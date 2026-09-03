/**
 * 本地记忆 v3 的稳定公共契约。
 *
 * SQLite 条目统一保存在一个全局记忆库中。origin 只描述事实来源，不再决定物理目录；
 * 所有写操作共享一个单调 revision，并通过 expectedRevision 做 CAS。
 */

export type MemoryAudience = "universal" | "workspace";

/** Sleep 用 durability 区分会自然过期的短期记忆和长期记忆。 */
export type MemoryDurability = "temporary" | "permanent";

/** archive reason 使用稳定名称；旧短名称只用于读取当前开发库中的历史行。 */
export type MemoryArchiveReason = "exact_dup" | "exact" | "expired" | "orphan" | "similarity_merge" | "llm_merge" | "similarity" | "llm" | "manual";

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
  | "sleep";

/** 一条记忆可以来自多个被合并的条目，所以 StoredMemoryEntry 使用 lineage 数组。 */
export interface MemoryLineage {
  source: MemoryLineageSource;
  externalContext: boolean;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  sourceEntryIds?: string[];
  /** universal 记忆必须能回溯到用户明确表达的偏好或工作方式。 */
  userEvidence?: string;
}

/** 稳定 id、时间与 revision 由存储层生成。 */
export interface MemoryEntryInput {
  /** 调用方必须提供 origin 或 audience；workspace audience 自动绑定当前工作区。 */
  origin?: MemoryOrigin;
  audience?: MemoryAudience;
  kind: MemoryKind;
  topic: string;
  title: string;
  summary: string;
  decisions?: string[];
  paths?: string[];
  keywords?: string[];
  /** 1（低）到 5（高），默认 3。 */
  importance?: number;
  durability?: MemoryDurability;
  expiresAt?: string;
  archivedAt?: string;
  archivedReason?: MemoryArchiveReason;
  mergedInto?: string;
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
  durability?: MemoryDurability;
  expiresAt?: string;
  userEvidence?: string;
  archivedAt?: string;
  archivedReason?: MemoryArchiveReason;
  mergedInto?: string;
}

export interface MemoryEntry {
  id: string;
  /** 归档条目拥有独立的 archive row id，并用 originalId 关联原活动条目。 */
  originalId?: string;
  origin: MemoryOrigin;
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
  durability: MemoryDurability;
  expiresAt?: string;
  /** SQLite 行上的 usage 字段；不会改变事实 revision。 */
  recallCount: number;
  lastRecalledAt?: string;
  /** memory_archive 对应的可恢复归档状态。 */
  archivedAt?: string;
  archivedReason?: MemoryArchiveReason;
  /** 归档时指向保留下来的 survivor 或新 synthesis。 */
  mergedInto?: string;
  /** 产生该归档记录的操作（Sleep run id 或 manual）。 */
  archivedBy?: string;
}

/** 自动贡献记忆时使用的语义候选查询；undefined 表示 embedding/index 当前不可用。 */
export interface MemorySimilarSearchOptions extends MemoryReadOptions {
  limit: number;
  minimumSimilarity: number;
}

export type MemorySimilarEntrySearch = (
  query: string,
  options: MemorySimilarSearchOptions
) => Promise<MemoryEntry[] | undefined>;

export interface MemoryOriginCounts {
  user: number;
  currentWorkspace: number;
  otherWorkspaces: number;
}

export interface MemoryOverview {
  storeRevision: number;
  entryCount: number;
  origins: MemoryOriginCounts;
}

export interface MemoryReadOptions {
  signal?: AbortSignal;
}

export interface MemoryMutationOptions extends MemoryReadOptions {
  expectedRevision: number;
  /** 测试与确定性维护可注入时间；普通调用无需传入。 */
  now?: Date;
  /** 归档审计来源；Sleep 使用 run id，手动归档默认 manual。 */
  archivedBy?: string;
}

export interface MemoryListOptions extends MemoryReadOptions {
  origins?: MemoryOriginSelector[];
  topic?: string;
  limit?: number;
  /** 分页起始偏移；与 limit 组合实现 offset 分页。 */
  offset?: number;
  /** 默认隐藏归档记忆；管理界面可显式读取。 */
  includeArchived?: boolean;
}

export interface MemoryEntriesResult {
  entries: MemoryEntry[];
  /** 条目 ID 到稳定 memory:// 引用的映射，供向量独占命中仍能回到事实条目。 */
  paths?: Record<string, string>;
  storeRevision: number;
  /** 应用 filter（origin/topic）后、分页前的条目总数；供分页 UI 计算页数。 */
  total: number;
}

export interface MemoryWriteResult {
  written: boolean;
  entry?: MemoryEntry;
  path?: string;
  revision: number;
}

export interface MemoryDeleteResult {
  deleted: boolean;
  entry?: MemoryEntry;
  revision: number;
}

export interface MemoryArchiveEntriesResult {
  entries: MemoryEntry[];
  storeRevision: number;
  total: number;
}

export interface MemoryArchiveResult {
  archived: boolean;
  entry?: MemoryEntry;
  revision: number;
}

export interface MemoryBulkArchiveResult {
  entries: MemoryEntry[];
  archived: number;
  revision: number;
}

export interface MemoryClearResult {
  selector: MemoryOriginSelector;
  deletedEntries: number;
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
  id: string;
  reason: MemoryOmissionReason;
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
  omitted: MemoryRecallOmission[];
  budgetOmission?: MemoryBudgetOmission;
}

export interface MemorySearchOptions extends MemoryReadOptions {
  includeArchived?: boolean;
  origins?: MemoryOriginSelector[];
  /** 单库合计上限。 */
  limit?: number;
  /** 注入预算；命中条目超过预算时在 report 中明确标为 budget。 */
  maxChars?: number;
  now?: Date;
}

export interface MemorySearchResult {
  matches: MemoryMatch[];
  storeRevision: number;
  report: MemoryRecallReport;
}

/**
 * SQLite 事实写入后的派生索引同步边界。
 *
 * indexEntry 只处理仍然存在的单条新增；requestRebuild 只发出批量失效信号，调用方应在
 * 当前维护批次结束后再调度重建，避免与后续 memory mutation 并发。
 */
export interface MemoryDerivedIndexSink {
  indexEntry(entry: MemoryEntry): Promise<void>;
  removeEntries?(entryIds: readonly string[]): void;
  requestRebuild?(): void;
  findSimilarPairs?: (
    entries: readonly MemoryEntry[],
    minimumSimilarity: number,
    signal?: AbortSignal
  ) => Promise<MemorySimilarityPair[]>;
}

export interface MemorySimilarityPair {
  leftId: string;
  rightId: string;
  similarity: number;
}

export interface MemoryMaintenanceOptions extends MemoryReadOptions {
  now?: Date;
  trigger?: "scheduled" | "manual";
  archiveRetentionDays?: number;
  temporaryTtl?: number;
  useLlm?: boolean;
  llmMergeLow?: number;
  llmBatchSize?: number;
}

export interface MemorySleepPreview {
  available: boolean;
  entries: number;
  temporaryToArchive: number;
  archivedToDelete: number;
  recentRuns: number;
  lastRun?: MemorySleepRun;
}

export interface MemorySleepRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  trigger: "scheduled" | "manual";
  examined: number;
  written: number;
  failed: number;
  archived: number;
  exact: number;
  expired: number;
  similarity: number;
  llm: number;
  /** Sleep run 的详细审计字段；旧的短字段保留为 UI/历史读取别名。 */
  archivedExact: number;
  archivedExpired: number;
  archivedOrphan: number;
  archivedSimilarity: number;
  archivedLlm: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
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
  lastRun?: MemorySleepRun;
  /** 最近的睡眠整理历史，最多保留 20 次。 */
  sleepRuns?: MemorySleepRun[];
}

/** CAS 失败是正常并发结果，调用方应重新读取 storeRevision 后重试。 */
export class MemoryRevisionConflictError extends Error {
  readonly name = "MemoryRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Memory revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}
