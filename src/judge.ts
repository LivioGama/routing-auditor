import type { JudgeResult, Config, ExecutionArtifact } from "./schemas.ts";
import { JudgeResultSchema, splitModelTier } from "./schemas.ts";
import { runPrompt, type RunnerOptions, type RunResult } from "./acp/runner.ts";
import { stripFences } from "./utils/json.ts";

export class JudgeError extends Error {
  raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.name = "JudgeError";
    this.raw = raw;
  }
}

export interface JudgeOptions {
  config: Config;
  originalPrompt: string;
  originalOutput: string;
  predictedOutput: string;
  originalArtifacts?: ExecutionArtifact[];
  predictedArtifacts?: ExecutionArtifact[];
  runner?: typeof runPrompt;
  runnerOptionsOverrides?: Partial<RunnerOptions>;
  fastMode?: boolean;
}

export const JUDGE_PROMPT_TEMPLATE = `You are a neutral judge comparing two outputs for the same prompt. Assess quality equivalence.

Judge the user-visible task outcome, not incidental verification artifacts.

Important rules:
- Output B may have been produced in a temporary Routing Auditor sandbox. Do not penalize absolute paths under /tmp, /private/tmp, or paths containing routing-auditor-verify-* when they otherwise correspond to the requested project artifact.
- Do not penalize harmless progress narration, workspace inspection notes, or tool-availability notes unless they obscure the final answer, contradict the result, or indicate the task was not completed.
- For file-writing or coding prompts, compare whether the requested artifact/functionality was produced. The captured artifacts are primary evidence; assistant prose is secondary.
- If both artifact sets satisfy the prompt with equivalent code/content, mark a tie or only a tiny gap even if the transcript text differs.
- Different absolute paths caused by sandboxing should not create a quality gap by themselves.
- Still penalize real failures: missing deliverables, incorrect content, refusal, errors, unsafe behavior, or materially worse user-facing guidance.

Original prompt:
"""
<originalPrompt>
"""

Output A (original — produced by the actual Codex model):
"""
<originalOutput>
"""

Output A produced artifacts:
<originalArtifacts>

Output B (predicted — produced by the recommended cheaper model/tier):
"""
<predictedOutput>
"""

Output B produced artifacts:
<predictedArtifacts>

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "winner": "original" | "predicted" | "tie",
  "original_quality_score": 0-100,
  "cheaper_quality_score": 0-100,
  "quality_gap_score": <original_quality_score - cheaper_quality_score>,
  "reasoning": "<brief justification>"
}`;

export const buildJudgePrompt = (
  originalPrompt: string,
  originalOutput: string,
  predictedOutput: string,
  originalArtifacts: ExecutionArtifact[] = [],
  predictedArtifacts: ExecutionArtifact[] = [],
): string =>
  JUDGE_PROMPT_TEMPLATE
    .replace("<originalPrompt>", originalPrompt)
    .replace("<originalOutput>", originalOutput)
    .replace("<originalArtifacts>", formatArtifacts(originalArtifacts))
    .replace("<predictedOutput>", predictedOutput)
    .replace("<predictedArtifacts>", formatArtifacts(predictedArtifacts));

const formatArtifacts = (artifacts: ExecutionArtifact[]): string => {
  if (artifacts.length === 0) return "No captured artifacts.";
  return artifacts
    .map((artifact) =>
      [
        `--- path: ${artifact.path}${artifact.truncated ? " (truncated)" : ""}`,
        artifact.content,
      ].join("\n"),
    )
    .join("\n\n");
};

export const judge = async (options: JudgeOptions): Promise<JudgeResult> => {
  const runner = options.runner ?? runPrompt;
  const { model, tier } = splitModelTier(options.config.judgeModel);
  const metaPrompt = buildJudgePrompt(
    options.originalPrompt,
    options.originalOutput,
    options.predictedOutput,
    options.originalArtifacts ?? [],
    options.predictedArtifacts ?? [],
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
    throw new JudgeError(
      `Failed to parse judge JSON: ${err?.message ?? String(err)}`,
      runResult.output,
    );
  }

  let validated: JudgeResult;
  try {
    validated = JudgeResultSchema.parse(parsed);
  } catch (err: any) {
    throw new JudgeError(
      `Judge result failed Zod validation: ${err?.message ?? String(err)}`,
      runResult.output,
    );
  }

  return {
    ...validated,
    input_tokens: runResult.input_tokens,
    output_tokens: runResult.output_tokens,
    latency_ms: runResult.latencyMs,
    estimated: runResult.estimated,
    judged_at: new Date().toISOString(),
  };
};
