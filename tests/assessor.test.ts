import { describe, it, expect } from "bun:test";
import {
  assess,
  buildAssessmentPrompt,
  AssessmentError,
  ASSESSMENT_PROMPT_TEMPLATE,
} from "../src/assessor.ts";
import { defaultConfig, type Assessment } from "../src/schemas.ts";
import type { RunResult, RunnerOptions } from "../src/acp/runner.ts";

const fakeRunResult = (output: string): RunResult => ({
  output,
  latencyMs: 123,
  input_tokens: 45,
  output_tokens: 67,
  estimated: true,
});

const validAssessmentJson = JSON.stringify({
  recommended_model: "gpt-5.5",
  recommended_tier: "medium",
  acceptable_models: [
    { model: "gpt-5.5", tier: "medium", predicted_quality_score: 92 },
    { model: "gpt-5.5", tier: "low", predicted_quality_score: 70 },
  ],
  confidence: 88,
  reasoning_score: 7,
  coding_score: 6,
  ambiguity_score: 3,
  context_pressure_score: 4,
  instruction_complexity_score: 5,
  explanation: "a medium tier suffices",
  model: "irrelevant",
  tier: "low",
  input_tokens: 0,
  output_tokens: 0,
  latency_ms: 0,
});

describe("buildAssessmentPrompt", () => {
  it("contains the user prompt, codex model, codex tier, and JSON shape", () => {
    const p = buildAssessmentPrompt("do a barrel roll", "gpt-5.5", "high");
    expect(p).toContain("do a barrel roll");
    expect(p).toContain("gpt-5.5");
    expect(p).toContain("high");
    expect(p).toContain("recommended_model");
    expect(p).toContain("acceptable_models");
    expect(p).toContain("instruction_complexity_score");
    expect(p).toContain("minimum quality threshold");
    expect(p).toContain("Do not prefer the same model family");
  });

  it("template has all placeholders filled", () => {
    const p = buildAssessmentPrompt("hello", "m1", "low");
    expect(p).not.toContain("<codexModel>");
    expect(p).not.toContain("<codexTier>");
    expect(p).not.toContain("<prompt>");
  });

  it("exports the template", () => {
    expect(ASSESSMENT_PROMPT_TEMPLATE).toContain("<codexModel>");
  });
});

describe("assess", () => {
  it("happy path: returns Assessment with tokens/latency from RunResult and model=tier=assessment model", async () => {
    let called = false;
    let receivedOpts: RunnerOptions | undefined = undefined;
    const fake = async (prompt: string, opts: RunnerOptions): Promise<RunResult> => {
      called = true;
      receivedOpts = opts;
      return fakeRunResult(validAssessmentJson);
    };
    const config = defaultConfig({ assessmentModel: "gpt-5.5-high" });
    const result: Assessment = await assess({
      config,
      prompt: "write a function",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(called).toBe(true);
    expect(result.recommended_model).toBe("gpt-5.5");
    expect(result.recommended_tier).toBe("medium");  // Higher quality (92) than low (70)
    expect(result.acceptable_models).toEqual([
      { model: "gpt-5.5", tier: "medium", predicted_quality_score: 92 },
    ]);
    expect(result.confidence).toBe(88);
    expect(result.input_tokens).toBe(45);
    expect(result.output_tokens).toBe(67);
    expect(result.latency_ms).toBe(123);
    expect(result.model).toBe("gpt-5.5");
    expect(result.tier).toBe("high");
    expect(receivedOpts!.model).toBe("gpt-5.5");
    expect(receivedOpts!.tier).toBe("high");
  });

  it("strips markdown json fences", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("```json\n" + validAssessmentJson + "\n```");
    const config = defaultConfig();
    const result = await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(result.recommended_model).toBe("gpt-5.5");
  });

  it("strips bare fences", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("```\n" + validAssessmentJson + "\n```");
    const config = defaultConfig();
    const result = await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(result.recommended_tier).toBe("medium");  // Higher quality (92) than low (70)
  });

  it("extracts JSON from real ACP output with leading warning text", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("Warning: skills context was shortened.\n\n" + validAssessmentJson + "\n");
    const config = defaultConfig();
    const result = await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(result.recommended_model).toBe("gpt-5.5");
    expect(result.recommended_tier).toBe("medium");  // Higher quality (92) than low (70)
  });

  it("throws AssessmentError on invalid JSON", async () => {
    const fake = async (): Promise<RunResult> => fakeRunResult("not json at all");
    const config = defaultConfig();
    await expect(
      assess({
        config,
        prompt: "x",
        codexModel: "gpt-5.5",
        codexTier: "high",
        runner: fake as any,
      }),
    ).rejects.toBeInstanceOf(AssessmentError);
  });

  it("throws AssessmentError on Zod validation failure", async () => {
    const bad = JSON.parse(validAssessmentJson);
    bad.recommended_tier = "xhigh";
    const fake = async (): Promise<RunResult> => fakeRunResult(JSON.stringify(bad));
    const config = defaultConfig();
    await expect(
      assess({
        config,
        prompt: "x",
        codexModel: "gpt-5.5",
        codexTier: "high",
        runner: fake as any,
      }),
    ).rejects.toBeInstanceOf(AssessmentError);
  });

  it("passes assessment model+tier from config.assessmentModel to runner", async () => {
    let received: RunnerOptions | undefined = undefined;
    const fake = async (_p: string, opts: RunnerOptions): Promise<RunResult> => {
      received = opts;
      return fakeRunResult(validAssessmentJson);
    };
    const config = defaultConfig({ assessmentModel: "gpt-5.5-medium" });
    await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(received!.model).toBe("gpt-5.5");
    expect(received!.tier).toBe("medium");
  });

  it("caps acceptable_models and recommends cheapest route that meets quality threshold", async () => {
    const unordered = JSON.stringify({
      recommended_model: "gpt-5.5",
      recommended_tier: "high",
      acceptable_models: [
        { model: "gpt-5.5", tier: "high", predicted_quality_score: 100 },
        { model: "gpt-5.4-mini", tier: "low", predicted_quality_score: 91 },
        { model: "gpt-5.4", tier: "low", predicted_quality_score: 94 },
      ],
      confidence: 88,
      reasoning_score: 7,
      coding_score: 6,
      ambiguity_score: 3,
      context_pressure_score: 4,
      instruction_complexity_score: 5,
      explanation: "multiple routes",
    });
    const fake = async (): Promise<RunResult> => fakeRunResult(unordered);
    const config = defaultConfig({ maxSuggestedModels: 2 });
    const result = await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    // Should recommend gpt-5.4-mini low (cheapest that meets 90+ quality threshold, not gpt-5.5 high which is same as original)
    expect(result.recommended_model).toBe("gpt-5.4-mini");
    expect(result.recommended_tier).toBe("low");
    expect(result.acceptable_models.map((m) => `${m.model}-${m.tier}`)).toEqual([
      "gpt-5.4-mini-low",
      "gpt-5.4-low",
    ]);
  });

  it("with maxSuggestedModels=1 recommends the cheapest route that meets quality threshold", async () => {
    const unordered = JSON.stringify({
      recommended_model: "gpt-5.5",
      recommended_tier: "low",
      acceptable_models: [
        { model: "gpt-5.5", tier: "low", predicted_quality_score: 99 },
        { model: "gpt-5.4-mini", tier: "low", predicted_quality_score: 90 },
        { model: "gpt-5.4", tier: "low", predicted_quality_score: 95 },
      ],
      confidence: 88,
      reasoning_score: 7,
      coding_score: 6,
      ambiguity_score: 3,
      context_pressure_score: 4,
      instruction_complexity_score: 5,
      explanation: "multiple routes",
    });
    let metaPrompt = "";
    const fake = async (prompt: string): Promise<RunResult> => {
      metaPrompt = prompt;
      return fakeRunResult(unordered);
    };
    const config = defaultConfig({ maxSuggestedModels: 1 });
    const result = await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });

    expect(metaPrompt).toContain("gpt-5.4-mini low");
    expect(metaPrompt.indexOf("gpt-5.4-mini low")).toBeLessThan(metaPrompt.indexOf("gpt-5.5 low"));
    expect(result.recommended_model).toBe("gpt-5.4-mini");  // Cheapest that meets 90+ quality threshold
    expect(result.recommended_tier).toBe("low");
    expect(result.acceptable_models.map((m) => `${m.model}-${m.tier}`)).toEqual([
      "gpt-5.4-mini-low",
    ]);
  });

  it("ignores acceptable routes that are not configured for Codex", async () => {
    const output = JSON.stringify({
      recommended_model: "gpt-5",
      recommended_tier: "low",
      acceptable_models: [
        { model: "gpt-5", tier: "low", predicted_quality_score: 100 },
        { model: "gpt-5.4-mini", tier: "low", predicted_quality_score: 90 },
      ],
      confidence: 88,
      reasoning_score: 7,
      coding_score: 6,
      ambiguity_score: 3,
      context_pressure_score: 4,
      instruction_complexity_score: 5,
      explanation: "multiple routes",
    });
    const fake = async (): Promise<RunResult> => fakeRunResult(output);
    const result = await assess({
      config: defaultConfig({ maxSuggestedModels: 1 }),
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });

    expect(result.recommended_model).toBe("gpt-5.4-mini");
    expect(result.recommended_tier).toBe("low");
    expect(result.acceptable_models.map((m) => `${m.model}-${m.tier}`)).toEqual([
      "gpt-5.4-mini-low",
    ]);
  });

  it("falls back to the actual Codex route when no returned route is configured", async () => {
    const output = JSON.stringify({
      recommended_model: "gpt-5",
      recommended_tier: "low",
      acceptable_models: [
        { model: "gpt-5", tier: "low", predicted_quality_score: 100 },
      ],
      confidence: 88,
      reasoning_score: 7,
      coding_score: 6,
      ambiguity_score: 3,
      context_pressure_score: 4,
      instruction_complexity_score: 5,
      explanation: "unavailable route only",
    });
    const fake = async (): Promise<RunResult> => fakeRunResult(output);
    const result = await assess({
      config: defaultConfig({ maxSuggestedModels: 1 }),
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });

    expect(result.recommended_model).toBe("gpt-5.5");
    expect(result.recommended_tier).toBe("high");
    expect(result.acceptable_models).toEqual([]);
  });

  it("uses DI runner and never calls real runPrompt", async () => {
    let called = 0;
    const fake = async (): Promise<RunResult> => {
      called++;
      return fakeRunResult(validAssessmentJson);
    };
    const config = defaultConfig();
    await assess({
      config,
      prompt: "x",
      codexModel: "gpt-5.5",
      codexTier: "high",
      runner: fake as any,
    });
    expect(called).toBe(1);
  });
});
