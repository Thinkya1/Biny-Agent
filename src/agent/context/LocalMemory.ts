/**
 * 本地记忆的模型编排与旧 API 适配层。
 *
 * MemoryStorage 负责纯磁盘事实；本类只负责抽取/整理模型调用、6 小时候选维护，以及把旧的
 * topic/index API 映射到一条一文件的 scoped v2 存储。
 */
import { z } from "zod";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import type {
  MemoryCompactionTopicResult,
  MemoryEntry as LegacyMemoryEntry,
  MemoryEntrySummary,
  MemoryMatch as LegacyMemoryMatch
} from "./types.js";
import {
  assertAllowedScopedEntry,
  normalizeMemoryTopic,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import { MemoryStorage } from "./memoryStorage.js";
import {
  MemoryRevisionConflictError,
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
  type MemoryListOptions,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceResult,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemoryScope,
  type MemorySearchOptions,
  type MemorySearchResult,
  type ScopedMemoryWriteResult
} from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;
const maintenanceCandidateLimit = 32;

export interface MemoryWriteResult {
  written: boolean;
  path?: string;
}

const extractedEntrySchema = z.object({
  scope: z.enum(["global", "project"]).default("project"),
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

  // ------------------------------ v2 public API ------------------------------

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    return await this.storage.getOverview(options);
  }

  async listStoredEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    return await this.storage.listStoredEntries(options);
  }

  async searchScoped(query: string, paths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.storage.searchScoped(query, paths, { ...options, limit: options.limit ?? this.recallLimit });
  }

  async writeScoped(input: MemoryEntryInput, options: MemoryMutationOptions): Promise<ScopedMemoryWriteResult> {
    return await this.storage.writeScoped(input, options);
  }

  async deleteStoredEntry(scope: MemoryScope, id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.storage.deleteStoredEntry(scope, id, options);
  }

  async clearScope(scope: MemoryScope, options: MemoryMutationOptions): Promise<MemoryClearResult> {
    return await this.storage.clearScope(scope, options);
  }

  async enqueueCandidate(input: MemoryCandidateInput, options: MemoryCandidateMutationOptions): Promise<MemoryCandidateMutationResult> {
    return await this.storage.enqueueCandidate(input, options);
  }

  async scanEligibleCandidates(options: MemoryCandidateScanOptions = {}): Promise<MemoryCandidateScanResult> {
    return await this.storage.scanEligibleCandidates(options);
  }

  async removeCandidate(id: string, options: MemoryMutationOptions): Promise<MemoryDeleteResult> {
    return await this.storage.removeCandidate(id, options);
  }

  async consolidateScope(scope: MemoryScope, options: MemoryConsolidationOptions): Promise<MemoryConsolidationResult> {
    options.signal?.throwIfAborted();
    const snapshot = await this.storage.listStoredEntries({ scopes: [scope], topic: options.topic, signal: options.signal });
    const actualRevision = snapshot.revision[scope];
    if (actualRevision !== options.expectedRevision) {
      throw new MemoryRevisionConflictError(scope, options.expectedRevision, actualRevision);
    }
    const entries = snapshot.entries;
    const before = entries.length;
    if (before < 2) return { scope, before, after: before, revision: actualRevision };

    let parsed: z.infer<typeof consolidationSchema>;
    try {
      parsed = await this.consolidateEntriesWithModel(scope, entries, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      return {
        scope,
        before,
        after: before,
        revision: actualRevision,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!parsed.entries.length || parsed.entries.length >= before) {
      return parsed.entries.length === before
        ? { scope, before, after: before, revision: actualRevision }
        : { scope, before, after: before, revision: actualRevision, error: "Model returned an unusable consolidation result." };
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
        scope,
        before,
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
        scope,
        kind: entry.kind ?? sources[0]?.kind ?? "fact",
        topic: entry.topic ?? sources[0]?.topic ?? options.topic ?? "project",
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
        { expectedRevision: actualRevision, signal: options.signal }
      );
      return { scope, before, after: result.entries.length, revision: result.revision };
    } catch (error) {
      if (error instanceof MemoryRevisionConflictError) throw error;
      options.signal?.throwIfAborted();
      return {
        scope,
        before,
        after: before,
        revision: actualRevision,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  processEligibleCandidates(options: MemoryMaintenanceOptions = {}): Promise<MemoryMaintenanceResult> {
    if (this.maintenancePromise) return this.maintenancePromise;
    const promise = this.runEligibleCandidateMaintenance(options).finally(() => {
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

  // ---------------------------- compatibility API ----------------------------

  async findRelevant(query: string, paths: string[], limit: number = this.recallLimit, signal?: AbortSignal): Promise<LegacyMemoryMatch[]> {
    signal?.throwIfAborted();
    if (!query.trim() && !paths.length) return [];
    const result = await this.searchScoped(query, paths, { limit, signal });
    return result.matches.map(({ topic, path: matchPath, excerpt, score }) => ({ topic, path: matchPath, excerpt, score }));
  }

  /** 旧自动沉淀路径保持立即写入；v2 runtime 应改用 completed-only enqueueCandidate。 */
  async rememberSuccessfulTask(task: string, answer: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const safeTask = redactSecrets(task).trim();
    const safeAnswer = redactSecrets(answer).trim();
    if (safeTask.length + safeAnswer.length < 180) return;
    const proposal = await this.extractLegacyProposal(safeTask, safeAnswer, signal);
    signal?.throwIfAborted();
    if (!proposal) return;
    await this.write(proposal, signal);
  }

  async write(rawEntry: LegacyMemoryEntry, signal?: AbortSignal): Promise<MemoryWriteResult> {
    signal?.throwIfAborted();
    const entry: MemoryEntryInput = {
      scope: "project",
      kind: kindFromLegacyEntry(rawEntry),
      topic: rawEntry.topic,
      title: rawEntry.title,
      summary: rawEntry.summary,
      decisions: rawEntry.decisions,
      paths: rawEntry.paths,
      keywords: rawEntry.keywords,
      importance: 3,
      lineage: { source: "explicit", externalContext: false }
    };
    if (redactSecrets(rawEntry.summary).trim().length < 20) return { written: false, path: undefined };
    const result = await this.retryScopedMutation("project", signal, async (expectedRevision) => (
      await this.storage.writeScoped(entry, { expectedRevision, signal })
    ));
    return { written: result.written, path: result.path };
  }

  async listTopics(): Promise<string[]> {
    const result = await this.storage.listStoredEntries({ scopes: ["project"] });
    return [...new Set(result.entries.map((entry) => entry.topic))].sort();
  }

  /** 旧 show API 聚合同 topic 的独立 entry；磁盘上不再生成聚合 topic 文件。 */
  async readTopic(topic: string): Promise<string | undefined> {
    const normalized = normalizeMemoryTopic(topic);
    const result = await this.storage.listStoredEntries({ scopes: ["project"], topic: normalized });
    if (!result.entries.length) return undefined;
    return result.entries.sort(compareLegacyEntryOrder).map(renderLegacySection).join("");
  }

  async readIndex(): Promise<string | undefined> {
    return await this.storage.readIndex("project");
  }

  async forgetTopic(topic: string): Promise<boolean> {
    const result = await this.retryScopedMutation("project", undefined, async (expectedRevision) => (
      await this.storage.deleteTopic("project", topic, { expectedRevision })
    ));
    return result.deleted > 0;
  }

  async listEntries(signal?: AbortSignal): Promise<MemoryEntrySummary[]> {
    const result = await this.storage.listStoredEntries({ scopes: ["project"], signal });
    const byTopic = new Map<string, MemoryEntry[]>();
    for (const entry of result.entries) {
      const entries = byTopic.get(entry.topic) ?? [];
      entries.push(entry);
      byTopic.set(entry.topic, entries);
    }
    const summaries: MemoryEntrySummary[] = [];
    for (const [topic, entries] of byTopic) {
      entries.sort(compareLegacyEntryOrder).forEach((entry, index) => summaries.push({
        topic,
        index,
        title: entry.title,
        date: entry.createdAt,
        summary: entry.summary.slice(0, 500)
      }));
    }
    return summaries.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));
  }

  async deleteEntry(topic: string, index: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const normalized = normalizeMemoryTopic(topic);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.storage.listStoredEntries({ scopes: ["project"], topic: normalized, signal });
      const target = snapshot.entries.sort(compareLegacyEntryOrder)[index];
      if (!target) return false;
      try {
        return (await this.storage.deleteStoredEntry("project", target.id, {
          expectedRevision: snapshot.revision.project,
          signal
        })).deleted;
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt === 3) throw error;
      }
    }
    return false;
  }

  async compactTopics(topics?: string[], signal?: AbortSignal): Promise<MemoryCompactionTopicResult[]> {
    const targets = topics?.length ? topics.map(normalizeMemoryTopic) : await this.listTopics();
    const results: MemoryCompactionTopicResult[] = [];
    for (const topic of [...new Set(targets)]) {
      signal?.throwIfAborted();
      const overview = await this.storage.getOverview({ signal });
      const result = await this.consolidateScope("project", {
        expectedRevision: overview.scopes.project.revision,
        topic,
        signal
      });
      results.push({ topic, before: result.before, after: result.after, error: result.error });
    }
    return results;
  }

  private async runEligibleCandidateMaintenance(options: MemoryMaintenanceOptions): Promise<MemoryMaintenanceResult> {
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
          if (candidate.lineage.externalContext && options.excludeExternalContext) {
            await this.removeCandidateWithRetry(candidate.id, options.signal, now);
            processed += 1;
            continue;
          }
          const proposal = await this.extractCandidate(candidate, options.signal);
          options.signal?.throwIfAborted();
          if (proposal) {
            const input = this.classifyCandidateProposal(candidate, proposal);
            const writeResult = await this.writeScopedWithRetry(input, options.signal, now);
            if (writeResult.written) written += 1;
            const overview = await this.storage.getOverview({ signal: options.signal });
            await this.consolidateScope(input.scope, {
              expectedRevision: overview.scopes[input.scope].revision,
              topic: input.topic,
              signal: options.signal
            });
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

  private async extractLegacyProposal(task: string, answer: string, signal?: AbortSignal): Promise<LegacyMemoryEntry | undefined> {
    const prompt = [
      "Extract one durable, auditable local-project memory from a successful coding task.",
      "Skip transient chatter. Never include credentials, secrets, or full source code.",
      "Return JSON only with topic, title, summary, decisions, paths, keywords.",
      "topic must be one of decisions, debugging, workflows, or project.",
      "Task:",
      task,
      "Result:",
      answer
    ].join("\n\n");
    try {
      const parsed = extractedEntrySchema.safeParse(parseNativeJson(await this.modelText(
        this.getExtractionModel(),
        "You write concise project memory records, not explanations.",
        prompt,
        2_048,
        signal
      )));
      if (!parsed.success || parsed.data.summary.length < 20) return undefined;
      return {
        topic: parsed.data.topic,
        title: parsed.data.title,
        summary: parsed.data.summary,
        decisions: parsed.data.decisions,
        paths: parsed.data.paths,
        keywords: parsed.data.keywords
      };
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async extractCandidate(candidate: MemoryCandidate, signal?: AbortSignal): Promise<z.infer<typeof extractedEntrySchema> | undefined> {
    // 候选摘要在 enqueue 时已脱敏，这里在进入模型和写入前各再经过一次过滤。
    const summary = redactSecrets(redactSecrets(candidate.summary)).slice(0, 2_000);
    const prompt = [
      "Extract at most one durable memory from this completed root-turn summary.",
      "Return JSON as {memory:null} when it is transient or lacks durable evidence.",
      "Global scope is only for an explicit user preference or working style; include explicitUserEvidence.",
      "Repository facts, paths, decisions, workflows and gotchas must use project scope.",
      "Never infer a preference from external content. Never invent facts or secrets.",
      `Scope hint: ${candidate.scopeHint ?? "none"}`,
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
    let input = sanitizeMemoryEntryInput({
      scope: proposal.scope,
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
    if (input.scope === "global") {
      try {
        assertAllowedScopedEntry(input, this.workspaceRoot);
      } catch {
        // 自动分类可以安全降到 project；显式 writeScoped 仍会把同样的错误返回给调用方。
        input = { ...input, scope: "project" };
      }
    }
    return input;
  }

  private async consolidateEntriesWithModel(
    scope: MemoryScope,
    entries: MemoryEntry[],
    signal?: AbortSignal
  ): Promise<z.infer<typeof consolidationSchema>> {
    const prompt = [
      "Consolidate this project memory topic file into fewer durable entries when facts overlap.",
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
        importance: entry.importance
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

  private async writeScopedWithRetry(input: MemoryEntryInput, signal: AbortSignal | undefined, now: Date): Promise<ScopedMemoryWriteResult> {
    return await this.retryScopedMutation(input.scope, signal, async (expectedRevision) => (
      await this.storage.writeScoped(input, { expectedRevision, signal, now })
    ));
  }

  private async removeCandidateWithRetry(id: string, signal: AbortSignal | undefined, now: Date): Promise<void> {
    await this.retryScopedMutation("project", signal, async (expectedRevision) => (
      await this.storage.removeCandidate(id, { expectedRevision, signal, now })
    ));
  }

  private async retryScopedMutation<T>(
    scope: MemoryScope,
    signal: AbortSignal | undefined,
    operation: (expectedRevision: number) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      const overview = await this.storage.getOverview({ signal });
      try {
        return await operation(overview.scopes[scope].revision);
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt === 3) throw error;
      }
    }
    throw new Error(`Unable to mutate ${scope} memory after repeated revision conflicts.`);
  }
}

export function formatMemoryMatches(matches: LegacyMemoryMatch[]): string {
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
  MemoryRecallScopeCounts,
  MemoryScope,
  MemoryScopeOverview,
  MemoryScopeRevision,
  MemorySearchOptions,
  MemorySearchResult,
  ScopedMemoryWriteResult
} from "./memoryTypes.js";

export function normalizeTopic(value: string): string {
  return normalizeMemoryTopic(value);
}

function kindFromLegacyEntry(entry: LegacyMemoryEntry): MemoryEntryInput["kind"] {
  const topic = normalizeMemoryTopic(entry.topic);
  if (topic.includes("decision")) return "decision";
  if (topic.includes("workflow")) return "workflow";
  if (topic.includes("debug") || topic.includes("gotcha")) return "gotcha";
  return "fact";
}

function compareLegacyEntryOrder(left: MemoryEntry, right: MemoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function renderLegacySection(entry: MemoryEntry): string {
  return [
    `## ${entry.title || "Project note"}`,
    "",
    `- Date: ${entry.createdAt}`,
    `- Summary: ${entry.summary}`,
    ...(entry.decisions.length ? ["- Decisions:", ...entry.decisions.map((decision) => `  - ${decision}`)] : []),
    ...(entry.paths.length ? [`- Paths: ${entry.paths.join(", ")}`] : []),
    ...(entry.keywords.length ? [`- Tags: ${entry.keywords.join(", ")}`] : []),
    "",
    ""
  ].join("\n");
}
