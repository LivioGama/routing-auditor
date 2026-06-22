import { describe, it, expect } from "bun:test";
import { redactText, redactPromptRecord, filterByRetention } from "../src/privacy.ts";
import type { PromptRecord } from "../src/schemas.ts";

describe("redactText", () => {
  it("redacts API keys", () => {
    const text = "Use sk-1234567890abcdefghijklmnopqrstuv as your key";
    const redacted = redactText(text);
    expect(redacted).toContain("sk-REDACTED");
    expect(redacted).not.toContain("1234567890abcdefghijklmnopqrstuv");
  });

  it("redacts email addresses", () => {
    const text = "Contact user@example.com for support";
    const redacted = redactText(text);
    expect(redacted).toContain("EMAIL-REDACTED");
    expect(redacted).not.toContain("user@example.com");
  });

  it("redacts IP addresses", () => {
    const text = "Server at 192.168.1.1 is down";
    const redacted = redactText(text);
    expect(redacted).toContain("IP-REDACTED");
    expect(redacted).not.toContain("192.168.1.1");
  });

  it("redacts URLs", () => {
    const text = "Visit https://example.com/api for docs";
    const redacted = redactText(text);
    expect(redacted).toContain("URL-REDACTED");
    expect(redacted).not.toContain("https://example.com");
  });
});

describe("filterByRetention", () => {
  it("keeps all records when retentionDays is 0", () => {
    const now = new Date();
    const oldRecord: PromptRecord = {
      id: "p_1",
      timestamp: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      session_id: "s1",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    const records = filterByRetention([oldRecord], 0);
    expect(records).toHaveLength(1);
  });

  it("filters out old records based on retentionDays", () => {
    const now = new Date();
    const oldRecord: PromptRecord = {
      id: "p_1",
      timestamp: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      session_id: "s1",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    const recentRecord: PromptRecord = {
      id: "p_2",
      timestamp: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      session_id: "s2",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    const records = filterByRetention([oldRecord, recentRecord], 30);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("p_2");
  });
});

describe("redactPromptRecord", () => {
  it("redacts prompt when redactPrompts is true", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      prompt: "Use sk-1234567890abcdefghijklmnopqrstuv as key",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    const redacted = redactPromptRecord(record, true, false);
    expect(redacted.prompt).toContain("REDACTED");
    expect(redacted.prompt).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
  });

  it("does not redact prompt when redactPrompts is false", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      prompt: "Use sk-1234567890abcdefghijklmnopqrstuv as key",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
    };
    const redacted = redactPromptRecord(record, false, false);
    expect(redacted.prompt).toBe("Use sk-1234567890abcdefghijklmnopqrstuv as key");
  });

  it("redacts assessment explanation when redactPrompts is true", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
      assessment: {
        model: "gpt-5.5",
        tier: "high",
        recommended_model: "gpt-4.5-mini",
        recommended_tier: "low",
        acceptable_models: [],
        confidence: 85,
        reasoning_score: 8,
        coding_score: 7,
        ambiguity_score: 3,
        context_pressure_score: 2,
        instruction_complexity_score: 5,
        explanation: "The prompt contains sensitive data: sk-1234567890abcdefghijklmnopqrstuv",
        input_tokens: 100,
        output_tokens: 50,
        latency_ms: 500,
      },
    };
    const redacted = redactPromptRecord(record, true, false);
    expect(redacted.assessment?.explanation).toContain("REDACTED");
    expect(redacted.assessment?.explanation).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
  });

  it("redacts judge reasoning when redactPrompts is true", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
      judge: {
        winner: "original",
        original_quality_score: 90,
        cheaper_quality_score: 85,
        quality_gap_score: 5,
        reasoning: "The original response used key sk-1234567890abcdefghijklmnopqrstuv correctly",
        input_tokens: 200,
        output_tokens: 100,
        estimated: false,
        latency_ms: 1000,
        judged_at: new Date().toISOString(),
      },
    };
    const redacted = redactPromptRecord(record, true, false);
    expect(redacted.judge?.reasoning).toContain("REDACTED");
    expect(redacted.judge?.reasoning).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
  });

  it("preserves non-sensitive fields when redactPrompts is true", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: "2024-01-01T00:00:00.000Z",
      session_id: "s1",
      prompt: "Use sk-1234567890abcdefghijklmnopqrstuv as key",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
      assessment: {
        model: "gpt-5.5",
        tier: "high",
        recommended_model: "gpt-4.5-mini",
        recommended_tier: "low",
        acceptable_models: [],
        confidence: 85,
        reasoning_score: 8,
        coding_score: 7,
        ambiguity_score: 3,
        context_pressure_score: 2,
        instruction_complexity_score: 5,
        explanation: "Contains sensitive data: sk-1234567890abcdefghijklmnopqrstuv",
        input_tokens: 100,
        output_tokens: 50,
        latency_ms: 500,
      },
    };
    const redacted = redactPromptRecord(record, true, false);
    expect(redacted.id).toBe("p_1");
    expect(redacted.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(redacted.session_id).toBe("s1");
    expect(redacted.codex_model).toBe("gpt-5.5");
    expect(redacted.codex_tier).toBe("high");
    expect(redacted.assessment?.model).toBe("gpt-5.5");
    expect(redacted.assessment?.tier).toBe("high");
    expect(redacted.assessment?.recommended_model).toBe("gpt-4.5-mini");
    expect(redacted.assessment?.confidence).toBe(85);
    expect(redacted.assessment?.input_tokens).toBe(100);
    expect(redacted.assessment?.output_tokens).toBe(50);
    expect(redacted.assessment?.latency_ms).toBe(500);
  });

  it("redacts actual execution output when redactOutputs is true", () => {
    const record: PromptRecord = {
      id: "p_1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      prompt: "test",
      codex_model: "gpt-5.5",
      codex_tier: "high",
      verified: false,
      verification_succeeded: false,
      completion_notice_shown: false,
      actual_execution: {
        model: "gpt-5.5",
        tier: "high",
        output: "The API key is sk-1234567890abcdefghijklmnopqrstuv",
        artifacts: [
          {
            path: "index.html",
            content: "const key = 'sk-1234567890abcdefghijklmnopqrstuv';",
            truncated: false,
          },
        ],
        input_tokens: 10,
        output_tokens: 10,
        estimated: false,
        latency_ms: 0,
        captured: false,
      },
    };
    const redacted = redactPromptRecord(record, false, true);
    expect(redacted.actual_execution?.output).toContain("REDACTED");
    expect(redacted.actual_execution?.output).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
    expect(redacted.actual_execution?.artifacts?.[0]?.content).toContain("REDACTED");
    expect(redacted.actual_execution?.artifacts?.[0]?.content).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
  });
});
