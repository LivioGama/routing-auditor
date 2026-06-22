import type { Config, QueueJob, PromptRecord, Verification, JudgeResult, Tier, ExecutionArtifact } from "./schemas.ts";
import {
  VerificationSchema,
  defaultStats,
} from "./schemas.ts";
import {
  ensureDataDir,
  readConfig,
  readStats,
  writeStats,
  claimNextJob,
  updateJob,
  removeJob,
  findPrompt,
  updatePrompt,
  readAllPrompts,
  readQueueJobs,
  DEFAULT_RUNNING_JOB_LEASE_MS,
  defaultDataDir,
} from "./storage.ts";
import { assess } from "./assessor.ts";
import { judge } from "./judge.ts";
import { computeCosts, applyRecordToStats } from "./cost.ts";
import { runPrompt } from "./acp/runner.ts";
import { generateAndSaveReport } from "./reports.ts";
import { captureArtifacts, isLikelyArtifactTask } from "./artifacts.ts";
import { createLogger } from "./logger.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";

export interface DaemonOptions {
  dataDir?: string;
  once?: boolean;
  pollIntervalMs?: number;
  runner?: typeof runPrompt;
  assesser?: typeof assess;
  judger?: typeof judge;
  signal?: AbortSignal;
  onJobComplete?: (recordId: string, succeeded: boolean) => void;
}

export interface DaemonResult {
  processed: number;
  succeeded: number;
  failed: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const recomputeStats = (dataDir: string): void => {
  const records = readAllPrompts(dataDir);
  let stats = defaultStats();
  for (const r of records) {
    stats = applyRecordToStats(stats, r);
  }
  writeStats(dataDir, stats);
};

const updateStatsIncremental = (dataDir: string, record: PromptRecord): void => {
  const stats = readStats(dataDir);
  const updated = applyRecordToStats(stats, record);
  writeStats(dataDir, updated);
};

const markTerminalAuditFailure = async (
  dataDir: string,
  record: PromptRecord,
  config: Config,
  error: string,
): Promise<void> => {
  const latest = findPrompt(dataDir, record.id) ?? record;
  const assessment = latest.assessment;
  const recommendedModel = assessment?.recommended_model ?? latest.codex_model;
  const recommendedTier = assessment?.recommended_tier ?? latest.codex_tier;
  const verification = VerificationSchema.parse({
    model: recommendedModel,
    tier: recommendedTier,
    output: "",
    input_tokens: 0,
    output_tokens: 0,
    estimated: true,
    latency_ms: 0,
    status: "failed",
    error,
    verified_at: new Date().toISOString(),
  });
  const costs = computeCosts({
    pricing: config.pricing,
    assessment,
    verification,
    judgeModelKey: config.judgeModel,
    actual: latest.actual_execution,
    recommendedModel,
    recommendedTier,
    verificationSucceeded: false,
  });

  await updatePrompt(dataDir, record.id, (r) => ({
    ...r,
    verification,
    costs,
    verified: true,
    verification_succeeded: false,
  }));
};

const cleanupTerminalRunningJobs = async (
  dataDir: string,
  config: Config,
  log: pino.Logger,
  now: Date = new Date(),
): Promise<number> => {
  const nowMs = now.getTime();
  let cleaned = 0;

  for (const job of readQueueJobs(dataDir)) {
    if (job.status !== "running" || job.attempts < job.max_attempts) continue;

    const updatedAtMs = Date.parse(job.updated_at);
    const stale = Number.isNaN(updatedAtMs) || nowMs - updatedAtMs >= DEFAULT_RUNNING_JOB_LEASE_MS;
    if (!stale) continue;

    const record = findPrompt(dataDir, job.prompt_record_id);
    if (record) {
      await markTerminalAuditFailure(
        dataDir,
        record,
        config,
        job.last_error || "verification job expired after exhausting retries",
      );
      const failedRecord = findPrompt(dataDir, record.id);
      if (failedRecord) {
        updateStatsIncremental(dataDir, failedRecord);
      }
    }
    removeJob(dataDir, job.id);
    cleaned++;
    log.warn({ job_id: job.id, record_id: job.prompt_record_id }, "removed terminal stale running job");
  }

  return cleaned;
};

export const processJob = async (
  dataDir: string,
  job: QueueJob,
  config: Config,
  deps: { runner: typeof runPrompt; assesser: typeof assess; judger: typeof judge; log: pino.Logger },
): Promise<boolean> => {
  const { log } = deps;
  const record = findPrompt(dataDir, job.prompt_record_id);
  if (!record) {
    log.warn({ job_id: job.id, record_id: job.prompt_record_id }, "prompt record not found; dropping job");
    removeJob(dataDir, job.id);
    return false;
  }

  const updatedJob = { ...job, status: "running" as const, updated_at: new Date().toISOString(), attempts: job.attempts + 1 };
  updateJob(dataDir, updatedJob);

  try {
    if (!record.assessment) {
      log.info({ job_id: job.id }, "assessing");
      const assessment = await deps.assesser({
        config,
        prompt: job.prompt,
        codexModel: job.codex_model,
        codexTier: job.codex_tier,
        runner: deps.runner,
        fastMode: config.fastMode,
      });
      await updatePrompt(dataDir, record.id, (r) => ({ ...r, assessment }));
    }

    const assessedRecord = findPrompt(dataDir, record.id);
    if (!assessedRecord?.assessment) {
      throw new Error("assessment missing after assess step");
    }
    const assessment = assessedRecord.assessment;
    const recommendedModel = assessment.recommended_model;
    const recommendedTier = assessment.recommended_tier;

    let verification: Verification | undefined;
    let judgeResult: JudgeResult | undefined;
    let verificationSucceeded = false;

    if (config.verificationEnabled) {
      log.info({ job_id: job.id, model: recommendedModel, tier: recommendedTier }, "verifying");
      // Run the cheaper rerun in a throwaway sandbox dir with writes allowed, so
      // file-writing/coding prompts can actually do the work and be judged
      // fairly, without ever touching the user's real folders. The dir is
      // deleted afterward regardless of success or failure.
      const sandboxDir = mkdtempSync(join(tmpdir(), "routing-auditor-verify-"));
      let runResult;
      let verificationArtifacts: ExecutionArtifact[] = [];
      try {
        runResult = await deps.runner(job.prompt, {
          command: config.acpCommand,
          args: config.acpArgs,
          cwd: sandboxDir,
          readOnly: false,
          model: recommendedModel,
          tier: recommendedTier,
          fastMode: config.fastMode,
          onStderr: (line) => log.debug({ job_id: job.id }, line),
        });
        if (isLikelyArtifactTask(`${job.prompt}\n${runResult.output}`)) {
          verificationArtifacts = captureArtifacts(sandboxDir);
        }
      } finally {
        let cleaned = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            rmSync(sandboxDir, { recursive: true, force: true });
            cleaned = true;
            break;
          } catch (err: any) {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            }
          }
        }
        if (!cleaned) {
          log.warn({ job_id: job.id, sandboxDir }, "failed to remove verify sandbox dir after retries");
        }
      }
      verification = VerificationSchema.parse({
        model: recommendedModel,
        tier: recommendedTier,
        output: runResult.output,
        ...(verificationArtifacts.length > 0 ? { artifacts: verificationArtifacts } : {}),
        input_tokens: runResult.input_tokens,
        output_tokens: runResult.output_tokens,
        estimated: runResult.estimated,
        latency_ms: runResult.latencyMs,
        status: "succeeded",
        verified_at: new Date().toISOString(),
      });

      const actualOutput = assessedRecord.actual_execution?.output ?? job.actual_output ?? "";
      const actualArtifacts = assessedRecord.actual_execution?.artifacts ?? [];
      const actualCaptured = assessedRecord.actual_execution?.captured ?? false;

      if (actualOutput || actualArtifacts.length > 0) {
        log.info({ job_id: job.id }, "judging");
        judgeResult = await deps.judger({
          config,
          originalPrompt: job.prompt,
          originalOutput: actualOutput,
          predictedOutput: verification.output,
          originalArtifacts: actualArtifacts,
          predictedArtifacts: verification.artifacts ?? [],
          runner: deps.runner,
          fastMode: config.fastMode,
        });
        verificationSucceeded =
          judgeResult.winner === "predicted" || judgeResult.quality_gap_score <= config.verificationThreshold;
      } else if (actualCaptured) {
        // actual_execution.captured is true but output is empty - this is a capture failure
        log.warn({ job_id: job.id }, "actual output captured but empty; marking verification as failed");
        verificationSucceeded = false;
        verification.status = "failed";
        verification.error = "actual output was captured but empty; cannot judge verification";
      } else {
        // actual output was never captured - we can't verify, so consider it succeeded
        log.info({ job_id: job.id }, "no actual output captured; marking verified without judge");
        verificationSucceeded = true;
      }
    } else {
      log.info({ job_id: job.id }, "verification disabled; skipping");
      verificationSucceeded = true;
    }

    const finalRecord = findPrompt(dataDir, record.id);
    if (!finalRecord) throw new Error("record vanished during processing");

    const costs = computeCosts({
      pricing: config.pricing,
      assessment: finalRecord.assessment ?? assessment,
      verification,
      judge: judgeResult,
      judgeModelKey: config.judgeModel,
      actual: finalRecord.actual_execution,
      recommendedModel,
      recommendedTier,
      verificationSucceeded,
    });

    await updatePrompt(dataDir, record.id, (r) => ({
      ...r,
      assessment: finalRecord.assessment ?? r.assessment,
      verification,
      judge: judgeResult,
      costs,
      verified: true,
      verification_succeeded: verificationSucceeded,
    }));

    const doneJob: QueueJob = {
      ...updatedJob,
      status: "completed",
      updated_at: new Date().toISOString(),
    };
    updateJob(dataDir, doneJob);
    removeJob(dataDir, job.id);

    const updatedRecord = findPrompt(dataDir, record.id);
    if (updatedRecord) {
      updateStatsIncremental(dataDir, updatedRecord);
    } else {
      recomputeStats(dataDir);
    }

    log.info({ job_id: job.id, succeeded: verificationSucceeded }, "job complete");
    return verificationSucceeded;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error({ job_id: job.id, error: msg }, "job failed");
    const terminal = updatedJob.attempts >= updatedJob.max_attempts;
    const failedJob: QueueJob = {
      ...updatedJob,
      status: terminal ? "failed" : "queued",
      updated_at: new Date().toISOString(),
      last_error: msg,
    };
    updateJob(dataDir, failedJob);
    if (terminal) {
      await markTerminalAuditFailure(dataDir, record, config, msg);
      removeJob(dataDir, job.id);
      const failedRecord = findPrompt(dataDir, record.id);
      if (failedRecord) {
        updateStatsIncremental(dataDir, failedRecord);
      }
    }
    return false;
  }
};

export const runDaemon = async (options: DaemonOptions = {}): Promise<DaemonResult> => {
  const dataDir = options.dataDir ?? defaultDataDir();
  ensureDataDir(dataDir);
  const log = createLogger(dataDir);
  const config = readConfig(dataDir);
  const runner = options.runner ?? runPrompt;
  const assesser = options.assesser ?? assess;
  const judger = options.judger ?? judge;
  const pollMs = options.pollIntervalMs ?? config.pollIntervalMs;
  const signal = options.signal;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  log.info({ dataDir, pollMs }, "daemon started");
  try {
    recomputeStats(dataDir);
    const reportPath = generateAndSaveReport(dataDir, "daily");
    log.info({ reportPath }, "daily report refreshed");
  } catch (err: any) {
    log.warn({ error: err?.message }, "daily report refresh failed");
  }

  const loop = async (): Promise<void> => {
    let backoffMs = pollMs;
    const maxBackoffMs = pollMs * 8;
    const minBackoffMs = pollMs;

    while (!signal?.aborted) {
      await cleanupTerminalRunningJobs(dataDir, config, log);
      const job = claimNextJob(dataDir);
      if (!job) {
        if (options.once) return;
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }
      backoffMs = minBackoffMs;
      processed++;
      const ok = await processJob(dataDir, job, config, { runner, assesser, judger, log });
      if (ok) succeeded++;
      else failed++;
      options.onJobComplete?.(job.prompt_record_id, ok);

      if (!options.once) {
        try {
          const reportPath = generateAndSaveReport(dataDir, "daily");
          log.info({ reportPath }, "daily report generated");
        } catch (err: any) {
          log.warn({ error: err?.message }, "daily report generation failed");
        }
      }
      if (options.once) return;
    }
  };

  try {
    await loop();
  } catch (err: any) {
    if (err?.name === "AbortError") {
      log.info("daemon stopped via abort signal");
    } else {
      log.error({ error: err?.message }, "daemon loop crashed");
      throw err;
    }
  }

  log.info({ processed, succeeded, failed }, "daemon exiting");
  return { processed, succeeded, failed };
};
