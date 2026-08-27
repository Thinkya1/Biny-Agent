/**
 * Session 元数据类型：token 用量、费用和上下文预算。
 *
 * 这些结构会原样写进 session 文件，属于对外的持久化格式，改字段要考虑历史 session 的
 * 兼容性，因此除 `operation` 等必需项外都保持可选。
 */
import type { AgentUsage } from "../agent/core/types.js";
import type { PromptEpochReason } from "../llm/promptCache.js";
import type { PersonalizationMetadata } from "../personalization/index.js";

export type UsageOperation = "agent" | "plan" | "compaction" | "memory" | "subagent";
export type ContextBudgetSource = "estimated" | "provider";

export type ContextComponentDisposition = "included" | "trimmed" | "omitted";

export interface ContextComponentUsage {
  id: string;
  requestedTokens: number;
  usedTokens: number;
  disposition: ContextComponentDisposition;
}

export interface SessionContextUsage {
  maxTokens: number;
  usedTokens: number;
  contextWindow?: number;
  /** 按模型有效窗口比例计算的可用输入窗口；历史 session 没有时按旧字段恢复。 */
  effectiveContextWindow?: number;
  effectiveContextWindowPercent?: number;
  contextReserveTokens?: number;
  autoCompactTokenLimit?: number;
  maxOutputTokens?: number;
  modelAlias?: string;
  requestedTokens?: number;
  /** 本地估算的实际组装输入量；与 provider 回报的 inputTokens 分开保存。 */
  estimatedTokens?: number;
  /** provider 回报的真实输入 token 数；未提供时为空。 */
  providerInputTokens?: number;
  reserveTokens?: number;
  omitted: string[];
  autoCompacted: boolean;
  source?: ContextBudgetSource;
  measuredAt?: string;
  /** 本次上下文候选块的估算组成；旧 session 没有该字段。 */
  components?: ContextComponentUsage[];
  outputReserveTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
}

/**
 * 一次已经持久化的上下文压缩边界。
 *
 * `firstKeptMessageId` 是新 session 的稳定真值；`firstKeptMessageIndex` 让没有消息 ID 的
 * 历史 session 仍可恢复。索引是压缩发生时、完整 canonical 消息流里的绝对位置。
 */
export interface SessionContextCheckpoint {
  summary: string;
  firstKeptMessageId?: string;
  firstKeptMessageIndex: number;
  tokensBefore: number;
  compactedMessages: number;
  createdAt: string;
}

export interface SessionContextState {
  summary?: string;
  compactedMessages: number;
  lastCompactedAt?: string;
  budget: SessionContextUsage;
  checkpoint?: SessionContextCheckpoint;
  /** 自定义指令正文不进入 JSONL；只保存不可逆 hash 与枚举/版本元数据。 */
  personalization?: PersonalizationMetadata;
  /** 稳定 prompt 前缀的 session epoch；旧 session 没有该字段时从 0 开始。 */
  promptEpoch?: number;
  promptEpochReason?: PromptEpochReason;
  promptEpochCreatedAt?: string;
  promptProvider?: string;
  promptModel?: string;
  toolSchemaHash?: string;
}

export interface SessionUsage {
  operation: UsageOperation;
  modelAlias: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 产生这条实际用量的 prompt epoch；旧 session 或聚合跨 epoch 记录可能没有。 */
  promptEpochId?: string;
  stablePrefixHash?: string;
  /** 回合聚合记录中，最后一次 provider 请求的完整输入 token。 */
  latestRequestInputTokens?: number;
  /** 回合聚合记录中，最后一次 provider 请求命中的缓存 token。 */
  latestRequestCacheReadTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
  time?: string;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
  pricedCalls: number;
  unpricedCalls: number;
  /** 最近一次模型请求的缓存命中率；provider 未提供缓存 token 时为空。 */
  latestCacheHitRate?: number;
  /** 本会话按完整输入 token 加权的缓存命中率；任一输入记录缺少缓存读数时为空。 */
  sessionCacheHitRate?: number;
  /** 按 prompt epoch 分桶的加权命中率；null 表示该 epoch 缺少可靠 cache read 字段。 */
  epochCacheHitRates?: Record<string, number | null>;
}

export function usageSnapshot(usage: AgentUsage): Omit<SessionUsage,
  | "operation"
  | "modelAlias"
  | "provider"
  | "model"
  | "latestRequestInputTokens"
  | "latestRequestCacheReadTokens"
  | "costUsd"
  | "pricingKnown"
  | "time"
> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheMissTokens: usage.cacheMissTokens
  };
}
