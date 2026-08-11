/**
 * 本地记忆 v2 的稳定公共契约。
 *
 * revision 是 scope 目录自己的单调版本号；所有 scoped 写操作都必须携带调用方最近读取到的
 * expectedRevision，避免 Desktop、TUI 和后台维护互相覆盖。
 */

export type MemoryScope = "global" | "project";

export type MemoryKind =
  | "preference"
  | "working_style"
  | "fact"
  | "decision"
  | "workflow"
  | "gotcha";

export type MemoryLineageSource =
  | "explicit"
  | "completed_task"
  | "candidate"
  | "migration"
  | "consolidation";

/** 一条记忆可以来自多个被合并的条目，所以 StoredMemoryEntry 使用 lineage 数组。 */
export interface MemoryLineage {
  source: MemoryLineageSource;
  externalContext: boolean;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  candidateId?: string;
  sourceEntryIds?: string[];
  legacyPath?: string;
  /** global 记忆必须能回溯到用户明确表达的偏好或工作方式。 */
  userEvidence?: string;
}

/** scoped 写入的最小输入；稳定 id、时间与 revision 由存储层生成。 */
export interface MemoryEntryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  topic: string;
  title: string;
  summary: string;
  decisions?: string[];
  paths?: string[];
  keywords?: string[];
  /** 1（低）到 5（高），默认 3。 */
  importance?: number;
  lineage: MemoryLineage | MemoryLineage[];
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  topic: string;
  title: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** 该条目最近写入时所属 scope 的 revision。 */
  revision: number;
  lineage: MemoryLineage[];
}

export interface MemoryCandidateLineage {
  source: "completed_task";
  sessionId: string;
  turnId: string;
  runId: string;
  externalContext: boolean;
}

/**
 * 候选只保存成功根回合的有界摘要，不接受 task/answer/messages 等完整聊天字段。
 * completed 使用字面量 true，让失败和中断回合无法误入这个 API。
 */
export interface MemoryCandidateInput {
  summary: string;
  completed: true;
  lineage: MemoryCandidateLineage;
  scopeHint?: MemoryScope;
  kindHint?: MemoryKind;
}

export interface MemoryCandidate {
  id: string;
  summary: string;
  completed: true;
  lineage: MemoryCandidateLineage;
  scopeHint?: MemoryScope;
  kindHint?: MemoryKind;
  createdAt: string;
  eligibleAt: string;
  revision: number;
}

export interface MemoryScopeRevision {
  global: number;
  project: number;
}

export interface MemoryScopeOverview {
  scope: MemoryScope;
  revision: number;
  entryCount: number;
  candidateCount: number;
  indexChars: number;
}

export interface MemoryOverview {
  scopes: Record<MemoryScope, MemoryScopeOverview>;
  revision: MemoryScopeRevision;
}

export interface MemoryReadOptions {
  signal?: AbortSignal;
}

export interface MemoryMutationOptions extends MemoryReadOptions {
  expectedRevision: number;
  /** 测试与确定性维护可注入时间；普通调用无需传入。 */
  now?: Date;
}

export interface MemoryListOptions extends MemoryReadOptions {
  scopes?: MemoryScope[];
  topic?: string;
  limit?: number;
}

export interface MemoryEntriesResult {
  entries: MemoryEntry[];
  revision: MemoryScopeRevision;
}

export interface ScopedMemoryWriteResult {
  written: boolean;
  entry?: MemoryEntry;
  path?: string;
  revision: number;
}

export interface MemoryDeleteResult {
  deleted: boolean;
  revision: number;
}

export interface MemoryClearResult {
  scope: MemoryScope;
  deletedEntries: number;
  deletedCandidates: number;
  revision: number;
}

export interface MemoryMatch {
  entry: MemoryEntry;
  topic: string;
  path: string;
  excerpt: string;
  score: number;
}

export type MemoryOmissionReason = "entry_limit" | "budget" | "invalid";

export interface MemoryRecallOmission {
  scope: MemoryScope;
  id: string;
  reason: MemoryOmissionReason;
}

export interface MemoryRecallScopeCounts {
  global: number;
  project: number;
}

export interface MemoryBudgetOmission {
  maxChars: number;
  usedChars: number;
  omitted: number;
}

export interface MemoryRecallReport {
  included: MemoryRecallScopeCounts;
  trimmed: MemoryRecallScopeCounts;
  omitted: MemoryRecallOmission[];
  budgetOmission?: MemoryBudgetOmission;
}

export interface MemorySearchOptions extends MemoryReadOptions {
  scopes?: MemoryScope[];
  /** global + project 合计上限；不是每个 scope 各自上限。 */
  limit?: number;
  /** 注入预算；命中条目超过预算时在 report 中明确标为 budget。 */
  maxChars?: number;
  now?: Date;
}

export interface MemorySearchResult {
  matches: MemoryMatch[];
  revision: MemoryScopeRevision;
  report: MemoryRecallReport;
}

export interface MemoryCandidateMutationOptions extends MemoryMutationOptions {
  excludeExternalContext: boolean;
}

export interface MemoryCandidateMutationResult {
  queued: boolean;
  candidate?: MemoryCandidate;
  revision: number;
  reason?: "external_context_excluded" | "duplicate" | "summary_too_short";
}

export interface MemoryCandidateScanOptions extends MemoryReadOptions {
  now?: Date;
  minAgeMs?: number;
  limit?: number;
}

export interface MemoryCandidateScanResult {
  candidates: MemoryCandidate[];
  revision: number;
}

export interface MemoryConsolidationOptions extends MemoryReadOptions {
  expectedRevision: number;
  topic?: string;
}

export interface MemoryConsolidationResult {
  scope: MemoryScope;
  before: number;
  after: number;
  revision: number;
  error?: string;
}

export interface MemoryMaintenanceOptions extends MemoryReadOptions {
  now?: Date;
  excludeExternalContext?: boolean;
}

export interface MemoryMaintenanceResult {
  scanned: number;
  processed: number;
  written: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
}

export interface MemoryMaintenanceStatus {
  state: "idle" | "running";
  startedAt?: string;
  lastScanAt?: string;
  lastFinishedAt?: string;
  eligible: number;
  processed: number;
  written: number;
  failed: number;
  error?: string;
}

/** CAS 失败是正常并发结果，调用方应重新读取 scope revision 后再决定是否重试。 */
export class MemoryRevisionConflictError extends Error {
  readonly name = "MemoryRevisionConflictError";

  constructor(
    readonly scope: MemoryScope,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Memory ${scope} revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}
