/**
 * LocalMemory v3 的纯磁盘存储层。
 *
 * 单一全局 memory 根目录的跨进程写入由一个全局 SQLite 权威库（.memory-authority.sqlite 上的
 * BEGIN IMMEDIATE 写事务）串行化；进程持锁期间崩溃会让事务随连接断开自动回滚，无需 stale 锁回收。
 * entry、state、candidate 和 MEMORY.md 都先写同目录临时文件、fsync 后 rename。模型调用不在写锁内执行。
 */
import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { globalAgentDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  assertAllowedScopedEntry,
  createStoredMemoryEntry,
  maxMemoryCandidateChars,
  maxMemoryEntryChars,
  memoryEntryEquals,
  memoryOriginsEqual,
  memoryMatchFromRanked,
  normalizeMemoryTopic,
  parseMemoryEntryFile,
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
  type MemoryArchiveResult,
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
  type MemorySearchOptions,
  type MemorySearchResult,
  type ScopedMemoryWriteResult
} from "./memoryTypes.js";

export const memoryCandidateEligibilityMs = 6 * 60 * 60 * 1_000;

const stateFileName = ".memory-state.json";
const maintenanceFileName = ".maintenance.json";
const usageFileName = ".memory-usage.json";
const pendingMutationFileName = ".pending-mutation.json";
const entryDirectoryName = "entries";
const candidateDirectoryName = ".candidates";
/** 全局记忆写权威库：与 memory 根同目录，BEGIN IMMEDIATE 事务即跨进程写锁。 */
const authorityDatabaseName = ".memory-authority.sqlite";
const authorityBusyTimeoutMs = 5_000;
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
  kindHint: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).optional(),
  createdAt: z.string(),
  eligibleAt: z.string(),
  revision: z.number().int().nonnegative()
});


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
  error: z.string().optional(),
  lastRun: z.object({
    id: z.string().min(1),
    trigger: z.enum(["scheduled", "manual"]),
    examined: z.number().int().nonnegative(),
    written: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative().default(0),
    exact: z.number().int().nonnegative().default(0),
    expired: z.number().int().nonnegative().default(0),
    similarity: z.number().int().nonnegative().default(0),
    llm: z.number().int().nonnegative().default(0),
    startedAt: z.string(),
    finishedAt: z.string()
  }).optional(),
  sleepRuns: z.array(z.object({
    id: z.string().min(1),
    trigger: z.enum(["scheduled", "manual"]),
    examined: z.number().int().nonnegative(),
    written: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative().default(0),
    exact: z.number().int().nonnegative().default(0),
    expired: z.number().int().nonnegative().default(0),
    similarity: z.number().int().nonnegative().default(0),
    llm: z.number().int().nonnegative().default(0),
    startedAt: z.string(),
    finishedAt: z.string()
  })).max(20).optional()
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
  private authority: DatabaseSync | undefined;
  /** 同一实例内的写串行化：避免并发写对共享权威连接发起嵌套 BEGIN；跨进程互斥仍由 BEGIN IMMEDIATE 兜底。 */
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(readonly workspaceRoot: string) {}

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const origins = countOrigins(snapshot.entries.map(({ entry }) => entry), currentWorkspaceId(snapshot.directory));
    return {
      storeRevision: snapshot.state.revision,
      entryCount: snapshot.entries.length,
      candidateCount: snapshot.candidates.length,
      origins
    };
  }

  /** v3 单库列表入口；offset/limit 组合做分页，total 为分页前计数。 */
  async listEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const selectors = normalizeOriginSelectors(options.origins);
    const workspaceId = currentWorkspaceId(snapshot.directory);
    const topic = options.topic === undefined ? undefined : normalizeMemoryTopic(options.topic);
    const matched = snapshot.entries
      .filter(({ entry }) => options.includeArchived === true || entry.archivedAt === undefined)
      .filter(({ entry }) => matchesOriginSelectors(entry.origin, selectors, workspaceId))
      .filter(({ entry }) => topic === undefined || entry.topic === topic)
      .sort((left, right) => compareEntriesForDisplay(left.entry, right.entry));
    const offset = normalizeLimit(options.offset, 0);
    const records = matched.slice(offset, offset + normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return {
      entries: records.map(({ entry }) => entry),
      paths: snapshot.directory === undefined
        ? undefined
        : Object.fromEntries(records.map(({ entry, fileName }) => [
          entry.id,
          path.relative(snapshot.directory!.storageRoot, path.join(snapshot.directory!.path, entryDirectoryName, fileName))
        ])),
      storeRevision: snapshot.state.revision,
      total: matched.length
    };
  }

  /** v3 单库词法搜索入口；语义层在 Runtime Host 上游组合。 */
  async search(query: string, queryPaths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.searchInternal(query, queryPaths, options);
  }

  private async searchInternal(
    query: string,
    queryPaths: string[],
    options: MemorySearchOptions
  ): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.readScope("project", options.signal);
    const selectors = normalizeOriginSelectors(options.origins);
    const workspaceId = currentWorkspaceId(snapshot.directory);
    const now = options.now ?? new Date();
    const ranked = rankMemoryEntries(
      snapshot.entries.map(({ entry }) => entry)
        .filter((entry) => options.includeArchived === true || entry.archivedAt === undefined)
        .filter((entry) => matchesOriginSelectors(entry.origin, selectors, workspaceId)),
      query,
      queryPaths,
      now
    );
    const records = new Map(snapshot.entries.map((record) => [record.entry.id, record] as const));
    const limit = normalizeLimit(options.limit, 3);
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
        originTrimmed[bucket] += 1;
        omitted.push({ origin: rankedEntry.entry.origin, id: rankedEntry.entry.id, reason: "entry_limit" });
        continue;
      }
      const estimatedChars = rankedEntry.entry.title.length + rankedEntry.excerpt.length + 80;
      if (options.maxChars !== undefined && usedChars + estimatedChars > Math.max(0, options.maxChars)) {
        budgetOmitted += 1;
        omitted.push({ origin: rankedEntry.entry.origin, id: rankedEntry.entry.id, reason: "budget" });
        continue;
      }
      usedChars += estimatedChars;
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
      omitted,
      budgetOmission: options.maxChars === undefined || budgetOmitted === 0
        ? undefined
        : { maxChars: Math.max(0, options.maxChars), usedChars, omitted: budgetOmitted }
    };
    return {
      matches,
      storeRevision: snapshot.state.revision,
      report
    };
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    options.signal?.throwIfAborted();
    const canonicalWorkspace = await fs.realpath(path.resolve(this.workspaceRoot));
    const safe = resolveEntryOrigin(sanitizeMemoryEntryInput(input), workspaceOrigin(canonicalWorkspace));
    assertAllowedScopedEntry(safe, canonicalWorkspace);
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.signal);
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

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    options.signal?.throwIfAborted();
    const canonicalWorkspace = await fs.realpath(path.resolve(this.workspaceRoot));
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const now = options.now ?? new Date();
      const snapshot = await this.readScopeLocked(directory, options.signal);
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
        archivedAt: record.entry.archivedAt,
        archivedReason: record.entry.archivedReason,
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

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions): Promise<MemoryArchiveResult> {
    options.signal?.throwIfAborted();
    const canonicalWorkspace = await fs.realpath(path.resolve(this.workspaceRoot));
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const now = options.now ?? new Date();
      const snapshot = await this.readScopeLocked(directory, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const record = snapshot.entries.find(({ entry }) => entry.id === id);
      if (!record) return { archived: false, revision: snapshot.state.revision };
      if ((record.entry.archivedAt !== undefined) === archived) return { archived, entry: record.entry, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      const input = sanitizeMemoryEntryInput({
        origin: record.entry.origin,
        kind: record.entry.kind,
        topic: record.entry.topic,
        title: record.entry.title,
        summary: record.entry.summary,
        decisions: record.entry.decisions,
        paths: record.entry.paths,
        keywords: record.entry.keywords,
        importance: record.entry.importance,
        archivedAt: archived ? now.toISOString() : undefined,
        archivedReason: archived ? "manual" : undefined,
        lineage: record.entry.lineage
      });
      assertAllowedScopedEntry(input, canonicalWorkspace);
      const entry = createStoredMemoryEntry(input, {
        id: record.entry.id,
        revision: nextRevision,
        createdAt: record.entry.createdAt,
        updatedAt: now.toISOString()
      });
      await atomicWriteChildFile(directory, path.join(directory.path, entryDirectoryName), record.fileName, renderMemoryEntry(entry));
      const records = snapshot.entries.map((item) => item.entry.id === id ? { entry, fileName: item.fileName } : item);
      await this.commitSnapshot(directory, snapshot.state, nextRevision, records, snapshot.candidates, now);
      return { archived, entry, revision: nextRevision };
    });
  }

  async purgeArchivedEntries(retentionDays: number, options: MemoryMutationOptions): Promise<{ deleted: number; revision: number }> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const cutoff = (options.now ?? new Date()).getTime() - Math.max(1, Math.trunc(retentionDays)) * 86_400_000;
      const targets = snapshot.entries.filter(({ entry }) => entry.archivedAt !== undefined && Date.parse(entry.archivedAt) <= cutoff);
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
      await pruneUsageEntries(directory, targets.map(({ entry }) => entry.id), options.signal);
      return { deleted: targets.length, revision: nextRevision };
    });
  }

  async deleteEntry(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.deleteEntryInternal(id, options);
  }

  private async deleteEntryInternal(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const record = snapshot.entries.find(({ entry }) => entry.id === id);
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
      await pruneUsageEntries(directory, [id], options.signal);
      return { deleted: true, revision: nextRevision };
    });
  }

  async clearEntries(selector: MemoryOriginSelector, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.signal);
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
      if (targets.length) {
        await pruneUsageEntries(directory, targets.map(({ entry }) => entry.id), options.signal);
      }
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
      const snapshot = await this.readScopeLocked(directory, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      if (input.lineage.externalContext && options.excludeExternalContext) {
        return { queued: false, revision: snapshot.state.revision, reason: "external_context_excluded" };
      }
      // 候选绝不保存完整聊天，只保留用户明确允许沉淀的有界 summary；正文不做盲目改写。
      const summary = input.summary.trim().slice(0, maxMemoryCandidateChars);
      if (summary.length < 20) return { queued: false, revision: snapshot.state.revision, reason: "summary_too_short" };
      const duplicate = snapshot.candidates.find((candidate) => (
        candidate.lineage.runId === input.lineage.runId
        && candidate.lineage.turnId === input.lineage.turnId
        && normalizeForDedup(candidate.summary) === normalizeForDedup(summary)
      ));
      if (duplicate) return { queued: false, candidate: duplicate, revision: snapshot.state.revision, reason: "duplicate" };
      const nextRevision = snapshot.state.revision + 1;
      const createdAt = now.toISOString();
      const candidateOrigin = input.origin ?? (input.audienceHint === "universal"
        ? { kind: "user" as const }
        : workspaceOrigin(directory.workspaceRoot));
      const candidate: MemoryCandidate = {
        id: randomUUID(),
        summary,
        completed: true,
        lineage: {
          source: "completed_task",
          sessionId: input.lineage.sessionId.trim().slice(0, 200),
          turnId: input.lineage.turnId.trim().slice(0, 200),
          runId: input.lineage.runId.trim().slice(0, 200),
          externalContext: input.lineage.externalContext
        },
        origin: candidateOrigin,
        audienceHint: input.audienceHint,
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
      const snapshot = await this.readScopeLocked(directory, options.signal);
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
  /** 回写「条目被引用」的使用投影；同一投影在 delete/clear 时同步清理孤儿行。 */
  /** 兼容旧调用名的别名；等价于 recordRecallUsage。 */
  async recordInjectedRecall(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.recordRecallUsage(ids, options);
  }

  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    await this.withScopeLock("project", true, options.signal, async (directory) => {
      const usage = await readUsage(directory, options.signal);
      const nowIso = (options.now ?? new Date()).toISOString();
      let changed = false;
      for (const id of uniqueIds) {
        usage[id] = {
          recallCount: (usage[id]?.recallCount ?? 0) + 1,
          lastRecalledAt: nowIso
        };
        changed = true;
      }
      if (changed) await writeUsageFile(directory, usage);
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
      const snapshot = await this.readScopeLocked(directory, options.signal);
      assertExpectedRevision("store", options.expectedRevision, snapshot.state.revision);
      const sourceSet = new Set(sourceEntryIds);
      if (sourceSet.size !== sourceEntryIds.length) throw new Error("Consolidation source ids must be unique.");
      if (![...sourceSet].every((id) => snapshot.entries.some(({ entry }) => entry.id === id))) {
        throw new MemoryRevisionConflictError(options.expectedRevision, snapshot.state.revision);
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


  /** 维护状态是操作元数据，不改变 memory revision；后台失败和进程重启后仍可审计。 */
  async readMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    const directory = await resolveScopeDirectory(this.workspaceRoot, "project", false);
    if (!directory) return emptyMaintenanceStatus();
    // 维护状态是单文件原子写，无锁读拿到的要么是旧值要么是新值，不会读到半截。
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
        error: status.error === undefined ? undefined : redactSecrets(status.error).trim().slice(0, 2_000) || undefined,
        lastRun: status.lastRun === undefined ? undefined : {
          id: status.lastRun.id,
          trigger: status.lastRun.trigger,
          examined: safeCounter(status.lastRun.examined),
          written: safeCounter(status.lastRun.written),
          failed: safeCounter(status.lastRun.failed),
          archived: safeCounter(status.lastRun.archived),
          exact: safeCounter(status.lastRun.exact ?? 0),
          expired: safeCounter(status.lastRun.expired ?? 0),
          similarity: safeCounter(status.lastRun.similarity ?? 0),
          llm: safeCounter(status.lastRun.llm ?? 0),
          startedAt: safeOptionalTime(status.lastRun.startedAt) ?? new Date(0).toISOString(),
          finishedAt: safeOptionalTime(status.lastRun.finishedAt) ?? new Date(0).toISOString()
        },
        sleepRuns: status.sleepRuns?.slice(-20).map((run) => ({
          id: run.id,
          trigger: run.trigger,
          examined: safeCounter(run.examined),
          written: safeCounter(run.written),
          failed: safeCounter(run.failed),
          archived: safeCounter(run.archived ?? 0),
          exact: safeCounter(run.exact ?? 0),
          expired: safeCounter(run.expired ?? 0),
          similarity: safeCounter(run.similarity ?? 0),
          llm: safeCounter(run.llm ?? 0),
          startedAt: safeOptionalTime(run.startedAt) ?? new Date(0).toISOString(),
          finishedAt: safeOptionalTime(run.finishedAt) ?? new Date(0).toISOString()
        }))
      };
      await atomicWriteFile(directory, maintenanceFileName, `${JSON.stringify({ version: 3, ...safe }, null, 2)}\n`);
    });
  }

  /** 读路径不取目录锁：单文件写入是原子的，跨文件视图允许短暂不一致。 */
  private async readScope(scope: MemoryScope, signal?: AbortSignal): Promise<ScopeSnapshot> {
    signal?.throwIfAborted();
    const existing = await resolveScopeDirectory(this.workspaceRoot, scope, false);
    if (!existing) return emptySnapshot();
    return await this.readScopeUnlocked(existing, signal);
  }

  /** 锁内读：供写路径在持有目录锁时复用，做 revision CAS 与恢复。 */
  private async readScopeLocked(directory: PinnedScopeDirectory, signal?: AbortSignal): Promise<ScopeSnapshot> {
    return await this.readScopeInternal(directory, signal, true);
  }

  /** 无锁读：跳过待提交恢复和状态修复，读到的是允许短暂不一致的快照。 */
  private async readScopeUnlocked(directory: PinnedScopeDirectory, signal?: AbortSignal): Promise<ScopeSnapshot> {
    return await this.readScopeInternal(directory, signal, false);
  }

  private async readScopeInternal(directory: PinnedScopeDirectory, signal: AbortSignal | undefined, locked: boolean): Promise<ScopeSnapshot> {
    signal?.throwIfAborted();
    await assertPinnedScopeDirectory(this.workspaceRoot, directory);
    const rawState = await readState(directory);
    // 只有持锁写方才负责恢复中断的 mutation；普通读不重放未提交内容，也不修复状态文件。
    const state = locked
      ? await recoverPendingMutationLocked(directory, rawState, signal)
      : rawState;
    const entries = await applyUsageProjection(directory, await readEntryRecords(directory, signal), signal);
    const candidates = await readCandidates(directory, false, signal);
    const snapshotState = locked ? stateForSnapshot(state, entries, candidates) : state;
    return { directory, state: snapshotState, entries, candidates };
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

  /**
   * 记忆写的跨进程互斥：全局权威库上的 BEGIN IMMEDIATE 写事务即写锁。
   * SQLite 对同一数据库文件做文件级互斥；持锁期间进程崩溃会让事务随连接断开回滚，锁自动释放。
   * 文件读写在这个临界区内 await，SQLite 锁只保护「谁在改」，真正的崩溃安全仍由 atomicWriteFile 保证。
   */
  private async withResolvedScopeLock<T>(
    directory: PinnedScopeDirectory,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const run = this.writeTail.then(() => this.withAuthorityTransaction(directory, signal, operation));
    // 队列只承载背压，不把上一次失败传给下一次。
    this.writeTail = run.catch(() => undefined);
    return await run;
  }

  private async withAuthorityTransaction<T>(
    directory: PinnedScopeDirectory,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted();
    const database = this.memoryAuthority(directory);
    database.exec("BEGIN IMMEDIATE");
    try {
      await assertPinnedScopeDirectory(this.workspaceRoot, directory);
      signal?.throwIfAborted();
      const result = await operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // 保留原始错误；连接关闭时 SQLite 会回收残留事务。
      }
      throw error;
    }
  }

  /** 打开（并缓存）全局记忆写权威库；与 memory 根同目录，保证锁的粒度与库一致。 */
  private memoryAuthority(directory: PinnedScopeDirectory): DatabaseSync {
    if (this.authority) return this.authority;
    const databasePath = path.join(directory.path, authorityDatabaseName);
    // 不设 WAL：多进程可能同时首次打开，切换日志模式要拿写锁会相互冲突。
    // 权威库不写任何业务数据，默认 rollback-journal 已足够；BEGIN IMMEDIATE 本身即写锁。
    const database = new DatabaseSync(databasePath, { timeout: authorityBusyTimeoutMs });
    this.authority = database;
    return database;
  }

  private async commitSnapshot(
    directory: PinnedScopeDirectory,
    previous: MemoryState,
    revision: number,
    entries: ScopeEntryRecord[],
    _candidates: MemoryCandidate[],
    now: Date
  ): Promise<void> {
    void previous;
    const state: MemoryState = {
      version: 3,
      revision,
      updatedAt: now.toISOString()
    };
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
    await recoverPendingMutationLocked(directory, await readState(directory), signal);
  }
}

function emptySnapshot(): ScopeSnapshot {
  return { state: emptyState(), entries: [], candidates: [] };
}

function emptyState(): MemoryState {
  return { version: 3, revision: 0, updatedAt: new Date(0).toISOString() };
}

function emptyMaintenanceStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
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
  if (create) await fs.chmod(directory, 0o700);
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
    return { version: 3, revision: parsed.revision as number, updatedAt: parsed.updatedAt };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid memory state JSON in ${directory.scope} scope.`);
    throw error;
  }
}

async function recoverPendingMutationLocked(
  directory: PinnedScopeDirectory,
  state: MemoryState,
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
    updatedAt: mutation.createdAt
  };
  void entries;
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

async function writeUsageFile(
  directory: PinnedScopeDirectory,
  entries: Record<string, { recallCount: number; lastRecalledAt?: string }>
): Promise<void> {
  await atomicWriteFile(directory, usageFileName, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

async function pruneUsageEntries(
  directory: PinnedScopeDirectory,
  ids: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const usage = await readUsage(directory, signal);
  let changed = false;
  for (const id of ids) {
    if (usage[id] !== undefined) {
      delete usage[id];
      changed = true;
    }
  }
  if (changed) await writeUsageFile(directory, usage);
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
 * 迁移重放只能忽略 v3 写入时重新分配的 id/revision；其余规范化字段（包括来源路径与 lineage）
 * 都必须完全相同。这样同一旧 id 下 decisions、paths 等任一字段变化都不会被静默吞掉。
 */
















/**
 * v1 topic files were unbounded. Preserve their complete bytes in .legacy-v1
 * and split the active v2 representation without cutting a UTF-16 surrogate
 * pair; createStoredMemoryEntry applies the same character budget to summary.
 */



function stateForSnapshot(state: MemoryState, entries: ScopeEntryRecord[], candidates: MemoryCandidate[]): MemoryState {
  const revision = Math.max(state.revision, ...entries.map(({ entry }) => entry.revision), ...candidates.map((candidate) => candidate.revision), 0);
  return revision === state.revision ? state : { ...state, revision };
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


/**
 * Finish a verified v1 backup after migration commits. The backup stays
 * user-readable and removable with its workspace; its integrity comes from
 * the byte-for-byte verification above plus safe-leaf checks, not chmod bits
 * that would make normal workspace cleanup fail.
 */


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
  if (expected !== actual) throw new MemoryRevisionConflictError(expected, actual);
}

function workspaceOrigin(canonicalWorkspace: string): Extract<MemoryOrigin, { kind: "workspace" }> {
  return {
    kind: "workspace",
    workspaceId: createHash("sha256").update(path.resolve(canonicalWorkspace)).digest("hex").slice(0, 24),
    workspaceName: path.basename(canonicalWorkspace).slice(0, 120) || "workspace"
  };
}

function resolveEntryOrigin(input: MemoryEntryInput, current: MemoryOrigin): MemoryEntryInput & { origin: MemoryOrigin } {
  const intended = input.audience === "universal"
    ? "user"
    : input.audience === "workspace"
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
  origins: MemoryOriginSelector[] | undefined
): MemoryOriginSelector[] {
  if (origins?.length) return [...new Set(origins)];
  return ["all"];
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

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function compareEntriesForDisplay(left: MemoryEntry, right: MemoryEntry): number {
  return right.importance - left.importance
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function validateCandidateLineage(input: MemoryCandidateInput): void {
  if (input.lineage.source !== "completed_task") throw new Error("Memory candidates require completed_task lineage.");
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
