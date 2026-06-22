import { describe, it, expect } from "bun:test";
import type { Pricing, Assessment, Verification, ActualExecution, JudgeResult, PromptRecord } from "../src/schemas.ts";
import {
  assessmentCost,
  verificationCost,
  judgeCost,
  actualExecutionCost,
  predictedExecutionCost,
  computeCosts,
  applyRecordToStats,
} from "../src/cost.ts";
import { defaultStats, AssessmentSchema, VerificationSchema, ActualExecutionSchema, JudgeResultSchema, PromptRecordSchema } from "../src/schemas.ts";

const pricing: Pricing = {
  "gpt-5.5-low": { input: 0.5, output: 2 },
  "gpt-5.5-medium": { input: 1, output: 4 },
  "gpt-5.5-high": { input: 1.5, output: 6 },
};

const makeAssessment = (over: Partial<Assessment> = {}): Assessment =>
  AssessmentSchema.parse({
    recommended_model: "gpt-5.5",
    recommended_tier: "low",
    confidence: 90,
    reasoning_score: 2,
    coding_score: 3,
    ambiguity_score: 1,
    context_pressure_score: 2,
    instruction_complexity_score: 2,
    explanation: "x",
    model: "gpt-5.5",
    tier: "high",
    input_tokens: 1000,
    output_tokens: 500,
    ...over,
  });

const makeVerification = (over: Partial<Verification> = {}): Verification =>
  VerificationSchema.parse({
    model: "gpt-5.5",
    tier: "low",
    input_tokens: 800,
    output_tokens: 400,
    status: "succeeded",
    ...over,
  });

const makeActual = (over: Partial<ActualExecution> = {}): ActualExecution =>
  ActualExecutionSchema.parse({
    model: "gpt-5.5",
    tier: "high",
    input_tokens: 1000,
    output_tokens: 500,
    ...over,
  });

const makeJudge = (over: Partial<JudgeResult> = {}): JudgeResult =>
  JudgeResultSchema.parse({
    winner: "tie",
    original_quality_score: 95,
    cheaper_quality_score: 94,
    quality_gap_score: 1,
    reasoning: "equivalent",
    input_tokens: 2000,
    output_tokens: 300,
    ...over,
  });

describe("assessmentCost", () => {
  it("uses assessment.model/tier and tokens", () => {
    const a = makeAssessment();
    const expected = (1.5 * 1000) / 1e6 + (6 * 500) / 1e6;
    expect(assessmentCost(pricing, a)).toBe(Math.round(expected * 1e6) / 1e6);
  });
});

describe("verificationCost", () => {
  it("uses verification.model/tier", () => {
    const v = makeVerification();
    const expected = (0.5 * 800) / 1e6 + (2 * 400) / 1e6;
    expect(verificationCost(pricing, v)).toBe(Math.round(expected * 1e6) / 1e6);
  });
});

describe("judgeCost", () => {
  it("uses the judgeModelKey split via splitModelTier", () => {
    const j = makeJudge();
    const expected = (1.5 * 2000) / 1e6 + (6 * 300) / 1e6;
    expect(judgeCost(pricing, "gpt-5.5-high", j)).toBe(Math.round(expected * 1e6) / 1e6);
  });
});

describe("actualExecutionCost", () => {
  it("uses actual.model/tier", () => {
    const actual = makeActual();
    const expected = (1.5 * 1000) / 1e6 + (6 * 500) / 1e6;
    expect(actualExecutionCost(pricing, actual)).toBe(Math.round(expected * 1e6) / 1e6);
  });
});

describe("predictedExecutionCost", () => {
  it("uses recommended model/tier with verification tokens", () => {
    const v = makeVerification();
    const expected = (0.5 * 800) / 1e6 + (2 * 400) / 1e6;
    expect(predictedExecutionCost(pricing, "gpt-5.5", "low", v)).toBe(Math.round(expected * 1e6) / 1e6);
  });
});

describe("computeCosts", () => {
  it("full happy path: gross_savings = diff, net = gross - audit", () => {
    const a = makeAssessment({ recommended_model: "gpt-5.5", recommended_tier: "low" });
    const v = makeVerification({ model: "gpt-5.5", tier: "low", input_tokens: 800, output_tokens: 400 });
    const j = makeJudge();
    const actual = makeActual({ model: "gpt-5.5", tier: "high", input_tokens: 1000, output_tokens: 500 });
    const costs = computeCosts({
      pricing,
      assessment: a,
      verification: v,
      judge: j,
      judgeModelKey: "gpt-5.5-high",
      actual,
      recommendedModel: "gpt-5.5",
      recommendedTier: "low",
      verificationSucceeded: true,
    });
    const ac = assessmentCost(pricing, a);
    const vc = verificationCost(pricing, v);
    const jc = judgeCost(pricing, "gpt-5.5-high", j);
    expect(costs.assessment_cost).toBe(ac);
    expect(costs.verification_cost).toBe(vc);
    expect(costs.judge_cost).toBe(jc);
    const totalAudit = ac + vc + jc;
    expect(costs.total_audit_cost).toBe(totalAudit);
    expect(costs.learning_investment).toBe(totalAudit);
    const actualC = actualExecutionCost(pricing, actual);
    const predC = predictedExecutionCost(pricing, "gpt-5.5", "low", v);
    expect(costs.actual_execution_cost).toBe(actualC);
    expect(costs.predicted_execution_cost).toBe(predC);
    expect(actualC).toBeGreaterThan(predC);
    const gross = actualC - predC;
    expect(costs.gross_savings).toBe(gross);
    expect(costs.net_savings).toBe(gross - totalAudit);
  });

  it("verificationSucceeded=false -> gross_savings=0, net=-total_audit", () => {
    const a = makeAssessment();
    const v = makeVerification();
    const j = makeJudge();
    const actual = makeActual();
    const costs = computeCosts({
      pricing,
      assessment: a,
      verification: v,
      judge: j,
      judgeModelKey: "gpt-5.5-high",
      actual,
      recommendedModel: "gpt-5.5",
      recommendedTier: "low",
      verificationSucceeded: false,
    });
    expect(costs.gross_savings).toBe(0);
    expect(costs.net_savings).toBe(-costs.total_audit_cost);
  });

  it("predicted cost > actual cost -> gross_savings negative, net_savings negative", () => {
    const a = makeAssessment();
    const actual = makeActual({ model: "gpt-5.5", tier: "low", input_tokens: 10, output_tokens: 5 });
    const v = makeVerification({ model: "gpt-5.5", tier: "high", input_tokens: 1000, output_tokens: 500 });
    const costs = computeCosts({
      pricing,
      assessment: a,
      verification: v,
      recommendedModel: "gpt-5.5",
      recommendedTier: "high",
      actual,
      verificationSucceeded: true,
    });
    expect(costs.actual_execution_cost).toBeLessThan(costs.predicted_execution_cost);
    const expectedGross = costs.actual_execution_cost - costs.predicted_execution_cost;
    expect(costs.gross_savings).toBe(expectedGross);
    expect(costs.gross_savings).toBeLessThan(0);
    expect(costs.net_savings).toBe(expectedGross - costs.total_audit_cost);
    expect(costs.net_savings).toBeLessThan(0);
  });

  it("missing assessment/verification/judge -> those costs are 0, no NaN", () => {
    const actual = makeActual();
    const costs = computeCosts({
      pricing,
      actual,
      verificationSucceeded: false,
    });
    expect(costs.assessment_cost).toBe(0);
    expect(costs.verification_cost).toBe(0);
    expect(costs.judge_cost).toBe(0);
    expect(costs.total_audit_cost).toBe(0);
    expect(costs.predicted_execution_cost).toBe(0);
    expect(Number.isNaN(costs.net_savings)).toBe(false);
  });
});

describe("applyRecordToStats", () => {
  const makeRecord = (over: Partial<PromptRecord> = {}): PromptRecord =>
    PromptRecordSchema.parse({
      id: "r1",
      timestamp: "2026-01-01T00:00:00Z",
      prompt: "hello",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      session_id: "s1",
      verified: true,
      verification_succeeded: true,
      assessment: makeAssessment({ recommended_model: "gpt-5.5", recommended_tier: "low", confidence: 90 }),
      verification: makeVerification(),
      judge: makeJudge(),
      actual_execution: makeActual(),
      costs: computeCosts({
        pricing,
        assessment: makeAssessment(),
        verification: makeVerification(),
        judge: makeJudge(),
        judgeModelKey: "gpt-5.5-high",
        actual: makeActual(),
        recommendedModel: "gpt-5.5",
        recommendedTier: "low",
        verificationSucceeded: true,
      }),
      ...over,
    });

  it("adds costs to totals and increments counters, updates distributions + timestamps", () => {
    const base = defaultStats();
    const record = makeRecord();
    const next = applyRecordToStats(base, record);
    expect(next.prompts_analyzed).toBe(1);
    expect(next.prompts_verified).toBe(1);
    expect(next.verification_succeeded).toBe(1);
    expect(next.verification_failed).toBe(0);
    expect(next.total_audit_cost).toBe(record.costs!.total_audit_cost);
    expect(next.total_gross_savings).toBe(record.costs!.gross_savings);
    expect(next.total_net_savings).toBe(record.costs!.net_savings);
    expect(next.model_recommendations["gpt-5.5"]).toBe(1);
    expect(next.tier_recommendations["low"]).toBe(1);
    expect(next.confidence_distribution.high).toBe(1);
    expect(next.first_prompt_at).toBe("2026-01-01T00:00:00Z");
    expect(next.last_prompt_at).toBe("2026-01-01T00:00:00Z");
    expect(next.total_assessment_input_tokens).toBe(record.assessment!.input_tokens);
    expect(next.total_verification_input_tokens).toBe(record.verification!.input_tokens);
    expect(next.total_judge_input_tokens).toBe(record.judge!.input_tokens);
    expect(next.total_actual_input_tokens).toBe(record.actual_execution!.input_tokens);
  });

  it("does NOT mutate input stats", () => {
    const base = defaultStats();
    const frozen = JSON.parse(JSON.stringify(base));
    const record = makeRecord();
    applyRecordToStats(base, record);
    expect(JSON.parse(JSON.stringify(base))).toEqual(frozen);
  });

  it("record with no assessment -> prompts_analyzed unchanged", () => {
    const base = defaultStats();
    const record = makeRecord({ assessment: undefined });
    const next = applyRecordToStats(base, record);
    expect(next.prompts_analyzed).toBe(0);
    expect(next.model_recommendations).toEqual({});
    expect(next.tier_recommendations).toEqual({});
    expect(next.confidence_distribution).toEqual({ low: 0, medium: 0, high: 0 });
  });

  it("counts verified records even when no judge result exists", () => {
    const base = defaultStats();
    const record = makeRecord({ judge: undefined });
    const next = applyRecordToStats(base, record);
    expect(next.prompts_verified).toBe(1);
    expect(next.verification_succeeded).toBe(1);
    expect(next.verification_failed).toBe(0);
    expect(next.total_judge_input_tokens).toBe(0);
  });
});
