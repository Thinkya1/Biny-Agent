/**
 * LocalMemory v3 的纯磁盘存储层。
 *
 * 单一 memory 根目录通过 mkdir 锁串行化跨进程写入；entry、state、candidate 和 MEMORY.md 都先写
 * 同目录临时文件、fsync 后 rename。模型调用不在目录锁内执行，避免长时间占锁。
 */
import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { globalAgentDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  assertAllowedScopedEntry,
  createStoredMemoryEntry,
  maxMemoryCandidateChars,
  maxMemoryEntryChars,
  maxMemorySummaryChars,
  memoryEntryEquals,
  memoryOriginsEqual,
  memoryMatchFromRanked,
  normalizeMemoryTopic,
  parseMemoryEntryFile,
  parseLegacyV2MemoryEntryFile,
  rankMemoryEntries,
  renderMemoryEntry,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import {
  MemoryRevisionConflictError,
  type MemoryCandidate,
  type MemoryCandidateInput,
  type MemoryCandidateMutationOptions,
  type MemoryCandidateMutationResult,
  type MemoryCandidateScanOptions,
  type MemoryCandidateScanResult,
  type MemoryClearResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOrigin,
  type MemoryOriginCounts,
  type MemoryOriginSelector,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemoryScope,
  type MemoryScopeOverview,
  type MemoryScopeRevision,
  type MemorySearchOptions,
  type MemorySearchResult,
  type ScopedMemoryWriteResult
} from "./memoryTypes.js";

export const memoryIndexFileName = "MEMORY.md";
export const maxMemoryIndexChars = 24_000;
export const memoryCandidateEligibilityMs = 6 * 60 * 60 * 1_000;

const stateFileName = ".memory-state.json";
const maintenanceFileName = ".maintenance.json";
const usageFileName = ".memory-usage.json";
const pendingMutationFileName = ".pending-mutation.json";
const migrationFileName = ".migration-v2.json";
const entryDirectoryName = "entries";
const candidateDirectoryName = ".candidates";
const legacyDirectoryName = ".legacy-v1";
const lockDirectoryName = ".memory.lock";
const lockTimeoutMs = 5_000;
const staleLockMs = 120_000;
const maxStateChars = 32_000;
const maxCandidateFileChars = 8_000;
const maxPendingMutationChars = 1_000_000;
const maxUsageChars = 5_000_000;

interface PinnedScopeDirectory {
  workspaceRoot: string;
  storageRoot: string;
  path: string;
  scope: MemoryScope;
  device: number | bigint;
  inode: number | bigint;
}

interface MemoryState {
  version: 3;
  revision: number;
  updatedAt: string;
  migratedV2At?: string;
}

interface ScopeEntryRecord {
  entry: MemoryEntry;
  fileName: string;
}

interface PendingEntryWrite {
  fileName: string;
  content: string;
  id: string;
}

interface PendingMutation {
  version: 3;
  fromRevision: number;
  toRevision: number;
  createdAt: string;
  entryWrites: PendingEntryWrite[];
  entryDeletes: string[];
  candidateDeletes: string[];
}

interface ScopeSnapshot {
  directory?: PinnedScopeDirectory;
  state: MemoryState;
  entries: ScopeEntryRecord[];
  candidates: MemoryCandidate[];
  index?: string;
}

interface MemoryStorageOptions {
  maxIndexChars?: number;
}

interface DeleteTopicResult {
  deleted: number;
  revision: number;
}

interface ReplaceEntriesResult {
  entries: MemoryEntry[];
  revision: number;
}

const candidateSchema = z.object({
  version: z.literal(3),
  id: z.string().min(8).max(128),
  summary: z.string().min(1).max(maxMemoryCandidateChars),
  completed: z.literal(true),
  lineage: z.object({
    source: z.literal("completed_task"),
    sessionId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    externalContext: z.boolean()
  }),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user") }),
    z.object({
      kind: z.literal("workspace"),
      workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
      workspaceName: z.string().min(1).max(120)
    })
  ]),
  audienceHint: z.enum(["universal", "workspace"]).optional(),
  scopeHint: z.enum(["global", "project"]).optional(),
  kindHint: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).optional(),
  createdAt: z.string(),
  eligibleAt: z.string(),
  revision: z.number().int().nonnegative()
});

const legacyCandidateSchema = z.object({
  version: z.literal(2),
  id: z.string().min(8).max(128),
  summary: z.string().min(1).max(maxMemoryCandidateChars),
  completed: z.literal(true),
  lineage: z.object({
    source: z.literal("completed_task"),
    sessionId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    externalContext: z.boolean()
  }),
  scopeHint: z.enum(["global", "project"]).optional(),
  kindHint: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).optional(),
  createdAt: z.string(),
  eligibleAt: z.string(),
  revision: z.number().int().nonnegative()
});

const v2MigrationProgressSchema = z.object({
  version: z.literal(3),
  status: z.literal("copying"),
  sourceDirectories: z.array(z.string().refine((value) => value === "global" || /^[a-f0-9]{24}$/u.test(value))),
  sourceIndex: z.number().int().nonnegative().default(0),
  phase: z.enum(["entries", "candidates"]).default("entries"),
  offset: z.number().int().nonnegative().default(0),
  updatedAt: z.string()
});

type V2MigrationProgress = z.infer<typeof v2MigrationProgressSchema>;

const maintenanceSchema = z.object({
  version: z.literal(3),
  state: z.enum(["idle", "running"]),
  startedAt: z.string().optional(),
  lastScanAt: z.string().optional(),
  lastFinishedAt: z.string().optional(),
  eligible: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  error: z.string().optional()
});

const pendingMutationSchema = z.object({
  version: z.literal(3),
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().positive(),
  createdAt: z.string(),
  entryWrites: z.array(z.object({
    fileName: z.string(),
    content: z.string(),
    id: z.string()
  })),
  entryDeletes: z.array(z.string()),
  candidateDeletes: z.array(z.string())
});

const usageSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({
    recallCount: z.number().int().nonnegative(),
    lastRecalledAt: z.string().optional()
  }))
});

export class MemoryStorage {
  private readonly maxIndexChars: number;

  constructor(readonly workspaceRoot: string, options: MemoryStorageOptions = {}) {
    this.maxIndexChars = Math.max(1_024, options.maxIndexChars ?? maxMemoryIndexChars);
  }

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const origins = countOrigins(snapshot.entries.map(({ entry }) => entry), currentWorkspaceId(snapshot.directory));
    const globalOverview = scopeOverview("global", snapshot, origins.user);
    const projectOverview = scopeOverview("project", snapshot, origins.currentWorkspace);
    return {
      storeRevision: snapshot.state.revision,
      entryCount: snapshot.entries.length,
      candidateCount: snapshot.candidates.length,
      indexChars: snapshot.index?.length ?? 0,
      origins,
      scopes: { global: globalOverview, project: projectOverview },
      revision: sameRevision(snapshot.state.revision)
    };
  }

  /** v3 单库列表入口。 */
  async listEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const selectors = normalizeOriginSelectors(options.origins, options.scopes, true);
    const workspaceId = currentWorkspaceId(snapshot.directory);
    const topic = options.topic === undefined ? undefined : normalizeMemoryTopic(options.topic);
    const records = snapshot.entries
      .filter(({ entry }) => matchesOriginSelectors(entry.origin, selectors, workspaceId))
      .filter(({ entry }) => topic === undefined || entry.topic === topic)
      .sort((left, right) => compareEntriesForDisplay(left.entry, right.entry))
      .slice(0, normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return {
      entries: records.map(({ entry }) => entry),
      paths: snapshot.directory === undefined
        ? undefined
        : Object.fromEntries(records.map(({ entry, fileName }) => [
          entry.id,
          path.relative(snapshot.directory!.storageRoot, path.join(snapshot.directory!.path, entryDirectoryName, fileName))
        ])),
      storeRevision: snapshot.state.revision,
      revision: sameRevision(snapshot.state.revision)
    };
  }

  /** @deprecated 使用 listEntries。 */
  async listStoredEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    return await this.listEntries(options);
  }

  /** v3 单库词法搜索入口；语义层在 Runtime Host 上游组合。 */
  async search(query: string, queryPaths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.searchInternal(query, queryPaths, options, true);
  }

  /**
   * @deprecated 使用 search。旧自动召回未显式传 scope 时只读取 user + 当前 workspace，
   * 避免向量不可用时把其他项目的词法结果自动注入上下文。
   */
  async searchScoped(query: string, queryPaths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.searchInternal(query, queryPaths, options, options.origins !== undefined || options.scopes !== undefined);
  }

  private async searchInternal(
    query: string,
    queryPaths: string[],
    options: MemorySearchOptions,
    defaultAll: boolean
  ): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const selectors = normalizeOriginSelectors(options.origins, options.scopes, defaultAll);
    const workspaceId = currentWorkspaceId(snapshot.directory);
    const now = options.now ?? new Date();
    const ranked = rankMemoryEntries(
      snapshot.entries.map(({ entry }) => entry)
        .filter((entry) => matchesOriginSelectors(entry.origin, selectors, workspaceId)),
      redactSecrets(query),
      queryPaths.map((value) => redactSecrets(value)),
      now
    );
    const records = new Map(snapshot.entries.map((record) => [record.entry.id, record] as const));
    const limit = normalizeLimit(options.limit, 3);
    const included = { global: 0, project: 0 };
    const trimmed = { global: 0, project: 0 };
    const originIncluded = emptyOriginCounts();
    const originTrimmed = emptyOriginCounts();
    const omitted: MemorySearchResult["report"]["omitted"] = [];
    const matches: MemorySearchResult["matches"] = [];
    let usedChars = 0;
    let budgetOmitted = 0;

    for (const rankedEntry of ranked) {
      const record = records.get(rankedEntry.entry.id);
      if (!record || !snapshot.directory) continue;
      const bucket = originBucket(rankedEntry.entry.origin, workspaceId);
      if (matches.length >= limit) {
        trimmed[rankedEntry.entry.scope] += 1;
        originTrimmed[bucket] += 1;
        omitted.push({ origin: rankedEntry.entry.origin, scope: rankedEntry.entry.scope, id: rankedEntry.entry.id, reason: "entry_limit" });
        continue;
      }
      const estimatedChars = rankedEntry.entry.title.length + rankedEntry.excerpt.length + 80;
      if (options.maxChars !== undefined && usedChars + estimatedChars > Math.max(0, options.maxChars)) {
        budgetOmitted += 1;
        omitted.push({ origin: rankedEntry.entry.origin, scope: rankedEntry.entry.scope, id: rankedEntry.entry.id, reason: "budget" });
        continue;
      }
      usedChars += estimatedChars;
      included[rankedEntry.entry.scope] += 1;
      originIncluded[bucket] += 1;
      matches.push({
        ...memoryMatchFromRanked(
          rankedEntry,
          path.relative(snapshot.directory.storageRoot, path.join(snapshot.directory.path, entryDirectoryName, record.fileName))
        ),
        originBucket: bucket
      });
    }

    const report: MemorySearchResult["report"] = {
      origins: { included: originIncluded, trimmed: originTrimmed },
      included,
      trimmed,
      omitted,
      budgetOmission: options.maxChars === undefined || budgetOmitted === 0
        ? undefined
        : { maxChars: Math.max(0, options.maxChars), usedChars, omitted: budgetOmitted }
    };
    return {
      matches,
      storeRevision: snapshot.state.revision,
      revision: sameRevision(snapshot.state.revision),
      report
    };
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    options.signal?.throwIfAborted();
    const canonicalWorkspace = await fs.realpath(path.resolve(this.workspaceRoot));
    const safe = resolveEntryOrigin(sanitizeMemoryEntryInput(input), workspaceOrigin(canonicalWorkspace));
    assertAllowedScopedEntry(safe, canonicalWorkspace);
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      if (safe.summary.length < 20) return { written: false, revision: snapshot.state.revision };
      const duplicate = snapshot.entries.find(({ entry }) => entry.topic === safe.topic && memoryEntryEquals(entry, safe));
      if (duplicate) {
        return {
          written: false,
          entry: duplicate.entry,
          path: path.relative(directory.storageRoot, path.join(directory.path, entryDirectoryName, duplicate.fileName)),
          revision: snapshot.state.revision
        };
      }
      const nextRevision = snapshot.state.revision + 1;
      const now = (options.now ?? new Date()).toISOString();
      const entry = createStoredMemoryEntry(safe, {
        id: randomUUID(),
        revision: nextRevision,
        createdAt: now,
        updatedAt: now
      });
      const fileName = chooseEntryFileName(entry, snapshot.entries);
      await atomicWriteChildFile(directory, path.join(directory.path, entryDirectoryName), fileName, renderMemoryEntry(entry));
      const records = [...snapshot.entries, { entry, fileName }];
      await this.commitSnapshot(directory, snapshot.state, nextRevision, records, snapshot.candidates, options.now ?? new Date());
      return {
        written: true,
        entry,
        path: path.relative(directory.storageRoot, path.join(directory.path, entryDirectoryName, fileName)),
        revision: nextRevision
      };
    });
  }

  /** @deprecated 使用 writeEntry。 */
  async writeScoped(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    return await this.writeEntry(input, options);
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    options.signal?.throwIfAborted();
    const canonicalWorkspace = await fs.realpath(path.resolve(this.workspaceRoot));
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const now = options.now ?? new Date();
      const snapshot = await this.readScopeLocked(directory, now, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const record = snapshot.entries.find(({ entry }) => entry.id === id);
      if (!record) return { written: false, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      const input = sanitizeMemoryEntryInput({
        origin: record.entry.origin,
        kind: patch.kind ?? record.entry.kind,
        topic: patch.topic ?? record.entry.topic,
        title: patch.title ?? record.entry.title,
        summary: patch.summary ?? record.entry.summary,
        decisions: patch.decisions ?? record.entry.decisions,
        paths: patch.paths ?? record.entry.paths,
        keywords: patch.keywords ?? record.entry.keywords,
        importance: patch.importance ?? record.entry.importance,
        lineage: [
          ...record.entry.lineage,
          {
            source: "explicit_edit",
            externalContext: false,
            sourceEntryIds: [record.entry.id],
            userEvidence: patch.userEvidence
          }
        ]
      });
      if (!input.origin) throw new Error("Edited memory must retain its origin.");
      assertAllowedScopedEntry(input, canonicalWorkspace);
      if (input.summary.length < 20) return { written: false, entry: record.entry, revision: snapshot.state.revision };
      const entry = createStoredMemoryEntry(input, {
        id: record.entry.id,
        revision: nextRevision,
        createdAt: record.entry.createdAt,
        updatedAt: now.toISOString()
      });
      await atomicWriteChildFile(directory, path.join(directory.path, entryDirectoryName), record.fileName, renderMemoryEntry(entry));
      const records = snapshot.entries.map((item) => item.entry.id === id ? { entry, fileName: item.fileName } : item);
      await this.commitSnapshot(directory, snapshot.state, nextRevision, records, snapshot.candidates, now);
      return {
        written: true,
        entry,
        path: path.relative(directory.storageRoot, path.join(directory.path, entryDirectoryName, record.fileName)),
        revision: nextRevision
      };
    });
  }

  async deleteEntry(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.deleteStoredEntryInternal(id, options);
  }

  /** @deprecated 使用 deleteEntry。 */
  async deleteStoredEntry(scope: MemoryScope, id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.deleteStoredEntryInternal(id, options, scope);
  }

  private async deleteStoredEntryInternal(id: string, options: MemoryMutationOptions, scope?: MemoryScope): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const record = snapshot.entries.find(({ entry }) => entry.id === id && (scope === undefined || entry.scope === scope));
      if (!record) return { deleted: false, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 3,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: (options.now ?? new Date()).toISOString(),
        entryWrites: [],
        entryDeletes: [record.fileName],
        candidateDeletes: []
      }, options.signal);
      return { deleted: true, revision: nextRevision };
    });
  }

  async deleteTopic(scope: MemoryScope, topic: string, options: MemoryMutationOptions): Promise<DeleteTopicResult> {
    options.signal?.throwIfAborted();
    const normalized = normalizeMemoryTopic(topic);
    return await this.withScopeLock(scope, true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const targets = snapshot.entries.filter(({ entry }) => entry.scope === scope && entry.topic === normalized);
      if (!targets.length) return { deleted: 0, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 3,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: (options.now ?? new Date()).toISOString(),
        entryWrites: [],
        entryDeletes: targets.map(({ fileName }) => fileName),
        candidateDeletes: []
      }, options.signal);
      return { deleted: targets.length, revision: nextRevision };
    });
  }

  async clearScope(scope: MemoryScope, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    const selector: MemoryOriginSelector = scope === "global" ? "user" : "current_workspace";
    const result = await this.clearEntries(selector, options);
    return { ...result, scope };
  }

  async clearEntries(selector: MemoryOriginSelector, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const workspaceId = currentWorkspaceId(directory);
      const targets = snapshot.entries.filter(({ entry }) => matchesOriginSelectors(entry.origin, [selector], workspaceId));
      const candidates = snapshot.candidates.filter((candidate) => matchesOriginSelectors(candidate.origin, [selector], workspaceId));
      if (!targets.length && !candidates.length) {
        return { selector, deletedEntries: 0, deletedCandidates: 0, revision: snapshot.state.revision };
      }
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 3,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: (options.now ?? new Date()).toISOString(),
        entryWrites: [],
        entryDeletes: targets.map(({ fileName }) => fileName),
        candidateDeletes: candidates.map(({ id }) => id)
      }, options.signal);
      return {
        selector,
        deletedEntries: targets.length,
        deletedCandidates: candidates.length,
        revision: nextRevision
      };
    });
  }

  async enqueueCandidate(input: MemoryCandidateInput, options: MemoryCandidateMutationOptions): Promise<MemoryCandidateMutationResult> {
    options.signal?.throwIfAborted();
    if (input.completed !== true) throw new Error("Only completed root turns can become memory candidates.");
    validateCandidateLineage(input);
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const now = options.now ?? new Date();
      const snapshot = await this.readScopeLocked(directory, now, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      if (input.lineage.externalContext && options.excludeExternalContext) {
        return { queued: false, revision: snapshot.state.revision, reason: "external_context_excluded" };
      }
      // enqueue 和提升前各脱敏一次；候选绝不保存完整聊天，只保留有界 summary。
      const summary = redactSecrets(redactSecrets(input.summary)).trim().slice(0, maxMemoryCandidateChars);
      if (summary.length < 20) return { queued: false, revision: snapshot.state.revision, reason: "summary_too_short" };
      const duplicate = snapshot.candidates.find((candidate) => (
        candidate.lineage.runId === input.lineage.runId
        && candidate.lineage.turnId === input.lineage.turnId
        && normalizeForDedup(candidate.summary) === normalizeForDedup(summary)
      ));
      if (duplicate) return { queued: false, candidate: duplicate, revision: snapshot.state.revision, reason: "duplicate" };
      const nextRevision = snapshot.state.revision + 1;
      const createdAt = now.toISOString();
      const candidateOrigin = input.origin ?? (
        input.audienceHint === "universal" || input.scopeHint === "global"
          ? { kind: "user" as const }
          : workspaceOrigin(directory.workspaceRoot)
      );
      const candidate: MemoryCandidate = {
        id: randomUUID(),
        summary,
        completed: true,
        lineage: {
          source: "completed_task",
          sessionId: redactSecrets(input.lineage.sessionId).trim().slice(0, 200),
          turnId: redactSecrets(input.lineage.turnId).trim().slice(0, 200),
          runId: redactSecrets(input.lineage.runId).trim().slice(0, 200),
          externalContext: input.lineage.externalContext
        },
        origin: candidateOrigin,
        audienceHint: input.audienceHint ?? (input.scopeHint === "global" ? "universal" : input.scopeHint === "project" ? "workspace" : undefined),
        scopeHint: input.scopeHint,
        kindHint: input.kindHint,
        createdAt,
        eligibleAt: new Date(now.getTime() + memoryCandidateEligibilityMs).toISOString(),
        revision: nextRevision
      };
      await writeCandidate(directory, candidate);
      await this.commitSnapshot(
        directory,
        snapshot.state,
        nextRevision,
        snapshot.entries,
        [...snapshot.candidates, candidate],
        now
      );
      return { queued: true, candidate, revision: nextRevision };
    });
  }

  /** 纯读取 API：启动扫描和定时扫描都可注入 now/minAgeMs 做确定性测试。 */
  async scanEligibleCandidates(options: MemoryCandidateScanOptions = {}): Promise<MemoryCandidateScanResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const nowMs = (options.now ?? new Date()).getTime();
    const minAgeMs = Math.max(0, options.minAgeMs ?? memoryCandidateEligibilityMs);
    const candidates = snapshot.candidates
      .filter((candidate) => candidate.origin.kind === "workspace" && candidate.origin.workspaceId === currentWorkspaceId(snapshot.directory))
      .filter((candidate) => nowMs >= Date.parse(candidate.createdAt) + minAgeMs)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return { candidates, revision: snapshot.state.revision };
  }

  async removeCandidate(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      if (!snapshot.candidates.some((candidate) => candidate.id === id)) {
        return { deleted: false, revision: snapshot.state.revision };
      }
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 3,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: (options.now ?? new Date()).toISOString(),
        entryWrites: [],
        entryDeletes: [],
        candidateDeletes: [id]
      }, options.signal);
      return { deleted: true, revision: nextRevision };
    });
  }

  /**
   * 只有调用方确认条目已实际组装进模型上下文后才调用。usage 是可丢弃投影，
   * 不推进内容 revision，也不会污染权威 Markdown。
   */
  async recordInjectedRecall(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      const valid = new Set(snapshot.entries.map(({ entry }) => entry.id));
      const targetIds = unique.filter((id) => valid.has(id));
      if (!targetIds.length) return;
      const usage = await readUsage(directory, options.signal);
      const recalledAt = (options.now ?? new Date()).toISOString();
      for (const id of targetIds) {
        const previous = usage[id];
        usage[id] = {
          recallCount: (previous?.recallCount ?? 0) + 1,
          lastRecalledAt: recalledAt
        };
      }
      await atomicWriteFile(directory, usageFileName, `${JSON.stringify({ version: 1, entries: usage }, null, 2)}\n`);
    });
  }

  /** consolidation 已在锁外调用模型；这里只用一次 CAS 原子替换被覆盖的 source entries。 */
  async replaceEntries(
    scope: MemoryScope,
    sourceEntryIds: string[],
    replacements: MemoryEntryInput[],
    options: MemoryMutationOptions
  ): Promise<ReplaceEntriesResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock(scope, true, options.signal, async (directory) => {
      const now = options.now ?? new Date();
      const snapshot = await this.readScopeLocked(directory, now, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const sourceSet = new Set(sourceEntryIds);
      if (sourceSet.size !== sourceEntryIds.length) throw new Error("Consolidation source ids must be unique.");
      if (![...sourceSet].every((id) => snapshot.entries.some(({ entry }) => entry.id === id))) {
        throw new MemoryRevisionConflictError("store", options.expectedRevision, snapshot.state.revision);
      }
      const sources = snapshot.entries.filter(({ entry }) => sourceSet.has(entry.id));
      const sourceOrigin = sources[0]?.entry.origin;
      if (!sourceOrigin || sources.some(({ entry }) => !memoryOriginsEqual(entry.origin, sourceOrigin))) {
        throw new Error("Consolidation cannot combine entries from different memory origins.");
      }
      const safeReplacements = replacements.map((entry) => {
        const safe = sanitizeMemoryEntryInput({ ...entry, origin: entry.origin ?? sourceOrigin });
        if (!safe.origin || !memoryOriginsEqual(safe.origin, sourceOrigin)) throw new Error("Consolidation cannot move entries between memory origins.");
        if (safe.summary.length < 20) throw new Error("Consolidation returned a memory summary that is too short.");
        assertAllowedScopedEntry(safe, directory.workspaceRoot);
        return safe;
      });
      if (!safeReplacements.length) throw new Error("Consolidation cannot delete all source memories.");
      const nextRevision = snapshot.state.revision + 1;
      const timestamp = now.toISOString();
      const created: ScopeEntryRecord[] = [];
      for (const input of safeReplacements) {
        const entry = createStoredMemoryEntry(input, {
          id: randomUUID(),
          revision: nextRevision,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        // source 文件删除前仍占用名字；新 entry 必须避开它们，不能先覆盖再被清理阶段删除。
        const fileName = chooseEntryFileName(entry, [...snapshot.entries, ...created]);
        created.push({ entry, fileName });
      }
      await this.commitDestructiveMutation(directory, {
        version: 3,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: timestamp,
        entryWrites: created.map(({ entry, fileName }) => ({
          fileName,
          content: renderMemoryEntry(entry),
          id: entry.id
        })),
        entryDeletes: snapshot.entries.filter(({ entry }) => sourceSet.has(entry.id)).map(({ fileName }) => fileName),
        candidateDeletes: []
      }, options.signal);
      return { entries: created.map(({ entry }) => entry), revision: nextRevision };
    });
  }

  async readIndex(scope: MemoryScope, signal?: AbortSignal): Promise<string | undefined> {
    void scope;
    return (await this.readScope(scope, signal)).index;
  }

  /** 维护状态是操作元数据，不改变 memory revision；后台失败和进程重启后仍可审计。 */
  async readMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    const directory = await resolveScopeDirectory(this.workspaceRoot, "project", false);
    if (!directory) return emptyMaintenanceStatus();
    return await this.withResolvedScopeLock(directory, options.signal, async () => {
      const content = await readOptionalSafeFile(directory, maintenanceFileName, maxStateChars, options.signal);
      if (!content) return emptyMaintenanceStatus();
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new Error("Invalid memory maintenance status JSON.");
      }
      const parsed = maintenanceSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Invalid memory maintenance status.");
      const { version: _version, ...status } = parsed.data;
      return status;
    });
  }

  async writeMaintenanceStatus(status: MemoryMaintenanceStatus, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.withScopeLock("project", true, signal, async (directory) => {
      const safe: MemoryMaintenanceStatus = {
        state: status.state,
        startedAt: safeOptionalTime(status.startedAt),
        lastScanAt: safeOptionalTime(status.lastScanAt),
        lastFinishedAt: safeOptionalTime(status.lastFinishedAt),
        eligible: safeCounter(status.eligible),
        processed: safeCounter(status.processed),
        written: safeCounter(status.written),
        failed: safeCounter(status.failed),
        error: status.error === undefined ? undefined : redactSecrets(status.error).trim().slice(0, 2_000) || undefined
      };
      await atomicWriteFile(directory, maintenanceFileName, `${JSON.stringify({ version: 3, ...safe }, null, 2)}\n`);
    });
  }

  private async readScope(scope: MemoryScope, signal?: AbortSignal): Promise<ScopeSnapshot> {
    signal?.throwIfAborted();
    const existing = await resolveScopeDirectory(this.workspaceRoot, scope, false);
    if (!existing) return emptySnapshot();
    return await this.withResolvedScopeLock(existing, signal, async () => await this.readScopeLocked(existing, new Date(), signal));
  }

  private async readScopeLocked(directory: PinnedScopeDirectory, now: Date, signal?: AbortSignal): Promise<ScopeSnapshot> {
    signal?.throwIfAborted();
    await assertPinnedScopeDirectory(this.workspaceRoot, directory);
    const state = await recoverPendingMutationLocked(
      directory,
      await readState(directory),
      this.maxIndexChars,
      signal
    );
    const migrated = await migrateV2ScopesLocked(directory, state, now, this.maxIndexChars, signal);
    const entries = await applyUsageProjection(directory, await readEntryRecords(directory, signal), signal);
    const candidates = await readCandidates(directory, false, signal);
    const reconciled = reconcileState(migrated, entries, candidates, now);
    let index = await readOptionalSafeFile(directory, memoryIndexFileName, this.maxIndexChars, signal);
    const expectedIndex = renderIndex(directory.scope, reconciled.revision, entries, this.maxIndexChars);
    if (index !== expectedIndex) {
      await atomicWriteFile(directory, memoryIndexFileName, expectedIndex);
      index = expectedIndex;
    }
    if (reconciled.revision !== migrated.revision) await atomicWriteFile(directory, stateFileName, renderState(reconciled));
    return { directory, state: reconciled, entries, candidates, index };
  }

  private async withScopeLock<T>(
    scope: MemoryScope,
    create: boolean,
    signal: AbortSignal | undefined,
    operation: (directory: PinnedScopeDirectory) => Promise<T>
  ): Promise<T> {
    const directory = await resolveScopeDirectory(this.workspaceRoot, scope, create);
    if (!directory) throw new Error(`Failed to create ${scope} memory storage.`);
    return await this.withResolvedScopeLock(directory, signal, async () => await operation(directory));
  }

  private async withResolvedScopeLock<T>(
    directory: PinnedScopeDirectory,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockPath = path.join(directory.path, lockDirectoryName);
    const deadline = Date.now() + lockTimeoutMs;
    let identity: { dev: number | bigint; ino: number | bigint } | undefined;
    while (!identity) {
      signal?.throwIfAborted();
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        const stat = await fs.lstat(lockPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Memory lock must be a real directory.");
        identity = { dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stat = await fs.lstat(lockPath).catch(() => undefined);
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
          throw new Error("Memory lock must be a real directory.");
        }
        if (stat && !stat.isSymbolicLink() && stat.isDirectory() && Date.now() - stat.mtimeMs > staleLockMs) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          await fs.rename(lockPath, stalePath).catch(() => undefined);
          await fs.rmdir(stalePath).catch(() => undefined);
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${directory.scope} memory directory lock.`);
        await waitForLock(signal);
      }
    }
    try {
      await assertPinnedScopeDirectory(this.workspaceRoot, directory);
      return await operation();
    } finally {
      const current = await fs.lstat(lockPath).catch(() => undefined);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        await fs.rmdir(lockPath).catch(() => undefined);
      }
    }
  }

  private async commitSnapshot(
    directory: PinnedScopeDirectory,
    previous: MemoryState,
    revision: number,
    entries: ScopeEntryRecord[],
    _candidates: MemoryCandidate[],
    now: Date
  ): Promise<void> {
    const state: MemoryState = {
      version: 3,
      revision,
      updatedAt: now.toISOString(),
      migratedV2At: previous.migratedV2At
    };
    await atomicWriteFile(directory, memoryIndexFileName, renderIndex(directory.scope, revision, entries, this.maxIndexChars));
    // state 最后落盘，revision 因此充当这次目录 mutation 的 commit marker。
    await atomicWriteFile(directory, stateFileName, renderState(state));
  }

  private async commitDestructiveMutation(
    directory: PinnedScopeDirectory,
    mutation: PendingMutation,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    await atomicWriteFile(directory, pendingMutationFileName, `${JSON.stringify(mutation)}\n`);
    await recoverPendingMutationLocked(directory, await readState(directory), this.maxIndexChars, signal);
  }
}

function emptySnapshot(): ScopeSnapshot {
  return { state: emptyState(), entries: [], candidates: [], index: undefined };
}

function emptyState(): MemoryState {
  return { version: 3, revision: 0, updatedAt: new Date(0).toISOString(), migratedV2At: undefined };
}

function emptyMaintenanceStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
}

function scopeOverview(scope: MemoryScope, snapshot: ScopeSnapshot, entryCount: number): MemoryScopeOverview {
  return {
    scope,
    revision: snapshot.state.revision,
    entryCount,
    candidateCount: scope === "global"
      ? snapshot.candidates.filter((candidate) => candidate.origin.kind === "user").length
      : snapshot.candidates.filter((candidate) => candidate.origin.kind === "workspace" && candidate.origin.workspaceId === currentWorkspaceId(snapshot.directory)).length,
    indexChars: snapshot.index?.length ?? 0
  };
}

async function resolveScopeDirectory(workspaceRoot: string, scope: MemoryScope, create: boolean): Promise<PinnedScopeDirectory | undefined> {
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const configuredAgentPath = path.resolve(globalAgentDir());
  const agent = await ensureRealDirectory(configuredAgentPath, create, "global agent directory");
  if (!agent) return undefined;
  const canonicalAgent = await fs.realpath(configuredAgentPath);
  const memoryRootPath = path.join(canonicalAgent, "memory");
  const memoryRoot = await ensureRealDirectory(memoryRootPath, create, "global memory root");
  if (!memoryRoot) return undefined;
  const canonicalMemoryRoot = await fs.realpath(memoryRootPath);
  if (canonicalMemoryRoot !== memoryRootPath) throw new Error("Global memory root must be a real canonical directory.");
  void scope;
  const scopePath = canonicalMemoryRoot;
  const stat = await fs.lstat(scopePath);
  const canonicalScope = await fs.realpath(scopePath);
  if (canonicalScope !== canonicalMemoryRoot) throw new Error("Memory storage resolves outside the global memory root.");
  return {
    workspaceRoot: canonicalWorkspace,
    storageRoot: canonicalAgent,
    path: canonicalScope,
    scope: "project",
    device: stat.dev,
    inode: stat.ino
  };
}

async function ensureRealDirectory(directory: string, create: boolean, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error) || !create) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Local memory storage ${label} must be a real directory, not a symbolic link.`);
  }
  await fs.chmod(directory, 0o700);
  return stat;
}

async function assertPinnedScopeDirectory(workspaceRoot: string, expected: PinnedScopeDirectory): Promise<void> {
  const current = await resolveScopeDirectory(workspaceRoot, expected.scope, false);
  if (!current || current.path !== expected.path || current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("Local memory storage changed during access.");
  }
}

async function readState(directory: PinnedScopeDirectory): Promise<MemoryState> {
  const content = await readOptionalSafeFile(directory, stateFileName, maxStateChars);
  if (!content) return emptyState();
  try {
    const parsed = JSON.parse(content) as Partial<MemoryState>;
    if (parsed.version !== 3 || !Number.isSafeInteger(parsed.revision) || (parsed.revision ?? -1) < 0 || typeof parsed.updatedAt !== "string") {
      throw new Error("Invalid memory state.");
    }
    return {
      version: 3,
      revision: parsed.revision as number,
      updatedAt: parsed.updatedAt,
      migratedV2At: typeof parsed.migratedV2At === "string" ? parsed.migratedV2At : undefined
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid memory state JSON in ${directory.scope} scope.`);
    throw error;
  }
}

async function recoverPendingMutationLocked(
  directory: PinnedScopeDirectory,
  state: MemoryState,
  maxIndexChars: number,
  signal?: AbortSignal
): Promise<MemoryState> {
  const content = await readOptionalSafeFile(directory, pendingMutationFileName, maxPendingMutationChars, signal);
  if (!content) return state;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Invalid pending memory mutation JSON.");
  }
  const parsed = pendingMutationSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid pending memory mutation manifest.");
  const mutation = parsed.data;
  if (mutation.toRevision !== mutation.fromRevision + 1) {
    throw new Error("Pending memory mutation does not match its revision sequence.");
  }
  if (state.revision !== mutation.fromRevision && state.revision !== mutation.toRevision) {
    throw new Error(`Pending memory mutation cannot recover revision ${String(state.revision)}.`);
  }
  const writeNames = new Set(mutation.entryWrites.map(({ fileName }) => fileName));
  if (writeNames.size !== mutation.entryWrites.length || mutation.entryDeletes.some((fileName) => writeNames.has(fileName))) {
    throw new Error("Pending memory mutation contains duplicate or overlapping entry targets.");
  }
  const entriesPath = path.join(directory.path, entryDirectoryName);
  await ensureSafeChildDirectory(directory, entriesPath, true, "memory entry directory");
  for (const write of mutation.entryWrites) {
    signal?.throwIfAborted();
    const existing = await readOptionalSafeChildFile(directory, entriesPath, write.fileName, maxMemoryEntryChars, signal);
    if (existing !== undefined) {
      const entry = parseMemoryEntryFile(existing);
      if (!entry || entry.id !== write.id || existing !== write.content) {
        throw new Error(`Pending memory entry write conflicts with ${write.fileName}.`);
      }
    } else {
      const entry = parseMemoryEntryFile(write.content);
      if (!entry || entry.id !== write.id || entry.revision !== mutation.toRevision) {
        throw new Error(`Invalid pending memory entry payload: ${write.fileName}`);
      }
      await atomicWriteChildFile(directory, entriesPath, write.fileName, write.content);
    }
  }
  for (const fileName of mutation.entryDeletes) {
    signal?.throwIfAborted();
    await unlinkSafeChildFile(directory, entriesPath, fileName).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
  for (const id of mutation.candidateDeletes) {
    signal?.throwIfAborted();
    await unlinkCandidate(directory, id).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
  const entries = await readEntryRecords(directory, signal);
  const recovered: MemoryState = {
    version: 3,
    revision: mutation.toRevision,
    updatedAt: mutation.createdAt,
    migratedV2At: state.migratedV2At
  };
  await atomicWriteFile(directory, memoryIndexFileName, renderIndex(directory.scope, recovered.revision, entries, maxIndexChars));
  await atomicWriteFile(directory, stateFileName, renderState(recovered));
  await unlinkSafeFile(directory, pendingMutationFileName);
  return recovered;
}

async function readEntryRecords(directory: PinnedScopeDirectory, signal?: AbortSignal): Promise<ScopeEntryRecord[]> {
  signal?.throwIfAborted();
  const entriesPath = path.join(directory.path, entryDirectoryName);
  const child = await ensureSafeChildDirectory(directory, entriesPath, false, "memory entry directory");
  if (!child) return [];
  const names = (await fs.readdir(entriesPath, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const records: ScopeEntryRecord[] = [];
  for (const fileName of names) {
    const content = await readOptionalSafeChildFile(directory, entriesPath, fileName, maxMemoryEntryChars, signal);
    if (content === undefined) continue;
    const entry = parseMemoryEntryFile(content);
    if (!entry) throw new Error(`Invalid v3 memory entry file: ${fileName}`);
    records.push({ entry, fileName });
  }
  const ids = new Set<string>();
  for (const { entry } of records) {
    if (ids.has(entry.id)) throw new Error(`Duplicate memory entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  return records;
}

async function readCandidates(directory: PinnedScopeDirectory, create: boolean, signal?: AbortSignal): Promise<MemoryCandidate[]> {
  const candidatesPath = path.join(directory.path, candidateDirectoryName);
  const child = await ensureSafeChildDirectory(directory, candidatesPath, create, "memory candidate directory");
  if (!child) return [];
  signal?.throwIfAborted();
  const fileNames = (await fs.readdir(candidatesPath, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const candidates: MemoryCandidate[] = [];
  for (const fileName of fileNames) {
    const content = await readOptionalSafeChildFile(directory, candidatesPath, fileName, maxCandidateFileChars, signal);
    if (!content) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error(`Invalid memory candidate JSON: ${fileName}`);
    }
    const parsed = candidateSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid memory candidate: ${fileName}`);
    candidates.push(parsed.data);
  }
  return candidates;
}

async function readUsage(
  directory: PinnedScopeDirectory,
  signal?: AbortSignal
): Promise<Record<string, { recallCount: number; lastRecalledAt?: string }>> {
  const content = await readOptionalSafeFile(directory, usageFileName, maxUsageChars, signal);
  if (!content) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Invalid memory usage projection JSON.");
  }
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid memory usage projection.");
  return parsed.data.entries;
}

async function applyUsageProjection(
  directory: PinnedScopeDirectory,
  records: ScopeEntryRecord[],
  signal?: AbortSignal
): Promise<ScopeEntryRecord[]> {
  const usage = await readUsage(directory, signal);
  return records.map(({ entry, fileName }) => {
    const projected = usage[entry.id];
    return {
      fileName,
      entry: {
        ...entry,
        recallCount: projected?.recallCount ?? 0,
        lastRecalledAt: projected?.lastRecalledAt !== undefined && Number.isFinite(Date.parse(projected.lastRecalledAt))
          ? new Date(projected.lastRecalledAt).toISOString()
          : undefined
      }
    };
  });
}

async function writeCandidate(directory: PinnedScopeDirectory, candidate: MemoryCandidate): Promise<void> {
  const candidatePath = path.join(directory.path, candidateDirectoryName);
  await ensureSafeChildDirectory(directory, candidatePath, true, "memory candidate directory");
  await atomicWriteChildFile(directory, candidatePath, `${candidate.id}.json`, `${JSON.stringify({ version: 3, ...candidate }, null, 2)}\n`);
}

async function unlinkCandidate(directory: PinnedScopeDirectory, id: string): Promise<void> {
  const candidatePath = path.join(directory.path, candidateDirectoryName);
  const child = await ensureSafeChildDirectory(directory, candidatePath, false, "memory candidate directory");
  if (!child) return;
  await unlinkSafeChildFile(directory, candidatePath, `${id}.json`);
}

/**
 * 将旧 global/<workspace-id> scope 目录复制进单一 v3 库。旧目录全程只读并保留为冷备份；
 * migration manifest + 确定性 id 让进程中断后能够安全重放。
 */
async function migrateV2ScopesLocked(
  directory: PinnedScopeDirectory,
  state: MemoryState,
  now: Date,
  maxIndexChars: number,
  signal?: AbortSignal
): Promise<MemoryState> {
  if (state.migratedV2At) {
    if (await readOptionalSafeFile(directory, migrationFileName, maxStateChars, signal) !== undefined) {
      await unlinkSafeFile(directory, migrationFileName);
    }
    return state;
  }
  signal?.throwIfAborted();
  const names = (await fs.readdir(directory.path, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && (item.name === "global" || /^[a-f0-9]{24}$/u.test(item.name)))
    .map((item) => item.name)
    .sort();
  const savedProgress = await readV2MigrationProgress(directory, signal);
  const progress: V2MigrationProgress = savedProgress
    && sameStringList(savedProgress.sourceDirectories, names)
    ? savedProgress
    : {
        version: 3,
        status: "copying",
        sourceDirectories: names,
        sourceIndex: 0,
        phase: "entries",
        offset: 0,
        updatedAt: now.toISOString()
      };
  await writeV2MigrationProgress(directory, progress);

  const currentEntries = await readEntryRecords(directory, signal);
  const currentCandidates = await readCandidates(directory, false, signal);
  const records = [...currentEntries];
  const candidates = [...currentCandidates];
  const nextRevision = names.length || records.length || candidates.length
    ? Math.max(state.revision, ...records.map(({ entry }) => entry.revision), ...candidates.map((candidate) => candidate.revision), 0) + 1
    : state.revision;
  const canonicalWorkspaceId = workspaceOrigin(directory.workspaceRoot).workspaceId;
  const seenLegacyEntryIds = new Set<string>();
  const seenLegacyCandidateIds = new Set<string>();

  for (const [sourceIndex, sourceName] of names.entries()) {
    const sourceAlreadyCompleted = sourceIndex < progress.sourceIndex;
    signal?.throwIfAborted();
    const sourcePath = path.join(directory.path, sourceName);
    await assertLegacyScopeDirectory(directory, sourcePath);
    const origin: MemoryOrigin = sourceName === "global"
      ? { kind: "user" }
      : {
          kind: "workspace",
          workspaceId: sourceName,
          workspaceName: sourceName === canonicalWorkspaceId ? path.basename(directory.workspaceRoot) : `项目 ${sourceName.slice(0, 8)}`
        };
    const legacyEntriesPath = path.join(sourcePath, entryDirectoryName);
    const legacyEntryNames = await listLegacyFiles(legacyEntriesPath, ".md");
    const entryOffset = sourceAlreadyCompleted
      ? legacyEntryNames.length
      : sourceIndex === progress.sourceIndex
        ? progress.phase === "entries" ? progress.offset : legacyEntryNames.length
        : 0;
    for (const [entryIndex, fileName] of legacyEntryNames.entries()) {
      const content = await readLegacyRegularFile(path.join(legacyEntriesPath, fileName), maxMemoryEntryChars, signal);
      const legacy = parseLegacyV2MemoryEntryFile(content);
      if (!legacy) throw new Error(`Invalid v2 memory entry file: ${sourceName}/${fileName}`);
      const legacyPath = `${sourceName}/entries/${fileName}`;
      const createMigratedEntry = (id: string): MemoryEntry => createStoredMemoryEntry({
        origin,
        kind: legacy.kind,
        topic: legacy.topic,
        title: legacy.title,
        summary: legacy.summary,
        decisions: legacy.decisions,
        paths: legacy.paths,
        keywords: legacy.keywords,
        importance: legacy.importance,
        lineage: [
          ...legacy.lineage,
          { source: "migration", externalContext: false, sourceEntryIds: [legacy.id], legacyPath }
        ]
      }, {
        id,
        revision: nextRevision,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt
      });
      const expected = createMigratedEntry(legacy.id);
      const repeatedSourceId = seenLegacyEntryIds.has(legacy.id);
      seenLegacyEntryIds.add(legacy.id);
      let id = legacy.id;
      const collision = records.find(({ entry }) => entry.id === id);
      if (repeatedSourceId || (collision && !sameMigratedEntryPayload(collision.entry, expected))) {
        id = deterministicMigrationId("entry", legacy.id, legacyPath, migrationEntryPayload(expected));
      }
      const resolvedCollision = records.find(({ entry }) => entry.id === id)?.entry;
      if (resolvedCollision && !sameMigratedEntryPayload(resolvedCollision, expected)) {
        throw new Error(`Deterministic v2 entry migration id collision: ${legacyPath}`);
      }
      if (entryIndex < entryOffset) {
        const migrated = records.find(({ entry }) => entry.id === id)?.entry;
        if (!migrated || !sameMigratedEntryPayload(migrated, expected)) {
          throw new Error(`V2 migration progress references a missing entry: ${sourceName}/${fileName}`);
        }
        continue;
      }
      if (!records.some(({ entry }) => entry.id === id)) {
        const entry = createMigratedEntry(id);
        const activeFileName = chooseEntryFileName(entry, records);
        await atomicWriteChildFile(directory, path.join(directory.path, entryDirectoryName), activeFileName, renderMemoryEntry(entry));
        records.push({ entry, fileName: activeFileName });
      }
      await writeV2MigrationProgress(directory, {
        ...progress,
        sourceIndex,
        phase: "entries",
        offset: entryIndex + 1,
        updatedAt: new Date().toISOString()
      });
    }

    if (!sourceAlreadyCompleted) {
      await writeV2MigrationProgress(directory, {
        ...progress,
        sourceIndex,
        phase: "candidates",
        offset: sourceIndex === progress.sourceIndex && progress.phase === "candidates" ? progress.offset : 0,
        updatedAt: new Date().toISOString()
      });
    }

    const legacyCandidatesPath = path.join(sourcePath, candidateDirectoryName);
    const legacyCandidateNames = await listLegacyFiles(legacyCandidatesPath, ".json");
    const candidateOffset = sourceAlreadyCompleted
      ? legacyCandidateNames.length
      : sourceIndex === progress.sourceIndex && progress.phase === "candidates" ? progress.offset : 0;
    for (const [candidateIndex, fileName] of legacyCandidateNames.entries()) {
      const content = await readLegacyRegularFile(path.join(legacyCandidatesPath, fileName), maxCandidateFileChars, signal);
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new Error(`Invalid v2 memory candidate JSON: ${sourceName}/${fileName}`);
      }
      const parsed = legacyCandidateSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid v2 memory candidate: ${sourceName}/${fileName}`);
      const legacyPath = `${sourceName}/.candidates/${fileName}`;
      const { version: _version, ...legacyCandidate } = parsed.data;
      const expected: MemoryCandidate = {
        ...legacyCandidate,
        id: parsed.data.id,
        origin,
        audienceHint: parsed.data.scopeHint === "global" ? "universal" : "workspace",
        revision: nextRevision
      };
      const repeatedSourceId = seenLegacyCandidateIds.has(parsed.data.id);
      seenLegacyCandidateIds.add(parsed.data.id);
      let id = parsed.data.id;
      const collision = candidates.find((candidate) => candidate.id === id);
      if (repeatedSourceId || (collision && !sameMigratedCandidatePayload(collision, expected))) {
        id = deterministicMigrationId("candidate", parsed.data.id, legacyPath, migrationCandidatePayload(expected));
      }
      const resolvedCollision = candidates.find((candidate) => candidate.id === id);
      if (resolvedCollision && !sameMigratedCandidatePayload(resolvedCollision, expected)) {
        throw new Error(`Deterministic v2 candidate migration id collision: ${legacyPath}`);
      }
      if (candidateIndex < candidateOffset) {
        const migrated = candidates.find((candidate) => candidate.id === id);
        if (!migrated || !sameMigratedCandidatePayload(migrated, expected)) {
          throw new Error(`V2 migration progress references a missing candidate: ${sourceName}/${fileName}`);
        }
        continue;
      }
      if (!candidates.some((candidate) => candidate.id === id)) {
        const candidate: MemoryCandidate = {
          ...expected,
          id,
        };
        await writeCandidate(directory, candidate);
        candidates.push(candidate);
      }
      await writeV2MigrationProgress(directory, {
        ...progress,
        sourceIndex,
        phase: "candidates",
        offset: candidateIndex + 1,
        updatedAt: new Date().toISOString()
      });
    }
    if (!sourceAlreadyCompleted) {
      await writeV2MigrationProgress(directory, {
        ...progress,
        sourceIndex: sourceIndex + 1,
        phase: "entries",
        offset: 0,
        updatedAt: new Date().toISOString()
      });
    }
  }

  const [verifiedEntries, verifiedCandidates] = await Promise.all([
    readEntryRecords(directory, signal),
    readCandidates(directory, false, signal)
  ]);
  const verifiedEntryIds = new Set(verifiedEntries.map(({ entry }) => entry.id));
  const verifiedCandidateIds = new Set(verifiedCandidates.map((candidate) => candidate.id));
  if (records.some(({ entry }) => !verifiedEntryIds.has(entry.id))
    || candidates.some((candidate) => !verifiedCandidateIds.has(candidate.id))) {
    throw new Error("Migrated v2 memory verification failed before activating the v3 store.");
  }

  const migrated: MemoryState = {
    version: 3,
    revision: nextRevision,
    updatedAt: now.toISOString(),
    migratedV2At: now.toISOString()
  };
  await atomicWriteFile(directory, memoryIndexFileName, renderIndex("project", migrated.revision, verifiedEntries, maxIndexChars));
  await atomicWriteFile(directory, stateFileName, renderState(migrated));
  await unlinkSafeFile(directory, migrationFileName);
  return migrated;
}

async function readV2MigrationProgress(
  directory: PinnedScopeDirectory,
  signal?: AbortSignal
): Promise<V2MigrationProgress | undefined> {
  const content = await readOptionalSafeFile(directory, migrationFileName, maxStateChars, signal);
  if (!content) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Invalid v2 memory migration progress JSON.");
  }
  const parsed = v2MigrationProgressSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid v2 memory migration progress.");
  return parsed.data;
}

async function writeV2MigrationProgress(directory: PinnedScopeDirectory, progress: V2MigrationProgress): Promise<void> {
  await atomicWriteFile(directory, migrationFileName, `${JSON.stringify(progress, null, 2)}\n`);
}

/**
 * 迁移重放只能忽略 v3 写入时重新分配的 id/revision；其余规范化字段（包括来源路径与 lineage）
 * 都必须完全相同。这样同一旧 id 下 decisions、paths 等任一字段变化都不会被静默吞掉。
 */
function migrationEntryPayload(entry: MemoryEntry): object {
  return {
    origin: entry.origin,
    kind: entry.kind,
    topic: entry.topic,
    title: entry.title,
    summary: entry.summary,
    decisions: entry.decisions,
    paths: entry.paths,
    keywords: entry.keywords,
    importance: entry.importance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lineage: entry.lineage
  };
}

function sameMigratedEntryPayload(left: MemoryEntry, right: MemoryEntry): boolean {
  return JSON.stringify(migrationEntryPayload(left)) === JSON.stringify(migrationEntryPayload(right));
}

function migrationCandidatePayload(candidate: MemoryCandidate): object {
  return {
    summary: candidate.summary,
    completed: candidate.completed,
    lineage: candidate.lineage,
    origin: candidate.origin,
    audienceHint: candidate.audienceHint,
    scopeHint: candidate.scopeHint,
    kindHint: candidate.kindHint,
    createdAt: candidate.createdAt,
    eligibleAt: candidate.eligibleAt
  };
}

function sameMigratedCandidatePayload(left: MemoryCandidate, right: MemoryCandidate): boolean {
  return JSON.stringify(migrationCandidatePayload(left)) === JSON.stringify(migrationCandidatePayload(right));
}

function deterministicMigrationId(
  kind: "entry" | "candidate",
  legacyId: string,
  legacyPath: string,
  payload: object
): string {
  return createHash("sha256")
    .update(`${kind}\0${legacyId}\0${legacyPath}\0${JSON.stringify(payload)}`)
    .digest("hex")
    .slice(0, 32);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertLegacyScopeDirectory(directory: PinnedScopeDirectory, sourcePath: string): Promise<void> {
  await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(sourcePath) !== sourcePath) {
    throw new Error("Legacy memory scope must be a real canonical directory.");
  }
}

async function listLegacyFiles(directory: string, suffix: string): Promise<string[]> {
  let items;
  try {
    items = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return items.filter((item) => item.isFile() && item.name.endsWith(suffix)).map((item) => item.name).sort();
}

async function readLegacyRegularFile(filePath: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const initial = await fs.lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1 || await fs.realpath(filePath) !== filePath) {
    throw unsafeLeafError(path.basename(filePath));
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    const content = await handle.readFile({ encoding: "utf8", signal });
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw unsafeLeafError(path.basename(filePath));
    }
    return content.slice(0, maxChars);
  } finally {
    await handle.close();
  }
}

async function _migrateV1Locked(
  directory: PinnedScopeDirectory,
  state: MemoryState,
  now: Date,
  maxIndexChars: number,
  signal?: AbortSignal
): Promise<MemoryState> {
  signal?.throwIfAborted();
  // MEMORY.md 即使不是迁移源也要验证，不能让索引软链/硬链绕过边界检查。
  const legacyIndex = await readOptionalSafeFile(directory, memoryIndexFileName, Number.MAX_SAFE_INTEGER, signal);
  const names = (await fs.readdir(directory.path, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md") && entry.name !== memoryIndexFileName)
    .map((entry) => entry.name)
    .sort();
  const sources: Array<{ fileName: string; content: string; v2Entry?: MemoryEntry }> = [];
  for (const fileName of names) {
    const content = await readOptionalSafeFile(directory, fileName, Number.MAX_SAFE_INTEGER, signal);
    if (content !== undefined) sources.push({ fileName, content, v2Entry: parseMemoryEntryFile(content) });
  }
  if (!sources.length) {
    await sealLegacyBackupIfPresent(directory);
    return state;
  }

  const legacyPath = path.join(directory.path, legacyDirectoryName);
  await ensureSafeChildDirectory(directory, legacyPath, true, "legacy memory backup directory");
  for (const source of sources) {
    await writeBackupOnce(directory, legacyPath, source.fileName, source.content);
  }
  if (legacyIndex !== undefined) await writeBackupOnce(directory, legacyPath, memoryIndexFileName, legacyIndex);

  const currentV2 = await readEntryRecords(directory, signal);
  const nextRevision = Math.max(
    state.revision,
    ...currentV2.map(({ entry }) => entry.revision),
    ...sources.map(({ v2Entry }) => v2Entry?.revision ?? 0),
    0
  ) + 1;
  const expectedRecords: ScopeEntryRecord[] = [];
  for (const source of sources) {
    if (source.v2Entry) {
      const fileName = chooseEntryFileName(source.v2Entry, [...currentV2, ...expectedRecords]);
      expectedRecords.push({ entry: source.v2Entry, fileName });
      continue;
    }
    const topic = normalizeMemoryTopic(source.fileName.replace(/\.md$/i, ""));
    const sections = parseLegacySections(source.content);
    for (const [sectionIndex, section] of sections.entries()) {
      const chunks = splitLegacyContent(section.raw);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const id = createHash("sha256")
          .update(`${directory.scope}\0${source.fileName}\0${String(sectionIndex)}\0${String(chunkIndex)}\0${chunk}`)
          .digest("hex")
          .slice(0, 32);
        if (currentV2.some(({ entry }) => entry.id === id) || expectedRecords.some(({ entry }) => entry.id === id)) continue;
        const suffix = chunks.length === 1 ? "" : ` (part ${String(chunkIndex + 1)}/${String(chunks.length)})`;
        const entry = createStoredMemoryEntry({
          origin: directory.scope === "global" ? { kind: "user" } : workspaceOrigin(directory.workspaceRoot),
          kind: kindFromLegacyTopic(topic),
          topic,
          title: `${section.title}${suffix}`,
          // active v2 也保留原始 section；超长内容按 Unicode 字符边界分片，不只依赖 backup。
          summary: chunk,
          decisions: chunkIndex === 0 ? section.decisions : [],
          paths: chunkIndex === 0 ? section.paths : [],
          keywords: chunkIndex === 0 ? section.keywords : [],
          importance: 3,
          lineage: {
            source: "migration",
            externalContext: false,
            legacyPath: `${path.posix.join(legacyDirectoryName, source.fileName)}#section=${String(sectionIndex)}&chunk=${String(chunkIndex)}&chunks=${String(chunks.length)}`
          }
        }, {
          id,
          revision: nextRevision,
          createdAt: section.date ?? now.toISOString(),
          updatedAt: section.date ?? now.toISOString()
        });
        const fileName = `${topic}-${id.slice(0, 12)}.md`;
        expectedRecords.push({ entry, fileName });
      }
    }
  }
  const entriesPath = path.join(directory.path, entryDirectoryName);
  await ensureSafeChildDirectory(directory, entriesPath, true, "memory entry directory");
  for (const record of expectedRecords) {
    const existing = await readOptionalSafeChildFile(directory, entriesPath, record.fileName, maxMemoryEntryChars, signal);
    if (existing === undefined) await atomicWriteChildFile(directory, entriesPath, record.fileName, renderMemoryEntry(record.entry));
    else if (parseMemoryEntryFile(existing)?.id !== record.entry.id) throw new Error(`Migrated memory entry conflict: ${record.fileName}`);
  }

  // 删除旧源之前从磁盘重读：转换条目数、确定性 ID 和逐字节 backup 任一不符都停止迁移。
  const verified = await readEntryRecords(directory, signal);
  const expectedIds = new Set([...currentV2, ...expectedRecords].map(({ entry }) => entry.id));
  const verifiedIds = new Set(verified.map(({ entry }) => entry.id));
  if (verifiedIds.size < expectedIds.size || [...expectedIds].some((id) => !verifiedIds.has(id))) {
    throw new Error("Migrated memory verification failed before removing legacy sources.");
  }
  for (const source of sources) {
    const backup = await readOptionalSafeChildFile(directory, legacyPath, source.fileName, Number.MAX_SAFE_INTEGER, signal);
    if (backup !== source.content) throw new Error(`Legacy memory backup verification failed: ${source.fileName}`);
  }

  for (const source of sources) await unlinkSafeFile(directory, source.fileName);
  const records = verified;
  const migratedState: MemoryState = {
    version: 3,
    revision: nextRevision,
    updatedAt: now.toISOString(),
    migratedV2At: state.migratedV2At
  };
  await atomicWriteFile(directory, memoryIndexFileName, renderIndex(directory.scope, nextRevision, records, maxIndexChars));
  await atomicWriteFile(directory, stateFileName, renderState(migratedState));
  await sealLegacyBackup(directory, legacyPath);
  return migratedState;
}

interface LegacySection {
  title: string;
  date?: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
  raw: string;
}

function parseLegacySections(content: string): LegacySection[] {
  const lines = content.split("\n");
  const starts = lines.map((line, index) => line.startsWith("## ") ? index : -1).filter((index) => index >= 0);
  if (!starts.length) {
    const summary = content.trim();
    return summary ? [{ title: "Legacy project note", summary, decisions: [], paths: [], keywords: [], raw: content }] : [];
  }
  const sections: LegacySection[] = [];
  const preamble = lines.slice(0, starts[0]).join("\n").trim();
  if (preamble) sections.push({
    title: "Legacy topic preamble",
    summary: preamble,
    decisions: [],
    paths: [],
    keywords: [],
    raw: preamble
  });
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? lines.length;
    const rawLines = lines.slice(start, end);
    const raw = rawLines.join("\n");
    const title = rawLines[0]?.replace(/^##\s*/, "").trim() || "Legacy project note";
    const dateValue = fieldValue(rawLines, "Date");
    const summary = fieldValue(rawLines, "Summary") ?? rawLines.slice(1).map((line) => line.trim()).find(Boolean) ?? title;
    sections.push({
      title,
      date: dateValue !== undefined && Number.isFinite(Date.parse(dateValue)) ? new Date(dateValue).toISOString() : undefined,
      summary,
      decisions: nestedListValues(rawLines, "Decisions"),
      paths: splitField(fieldValue(rawLines, "Paths")),
      keywords: splitField(fieldValue(rawLines, "Tags")),
      raw
    });
  }
  return sections;
}

function fieldValue(lines: string[], name: string): string | undefined {
  const prefix = `- ${name}:`;
  return lines.find((line) => line.trim().startsWith(prefix))?.trim().slice(prefix.length).trim() || undefined;
}

function nestedListValues(lines: string[], name: string): string[] {
  const fieldIndex = lines.findIndex((line) => line.trim() === `- ${name}:`);
  if (fieldIndex < 0) return [];
  const values: string[] = [];
  for (const line of lines.slice(fieldIndex + 1)) {
    const match = line.match(/^\s{2,}-\s+(.+)$/u);
    if (!match) break;
    if (match[1]) values.push(match[1]);
  }
  return values;
}

function splitField(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function kindFromLegacyTopic(topic: string): MemoryEntryInput["kind"] {
  if (topic.includes("decision")) return "decision";
  if (topic.includes("workflow")) return "workflow";
  if (topic.includes("debug") || topic.includes("gotcha")) return "gotcha";
  return "fact";
}

/**
 * v1 topic files were unbounded. Preserve their complete bytes in .legacy-v1
 * and split the active v2 representation without cutting a UTF-16 surrogate
 * pair; createStoredMemoryEntry applies the same character budget to summary.
 */
function splitLegacyContent(content: string): string[] {
  if (!content) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + maxMemorySummaryChars);
    if (end < content.length && isHighSurrogate(content.charCodeAt(end - 1)) && isLowSurrogate(content.charCodeAt(end))) {
      end -= 1;
    }
    // maxMemorySummaryChars is safely larger than one code unit, but retain a
    // forward-progress guard should the budget ever be changed.
    if (end <= start) end = Math.min(content.length, start + 1);
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function reconcileState(state: MemoryState, entries: ScopeEntryRecord[], candidates: MemoryCandidate[], now: Date): MemoryState {
  const revision = Math.max(state.revision, ...entries.map(({ entry }) => entry.revision), ...candidates.map((candidate) => candidate.revision), 0);
  return revision === state.revision ? state : { ...state, revision, updatedAt: now.toISOString() };
}

function chooseEntryFileName(entry: MemoryEntry, records: ScopeEntryRecord[]): string {
  const simple = `${entry.topic}.md`;
  if (!records.some(({ fileName }) => fileName.toLowerCase() === simple.toLowerCase())) return simple;
  let length = 12;
  while (length <= entry.id.length) {
    const candidate = `${entry.topic}-${entry.id.slice(0, length)}.md`;
    if (!records.some(({ fileName }) => fileName.toLowerCase() === candidate.toLowerCase())) return candidate;
    length += 4;
  }
  return `${entry.topic}-${randomUUID()}.md`;
}

function renderIndex(scope: MemoryScope, revision: number, records: ScopeEntryRecord[], maxChars: number): string {
  void scope;
  const lines = [
    "# Biny Memory",
    "",
    `Revision: ${String(revision)}`,
    "",
    "This bounded index links to auditable one-entry Markdown records.",
    ""
  ];
  const sorted = [...records].sort(({ entry: left }, { entry: right }) => compareEntriesForDisplay(left, right));
  let omitted = 0;
  for (const { entry, fileName } of sorted) {
    const origin = entry.origin.kind === "user" ? "user" : `workspace:${entry.origin.workspaceName}`;
    const line = `- [${escapeIndexText(entry.title)}](entries/${fileName}) | ${origin} | ${entry.kind} | topic: ${entry.topic} | importance: ${String(entry.importance)} | updated: ${entry.updatedAt}`;
    const candidate = `${[...lines, line, ""].join("\n")}`;
    if (candidate.length > maxChars - 100) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }
  if (omitted) lines.push("", `... ${String(omitted)} entries omitted from this bounded index; entry files remain authoritative.`);
  const rendered = `${lines.join("\n").trimEnd()}\n`;
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, Math.max(0, maxChars - 1))}\n`;
}

function escapeIndexText(value: string): string {
  return value.replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").trim();
}

function renderState(state: MemoryState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function readOptionalSafeFile(
  directory: PinnedScopeDirectory,
  fileName: string,
  maxChars: number,
  signal?: AbortSignal
): Promise<string | undefined> {
  assertLeafName(fileName);
  signal?.throwIfAborted();
  await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
  const filePath = path.join(directory.path, fileName);
  let handle;
  try {
    await assertSafeLeaf(filePath, fileName, false);
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (isSymbolicLinkError(error)) throw unsafeLeafError(fileName);
    throw error;
  }
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1) throw unsafeLeafError(fileName);
    const content = await handle.readFile({ encoding: "utf8", signal });
    const current = await handle.stat();
    const binding = await fs.lstat(filePath);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino
      || binding.isSymbolicLink() || !binding.isFile() || binding.nlink !== 1 || binding.dev !== initial.dev || binding.ino !== initial.ino) {
      throw unsafeLeafError(fileName);
    }
    await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
    return content.slice(0, maxChars);
  } finally {
    await handle.close();
  }
}

async function atomicWriteFile(directory: PinnedScopeDirectory, fileName: string, content: string): Promise<void> {
  assertLeafName(fileName);
  await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
  const target = path.join(directory.path, fileName);
  await assertSafeLeaf(target, fileName, true);
  const temporaryName = `.${fileName}.${randomUUID()}.tmp`;
  const temporary = path.join(directory.path, temporaryName);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
    await assertSafeLeaf(target, fileName, true);
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncDirectory(directory.path);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function unlinkSafeFile(directory: PinnedScopeDirectory, fileName: string): Promise<void> {
  assertLeafName(fileName);
  await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
  const target = path.join(directory.path, fileName);
  await assertSafeLeaf(target, fileName, false);
  await fs.unlink(target);
  await syncDirectory(directory.path);
}

async function assertSafeLeaf(filePath: string, fileName: string, allowMissing: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(filePath) !== filePath) {
      throw unsafeLeafError(fileName);
    }
  } catch (error) {
    if (allowMissing && isNotFound(error)) return;
    throw error;
  }
}

async function ensureSafeChildDirectory(
  directory: PinnedScopeDirectory,
  childPath: string,
  create: boolean,
  label: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
  const expected = path.join(directory.path, path.basename(childPath));
  if (childPath !== expected) throw new Error(`Invalid ${label} path.`);
  const stat = await ensureRealDirectory(childPath, create, label);
  if (!stat) return undefined;
  if (await fs.realpath(childPath) !== childPath) throw new Error(`${label} must be a real canonical directory.`);
  return stat;
}

async function readOptionalSafeChildFile(
  directory: PinnedScopeDirectory,
  childPath: string,
  fileName: string,
  maxChars: number,
  signal?: AbortSignal
): Promise<string | undefined> {
  await ensureSafeChildDirectory(directory, childPath, false, "memory child directory");
  assertLeafName(fileName);
  const target = path.join(childPath, fileName);
  let handle;
  try {
    await assertSafeLeaf(target, fileName, false);
    handle = await fs.open(target, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const content = await handle.readFile({ encoding: "utf8", signal });
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unsafeLeafError(fileName);
    await assertPinnedScopeDirectory(directory.workspaceRoot, directory);
    return content.slice(0, maxChars);
  } finally {
    await handle.close();
  }
}

async function atomicWriteChildFile(directory: PinnedScopeDirectory, childPath: string, fileName: string, content: string): Promise<void> {
  await ensureSafeChildDirectory(directory, childPath, true, "memory child directory");
  assertLeafName(fileName);
  const target = path.join(childPath, fileName);
  await assertSafeLeaf(target, fileName, true);
  const temporary = path.join(childPath, `.${fileName}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncDirectory(childPath);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function unlinkSafeChildFile(directory: PinnedScopeDirectory, childPath: string, fileName: string): Promise<void> {
  await ensureSafeChildDirectory(directory, childPath, false, "memory child directory");
  assertLeafName(fileName);
  const target = path.join(childPath, fileName);
  await assertSafeLeaf(target, fileName, false);
  await fs.unlink(target);
  await syncDirectory(childPath);
}

async function writeBackupOnce(directory: PinnedScopeDirectory, legacyPath: string, fileName: string, content: string): Promise<void> {
  const existing = await readOptionalSafeChildFile(directory, legacyPath, fileName, Number.MAX_SAFE_INTEGER);
  if (existing !== undefined) {
    if (existing !== content) throw new Error(`Legacy memory backup conflict: ${fileName}`);
    return;
  }
  await atomicWriteChildFile(directory, legacyPath, fileName, content);
}

/**
 * Finish a verified v1 backup after migration commits. The backup stays
 * user-readable and removable with its workspace; its integrity comes from
 * the byte-for-byte verification above plus safe-leaf checks, not chmod bits
 * that would make normal workspace cleanup fail.
 */
async function sealLegacyBackup(directory: PinnedScopeDirectory, legacyPath: string): Promise<void> {
  const backup = await ensureSafeChildDirectory(directory, legacyPath, false, "legacy memory backup directory");
  if (!backup) return;
  const names = (await fs.readdir(legacyPath, { withFileTypes: true })).map((entry) => entry.name).sort();
  for (const fileName of names) {
    assertLeafName(fileName);
    const content = await readOptionalSafeChildFile(directory, legacyPath, fileName, Number.MAX_SAFE_INTEGER);
    if (content === undefined) throw new Error(`Legacy memory backup disappeared while sealing: ${fileName}`);
  }
  await syncDirectory(legacyPath);
}

async function sealLegacyBackupIfPresent(directory: PinnedScopeDirectory): Promise<void> {
  const legacyPath = path.join(directory.path, legacyDirectoryName);
  const backup = await ensureSafeChildDirectory(directory, legacyPath, false, "legacy memory backup directory");
  if (backup) await sealLegacyBackup(directory, legacyPath);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertLeafName(fileName: string): void {
  if (!fileName || fileName.includes("\0") || path.basename(fileName) !== fileName) {
    throw new Error(`Invalid local memory file name: ${fileName}`);
  }
}

function unsafeLeafError(fileName: string): Error {
  return new Error(`Local memory file must be a single regular file, not a symbolic link or hard link: ${fileName}`);
}

function assertExpectedRevision(scope: MemoryScope | "store", expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("expectedRevision must be a non-negative integer.");
  if (expected !== actual) throw new MemoryRevisionConflictError(scope, expected, actual);
}

function sameRevision(revision: number): MemoryScopeRevision {
  return { global: revision, project: revision };
}

function workspaceOrigin(canonicalWorkspace: string): Extract<MemoryOrigin, { kind: "workspace" }> {
  return {
    kind: "workspace",
    workspaceId: createHash("sha256").update(path.resolve(canonicalWorkspace)).digest("hex").slice(0, 24),
    workspaceName: path.basename(canonicalWorkspace).slice(0, 120) || "workspace"
  };
}

function resolveEntryOrigin(input: MemoryEntryInput, current: MemoryOrigin): MemoryEntryInput & { origin: MemoryOrigin } {
  const intended = input.audience === "universal" || input.scope === "global"
    ? "user"
    : input.audience === "workspace" || input.scope === "project"
      ? "workspace"
      : undefined;
  const origin = input.origin ?? (intended === "user" ? { kind: "user" as const } : current);
  if (intended !== undefined && origin.kind !== intended) throw new Error("Memory audience conflicts with origin.");
  if (origin.kind === "workspace" && current.kind === "workspace" && origin.workspaceId !== current.workspaceId) {
    throw new Error("New workspace memory must use the current workspace origin.");
  }
  return { ...input, origin };
}

function normalizeOriginSelectors(
  origins: MemoryOriginSelector[] | undefined,
  scopes: MemoryScope[] | undefined,
  defaultAll: boolean
): MemoryOriginSelector[] {
  if (origins?.length) return [...new Set(origins)];
  if (scopes?.length) {
    return [...new Set(scopes.map((scope): MemoryOriginSelector => scope === "global" ? "user" : "current_workspace"))];
  }
  return defaultAll ? ["all"] : ["user", "current_workspace"];
}

function matchesOriginSelectors(origin: MemoryOrigin, selectors: MemoryOriginSelector[], workspaceId: string): boolean {
  if (selectors.includes("all")) return true;
  if (origin.kind === "user") return selectors.includes("user");
  return origin.workspaceId === workspaceId
    ? selectors.includes("current_workspace")
    : selectors.includes("other_workspaces");
}

function currentWorkspaceId(directory: PinnedScopeDirectory | undefined): string {
  return directory ? workspaceOrigin(directory.workspaceRoot).workspaceId : "";
}

function emptyOriginCounts(): MemoryOriginCounts {
  return { user: 0, currentWorkspace: 0, otherWorkspaces: 0 };
}

function originBucket(origin: MemoryOrigin, workspaceId: string): keyof MemoryOriginCounts {
  if (origin.kind === "user") return "user";
  return origin.workspaceId === workspaceId ? "currentWorkspace" : "otherWorkspaces";
}

function countOrigins(entries: MemoryEntry[], workspaceId: string): MemoryOriginCounts {
  const counts = emptyOriginCounts();
  for (const entry of entries) counts[originBucket(entry.origin, workspaceId)] += 1;
  return counts;
}

function _normalizeScopes(scopes: MemoryScope[] | undefined): MemoryScope[] {
  if (!scopes?.length) return ["global", "project"];
  return [...new Set(scopes)];
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function compareEntriesForDisplay(left: MemoryEntry, right: MemoryEntry): number {
  return right.importance - left.importance
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.scope.localeCompare(right.scope)
    || left.id.localeCompare(right.id);
}

function validateCandidateLineage(input: MemoryCandidateInput): void {
  if (input.lineage.source !== "completed_task") throw new Error("Memory candidates require completed_task lineage.");
  if (input.scopeHint !== undefined && input.scopeHint !== "global" && input.scopeHint !== "project") {
    throw new Error(`Invalid memory candidate scope hint: ${String(input.scopeHint)}`);
  }
  if (input.kindHint !== undefined && !isMemoryKind(input.kindHint)) {
    throw new Error(`Invalid memory candidate kind hint: ${String(input.kindHint)}`);
  }
  for (const [field, value] of Object.entries({
    sessionId: input.lineage.sessionId,
    turnId: input.lineage.turnId,
    runId: input.lineage.runId
  })) {
    if (!value.trim()) throw new Error(`Memory candidate lineage requires ${field}.`);
  }
}

function isMemoryKind(value: string): boolean {
  return value === "preference"
    || value === "working_style"
    || value === "fact"
    || value === "decision"
    || value === "workflow"
    || value === "gotcha";
}

function normalizeForDedup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function safeCounter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeOptionalTime(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function waitForLock(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 25);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Memory lock wait aborted."));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
