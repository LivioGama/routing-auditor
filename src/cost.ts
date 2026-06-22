import type {
  Pricing,
  Assessment,
  Verification,
  ActualExecution,
  JudgeResult,
  Costs,
  Stats,
  Tier,
  PromptRecord,
} from "./schemas.ts";
import { priceFor, cost, costFor, estimateTokens } from "./pricing.ts";
import { splitModelTier, confidenceBucket } from "./schemas.ts";

export { priceFor, cost, costFor, estimateTokens };

export const assessmentCost = (pricing: Pricing, a: Assessment): number =>
  costFor(pricing, a.model, a.tier, a.input_tokens, a.output_tokens);

export const verificationCost = (pricing: Pricing, v: Verification): number =>
  costFor(pricing, v.model, v.tier, v.input_tokens, v.output_tokens);

export const judgeCost = (pricing: Pricing, judgeModelKey: string, j: JudgeResult): number => {
  const { model, tier } = splitModelTier(judgeModelKey);
  const price = priceFor(pricing, model, tier);
  return cost(price, j.input_tokens, j.output_tokens);
};

export const actualExecutionCost = (pricing: Pricing, actual: ActualExecution): number =>
  costFor(pricing, actual.model, actual.tier, actual.input_tokens, actual.output_tokens);

export const predictedExecutionCost = (
  pricing: Pricing,
  recommendedModel: string,
  recommendedTier: Tier,
  v: Verification,
): number => costFor(pricing, recommendedModel, recommendedTier, v.input_tokens, v.output_tokens);

export const computeCosts = (params: {
  pricing: Pricing;
  assessment?: Assessment;
  verification?: Verification;
  judge?: JudgeResult;
  judgeModelKey?: string;
  actual?: ActualExecution;
  recommendedModel?: string;
  recommendedTier?: Tier;
  verificationSucceeded: boolean;
}): Costs => {
  const assessment_cost = params.assessment
    ? assessmentCost(params.pricing, params.assessment)
    : 0;
  const verification_cost = params.verification
    ? verificationCost(params.pricing, params.verification)
    : 0;
  const judge_cost =
    params.judge && params.judgeModelKey
      ? judgeCost(params.pricing, params.judgeModelKey, params.judge)
      : 0;
  const total_audit_cost = assessment_cost + verification_cost + judge_cost;
  const actual_execution_cost = params.actual ? actualExecutionCost(params.pricing, params.actual) : 0;
  const predicted_execution_cost =
    params.verification && params.recommendedModel && params.recommendedTier
      ? predictedExecutionCost(
          params.pricing,
          params.recommendedModel,
          params.recommendedTier,
          params.verification,
        )
      : 0;
  const gross_savings = params.verificationSucceeded
    ? actual_execution_cost - predicted_execution_cost
    : 0;
  const net_savings = gross_savings - total_audit_cost;
  return {
    assessment_cost,
    verification_cost,
    judge_cost,
    total_audit_cost,
    actual_execution_cost,
    predicted_execution_cost,
    gross_savings,
    net_savings,
    learning_investment: total_audit_cost,
  };
};

const addRecord = (acc: Record<string, number>, key: string): Record<string, number> => {
  const next = { ...acc };
  next[key] = (next[key] ?? 0) + 1;
  return next;
};

const minIso = (a: string, b: string): string => (a === "" ? b : b === "" ? a : a < b ? a : b);
const maxIso = (a: string, b: string): string => (a === "" ? b : b === "" ? a : a > b ? a : b);

export const applyRecordToStats = (stats: Stats, record: PromptRecord): Stats => {
  const next: Stats = { ...stats };
  next.model_recommendations = { ...stats.model_recommendations };
  next.tier_recommendations = { ...stats.tier_recommendations };
  next.confidence_distribution = { ...stats.confidence_distribution };

  const costs = record.costs;
  if (costs) {
    next.total_assessment_cost += costs.assessment_cost;
    next.total_verification_cost += costs.verification_cost;
    next.total_judge_cost += costs.judge_cost;
    next.total_audit_cost += costs.total_audit_cost;
    next.total_actual_execution_cost += costs.actual_execution_cost;
    next.total_predicted_execution_cost += costs.predicted_execution_cost;
    next.total_gross_savings += costs.gross_savings;
    next.total_net_savings += costs.net_savings;
    next.total_learning_investment += costs.learning_investment;
  }

  const a = record.assessment;
  if (a) {
    next.prompts_analyzed += 1;
    next.total_assessment_input_tokens += a.input_tokens;
    next.total_assessment_output_tokens += a.output_tokens;
    next.model_recommendations = addRecord(next.model_recommendations, a.recommended_model);
    next.tier_recommendations = addRecord(next.tier_recommendations, a.recommended_tier);
    const bucket = confidenceBucket(a.confidence);
    next.confidence_distribution = {
      ...next.confidence_distribution,
      [bucket]: (next.confidence_distribution[bucket] ?? 0) + 1,
    };
    next.first_prompt_at = minIso(next.first_prompt_at, record.timestamp);
    next.last_prompt_at = maxIso(next.last_prompt_at, record.timestamp);
  }

  const v = record.verification;
  if (v) {
    next.total_verification_input_tokens += v.input_tokens;
    next.total_verification_output_tokens += v.output_tokens;
    next.total_predicted_latency_ms += v.latency_ms;
  }

  if (record.verified) {
    next.prompts_verified += 1;
    if (record.verification_succeeded) {
      next.verification_succeeded += 1;
      // Track unjudged verifications (succeeded without judge due to no actual output)
      if (!record.judge) {
        next.unjudged_verified += 1;
      }
    } else {
      next.verification_failed += 1;
    }
  }

  const j = record.judge;
  if (j) {
    next.total_judge_input_tokens += j.input_tokens;
    next.total_judge_output_tokens += j.output_tokens;
  }

  const actual = record.actual_execution;
  if (actual) {
    next.total_actual_input_tokens += actual.input_tokens;
    next.total_actual_output_tokens += actual.output_tokens;
    next.total_actual_latency_ms += actual.latency_ms;
    next.first_prompt_at = minIso(next.first_prompt_at, record.timestamp);
    next.last_prompt_at = maxIso(next.last_prompt_at, record.timestamp);
  }

  next.last_updated = new Date().toISOString();
  return next;
};
