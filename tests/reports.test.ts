import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureDataDir,
  readStats,
  writeStats,
  appendPrompt,
  readAllPrompts,
  generatePromptId,
} from "../src/storage.ts";
import { defaultStats, defaultConfig, type PromptRecord } from "../src/schemas.ts";
import {
  windowFor,
  filterRecordsInWindow,
  generateReport,
  saveReport,
  renderStatsReport,
  renderRoiReport,
  renderInvestmentReport,
  type ReportPeriod,
  type Report,
} from "../src/reports.ts";

let dataDir: string;

const makePrompt = (overrides: Partial<PromptRecord> = {}): PromptRecord => ({
  id: generatePromptId(),
  timestamp: new Date().toISOString(),
  session_id: "",
  prompt: "hello",
  codex_model: "gpt-5.5",
  codex_tier: "high",
  verified: false,
  verification_succeeded: false,
  completion_notice_shown: false,
  ...overrides,
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-reports-"));
  ensureDataDir(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("windowFor", () => {
  it("daily = 24h", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const { start, end } = windowFor("daily", now);
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });
  it("weekly = 7d", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const { start, end } = windowFor("weekly", now);
    expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
  });
  it("monthly = 30d", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const { start, end } = windowFor("monthly", now);
    expect(end.getTime() - start.getTime()).toBe(30 * 86_400_000);
  });
});

describe("filterRecordsInWindow", () => {
  it("includes inside, excludes outside", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const start = new Date(now.getTime() - 86_400_000);
    const end = now;
    const inside = makePrompt({ id: "in", timestamp: new Date(now.getTime() - 3600_000).toISOString() });
    const outside = makePrompt({ id: "out", timestamp: new Date(now.getTime() - 2 * 86_400_000).toISOString() });
    const res = filterRecordsInWindow([inside, outside], start, end);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("in");
  });
  it("includes boundary timestamps", () => {
    const start = new Date("2026-06-21T12:00:00Z");
    const end = new Date("2026-06-22T12:00:00Z");
    const atStart = makePrompt({ id: "s", timestamp: start.toISOString() });
    const atEnd = makePrompt({ id: "e", timestamp: end.toISOString() });
    const res = filterRecordsInWindow([atStart, atEnd], start, end);
    expect(res).toHaveLength(2);
  });
});

describe("generateReport", () => {
  it("returns a Report with correct window and counts", () => {
    const now = new Date();
    const stats = defaultStats();
    stats.prompts_analyzed = 3;
    stats.verification_succeeded = 1;
    writeStats(dataDir, stats);
    const recent = makePrompt({ id: "r1", timestamp: new Date(now.getTime() - 3600_000).toISOString() });
    const recent2 = makePrompt({ id: "r2", timestamp: new Date(now.getTime() - 7200_000).toISOString() });
    const old = makePrompt({ id: "old", timestamp: new Date(now.getTime() - 40 * 86_400_000).toISOString() });
    appendPrompt(dataDir, recent);
    appendPrompt(dataDir, recent2);
    appendPrompt(dataDir, old);

    const report = generateReport(dataDir, "daily", now);
    expect(report.period).toBe("daily");
    expect(report.prompts_in_window).toBe(2);
    expect(report.stats_snapshot).toEqual(readStats(dataDir));
    expect(report.records.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});

describe("saveReport", () => {
  it("writes a file under reports/ and returns the path", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const report = generateReport(dataDir, "daily", now);
    const written = saveReport(dataDir, report);
    expect(fs.existsSync(written)).toBe(true);
    expect(written).toContain("reports");
    const parsed = JSON.parse(fs.readFileSync(written, "utf8")) as Report;
    expect(parsed.period).toBe("daily");
    expect(parsed.window_start).toBe(report.window_start);
  });
});

describe("renderStatsReport", () => {
  it("contains expected lines", () => {
    const stats = defaultStats();
    stats.prompts_analyzed = 5;
    stats.prompts_verified = 4;
    stats.verification_succeeded = 3;
    stats.total_gross_savings = 1.5;
    stats.total_net_savings = 1.0;
    const out = renderStatsReport(stats, defaultConfig());
    expect(out).toContain("Prompts Analyzed: 5");
    expect(out).toContain("Routing Accuracy:");
    expect(out).toContain("Gross Savings:");
    expect(out).toContain("Net Savings:");
  });
});

describe("renderRoiReport", () => {
  it("contains expected lines", () => {
    const stats = defaultStats();
    stats.total_audit_cost = 40;
    stats.total_gross_savings = 120;
    stats.total_net_savings = 80;
    stats.prompts_analyzed = 10;
    stats.first_prompt_at = new Date(Date.now() - 86_400_000).toISOString();
    const out = renderRoiReport(stats, defaultConfig());
    expect(out).toContain("Learning Investment:");
    expect(out).toContain("ROI:");
    expect(out).toContain("Payback Ratio:");
    expect(out).toContain("Break-Even Estimate:");
  });
  it("uses projectionHorizonDays from config", () => {
    const stats = defaultStats();
    stats.total_audit_cost = 40;
    stats.total_gross_savings = 120;
    stats.total_net_savings = 80;
    stats.prompts_analyzed = 10;
    stats.first_prompt_at = new Date(Date.now() - 86_400_000).toISOString();
    const config14 = defaultConfig();
    config14.projectionHorizonDays = 14;
    const out14 = renderRoiReport(stats, config14);
    expect(out14).toContain("Future Savings (14d):");
    const config90 = defaultConfig();
    config90.projectionHorizonDays = 90;
    const out90 = renderRoiReport(stats, config90);
    expect(out90).toContain("Future Savings (90d):");
  });
});

describe("renderInvestmentReport", () => {
  it("contains expected lines", () => {
    const stats = defaultStats();
    stats.total_audit_cost = 40;
    stats.total_gross_savings = 120;
    stats.total_net_savings = 80;
    stats.prompts_analyzed = 10;
    stats.first_prompt_at = new Date(Date.now() - 86_400_000).toISOString();
    const out = renderInvestmentReport(stats, defaultConfig());
    expect(out).toContain("Money Spent Learning:");
    expect(out).toContain("Current Net Position:");
    expect(out).toContain("Future Projections:");
  });
  it("uses projectionHorizonDays from config", () => {
    const stats = defaultStats();
    stats.total_audit_cost = 40;
    stats.total_gross_savings = 120;
    stats.total_net_savings = 80;
    stats.prompts_analyzed = 10;
    stats.first_prompt_at = new Date(Date.now() - 86_400_000).toISOString();
    const config14 = defaultConfig();
    config14.projectionHorizonDays = 14;
    const out14 = renderInvestmentReport(stats, config14);
    expect(out14).toContain("Estimated Future Savings (14d):");
    const config90 = defaultConfig();
    config90.projectionHorizonDays = 90;
    const out90 = renderInvestmentReport(stats, config90);
    expect(out90).toContain("Estimated Future Savings (90d):");
  });
});