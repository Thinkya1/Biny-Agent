/**
 * Desktop 用量展示的纯函数。
 *
 * 费用计算仍由 observability 层负责，这里只把时间线记录汇总成界面需要的形态，并统一
 * 金额与 token 的显示精度，避免不同入口展示出互相矛盾的数字。
 */
import { summarizeUsage } from "../../../observability/usage.js";
import type { SessionUsage, UsageSummary } from "../../../session/metadata.js";
import type { TimelineTurn } from "./sessionTimeline.js";

export function summarizeTimelineUsage(turns: readonly TimelineTurn[]): UsageSummary {
  const records: SessionUsage[] = [];
  for (const turn of turns) {
    if (turn.usage) records.push(turn.usage);
  }
  return summarizeUsage(records);
}

export function formatUsageCost(summary: Pick<UsageSummary, "calls" | "costUsd" | "pricingKnown">): string {
  if (!summary.calls) return "—";
  if (!summary.pricingKnown || summary.costUsd === undefined) return "未知";
  return formatUsd(summary.costUsd);
}

export function formatTurnCost(usage: Pick<SessionUsage, "costUsd" | "pricingKnown"> | undefined): string | undefined {
  if (!usage) return undefined;
  if (!usage.pricingKnown || usage.costUsd === undefined) return "费用未知";
  return formatUsd(usage.costUsd);
}

export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString("zh-CN");
}

export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return `${String(Math.round(Math.min(1, Math.max(0, rate)) * 100))}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 0.01 ? 2 : 6)}`;
}
