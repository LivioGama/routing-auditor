import { z } from "zod";
import fs from "fs";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  ActualExecutionSchema,
  ActualExecution,
  type PromptRecord,
} from "../schemas.ts";
import {
  findPrompt,
  findLatestUnfinishedPromptBySession,
  findPromptBySessionTurn,
  updatePrompt,
  defaultDataDir,
  readConfig,
  readAllPrompts,
} from "../storage.ts";
import { buildTaskCompletionNotice } from "./taskCompletionNotice.ts";
import { getDataDir as getEnvDataDir, getMinimalChildEnv, isInternalHookProcess } from "../env.ts";
import { captureArtifacts, captureReferencedArtifacts, isLikelyArtifactTask } from "../artifacts.ts";
import { isPidRunning, isRoutingAuditorDaemon, readDaemonIdentity } from "../daemon-identity.ts";

const DEFAULT_STOP_POLL_INTERVAL_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const StopInputSchema = z.object({
  session_id: z.string(),
  turn_id: z.string().optional(),
  last_assistant_message: z.string().optional(),
  output: z.string().optional(),
  stop_hook_active: z.boolean().default(false),
}).passthrough();

const outputFromStopPayload = (payload: z.infer<typeof StopInputSchema>): string => {
  if (typeof payload.last_assistant_message === "string") return payload.last_assistant_message;
  if (typeof payload.output === "string") return payload.output;
  return "";
};

const findPendingCompletionNotice = (
  dataDir: string,
  sessionId: string,
): { record: PromptRecord; message: string } | undefined => {
  const records = readAllPrompts(dataDir)
    .filter((record) => record.session_id === sessionId && !record.completion_notice_shown)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const record of records) {
    const message = buildTaskCompletionNotice(record);
    if (message) return { record, message };
  }
  return undefined;
};

const isTerminalFailure = (record: PromptRecord): boolean => {
  return (
    (record.verified && record.verification_succeeded === false) ||
    record.verification?.status === "failed"
  );
};

const waitForCompletionNotice = async (
  dataDir: string,
  sessionId: string,
  turnId: string,
  timeoutMs: number,
  pollIntervalMs: number = DEFAULT_STOP_POLL_INTERVAL_MS,
): Promise<{ record: PromptRecord; message: string } | undefined> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (Date.now() <= deadline) {
    const record =
      findPromptBySessionTurn(dataDir, sessionId, turnId) ??
      readAllPrompts(dataDir).filter((r) => r.session_id === sessionId).at(-1);

    if (record) {
      if (record.completion_notice_shown) return undefined;
      const message = buildTaskCompletionNotice(record);
      if (message) return { record, message };
      if (isTerminalFailure(record)) return undefined;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return undefined;
};

const hasLiveDaemon = async (dataDir: string): Promise<boolean> => {
  const identity = readDaemonIdentity(dataDir);
  if (!identity || !isPidRunning(identity.pid)) return false;
  return isRoutingAuditorDaemon(identity.pid, dataDir);
};

export const handleStop = async (
  input: unknown,
  dataDir: string,
  opts: { artifactRoot?: string } = {},
): Promise<{ updated: boolean; message?: string; sessionId?: string; turnId?: string }> => {
  const parsed = StopInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.session_id === "") {
    return { updated: false };
  }
  if (parsed.data.stop_hook_active) {
    return { updated: false };
  }
  const session_id = parsed.data.session_id;
  const turn_id = parsed.data.turn_id ?? "";
  const extras = (parsed.data as Record<string, unknown>) ?? {};

  const record =
    findPromptBySessionTurn(dataDir, session_id, turn_id) ??
    findLatestUnfinishedPromptBySession(dataDir, session_id);
  if (!record) return { updated: false };

  const inputTokensRaw = extras.input_tokens;
  const hasTokens = typeof inputTokensRaw === "number";
  const output = outputFromStopPayload(parsed.data);
  const artifactRoot =
    opts.artifactRoot ??
    (typeof extras.cwd === "string" ? extras.cwd : undefined) ??
    (typeof extras.workspace_dir === "string" ? extras.workspace_dir : undefined) ??
    (typeof extras.working_directory === "string" ? extras.working_directory : undefined) ??
    (typeof extras.project_dir === "string" ? extras.project_dir : undefined) ??
    process.cwd();
  const artifactContext = `${record.prompt}\n${output}`;
  const referencedArtifacts = captureReferencedArtifacts(artifactRoot, output);
  const artifacts = referencedArtifacts.length > 0
    ? referencedArtifacts
    : isLikelyArtifactTask(artifactContext)
      ? captureArtifacts(artifactRoot)
      : [];

  const actual: ActualExecution = ActualExecutionSchema.parse({
    model: record.codex_model,
    tier: record.codex_tier,
    output,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    input_tokens: typeof inputTokensRaw === "number" ? inputTokensRaw : 0,
    output_tokens: typeof extras.output_tokens === "number" ? extras.output_tokens : 0,
    estimated: !hasTokens,
    latency_ms: typeof extras.latency_ms === "number" ? extras.latency_ms : 0,
    captured: true,
  });

  await updatePrompt(dataDir, record.id, (r: PromptRecord): PromptRecord => ({
    ...r,
    actual_execution: actual,
  }));

  const updatedRecord = findPrompt(dataDir, record.id);
  if (!updatedRecord) return { updated: true, sessionId: session_id, turnId: turn_id };

  const currentMessage = buildTaskCompletionNotice(updatedRecord);
  if (currentMessage) {
    await updatePrompt(dataDir, updatedRecord.id, (r: PromptRecord): PromptRecord => ({
      ...r,
      completion_notice_shown: true,
    }));
    return { updated: true, message: currentMessage, sessionId: session_id, turnId: turn_id };
  }

  const pending = findPendingCompletionNotice(dataDir, session_id);
  if (pending) {
    await updatePrompt(dataDir, pending.record.id, (r: PromptRecord): PromptRecord => ({
      ...r,
      completion_notice_shown: true,
    }));
    return { updated: true, message: pending.message, sessionId: session_id, turnId: turn_id };
  }

  return { updated: true, sessionId: session_id, turnId: turn_id };
};

export interface SpawnNoticeWatcherOptions {
  dataDir: string;
  sessionId: string;
  turnId?: string;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
  openTtyFd?: () => number | undefined;
  closeFd?: (fd: number) => void;
}

const openTtyFd = (): number | undefined => {
  try {
    return fs.openSync("/dev/tty", "a");
  } catch {
    return undefined;
  }
};

export const spawnNoticeWatcher = (opts: SpawnNoticeWatcherOptions): ChildProcess | undefined => {
  const scriptPath = process.argv[1];
  if (!scriptPath) return undefined;

  const args = [scriptPath, "await-notice", "--session", opts.sessionId];
  if (opts.turnId) {
    args.push("--turn", opts.turnId);
  }
  if (opts.timeoutMs !== undefined) {
    args.push("--timeout-ms", String(opts.timeoutMs));
  }

  const ttyFd = (opts.openTtyFd ?? openTtyFd)();
  const stdio: StdioOptions = ttyFd === undefined ? "ignore" : ["ignore", "ignore", "ignore", ttyFd];
  const spawnFn = opts.spawnFn ?? spawn;

  const child = spawnFn(process.execPath, args, {
    detached: true,
    stdio,
    env: {
      ...getMinimalChildEnv(),
      ROUTING_AUDITOR_DATA_DIR: opts.dataDir,
      ...(ttyFd === undefined ? {} : { ROUTING_AUDITOR_TTY_FD: "3" }),
    },
  }) as ChildProcess;
  if (ttyFd !== undefined) {
    try {
      (opts.closeFd ?? fs.closeSync)(ttyFd);
    } catch {}
  }
  child.unref();
  return child;
};

export const runStopHookCore = async (
  payload: unknown,
  dataDir: string,
  opts: {
    spawnFn?: typeof spawn;
    openTtyFd?: () => number | undefined;
    closeFd?: (fd: number) => void;
    artifactRoot?: string;
    synchronousWaitMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<string | undefined> => {
  const { updated, message, sessionId, turnId } = await handleStop(payload, dataDir, {
    artifactRoot: opts.artifactRoot,
  });
  if (message !== undefined) {
    return JSON.stringify({
      decision: "block",
      reason: `Reply with exactly this single sentence and do not run tools: ${message}`,
    });
  }
  if (updated && sessionId) {
    const config = readConfig(dataDir);
    const waitMs = opts.synchronousWaitMs ?? config.noticeTimeoutMs;
    const waitExplicitlyRequested = opts.synchronousWaitMs !== undefined;
    if (waitMs > 0 && (waitExplicitlyRequested || await hasLiveDaemon(dataDir))) {
      const notice = await waitForCompletionNotice(
        dataDir,
        sessionId,
        turnId ?? "",
        waitMs,
        opts.pollIntervalMs,
      );
      if (notice) {
        await updatePrompt(dataDir, notice.record.id, (r: PromptRecord): PromptRecord => ({
          ...r,
          completion_notice_shown: true,
        }));
        return JSON.stringify({
          decision: "block",
          reason: `Reply with exactly this single sentence and do not run tools: ${notice.message}`,
        });
      }
    }
    if (config.backgroundNoticeEnabled) {
      spawnNoticeWatcher({
        dataDir,
        sessionId,
        turnId,
        timeoutMs: config.noticeTimeoutMs,
        spawnFn: opts.spawnFn,
        openTtyFd: opts.openTtyFd,
        closeFd: opts.closeFd,
      });
    }
  }
  return undefined;
};

export const runStopHook = async (): Promise<void> => {
  let payload: unknown = {};
  try {
    const text = await Bun.stdin.text();
    payload = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    payload = {};
  }
  const dataDir = getEnvDataDir(defaultDataDir());
  try {
    if (isInternalHookProcess()) {
      process.exit(0);
    }
    const output = await runStopHookCore(payload, dataDir);
    if (output !== undefined) {
      process.stdout.write(output);
    }
  } catch (err) {
    // Codex validates Stop hook stdout strictly. Keep capture failures non-blocking.
  }
  process.exit(0);
};
