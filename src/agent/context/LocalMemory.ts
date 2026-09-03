/**
 * 本地记忆的模型编排层。
 *
 * MemoryStorage 负责单一 SQLite 事实库；本类负责记忆抽取、自动写入和 Sleep 整理。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AgentMessage, AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { globalAgentDir } from "../../config/paths.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import { messageText } from "../modelMessages.js";
import {
  assertAllowedMemoryEntry,
  memoryEntryExactKey,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import { MemoryStorage } from "./memoryStorage.js";
import {
  MemoryRevisionConflictError,
  type MemoryDerivedIndexSink,
  type MemoryClearResult,
  type MemoryArchiveEntriesResult,
  type MemoryArchiveReason,
  type MemoryArchiveResult,
  type MemoryBulkArchiveResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceResult,
  type MemoryMaintenanceStatus,
  type MemorySleepPreview,
  type MemorySleepRun,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryOriginSelector,
  type MemoryReadOptions,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemorySimilarEntrySearch,
  type MemorySimilarityPair,
  type MemoryWriteResult
} from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;
const defaultSleepSimilarityLow = 0.75;
const sleepSimilarityMergeThreshold = 0.95;
const maxSleepClusterSize = 50;

const memoryDedupSchema = z.object({
  isDuplicate: z.boolean(),
  reason: z.string().optional(),
  duplicateOf: z.number().int().positive().optional()
});

const memoryDeletionSelectionSchema = z.array(z.number().int().positive()).max(10);

const temporaryCleanupSelectionSchema = z.array(
  z.union([z.string().trim().min(1), z.number().int().positive()])
).max(20);

const memoryAddSchema = z.object({
  audience: z.enum(["universal", "workspace"]).default("workspace"),
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).default("fact"),
  topic: z.string().default("project"),
  title: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  decisions: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  importance: z.number().default(3),
  durability: z.enum(["temporary", "permanent"]).default("permanent"),
  expiresAt: z.string().optional(),
  userEvidence: z.string().optional()
}).superRefine((value, context) => {
  if (!(value.content?.trim() || value.summary?.trim())) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "Memory content is required." });
  }
});

const memoryUpdateSchema = z.object({
  add: z.array(memoryAddSchema).max(8).default([]),
  delete: z.array(z.string().trim().min(1)).max(16).default([])
});

/** Sleep 的模糊合并协议：模型只决定删除哪些旧 id，以及是否生成新事实。 */
const sleepMergeSchema = z.object({
  // 对模型响应采取“能读多少读多少”的策略；字段类型不对时按空操作处理，
  // 不能因为一个坏 ID 或一条坏 synthesis 误删整个相似簇。
  delete: z.unknown().optional(),
  synthesize: z.unknown().optional()
});

interface SleepMergeDecision {
  delete: string[];
  synthesize: Array<{
    content: string;
    durability: "temporary" | "permanent";
    expiresAt?: string;
  }>;
}

interface MemoryTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Durable, local-first memory. maxRecalled is a total entry count across global + project. */
export class LocalMemory {
  private readonly storage: MemoryStorage;
  private readonly recallLimitSource: number | (() => number);
  private maintenance: MemoryMaintenanceStatus = {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  };
  private maintenancePromise: Promise<MemoryMaintenanceResult> | undefined;
  private maintenanceAbort: AbortController | undefined;
  private maintenanceLoaded = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getExtractionModel: () => AgentModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    /** global + project 合计自动注入条数上限。 */
    recallLimit: number | (() => number) = 3,
    private readonly onModelRequest: ModelRequestObserver = () => undefined,
    private readonly getModelRequestContext: () => ModelRequestContext | undefined = () => undefined,
    private readonly derivedIndex?: Pick<MemoryDerivedIndexSink, "indexEntry" | "removeEntries">,
    private readonly findSimilarEntries?: MemorySimilarEntrySearch,
    /** summarization model 与 tool model 分开；旧/测试调用未提供时沿用抽取模型。 */
    private readonly getToolModel: () => AgentModel = getExtractionModel
  ) {
    this.recallLimitSource = recallLimit;
    this.storage = new MemoryStorage(workspaceRoot);
  }

  /**
   * 召回上限可以绑定到宿主配置。配置在每个根回合开始时刷新，因此这里不能只保存构造时快照。
   */
  get recallLimit(): number {
    return typeof this.recallLimitSource === "function"
      ? this.recallLimitSource()
      : this.recallLimitSource;
  }

  // ------------------------------ v3 public API ------------------------------

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    return await this.storage.getOverview(options);
  }

  async listMemoryEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    return await this.storage.listEntries(options);
  }

  async search(query: string, paths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.storage.search(query, paths, { ...options, limit: options.limit ?? this.recallLimit });
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<MemoryWriteResult> {
    const result = await this.storage.writeEntry(input, options);
    if (result.written && result.entry) await this.syncDerivedEntry(result.entry);
    return result;
  }

  /**
   * 自动贡献记忆的写入入口。它保留底层 SQLite 的确定性 exact dedup，写入前再做一次
   * “语义候选 → LLM 判断”；手动 /memory add 不经过这层模型判断。
   */
  async writeAutoEntry(
    input: MemoryEntryInput,
    options: MemoryMutationOptions & { requireSemantic?: boolean }
  ): Promise<MemoryWriteResult> {
    options.signal?.throwIfAborted();
    const safe = sanitizeMemoryEntryInput(input);
    const person = parsePersonMemory(safe.summary);
    if (person) {
      await this.appendPersonMemory(person.name, person.fact, options.signal);
      return { written: false, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
    assertAllowedMemoryEntry(safe, this.workspaceRoot);

    const candidates = await this.findSemanticMemoryEntries(safe.summary, 5, 0.3, options.signal);
    if (options.requireSemantic && candidates === undefined) {
      return { written: false, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
    const duplicate = candidates?.length
      ? await this.findDuplicateMemory(safe.summary, candidates, options.signal)
      : undefined;
    if (duplicate) {
      return {
        written: false,
        entry: duplicate,
        path: `memory://${duplicate.id}`,
        revision: (await this.getOverview({ signal: options.signal })).storeRevision
      };
    }
    return await this.writeEntry(safe, options);
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions): Promise<MemoryWriteResult> {
    const result = await this.storage.updateEntry(id, patch, options);
    if (result.written && result.entry) {
      if (result.entry.archivedAt !== undefined) this.removeDerivedEntries([result.entry.originalId ?? id]);
      else await this.syncDerivedEntry(result.entry);
    }
    return result;
  }

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions): Promise<MemoryArchiveResult> {
    const result = await this.storage.archiveEntry(id, archived, options);
    // archived 表示操作后的状态；是否真的发生 mutation 要看 revision 是否前进，
    // 否则“恢复”会漏掉派生向量的重新写入。
    if (result.revision !== options.expectedRevision) {
      if (archived) this.removeDerivedEntries([id]);
      else if (result.entry) await this.syncDerivedEntry(result.entry);
    }
    return result;
  }

  async archiveEntries(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMutationOptions & { mergedInto?: string }
  ): Promise<MemoryBulkArchiveResult> {
    const result = await this.storage.archiveEntries(ids, reason, options);
    if (result.archived) this.removeDerivedEntries(result.entries.map((entry) => entry.originalId ?? entry.id));
    return result;
  }

  async listArchivedEntries(options: MemoryReadOptions = {}): Promise<MemoryArchiveEntriesResult> {
    const result = await this.storage.listEntries({ origins: ["all"], includeArchived: true, signal: options.signal });
    const entries = result.entries.filter((entry) => entry.archivedAt !== undefined);
    return { entries, storeRevision: result.storeRevision, total: entries.length };
  }

  async deleteEntryById(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    const result = await this.storage.deleteEntry(id, options);
    if (result.deleted) this.removeDerivedEntries([result.entry?.originalId ?? id]);
    return result;
  }

  async clearEntries(selector: MemoryOriginSelector, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    // 底层 clear 会同时删除 active 与 archived；快照也必须包含归档条目，才能把它们的
    // 旧向量一并从派生索引移除。
    const snapshot = await this.storage.listEntries({ origins: [selector], includeArchived: true, signal: options.signal });
    const result = await this.storage.clearEntries(selector, options);
    if (result.deletedEntries) this.removeDerivedEntries(snapshot.entries.map((entry) => entry.originalId ?? entry.id));
    return result;
  }

  /** SQLite 是权威源；派生索引失败只能降级召回，不能让成功写入变成失败。 */
  private async syncDerivedEntry(entry: MemoryEntry): Promise<void> {
    try {
      await this.derivedIndex?.indexEntry(entry);
    } catch {
      // 派生索引可由后续 rebuild 修复，不能回滚已经提交的 SQLite 事实。
    }
  }

  private removeDerivedEntries(entryIds: readonly string[]): void {
    try {
      this.derivedIndex?.removeEntries?.(entryIds);
    } catch {
      // 派生索引可重建，不能阻断删除或归档。
    }
  }

  /** 记录「条目被实际引用」的使用投影，供 Sleep 选择 survivor。 */
  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.storage.recordRecallUsage(ids, options);
  }

  runMemoryMaintenance(
    options: MemoryMaintenanceOptions = {},
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    if (this.maintenancePromise) return this.maintenancePromise;
    const controller = new AbortController();
    this.maintenanceAbort = controller;
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    const promise = this.runMemoryMaintenanceImpl({ ...options, signal }, derivedIndex).finally(() => {
      if (this.maintenancePromise === promise) this.maintenancePromise = undefined;
      if (this.maintenanceAbort === controller) this.maintenanceAbort = undefined;
    });
    this.maintenancePromise = promise;
    return promise;
  }

  maintenanceStatus(): MemoryMaintenanceStatus {
    return { ...this.maintenance, sleepRuns: this.maintenance.sleepRuns?.map((run) => ({ ...run })), lastRun: this.maintenance.lastRun ? { ...this.maintenance.lastRun } : undefined };
  }

  cancelMaintenance(): boolean {
    if (!this.maintenanceAbort) return false;
    this.maintenanceAbort.abort();
    return true;
  }

  async previewMaintenance(options: { temporaryTtl?: number; archiveRetentionDays?: number } = {}): Promise<MemorySleepPreview> {
    const [entries, status] = await Promise.all([
      this.storage.listEntries({ origins: ["all"], includeArchived: true }),
      this.storage.readMaintenanceStatus().catch(() => undefined)
    ]);
    const now = new Date();
    const archiveCutoff = options.archiveRetentionDays === undefined ? Number.NEGATIVE_INFINITY : now.getTime() - Math.max(1, Math.trunc(options.archiveRetentionDays)) * 86_400_000;
    const temporaryToArchive = options.temporaryTtl === undefined ? 0 : entries.entries.filter((entry) => (
      entry.archivedAt === undefined
      && isExpiredTemporaryMemory(entry, now, options.temporaryTtl!)
    )).length;
    const archivedToDelete = options.archiveRetentionDays === undefined ? 0 : entries.entries.filter((entry) => (
      entry.archivedAt !== undefined && Date.parse(entry.archivedAt) <= archiveCutoff
    )).length;
    return {
      available: true,
      entries: entries.entries.filter((entry) => entry.archivedAt === undefined).length,
      temporaryToArchive,
      archivedToDelete,
      recentRuns: status?.sleepRuns?.length ?? 0,
      lastRun: status?.lastRun
    };
  }


  async loadMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    // 同一实例的维护正在进行时，UI/状态轮询不能把本进程刚写下的 running
    // 标记误判成崩溃遗留记录。
    if (this.maintenance.state === "running") return this.maintenanceStatus();
    const loaded = await this.storage.readMaintenanceStatus(options);
    const hasInterruptedRun = loaded.state === "running" || loaded.lastRun?.status === "running";
    if (hasInterruptedRun) {
      const finishedAt = new Date().toISOString();
      const interrupted = (run: MemorySleepRun): MemorySleepRun => ({
        ...run,
        status: "failed",
        finishedAt: run.finishedAt ?? finishedAt,
        error: "interrupted"
      });
      const lastRun = loaded.lastRun === undefined
        ? undefined
        : interrupted(loaded.lastRun);
      const history = [...(loaded.sleepRuns ?? [])];
      if (lastRun !== undefined && !history.some((run) => run.id === lastRun.id)) history.push(lastRun);
      const sleepRuns = history.map((run) => (
        run.status === "running" || run.id === lastRun?.id ? interrupted(run) : run
      )).slice(-20);
      this.maintenance = {
        ...loaded,
        state: "idle",
        lastFinishedAt: finishedAt,
        error: "interrupted",
        lastRun,
        sleepRuns
      };
      // A process can disappear between two maintenance writes. Converting the
      // durable running marker here is what prevents the scheduler from
      // treating an abandoned run as active forever.
      await this.storage.writeMaintenanceStatus(this.maintenance);
    } else {
      this.maintenance = loaded;
    }
    this.maintenanceLoaded = true;
    return this.maintenanceStatus();
  }

  private async runMemoryMaintenanceImpl(
    options: MemoryMaintenanceOptions,
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    derivedIndex ??= this.derivedIndex;
    // Manual callers may invoke the maintenance API on a fresh AgentSession
    // without going through Runtime Host. Load the old history first so this
    // run does not erase the durable 20-run window.
    if (!this.maintenanceLoaded) await this.loadMaintenanceStatus({ signal: options.signal });
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    const runId = `${startedAt}-${randomUUID()}`;
    const trigger = options.trigger ?? "scheduled";
    const sleepUsage: MemoryTokenUsage = { inputTokens: 0, outputTokens: 0 };
    const runningRun: MemorySleepRun = {
      id: runId,
      status: "running",
      trigger,
      examined: 0,
      written: 0,
      failed: 0,
      archived: 0,
      exact: 0,
      expired: 0,
      similarity: 0,
      llm: 0,
      archivedExact: 0,
      archivedExpired: 0,
      archivedOrphan: 0,
      archivedSimilarity: 0,
      archivedLlm: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt
    };
    const previousRuns = this.maintenance.sleepRuns ?? (
      this.maintenance.lastRun === undefined ? [] : [this.maintenance.lastRun]
    );
    this.maintenance = {
      state: "running",
      startedAt,
      lastScanAt: startedAt,
      eligible: 0,
      processed: 0,
      written: 0,
      failed: 0,
      error: undefined,
      lastRun: runningRun,
      sleepRuns: [...previousRuns.filter((run) => run.id !== runId), runningRun].slice(-20)
    };
    let scanned = 0;
    let processed = 0;
    let written = 0;
    let failed = 0;
    let archived = 0;
    let exact = 0;
    let expired = 0;
    let similarity = 0;
    let llm = 0;
    let examined = 0;
    let lastError: string | undefined;
    let runStatus: MemorySleepRun["status"] = "completed";
    const persistProgress = async (): Promise<void> => {
      const currentRun: MemorySleepRun = {
        ...runningRun,
        status: "running",
        examined,
        written,
        failed,
        archived,
        exact,
        expired,
        similarity,
        llm,
        archivedExact: exact,
        archivedExpired: expired,
        archivedOrphan: 0,
        archivedSimilarity: similarity,
        archivedLlm: llm,
        inputTokens: sleepUsage.inputTokens,
        outputTokens: sleepUsage.outputTokens,
        error: lastError
      };
      const history = (this.maintenance.sleepRuns ?? previousRuns).filter((run) => run.id !== runId);
      this.maintenance = {
        ...this.maintenance,
        eligible: scanned,
        processed,
        written,
        failed,
        error: lastError,
        lastRun: currentRun,
        sleepRuns: [...history, currentRun].slice(-20)
      };
      await this.storage.writeMaintenanceStatus(this.maintenance, options.signal);
    };
    try {
      await this.storage.writeMaintenanceStatus(this.maintenance, options.signal);
      // Sleep 直接扫描现有 active entries；记忆写入不再经过延迟候选队列。
      let active = (await this.storage.listEntries({ origins: ["all"], signal: options.signal })).entries;
      scanned = active.length;
      this.maintenance.eligible = scanned;
      examined = active.length;

      // Layer 1: 同一 origin namespace 内的 exact duplicate，完全确定性处理。
      for (const group of exactDuplicateGroups(active)) {
        options.signal?.throwIfAborted();
        const survivor = selectSleepSurvivor(group);
        const duplicateIds = group.filter((entry) => entry.id !== survivor.id).map((entry) => entry.id);
        if (!duplicateIds.length) continue;
        try {
          const result = await this.archiveForSleep(duplicateIds, "exact_dup", options, survivor.id, now, runId);
          if (result.archived > 0) {
            archived += result.archived;
            exact += result.archived;
            processed += result.archived;
            active = active.filter((entry) => !duplicateIds.includes(entry.id));
            notifySleepIndexRebuild(derivedIndex);
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          failed += 1;
          lastError ??= error instanceof Error ? error.message : String(error);
        }
      }

      // Layer 1b: temporary 只按 durability 过期；缺省值由格式层统一按 permanent 处理。
      if (options.temporaryTtl !== undefined) {
        const expiredIds = active
          .filter((entry) => isExpiredTemporaryMemory(entry, now, options.temporaryTtl!))
          .map((entry) => entry.id);
        if (expiredIds.length) {
          try {
            const result = await this.archiveForSleep(expiredIds, "expired", options, undefined, now, runId);
          if (result.archived > 0) {
            archived += result.archived;
            expired += result.archived;
              processed += result.archived;
              active = active.filter((entry) => !expiredIds.includes(entry.id));
              notifySleepIndexRebuild(derivedIndex);
            }
          } catch (error) {
            options.signal?.throwIfAborted();
            failed += 1;
            lastError ??= error instanceof Error ? error.message : String(error);
          }
        }
      }

      // Layer 2/3: 先按 embedding 相似度做 union-find，再把模糊簇交给 LLM。
      active = (await this.storage.listEntries({ origins: ["all"], signal: options.signal })).entries;
      const lowThreshold = clampSimilarity(options.llmMergeLow, defaultSleepSimilarityLow);
      if (derivedIndex?.findSimilarPairs && active.length > 1) {
        try {
          const pairs = await derivedIndex.findSimilarPairs(active, lowThreshold, options.signal);
          const clusters = buildSimilarityClusters(active, pairs, lowThreshold);
          for (const cluster of clusters) {
            options.signal?.throwIfAborted();
            if (cluster.entries.length > maxSleepClusterSize) continue;
            const currentIds = new Set(cluster.entries.map((entry) => entry.id));
            const current = active.filter((entry) => currentIds.has(entry.id));
            if (current.length < 2) continue;
            if (cluster.maxSimilarity >= sleepSimilarityMergeThreshold) {
              const survivor = selectSleepSurvivor(current);
              const duplicateIds = current.filter((entry) => entry.id !== survivor.id).map((entry) => entry.id);
              try {
                const result = await this.archiveForSleep(duplicateIds, "similarity_merge", options, survivor.id, now, runId);
                if (result.archived > 0) {
                  archived += result.archived;
                  similarity += result.archived;
                  processed += result.archived;
                  active = active.filter((entry) => !duplicateIds.includes(entry.id));
                  notifySleepIndexRebuild(derivedIndex);
                }
              } catch (error) {
                options.signal?.throwIfAborted();
                failed += 1;
                lastError ??= error instanceof Error ? error.message : String(error);
              }
              continue;
            }
            if (options.useLlm === false) continue;

            const ordered = [...current].sort(compareSleepEntries);
            const batchSize = normalizeSleepBatchSize(options.llmBatchSize);
            for (let offset = 0; offset < ordered.length; offset += batchSize) {
              const batchIds = new Set(ordered.slice(offset, offset + batchSize).map((entry) => entry.id));
              const batch = active.filter((entry) => batchIds.has(entry.id));
              if (batch.length < 2) continue;
              try {
                const result = await this.mergeSleepBatch(batch, options, now, derivedIndex, sleepUsage, runId);
                written += result.written;
                archived += result.archived;
                llm += result.archived;
                processed += result.written + result.archived;
                if (result.archived > 0) {
                  const archivedIds = new Set(result.archivedIds);
                  active = active.filter((entry) => !archivedIds.has(entry.id));
                }
              } catch (error) {
                options.signal?.throwIfAborted();
                failed += 1;
                lastError ??= error instanceof Error ? error.message : String(error);
              }
            }
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          failed += 1;
          lastError ??= error instanceof Error ? error.message : String(error);
        }
      }

      await persistProgress();
      if (options.archiveRetentionDays !== undefined) {
        const purged = await this.purgeArchivedWithRetry(options.archiveRetentionDays, options, now);
        if (purged > 0) notifySleepIndexRebuild(derivedIndex);
      }
      const finishedAt = new Date().toISOString();
      return { scanned, processed, written, failed, startedAt, finishedAt };
    } catch (error) {
      if (options.signal?.aborted) {
        runStatus = "cancelled";
      } else {
        runStatus = "failed";
        lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      const finishedAt = new Date().toISOString();
      const lastRun: MemorySleepRun = {
        id: runId,
        status: runStatus,
        trigger,
        examined,
        written,
        failed,
        archived,
        exact,
        expired,
        similarity,
        llm,
        archivedExact: exact,
        archivedExpired: expired,
        archivedOrphan: 0,
        archivedSimilarity: similarity,
        archivedLlm: llm,
        inputTokens: sleepUsage.inputTokens,
        outputTokens: sleepUsage.outputTokens,
        startedAt,
        finishedAt,
        error: lastError
      };
      const history = (this.maintenance.sleepRuns ?? previousRuns).filter((run) => run.id !== runId);
      this.maintenance = {
        state: "idle",
        lastScanAt: startedAt,
        lastFinishedAt: finishedAt,
        eligible: scanned,
        processed,
        written,
        failed,
        error: lastError,
        lastRun,
        sleepRuns: [...history, lastRun].slice(-20)
      };
      // Abort 后仍要留下已验证的清理/失败状态；状态写入不复用已中止 signal。
      await this.storage.writeMaintenanceStatus(this.maintenance).catch((error) => {
        this.maintenance.error ??= error instanceof Error ? error.message : String(error);
      });
    }
  }

  private async archiveForSleep(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMaintenanceOptions,
    mergedInto: string | undefined,
    now: Date,
    archivedBy: string
  ): Promise<MemoryBulkArchiveResult> {
    return await this.retryMutation(options.signal, async (expectedRevision) => (
      await this.storage.archiveEntries(ids, reason, {
        expectedRevision,
        mergedInto,
        archivedBy,
        now,
        signal: options.signal
      })
    ));
  }

  private async purgeArchivedWithRetry(
    retentionDays: number,
    options: MemoryMaintenanceOptions,
    now: Date
  ): Promise<number> {
    const result = await this.retryMutation(options.signal, async (expectedRevision) => (
      await this.storage.purgeArchivedEntries(retentionDays, {
        expectedRevision,
        now,
        signal: options.signal
      })
    ));
    return result.deleted;
  }

  private async mergeSleepBatch(
    entries: MemoryEntry[],
    options: MemoryMaintenanceOptions,
    now: Date,
    derivedIndex?: MemoryDerivedIndexSink,
    sleepUsage?: MemoryTokenUsage,
    archivedBy = "sleep"
  ): Promise<{ written: number; archived: number; archivedIds: string[] }> {
    const parsed = await this.sleepMergeEntriesWithModel(entries, options.signal, sleepUsage);
    const sourceIds = new Set(entries.map((entry) => entry.id));
    // 模型可能会带出簇外 ID；过滤它们，保留同一响应里的合法删除决定。
    const deleteIds = [...new Set(parsed.delete.filter((id) => sourceIds.has(id)))];
    if (!deleteIds.length && !parsed.synthesize.length) {
      return { written: 0, archived: 0, archivedIds: [] };
    }
    if (deleteIds.length === entries.length && parsed.synthesize.length === 0) {
      // 没有保留条目也没有 synthesis 时，放弃这一簇；把它当作 no-op，
      // 不把模型的过激判断升级成维护失败。
      return { written: 0, archived: 0, archivedIds: [] };
    }
    // synthesis 不等于删除原始记忆。只归档模型明确列在 delete 中的条目；
    // synthesis 且 delete=[] 时，旧条目和新条目会暂时同时保留。
    const archiveIds = deleteIds;

    const origin = entries[0]?.origin;
    const first = entries[0];
    if (!origin || !first) throw new Error("Sleep similarity cluster is empty.");
    const lineages = entries.flatMap((entry) => entry.lineage);
    const sourceEntryIds = entries.map((entry) => entry.id);
    const externalContext = lineages.some((lineage) => lineage.externalContext);
    const decisions = [...new Set(entries.flatMap((entry) => entry.decisions))];
    const paths = [...new Set(entries.flatMap((entry) => entry.paths))];
    const keywords = [...new Set(entries.flatMap((entry) => entry.keywords))];
    const syntheses = parsed.synthesize.map((synthesis) => {
      const input = sanitizeMemoryEntryInput({
        origin,
        kind: first.kind,
        topic: first.topic,
        title: entries.length === 1 ? first.title : `${first.title} (synthesized)`,
        summary: synthesis.content,
        decisions,
        paths,
        keywords,
        importance: Math.max(...entries.map((entry) => entry.importance)),
        durability: synthesis.durability,
        expiresAt: synthesis.expiresAt,
        lineage: [
          ...lineages,
          { source: "sleep", externalContext, sourceEntryIds }
        ]
      });
      if (input.summary.length < 20) throw new Error("Sleep model returned a synthesis that is too short.");
      assertAllowedMemoryEntry(input, this.workspaceRoot);
      return input;
    });

    let written = 0;
    const synthesisIds: string[] = [];
    for (const input of syntheses) {
      const result = await this.writeEntryWithRetry(input, options.signal, now);
      if (result.entry) synthesisIds.push(result.entry.id);
      if (result.written) written += 1;
      if (result.entry && derivedIndex) await derivedIndex.indexEntry(result.entry).catch(() => undefined);
    }
    if (syntheses.length > 0 && !synthesisIds.length) {
      throw new Error("Sleep model synthesis was not written.");
    }
    if (synthesisIds.some((id) => archiveIds.includes(id))) {
      throw new Error("Sleep model synthesis resolved to an entry it also requested to delete.");
    }
    const survivor = archiveIds.length < entries.length
      ? selectSleepSurvivor(entries.filter((entry) => !archiveIds.includes(entry.id))).id
      : undefined;
    const archivedResult = archiveIds.length === 0
      ? { entries: [], archived: 0, revision: (await this.storage.getOverview({ signal: options.signal })).storeRevision }
      : await this.archiveForSleep(archiveIds, "llm_merge", options, synthesisIds[0] ?? survivor, now, archivedBy);
    if (archivedResult.archived > 0) notifySleepIndexRebuild(derivedIndex);
    return {
      written,
      archived: archivedResult.archived,
      archivedIds: archivedResult.entries.map((entry) => entry.originalId ?? entry.id)
    };
  }

  private async sleepMergeEntriesWithModel(
    entries: MemoryEntry[],
    signal?: AbortSignal,
    usage?: MemoryTokenUsage
  ): Promise<SleepMergeDecision> {
    const prompt = [
      "Review one memory similarity cluster and remove only strict redundancy.",
      "Return JSON exactly as {delete:[memory ids], synthesize:[{content,durability,expiresAt?}] }.",
      "Delete only memories whose facts are fully represented by another memory or by a synthesis.",
      "Do not lose any fact, decision, path, keyword, or user preference.",
      "Do not merge genuinely unrelated topics. A cluster must not become empty.",
      "A synthesis may use only facts present in this cluster; never invent facts or secrets.",
      "When uncertain, return empty delete and empty synthesize.",
      "Memory cluster:",
      JSON.stringify(entries.map((entry) => ({
        id: entry.id,
        durability: entry.durability,
        expiresAt: entry.expiresAt,
        kind: entry.kind,
        topic: entry.topic,
        title: entry.title,
        content: entry.summary,
        decisions: entry.decisions,
        paths: entry.paths,
        keywords: entry.keywords,
        importance: entry.importance,
        accessCount: entry.recallCount,
        lastRecalledAt: entry.lastRecalledAt
      })))
    ].join("\n\n");
    const text = await this.modelText(
      this.getToolModel(),
      "You safely consolidate a small similarity cluster of durable memories.",
      prompt,
      4_096,
      signal,
      usage
    );
    let raw: unknown;
    try {
      raw = parseNativeJson(text);
    } catch {
      return emptySleepMergeDecision();
    }
    const parsed = sleepMergeSchema.safeParse(raw);
    if (!parsed.success) return emptySleepMergeDecision();
    const deleted = Array.isArray(parsed.data.delete)
      ? parsed.data.delete.filter((value): value is string => typeof value === "string")
      : [];
    const synthesize = Array.isArray(parsed.data.synthesize)
      ? parsed.data.synthesize.flatMap((value) => {
        const synthesis = normalizeSleepSynthesis(value);
        return synthesis === undefined ? [] : [synthesis];
      })
      : [];
    return { delete: deleted, synthesize };
  }

  /**
   * 在成功回合结束后直接整理并写入记忆。这里不落候选表：模型一次返回 add/delete，
   * 每个变更都通过同一套 SQLite CAS 写路径提交，失败也不会影响已经完成的对话。
   */
  async summarizeAndStoreMemories(
    messages: readonly AgentMessage[],
    options: {
      sessionId: string;
      turnId: string;
      runId: string;
      externalContext: boolean;
      excludeExternalContext: boolean;
      signal?: AbortSignal;
      now?: Date;
    }
  ): Promise<{ added: number; deleted: number }> {
    options.signal?.throwIfAborted();
    if (options.excludeExternalContext && options.externalContext) return { added: 0, deleted: 0 };
    const recentMessages = messages.slice(-4);
    // Only summarize a completed turn when the tail contains at least two
    // messages. A single user/tool fragment is too easy to mistake for a
    // durable fact (and is not a completed conversational turn).
    if (recentMessages.length < 2) return { added: 0, deleted: 0 };
    const existing = await this.listMemoryEntries({
      origins: ["user", "current_workspace"],
      limit: 64,
      signal: options.signal
    });
    const existingForPrompt = existing.entries.map((entry) => ({
      audience: entry.origin.kind === "user" ? "universal" : "workspace",
      kind: entry.kind,
      topic: entry.topic,
      content: entry.summary.slice(0, 800)
    }));
    const prompt = [
      "Review the last four messages from one completed agent turn and update durable memory.",
      "Return JSON exactly as {add:[...],delete:[memory descriptions]} and nothing else.",
      "Add only stable facts, decisions, workflows, gotchas, or explicit user preferences that are useful in a later turn.",
      "Use content for the self-contained memory text; audience defaults to workspace.",
      "Use universal only when the user explicitly states a lasting preference or working style, and copy that statement into userEvidence.",
      "Do not store secrets, ordinary activity, one-off task details, model instructions, or text copied from ## Relevant Memories.",
      "In group-chat context, facts about another participant may be emitted as an add with content exactly PERSON:<name>: <fact>; these are routed to a people profile instead of the durable memory table.",
      "For delete, describe the obsolete fact in plain language; do not return a memory ID. The description will be matched against candidate memories in a second step.",
      "Delete an existing memory only when the messages clearly correct or invalidate it. When uncertain, return empty add/delete.",
      "Existing memories:",
      JSON.stringify(existingForPrompt),
      "Recent messages:",
      formatMemoryExtractionMessages(recentMessages)
    ].join("\n\n");
    let parsed: z.infer<typeof memoryUpdateSchema>;
    try {
      parsed = memoryUpdateSchema.parse(parseNativeJson(await this.modelText(
        this.getToolModel(),
        "You maintain a small, auditable durable memory store.",
        prompt,
        2_048,
        options.signal
      )));
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { added: 0, deleted: 0 };
    }

    const now = options.now ?? new Date();
    let deleted = 0;
    for (const description of [...new Set(parsed.delete)]) {
      options.signal?.throwIfAborted();
      try {
        deleted += await this.deleteMemoryByDescription(description, options.signal, now);
      } catch {
        options.signal?.throwIfAborted();
        // 单个删除失败不应丢掉同一响应里的其它合法 add；下次成功回合仍可重新判断。
      }
    }

    let added = 0;
    for (const proposal of parsed.add) {
      options.signal?.throwIfAborted();
      try {
        const summary = (proposal.content ?? proposal.summary ?? "").trim();
        const title = (proposal.title?.trim() || summary.slice(0, 120)).trim();
        const input = sanitizeMemoryEntryInput({
          audience: proposal.audience,
          kind: proposal.kind,
          topic: proposal.topic,
          title,
          summary,
          decisions: proposal.decisions,
          paths: proposal.paths,
          keywords: proposal.keywords,
          importance: proposal.importance,
          durability: proposal.durability,
          expiresAt: proposal.expiresAt,
          lineage: {
            source: "completed_task",
            externalContext: options.externalContext,
            sessionId: options.sessionId,
            turnId: options.turnId,
            runId: options.runId,
            userEvidence: proposal.userEvidence
          }
        });
        assertAllowedMemoryEntry(input, this.workspaceRoot);
        // Generate an embedding before every automatic ADD. If the
        // semantic path is unavailable, skip this candidate instead of
        // silently weakening the write-time dedup guarantee.
        const result = await this.writeAutoEntryWithRetry(input, options.signal, now, true);
        if (result.written) added += 1;
      } catch {
        options.signal?.throwIfAborted();
        // 模型返回的单条坏记忆只跳过这一条，不阻止其它条目提交。
      }
    }
    deleted += await this.cleanupTemporaryMemories(
      formatMemoryExtractionMessages(recentMessages),
      now,
      options.signal
    );
    return { added, deleted };
  }

  private async findSemanticMemoryEntries(
    query: string,
    limit: number,
    minimumSimilarity: number,
    signal?: AbortSignal
  ): Promise<MemoryEntry[] | undefined> {
    if (!this.findSimilarEntries) return undefined;
    try {
      return await this.findSimilarEntries(query, { limit, minimumSimilarity, signal });
    } catch {
      signal?.throwIfAborted();
      // 语义判断是可选派生能力；索引/模型暂时不可用时保留确定性写入路径。
      return undefined;
    }
  }

  private async findDuplicateMemory(
    summary: string,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<MemoryEntry | undefined> {
    const prompt = [
      "Decide whether a new candidate memory is already represented by one of the existing memories.",
      "Treat it as a duplicate when it states the same core fact, is a subset of an existing fact, or is a vaguer/noisier restatement.",
      "Do not call it a duplicate when it adds a materially new fact or important detail.",
      "Return JSON exactly as {isDuplicate:true|false,reason?:string,duplicateOf?:number}.",
      "New memory:",
      summary,
      "Existing memories (candidate numbers start at 1):",
      JSON.stringify(candidates.map((entry, index) => ({
        candidate: index + 1,
        kind: entry.kind,
        topic: entry.topic,
        content: entry.summary,
        durability: entry.durability
      })))
    ].join("\n\n");
    let parsed: z.infer<typeof memoryDedupSchema>;
    try {
      const text = await this.modelText(
        this.getToolModel(),
        "You make conservative, auditable memory deduplication decisions.",
        prompt,
        512,
        signal
      );
      const result = memoryDedupSchema.safeParse(parseNativeJson(text));
      if (!result.success || !result.data.isDuplicate) return undefined;
      parsed = result.data;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
    const selected = parsed.duplicateOf === undefined ? undefined : candidates[parsed.duplicateOf - 1];
    return selected ?? candidates[0];
  }

  private async deleteMemoryByDescription(description: string, signal: AbortSignal | undefined, now: Date): Promise<number> {
    const candidates = await this.findSemanticMemoryEntries(description, 10, 0, signal);
    if (!candidates?.length) return 0;
    const selectedIndexes = await this.selectMemoryDeletionCandidates(description, candidates, signal);
    let deleted = 0;
    for (const index of selectedIndexes) {
      signal?.throwIfAborted();
      const entry = candidates[index - 1];
      if (!entry) continue;
      try {
        const result = await this.retryMutation(signal, async (expectedRevision) => (
          await this.deleteEntryById(entry.id, { expectedRevision, signal, now })
        ));
        if (result.deleted) deleted += 1;
      } catch {
        signal?.throwIfAborted();
        // 一个语义删除失败不应阻止同一轮继续清理其它候选。
      }
    }
    return deleted;
  }

  private async selectMemoryDeletionCandidates(
    description: string,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<number[]> {
    const prompt = [
      "Select the existing memories that are made obsolete by the deletion description.",
      "Return only a JSON array of 1-based candidate numbers, for example [1] or [].",
      "Delete only a memory that is directly contradicted, fully superseded, or clearly invalidated.",
      "When uncertain, return an empty array. Do not select a merely related memory.",
      "Deletion description:",
      description,
      "Candidates:",
      candidates.map((entry, index) => `${String(index + 1)}. [${entry.durability}] ${entry.summary}`).join("\n")
    ].join("\n\n");
    try {
      const text = await this.modelText(
        this.getToolModel(),
        "You safely map a deletion description to existing memory candidates.",
        prompt,
        512,
        signal
      );
      const parsed = memoryDeletionSelectionSchema.safeParse(parseNativeJson(text));
      if (!parsed.success) return [];
      return [...new Set(parsed.data.filter((index) => index >= 1 && index <= candidates.length))];
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  private async cleanupTemporaryMemories(conversation: string, now: Date, signal?: AbortSignal): Promise<number> {
    const candidates = await this.findSemanticMemoryEntries(conversation, 20, 0.3, signal);
    const temporary = candidates?.filter((entry) => entry.durability === "temporary") ?? [];
    if (!temporary.length) return 0;
    const prompt = [
      "Review temporary memories against the current completed-turn context.",
      "Return only a JSON array containing candidate IDs to delete; [] when none should be removed.",
      "Delete a temporary memory when it is expired, no longer relevant, or clearly replaced by newer information in the current context.",
      "Do not delete merely because it is old or because it is mentioned. When uncertain, keep it.",
      `Current date: ${now.toISOString()}`,
      "Current context:",
      conversation,
      "Temporary memories:",
      JSON.stringify(temporary.map((entry, index) => ({
        candidate: index + 1,
        id: entry.id,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        content: entry.summary
      })))
    ].join("\n\n");
    let selected: Array<string | number>;
    try {
      const text = await this.modelText(
        this.getToolModel(),
        "You conservatively clean up temporary memories after a turn.",
        prompt,
        512,
        signal
      );
      const parsed = temporaryCleanupSelectionSchema.safeParse(parseNativeJson(text));
      if (!parsed.success) return 0;
      selected = parsed.data;
    } catch {
      signal?.throwIfAborted();
      return 0;
    }
    const ids = new Set<string>();
    for (const value of selected) {
      if (typeof value === "number") {
        const entry = temporary[value - 1];
        if (entry) ids.add(entry.id);
      } else if (temporary.some((entry) => entry.id === value)) {
        ids.add(value);
      }
    }
    let deleted = 0;
    for (const id of ids) {
      signal?.throwIfAborted();
      try {
        const result = await this.retryMutation(signal, async (expectedRevision) => (
          await this.deleteEntryById(id, { expectedRevision, signal, now })
        ));
        if (result.deleted) deleted += 1;
      } catch {
        signal?.throwIfAborted();
      }
    }
    return deleted;
  }

  private async appendPersonMemory(name: string, fact: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const safeName = sanitizePersonFileName(name);
    if (!safeName) return;
    const peopleRoot = path.join(globalAgentDir(), "people");
    await mkdir(peopleRoot, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(peopleRoot, `${safeName}.md`),
      `- ${redactSecrets(fact).replace(/\s+/gu, " ").trim()}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  private async modelText(
    model: AgentModel,
    system: string,
    prompt: string,
    maxOutputTokens: number,
    signal?: AbortSignal,
    usage?: MemoryTokenUsage
  ): Promise<string> {
    const response = await generateNativeText(model, nativeJsonMessages(system, prompt), {
      signal,
      maxOutputTokens,
      timeoutMs: memoryModelTimeoutMs,
      onRequestMetrics: this.onModelRequest,
      requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
    });
    if (response.usage) {
      await this.onUsage(response.usage, "memory");
      if (usage) {
        usage.inputTokens += response.usage.inputTokens ?? 0;
        usage.outputTokens += response.usage.outputTokens ?? 0;
      }
    }
    signal?.throwIfAborted();
    return response.text;
  }

  private async writeEntryWithRetry(input: MemoryEntryInput, signal: AbortSignal | undefined, now: Date): Promise<MemoryWriteResult> {
    return await this.retryMutation(signal, async (expectedRevision) => (
      await this.writeEntry(input, { expectedRevision, signal, now })
    ));
  }

  private async writeAutoEntryWithRetry(
    input: MemoryEntryInput,
    signal: AbortSignal | undefined,
    now: Date,
    requireSemantic = false
  ): Promise<MemoryWriteResult> {
    return await this.retryMutation(signal, async (expectedRevision) => (
      await this.writeAutoEntry(input, { expectedRevision, signal, now, requireSemantic })
    ));
  }

  private async retryMutation<T>(
    signal: AbortSignal | undefined,
    operation: (expectedRevision: number) => Promise<T>
  ): Promise<T> {
    return await withFreshRevision(this.storage, signal, operation);
  }
}

interface SleepSimilarityCluster {
  entries: MemoryEntry[];
  maxSimilarity: number;
}

interface PersonMemory {
  name: string;
  fact: string;
}

function parsePersonMemory(summary: string): PersonMemory | undefined {
  const match = /^PERSON:\s*([^:\n]{1,120}):\s*(.{1,2000})$/su.exec(summary.trim());
  if (!match?.[1] || !match[2]?.trim()) return undefined;
  return { name: match[1].trim(), fact: match[2].trim() };
}

function sanitizePersonFileName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 80)
    .replace(/[._-]+$/gu, "");
}

function exactDuplicateGroups(entries: readonly MemoryEntry[]): MemoryEntry[][] {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    // 默认允许跨 userId namespace 去重；user/workspace origin 是同一份全局库上的来源视图，
    // 因此完全重复的事实也不应被来源边界挡住。
    const key = memoryEntryExactKey(entry);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.values()].filter((group) => group.length > 1);
}

function buildSimilarityClusters(
  entries: readonly MemoryEntry[],
  pairs: readonly MemorySimilarityPair[],
  minimumSimilarity: number
): SleepSimilarityCluster[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const parent = new Map(entries.map((entry) => [entry.id, entry.id]));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (current === undefined || current === id) return current ?? id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const usablePairs: Array<{ leftId: string; rightId: string; similarity: number }> = [];
  for (const pair of pairs) {
    if (!Number.isFinite(pair.similarity) || pair.similarity < minimumSimilarity || pair.leftId === pair.rightId) continue;
    const left = entriesById.get(pair.leftId);
    const right = entriesById.get(pair.rightId);
    if (!left || !right || sleepNamespace(left) !== sleepNamespace(right)) continue;
    usablePairs.push(pair);
    union(pair.leftId, pair.rightId);
  }
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const root = find(entry.id);
    grouped.set(root, [...(grouped.get(root) ?? []), entry]);
  }
  const maxByRoot = new Map<string, number>();
  for (const pair of usablePairs) {
    const root = find(pair.leftId);
    maxByRoot.set(root, Math.max(maxByRoot.get(root) ?? -1, pair.similarity));
  }
  return [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([root, group]) => ({
      entries: group,
      maxSimilarity: maxByRoot.get(root) ?? -1
    }))
    .sort((left, right) => (
      right.maxSimilarity - left.maxSimilarity
      || compareSleepEntries(left.entries[0]!, right.entries[0]!)
    ));
}

function selectSleepSurvivor(entries: readonly MemoryEntry[]): MemoryEntry {
  return [...entries].sort((left, right) => (
    durabilityRank(right) - durabilityRank(left)
    || memoryOriginRank(right) - memoryOriginRank(left)
    || right.importance - left.importance
    || Math.min(right.recallCount, 10_000) - Math.min(left.recallCount, 10_000)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id)
  ))[0]!;
}

function compareSleepEntries(left: MemoryEntry, right: MemoryEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function durabilityRank(entry: MemoryEntry): number {
  return entry.durability === "permanent" ? 1 : 0;
}

function memoryOriginRank(entry: MemoryEntry): number {
  return entry.origin.kind === "user" ? 1 : 0;
}

function sleepNamespace(entry: MemoryEntry): string {
  return entry.origin.kind === "user" ? "user" : `workspace:${entry.origin.workspaceId}`;
}

function isExpiredTemporaryMemory(entry: MemoryEntry, now: Date, ttlDays: number): boolean {
  if (entry.durability !== "temporary") return false;
  const nowMs = now.getTime();
  const expiresAt = entry.expiresAt === undefined ? Number.NaN : Date.parse(entry.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt < nowMs) return true;
  if (entry.recallCount !== 0) return false;
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt)
    && createdAt + Math.max(1, Math.trunc(ttlDays)) * 86_400_000 < nowMs;
}

function emptySleepMergeDecision(): SleepMergeDecision {
  return { delete: [], synthesize: [] };
}

function normalizeSleepSynthesis(value: unknown): SleepMergeDecision["synthesize"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return undefined;
  const timestamp = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
  return {
    content,
    durability: record.durability === "temporary" ? "temporary" : "permanent",
    expiresAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
  };
}

function clampSimilarity(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeSleepBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function notifySleepIndexRebuild(derivedIndex: MemoryDerivedIndexSink | undefined): void {
  try {
    derivedIndex?.requestRebuild?.();
  } catch {
    // 派生索引通知失败不能回滚已经提交的 SQLite 归档。
  }
}

/**
 * 共享的 CAS 重试包装：重读 storeRevision 后重放操作，最多 4 次。
 * 写入路径的幂等性由存储层去重保证，因此重放是安全的。
 */
export async function withFreshRevision<T>(
  memory: Pick<LocalMemory, "getOverview"> | { getOverview(options?: MemoryReadOptions): Promise<MemoryOverview> },
  signal: AbortSignal | undefined,
  operation: (expectedRevision: number) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    signal?.throwIfAborted();
    const overview = await memory.getOverview({ signal });
    try {
      return await operation(overview.storeRevision);
    } catch (error) {
      if (!(error instanceof MemoryRevisionConflictError) || attempt === 3) throw error;
    }
  }
  throw new Error("Unable to mutate memory after repeated revision conflicts.");
}

export function formatMemoryMatches(matches: Array<{ topic: string; excerpt: string }>): string {
  if (!matches.length) return "";
  // Keep the display label separate from the embedding text: the vector uses
  // only the memory summary, while the prompt still benefits from an explicit
  // field marker when several recalled entries are shown together.
  return [
    "## Relevant Memories",
    ...matches.map((match) => `- ${match.topic}: Summary: ${match.excerpt}`)
  ].join("\n");
}

function formatMemoryExtractionMessages(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  let remaining = 8_000;
  for (const message of messages) {
    if (remaining <= 0) break;
    const text = redactSecrets(messageText(message)).trim();
    if (!text) continue;
    const label = message.role === "toolResult" ? "tool" : message.role;
    const bounded = text.slice(0, Math.min(2_000, remaining));
    lines.push(`${label}: ${bounded}`);
    remaining -= bounded.length;
  }
  return lines.join("\n") || "(no textual messages)";
}

export { redactSecrets, MemoryRevisionConflictError };
export type {
  MemoryBudgetOmission,
  MemoryArchiveReason,
  MemoryClearResult,
  MemoryBulkArchiveResult,
  MemoryDeleteResult,
  MemoryEntriesResult,
  MemoryEntry,
  MemoryEntryInput,
  MemoryDurability,
  MemoryKind,
  MemoryLineage,
  MemoryLineageSource,
  MemoryListOptions,
  MemoryMaintenanceOptions,
  MemoryMaintenanceResult,
  MemoryMaintenanceStatus,
  MemoryMatch,
  MemoryMutationOptions,
  MemoryOmissionReason,
  MemoryOverview,
  MemoryReadOptions,
  MemoryRecallOmission,
  MemoryRecallReport,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySimilarityPair,
  MemoryWriteResult
} from "./memoryTypes.js";
