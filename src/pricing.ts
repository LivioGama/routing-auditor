import type { Pricing, Price, Tier } from "./schemas.ts";
import { modelTierKey } from "./schemas.ts";

export const priceFor = (pricing: Pricing, model: string, tier: Tier): Price => {
  const key = modelTierKey(model, tier);
  const p = pricing[key];
  if (!p) return { input: 0, output: 0 };
  return { input: p.input, output: p.output };
};

export const cost = (price: Price, inputTokens: number, outputTokens: number): number => {
  const raw = price.input * (inputTokens / 1_000_000) + price.output * (outputTokens / 1_000_000);
  return Math.round(raw * 1e6) / 1e6;
};

export const costFor = (
  pricing: Pricing,
  model: string,
  tier: Tier,
  inputTokens: number,
  outputTokens: number,
): number => cost(priceFor(pricing, model, tier), inputTokens, outputTokens);

/**
 * Rough token estimate when real usage is unavailable.
 * Assumes ~4 characters per token (a common heuristic for English text on
 * sub-word tokenizers like BPE). Returns ceil(text.length / 4).
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const zeroPrice = (): Price => ({ input: 0, output: 0 });