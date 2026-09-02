/**
 * activity_search_semantic 的业务实现：优先检索 OCR frame，再以 analysis 行作补充。
 *
 * 主检索对象是屏幕 OCR 文本；已分析 session 的 project+summary+topics+highlights
 * 作为 OCR 不足时的补充。每次调用先补当前指纹缺失的向量（本地模型批量嵌入，失败只留
 * 待下次），再嵌入查询做 cosine top N。
 *
 * 固定使用本地 multilingual-e5-small；模型未下载/不可用
 * 时返回 ok=false，工具层渲染成友好提示，由模型回退到关键词 activity_search，不抛给调用方。
 */
import type { ActivityStore } from "./store.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../llm/embedding/types.js";
import { cosineSimilarity } from "../llm/embedding/vector.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";

/** 单次调用最多补嵌入的分析行数；其余留到下一次调用继续补。 */
const EMBED_BATCH_LIMIT = 200;
const OCR_EMBED_BATCH_LIMIT = 400;
/** 参与 cosine 排序的向量上限（取最新 N 条，防库体无限增长拖慢检索）。 */
const EMBED_SCORE_LIMIT = 1_000;
const OCR_SCORE_LIMIT = 2_000;
const EMBED_BATCH_SIZE = 32;

export interface ActivitySemanticSearchDeps {
  store: ActivityStore;
  /** 本地嵌入运行时；未安装/不可用时返回 undefined。 */
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  query: string;
  limit?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ActivityEmbeddingPrecomputeDeps {
  store: ActivityStore;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  signal?: AbortSignal;
  now?: () => Date;
}

export type ActivityEmbeddingPrecomputeResult =
  | { ok: true; embedded: number; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

export interface ActivitySemanticHit {
  sessionId: string;
  startedAt: string;
  similarity: number;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
  /** OCR 命中是否已经关联到结构化分析；被动聊天上下文只接受 true。 */
  analysisAvailable?: boolean;
  source?: "ocr" | "analysis";
  excerpt?: string;
  occurredAt?: string;
}

export type ActivitySemanticSearchResult =
  | { ok: true; hits: ActivitySemanticHit[]; embedded: number; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

/**
 * 后台补齐当前本地模型指纹下的 OCR/analysis 向量。
 * 只接受约定的本地 multilingual-e5-small；模型不可用时不改变数据库。
 */
export async function precomputeActivityEmbeddings(
  deps: ActivityEmbeddingPrecomputeDeps
): Promise<ActivityEmbeddingPrecomputeResult> {
  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  if (!runtime) return unsupportedRuntimeResult();
  const embedded = await embedMissingActivitySources(deps, runtime);
  return {
    ok: true,
    embedded,
    model: activityEmbeddingModelName(runtime),
    dimensions: runtime.descriptor.dimensions ?? 0
  };
}

export async function searchActivitySemantic(deps: ActivitySemanticSearchDeps): Promise<ActivitySemanticSearchResult> {
  const normalized = deps.query.trim();
  if (!normalized) return { ok: false, reason: "no_vectors", message: "查询不能为空。" };

  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  if (!runtime) return unsupportedRuntimeResult();
  const embedded = await embedMissingActivitySources(deps, runtime);
  const fingerprint = runtime.fingerprint;

  const ocrRows = deps.store.listOcrEmbeddingRows(fingerprint, OCR_SCORE_LIMIT);
  const analysisRows = deps.store.listAnalysisEmbeddingRows(fingerprint, EMBED_SCORE_LIMIT);
  if (!ocrRows.length && !analysisRows.length) return { ok: false, reason: "no_vectors", message: "还没有可检索的 Activity 文本记录。" };

  const queryResult = await runtime.embed({ texts: [normalized], inputType: "query", signal: deps.signal });
  const queryVector = queryResult.embeddings[0];
  if (!queryVector) return { ok: false, reason: "no_vectors", message: "查询向量生成失败。" };

  const ocrScored = ocrRows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter((item) => Number.isFinite(item.similarity) && item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .map(({ row, similarity }) => {
      const analysis = deps.store.getAnalysis(row.sessionId);
      return {
        sessionId: row.sessionId,
        startedAt: row.startedAt,
        similarity,
        project: analysis?.project,
        summary: analysis?.summary ?? row.text,
        topics: analysis?.topics ?? [],
        highlights: analysis?.highlights ?? [],
        analysisAvailable: analysis !== undefined,
        source: "ocr" as const,
        excerpt: row.text,
        occurredAt: row.occurredAt
      };
    });
  const analysisScored = analysisRows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter((item) => Number.isFinite(item.similarity) && item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .map(({ row, similarity }) => ({ ...row, similarity, analysisAvailable: true, source: "analysis" as const }));
  const bestBySession = new Map<string, ActivitySemanticHit>();
  for (const hit of [...ocrScored, ...analysisScored]) {
    const previous = bestBySession.get(hit.sessionId);
    if (!previous || hit.similarity > previous.similarity) {
      bestBySession.set(hit.sessionId, {
        sessionId: hit.sessionId,
        startedAt: hit.startedAt,
        similarity: hit.similarity,
        project: hit.project,
        summary: hit.summary,
        topics: hit.topics,
        highlights: hit.highlights,
        analysisAvailable: hit.analysisAvailable,
        source: hit.source,
        excerpt: "excerpt" in hit ? hit.excerpt : undefined,
        occurredAt: "occurredAt" in hit ? hit.occurredAt : undefined
      });
    }
  }
  const scored = [...bestBySession.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(1, Math.min(20, deps.limit ?? 5)));

  return {
    ok: true,
    embedded,
    model: `${runtime.descriptor.ref.kind}:${"model" in runtime.descriptor.ref ? runtime.descriptor.ref.model : ""}`,
    dimensions: queryResult.dimensions,
    hits: scored
  };
}

async function resolveActivityEmbeddingRuntime(
  getRuntime: () => Promise<EmbeddingModelRuntime | undefined>
): Promise<EmbeddingModelRuntime | undefined> {
  let runtime: EmbeddingModelRuntime | undefined;
  try {
    runtime = await getRuntime();
  } catch {
    runtime = undefined;
  }
  if (!runtime) return undefined;
  const runtimeRef = runtime.descriptor.ref;
  if (runtime.descriptor.source !== "local" || runtimeRef.kind !== "local" || runtimeRef.model !== "multilingual-e5-small") {
    return undefined;
  }
  return runtime;
}

function unsupportedRuntimeResult(): { ok: false; reason: "no_runtime"; message: string } {
  return {
    ok: false,
    reason: "no_runtime",
    message: "Activity 本地 multilingual-e5-small 不可用（未下载或运行时未配置）。可以改用 activity_search 的 keyword 模式。"
  };
}

function activityEmbeddingModelName(runtime: EmbeddingModelRuntime): string {
  const ref = runtime.descriptor.ref;
  return `${ref.kind}:${ref.kind === "local" ? ref.model : `${ref.provider}/${ref.model}`}`;
}

async function embedMissingActivitySources(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime
): Promise<number> {
  const fingerprint = runtime.fingerprint;
  const ocrMissing = deps.store.listOcrEmbeddingSources(fingerprint, OCR_EMBED_BATCH_LIMIT);
  const analysisMissing = deps.store.listAnalysisEmbeddingSources(fingerprint, EMBED_BATCH_LIMIT)
    .filter((source) => !PLACEHOLDER_SUMMARIES.has(source.summary));
  let embedded = await embedOcrPassages(deps, runtime, fingerprint, ocrMissing);
  embedded += await embedAnalysisPassages(deps, runtime, fingerprint, analysisMissing);
  return embedded;
}

async function embedOcrPassages(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime,
  fingerprint: string,
  sources: ReadonlyArray<{ id: number; sessionId: string; text: string }>
): Promise<number> {
  let embedded = 0;
  for (let offset = 0; offset < sources.length; offset += EMBED_BATCH_SIZE) {
    deps.signal?.throwIfAborted();
    const batch = sources.slice(offset, offset + EMBED_BATCH_SIZE);
    let result: EmbeddingResult;
    try {
      result = await runtime.embed({ texts: batch.map((source) => source.text), inputType: "passage", signal: deps.signal });
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      continue;
    }
    result.embeddings.forEach((vector, index) => {
      const source = batch[index];
      if (!source) return;
      deps.store.upsertOcrEmbedding(source.id, fingerprint, vector, (deps.now?.() ?? new Date()).toISOString());
      embedded += 1;
    });
  }
  return embedded;
}

async function embedAnalysisPassages(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime,
  fingerprint: string,
  sources: ReadonlyArray<{ sessionId: string; project?: string; summary: string; topics: string[]; highlights: string[] }>
): Promise<number> {
  let embedded = 0;
  for (let offset = 0; offset < sources.length; offset += EMBED_BATCH_SIZE) {
    deps.signal?.throwIfAborted();
    const batch = sources.slice(offset, offset + EMBED_BATCH_SIZE);
    let result: EmbeddingResult;
    try {
      result = await runtime.embed({ texts: batch.map(embeddingText), inputType: "passage", signal: deps.signal });
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      continue;
    }
    result.embeddings.forEach((vector, index) => {
      const source = batch[index];
      if (!source) return;
      deps.store.upsertAnalysisEmbedding(source.sessionId, fingerprint, vector, (deps.now?.() ?? new Date()).toISOString());
      embedded += 1;
    });
  }
  return embedded;
}

/** 嵌入文本：project 用 [project] 前缀突出，再拼接 summary 与 topics/highlights。 */
function embeddingText(source: { project?: string; summary: string; topics: string[]; highlights: string[] }): string {
  const parts: string[] = [];
  if (source.project?.trim()) parts.push(`[${source.project.trim()}]`);
  parts.push(source.summary.trim());
  parts.push(...source.topics.map((topic) => topic.trim()));
  parts.push(...source.highlights.map((highlight) => highlight.trim()));
  return parts.filter(Boolean).join("。");
}
