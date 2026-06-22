import type { Stats, Config } from "./schemas.ts";

export interface RoiSummary {
  gross_savings: number;
  net_savings: number;
  learning_investment: number;
  audit_cost: number;
  assessment_cost: number;
  verification_cost: number;
  judge_cost: number;
  roi_percent: number;
  payback_ratio: number;
  break_even_progress: number;
  break_even_days: number | null;
  deficit: number;
  current_position: number;
  estimated_dataset_value: number;
  estimated_future_savings: number;
  verified_records: number;
  trailing_avg_daily_gross_savings: number;
  trailing_avg_daily_prompts: number;
}

export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
export const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
export const round1 = (x: number): number => Math.round(x * 1e1) / 1e1;

export const formatMoney = (usd: number): string => {
  if (usd < 0) return `-$${Math.abs(usd).toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
};

/**
 * Compute the ROI summary from cumulative stats and config.
 *
 * Formulas:
 * - assessment_cost = stats.total_assessment_cost
 * - verification_cost = stats.total_verification_cost
 * - judge_cost = stats.total_judge_cost
 * - audit_cost = learning_investment = stats.total_audit_cost
 * - gross_savings = stats.total_gross_savings
 * - net_savings = stats.total_net_savings
 * - roi_percent = learning_investment > 0 ? (gross_savings / learning_investment) * 100 : 0
 * - payback_ratio = learning_investment > 0 ? gross_savings / learning_investment : 0
 * - break_even_progress = gross_savings > 0 ? learning_investment / gross_savings
 *                       : (learning_investment > 0 ? Infinity : 0)
 * - deficit = learning_investment - gross_savings (signed; negative = in profit)
 * - current_position = net_savings
 * - verified_records = stats.verification_succeeded
 * - estimated_dataset_value = verified_records * config.datasetValuePerRecord
 * - days_elapsed = max(1, (now - first_prompt_at) / 86400000); 1 when first_prompt_at empty
 * - trailing_avg_daily_gross_savings = gross_savings / days_elapsed
 * - trailing_avg_daily_prompts = prompts_analyzed / days_elapsed
 * - break_even_days = trailing_avg_daily_gross_savings > 0
 *                     ? learning_investment / trailing_avg_daily_gross_savings : null
 * - estimated_future_savings = prompts_analyzed > 0
 *     ? (net_savings / max(1, prompts_analyzed)) * (trailing_avg_daily_prompts * config.projectionHorizonDays)
 *     : 0
 */
export const computeRoi = (stats: Stats, config: Config, now: Date = new Date()): RoiSummary => {
  const assessment_cost = round6(stats.total_assessment_cost);
  const verification_cost = round6(stats.total_verification_cost);
  const judge_cost = round6(stats.total_judge_cost);
  const audit_cost = round6(stats.total_audit_cost);
  const learning_investment = audit_cost;
  const gross_savings = round6(stats.total_gross_savings);
  const net_savings = round6(stats.total_net_savings);

  const roi_percent =
    learning_investment > 0 ? round4((gross_savings / learning_investment) * 100) : 0;
  const payback_ratio =
    learning_investment > 0 ? round4(gross_savings / learning_investment) : 0;
  const break_even_progress =
    gross_savings > 0
      ? round4(learning_investment / gross_savings)
      : learning_investment > 0
        ? Infinity
        : 0;

  const deficit = round6(learning_investment - gross_savings);
  const current_position = net_savings;

  const verified_records = stats.verification_succeeded;
  const estimated_dataset_value = round6(verified_records * config.datasetValuePerRecord);

  const firstTs = stats.first_prompt_at ? Date.parse(stats.first_prompt_at) : NaN;
  const days_elapsed =
    Number.isNaN(firstTs) ? 1 : Math.max(1, (now.getTime() - firstTs) / 86_400_000);
  const trailing_avg_daily_gross_savings = round6(gross_savings / days_elapsed);
  const trailing_avg_daily_prompts = round6(stats.prompts_analyzed / days_elapsed);

  const break_even_days =
    trailing_avg_daily_gross_savings > 0
      ? round1(learning_investment / trailing_avg_daily_gross_savings)
      : null;

  const estimated_future_savings =
    stats.prompts_analyzed > 0
      ? round6(
          (net_savings / Math.max(1, stats.prompts_analyzed)) *
            (trailing_avg_daily_prompts * config.projectionHorizonDays),
        )
      : 0;

  return {
    gross_savings,
    net_savings,
    learning_investment,
    audit_cost,
    assessment_cost,
    verification_cost,
    judge_cost,
    roi_percent,
    payback_ratio,
    break_even_progress,
    break_even_days,
    deficit,
    current_position,
    estimated_dataset_value,
    estimated_future_savings,
    verified_records,
    trailing_avg_daily_gross_savings,
    trailing_avg_daily_prompts,
  };
};

const BORDER = "═══════════════════════";

export const formatSignedMoney = (usd: number): string => {
  if (usd < 0) return `-$${Math.abs(usd).toFixed(2)}`;
  return `+$${usd.toFixed(2)}`;
};

export const renderLossesReport = (stats: Stats, config: Config, now: Date = new Date()): string => {
  const roi = computeRoi(stats, config, now);
  const deficitDisplay = Math.max(0, roi.learning_investment - roi.gross_savings);
  const breakEvenDisplay =
    roi.break_even_days === null ? "unknown" : `${roi.break_even_days.toFixed(1)} days`;

  return [
    BORDER,
    "Learning Investment Report",
    BORDER,
    "",
    "Assessment Cost:",
    formatMoney(roi.assessment_cost),
    "",
    "Verification Cost:",
    formatMoney(roi.verification_cost),
    "",
    "Judge Cost:",
    formatMoney(roi.judge_cost),
    "",
    "Total Audit Cost:",
    formatMoney(roi.audit_cost),
    "",
    "Gross Savings:",
    formatMoney(roi.gross_savings),
    "",
    "Net Savings:",
    formatMoney(roi.net_savings),
    "",
    "Current Position:",
    formatSignedMoney(roi.current_position),
    "",
    "If Routing Auditor were disabled:",
    "",
    "You would have saved:",
    formatMoney(roi.audit_cost),
    "",
    "Current auditing deficit:",
    formatMoney(deficitDisplay),
    "",
    "Estimated break-even:",
    breakEvenDisplay,
    "",
    BORDER,
    "",
  ].join("\n");
};