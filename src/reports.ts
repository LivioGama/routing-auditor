import path from "node:path";
import type { Stats, Config, PromptRecord } from "./schemas.ts";
import { readStats, readAllPrompts, ensureDataDir, readConfig } from "./storage.ts";
import { computeRoi, formatMoney, formatSignedMoney, round1, type RoiSummary } from "./roi.ts";
import { atomicWrite } from "./storage.ts";

export type ReportPeriod = "daily" | "weekly" | "monthly";

export interface Report {
  period: ReportPeriod;
  generated_at: string;
  window_start: string;
  window_end: string;
  prompts_in_window: number;
  verified_in_window: number;
  stats_snapshot: Stats;
  roi_snapshot: RoiSummary;
  records: PromptRecord[];
}

const PERIOD_MS: Record<ReportPeriod, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

export const windowFor = (
  period: ReportPeriod,
  now: Date = new Date(),
): { start: Date; end: Date } => ({
  start: new Date(now.getTime() - PERIOD_MS[period]),
  end: now,
});

export const filterRecordsInWindow = (
  records: PromptRecord[],
  start: Date,
  end: Date,
): PromptRecord[] => {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return records.filter((r) => {
    const ts = Date.parse(r.timestamp);
    if (Number.isNaN(ts)) return false;
    return ts >= startMs && ts <= endMs;
  });
};

export const generateReport = (
  dataDir: string,
  period: ReportPeriod,
  now: Date = new Date(),
): Report => {
  const stats = readStats(dataDir);
  const all = readAllPrompts(dataDir);
  const { start, end } = windowFor(period, now);
  const records = filterRecordsInWindow(all, start, end);
  const verified_in_window = records.filter((r) => r.verification_succeeded).length;
  return {
    period,
    generated_at: now.toISOString(),
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    prompts_in_window: records.length,
    verified_in_window,
    stats_snapshot: stats,
    roi_snapshot: computeRoi(stats, readConfig(dataDir), now),
    records,
  };
};

export const saveReport = (dataDir: string, report: Report): string => {
  ensureDataDir(dataDir);
  const dateStr = report.generated_at.slice(0, 10);
  const filePath = path.join(dataDir, "reports", `${report.period}-${dateStr}.json`);
  atomicWrite(filePath, JSON.stringify(report, null, 2));
  return path.resolve(filePath);
};

export const generateAndSaveReport = (
  dataDir: string,
  period: ReportPeriod,
  now: Date = new Date(),
): string => {
  const report = generateReport(dataDir, period, now);
  return saveReport(dataDir, report);
};

const confidenceMidpoints = { low: 25, medium: 65, high: 90 } as const;

const avgConfidence = (stats: Stats): number => {
  const d = stats.confidence_distribution;
  const total = d.low + d.medium + d.high;
  if (total === 0) return 0;
  return (
    (d.low * confidenceMidpoints.low +
      d.medium * confidenceMidpoints.medium +
      d.high * confidenceMidpoints.high) /
    total
  );
};

const routingAccuracy = (stats: Stats): number => {
  if (stats.prompts_verified === 0) return 0;
  return (stats.verification_succeeded / stats.prompts_verified) * 100;
};

export const renderStatsReport = (stats: Stats, config: Config, now: Date = new Date()): string => {
  const latencySavings = Math.max(
    0,
    stats.total_actual_latency_ms - stats.total_predicted_latency_ms,
  );
  const inputSavings = Math.max(
    0,
    stats.total_actual_input_tokens - stats.total_verification_input_tokens,
  );
  const outputSavings = Math.max(
    0,
    stats.total_actual_output_tokens - stats.total_verification_output_tokens,
  );
  const modelLines = Object.entries(stats.model_recommendations).map(
    ([model, count]) => `  ${model}: ${count}`,
  );
  const tierLines = Object.entries(stats.tier_recommendations).map(
    ([tier, count]) => `  ${tier}: ${count}`,
  );

  return [
    `Prompts Analyzed: ${stats.prompts_analyzed}`,
    `Prompts Verified: ${stats.prompts_verified}`,
    `Routing Accuracy: ${round1(routingAccuracy(stats))}%`,
    `Avg Confidence: ${round1(avgConfidence(stats))}`,
    `Confidence Distribution: low=${stats.confidence_distribution.low} medium=${stats.confidence_distribution.medium} high=${stats.confidence_distribution.high}`,
    "Model Recommendations:",
    ...(modelLines.length > 0 ? modelLines : ["  (none)"]),
    "Tier Recommendations:",
    ...(tierLines.length > 0 ? tierLines : ["  (none)"]),
    `Latency Savings: ${latencySavings}ms`,
    `Token Savings: input=${inputSavings} output=${outputSavings}`,
    `Quota Savings: ${stats.verification_succeeded} prompts worth`,
    `Gross Savings: ${formatMoney(stats.total_gross_savings)}`,
    `Net Savings: ${formatMoney(stats.total_net_savings)}`,
  ].join("\n");
};

export const renderRoiReport = (stats: Stats, config: Config, now: Date = new Date()): string => {
  const roi = computeRoi(stats, config, now);
  const breakEvenDisplay = roi.break_even_days === null ? "unknown" : `${roi.break_even_days} days`;
  return [
    `Learning Investment: ${formatMoney(roi.learning_investment)}`,
    `Audit Costs: ${formatMoney(roi.audit_cost)} (breakdown: assessment ${formatMoney(roi.assessment_cost)}, verification ${formatMoney(roi.verification_cost)}, judge ${formatMoney(roi.judge_cost)})`,
    `Gross Savings: ${formatMoney(roi.gross_savings)}`,
    `Net Savings: ${formatMoney(roi.net_savings)}`,
    `ROI: ${roi.roi_percent}%`,
    `Payback Ratio: ${roi.payback_ratio}`,
    `Break-Even Estimate: ${breakEvenDisplay}`,
    `Dataset Value: ${formatMoney(roi.estimated_dataset_value)}`,
    `Future Savings (${config.projectionHorizonDays}d): ${formatMoney(roi.estimated_future_savings)}`,
  ].join("\n");
};

export const renderInvestmentReport = (
  stats: Stats,
  config: Config,
  now: Date = new Date(),
): string => {
  const roi = computeRoi(stats, config, now);
  const breakEvenDisplay = roi.break_even_days === null ? "unknown" : `${roi.break_even_days} days`;
  return [
    `Money Spent Learning: ${formatMoney(roi.learning_investment)}`,
    `Assessment Costs: ${formatMoney(roi.assessment_cost)}`,
    `Verification Costs: ${formatMoney(roi.verification_cost)}`,
    `Judge Costs: ${formatMoney(roi.judge_cost)}`,
    `Current Net Position: ${formatSignedMoney(roi.current_position)}`,
    "Future Projections:",
    `  Estimated Dataset Value: ${formatMoney(roi.estimated_dataset_value)}`,
    `  Estimated Future Savings (${config.projectionHorizonDays}d): ${formatMoney(roi.estimated_future_savings)}`,
    `  Projected Break-Even: ${breakEvenDisplay}`,
  ].join("\n");
};