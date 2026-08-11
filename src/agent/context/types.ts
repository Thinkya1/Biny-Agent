/**
 * 上下文层共享类型。
 *
 * 工作区上下文、仓库地图、压缩状态、token 预算和本地记忆之间互相引用，类型集中放在这里，
 * 避免各实现文件之间循环依赖。
 */
import type { ProjectContext } from "../../project/ProjectContext.js";
import type { ContextComponentUsage } from "../../session/metadata.js";
import type { MemoryRecallReport } from "./memoryTypes.js";

export interface LoadedInstruction {
  path: string;
  content: string;
  bytes: number;
}

export interface ProjectSnapshot {
  context: ProjectContext;
  refreshedAt: string;
  revision: number;
}

export type RepoMapRole = "entry" | "test" | "source" | "config" | "other";

export interface RepoMapEntry {
  path: string;
  role: RepoMapRole;
  symbols: string[];
  imports: string[];
  exports: string[];
}

export interface RecentWorkspaceActivity {
  paths: string[];
  summaries: string[];
}

/** 单轮对话要注入模型的工作区材料。 */
export interface WorkspaceTurnData {
  instructions: LoadedInstruction[];
  snapshot: ProjectSnapshot;
  explicitPaths: string[];
  recentActivity: RecentWorkspaceActivity;
  repoMapCandidates: RepoMapEntry[];
}

/**
 * token 预算现状。`source` 区分是本地估算还是 provider 回报的真实用量，
 * `omitted` 列出因预算不足被丢掉的上下文块，便于界面解释「为什么没带上这些内容」。
 */
export interface ContextBudgetStatus {
  maxTokens: number;
  usedTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelAlias?: string;
  /** 本轮所有候选上下文都保留时的估算量。 */
  requestedTokens?: number;
  /** 本地估算的实际组装输入量；与 provider 回报的 inputTokens 分开保存。 */
  estimatedTokens?: number;
  /** provider 回报的真实输入 token 数；未提供时为空。 */
  providerInputTokens?: number;
  /** 在可用输入预算内为下一步增长保留的安全余量。 */
  reserveTokens?: number;
  omitted: string[];
  autoCompacted: boolean;
  source?: "estimated" | "provider";
  measuredAt?: string;
  /** 上下文候选块的估算组成；tool schema 使用独立 reserve，不重复计入输入预算。 */
  components?: ContextComponentUsage[];
  outputReserveTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
}

export interface CompactionStatus {
  summaryPresent: boolean;
  compactedMessages: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  compactedMessageCount: number;
  retainedMessageCount: number;
  tokensBefore: number;
  summary?: string;
}

export interface ContextStatus {
  loadedInstructions: string[];
  instructionBytes: number;
  instructionCapBytes: number;
  snapshotRefreshedAt?: string;
  snapshotDirty: boolean;
  repoMapRefreshedAt?: string;
  repoMapDirty: boolean;
  repoMapEntries: number;
  activePaths: string[];
  recentActivity: RecentWorkspaceActivity;
  compaction: CompactionStatus;
  budget: ContextBudgetStatus;
  memoryEnabled: boolean;
  memoryTopics: string[];
  memoryRecall?: MemoryRecallReport;
}

export interface MemoryEntry {
  topic: string;
  title: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
}

export interface MemoryMatch {
  topic: string;
  path: string;
  excerpt: string;
  score: number;
}

/** 话题文件里的一个 `##` 小节，供列表展示与按条删除定位。`index` 是小节在文件中的序号。 */
export interface MemoryEntrySummary {
  topic: string;
  index: number;
  title: string;
  date?: string;
  summary: string;
}

/** 单个话题的整理结果；`error` 存在表示该话题整理失败并保持原样。 */
export interface MemoryCompactionTopicResult {
  topic: string;
  before: number;
  after: number;
  error?: string;
}
