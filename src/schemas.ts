import { z } from "zod";

export type Tier = "low" | "medium" | "high";
export const TierSchema = z.enum(["low", "medium", "high"]);

export const ModelTierSchema = z.object({
  model: z.string(),
  tier: TierSchema,
});
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const AcceptableModelSchema = ModelTierSchema.extend({
  predicted_quality_score: z.number().min(0).max(100),
});
export type AcceptableModel = z.infer<typeof AcceptableModelSchema>;

export const AssessmentLLMOutputSchema = z.object({
  recommended_model: z.string(),
  recommended_tier: TierSchema,
  acceptable_models: z.array(AcceptableModelSchema).default([]),
  confidence: z.number().min(0).max(100),
  reasoning_score: z.number().min(0).max(10),
  coding_score: z.number().min(0).max(10),
  ambiguity_score: z.number().min(0).max(10),
  context_pressure_score: z.number().min(0).max(10),
  instruction_complexity_score: z.number().min(0).max(10),
  explanation: z.string().default(""),
});
export type AssessmentLLMOutput = z.infer<typeof AssessmentLLMOutputSchema>;

export const AssessmentSchema = AssessmentLLMOutputSchema.extend({
  model: z.string(),
  tier: TierSchema,
  input_tokens: z.number().min(0).default(0),
  output_tokens: z.number().min(0).default(0),
  latency_ms: z.number().min(0).default(0),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const TokenUsageSchema = z.object({
  input_tokens: z.number().min(0).default(0),
  output_tokens: z.number().min(0).default(0),
  estimated: z.boolean().default(false),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ExecutionArtifactSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean().default(false),
});
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

export const ActualExecutionSchema = z.object({
  model: z.string(),
  tier: TierSchema,
  output: z.string().default(""),
  artifacts: z.array(ExecutionArtifactSchema).optional(),
  input_tokens: z.number().min(0).default(0),
  output_tokens: z.number().min(0).default(0),
  estimated: z.boolean().default(false),
  latency_ms: z.number().min(0).default(0),
  captured: z.boolean().default(false),
});
export type ActualExecution = z.infer<typeof ActualExecutionSchema>;

export const VerificationSchema = z.object({
  model: z.string(),
  tier: TierSchema,
  output: z.string().default(""),
  artifacts: z.array(ExecutionArtifactSchema).optional(),
  input_tokens: z.number().min(0).default(0),
  output_tokens: z.number().min(0).default(0),
  estimated: z.boolean().default(false),
  latency_ms: z.number().min(0).default(0),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]).default("pending"),
  error: z.string().default(""),
  verified_at: z.string().default(""),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const JudgeResultSchema = z.object({
  winner: z.enum(["original", "predicted", "tie"]),
  original_quality_score: z.number().min(0).max(100),
  cheaper_quality_score: z.number().min(0).max(100),
  quality_gap_score: z.number(),
  reasoning: z.string().default(""),
  input_tokens: z.number().min(0).default(0),
  output_tokens: z.number().min(0).default(0),
  estimated: z.boolean().default(false),
  latency_ms: z.number().min(0).default(0),
  judged_at: z.string().default(""),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const CostsSchema = z.object({
  assessment_cost: z.number().min(0).default(0),
  verification_cost: z.number().min(0).default(0),
  judge_cost: z.number().min(0).default(0),
  total_audit_cost: z.number().min(0).default(0),
  actual_execution_cost: z.number().min(0).default(0),
  predicted_execution_cost: z.number().min(0).default(0),
  gross_savings: z.number().default(0),
  net_savings: z.number().default(0),
  learning_investment: z.number().min(0).default(0),
});
export type Costs = z.infer<typeof CostsSchema>;

export const PromptRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  session_id: z.string().default(""),
  turn_id: z.string().optional(),
  prompt: z.string(),
  codex_model: z.string().default(""),
  codex_tier: TierSchema.default("high"),
  actual_execution: ActualExecutionSchema.optional(),
  assessment: AssessmentSchema.optional(),
  verification: VerificationSchema.optional(),
  judge: JudgeResultSchema.optional(),
  costs: CostsSchema.optional(),
  verified: z.boolean().default(false),
  verification_succeeded: z.boolean().default(false),
  completion_notice_shown: z.boolean().default(false),
});
export type PromptRecord = z.infer<typeof PromptRecordSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "assessed",
  "verified",
  "judged",
  "completed",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const QueueJobSchema = z.object({
  id: z.string(),
  prompt_record_id: z.string(),
  session_id: z.string().default(""),
  turn_id: z.string().optional(),
  prompt: z.string(),
  codex_model: z.string().default(""),
  codex_tier: TierSchema.default("high"),
  status: JobStatusSchema.default("queued"),
  attempts: z.number().min(0).default(0),
  max_attempts: z.number().min(1).default(3),
  created_at: z.string(),
  updated_at: z.string(),
  last_error: z.string().default(""),
  actual_output: z.string().default(""),
  actual_captured: z.boolean().default(false),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const PriceSchema = z.object({
  input: z.number().min(0).default(0),
  output: z.number().min(0).default(0),
});
export type Price = z.infer<typeof PriceSchema>;

export const PricingSchema = z.record(z.string(), PriceSchema);
export type Pricing = z.infer<typeof PricingSchema>;

export const ModelDefinitionSchema = z.object({
  name: z.string(),
  tiers: z.array(TierSchema).default(["low", "medium", "high"]),
});
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

export const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  assessmentModel: z.string().default("gpt-5.5-high"),
  judgeModel: z.string().default("gpt-5.5-high"),
  verificationEnabled: z.boolean().default(true),
  stopHookEnabled: z.boolean().default(true),
  backgroundNoticeEnabled: z.boolean().default(true),
  noticeTimeoutMs: z.number().min(0).default(300000),
  noticeChannel: z.enum(["tty", "desktop", "both"]).default("both"),
  verificationThreshold: z.number().min(0).default(5),
  fastMode: z.boolean().default(true),
  pricing: PricingSchema.default({}),
  models: z.array(ModelDefinitionSchema).default([]),
  acpCommand: z.string().default("codex-acp"),
  acpArgs: z.array(z.string()).default([]),
  datasetValuePerRecord: z.number().min(0).default(0.05),
  projectionHorizonDays: z.number().min(1).default(30),
  pollIntervalMs: z.number().min(100).default(2000),
  maxConcurrentJobs: z.number().min(1).default(1),
  maxSuggestedModels: z.number().int().min(1).default(1),
  retentionDays: z.number().min(0).default(90),
  redactPrompts: z.boolean().default(false),
  redactOutputs: z.boolean().default(false),
});
export type Config = z.infer<typeof ConfigSchema>;

export const StatsSchema = z.object({
  prompts_analyzed: z.number().min(0).default(0),
  prompts_verified: z.number().min(0).default(0),
  verification_succeeded: z.number().min(0).default(0),
  verification_failed: z.number().min(0).default(0),
  unjudged_verified: z.number().min(0).default(0),
  total_assessment_cost: z.number().min(0).default(0),
  total_verification_cost: z.number().min(0).default(0),
  total_judge_cost: z.number().min(0).default(0),
  total_audit_cost: z.number().min(0).default(0),
  total_actual_execution_cost: z.number().min(0).default(0),
  total_predicted_execution_cost: z.number().min(0).default(0),
  total_gross_savings: z.number().default(0),
  total_net_savings: z.number().default(0),
  total_learning_investment: z.number().min(0).default(0),
  total_assessment_input_tokens: z.number().min(0).default(0),
  total_assessment_output_tokens: z.number().min(0).default(0),
  total_actual_input_tokens: z.number().min(0).default(0),
  total_actual_output_tokens: z.number().min(0).default(0),
  total_verification_input_tokens: z.number().min(0).default(0),
  total_verification_output_tokens: z.number().min(0).default(0),
  total_judge_input_tokens: z.number().min(0).default(0),
  total_judge_output_tokens: z.number().min(0).default(0),
  total_actual_latency_ms: z.number().min(0).default(0),
  total_predicted_latency_ms: z.number().min(0).default(0),
  model_recommendations: z.record(z.string(), z.number()).default({}),
  tier_recommendations: z.record(z.string(), z.number()).default({}),
  confidence_distribution: z
    .object({
      low: z.number().default(0),
      medium: z.number().default(0),
      high: z.number().default(0),
    })
    .default({ low: 0, medium: 0, high: 0 }),
  first_prompt_at: z.string().default(""),
  last_prompt_at: z.string().default(""),
  last_updated: z.string().default(""),
});
export type Stats = z.infer<typeof StatsSchema>;

export function defaultStats(): Stats {
  return StatsSchema.parse({});
}

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    pricing: {
      "gpt-5.5-low": { input: 5.0, output: 30.0 },
      "gpt-5.5-medium": { input: 5.0, output: 30.0 },
      "gpt-5.5-high": { input: 5.0, output: 30.0 },
      "gpt-5.4-low": { input: 2.5, output: 15.0 },
      "gpt-5.4-medium": { input: 2.5, output: 15.0 },
      "gpt-5.4-high": { input: 2.5, output: 15.0 },
      "gpt-5.4-mini-low": { input: 0.75, output: 4.5 },
      "gpt-5.4-mini-medium": { input: 0.75, output: 4.5 },
      "gpt-5.4-mini-high": { input: 0.75, output: 4.5 },
      "gpt-5.3-codex-low": { input: 1.75, output: 14.0 },
      "gpt-5.3-codex-medium": { input: 1.75, output: 14.0 },
      "gpt-5.3-codex-high": { input: 1.75, output: 14.0 },
    },
    models: [
      { name: "gpt-5.5", tiers: ["low", "medium", "high"] },
      { name: "gpt-5.4", tiers: ["low", "medium", "high"] },
      { name: "gpt-5.4-mini", tiers: ["low", "medium", "high"] },
      { name: "gpt-5.3-codex", tiers: ["low", "medium", "high"] },
    ],
    ...overrides,
  });
}

export function modelTierKey(model: string, tier: Tier): string {
  return `${model}-${tier}`;
}

export function splitModelTier(key: string): { model: string; tier: Tier } {
  const idx = key.lastIndexOf("-");
  if (idx <= 0) return { model: key, tier: "high" };
  const model = key.slice(0, idx);
  const tier = key.slice(idx + 1);
  if (tier === "low" || tier === "medium" || tier === "high") {
    return { model, tier };
  }
  return { model: key, tier: "high" };
}

export function confidenceBucket(confidence: number): "low" | "medium" | "high" {
  if (confidence < 50) return "low";
  if (confidence < 80) return "medium";
  return "high";
}
