import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureDataDir,
  appendPrompt,
  enqueueJob,
  readAllPrompts,
  readStats,
  writeStats,
  readQueueJobs,
  generatePromptId,
  generateJobId,
} from "../src/storage.ts";
import { defaultConfig, defaultStats, type PromptRecord, type QueueJob, AssessmentSchema } from "../src/schemas.ts";
import { runDaemon, processJob } from "../src/daemon.ts";
import { assess as realAssess } from "../src/assessor.ts";
import { judge as realJudge } from "../src/judge.ts";
import type { RunResult, RunnerOptions } from "../src/acp/runner.ts";
import type { Assessment, JudgeResult } from "../src/schemas.ts";

let dataDir: string;

const pricing = {
  "gpt-5.5-low": { input: 0.5, output: 2 },
  "gpt-5.5-medium": { input: 1, output: 4 },
  "gpt-5.5-high": { input: 1.5, output: 6 },
};

const makeRecord = (over: Partial<PromptRecord> = {}): PromptRecord => ({
  id: generatePromptId(),
  timestamp: new Date().toISOString(),
  session_id: "s1",
  prompt: "write a hello world in python",
  codex_model: "gpt-5.5",
  codex_tier: "high",
  verified: false,
  verification_succeeded: false,
  completion_notice_shown: false,
  actual_execution: {
    model: "gpt-5.5",
    tier: "high",
    output: "print('hello world')",
    input_tokens: 100,
    output_tokens: 20,
    estimated: false,
    latency_ms: 2000,
    captured: true,
  },
  ...over,
});

const makeJob = (record: PromptRecord, over: Partial<QueueJob> = {}): QueueJob => ({
  id: generateJobId(),
  prompt_record_id: record.id,
  session_id: record.session_id,
  prompt: record.prompt,
  codex_model: record.codex_model,
  codex_tier: record.codex_tier,
  status: "queued",
  attempts: 0,
  max_attempts: 3,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_error: "",
  actual_output: record.actual_execution?.output ?? "",
  actual_captured: !!record.actual_execution,
  ...over,
});

const fakeAssessmentOutput = (over: Partial<Assessment> = {}): string => {
  const a = AssessmentSchema.parse({
    recommended_model: "gpt-5.5",
    recommended_tier: "low",
    acceptable_models: [
      { model: "gpt-5.5", tier: "low", predicted_quality_score: 88 },
      { model: "gpt-5.5", tier: "medium", predicted_quality_score: 95 },
    ],
    confidence: 90,
    reasoning_score: 2,
    coding_score: 5,
    ambiguity_score: 1,
    context_pressure_score: 2,
    instruction_complexity_score: 3,
    explanation: "trivial task",
    model: "gpt-5.5",
    tier: "high",
    ...over,
  });
  return JSON.stringify({
    recommended_model: a.recommended_model,
    recommended_tier: a.recommended_tier,
    acceptable_models: a.acceptable_models,
    confidence: a.confidence,
    reasoning_score: a.reasoning_score,
    coding_score: a.coding_score,
    ambiguity_score: a.ambiguity_score,
    context_pressure_score: a.context_pressure_score,
    instruction_complexity_score: a.instruction_complexity_score,
    explanation: a.explanation,
  });
};

const fakeJudgeOutput = (over: Partial<JudgeResult> = {}): string => {
  const j: JudgeResult = {
    winner: "tie",
    original_quality_score: 95,
    cheaper_quality_score: 94,
    quality_gap_score: 1,
    reasoning: "equivalent",
    input_tokens: 0,
    output_tokens: 0,
    estimated: false,
    latency_ms: 0,
    judged_at: "",
    ...over,
  };
  return JSON.stringify({
    winner: j.winner,
    original_quality_score: j.original_quality_score,
    cheaper_quality_score: j.cheaper_quality_score,
    quality_gap_score: j.quality_gap_score,
    reasoning: j.reasoning,
  });
};

const buildFakeRunner = (responses: { assessment?: string; verification?: string; judge?: string }) => {
  let callCount = 0;
  const fakeRunner = async (prompt: string, _opts: RunnerOptions): Promise<RunResult> => {
    callCount++;
    let output = "";
    if (prompt.includes("routing auditor") && prompt.includes("recommended_tier")) {
      output = responses.assessment ?? fakeAssessmentOutput();
    } else if (prompt.includes("neutral judge")) {
      output = responses.judge ?? fakeJudgeOutput();
    } else {
      output = responses.verification ?? "print('hello world')";
    }
    return {
      output,
      latencyMs: 100,
      input_tokens: 50,
      output_tokens: 10,
      estimated: false,
    };
  };
  return fakeRunner;
};

const buildFakeAssessor = (assessment: Assessment) => {
  return async (_opts: any): Promise<Assessment> => assessment;
};

const buildFakeJudger = (judgeResult: JudgeResult) => {
  return async (_opts: any): Promise<JudgeResult> => judgeResult;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-daemon-"));
  ensureDataDir(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("processJob", () => {
  it("end-to-end: assess + verify + judge + costs + stats + job removal", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record);
    enqueueJob(dataDir, job);

    const fakeRunner = buildFakeRunner({});
    const ok = await processJob(dataDir, job, config, {
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });

    expect(ok).toBe(true);
    expect(readQueueJobs(dataDir)).toHaveLength(0);

    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.assessment).toBeDefined();
    expect(updated.assessment!.recommended_tier).toBe("medium");  // Quality-based selection picks higher quality over cheapest
    expect(updated.verification).toBeDefined();
    expect(updated.verification!.model).toBe("gpt-5.5");
    expect(updated.verification!.tier).toBe("medium");  // Quality-based selection picks higher quality over cheapest
    expect(updated.judge).toBeDefined();
    expect(updated.judge!.winner).toBe("tie");
    expect(updated.costs).toBeDefined();
    expect(updated.costs!.total_audit_cost).toBeGreaterThan(0);
    expect(updated.verified).toBe(true);
    expect(updated.verification_succeeded).toBe(true);

    const stats = readStats(dataDir);
    expect(stats.prompts_analyzed).toBe(1);
    expect(stats.prompts_verified).toBe(1);
    expect(stats.verification_succeeded).toBe(1);
    expect(stats.total_audit_cost).toBeGreaterThan(0);
    expect(stats.model_recommendations["gpt-5.5"]).toBe(1);
    expect(stats.tier_recommendations["medium"]).toBe(1);  // Quality-based selection picks higher quality over cheapest
  });

  it("verifies in a fresh, empty, throwaway sandbox dir with writes allowed, then cleans it up", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record);
    enqueueJob(dataDir, job);

    let verifyCwd: string | undefined;
    let verifyReadOnly: boolean | undefined;
    let cwdExistedDuringCall = false;
    let cwdWasEmptyDuringCall = false;
    const capturingRunner = async (prompt: string, opts: RunnerOptions): Promise<RunResult> => {
      // The daemon only sets cwd on the verification rerun.
      if (opts.cwd) {
        verifyCwd = opts.cwd;
        verifyReadOnly = opts.readOnly;
        cwdExistedDuringCall = fs.existsSync(opts.cwd) && fs.statSync(opts.cwd).isDirectory();
        cwdWasEmptyDuringCall = cwdExistedDuringCall && fs.readdirSync(opts.cwd).length === 0;
        fs.writeFileSync(path.join(opts.cwd, "index.html"), "<h1>Hello world</h1>");
      }
      return buildFakeRunner({})(prompt, opts);
    };

    const ok = await processJob(dataDir, job, config, {
      runner: capturingRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });

    expect(ok).toBe(true);
    expect(verifyCwd).toBeDefined();
    // writes must be allowed so coding prompts can actually do the work
    expect(verifyReadOnly).toBe(false);
    // a real, empty clean-room dir existed during the rerun
    expect(cwdExistedDuringCall).toBe(true);
    expect(cwdWasEmptyDuringCall).toBe(true);
    // and it is deleted afterward, never touching the user's real folders
    expect(fs.existsSync(verifyCwd!)).toBe(false);

    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.verification!.artifacts).toEqual([
      { path: "index.html", content: "<h1>Hello world</h1>", truncated: false },
    ]);
  });

  it("rebuilds stats from records instead of accumulating previous stats", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const first = makeRecord({ id: "p1", session_id: "s1" });
    const second = makeRecord({ id: "p2", session_id: "s2" });
    appendPrompt(dataDir, first);
    appendPrompt(dataDir, second);

    const fakeRunner = buildFakeRunner({});
    for (const record of [first, second]) {
      const ok = await processJob(dataDir, makeJob(record), config, {
        runner: fakeRunner,
        assesser: realAssess,
        judger: realJudge,
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      });
      expect(ok).toBe(true);
    }

    const stats = readStats(dataDir);
    expect(stats.prompts_analyzed).toBe(2);
    expect(stats.prompts_verified).toBe(2);
    expect(stats.verification_succeeded).toBe(2);
    expect(stats.tier_recommendations["medium"]).toBe(2);  // Quality-based selection picks medium over low
  });

  it("marks verification_succeeded=false when judge says original wins by a large margin", async () => {
    const config = defaultConfig({ pricing, verificationThreshold: 5 });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record);
    enqueueJob(dataDir, job);

    const fakeRunner = buildFakeRunner({
      judge: fakeJudgeOutput({ winner: "original", original_quality_score: 95, cheaper_quality_score: 70, quality_gap_score: 25 }),
    });
    const ok = await processJob(dataDir, job, config, {
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });

    expect(ok).toBe(false);
    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.verification_succeeded).toBe(false);
    expect(updated.costs!.gross_savings).toBe(0);
  });

  it("skips verification when config.verificationEnabled=false", async () => {
    const config = defaultConfig({ pricing, verificationEnabled: false });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record);
    enqueueJob(dataDir, job);

    const fakeRunner = buildFakeRunner({});
    const ok = await processJob(dataDir, job, config, {
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });

    expect(ok).toBe(true);
    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.assessment).toBeDefined();
    expect(updated.verification).toBeUndefined();
    expect(updated.judge).toBeUndefined();
    expect(updated.costs!.verification_cost).toBe(0);
  });

  it("retries on failure up to max_attempts, then marks failed and removes job", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record, { max_attempts: 2 });
    enqueueJob(dataDir, job);

    const failingRunner = async (): Promise<RunResult> => {
      throw new Error("simulated ACP failure");
    };
    const ok1 = await processJob(dataDir, job, config, {
      runner: failingRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });
    expect(ok1).toBe(false);
    const jobsAfter1 = readQueueJobs(dataDir);
    expect(jobsAfter1).toHaveLength(1);
    expect(jobsAfter1[0]!.status).toBe("queued");
    expect(jobsAfter1[0]!.attempts).toBe(1);

    const ok2 = await processJob(dataDir, jobsAfter1[0]!, config, {
      runner: failingRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });
    expect(ok2).toBe(false);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
  });

  it("marks the prompt as failed when final retry fails after assessment", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record, { max_attempts: 1 });
    enqueueJob(dataDir, job);

    const assessment = AssessmentSchema.parse({
      recommended_model: "gpt-5.5",
      recommended_tier: "low",
      acceptable_models: [{ model: "gpt-5.5", tier: "low", predicted_quality_score: 100 }],
      confidence: 99,
      reasoning_score: 1,
      coding_score: 1,
      ambiguity_score: 1,
      context_pressure_score: 0,
      instruction_complexity_score: 1,
      explanation: "simple",
      model: "gpt-5.5",
      tier: "high",
      input_tokens: 205,
      output_tokens: 149,
      latency_ms: 7269,
    });
    const failingRunner = async (): Promise<RunResult> => {
      throw new Error("simulated verification failure");
    };

    const ok = await processJob(dataDir, job, config, {
      runner: failingRunner,
      assesser: buildFakeAssessor(assessment),
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });

    expect(ok).toBe(false);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.assessment).toBeDefined();
    expect(updated.verified).toBe(true);
    expect(updated.verification_succeeded).toBe(false);
    expect(updated.verification?.status).toBe("failed");
    expect(updated.verification?.error).toBe("simulated verification failure");
    expect(updated.costs?.assessment_cost).toBeGreaterThan(0);

    const stats = readStats(dataDir);
    expect(stats.prompts_analyzed).toBe(1);
    expect(stats.prompts_verified).toBe(1);
    expect(stats.verification_failed).toBe(1);
    expect(stats.total_assessment_input_tokens).toBe(205);
  });

  it("drops job when prompt record is missing", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const job = makeJob({ id: "ghost" } as any, { prompt_record_id: "ghost-id" });
    enqueueJob(dataDir, job);

    const fakeRunner = buildFakeRunner({});
    const ok = await processJob(dataDir, job, config, {
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    });
    expect(ok).toBe(false);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
  });
});

describe("runDaemon", () => {
  it("processes a single job with once=true and exits", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const record = makeRecord();
    appendPrompt(dataDir, record);
    const job = makeJob(record);
    enqueueJob(dataDir, job);

    const fakeRunner = buildFakeRunner({});
    const result = await runDaemon({
      dataDir,
      once: true,
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.verified).toBe(true);
  });

  it("returns 0 processed when no jobs and once=true", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const fakeRunner = buildFakeRunner({});
    const result = await runDaemon({
      dataDir,
      once: true,
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
    });

    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it("removes terminal stale running jobs without rerunning verification", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const assessment = AssessmentSchema.parse({
      recommended_model: "gpt-5.5",
      recommended_tier: "low",
      acceptable_models: [{ model: "gpt-5.5", tier: "low", predicted_quality_score: 100 }],
      confidence: 99,
      reasoning_score: 1,
      coding_score: 1,
      ambiguity_score: 1,
      context_pressure_score: 0,
      instruction_complexity_score: 1,
      explanation: "simple",
      model: "gpt-5.5",
      tier: "high",
      input_tokens: 20,
      output_tokens: 10,
      latency_ms: 100,
    });
    const record = makeRecord({ assessment });
    appendPrompt(dataDir, record);
    const staleTerminalJob = makeJob(record, {
      status: "running",
      attempts: 3,
      max_attempts: 3,
      updated_at: "2026-01-01T00:00:00.000Z",
      last_error: "Timeout after 90000ms: session/prompt",
    });
    enqueueJob(dataDir, staleTerminalJob);

    let runnerCalled = false;
    const runner = async (): Promise<RunResult> => {
      runnerCalled = true;
      throw new Error("runner should not be called");
    };

    const result = await runDaemon({
      dataDir,
      once: true,
      runner,
      assesser: realAssess,
      judger: realJudge,
    });

    expect(result.processed).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(readQueueJobs(dataDir)).toHaveLength(0);

    const updated = readAllPrompts(dataDir)[0]!;
    expect(updated.verified).toBe(true);
    expect(updated.verification_succeeded).toBe(false);
    expect(updated.verification?.status).toBe("failed");
    expect(updated.verification?.error).toBe("Timeout after 90000ms: session/prompt");
  });

  it("refreshes stale stats and daily report on startup even with no jobs", async () => {
    const config = defaultConfig({ pricing });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const assessed = AssessmentSchema.parse({
      recommended_model: "gpt-5.5",
      recommended_tier: "low",
      acceptable_models: [],
      confidence: 90,
      reasoning_score: 1,
      coding_score: 1,
      ambiguity_score: 1,
      context_pressure_score: 1,
      instruction_complexity_score: 1,
      explanation: "simple",
      model: "gpt-5.5",
      tier: "high",
      input_tokens: 10,
      output_tokens: 5,
      latency_ms: 100,
    });
    appendPrompt(dataDir, makeRecord({ id: "stale-prompt", assessment: assessed }));

    const stale = defaultStats();
    stale.prompts_analyzed = 99;
    writeStats(dataDir, stale);

    const result = await runDaemon({
      dataDir,
      once: true,
      runner: buildFakeRunner({}),
      assesser: realAssess,
      judger: realJudge,
    });

    expect(result.processed).toBe(0);
    const stats = readStats(dataDir);
    expect(stats.prompts_analyzed).toBe(1);
    expect(stats.model_recommendations["gpt-5.5"]).toBe(1);

    const reportFiles = fs.readdirSync(path.join(dataDir, "reports")).filter((f) => f.startsWith("daily-"));
    expect(reportFiles).toHaveLength(1);
    const report = JSON.parse(fs.readFileSync(path.join(dataDir, "reports", reportFiles[0]!), "utf8"));
    expect(report.stats_snapshot.prompts_analyzed).toBe(1);
    expect(report.records).toHaveLength(1);
  });

  it("stops on abort signal", async () => {
    const config = defaultConfig({ pricing, pollIntervalMs: 1000 });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const fakeRunner = buildFakeRunner({});
    const result = await runDaemon({
      dataDir,
      runner: fakeRunner,
      assesser: realAssess,
      judger: realJudge,
      signal: controller.signal,
    });

    expect(result.processed).toBe(0);
  });
});
