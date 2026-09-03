/**
 * 自动记忆召回：可选查询改写后进行向量余弦 topK；向量不可用时保持为空。
 *
 * SQLite/LocalMemory 负责事实源；向量索引只提供可丢弃的语义排名。向量不可用、指纹或
 * 内容哈希不匹配时自动召回 fail closed，绝不把词法猜测或其他项目内容带进上下文；手动
 * `/memory search` 仍然保留词法 fallback。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbeddingModelRuntime, EmbeddingThresholds } from "../../llm/embedding/types.js";
import { redactSecrets } from "../../utils/secrets.js";
import { perfNow, recordPerfPhase } from "../../observability/perfTiming.js";
import { memoryVectorContentHash, type MemoryVectorIndexStatus, type MemoryVectorSearchResult } from "./MemoryVectorIndex.js";
import type {
  MemoryEntriesResult,
  MemoryEntry,
  MemoryMatch,
  MemoryOriginCounts,
  MemoryOriginSelector,
  MemoryRecallReport,
  MemorySearchOptions,
  MemorySearchResult
} from "./memoryTypes.js";

const lexicalWeight = 1;
const queryRewriteTimeoutMs = 3_000;
const currentWorkspaceBoost = 1.1;
const userMemoryBoost = 1.05;
const defaultRecallMaxChars = 12_000;
const maximumSemanticCandidates = 100;

export interface AutomaticMemoryStore {
  listMemoryEntries(options?: { origins?: MemoryOriginSelector[]; includeArchived?: boolean; signal?: AbortSignal }): Promise<MemoryEntriesResult>;
  search(query: string, paths: string[], options?: MemorySearchOptions): Promise<MemorySearchResult>;
  recordRecallUsage(ids: string[], options?: { signal?: AbortSignal; now?: Date }): Promise<void>;
}

export interface MemoryVectorSearchIndex {
  status(): MemoryVectorIndexStatus;
  search(
    query: ArrayLike<number>,
    options: {
      modelFingerprint: string;
      limit?: number;
      minimumSimilarity?: number;
      entryIds?: ReadonlySet<string>;
    }
  ): MemoryVectorSearchResult[];
  close?(): void;
}

export interface HybridMemoryRetrieverOptions {
  localMemory: AutomaticMemoryStore;
  workspaceRoot: string;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  getReadOnlyVectorIndex: () => MemoryVectorSearchIndex | undefined;
  getThresholds: (fingerprint: string, recommended: EmbeddingThresholds) => EmbeddingThresholds;
  rewriteQuery?: (query: string, signal?: AbortSignal) => Promise<string>;
  queryRewriteEnabled?: () => boolean;
  now?: () => Date;
  closeVectorIndex?: boolean;
}

export interface HybridMemoryRankingInput {
  entries: readonly MemoryEntry[];
  currentWorkspaceId: string;
  lexicalRankings: readonly (readonly string[])[];
  vectorRanking: readonly { entryId: string; similarity: number }[];
  semanticAvailable: boolean;
  /** 自动召回会禁止无向量依据的跨项目结果；手动搜索允许用户浏览整个筛选范围。 */
  automatic?: boolean;
  paths?: ReadonlyMap<string, string>;
  limit: number;
  maxChars: number;
}

/**
 * AgentSession 与 Runtime Host 重建索引必须使用同一段文本和同一哈希。
 * Embedding 只接收记忆 summary；它就是这段事实正文。
 * 标题、topic、来源和展示字段不应污染语义向量，也不应因为元数据编辑触发重建。
 */
export function memoryEntryEmbeddingText(entry: MemoryEntry): string {
  return entry.summary;
}

export function memoryEntryContentHash(entry: MemoryEntry): string {
  return memoryVectorContentHash(memoryEntryEmbeddingText(entry));
}

export class HybridMemoryRetriever {
  private readonly currentWorkspaceId: Promise<string>;
  private vectorIndex: MemoryVectorSearchIndex | undefined;

  constructor(private readonly options: HybridMemoryRetrieverOptions) {
    this.currentWorkspaceId = canonicalWorkspaceId(options.workspaceRoot);
  }

  async retrieve(
    query: string,
    paths: string[],
    options: {
      limit: number;
      maxChars?: number;
      signal?: AbortSignal;
      origins?: MemoryOriginSelector[];
      includeArchived?: boolean;
      automatic?: boolean;
    }
  ): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const origins = options.origins ?? (options.automatic === false
      ? ["all"]
      : ["user", "current_workspace"]);
    const listPerfStartedAt = perfNow();
    const snapshot = await this.options.localMemory.listMemoryEntries({
      origins,
      includeArchived: options.includeArchived,
      signal: options.signal
    });
    recordPerfPhase("memory.listEntries", listPerfStartedAt);
    if (!snapshot.entries.length || options.limit < 1) return emptySearchResult(snapshot);

    const safeQuery = redactSecrets(query).trim();
    const rewritten = await this.rewrite(safeQuery, snapshot.entries, options.signal);
    const matchPaths = new Map(Object.entries(snapshot.paths ?? {}));
    const lexicalRankings: string[][] = [];
    if (options.automatic !== true) {
      const lexicalQueries = [...new Set([safeQuery, rewritten].filter(Boolean))];
      if (!lexicalQueries.length && paths.length) lexicalQueries.push("");
      const lexicalPerfStartedAt = perfNow();
      const lexicalResults = await Promise.all(lexicalQueries.map(async (value) => (
        await this.options.localMemory.search(value, paths, {
          origins,
          includeArchived: options.includeArchived,
          limit: snapshot.entries.length,
          signal: options.signal
        })
      )));
      recordPerfPhase("memory.lexical", lexicalPerfStartedAt);
      const exactId = snapshot.entries.find(({ id }) => id === safeQuery)?.id;
      for (const result of lexicalResults) {
        const ids = result.matches.map(({ entry }) => entry.id);
        lexicalRankings.push(exactId === undefined ? ids : [exactId, ...ids.filter((id) => id !== exactId)]);
        for (const match of result.matches) if (!matchPaths.has(match.entry.id)) matchPaths.set(match.entry.id, match.path);
      }
    }

    const semanticPerfStartedAt = perfNow();
    const semantic = await this.semanticSearch(rewritten || safeQuery, snapshot.entries, options.signal);
    recordPerfPhase("memory.semantic", semanticPerfStartedAt, { available: semantic.available });
    return rankHybridMemory({
      entries: snapshot.entries,
      currentWorkspaceId: await this.currentWorkspaceId,
      lexicalRankings,
      vectorRanking: semantic.results,
      semanticAvailable: semantic.available,
      automatic: options.automatic,
      paths: matchPaths,
      limit: options.limit,
      maxChars: options.maxChars ?? defaultRecallMaxChars
    }, snapshot.storeRevision);
  }

  private async rewrite(query: string, entries: readonly MemoryEntry[], signal?: AbortSignal): Promise<string> {
    if (!query || !this.options.rewriteQuery || this.options.queryRewriteEnabled?.() === false) return query;
    if (entries.some(({ id }) => id === query)) return query;
    const timeout = AbortSignal.timeout(queryRewriteTimeoutMs);
    const rewriteSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const rewritten = (await raceWithAbort(this.options.rewriteQuery(query, rewriteSignal), rewriteSignal))
        .trim().replace(/\s+/gu, " ").slice(0, 1_000);
      return rewritten || query;
    } catch {
      signal?.throwIfAborted();
      return query;
    }
  }

  async recordRecallUsage(ids: string[], options: { signal?: AbortSignal; now?: Date } = {}): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    await this.options.localMemory.recordRecallUsage(uniqueIds, options);
  }

  close(): void {
    if (this.options.closeVectorIndex === false) return;
    this.vectorIndex?.close?.();
    this.vectorIndex = undefined;
  }

  private async semanticSearch(
    query: string,
    entries: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<{ available: boolean; results: MemoryVectorSearchResult[] }> {
    if (!query) return { available: false, results: [] };
    try {
      const runtime = await this.options.getEmbeddingRuntime();
      if (!runtime) return { available: false, results: [] };
      signal?.throwIfAborted();
      const embedded = await runtime.embed({ texts: [query], inputType: "query", signal });
      const queryVector = embedded.embeddings[0];
      if (!queryVector || embedded.embeddings.length !== 1 || embedded.fingerprint !== runtime.descriptor.fingerprint) {
        return { available: false, results: [] };
      }
      const index = this.vectorIndex ?? this.options.getReadOnlyVectorIndex();
      if (!index) return { available: false, results: [] };
      this.vectorIndex = index;
      const active = index.status().active;
      if (
        !active
        || active.modelFingerprint !== runtime.descriptor.fingerprint
        || active.dimensions !== embedded.dimensions
        || active.vectorCount < 1
      ) return { available: false, results: [] };

      const currentWorkspaceId = await this.currentWorkspaceId;
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));
      const thresholds = this.options.getThresholds(runtime.descriptor.fingerprint, runtime.descriptor.recommendedThresholds);
      const candidates = index.search(queryVector, {
        modelFingerprint: runtime.descriptor.fingerprint,
        limit: Math.min(maximumSemanticCandidates, entries.length),
        minimumSimilarity: -1,
        entryIds: new Set(entryById.keys())
      });
      return {
        available: true,
        results: candidates.filter((candidate) => {
          const entry = entryById.get(candidate.entryId);
          if (!entry || candidate.contentHash !== memoryEntryContentHash(entry)) return false;
          const otherWorkspace = entry.origin.kind === "workspace" && entry.origin.workspaceId !== currentWorkspaceId;
          return candidate.similarity >= (otherWorkspace ? thresholds.crossWorkspace : thresholds.currentWorkspace);
        })
      };
    } catch {
      signal?.throwIfAborted();
      return { available: false, results: [] };
    }
  }
}

/** 纯排序函数不访问磁盘或模型，便于锁定跨项目门禁、权重和预算行为。 */
export function rankHybridMemory(input: HybridMemoryRankingInput, storeRevision = 0): MemorySearchResult {
  const entries = new Map(input.entries.map((entry) => [entry.id, entry]));
  const scores = new Map<string, number>();
  const add = (id: string, score: number): void => {
    const entry = entries.get(id);
    if (!entry || (input.automatic !== false
      && !automaticOriginAllowed(entry, input.currentWorkspaceId))) return;
    scores.set(id, (scores.get(id) ?? 0) + score);
  };

  // 自动模式只接受通过阈值的向量结果；手动搜索才在 embedding 不可用时回退词法。
  // 过滤必须发生在分支选择前，否则跨 workspace 向量被丢弃后会错误触发词法回退。
  const allowedVectorRanking = input.vectorRanking.filter((candidate) => {
    const entry = entries.get(candidate.entryId);
    return entry !== undefined && (input.automatic === false
      || automaticOriginAllowed(entry, input.currentWorkspaceId));
  });
  if (input.semanticAvailable && allowedVectorRanking.length > 0) {
    for (const candidate of allowedVectorRanking) add(candidate.entryId, candidate.similarity);
  } else if (input.automatic === true) {
    return emptyRankedMemoryResult(storeRevision);
  } else {
    const lexicalDivisor = Math.max(1, input.lexicalRankings.length);
    for (const ranking of input.lexicalRankings) {
      for (const [index, id] of ranking.entries()) {
        add(id, lexicalWeight / lexicalDivisor / (index + 1));
      }
    }
  }

  const ranked = [...scores].map(([id, score]) => {
    const entry = entries.get(id)!;
    return {
      entry,
      score: score * originBoost(entry, input.currentWorkspaceId)
    };
  }).sort((left, right) => (
    right.score - left.score
    || right.entry.importance - left.entry.importance
    || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
    || left.entry.id.localeCompare(right.entry.id)
  ));

  const included = emptyOriginCounts();
  const trimmed = emptyOriginCounts();
  const omitted: MemoryRecallReport["omitted"] = [];
  const matches: MemoryMatch[] = [];
  let usedChars = 0;
  let budgetOmitted = 0;
  for (const { entry, score } of ranked) {
    const bucket = originBucket(entry, input.currentWorkspaceId);
    const excerpt = memoryEntryEmbeddingText(entry);
    const chars = entry.topic.length + excerpt.length + 5;
    const reason = matches.length >= input.limit
      ? "entry_limit" as const
      : usedChars + chars > Math.max(0, input.maxChars)
        ? "budget" as const
        : undefined;
    if (reason) {
      trimmed[bucket] += 1;
      omitted.push({ origin: entry.origin, id: entry.id, reason });
      if (reason === "budget") budgetOmitted += 1;
      continue;
    }
    usedChars += chars;
    included[bucket] += 1;
    matches.push({
      entry,
      originBucket: bucket,
      topic: entry.topic,
      path: input.paths?.get(entry.id) ?? "memory://" + entry.id,
      excerpt,
      score
    });
  }

  return {
    matches,
    storeRevision,
    report: {
      origins: { included, trimmed },
      omitted,
      budgetOmission: budgetOmitted > 0
        ? { maxChars: Math.max(0, input.maxChars), usedChars, omitted: budgetOmitted }
        : undefined
    }
  };
}

function emptyRankedMemoryResult(storeRevision: number): MemorySearchResult {
  const origins = emptyOriginCounts();
  return {
    matches: [],
    storeRevision,
    report: {
      origins: { included: origins, trimmed: { ...origins } },
      omitted: [],
      budgetOmission: undefined
    }
  };
}

function automaticOriginAllowed(
  entry: MemoryEntry,
  currentWorkspaceId: string
): boolean {
  return entry.origin.kind === "user" || entry.origin.workspaceId === currentWorkspaceId;
}

function originBoost(entry: MemoryEntry, currentWorkspaceId: string): number {
  if (entry.origin.kind === "user") return userMemoryBoost;
  return entry.origin.workspaceId === currentWorkspaceId ? currentWorkspaceBoost : 1;
}

function originBucket(entry: MemoryEntry, currentWorkspaceId: string): keyof MemoryOriginCounts {
  if (entry.origin.kind === "user") return "user";
  return entry.origin.workspaceId === currentWorkspaceId ? "currentWorkspace" : "otherWorkspaces";
}

function emptySearchResult(snapshot: MemoryEntriesResult): MemorySearchResult {
  const report = emptyRecallReport();
  return {
    matches: [],
    storeRevision: snapshot.storeRevision,
    report
  };
}

function emptyRecallReport(): MemoryRecallReport {
  return {
    origins: { included: emptyOriginCounts(), trimmed: emptyOriginCounts() },
    omitted: [],
    budgetOmission: undefined
  };
}

function emptyOriginCounts(): MemoryOriginCounts {
  return { user: 0, currentWorkspace: 0, otherWorkspaces: 0 };
}

async function canonicalWorkspaceId(workspaceRoot: string): Promise<string> {
  const canonical = await fs.realpath(path.resolve(workspaceRoot));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
