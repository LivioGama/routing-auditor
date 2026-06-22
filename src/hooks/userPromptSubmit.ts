import { z } from "zod";
import {
  PromptRecordSchema,
  QueueJobSchema,
  TierSchema,
  type PromptRecord,
  type QueueJob,
  type Tier,
} from "../schemas.ts";
import {
  ensureDataDir,
  readConfig,
  appendPrompt,
  enqueueJob,
  generatePromptId,
  generateJobId,
  defaultDataDir,
} from "../storage.ts";
import { getDataDir as getEnvDataDir, isInternalHookProcess } from "../env.ts";

export const UserPromptSubmitInputSchema = z.object({
  session_id: z.string().default(""),
  turn_id: z.string().optional(),
  prompt: z.string(),
  model: z.string().default("gpt-5.5"),
  model_reasoning_effort: z.string().default("high"),
}).passthrough();

const mapTier = (raw: string): Tier => {
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  const safe = TierSchema.safeParse(raw);
  if (safe.success) return safe.data;
  return "high";
};

export const handleUserPromptSubmit = (
  input: unknown,
  dataDir: string,
): { record_id: string; job_id: string; notices: string[] } => {
  const parsed = UserPromptSubmitInputSchema.parse(input);
  const tier = mapTier(parsed.model_reasoning_effort);
  const now = new Date().toISOString();
  ensureDataDir(dataDir);

  const record: PromptRecord = PromptRecordSchema.parse({
    id: generatePromptId(),
    timestamp: now,
    session_id: parsed.session_id,
    turn_id: parsed.turn_id,
    prompt: parsed.prompt,
    codex_model: parsed.model,
    codex_tier: tier,
    verified: false,
  });
  appendPrompt(dataDir, record);

  const job: QueueJob = QueueJobSchema.parse({
    id: generateJobId(),
    prompt_record_id: record.id,
    session_id: parsed.session_id,
    turn_id: parsed.turn_id,
    prompt: parsed.prompt,
    codex_model: parsed.model,
    codex_tier: tier,
    status: "queued",
    created_at: now,
    updated_at: now,
  });
  enqueueJob(dataDir, job);

  return { record_id: record.id, job_id: job.id, notices: [] };
};

export const runUserPromptSubmitHook = async (): Promise<void> => {
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
    ensureDataDir(dataDir);
    const config = readConfig(dataDir);
    if (!config.enabled) {
      process.exit(0);
    }
    handleUserPromptSubmit(payload, dataDir);
  } catch (err) {
    // Codex validates hook stdout strictly. Keep capture failures non-blocking.
  }
  process.exit(0);
};
