import { describe, it, expect } from "bun:test";
import { priceFor, cost, costFor, estimateTokens, zeroPrice } from "../src/pricing.ts";
import type { Pricing } from "../src/schemas.ts";

const pricing: Pricing = {
  "gpt-5.5-low": { input: 0.5, output: 2 },
  "gpt-5.5-medium": { input: 1, output: 4 },
  "gpt-5.5-high": { input: 1.5, output: 6 },
};

describe("priceFor", () => {
  it("returns the right Price for a known key", () => {
    expect(priceFor(pricing, "gpt-5.5", "high")).toEqual({ input: 1.5, output: 6 });
    expect(priceFor(pricing, "gpt-5.5", "low")).toEqual({ input: 0.5, output: 2 });
  });
  it("returns {input:0,output:0} for missing key without throwing", () => {
    expect(priceFor(pricing, "unknown-model", "high")).toEqual({ input: 0, output: 0 });
    expect(priceFor({}, "gpt-5.5", "high")).toEqual({ input: 0, output: 0 });
  });
});

describe("cost", () => {
  it("computes correctly", () => {
    const result = cost({ input: 1.5, output: 6 }, 1000, 500);
    expect(result).toBe(0.0045);
  });
  it("rounds to 6 decimals", () => {
    const result = cost({ input: 1.5, output: 6 }, 1, 1);
    expect(result).toBe(Math.round((1.5 / 1e6 + 6 / 1e6) * 1e6) / 1e6);
  });
  it("returns 0 for zero price", () => {
    expect(cost(zeroPrice(), 1000, 1000)).toBe(0);
  });
});

describe("costFor", () => {
  it("matches cost(priceFor(...))", () => {
    const viaCostFor = costFor(pricing, "gpt-5.5", "high", 1000, 500);
    const viaCost = cost(priceFor(pricing, "gpt-5.5", "high"), 1000, 500);
    expect(viaCostFor).toBe(viaCost);
    expect(viaCostFor).toBe(0.0045);
  });
  it("returns 0 for unknown model", () => {
    expect(costFor(pricing, "unknown", "high", 1000, 1000)).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("ceil(length/4)", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});