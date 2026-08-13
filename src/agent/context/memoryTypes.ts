/**
 * 本地记忆 v3 的稳定公共契约。
 *
 * Markdown 条目统一保存在一个全局记忆库中。origin 只描述事实来源，不再决定物理目录；
 * 所有写操作共享一个单调 revision，并通过 expectedRevision 做 CAS。
 */

/** 新接口使用 audience；scope 仅供尚未迁移的内部调用方兼容。 */
export type MemoryAudience = "universal" | "workspace";

/** @deprecated 使用 MemoryAudience/MemoryOrigin。 */
export type MemoryScope = "global" | "project";

export interface UserMemoryOrigin {
  kind: "user";
}

export interface WorkspaceMemoryOrigin {
  kind: "workspace";
  /** 规范化工作区绝对路径的 SHA-256 前 24 位；不会反向暴露本地路径。 */
  workspaceId: string;
  /** 仅用于展示的目录名快照，不作为身份或权限依据。 */
  workspaceName: string;
}

export type MemoryOrigin = UserMemoryOrigin | WorkspaceMemoryOrigin;

/** 单库列表/搜索的来源视图筛选，不对应任何物理 scope。 */
export type MemoryOriginSelector = "all" | "current_workspace" | "user" | "other_workspaces";

export type MemoryKind =
  | "preference"
  | "working_style"
  | "fact"
  | "decision"
  | "workflow"
  | "gotcha";

export type MemoryLineageSource =
  | "explicit"
  | "explicit_edit"
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
  /** universal 记忆必须能回溯到用户明确表达的偏好或工作方式。 */
  userEvidence?: string;
}

/** 稳定 id、时间与 revision 由存储层生成。 */
export interface MemoryEntryInput {
  /** v3 调用方必须提供 origin 或 audience；workspace audience 自动绑定当前工作区。 */
  origin?: MemoryOrigin;
  audience?: MemoryAudience;
  /** @deprecated 仅供旧调用方；global=universal，project=workspace。 */
  scope?: MemoryScope;
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

/** 显式编辑不能改变 origin、id、createdAt 或既有 lineage。 */
export interface MemoryEntryPatch {
  kind?: MemoryKind;
  topic?: string;
  title?: string;
  summary?: string;
  decisions?: string[];
  paths?: string[];
  keywords?: string[];
  importance?: number;
  userEvidence?: string;
}

export interface MemoryEntry {
  id: string;
  origin: MemoryOrigin;
  /** @deprecated 由 origin 派生，便于旧 Desktop/Runtime 渐进切换。 */
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
  /** 该条目最近写入时单一记忆库的 revision。 */
  revision: number;
  lineage: MemoryLineage[];
  /** 派生 usage 投影；不会写入权威 Markdown。 */
  recallCount: number;
  lastRecalledAt?: string;
}

export interface MemoryCandidateLineage {
  source: "completed_task";
  sessionId: string;
  turnId: string;
  runId: string;
  externalContext: boolean;
}

/** 候选只保存成功根回合的有界摘要，不接受完整聊天字段。 */
export interface MemoryCandidateInput {
  summary: string;
  completed: true;
  lineage: MemoryCandidateLineage;
  origin?: MemoryOrigin;
  audienceHint?: MemoryAudience;
  /** @deprecated 使用 audienceHint。 */
  scopeHint?: MemoryScope;
  kindHint?: MemoryKind;
}

export interface MemoryCandidate {
  id: string;
  summary: string;
  completed: true;
  lineage: MemoryCandidateLineage;
  origin: MemoryOrigin;
  audienceHint?: MemoryAudience;
  /** @deprecated 使用 audienceHint。 */
  scopeHint?: MemoryScope;
  kindHint?: MemoryKind;
  createdAt: string;
  eligibleAt: string;
  revision: number;
}

/** @deprecated 两个字段始终等于 storeRevision。 */
export interface MemoryScopeRevision {
  global: number;
  project: number;
}

/** @deprecated 仅供旧设置页渐进切换。 */
export interface MemoryScopeOverview {
  scope: MemoryScope;
  revision: number;
  entryCount: number;
  candidateCount: number;
  indexChars: number;
}

export interface MemoryOriginCounts {
  user: number;
  currentWorkspace: number;
  otherWorkspaces: number;
}

export interface MemoryOverview {
  storeRevision: number;
  entryCount: number;
  candidateCount: number;
  indexChars: number;
  origins: MemoryOriginCounts;
  /** @deprecated 使用 storeRevision/origins。 */
  scopes: Record<MemoryScope, MemoryScopeOverview>;
  /** @deprecated 使用 storeRevision。 */
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
  origins?: MemoryOriginSelector[];
  /** @deprecated 使用 origins。 */
  scopes?: MemoryScope[];
  topic?: string;
  limit?: number;
}

export interface MemoryEntriesResult {
  entries: MemoryEntry[];
  /** 条目 ID 到权威 Markdown 相对路径的映射，供向量独占命中仍能引用真实文件。 */
  paths?: Record<string, string>;
  storeRevision: number;
  /** @deprecated 使用 storeRevision。 */
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
  selector: MemoryOriginSelector;
  /** @deprecated 仅在 clearScope 兼容入口中返回。 */
  scope?: MemoryScope;
  deletedEntries: number;
  deletedCandidates: number;
  revision: number;
}

export interface MemoryMatch {
  entry: MemoryEntry;
  /** 召回发生时相对于当前工作区的来源桶；用于后续上下文预算投影保持精确计数。 */
  originBucket?: keyof MemoryOriginCounts;
  topic: string;
  path: string;
  excerpt: string;
  score: number;
}

export type MemoryOmissionReason = "entry_limit" | "budget" | "invalid";

export interface MemoryRecallOmission {
  origin: MemoryOrigin;
  /** @deprecated 使用 origin。 */
  scope: MemoryScope;
  id: string;
  reason: MemoryOmissionReason;
}

/** @deprecated 使用 MemoryOriginCounts。 */
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
  origins: {
    included: MemoryOriginCounts;
    trimmed: MemoryOriginCounts;
  };
  /** @deprecated 使用 origins.included。 */
  included: MemoryRecallScopeCounts;
  /** @deprecated 使用 origins.trimmed。 */
  trimmed: MemoryRecallScopeCounts;
  omitted: MemoryRecallOmission[];
  budgetOmission?: MemoryBudgetOmission;
}

export interface MemorySearchOptions extends MemoryReadOptions {
  origins?: MemoryOriginSelector[];
  /** @deprecated 使用 origins。 */
  scopes?: MemoryScope[];
  /** 单库合计上限。 */
  limit?: number;
  /** 注入预算；命中条目超过预算时在 report 中明确标为 budget。 */
  maxChars?: number;
  now?: Date;
}

export interface MemorySearchResult {
  matches: MemoryMatch[];
  storeRevision: number;
  /** @deprecated 使用 storeRevision。 */
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
  origins?: MemoryOriginSelector[];
}

export interface MemoryConsolidationResult {
  origin?: MemoryOrigin;
  /** @deprecated 仅在 consolidateScope 兼容入口中返回。 */
  scope: MemoryScope;
  before: number;
  after: number;
  revision: number;
  error?: string;
}

export interface MemoryMaintenanceOptions extends MemoryReadOptions {
  now?: Date;
}

/**
 * Markdown 写入后的派生索引同步边界。
 *
 * indexEntry 只处理仍然存在的单条新增；requestRebuild 只发出批量失效信号，调用方应在
 * 当前维护批次结束后再调度重建，避免与后续 Markdown mutation 并发。
 */
export interface MemoryDerivedIndexSink {
  indexEntry(entry: MemoryEntry): Promise<void>;
  requestRebuild(): void;
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

/** CAS 失败是正常并发结果，调用方应重新读取 storeRevision 后重试。 */
export class MemoryRevisionConflictError extends Error {
  readonly name = "MemoryRevisionConflictError";

  constructor(
    readonly scope: MemoryScope | "store",
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Memory revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}
