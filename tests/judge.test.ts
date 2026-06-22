import { describe, it, expect } from "bun:test";
import {
  judge,
  buildJudgePrompt,
  JudgeError,
  JUDGE_PROMPT_TEMPLATE,
} from "../src/judge.ts";
import { defaultConfig } from "../src/schemas.ts";
import type { RunResult, RunnerOptions } from "../src/acp/runner.ts";

const fakeRunResult = (output: string): RunResult => ({
  output,
  latencyMs: 200,
  input_tokens: 11,
  output_tokens: 22,
  estimated: false,
});

const validJudgeJson = JSON.stringify({
  winner: "tie",
  original_quality_score: 85,
  cheaper_quality_score: 84,
  quality_gap_score: 1,
  reasoning: "equivalent",
  input_tokens: 0,
  output_tokens: 0,
  estimated: false,
  latency_ms: 0,
  judged_at: "ignored",
});

describe("buildJudgePrompt", () => {
  it("contains originalPrompt, originalOutput, predictedOutput, and JSON shape", () => {
    const p = buildJudgePrompt("the prompt", "orig out", "pred out");
    expect(p).toContain("the prompt");
    expect(p).toContain("orig out");
    expect(p).toContain("pred out");
    expect(p).toContain("winner");
    expect(p).toContain("original_quality_score");
    expect(p).toContain("cheaper_quality_score");
    expect(p).toContain("quality_gap_score");
    expect(p).toContain("reasoning");
  });

  it("instructs the judge to ignore verification sandbox artifacts", () => {
    const p = buildJudgePrompt("create index.html", "done", "done in /private/tmp/routing-auditor-verify-abc/index.html");
    expect(p).toContain("temporary Routing Auditor sandbox");
    expect(p).toContain("routing-auditor-verify-*");
    expect(p).toContain("progress narration");
    expect(p).toContain("Different absolute paths caused by sandboxing");
  });

  it("includes captured artifacts as primary comparison evidence", () => {
    const p = buildJudgePrompt(
      "create index.html",
      "done",
      "done",
      [{ path: "index.html", content: "<h1>Hello</h1>", truncated: false }],
      [{ path: "index.html", content: "<h1>Hello</h1>", truncated: false }],
    );

    expect(p).toContain("captured artifacts are primary evidence");
    expect(p).toContain("Output A produced artifacts");
    expect(p).toContain("--- path: index.html");
    expect(p).toContain("<h1>Hello</h1>");
    expect(p).toContain("Output B produced artifacts");
  });

  it("fills all placeholders", () => {
    const p = buildJudgePrompt("a", "b", "c");
    expect(p).not.toContain("<originalPrompt>");
    expect(p).not.toContain("<originalOutput>");
    expect(p).not.toContain("<predictedOutput>");
    expect(p).not.toContain("<originalArtifacts>");
    expect(p).not.toContain("<predictedArtifacts>");
  });

  it("exports the template", () => {
    expect(JUDGE_PROMPT_TEMPLATE).toContain("<originalPrompt>");
  });
});

describe("judge", () => {
  it("happy path: returns JudgeResult with tokens/latency from RunResult and judged_at ISO", async () => {
    let received: RunnerOptions | undefined = undefined;
    const fake = async (_p: string, opts: RunnerOptions): Promise<RunResult> => {
      received = opts;
      return fakeRunResult(validJudgeJson);
    };
    const config = defaultConfig({ judgeModel: "gpt-5.5-high" });
    const result = await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(result.winner).toBe("tie");
    expect(result.original_quality_score).toBe(85);
    expect(result.cheaper_quality_score).toBe(84);
    expect(result.quality_gap_score).toBe(1);
    expect(result.input_tokens).toBe(11);
    expect(result.output_tokens).toBe(22);
    expect(result.latency_ms).toBe(200);
    expect(result.estimated).toBe(false);
    expect(result.judged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(result.judged_at).toString()).not.toBe("Invalid Date");
    expect(received!.model).toBe("gpt-5.5");
    expect(received!.tier).toBe("high");
  });

  it("strips markdown json fences", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("```json\n" + validJudgeJson + "\n```");
    const config = defaultConfig();
    const result = await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(result.winner).toBe("tie");
  });

  it("strips bare fences", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("```\n" + validJudgeJson + "\n```");
    const config = defaultConfig();
    const result = await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(result.winner).toBe("tie");
  });

  it("extracts JSON from real ACP output with leading warning text", async () => {
    const fake = async (): Promise<RunResult> =>
      fakeRunResult("Warning: skills context was shortened.\n\n" + validJudgeJson + "\n");
    const config = defaultConfig();
    const result = await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(result.winner).toBe("tie");
  });

  it("throws JudgeError on invalid JSON", async () => {
    const fake = async (): Promise<RunResult> => fakeRunResult("garbage");
    const config = defaultConfig();
    await expect(
      judge({
        config,
        originalPrompt: "p",
        originalOutput: "o",
        predictedOutput: "pr",
        runner: fake as any,
      }),
    ).rejects.toBeInstanceOf(JudgeError);
  });

  it("throws JudgeError on Zod validation failure", async () => {
    const bad = JSON.parse(validJudgeJson);
    bad.winner = "neither";
    const fake = async (): Promise<RunResult> => fakeRunResult(JSON.stringify(bad));
    const config = defaultConfig();
    await expect(
      judge({
        config,
        originalPrompt: "p",
        originalOutput: "o",
        predictedOutput: "pr",
        runner: fake as any,
      }),
    ).rejects.toBeInstanceOf(JudgeError);
  });

  it("passes judge model+tier from config.judgeModel to runner", async () => {
    let received: RunnerOptions | undefined = undefined;
    const fake = async (_p: string, opts: RunnerOptions): Promise<RunResult> => {
      received = opts;
      return fakeRunResult(validJudgeJson);
    };
    const config = defaultConfig({ judgeModel: "gpt-5.5-low" });
    await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(received!.model).toBe("gpt-5.5");
    expect(received!.tier).toBe("low");
  });

  it("uses DI runner and never calls real runPrompt", async () => {
    let called = 0;
    const fake = async (): Promise<RunResult> => {
      called++;
      return fakeRunResult(validJudgeJson);
    };
    const config = defaultConfig();
    await judge({
      config,
      originalPrompt: "p",
      originalOutput: "o",
      predictedOutput: "pr",
      runner: fake as any,
    });
    expect(called).toBe(1);
  });
});
