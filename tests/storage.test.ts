import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureDataDir,
  readConfig,
  writeConfig,
  readStats,
  writeStats,
  appendPrompt,
  readAllPrompts,
  findPrompt,
  findPromptBySession,
  updatePrompt,
  enqueueJob,
  readQueueJobs,
  readPendingJobs,
  updateJob,
  claimNextJob,
  DEFAULT_RUNNING_JOB_LEASE_MS,
  removeJob,
  clearQueueJobs,
  generateId,
  generatePromptId,
  generateJobId,
  defaultDataDir,
} from "../src/storage.ts";
import {
  defaultConfig,
  defaultStats,
  type PromptRecord,
  type QueueJob,
} from "../src/schemas.ts";

let dataDir: string;

const makePrompt = (overrides: Partial<PromptRecord> = {}): PromptRecord => ({
  id: generatePromptId(),
  timestamp: new Date().toISOString(),
  session_id: "",
  prompt: "hello",
  codex_model: "gpt-5.5",
  codex_tier: "high",
  verified: false,
  verification_succeeded: false,
  completion_notice_shown: false,
  ...overrides,
});

const makeJob = (overrides: Partial<QueueJob> = {}): QueueJob => ({
  id: generateJobId(),
  prompt_record_id: generatePromptId(),
  session_id: "",
  prompt: "hello",
  codex_model: "gpt-5.5",
  codex_tier: "high",
  status: "queued",
  attempts: 0,
  max_attempts: 3,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_error: "",
  actual_output: "",
  actual_captured: false,
  ...overrides,
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-test-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("ensureDataDir", () => {
  it("creates the dir tree (dataDir, queue/, reports/)", () => {
    ensureDataDir(dataDir);
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "queue"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "reports"))).toBe(true);
  });
});

describe("config", () => {
  it("readConfig returns defaultConfig when missing", () => {
    ensureDataDir(dataDir);
    const cfg = readConfig(dataDir);
    expect(cfg).toEqual(defaultConfig());
  });

  it("writeConfig then readConfig round-trips with custom pricing", () => {
    ensureDataDir(dataDir);
    const custom = defaultConfig({
      pricing: { "gpt-5.5-low": { input: 1.5, output: 6 } },
      pollIntervalMs: 500,
    });
    writeConfig(dataDir, custom);
    const read = readConfig(dataDir);
    expect(read).toEqual(custom);
    expect(read.pricing["gpt-5.5-low"]!.input).toBe(1.5);
  });

  it("writeConfig is atomic (no .tmp left behind)", () => {
    ensureDataDir(dataDir);
    writeConfig(dataDir, defaultConfig());
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "config.json.tmp"))).toBe(false);
  });
});

describe("stats", () => {
  it("readStats returns defaultStats when missing", () => {
    ensureDataDir(dataDir);
    expect(readStats(dataDir)).toEqual(defaultStats());
  });

  it("writeStats/readStats round-trip with non-zero values", () => {
    ensureDataDir(dataDir);
    const stats = defaultStats();
    stats.prompts_analyzed = 42;
    stats.total_audit_cost = 1.23;
    stats.model_recommendations = { "gpt-5.5-low": 10 };
    writeStats(dataDir, stats);
    expect(readStats(dataDir)).toEqual(stats);
  });
});

describe("prompts", () => {
  it("appendPrompt writes one JSON line; readAllPrompts returns it parsed", () => {
    ensureDataDir(dataDir);
    const p = makePrompt({ id: "p1", prompt: "first" });
    appendPrompt(dataDir, p);
    const all = readAllPrompts(dataDir);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("p1");
    expect(all[0]!.prompt).toBe("first");
  });

  it("appendPrompt multiple times returns all in order", () => {
    ensureDataDir(dataDir);
    const p1 = makePrompt({ id: "p1", prompt: "a" });
    const p2 = makePrompt({ id: "p2", prompt: "b" });
    const p3 = makePrompt({ id: "p3", prompt: "c" });
    appendPrompt(dataDir, p1);
    appendPrompt(dataDir, p2);
    appendPrompt(dataDir, p3);
    const all = readAllPrompts(dataDir);
    expect(all.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("readAllPrompts skips blank and corrupt JSON lines", () => {
    ensureDataDir(dataDir);
    const p = makePrompt({ id: "p1" });
    fs.appendFileSync(path.join(dataDir, "prompts.jsonl"), "\n");
    fs.appendFileSync(path.join(dataDir, "prompts.jsonl"), "{not valid json}\n");
    appendPrompt(dataDir, p);
    fs.appendFileSync(path.join(dataDir, "prompts.jsonl"), "\n");
    fs.appendFileSync(path.join(dataDir, "prompts.jsonl"), "{bad again\n");
    const all = readAllPrompts(dataDir);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("p1");
  });

  it("findPrompt finds by id; undefined for missing", () => {
    ensureDataDir(dataDir);
    const p = makePrompt({ id: "p1" });
    appendPrompt(dataDir, p);
    expect(findPrompt(dataDir, "p1")?.id).toBe("p1");
    expect(findPrompt(dataDir, "nope")).toBeUndefined();
  });

  it("findPromptBySession finds first matching session_id", () => {
    ensureDataDir(dataDir);
    const p1 = makePrompt({ id: "p1", session_id: "s1" });
    const p2 = makePrompt({ id: "p2", session_id: "s1" });
    const p3 = makePrompt({ id: "p3", session_id: "s2" });
    appendPrompt(dataDir, p1);
    appendPrompt(dataDir, p2);
    appendPrompt(dataDir, p3);
    expect(findPromptBySession(dataDir, "s1")?.id).toBe("p1");
    expect(findPromptBySession(dataDir, "s2")?.id).toBe("p3");
    expect(findPromptBySession(dataDir, "sX")).toBeUndefined();
  });

  it("updatePrompt replaces matched record and preserves order", async () => {
    ensureDataDir(dataDir);
    const p1 = makePrompt({ id: "p1", prompt: "a" });
    const p2 = makePrompt({ id: "p2", prompt: "b" });
    const p3 = makePrompt({ id: "p3", prompt: "c" });
    appendPrompt(dataDir, p1);
    appendPrompt(dataDir, p2);
    appendPrompt(dataDir, p3);
    await updatePrompt(dataDir, "p2", (r) => ({ ...r, prompt: "B!" }));
    const all = readAllPrompts(dataDir);
    expect(all.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    expect(all[1]!.prompt).toBe("B!");
  });

  it("updatePrompt is no-op if id missing (file unchanged)", async () => {
    ensureDataDir(dataDir);
    const p1 = makePrompt({ id: "p1", prompt: "a" });
    appendPrompt(dataDir, p1);
    const before = fs.readFileSync(path.join(dataDir, "prompts.jsonl"), "utf8");
    await updatePrompt(dataDir, "missing", (r) => r);
    const after = fs.readFileSync(path.join(dataDir, "prompts.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});

describe("queue", () => {
  it("enqueueJob writes queue/<id>.json; readQueueJobs returns it parsed", () => {
    ensureDataDir(dataDir);
    const j = makeJob({ id: "j1", prompt: "do thing" });
    enqueueJob(dataDir, j);
    expect(fs.existsSync(path.join(dataDir, "queue", "j1.json"))).toBe(true);
    const jobs = readQueueJobs(dataDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("j1");
    expect(jobs[0]!.prompt).toBe("do thing");
  });

  it("readPendingJobs filters and sorts by created_at asc", () => {
    ensureDataDir(dataDir);
    const j1 = makeJob({ id: "j1", created_at: "2026-01-03T00:00:00Z", status: "queued" });
    const j2 = makeJob({ id: "j2", created_at: "2026-01-01T00:00:00Z", status: "assessed" });
    const j3 = makeJob({ id: "j3", created_at: "2026-01-02T00:00:00Z", status: "running" });
    const j4 = makeJob({ id: "j4", created_at: "2026-01-04T00:00:00Z", status: "completed" });
    const j5 = makeJob({ id: "j5", created_at: "2026-01-05T00:00:00Z", status: "failed" });
    enqueueJob(dataDir, j1);
    enqueueJob(dataDir, j2);
    enqueueJob(dataDir, j3);
    enqueueJob(dataDir, j4);
    enqueueJob(dataDir, j5);
    const pending = readPendingJobs(dataDir);
    expect(pending.map((j) => j.id)).toEqual(["j2", "j3", "j1"]);
  });

  it("updateJob overwrites status/updated_at", () => {
    ensureDataDir(dataDir);
    const j = makeJob({ id: "j1", status: "queued", updated_at: "2026-01-01T00:00:00Z" });
    enqueueJob(dataDir, j);
    updateJob(dataDir, { ...j, status: "completed", updated_at: "2026-01-02T00:00:00Z" });
    const jobs = readQueueJobs(dataDir);
    expect(jobs[0]!.status).toBe("completed");
    expect(jobs[0]!.updated_at).toBe("2026-01-02T00:00:00Z");
  });

  it("claimNextJob picks oldest pending, marks running, persists, returns it", () => {
    ensureDataDir(dataDir);
    const j1 = makeJob({ id: "j1", created_at: "2026-01-03T00:00:00Z" });
    const j2 = makeJob({ id: "j2", created_at: "2026-01-01T00:00:00Z" });
    enqueueJob(dataDir, j1);
    enqueueJob(dataDir, j2);
    const claimed = claimNextJob(dataDir);
    expect(claimed?.id).toBe("j2");
    expect(claimed?.status).toBe("running");
    const all = readQueueJobs(dataDir);
    expect(all.find((j) => j.id === "j2")?.status).toBe("running");
    const claimedAgain = claimNextJob(dataDir);
    expect(claimedAgain?.id).toBe("j1");
  });

  it("claimNextJob returns undefined when none pending", () => {
    ensureDataDir(dataDir);
    expect(claimNextJob(dataDir)).toBeUndefined();
  });

  it("claimNextJob stability across simulated restart", () => {
    ensureDataDir(dataDir);
    const j = makeJob({ id: "j1", status: "queued", created_at: "2026-01-01T00:00:00Z" });
    enqueueJob(dataDir, j);
    const claimed = claimNextJob(dataDir);
    expect(claimed?.id).toBe("j1");
    expect(claimed?.status).toBe("running");
    const claimedAgain = claimNextJob(dataDir);
    expect(claimedAgain).toBeUndefined();
    const fresh = makeJob({ id: "j2", status: "queued", created_at: "2026-01-02T00:00:00Z" });
    enqueueJob(dataDir, fresh);
    const claimed2 = claimNextJob(dataDir);
    expect(claimed2?.id).toBe("j2");
  });

  it("claimNextJob reclaims stale running jobs from crashed daemons", () => {
    ensureDataDir(dataDir);
    const now = new Date("2026-01-01T00:11:00.000Z");
    const stale = makeJob({
      id: "j1",
      status: "running",
      attempts: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    enqueueJob(dataDir, stale);
    const claimed = claimNextJob(dataDir, { now, runningJobLeaseMs: DEFAULT_RUNNING_JOB_LEASE_MS });
    expect(claimed?.id).toBe("j1");
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.updated_at).toBe(now.toISOString());
    expect(readQueueJobs(dataDir)[0]!.updated_at).toBe(now.toISOString());
  });

  it("claimNextJob does not reclaim terminal stale running jobs", () => {
    ensureDataDir(dataDir);
    const terminal = makeJob({
      id: "j1",
      status: "running",
      attempts: 3,
      max_attempts: 3,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    enqueueJob(dataDir, terminal);
    const claimed = claimNextJob(dataDir, {
      now: new Date("2026-01-01T00:11:00.000Z"),
      runningJobLeaseMs: DEFAULT_RUNNING_JOB_LEASE_MS,
    });
    expect(claimed).toBeUndefined();
    expect(readQueueJobs(dataDir)[0]).toEqual(terminal);
  });

  it("claimNextJob preserves non-stale running jobs", () => {
    ensureDataDir(dataDir);
    const running = makeJob({
      id: "j1",
      status: "running",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:09:30.000Z",
    });
    enqueueJob(dataDir, running);
    const claimed = claimNextJob(dataDir, {
      now: new Date("2026-01-01T00:10:00.000Z"),
      runningJobLeaseMs: DEFAULT_RUNNING_JOB_LEASE_MS,
    });
    expect(claimed).toBeUndefined();
    expect(readQueueJobs(dataDir)[0]).toEqual(running);
  });

  it("removeJob deletes the file (idempotent if missing)", () => {
    ensureDataDir(dataDir);
    const j = makeJob({ id: "j1" });
    enqueueJob(dataDir, j);
    expect(fs.existsSync(path.join(dataDir, "queue", "j1.json"))).toBe(true);
    removeJob(dataDir, "j1");
    expect(fs.existsSync(path.join(dataDir, "queue", "j1.json"))).toBe(false);
    removeJob(dataDir, "j1");
    removeJob(dataDir, "never-existed");
  });

  it("clearQueueJobs removes all queue json files and is idempotent", () => {
    ensureDataDir(dataDir);
    enqueueJob(dataDir, makeJob({ id: "j1", status: "queued" }));
    enqueueJob(dataDir, makeJob({ id: "j2", status: "running" }));
    fs.writeFileSync(path.join(dataDir, "queue", "keep.txt"), "not a queue job", "utf8");

    expect(clearQueueJobs(dataDir)).toBe(2);
    expect(readQueueJobs(dataDir)).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, "queue", "keep.txt"))).toBe(true);
    expect(clearQueueJobs(dataDir)).toBe(0);
  });
});

describe("id generation", () => {
  it("generateId returns unique strings with prefix", () => {
    const a = generateId("x");
    const b = generateId("x");
    expect(a).not.toBe(b);
    expect(a.startsWith("x_")).toBe(true);
    expect(b.startsWith("x_")).toBe(true);
  });

  it("generatePromptId has p_ prefix", () => {
    const id = generatePromptId();
    expect(id.startsWith("p_")).toBe(true);
  });

  it("generateJobId has j_ prefix", () => {
    const id = generateJobId();
    expect(id.startsWith("j_")).toBe(true);
  });

  it("generatePromptId and generateJobId are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generatePromptId());
      ids.add(generateJobId());
    }
    expect(ids.size).toBe(200);
  });
});

describe("defaultDataDir", () => {
  it("points to ~/.routing-auditor", () => {
    expect(defaultDataDir()).toBe(path.join(os.homedir(), ".routing-auditor"));
  });
});
