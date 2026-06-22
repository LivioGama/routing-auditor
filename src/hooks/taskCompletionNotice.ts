import type { PromptRecord } from "../schemas.ts";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

export function buildTaskCompletionNotice(
  record: PromptRecord,
  options: { color?: boolean } = {},
): string | undefined {
  const verifiedModel = record.verification?.model?.trim() ?? "";
  const verifiedTier = record.verification?.tier?.trim() ?? "";

  if (
    record.verified !== true ||
    record.verification_succeeded !== true ||
    record.verification?.status !== "succeeded" ||
    verifiedModel === ""
  ) {
    return undefined;
  }

  const verifiedRoute = verifiedTier === "" ? verifiedModel : `${verifiedModel} ${verifiedTier}`;

  // Plain text is used by the Stop hook `reason` (it becomes model output, so it
  // must not contain escape codes). The colored variant is only used where it is
  // printed directly to a terminal/UI (the UserPromptSubmit systemMessage).
  if (options.color) {
    return (
      `${ANSI.bold}${ANSI.cyan}Routing Auditor:${ANSI.reset}` +
      `${ANSI.cyan} the previous task could have run with ${ANSI.reset}` +
      `${ANSI.bold}${ANSI.green}${verifiedRoute}${ANSI.reset}` +
      `${ANSI.cyan}.${ANSI.reset}`
    );
  }

  return `Routing Auditor: the previous task could have run with ${verifiedRoute}.`;
}
