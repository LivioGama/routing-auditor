import { describe, it, expect } from "bun:test";
import { defaultConfig } from "../src/schemas.ts";
import { migrateConfigObject } from "../src/install.ts";

describe("config migration", () => {
  const defaults = defaultConfig();

  it("migrates valid acpArgs array", () => {
    const existing = {
      ...defaults,
      acpArgs: ["--verbose", "--debug"],
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.acpArgs).toEqual(["--verbose", "--debug"]);
  });

  it("falls back to default for invalid acpArgs (non-array)", () => {
    const existing = {
      ...defaults,
      acpArgs: "invalid-string" as unknown as string[],
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.acpArgs).toEqual([]);
  });

  it("falls back to default when acpArgs contains non-string elements", () => {
    const existing = {
      ...defaults,
      acpArgs: ["--valid", 123, null, undefined, "--another-valid"] as unknown as string[],
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.acpArgs).toEqual([]);
  });

  it("falls back to default for negative verificationThreshold", () => {
    const existing = {
      ...defaults,
      verificationThreshold: -5,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.verificationThreshold).toBe(5);
  });

  it("falls back to default for NaN verificationThreshold", () => {
    const existing = {
      ...defaults,
      verificationThreshold: NaN,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.verificationThreshold).toBe(5);
  });

  it("falls back to default for Infinity verificationThreshold", () => {
    const existing = {
      ...defaults,
      verificationThreshold: Infinity,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.verificationThreshold).toBe(5);
  });

  it("preserves valid verificationThreshold", () => {
    const existing = {
      ...defaults,
      verificationThreshold: 10,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.verificationThreshold).toBe(10);
  });

  it("preserves valid sibling fields when one field is invalid", () => {
    const existing = {
      ...defaults,
      enabled: false,
      assessmentModel: "custom-model",
      verificationThreshold: -1,
      acpArgs: ["--custom"],
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.enabled).toBe(false);
    expect(result.assessmentModel).toBe("custom-model");
    expect(result.verificationThreshold).toBe(5);
    expect(result.acpArgs).toEqual(["--custom"]);
  });

  it("handles completely invalid config object", () => {
    const existing = {
      enabled: "not-a-boolean",
      verificationThreshold: "not-a-number",
      acpArgs: {},
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result).toEqual(defaults);
  });

  it("handles null and undefined values", () => {
    const existing = {
      ...defaults,
      enabled: null,
      verificationThreshold: null,
      acpArgs: null,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.enabled).toBe(true);
    expect(result.verificationThreshold).toBe(5);
    expect(result.acpArgs).toEqual([]);
  });

  it("preserves missing fields as defaults", () => {
    const existing = {
      enabled: false,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.enabled).toBe(false);
    expect(result.assessmentModel).toBe("gpt-5.5-high");
    expect(result.verificationThreshold).toBe(5);
  });

  it("handles retentionDays with negative value", () => {
    const existing = {
      ...defaults,
      retentionDays: -10,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.retentionDays).toBe(90);
  });

  it("handles retentionDays with NaN", () => {
    const existing = {
      ...defaults,
      retentionDays: NaN,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.retentionDays).toBe(90);
  });

  it("handles retentionDays with Infinity", () => {
    const existing = {
      ...defaults,
      retentionDays: Infinity,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.retentionDays).toBe(90);
  });

  it("preserves valid retentionDays", () => {
    const existing = {
      ...defaults,
      retentionDays: 180,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.retentionDays).toBe(180);
  });

  it("preserves valid redactPrompts and redactOutputs", () => {
    const existing = {
      ...defaults,
      redactPrompts: true,
      redactOutputs: true,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.redactPrompts).toBe(true);
    expect(result.redactOutputs).toBe(true);
  });

  it("falls back to default for invalid redactPrompts", () => {
    const existing = {
      ...defaults,
      redactPrompts: "true" as unknown as boolean,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.redactPrompts).toBe(false);
  });

  it("falls back to default for invalid redactOutputs", () => {
    const existing = {
      ...defaults,
      redactOutputs: 1 as unknown as boolean,
    };
    const result = migrateConfigObject(existing, defaults);
    expect(result.redactOutputs).toBe(false);
  });

  it("handles non-record existing config", () => {
    const existing = null;
    const result = migrateConfigObject(existing, defaults);
    expect(result).toEqual(defaults);
  });

  it("handles array as existing config", () => {
    const existing = [] as unknown;
    const result = migrateConfigObject(existing, defaults);
    expect(result).toEqual(defaults);
  });
});
