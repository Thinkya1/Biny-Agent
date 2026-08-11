/**
 * LocalMemory v2 的纯磁盘存储层。
 *
 * scope 目录通过 mkdir 锁串行化跨进程写入；entry、state、candidate 和 MEMORY.md 都先写
 * 同目录临时文件、fsync 后 rename。模型调用不在目录锁内执行，避免长时间占锁。
 */
import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { globalAgentDir, projectMemoryDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  assertAllowedScopedEntry,
  createStoredMemoryEntry,
  maxMemoryCandidateChars,
  maxMemoryEntryChars,
  maxMemorySummaryChars,
  memoryEntryEquals,
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
  type MemoryClearResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryListOptions,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
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
const pendingMutationFileName = ".pending-mutation.json";
const entryDirectoryName = "entries";
const candidateDirectoryName = ".candidates";
const legacyDirectoryName = ".legacy-v1";
const lockDirectoryName = ".memory.lock";
const lockTimeoutMs = 5_000;
const staleLockMs = 120_000;
const maxStateChars = 32_000;
const maxCandidateFileChars = 8_000;
const maxPendingMutationChars = 1_000_000;

interface PinnedScopeDirectory {
  workspaceRoot: string;
  storageRoot: string;
  path: string;
  scope: MemoryScope;
  device: number | bigint;
  inode: number | bigint;
}

interface MemoryState {
  version: 2;
  revision: number;
  updatedAt: string;
  migratedV1At?: string;
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
  version: 2;
  scope: MemoryScope;
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

const maintenanceSchema = z.object({
  version: z.literal(2),
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
  version: z.literal(2),
  scope: z.enum(["global", "project"]),
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

export class MemoryStorage {
  private readonly maxIndexChars: number;

  constructor(readonly workspaceRoot: string, options: MemoryStorageOptions = {}) {
    this.maxIndexChars = Math.max(1_024, options.maxIndexChars ?? maxMemoryIndexChars);
  }

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    options.signal?.throwIfAborted();
    const [global, project] = await Promise.all([
      this.readScope("global", options.signal),
      this.readScope("project", options.signal)
    ]);
    const globalOverview = scopeOverview("global", global);
    const projectOverview = scopeOverview("project", project);
    return {
      scopes: { global: globalOverview, project: projectOverview },
      revision: { global: global.state.revision, project: project.state.revision }
    };
  }

  async listStoredEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    options.signal?.throwIfAborted();
    const scopes = normalizeScopes(options.scopes);
    // revision 始终返回两个 scope 的真实快照；scopes 只过滤 entries，避免 UI 把未查询 scope 误判成 revision 0。
    const snapshots = await this.readScopes(["global", "project"], options.signal);
    const topic = options.topic === undefined ? undefined : normalizeMemoryTopic(options.topic);
    const entries = snapshots.filter(({ scope }) => scopes.includes(scope))
      .flatMap(({ snapshot }) => snapshot.entries.map(({ entry }) => entry))
      .filter((entry) => topic === undefined || entry.topic === topic)
      .sort(compareEntriesForDisplay)
      .slice(0, normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return { entries, revision: revisionsFromSnapshots(snapshots) };
  }

  async searchScoped(query: string, queryPaths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const scopes = normalizeScopes(options.scopes);
    const snapshots = await this.readScopes(["global", "project"], options.signal);
    const now = options.now ?? new Date();
    const ranked = rankMemoryEntries(
      snapshots.filter(({ scope }) => scopes.includes(scope))
        .flatMap(({ snapshot }) => snapshot.entries.map(({ entry }) => entry)),
      redactSecrets(query),
      queryPaths.map((value) => redactSecrets(value)),
      now
    );
    const records = new Map(snapshots.flatMap(({ snapshot }) => snapshot.entries.map((record) => [record.entry.id, {
      record,
      directory: snapshot.directory
    }] as const)));
    const limit = normalizeLimit(options.limit, 3);
    const included = { global: 0, project: 0 };
    const trimmed = { global: 0, project: 0 };
    const omitted: MemorySearchResult["report"]["omitted"] = [];
    const matches: MemorySearchResult["matches"] = [];
    let usedChars = 0;
    let budgetOmitted = 0;

    for (const rankedEntry of ranked) {
      const metadata = records.get(rankedEntry.entry.id);
      if (!metadata?.directory) continue;
      if (matches.length >= limit) {
        trimmed[rankedEntry.entry.scope] += 1;
        omitted.push({ scope: rankedEntry.entry.scope, id: rankedEntry.entry.id, reason: "entry_limit" });
        continue;
      }
      const estimatedChars = rankedEntry.entry.title.length + rankedEntry.excerpt.length + 80;
      if (options.maxChars !== undefined && usedChars + estimatedChars > Math.max(0, options.maxChars)) {
        budgetOmitted += 1;
        omitted.push({ scope: rankedEntry.entry.scope, id: rankedEntry.entry.id, reason: "budget" });
        continue;
      }
      usedChars += estimatedChars;
      included[rankedEntry.entry.scope] += 1;
      matches.push(memoryMatchFromRanked(
        rankedEntry,
        path.relative(metadata.directory.storageRoot, path.join(metadata.directory.path, entryDirectoryName, metadata.record.fileName))
      ));
    }

    const report: MemorySearchResult["report"] = {
      included,
      trimmed,
      omitted,
      budgetOmission: options.maxChars === undefined || budgetOmitted === 0
        ? undefined
        : { maxChars: Math.max(0, options.maxChars), usedChars, omitted: budgetOmitted }
    };
    return { matches, revision: revisionsFromSnapshots(snapshots), report };
  }

  async writeScoped(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    options.signal?.throwIfAborted();
    const safe = sanitizeMemoryEntryInput(input);
    assertAllowedScopedEntry(safe, await fs.realpath(path.resolve(this.workspaceRoot)));
    return await this.withScopeLock(safe.scope, true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision(safe.scope, options.expectedRevision, snapshot.state.revision);
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

  async deleteStoredEntry(scope: MemoryScope, id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock(scope, true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision(scope, options.expectedRevision, snapshot.state.revision);
      const record = snapshot.entries.find(({ entry }) => entry.id === id);
      if (!record) return { deleted: false, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 2,
        scope,
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
      assertExpectedRevision(scope, options.expectedRevision, snapshot.state.revision);
      const targets = snapshot.entries.filter(({ entry }) => entry.topic === normalized);
      if (!targets.length) return { deleted: 0, revision: snapshot.state.revision };
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 2,
        scope,
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
    options.signal?.throwIfAborted();
    return await this.withScopeLock(scope, true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision(scope, options.expectedRevision, snapshot.state.revision);
      if (!snapshot.entries.length && !snapshot.candidates.length) {
        return { scope, deletedEntries: 0, deletedCandidates: 0, revision: snapshot.state.revision };
      }
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 2,
        scope,
        fromRevision: snapshot.state.revision,
        toRevision: nextRevision,
        createdAt: (options.now ?? new Date()).toISOString(),
        entryWrites: [],
        entryDeletes: snapshot.entries.map(({ fileName }) => fileName),
        candidateDeletes: snapshot.candidates.map(({ id }) => id)
      }, options.signal);
      return {
        scope,
        deletedEntries: snapshot.entries.length,
        deletedCandidates: snapshot.candidates.length,
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
      assertExpectedRevision("project", options.expectedRevision, snapshot.state.revision);
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
      .filter((candidate) => nowMs >= Date.parse(candidate.createdAt) + minAgeMs)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, normalizeLimit(options.limit, Number.MAX_SAFE_INTEGER));
    return { candidates, revision: snapshot.state.revision };
  }

  async removeCandidate(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withScopeLock("project", true, options.signal, async (directory) => {
      const snapshot = await this.readScopeLocked(directory, options.now ?? new Date(), options.signal);
      assertExpectedRevision("project", options.expectedRevision, snapshot.state.revision);
      if (!snapshot.candidates.some((candidate) => candidate.id === id)) {
        return { deleted: false, revision: snapshot.state.revision };
      }
      const nextRevision = snapshot.state.revision + 1;
      await this.commitDestructiveMutation(directory, {
        version: 2,
        scope: "project",
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
      assertExpectedRevision(scope, options.expectedRevision, snapshot.state.revision);
      const sourceSet = new Set(sourceEntryIds);
      if (sourceSet.size !== sourceEntryIds.length) throw new Error("Consolidation source ids must be unique.");
      if (![...sourceSet].every((id) => snapshot.entries.some(({ entry }) => entry.id === id))) {
        throw new MemoryRevisionConflictError(scope, options.expectedRevision, snapshot.state.revision);
      }
      const safeReplacements = replacements.map((entry) => {
        const safe = sanitizeMemoryEntryInput(entry);
        if (safe.scope !== scope) throw new Error("Consolidation cannot move entries between memory scopes.");
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
        version: 2,
        scope,
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
      await atomicWriteFile(directory, maintenanceFileName, `${JSON.stringify({ version: 2, ...safe }, null, 2)}\n`);
    });
  }

  private async readScopes(scopes: MemoryScope[], signal?: AbortSignal): Promise<Array<{ scope: MemoryScope; snapshot: ScopeSnapshot }>> {
    return await Promise.all(scopes.map(async (scope) => ({ scope, snapshot: await this.readScope(scope, signal) })));
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
    const migrated = await migrateV1Locked(directory, state, now, this.maxIndexChars, signal);
    const entries = await readEntryRecords(directory, signal);
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
      version: 2,
      revision,
      updatedAt: now.toISOString(),
      migratedV1At: previous.migratedV1At
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
  return { version: 2, revision: 0, updatedAt: new Date(0).toISOString(), migratedV1At: undefined };
}

function emptyMaintenanceStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
}

function scopeOverview(scope: MemoryScope, snapshot: ScopeSnapshot): MemoryScopeOverview {
  return {
    scope,
    revision: snapshot.state.revision,
    entryCount: snapshot.entries.length,
    candidateCount: snapshot.candidates.length,
    indexChars: snapshot.index?.length ?? 0
  };
}

function revisionsFromSnapshots(snapshots: Array<{ scope: MemoryScope; snapshot: ScopeSnapshot }>): MemoryScopeRevision {
  const revision: MemoryScopeRevision = { global: 0, project: 0 };
  for (const item of snapshots) revision[item.scope] = item.snapshot.state.revision;
  return revision;
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
  const projectPath = projectMemoryDir(canonicalWorkspace);
  const scopePath = scope === "global" ? path.join(path.dirname(projectPath), "global") : projectPath;
  const stat = await ensureRealDirectory(scopePath, create, `${scope} memory scope`);
  if (!stat) return undefined;
  const canonicalScope = await fs.realpath(scopePath);
  if (canonicalScope !== path.join(canonicalMemoryRoot, path.basename(scopePath))) {
    throw new Error(`${scope} memory storage resolves outside the global memory root.`);
  }
  return {
    workspaceRoot: canonicalWorkspace,
    storageRoot: canonicalAgent,
    path: canonicalScope,
    scope,
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
    if (parsed.version !== 2 || !Number.isSafeInteger(parsed.revision) || (parsed.revision ?? -1) < 0 || typeof parsed.updatedAt !== "string") {
      throw new Error("Invalid memory state.");
    }
    return {
      version: 2,
      revision: parsed.revision as number,
      updatedAt: parsed.updatedAt,
      migratedV1At: typeof parsed.migratedV1At === "string" ? parsed.migratedV1At : undefined
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
  if (mutation.scope !== directory.scope || mutation.toRevision !== mutation.fromRevision + 1) {
    throw new Error("Pending memory mutation does not match its scope or revision sequence.");
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
    version: 2,
    revision: mutation.toRevision,
    updatedAt: mutation.createdAt,
    migratedV1At: state.migratedV1At
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
    if (!entry) throw new Error(`Invalid v2 memory entry file: ${fileName}`);
    if (entry.scope !== directory.scope) throw new Error(`Memory entry scope mismatch: ${fileName}`);
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

async function writeCandidate(directory: PinnedScopeDirectory, candidate: MemoryCandidate): Promise<void> {
  const candidatePath = path.join(directory.path, candidateDirectoryName);
  await ensureSafeChildDirectory(directory, candidatePath, true, "memory candidate directory");
  await atomicWriteChildFile(directory, candidatePath, `${candidate.id}.json`, `${JSON.stringify({ version: 2, ...candidate }, null, 2)}\n`);
}

async function unlinkCandidate(directory: PinnedScopeDirectory, id: string): Promise<void> {
  const candidatePath = path.join(directory.path, candidateDirectoryName);
  const child = await ensureSafeChildDirectory(directory, candidatePath, false, "memory candidate directory");
  if (!child) return;
  await unlinkSafeChildFile(directory, candidatePath, `${id}.json`);
}

async function migrateV1Locked(
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
          scope: directory.scope,
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
    version: 2,
    revision: nextRevision,
    updatedAt: now.toISOString(),
    migratedV1At: state.migratedV1At ?? (sources.some(({ v2Entry }) => v2Entry === undefined) ? now.toISOString() : undefined)
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
  const lines = [
    `# Biny ${scope === "global" ? "Global" : "Project"} Memory`,
    "",
    `Revision: ${String(revision)}`,
    "",
    "This bounded index links to auditable one-entry Markdown records.",
    ""
  ];
  const sorted = [...records].sort(({ entry: left }, { entry: right }) => compareEntriesForDisplay(left, right));
  let omitted = 0;
  for (const { entry, fileName } of sorted) {
    const line = `- [${escapeIndexText(entry.title)}](${fileName}) | ${entry.kind} | topic: ${entry.topic} | importance: ${String(entry.importance)} | updated: ${entry.updatedAt}`;
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

function assertExpectedRevision(scope: MemoryScope, expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("expectedRevision must be a non-negative integer.");
  if (expected !== actual) throw new MemoryRevisionConflictError(scope, expected, actual);
}

function normalizeScopes(scopes: MemoryScope[] | undefined): MemoryScope[] {
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
