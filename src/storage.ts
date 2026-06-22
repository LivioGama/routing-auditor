import fs from "fs";
import path from "path";
import os from "os";
import crypto from "node:crypto";
import {
  ConfigSchema,
  StatsSchema,
  PromptRecordSchema,
  QueueJobSchema,
  defaultConfig,
  defaultStats,
  type Config,
  type Stats,
  type PromptRecord,
  type QueueJob,
} from "./schemas.ts";

export const defaultDataDir = (): string => path.join(os.homedir(), ".routing-auditor");

const CONFIG_FILE = "config.json";
const STATS_FILE = "stats.json";
const PROMPTS_FILE = "prompts.jsonl";
const QUEUE_DIR = "queue";
const REPORTS_DIR = "reports";
const LOCK_DIR = "lock";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 100;

interface CacheEntry<T> {
  data: T;
  mtimeMs: number;
}

const promptsCache = new Map<string, CacheEntry<PromptRecord[]>>();

export const invalidatePromptsCache = (dataDir: string): void => {
  const filePath = path.join(dataDir, PROMPTS_FILE);
  promptsCache.delete(filePath);
};

interface LockOptions {
  timeout?: number;
  retryMs?: number;
}

export const withFileLock = async <T>(
  dataDir: string,
  lockName: string,
  fn: () => T,
  options: LockOptions = {},
): Promise<T> => {
  const lockPath = path.join(dataDir, LOCK_DIR, lockName);
  const timeout = options.timeout ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const startTime = Date.now();

  const acquire = (): boolean => {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch (err: any) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  };

  const release = (): void => {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Ignore errors during release
    }
  };

  while (Date.now() - startTime < timeout) {
    if (acquire()) {
      try {
        return fn();
      } finally {
        release();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  throw new Error(`Failed to acquire lock ${lockName} after ${timeout}ms`);
};

export const atomicWrite = (filePath: string, data: string): void => {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
};

const readJsonFile = <T>(filePath: string, fallback: T): T => {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const ensureDataDir = (dataDir: string): void => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, QUEUE_DIR), { recursive: true });
  fs.mkdirSync(path.join(dataDir, REPORTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dataDir, LOCK_DIR), { recursive: true });
};

export const readConfig = (dataDir: string, options: { silent?: boolean } = {}): Config => {
  const raw = readJsonFile<unknown>(path.join(dataDir, CONFIG_FILE), null);
  if (raw === null) return defaultConfig();
  try {
    return ConfigSchema.parse(raw);
  } catch (err: any) {
    if (!options.silent) {
      console.warn(`[Routing Auditor] Malformed config file, using defaults: ${err.message}`);
    }
    return defaultConfig();
  }
};

export const writeConfig = (dataDir: string, config: Config): void => {
  atomicWrite(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2));
};

export const readStats = (dataDir: string): Stats => {
  const raw = readJsonFile<unknown>(path.join(dataDir, STATS_FILE), null);
  if (raw === null) return defaultStats();
  try {
    return StatsSchema.parse(raw);
  } catch {
    return defaultStats();
  }
};

export const writeStats = (dataDir: string, stats: Stats): void => {
  atomicWrite(path.join(dataDir, STATS_FILE), JSON.stringify(stats, null, 2));
};

export const appendPrompt = (dataDir: string, record: PromptRecord): void => {
  fs.appendFileSync(path.join(dataDir, PROMPTS_FILE), JSON.stringify(record) + "\n", "utf-8");
  invalidatePromptsCache(dataDir);
};

export const readAllPrompts = (dataDir: string, options: { silent?: boolean } = {}): PromptRecord[] => {
  const filePath = path.join(dataDir, PROMPTS_FILE);
  if (!fs.existsSync(filePath)) return [];

  const stats = fs.statSync(filePath);
  const mtimeMs = stats.mtimeMs;
  const cached = promptsCache.get(filePath);

  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const records: PromptRecord[] = [];
  let corruptLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      records.push(PromptRecordSchema.parse(parsed));
    } catch {
      corruptLines++;
      continue;
    }
  }
  if (corruptLines > 0 && !options.silent) {
    console.warn(`[Routing Auditor] Skipped ${corruptLines} corrupt JSONL line(s) in ${PROMPTS_FILE}`);
  }

  promptsCache.set(filePath, { data: records, mtimeMs });
  return records;
};

export const findPrompt = (dataDir: string, id: string): PromptRecord | undefined => {
  return readAllPrompts(dataDir).find((r) => r.id === id);
};

export const findPromptBySession = (dataDir: string, sessionId: string): PromptRecord | undefined => {
  return readAllPrompts(dataDir).find((r) => r.session_id === sessionId);
};

export const findPromptBySessionTurn = (
  dataDir: string,
  sessionId: string,
  turnId: string,
): PromptRecord | undefined => {
  if (turnId === "") return undefined;
  return readAllPrompts(dataDir).find((r) => r.session_id === sessionId && r.turn_id === turnId);
};

export const findLatestUnfinishedPromptBySession = (
  dataDir: string,
  sessionId: string,
): PromptRecord | undefined => {
  const records = readAllPrompts(dataDir).filter((r) => r.session_id === sessionId && r.actual_execution === undefined);
  return records.at(-1);
};

export const updatePrompt = async (
  dataDir: string,
  id: string,
  updater: (r: PromptRecord) => PromptRecord,
): Promise<void> => {
  await withFileLock(dataDir, "prompts.jsonl", () => {
    const records = readAllPrompts(dataDir);
    let found = false;
    const updated = records.map((r) => {
      if (r.id === id) {
        found = true;
        return updater(r);
      }
      return r;
    });
    if (!found) return;
    atomicWrite(
      path.join(dataDir, PROMPTS_FILE),
      updated.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    invalidatePromptsCache(dataDir);
  });
};

export const enqueueJob = (dataDir: string, job: QueueJob): void => {
  atomicWrite(path.join(dataDir, QUEUE_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
};

export const readQueueJobs = (dataDir: string): QueueJob[] => {
  const queuePath = path.join(dataDir, QUEUE_DIR);
  if (!fs.existsSync(queuePath)) return [];
  const files = fs.readdirSync(queuePath).filter((f) => f.endsWith(".json"));
  const jobs: QueueJob[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(queuePath, file), "utf-8"));
      jobs.push(QueueJobSchema.parse(raw));
    } catch {
      continue;
    }
  }
  return jobs;
};

const PENDING_STATUSES = new Set(["queued", "assessed", "running"]);

const CLAIMABLE_STATUSES = new Set(["queued", "assessed"]);

export const DEFAULT_RUNNING_JOB_LEASE_MS = 10 * 60 * 1000;

export interface ClaimNextJobOptions {
  now?: Date;
  runningJobLeaseMs?: number;
}

const isStaleRunningJob = (job: QueueJob, nowMs: number, leaseMs: number): boolean => {
  if (job.status !== "running") return false;
  const updatedAtMs = Date.parse(job.updated_at);
  return Number.isNaN(updatedAtMs) || nowMs - updatedAtMs >= leaseMs;
};

export const readPendingJobs = (dataDir: string): QueueJob[] => {
  return readQueueJobs(dataDir)
    .filter((j) => PENDING_STATUSES.has(j.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
};

export const updateJob = (dataDir: string, job: QueueJob): void => {
  atomicWrite(path.join(dataDir, QUEUE_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
};

export const claimNextJob = (dataDir: string, options: ClaimNextJobOptions = {}): QueueJob | undefined => {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const leaseMs = Math.max(0, options.runningJobLeaseMs ?? DEFAULT_RUNNING_JOB_LEASE_MS);
  const claimable = readQueueJobs(dataDir)
    .filter((j) => CLAIMABLE_STATUSES.has(j.status) || (isStaleRunningJob(j, nowMs, leaseMs) && j.attempts < j.max_attempts))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (claimable.length === 0) return undefined;
  const next = claimable[0]!;
  const claimed: QueueJob = {
    ...next,
    status: "running",
    updated_at: now.toISOString(),
  };
  updateJob(dataDir, claimed);
  return claimed;
};

export const removeJob = (dataDir: string, id: string): void => {
  const filePath = path.join(dataDir, QUEUE_DIR, `${id}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    return;
  }
};

export const clearQueueJobs = (dataDir: string): number => {
  const queuePath = path.join(dataDir, QUEUE_DIR);
  if (!fs.existsSync(queuePath)) return 0;
  const files = fs.readdirSync(queuePath).filter((f) => f.endsWith(".json"));
  let removed = 0;
  for (const file of files) {
    try {
      fs.rmSync(path.join(queuePath, file), { force: true });
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
};

export const resetRunningJobsToQueued = (dataDir: string): number => {
  const jobs = readQueueJobs(dataDir);
  let resetCount = 0;
  for (const job of jobs) {
    if (job.status === "running") {
      const resetJob: QueueJob = {
        ...job,
        status: "queued",
        updated_at: new Date().toISOString(),
      };
      updateJob(dataDir, resetJob);
      resetCount++;
    }
  }
  return resetCount;
};

export const generateId = (prefix: string): string => {
  const ts = Date.now();
  const uuid = crypto.randomUUID();
  return `${prefix}_${ts}_${uuid}`;
};

export const generatePromptId = (): string => generateId("p");

export const generateJobId = (): string => generateId("j");
