/**
 * Desktop 用量展示的纯函数。
 *
 * 费用计算仍由 observability 层负责，这里只把时间线记录汇总成界面需要的形态，并统一
 * 金额与 token 的显示精度，避免不同入口展示出互相矛盾的数字。
 */
import { summarizeUsage } from "../../../observability/usage.js";
import type { SessionUsage, UsageSummary } from "../../../session/metadata.js";
import type { TimelineTurn } from "./sessionTimeline.js";

export interface ContextUsage {
  usedTokens: number;
  /** 模型官方声明的完整上下文窗口（含预留），仅在 tooltip 里解释用，主展示分母用 inputBudgetTokens。 */
  contextWindow: number;
  /** 上下文窗口未由模型元数据声明时为 true；此时界面不能把数值称为官方窗口。 */
  contextWindowIsFallback?: boolean;
  /** 按模型有效窗口比例与 provider/用户上限收敛后的可用输入预算。 */
  inputBudgetTokens?: number;
  /** 原始窗口中的 Codex 风格 headroom；不计入已使用 token。 */
  reservedTokens?: number;
  /** 工具 schema 的解释性预留，不计入已使用 token。 */
  toolTokens?: number;
  /** 除工具 schema 外的解释性预留，不计入已使用 token。 */
  otherTokens?: number;
}

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

export function formatContextUsage(usage?: ContextUsage): {
  percent: number;
  used: string;
  /** 主展示分母：不含输出/headroom 预留的可用输入额度。 */
  max: string;
  /** 模型原始窗口（含预留），仅作 tooltip 解释用。 */
  window: string;
  contextWindowIsFallback?: boolean;
  actual: string;
  available: string;
  reserved?: string;
  tool?: string;
  other?: string;
} | undefined {
  if (!usage || usage.contextWindow <= 0 || usage.usedTokens <= 0) return undefined;
  const inputBudgetTokens = Math.max(1, Math.min(
    usage.contextWindow,
    usage.inputBudgetTokens ?? usage.contextWindow
  ));
  const usedTokens = Math.max(0, usage.usedTokens);
  const reservedTokens = Math.max(0, usage.reservedTokens ?? usage.contextWindow - inputBudgetTokens);
  const toolTokens = Math.min(reservedTokens, Math.max(0, usage.toolTokens ?? 0));
  const otherTokens = Math.max(0, Math.min(reservedTokens - toolTokens, usage.otherTokens ?? reservedTokens - toolTokens));
  return {
    percent: Math.min(100, Math.round((usedTokens / inputBudgetTokens) * 100)),
    used: usedTokens.toLocaleString("en-US"),
    // 分母只算用户真实可用的输入额度；输出预留与 headroom 不摊开给用户看。
    max: inputBudgetTokens.toLocaleString("en-US"),
    window: usage.contextWindow.toLocaleString("en-US"),
    contextWindowIsFallback: usage.contextWindowIsFallback,
    actual: usedTokens.toLocaleString("en-US"),
    available: Math.max(0, inputBudgetTokens - usedTokens).toLocaleString("en-US"),
    reserved: reservedTokens > 0 ? reservedTokens.toLocaleString("en-US") : undefined,
    tool: toolTokens > 0 ? toolTokens.toLocaleString("en-US") : undefined,
    other: otherTokens > 0 ? otherTokens.toLocaleString("en-US") : undefined
  };
}

export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return `${String(Math.round(Math.min(1, Math.max(0, rate)) * 100))}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 0.01 ? 2 : 6)}`;
}
