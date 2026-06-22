import type { PromptRecord } from "./schemas.ts";

/**
 * Redact sensitive information from text.
 * This is a simple implementation that redacts common patterns.
 * In production, you might want to use more sophisticated redaction.
 */
export function redactText(text: string): string {
  let redacted = text;
  
  // Redact API keys (common patterns)
  redacted = redacted.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-REDACTED");
  redacted = redacted.replace(/[a-zA-Z0-9]{20,}/g, "REDACTED");
  
  // Redact email addresses
  redacted = redacted.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "EMAIL-REDACTED");
  
  // Redact IP addresses
  redacted = redacted.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "IP-REDACTED");
  
  // Redact URLs (basic pattern)
  redacted = redacted.replace(/https?:\/\/[^\s]+/g, "URL-REDACTED");
  
  return redacted;
}

/**
 * Redact a prompt record based on config settings
 */
export function redactPromptRecord(
  record: PromptRecord,
  redactPrompts: boolean,
  redactOutputs: boolean
): PromptRecord {
  const redacted = { ...record };
  
  if (redactPrompts) {
    redacted.prompt = redactText(record.prompt);
    
    // Redact prompt-derived explanation and reasoning fields
    if (record.assessment) {
      redacted.assessment = {
        ...record.assessment,
        explanation: redactText(record.assessment.explanation),
      };
    }
    
    if (record.judge) {
      redacted.judge = {
        ...record.judge,
        reasoning: redactText(record.judge.reasoning),
      };
    }
  }
  
  if (redactOutputs && record.actual_execution) {
    redacted.actual_execution = {
      ...record.actual_execution,
      output: redactText(record.actual_execution.output),
      artifacts: record.actual_execution.artifacts?.map((artifact) => ({
        ...artifact,
        content: redactText(artifact.content),
      })),
    };
  }
  
  if (redactOutputs && record.verification) {
    redacted.verification = {
      ...record.verification,
      output: redactText(record.verification.output),
      artifacts: record.verification.artifacts?.map((artifact) => ({
        ...artifact,
        content: redactText(artifact.content),
      })),
    };
  }
  
  return redacted;
}

/**
 * Filter records by retention period
 */
export function filterByRetention(
  records: PromptRecord[],
  retentionDays: number
): PromptRecord[] {
  if (retentionDays === 0) return records; // 0 means keep forever
  
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  
  return records.filter((record) => new Date(record.timestamp) >= cutoff);
}
