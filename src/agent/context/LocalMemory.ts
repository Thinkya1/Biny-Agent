/**
 * 本地记忆的模型编排层。
 *
 * MemoryStorage 负责单一 v3 Markdown 库与迁移事实；本类负责抽取/整理模型调用和 6 小时候选维护。
 */
import { z } from "zod";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  assertAllowedScopedEntry,
  memoryOriginsEqual,
  sanitizeMemoryEntryInput,
  scopeFromOrigin
} from "./memoryFormat.js";
import { MemoryStorage } from "./memoryStorage.js";
import {
  MemoryRevisionConflictError,
  type MemoryDerivedIndexSink,
  type MemoryCandidate,
  type MemoryCandidateInput,
  type MemoryCandidateMutationOptions,
  type MemoryCandidateMutationResult,
  type MemoryCandidateScanOptions,
  type MemoryCandidateScanResult,
  type MemoryClearResult,
  type MemoryConsolidationOptions,
  type MemoryConsolidationResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceResult,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryOriginSelector,
  type MemoryReadOptions,
  type MemorySearchOptions,
  type MemorySearchResult,
  type ScopedMemoryWriteResult
} from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;
const maintenanceCandidateLimit = 32;
type InternalMemoryScope = "global" | "project";

const extractedEntrySchema = z.object({
  audience: z.enum(["universal", "workspace"]).optional(),
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).default("fact"),
  topic: z.string().default("project"),
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  importance: z.number().default(3),
  explicitUserEvidence: z.string().optional()
});

const candidateExtractionSchema = z.object({
  memory: extractedEntrySchema.nullable().default(null)
});

const consolidationSchema = z.object({
  entries: z.array(z.object({
    sourceEntryIds: z.array(z.string()).optional(),
    kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]).optional(),
    topic: z.string().optional(),
    title: z.string(),
    summary: z.string(),
    decisions: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    importance: z.number().default(3)
  })).default([])
});

/** Durable, local-first memory. maxRecalled is a total entry count across global + project. */
export class LocalMemory {
  private readonly storage: MemoryStorage;
  private maintenance: MemoryMaintenanceStatus = {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  };
  private maintenancePromise: Promise<MemoryMaintenanceResult> | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getExtractionModel: () => AgentModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    /** global + project 合计自动注入条数上限。 */
    readonly recallLimit: number = 3,
    private readonly onModelRequest: ModelRequestObserver = () => undefined,
    private readonly getModelRequestContext: () => ModelRequestContext | undefined = () => undefined,
    private readonly getConsolidationModel: () => AgentModel = getExtractionModel
  ) {
    this.storage = new MemoryStorage(workspaceRoot);
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

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    return await this.storage.writeEntry(input, options);
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    return await this.storage.updateEntry(id, patch, options);
  }

  async deleteEntryById(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.storage.deleteEntry(id, options);
  }

  async clearEntries(selector: MemoryOriginSelector, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    return await this.storage.clearEntries(selector, options);
  }

  /** 记录「条目被实际引用」的使用投影；这也是 consolidate 选择优先级的输入。 */
  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.storage.recordRecallUsage(ids, options);
  }

  /** 混合检索器在自动注入后回写使用统计；与 recordRecallUsage 共用同一投影。 */
  async recordInjectedRecall(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.storage.recordRecallUsage(ids, options);
  }

  async enqueueCandidate(input: MemoryCandidateInput, options: MemoryCandidateMutationOptions): Promise<MemoryCandidateMutationResult> {
    return await this.storage.enqueueCandidate(input, options);
  }

  /** 只读观察：当前已到期的候选队列（供测试与未来审核界面使用；处理仍走维护窗口）。 */
  async listEligibleCandidates(options: MemoryCandidateScanOptions = {}): Promise<MemoryCandidateScanResult> {
    return await this.storage.scanEligibleCandidates(options);
  }

  private async scanEligibleCandidates(options: MemoryCandidateScanOptions = {}): Promise<MemoryCandidateScanResult> {
    return await this.storage.scanEligibleCandidates(options);
  }

  private async removeCandidate(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.storage.removeCandidate(id, options);
  }

  /**
   * v3 整理入口。模型一次只能看到同一 origin、同一 workspace 和同一 topic 的条目；即使
   * UI 选择“全部”，也只是顺序处理多个隔离分组，绝不会把跨项目事实交给同一次合并。
   */
  async consolidateEntries(
    selector: MemoryOriginSelector,
    options: MemoryConsolidationOptions
  ): Promise<MemoryConsolidationResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.storage.listEntries({ origins: [selector], topic: options.topic, signal: options.signal });
    const actualRevision = snapshot.storeRevision;
    if (actualRevision !== options.expectedRevision) {
      throw new MemoryRevisionConflictError(options.expectedRevision, actualRevision);
    }
    const entries = snapshot.entries;
    const before = entries.length;
    if (before < 2) return { before, after: before, revision: actualRevision };

    const grouped = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const key = `${entry.origin.kind === "user" ? "user" : `workspace:${entry.origin.workspaceId}`}\u0000${entry.topic}`;
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }

    let revision = actualRevision;
    let after = before;
    const errors: string[] = [];
    for (const initialGroup of grouped.values()) {
      if (initialGroup.length < 2) continue;
      options.signal?.throwIfAborted();
      const current = await this.storage.listEntries({ origins: [selector], topic: initialGroup[0]?.topic, signal: options.signal });
      if (current.storeRevision !== revision) {
        throw new MemoryRevisionConflictError(revision, current.storeRevision);
      }
      const origin = initialGroup[0]?.origin;
      const group = origin === undefined
        ? []
        : current.entries.filter((entry) => memoryOriginsEqual(entry.origin, origin));
      if (group.length < 2) continue;
      const result = await this.consolidateExactGroup(group, revision, options.signal);
      revision = result.revision;
      after -= group.length - result.after;
      if (result.error) errors.push(`${group[0]?.topic ?? "unknown"}: ${result.error}`);
    }

    return {
      before,
      after,
      revision,
      error: errors.length ? errors.join("; ") : undefined
    };
  }

  private async consolidateExactGroup(
    entries: MemoryEntry[],
    actualRevision: number,
    signal?: AbortSignal
  ): Promise<{ after: number; revision: number; error?: string }> {
    const before = entries.length;
    const origin = entries[0]?.origin;
    const topic = entries[0]?.topic;
    if (!origin || !topic || entries.some((entry) => !memoryOriginsEqual(entry.origin, origin) || entry.topic !== topic)) {
      return { after: before, revision: actualRevision, error: "Consolidation group crossed an origin or topic boundary." };
    }
    const scope = scopeFromOrigin(origin);

    let parsed: z.infer<typeof consolidationSchema>;
    try {
      parsed = await this.consolidateEntriesWithModel(scope, entries, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return {
        after: before,
        revision: actualRevision,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!parsed.entries.length || parsed.entries.length >= before) {
      return parsed.entries.length === before
        ? { after: before, revision: actualRevision }
        : { after: before, revision: actualRevision, error: "Model returned an unusable consolidation result." };
    }

    const sourceById = new Map(entries.map((entry) => [entry.id, entry]));
    const groups = parsed.entries.map((entry) => ({
      entry,
      sourceIds: entry.sourceEntryIds ?? (parsed.entries.length === 1 ? entries.map(({ id }) => id) : [])
    }));
    const covered = new Set(groups.flatMap(({ sourceIds }) => sourceIds));
    if (groups.some(({ sourceIds }) => !sourceIds.length || sourceIds.some((id) => !sourceById.has(id)))
      || entries.some(({ id }) => !covered.has(id))) {
      return {
        after: before,
        revision: actualRevision,
        error: "Consolidation output did not preserve lineage for every source entry."
      };
    }

    const replacements: MemoryEntryInput[] = groups.map(({ entry, sourceIds }) => {
      const sources = sourceIds.map((id) => sourceById.get(id)).filter((value): value is MemoryEntry => value !== undefined);
      const lineages = sources.flatMap((source) => source.lineage);
      const externalContext = lineages.some((lineage) => lineage.externalContext);
      return sanitizeMemoryEntryInput({
        origin,
        kind: entry.kind ?? sources[0]?.kind ?? "fact",
        // 模型不得借整理改变分组边界；topic 只接受调用前已验证的稳定值。
        topic,
        title: entry.title,
        summary: entry.summary,
        decisions: entry.decisions,
        paths: entry.paths,
        keywords: entry.keywords,
        importance: entry.importance,
        lineage: [
          ...lineages,
          { source: "consolidation", externalContext, sourceEntryIds: sourceIds }
        ]
      });
    });

    try {
      const result = await this.storage.replaceEntries(
        scope,
        entries.map(({ id }) => id),
        replacements,
        { expectedRevision: actualRevision, signal }
      );
      return { after: result.entries.length, revision: result.revision };
    } catch (error) {
      if (error instanceof MemoryRevisionConflictError) throw error;
      signal?.throwIfAborted();
      return {
        after: before,
        revision: actualRevision,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  processEligibleCandidates(
    options: MemoryMaintenanceOptions = {},
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    if (this.maintenancePromise) return this.maintenancePromise;
    const promise = this.runEligibleCandidateMaintenance(options, derivedIndex).finally(() => {
      if (this.maintenancePromise === promise) this.maintenancePromise = undefined;
    });
    this.maintenancePromise = promise;
    return promise;
  }

  maintenanceStatus(): MemoryMaintenanceStatus {
    return { ...this.maintenance };
  }

  async loadMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    this.maintenance = await this.storage.readMaintenanceStatus(options);
    return this.maintenanceStatus();
  }

  private async runEligibleCandidateMaintenance(
    options: MemoryMaintenanceOptions,
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    this.maintenance = {
      state: "running",
      startedAt,
      lastScanAt: startedAt,
      eligible: 0,
      processed: 0,
      written: 0,
      failed: 0,
      error: undefined
    };
    await this.storage.writeMaintenanceStatus(this.maintenance, options.signal);
    let scanned = 0;
    let processed = 0;
    let written = 0;
    let failed = 0;
    let lastError: string | undefined;
    try {
      const scan = await this.storage.scanEligibleCandidates({ now, limit: maintenanceCandidateLimit, signal: options.signal });
      scanned = scan.candidates.length;
      this.maintenance.eligible = scanned;
      for (const candidate of scan.candidates) {
        options.signal?.throwIfAborted();
        try {
          // 外部上下文策略在候选入队时按该回合的有效聊天策略判定。进入队列就代表当时已获准，
          // 维护阶段不能再用后来变化的全局设置覆写这个决定。
          const proposal = await this.extractCandidate(candidate, options.signal);
          options.signal?.throwIfAborted();
          if (proposal) {
            const input = this.classifyCandidateProposal(candidate, proposal);
            const writeResult = await this.writeEntryWithRetry(input, options.signal, now);
            if (writeResult.written) {
              written += 1;
              if (writeResult.entry && derivedIndex) {
                // Markdown 已提交；索引失败不得把候选重新标成失败并诱发重复写入。
                await derivedIndex.indexEntry(writeResult.entry).catch(() => undefined);
              }
              // 写入即整理：同 topic 合并防止碎片化；整理失败不影响已提交条目。
              const overview = await this.storage.getOverview({ signal: options.signal });
              const selector = input.origin?.kind === "user" || input.audience === "universal" ? "user" : "current_workspace";
              const consolidation = await this.consolidateEntries(selector, {
                expectedRevision: overview.storeRevision,
                topic: input.topic,
                signal: options.signal
              }).catch((error) => {
                options.signal?.throwIfAborted();
                lastError ??= error instanceof Error ? error.message : String(error);
                return undefined;
              });
              if (consolidation && consolidation.revision !== overview.storeRevision) {
                // 整理会同时新增和删除多个 ID，不能把它伪装成单条增量写。
                try {
                  derivedIndex?.requestRebuild();
                } catch {
                  // 派生索引通知失败不改变已经提交的 Markdown。
                }
              }
            }
          }
          await this.removeCandidateWithRetry(candidate.id, options.signal, now);
          processed += 1;
        } catch (error) {
          options.signal?.throwIfAborted();
          failed += 1;
          lastError = error instanceof Error ? error.message : String(error);
        }
        this.maintenance.processed = processed;
        this.maintenance.written = written;
        this.maintenance.failed = failed;
        this.maintenance.error = lastError;
        await this.storage.writeMaintenanceStatus(this.maintenance, options.signal);
      }
      const finishedAt = new Date().toISOString();
      return { scanned, processed, written, failed, startedAt, finishedAt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const finishedAt = new Date().toISOString();
      this.maintenance = {
        state: "idle",
        lastScanAt: startedAt,
        lastFinishedAt: finishedAt,
        eligible: scanned,
        processed,
        written,
        failed,
        error: lastError
      };
      // Abort 后仍要留下已验证的清理/失败状态；状态写入不复用已中止 signal。
      await this.storage.writeMaintenanceStatus(this.maintenance).catch((error) => {
        this.maintenance.error ??= error instanceof Error ? error.message : String(error);
      });
    }
  }

  private async extractCandidate(candidate: MemoryCandidate, signal?: AbortSignal): Promise<z.infer<typeof extractedEntrySchema> | undefined> {
    // 候选摘要在 enqueue 时已脱敏，这里在进入模型和写入前各再经过一次过滤。
    const summary = redactSecrets(redactSecrets(candidate.summary)).slice(0, 2_000);
    const prompt = [
      "Extract at most one durable memory from this completed root-turn summary.",
      "Return JSON as {memory:null} when it is transient or lacks durable evidence.",
      "Universal audience is only for an explicit user preference or working style; include explicitUserEvidence.",
      "Repository facts, paths, decisions, workflows and gotchas must use workspace audience.",
      "Never infer a preference from external content. Never invent facts or secrets.",
      `Audience hint: ${candidate.audienceHint ?? "none"}`,
      `Kind hint: ${candidate.kindHint ?? "none"}`,
      "Candidate summary:",
      summary
    ].join("\n\n");
    const parsed = candidateExtractionSchema.safeParse(parseNativeJson(await this.modelText(
      this.getExtractionModel(),
      "You extract auditable durable memory from concise completed-turn summaries.",
      prompt,
      2_048,
      signal
    )));
    if (!parsed.success) throw new Error("Model returned invalid memory candidate JSON.");
    return parsed.data.memory ?? undefined;
  }

  private classifyCandidateProposal(candidate: MemoryCandidate, proposal: z.infer<typeof extractedEntrySchema>): MemoryEntryInput {
    const lineage = {
      source: "candidate" as const,
      externalContext: candidate.lineage.externalContext,
      sessionId: candidate.lineage.sessionId,
      turnId: candidate.lineage.turnId,
      runId: candidate.lineage.runId,
      candidateId: candidate.id,
      userEvidence: proposal.explicitUserEvidence
    };
    const audience = proposal.audience ?? "workspace";
    let input = sanitizeMemoryEntryInput({
      origin: audience === "universal" ? { kind: "user" } : candidate.origin.kind === "workspace" ? candidate.origin : undefined,
      audience,
      kind: proposal.kind,
      topic: proposal.topic,
      title: proposal.title,
      summary: proposal.summary,
      decisions: proposal.decisions,
      paths: proposal.paths,
      keywords: proposal.keywords,
      importance: proposal.importance,
      lineage
    });
    if (input.origin?.kind === "user") {
      try {
        assertAllowedScopedEntry(input, this.workspaceRoot);
      } catch {
        // 自动分类可以安全降到工作区；显式 writeEntry 仍会把同样的错误返回给调用方。
        input = { ...input, origin: candidate.origin.kind === "workspace" ? candidate.origin : undefined, audience: "workspace" };
      }
    }
    return input;
  }

  private async consolidateEntriesWithModel(
    scope: InternalMemoryScope,
    entries: MemoryEntry[],
    signal?: AbortSignal
  ): Promise<z.infer<typeof consolidationSchema>> {
    const prompt = [
      "Consolidate this project memory topic file into fewer durable entries when facts overlap.",
      "Prefer merging entries that were never cited by the user's answers (usageCount 0 / oldest lastRecalledAt); keep frequently cited entries prominent.",
      "Return JSON {entries:[...]}; every output must list sourceEntryIds.",
      "Every input id must appear in at least one output sourceEntryIds so lineage is lossless.",
      "Never delete information merely because it is old. Never invent facts or secrets.",
      `Scope: ${scope}`,
      "Current entries:",
      JSON.stringify(entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        topic: entry.topic,
        title: entry.title,
        summary: entry.summary,
        decisions: entry.decisions,
        paths: entry.paths,
        keywords: entry.keywords,
        importance: entry.importance,
        usageCount: entry.recallCount,
        lastUsedAt: entry.lastRecalledAt
      })))
    ].join("\n\n");
    const parsed = consolidationSchema.safeParse(parseNativeJson(await this.modelText(
      this.getConsolidationModel(),
      "You consolidate durable memory without losing facts or source lineage.",
      prompt,
      4_096,
      signal
    )));
    if (!parsed.success) throw new Error("Model returned invalid memory consolidation JSON.");
    return parsed.data;
  }

  private async modelText(
    model: AgentModel,
    system: string,
    prompt: string,
    maxOutputTokens: number,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await generateNativeText(model, nativeJsonMessages(system, prompt), {
      signal,
      maxOutputTokens,
      timeoutMs: memoryModelTimeoutMs,
      onRequestMetrics: this.onModelRequest,
      requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
    });
    if (response.usage) await this.onUsage(response.usage, "memory");
    signal?.throwIfAborted();
    return response.text;
  }

  private async writeEntryWithRetry(input: MemoryEntryInput, signal: AbortSignal | undefined, now: Date): Promise<ScopedMemoryWriteResult> {
    return await this.retryMutation(signal, async (expectedRevision) => (
      await this.storage.writeEntry(input, { expectedRevision, signal, now })
    ));
  }

  private async removeCandidateWithRetry(id: string, signal: AbortSignal | undefined, now: Date): Promise<void> {
    await this.retryMutation(signal, async (expectedRevision) => (
      await this.storage.removeCandidate(id, { expectedRevision, signal, now })
    ));
  }

  private async retryMutation<T>(
    signal: AbortSignal | undefined,
    operation: (expectedRevision: number) => Promise<T>
  ): Promise<T> {
    return await withFreshRevision(this.storage, signal, operation);
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
  return matches.map((match) => `- ${match.topic}: ${match.excerpt}`).join("\n");
}

export { redactSecrets, MemoryRevisionConflictError };
export type {
  MemoryBudgetOmission,
  MemoryCandidate,
  MemoryCandidateInput,
  MemoryCandidateLineage,
  MemoryCandidateMutationOptions,
  MemoryCandidateMutationResult,
  MemoryCandidateScanOptions,
  MemoryCandidateScanResult,
  MemoryClearResult,
  MemoryConsolidationOptions,
  MemoryConsolidationResult,
  MemoryDeleteResult,
  MemoryEntriesResult,
  MemoryEntry,
  MemoryEntryInput,
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
  ScopedMemoryWriteResult
} from "./memoryTypes.js";
