/**
 * activity_search_semantic 的业务实现：本地嵌入 analysis 行 + cosine 排序。
 *
 * 嵌入对象是 analysis 的 project+summary+topics+highlights（不碰原始事件——事件级嵌入量
 * 大且噪），向量存在 activity_analysis_embeddings 派生表里。每次调用先补当前指纹缺失的
 * 向量（本地模型批量嵌入，失败只留待下次），再嵌入查询做 cosine top N。
 *
 * 复用 LocalEmbeddingRuntime（与记忆同一套本地模型与缓存目录）：模型未下载/不可用时返回
 * ok=false，工具层渲染成友好提示，由模型回退到关键词 activity_search，不抛给调用方。
 */
import type { ActivityStore } from "./store.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../llm/embedding/types.js";
import { cosineSimilarity } from "../llm/embedding/vector.js";
import { ACTIVITY_ANALYSIS_FAILED_SUMMARY, ACTIVITY_TRIVIAL_SUMMARY } from "./analyzer.js";

/** 单次调用最多补嵌入的分析行数；其余留到下一次调用继续补。 */
const EMBED_BATCH_LIMIT = 200;
/** 参与 cosine 排序的向量上限（取最新 N 条，防库体无限增长拖慢检索）。 */
const EMBED_SCORE_LIMIT = 1_000;
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

export interface ActivitySemanticHit {
  sessionId: string;
  startedAt: string;
  similarity: number;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
}

export type ActivitySemanticSearchResult =
  | { ok: true; hits: ActivitySemanticHit[]; embedded: number; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

export async function searchActivitySemantic(deps: ActivitySemanticSearchDeps): Promise<ActivitySemanticSearchResult> {
  const normalized = deps.query.trim();
  if (!normalized) return { ok: false, reason: "no_vectors", message: "查询不能为空。" };

  const runtime = await deps.getEmbeddingRuntime();
  if (!runtime) {
    return {
      ok: false,
      reason: "no_runtime",
      message: "本地嵌入模型不可用（未下载或运行时未配置）。可以改用 activity_search 的 keyword 模式做关键词检索。"
    };
  }

  const fingerprint = runtime.fingerprint;
  const missing = deps.store.listAnalysisEmbeddingSources(fingerprint, EMBED_BATCH_LIMIT)
    .filter((source) => !PLACEHOLDER_SUMMARIES.has(source.summary));
  let embedded = 0;
  for (let offset = 0; offset < missing.length; offset += EMBED_BATCH_SIZE) {
    deps.signal?.throwIfAborted();
    const batch = missing.slice(offset, offset + EMBED_BATCH_SIZE);
    let result: EmbeddingResult;
    try {
      result = await runtime.embed({
        texts: batch.map(embeddingText),
        inputType: "passage",
        signal: deps.signal
      });
    } catch (error) {
      // 中止必须穿透；单个批次失败只跳过本批（缺的向量留到下次调用再补），
      // 已写入的向量继续参与本次检索——见模块头「失败只留待下次」。
      if (deps.signal?.aborted) throw error;
      continue;
    }
    result.embeddings.forEach((vector, index) => {
      const source = batch[index];
      if (!source) return;
      deps.store.upsertAnalysisEmbedding(
        source.sessionId,
        fingerprint,
        vector,
        (deps.now?.() ?? new Date()).toISOString()
      );
    });
    embedded += batch.length;
  }

  const rows = deps.store.listAnalysisEmbeddingRows(fingerprint, EMBED_SCORE_LIMIT);
  if (!rows.length) return { ok: false, reason: "no_vectors", message: "还没有可检索的分析记录。" };

  const queryResult = await runtime.embed({ texts: [normalized], inputType: "query", signal: deps.signal });
  const queryVector = queryResult.embeddings[0];
  if (!queryVector) return { ok: false, reason: "no_vectors", message: "查询向量生成失败。" };

  const scored = rows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter((item) => Number.isFinite(item.similarity) && item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(1, Math.min(20, deps.limit ?? 5)));

  return {
    ok: true,
    embedded,
    model: `${runtime.descriptor.ref.kind}:${"model" in runtime.descriptor.ref ? runtime.descriptor.ref.model : ""}`,
    dimensions: queryResult.dimensions,
    hits: scored.map(({ row, similarity }) => ({
      sessionId: row.sessionId,
      startedAt: row.startedAt,
      similarity,
      project: row.project,
      summary: row.summary,
      topics: row.topics,
      highlights: row.highlights
    }))
  };
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