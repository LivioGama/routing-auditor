import { describe, it, expect } from "bun:test";
import {
  AssessmentSchema,
  ConfigSchema,
  ActualExecutionSchema,
  VerificationSchema,
  JudgeResultSchema,
  PromptRecordSchema,
  QueueJobSchema,
  StatsSchema,
  TierSchema,
  confidenceBucket,
  defaultConfig,
  defaultStats,
  modelTierKey,
  splitModelTier,
} from "../src/schemas.ts";

describe("TierSchema", () => {
  it("accepts low/medium/high", () => {
    expect(TierSchema.parse("low")).toBe("low");
    expect(TierSchema.parse("medium")).toBe("medium");
    expect(TierSchema.parse("high")).toBe("high");
  });
  it("rejects unknown", () => {
    expect(() => TierSchema.parse("xhigh")).toThrow();
  });
});

describe("AssessmentSchema", () => {
  it("parses a full assessment with defaults", () => {
    const a = AssessmentSchema.parse({
      recommended_model: "gpt-5.5",
      recommended_tier: "medium",
      acceptable_models: [
        { model: "gpt-5.5", tier: "low", predicted_quality_score: 84 },
        { model: "gpt-5.5", tier: "medium", predicted_quality_score: 95 },
      ],
      confidence: 91,
      reasoning_score: 2,
      coding_score: 5,
      ambiguity_score: 1,
      context_pressure_score: 2,
      instruction_complexity_score: 3,
      explanation: "simple refactor",
      model: "gpt-5.5-high",
      tier: "high",
    });
    expect(a.input_tokens).toBe(0);
    expect(a.acceptable_models).toHaveLength(2);
    expect(a.acceptable_models[1]?.predicted_quality_score).toBe(95);
  });
});

describe("JudgeResultSchema", () => {
  it("parses a judge result", () => {
    const j = JudgeResultSchema.parse({
      winner: "predicted",
      original_quality_score: 96,
      cheaper_quality_score: 94,
      quality_gap_score: 2,
      reasoning: "equivalent",
    });
    expect(j.winner).toBe("predicted");
    expect(j.input_tokens).toBe(0);
  });
});

describe("execution artifact schemas", () => {
  it("keeps artifacts optional for backward compatibility", () => {
    const actual = ActualExecutionSchema.parse({
      model: "gpt-5.5",
      tier: "high",
      output: "done",
      captured: true,
    });
    const verification = VerificationSchema.parse({
      model: "gpt-5.3-codex",
      tier: "medium",
      output: "done",
      status: "succeeded",
    });

    expect(actual.artifacts).toBeUndefined();
    expect(verification.artifacts).toBeUndefined();
  });

  it("parses captured execution artifacts", () => {
    const actual = ActualExecutionSchema.parse({
      model: "gpt-5.5",
      tier: "high",
      output: "wrote index.html",
      captured: true,
      artifacts: [{ path: "index.html", content: "<h1>Hello</h1>" }],
    });

    expect(actual.artifacts).toEqual([
      { path: "index.html", content: "<h1>Hello</h1>", truncated: false },
    ]);
  });
});

describe("PromptRecordSchema", () => {
  it("parses a minimal record", () => {
    const r = PromptRecordSchema.parse({
      id: "r1",
      timestamp: "2026-01-01T00:00:00Z",
      prompt: "hello",
    });
    expect(r.verified).toBe(false);
    expect(r.codex_tier).toBe("high");
    expect(r.session_id).toBe("");
  });
});

describe("QueueJobSchema", () => {
  it("parses a queued job with defaults", () => {
    const j = QueueJobSchema.parse({
      id: "j1",
      prompt_record_id: "r1",
      prompt: "hello",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(0);
    expect(j.max_attempts).toBe(3);
  });
});

describe("ConfigSchema / defaultConfig", () => {
  it("defaultConfig has OpenAI API pricing defaults", () => {
    const c = defaultConfig();
    expect(c.enabled).toBe(true);
    expect(c.assessmentModel).toBe("gpt-5.5-high");
    expect(c.verificationEnabled).toBe(true);
    expect(c.stopHookEnabled).toBe(true);
    expect(c.backgroundNoticeEnabled).toBe(true);
    expect(c.noticeTimeoutMs).toBe(300000);
    expect(c.noticeChannel).toBe("both");
    expect(c.verificationThreshold).toBe(5);
    expect(c.maxSuggestedModels).toBe(1);
    expect(c.pricing["gpt-5.5-high"]).toEqual({ input: 5, output: 30 });
    expect(c.pricing["gpt-5.4-mini-low"]).toEqual({ input: 0.75, output: 4.5 });
    expect(c.pricing["gpt-5.3-codex-high"]).toEqual({ input: 1.75, output: 14 });
    expect(c.acpCommand).toBe("codex-acp");
  });
  it("ConfigSchema accepts overrides", () => {
    const c = ConfigSchema.parse({
      assessmentModel: "gpt-5.5-medium",
      enabled: false,
      verificationEnabled: false,
      pricing: { "gpt-5.5-low": { input: 1, output: 2 } },
    });
    expect(c.assessmentModel).toBe("gpt-5.5-medium");
    expect(c.enabled).toBe(false);
    expect(c.verificationEnabled).toBe(false);
    expect(c.stopHookEnabled).toBe(true);
    expect(c.backgroundNoticeEnabled).toBe(true);
    expect(c.noticeTimeoutMs).toBe(300000);
    expect(c.noticeChannel).toBe("both");
    expect(c.pollIntervalMs).toBe(2000);
  });
});

describe("StatsSchema / defaultStats", () => {
  it("defaultStats is all zeros", () => {
    const s = defaultStats();
    expect(s.prompts_analyzed).toBe(0);
    expect(s.total_gross_savings).toBe(0);
    expect(s.confidence_distribution.low).toBe(0);
  });
});

describe("modelTierKey / splitModelTier", () => {
  it("round-trips", () => {
    const k = modelTierKey("gpt-5.5", "medium");
    expect(k).toBe("gpt-5.5-medium");
    const { model, tier } = splitModelTier(k);
    expect(model).toBe("gpt-5.5");
    expect(tier).toBe("medium");
  });
  it("splitModelTier handles unknown tier as high", () => {
    const { model, tier } = splitModelTier("gpt-5.5-xhigh");
    expect(model).toBe("gpt-5.5-xhigh");
    expect(tier).toBe("high");
  });
});

describe("confidenceBucket", () => {
  it("buckets correctly", () => {
    expect(confidenceBucket(10)).toBe("low");
    expect(confidenceBucket(60)).toBe("medium");
    expect(confidenceBucket(95)).toBe("high");
  });
});
