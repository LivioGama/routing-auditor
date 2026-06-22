import type { Tier, Config } from "../schemas.ts";
import { splitModelTier } from "../schemas.ts";
import { estimateTokens } from "../pricing.ts";
import { AcpClient, type AcpResult } from "./client.ts";

export const ROUTING_AUDITOR_INTERNAL_ENV = "ROUTING_AUDITOR_INTERNAL";

export interface RunResult {
  output: string;
  latencyMs: number;
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
}

export interface RunnerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  model?: string;
  tier?: Tier;
  onStderr?: (line: string) => void;
  onUpdate?: (update: any) => void;
  promptTimeoutMs?: number;
  /**
   * When true (default), the rerun runs read-only: tool calls that edit/delete/
   * move files or execute commands are rejected so audits have no side effects.
   */
  readOnly?: boolean;
  /**
   * When true, uses faster execution with shorter timeouts and lower tiers.
   * Useful for quick iteration during development.
   */
  fastMode?: boolean;
}

export const cleanAcpOutput = (output: string): string => {
  return output.replace(
    /^Warning: Skill descriptions were shortened to fit the 2% skills context budget\.[\s\S]*?\n\n/,
    "",
  );
};

export const runPrompt = async (prompt: string, options: RunnerOptions): Promise<RunResult> => {
  let model = options.model;
  let tier = options.tier;
  if (model && model.includes("-") && !tier) {
    const split = splitModelTier(model);
    model = split.model;
    tier = split.tier;
  }

  // Apply fast mode defaults
  let requestTimeoutMs = options.promptTimeoutMs;
  if (options.fastMode && requestTimeoutMs === undefined) {
    requestTimeoutMs = 90000; // 90 seconds for fast mode (still much faster than default 10min)
  }
  if (tier === undefined && options.fastMode) {
    tier = "low"; // Use low tier by default in fast mode
  }

  const client = new AcpClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      [ROUTING_AUDITOR_INTERNAL_ENV]: "1",
    },
    onStderr: options.onStderr,
    onUpdate: options.onUpdate,
    requestTimeoutMs,
    // Only set permission mode if not readOnly (we need write access for verification sandbox)
    // The client will detect server support during initialization
    permissionMode: options.readOnly === false ? "approve-all" : "read-only",
  });
  const start = Date.now();
  try {
    await client.start();
    await client.initialize();
    const sessionId = await client.newSession();
    const result: AcpResult = await client.prompt(prompt, {
      sessionId,
      model: model,
      reasoningEffort: tier,
    });
    const latencyMs = Date.now() - start;
    const usage = result.usage;
    const output = cleanAcpOutput(result.text);
    let input_tokens = 0;
    let output_tokens = 0;
    let estimated = false;
    if (usage && (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")) {
      input_tokens = usage.input_tokens ?? 0;
      output_tokens = usage.output_tokens ?? 0;
      estimated = false;
    } else {
      input_tokens = estimateTokens(prompt);
      output_tokens = estimateTokens(output);
      estimated = true;
    }
    return {
      output,
      latencyMs,
      input_tokens,
      output_tokens,
      estimated,
    };
  } catch (err: any) {
    if (options.onStderr) {
      options.onStderr(`runPrompt error: ${err?.message ?? String(err)}`);
    }
    throw err;
  } finally {
    await client.close();
  }
};

export const runPromptWithConfig = async (
  prompt: string,
  config: Config,
  overrides?: Partial<RunnerOptions>,
): Promise<RunResult> => {
  const options: RunnerOptions = {
    command: config.acpCommand,
    args: config.acpArgs,
    model: config.assessmentModel,
    ...overrides,
  };
  return runPrompt(prompt, options);
};
