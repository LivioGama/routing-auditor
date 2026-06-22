import { describe, it, expect } from "bun:test";
import {
  computeRoi,
  formatMoney,
  renderLossesReport,
} from "../src/roi.ts";
import { defaultStats, defaultConfig, type Stats } from "../src/schemas.ts";

const statsWith = (overrides: Partial<Stats>): Stats => ({
  ...defaultStats(),
  ...overrides,
});

describe("computeRoi", () => {
  it("empty stats → all zeros / nulls", () => {
    const roi = computeRoi(defaultStats(), defaultConfig());
    expect(roi.roi_percent).toBe(0);
    expect(roi.payback_ratio).toBe(0);
    expect(roi.break_even_progress).toBe(0);
    expect(roi.deficit).toBe(0);
    expect(roi.break_even_days).toBeNull();
    expect(roi.estimated_dataset_value).toBe(0);
    expect(roi.estimated_future_savings).toBe(0);
    expect(roi.gross_savings).toBe(0);
    expect(roi.net_savings).toBe(0);
    expect(roi.learning_investment).toBe(0);
    expect(roi.audit_cost).toBe(0);
    expect(roi.verified_records).toBe(0);
  });

  it("investment>0, gross=0 → deficit=investment, roi=0, break_even_days=null, current_position=-audit", () => {
    const stats = statsWith({
      total_audit_cost: 40,
      total_net_savings: -40,
    });
    const roi = computeRoi(stats, defaultConfig());
    expect(roi.learning_investment).toBe(40);
    expect(roi.audit_cost).toBe(40);
    expect(roi.deficit).toBe(40);
    expect(roi.roi_percent).toBe(0);
    expect(roi.payback_ratio).toBe(0);
    expect(roi.break_even_days).toBeNull();
    expect(roi.current_position).toBe(-40);
  });

  it("happy path investment=40 gross=120 net=80 → roi=300 payback=3 progress=0.333 deficit=-80", () => {
    const stats = statsWith({
      total_audit_cost: 40,
      total_gross_savings: 120,
      total_net_savings: 80,
      verification_succeeded: 10,
      prompts_analyzed: 10,
      first_prompt_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      last_prompt_at: new Date().toISOString(),
    });
    const roi = computeRoi(stats, defaultConfig());
    expect(roi.roi_percent).toBe(300);
    expect(roi.payback_ratio).toBe(3);
    expect(roi.break_even_progress).toBeCloseTo(0.3333, 3);
    expect(roi.deficit).toBe(-80);
    expect(roi.current_position).toBe(80);
    expect(roi.estimated_dataset_value).toBeCloseTo(10 * 0.05, 6);
  });

  it("div-by-zero guards (investment=0, gross=0)", () => {
    const roi = computeRoi(defaultStats(), defaultConfig());
    expect(roi.roi_percent).toBe(0);
    expect(roi.payback_ratio).toBe(0);
    expect(roi.break_even_progress).toBe(0);
  });

  it("break_even_days computed when savings exist", () => {
    const now = new Date();
    const stats = statsWith({
      total_audit_cost: 10,
      total_gross_savings: 5,
      prompts_analyzed: 5,
      first_prompt_at: new Date(now.getTime() - 86_400_000).toISOString(),
      last_prompt_at: now.toISOString(),
    });
    const roi = computeRoi(stats, defaultConfig(), now);
    expect(roi.break_even_days).not.toBeNull();
    expect(roi.break_even_days!).toBeGreaterThan(0);
  });
});

describe("formatMoney", () => {
  it("positive", () => {
    expect(formatMoney(1.5)).toBe("$1.50");
  });
  it("negative", () => {
    expect(formatMoney(-0.3)).toBe("-$0.30");
  });
  it("zero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });
  it("rounds to 2 decimals", () => {
    expect(formatMoney(1.234)).toBe("$1.23");
    expect(formatMoney(1.235)).toBe("$1.24");
  });
});

describe("renderLossesReport", () => {
  it("matches spec format with positive net", () => {
    const stats = statsWith({
      total_assessment_cost: 10,
      total_verification_cost: 20,
      total_judge_cost: 10,
      total_audit_cost: 40,
      total_gross_savings: 120,
      total_net_savings: 80,
      verification_succeeded: 10,
      prompts_analyzed: 10,
      first_prompt_at: new Date(Date.now() - 86_400_000).toISOString(),
      last_prompt_at: new Date().toISOString(),
    });
    const out = renderLossesReport(stats, defaultConfig());
    expect(out).toContain("═══════════════════════");
    expect(out).toContain("Learning Investment Report");
    expect(out).toContain("Assessment Cost:");
    expect(out).toContain("Verification Cost:");
    expect(out).toContain("Judge Cost:");
    expect(out).toContain("Total Audit Cost:");
    expect(out).toContain("$40.00");
    expect(out).toContain("Gross Savings:");
    expect(out).toContain("$120.00");
    expect(out).toContain("Net Savings:");
    expect(out).toContain("$80.00");
    expect(out).toContain("Current Position:");
    expect(out).toContain("+$80.00");
    expect(out).toContain("If Routing Auditor were disabled:");
    expect(out).toContain("You would have saved:");
    expect(out).toContain("Current auditing deficit:");
    expect(out).toContain("Estimated break-even:");
    expect(out).toContain(" days");
  });

  it("negative net position shows -\$X.XX", () => {
    const stats = statsWith({
      total_audit_cost: 40,
      total_gross_savings: 20,
      total_net_savings: -20,
    });
    const out = renderLossesReport(stats, defaultConfig());
    expect(out).toContain("Current Position:");
    expect(out).toContain("-$20.00");
  });

  it("in profit → deficit shows $0.00", () => {
    const stats = statsWith({
      total_audit_cost: 40,
      total_gross_savings: 120,
      total_net_savings: 80,
      prompts_analyzed: 10,
      first_prompt_at: new Date(Date.now() - 86_400_000).toISOString(),
      last_prompt_at: new Date().toISOString(),
    });
    const out = renderLossesReport(stats, defaultConfig());
    const lines = out.split("\n");
    const defIdx = lines.indexOf("Current auditing deficit:");
    expect(defIdx).toBeGreaterThan(-1);
    const defLine = lines[defIdx + 1];
    expect(defLine).toBe("$0.00");
  });

  it("break_even shows unknown when no savings", () => {
    const stats = statsWith({
      total_audit_cost: 40,
    });
    const out = renderLossesReport(stats, defaultConfig());
    const lines = out.split("\n");
    const idx = lines.indexOf("Estimated break-even:");
    expect(lines[idx + 1]).toBe("unknown");
  });
});