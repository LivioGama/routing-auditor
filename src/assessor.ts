import type { AcceptableModel, Assessment, AssessmentLLMOutput, Config, Tier } from "./schemas.ts";
import { AssessmentLLMOutputSchema, AssessmentSchema, modelTierKey, splitModelTier } from "./schemas.ts";
import { runPrompt, type RunnerOptions, type RunResult } from "./acp/runner.ts";
import { stripFences } from "./utils/json.ts";

export class AssessmentError extends Error {
  raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.name = "AssessmentError";
    this.raw = raw;
  }
}

export interface AssessOptions {
  config: Config;
  prompt: string;
  codexModel: string;
  codexTier: Tier;
  runner?: typeof runPrompt;
  runnerOptionsOverrides?: Partial<RunnerOptions>;
  fastMode?: boolean;
}

export const ASSESSMENT_PROMPT_TEMPLATE = `You are a routing auditor. Analyze the following prompt and determine the minimum model + reasoning tier that would produce an equivalent-quality result.

Actual model used by Codex: <codexModel>
Actual tier used by Codex: <codexTier>

User prompt to audit:
"""
<prompt>
"""

Configured candidate routes, cheapest first:
<candidateRoutes>

Choose the CHEAPEST route from that configured list that would produce equivalent-quality result, BUT ONLY if it meets a minimum quality threshold of 90/100.
Prioritize routes with quality >= 90, then choose the cheapest among those.
Do not prefer the same model family when a cheaper family is acceptable.
Include every acceptable route from the configured list in acceptable_models with a predicted_quality_score (0-100),
then set recommended_model and recommended_tier to the cheapest route that meets the quality threshold (cheapest as tiebreaker).

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "recommended_model": "<bare model name e.g. gpt-5.5>",
  "recommended_tier": "low" | "medium" | "high",
  "acceptable_models": [{"model": "...", "tier": "low"|"medium"|"high", "predicted_quality_score": 0-100}],
  "confidence": 0-100,
  "reasoning_score": 0-10,
  "coding_score": 0-10,
  "ambiguity_score": 0-10,
  "context_pressure_score": 0-10,
  "instruction_complexity_score": 0-10,
  "explanation": "<brief justification>"
}`;

export const buildAssessmentPrompt = (
  prompt: string,
  codexModel: string,
  codexTier: Tier,
  candidateRoutes = "- Use the configured candidate routes.",
): string =>
  ASSESSMENT_PROMPT_TEMPLATE
    .replace("<codexModel>", codexModel)
    .replace("<codexTier>", codexTier)
    .replace("<prompt>", prompt)
    .replace("<candidateRoutes>", candidateRoutes);

const tierRank = (tier: Tier): number => {
  if (tier === "low") return 0;
  if (tier === "medium") return 1;
  return 2;
};

const modelRank = (config: Config, modelName: string): number => {
  const idx = config.models.findIndex((m) => m.name === modelName);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
};

const routeCost = (config: Config, route: AcceptableModel): number => {
  const price = config.pricing[modelTierKey(route.model, route.tier)];
  if (!price) return Number.POSITIVE_INFINITY;
  return price.input + price.output;
};

const sortSmallestFirst = (config: Config, models: AcceptableModel[]): AcceptableModel[] => {
  return [...models].sort((a, b) => {
    const costDiff = routeCost(config, a) - routeCost(config, b);
    if (Number.isFinite(costDiff) && costDiff !== 0) return costDiff;
    const modelDiff = modelRank(config, a.model) - modelRank(config, b.model);
    if (modelDiff !== 0) return modelDiff;
    const tierDiff = tierRank(a.tier) - tierRank(b.tier);
    if (tierDiff !== 0) return tierDiff;
    return b.predicted_quality_score - a.predicted_quality_score;
  });
};

const isConfiguredRoute = (config: Config, route: { model: string; tier: Tier }): boolean => {
  return config.models.some((model) => model.name === route.model && model.tiers.includes(route.tier));
};

const configuredRoutesCheapestFirst = (config: Config): string => {
  const routes: AcceptableModel[] = [];
  for (const model of config.models) {
    for (const tier of model.tiers) {
      routes.push({ model: model.name, tier, predicted_quality_score: 0 });
    }
  }
  return sortSmallestFirst(config, routes)
    .map((route) => {
      const price = config.pricing[modelTierKey(route.model, route.tier)];
      const priceLabel = price ? `${price.input + price.output}` : "unknown";
      return `- ${route.model} ${route.tier} (relative price: ${priceLabel})`;
    })
    .join("\n");
};

const cheapestConfiguredFallback = (config: Config, codexModel: string, codexTier: Tier): { model: string; tier: Tier } => {
  if (isConfiguredRoute(config, { model: codexModel, tier: codexTier })) {
    return { model: codexModel, tier: codexTier };
  }
  const route = sortSmallestFirst(
    config,
    config.models.flatMap((model) =>
      model.tiers.map((tier) => ({ model: model.name, tier, predicted_quality_score: 0 })),
    ),
  )[0];
  return route ? { model: route.model, tier: route.tier } : { model: codexModel, tier: codexTier };
};

const capAcceptableModels = (
  config: Config,
  llmOutput: AssessmentLLMOutput,
  codexModel: string,
  codexTier: Tier,
): AssessmentLLMOutput => {
  const configuredAcceptable = llmOutput.acceptable_models.filter((route) => isConfiguredRoute(config, route));
  if (configuredAcceptable.length === 0) {
    const fallback = cheapestConfiguredFallback(config, codexModel, codexTier);
    return {
      ...llmOutput,
      recommended_model: fallback.model,
      recommended_tier: fallback.tier,
      acceptable_models: [],
    };
  }
  
  // Filter to routes that are cheaper than original AND meet minimum quality threshold (90)
  const MIN_QUALITY_THRESHOLD = 90;
  const qualityFiltered = configuredAcceptable.filter((route) => {
    const isCheaper = !(route.model === codexModel && route.tier === codexTier);
    const meetsQuality = (route.predicted_quality_score ?? 0) >= MIN_QUALITY_THRESHOLD;
    return isCheaper && meetsQuality;
  });
  
  if (qualityFiltered.length === 0) {
    // Fallback: if no routes meet quality threshold, use cheapest among all cheaper routes
    const cheaperRoutes = configuredAcceptable.filter((route) => 
      !(route.model === codexModel && route.tier === codexTier)
    );
    if (cheaperRoutes.length === 0) {
      const fallback = cheapestConfiguredFallback(config, codexModel, codexTier);
      return {
        ...llmOutput,
        recommended_model: fallback.model,
        recommended_tier: fallback.tier,
        acceptable_models: [],
      };
    }
    const sortedByPrice = sortSmallestFirst(config, cheaperRoutes);
    const max = Math.max(1, Math.trunc(config.maxSuggestedModels));
    const acceptable_models = sortedByPrice.slice(0, max);
    const best = acceptable_models[0]!;
    return {
      ...llmOutput,
      recommended_model: best.model,
      recommended_tier: best.tier,
      acceptable_models,
    };
  }
  
  // Among routes that meet quality threshold, pick the cheapest
  const sortedByPrice = sortSmallestFirst(config, qualityFiltered);
  const max = Math.max(1, Math.trunc(config.maxSuggestedModels));
  const acceptable_models = sortedByPrice.slice(0, max);
  
  const best = acceptable_models[0]!;
  return {
    ...llmOutput,
    recommended_model: best.model,
    recommended_tier: best.tier,
    acceptable_models,
  };
};

export const assess = async (options: AssessOptions): Promise<Assessment> => {
  const runner = options.runner ?? runPrompt;
  const { model, tier } = splitModelTier(options.config.assessmentModel);
  const metaPrompt = buildAssessmentPrompt(
    options.prompt,
    options.codexModel,
    options.codexTier,
    configuredRoutesCheapestFirst(options.config),
  );

  const runResult: RunResult = await runner(metaPrompt, {
    command: options.config.acpCommand,
    args: options.config.acpArgs,
    model,
    tier,
    fastMode: options.fastMode,
    ...options.runnerOptionsOverrides,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(runResult.output));
  } catch (err: any) {
    throw new AssessmentError(
      `Failed to parse assessment JSON: ${err?.message ?? String(err)}`,
      runResult.output,
    );
  }

  let llmOutput: AssessmentLLMOutput;
  try {
    llmOutput = AssessmentLLMOutputSchema.parse(parsed);
  } catch (err: any) {
    throw new AssessmentError(
      `Assessment failed Zod validation: ${err?.message ?? String(err)}`,
      runResult.output,
    );
  }

  const validated: Assessment = AssessmentSchema.parse({
    ...capAcceptableModels(options.config, llmOutput, options.codexModel, options.codexTier),
    model,
    tier,
    input_tokens: runResult.input_tokens,
    output_tokens: runResult.output_tokens,
    latency_ms: runResult.latencyMs,
  });

  return validated;
};
