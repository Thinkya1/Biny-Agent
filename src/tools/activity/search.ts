/**
 * activity_search / activity_search_semantic 工具模块。
 *
 * 两条检索路径刻意分开（Alma 实测分开比混合排序好调）：
 * - activity_search：关键词走现有 FTS5，搜的是脱敏事件行（粒度细，能命中「某条操作」）。
 * - activity_search_semantic：本地嵌入 analysis 行（project+summary+topics+highlights）做
 *   cosine top N，适合「那个讲 XX 的页面/那件事」这类模糊指向；本地嵌入模型不可用或尚无
 *   向量时返回友好提示，由模型回退到 activity_search，不抛给调用方。
 *
 * 两侧都只接触 store 查询层提供的脱敏数据；快照路径、OCR 原文不进结果文本。
 */
import { z } from "zod";
import { searchActivitySemantic, type ActivitySemanticSearchResult } from "../../activity/semanticSearch.js";
import { ActivityStore } from "../../activity/store.js";
import type { ActivitySettings } from "../../activity/settings.js";
import type { EmbeddingModelRuntime } from "../../llm/embedding/types.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface ActivitySearchArgs {
  query: string;
  limit?: number;
}

export interface ActivitySearchToolDeps {
  /** 读取最新的 activity 设置（存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
  /** 可注入时钟，便于测试固定「现在」。 */
  now?(): Date;
}

export function createActivitySearchTool(deps: ActivitySearchToolDeps): Tool<ActivitySearchArgs, string> {
  return {
    name: "activity_search",
    description: [
      "Keyword-search the user's recorded on-device activity events (redacted summaries, applications, windows) via full-text index.",
      "Use it when the user explicitly asks to search past activity by a keyword, or when activity_search_semantic is unavailable.",
      "Returns the most recent matching event lines; screenshots and OCR text never leave the device."
    ].join(" "),
    promptSnippet: "Keyword-search recorded activity events",
    promptGuidelines: [
      "Prefer activity_search when the user says 搜/搜索/找 explicitly about past activity; use activity_search_semantic for vague references to a thing",
      "If activity_search_semantic reports the embedding model is unavailable, fall back to activity_search with the same query"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Keyword or phrase to search for in recorded activity." },
        limit: { type: "number", minimum: 1, maximum: 50, description: "Max results (default 20)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(50).optional()
    }),
    capability: "activity.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `检索活动记录：${args.query}` },
        description: `Keyword search recorded activity for: ${args.query}`,
        approvalRule: "activity_search",
        async execute() {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            const rows = store.search(args.query, args.limit ?? 20);
            return renderKeywordSearchResult(args.query, rows);
          } finally {
            await store.close();
          }
        }
      };
    }
  };
}

export interface ActivitySemanticSearchToolDeps extends ActivitySearchToolDeps {
  /**
   * 本地嵌入运行时（与记忆同一套 LocalEmbeddingRuntime）；未安装/不可用时工具返回
   * 友好提示，由模型回退到 activity_search。
   */
  getEmbeddingRuntime?(): Promise<EmbeddingModelRuntime | undefined>;
}

export function createActivitySemanticSearchTool(deps: ActivitySemanticSearchToolDeps): Tool<ActivitySearchArgs, string> {
  return {
    name: "activity_search_semantic",
    description: [
      "Semantic search across analyzed activity sessions using local embeddings: finds sessions about the same topics even when wording differs.",
      "Use it when the user vaguely references past work (e.g. \"那个讲 XX 的页面\", previous decisions/refactors), when keyword search misses, or when recall needs similar-session discovery.",
      "Embeds only redacted analysis summaries (project, summary, topics, highlights) locally on-device; falls back to activity_search when the local embedding model is unavailable."
    ].join(" "),
    promptSnippet: "Semantic search across analyzed activity sessions",
    promptGuidelines: [
      "Route vague references to past work (那个…的XX / 之前那次…) to activity_search_semantic; fall back to activity_search if it reports local embedding unavailable",
      "Explicit 搜/搜索 requests go to activity_search"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Natural-language description of the session to find." },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Max results (default 5)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(20).optional()
    }),
    capability: "activity.search_semantic",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `语义检索活动会话：${args.query}` },
        description: `Semantic search analyzed activity sessions: ${args.query}`,
        approvalRule: "activity_search_semantic",
        async execute({ signal }) {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            const result = await searchActivitySemantic({
              store,
              getEmbeddingRuntime: async () => await deps.getEmbeddingRuntime?.(),
              query: args.query,
              limit: args.limit,
              signal,
              now: deps.now
            });
            return renderSemanticSearchResult(args.query, result);
          } finally {
            await store.close();
          }
        }
      };
    }
  };
}

/** 关键词结果渲染：一条一行，时间 + 应用 + 脱敏摘要。 */
function renderKeywordSearchResult(query: string, rows: readonly { occurredAt: string; application?: string; summary: string; sessionId: string }[]): string {
  const head = `## activity_search: ${query}`;
  if (!rows.length) return `${head}\n\n没有找到匹配的活动记录。`;
  const lines = rows.map((row) => {
    const time = formatLocalTime(row.occurredAt);
    const app = row.application?.trim() ? ` (${row.application.trim()})` : "";
    const summary = row.summary.trim() || "(无摘要)";
    return `- ${time}${app} ${summary}  [session ${row.sessionId.slice(0, 8)}]`;
  });
  return [head, "", ...lines].join("\n");
}

/** 语义结果渲染：相似度 + 命中 session 的 project/summary/topics/highlights。 */
function renderSemanticSearchResult(query: string, result: ActivitySemanticSearchResult): string {
  const head = `## activity_search_semantic: ${query}`;
  if (!result.ok) return `${head}\n\n${result.message}`;
  if (!result.hits.length) return `${head}\n\n没有相似度足够高的分析会话。`;
  const sections = result.hits.map((hit) => {
    const project = hit.project?.trim() ? ` [${hit.project.trim()}]` : "";
    const topics = hit.topics.length ? `\n  - 主题：${hit.topics.join("；")}` : "";
    const highlights = hit.highlights.length ? `\n  - 亮点：${hit.highlights.join("；")}` : "";
    return `- ${formatLocalTime(hit.startedAt)}${project} 相似度 ${hit.similarity.toFixed(3)}\n  ${hit.summary.trim()}${topics}${highlights}`;
  });
  const note = result.embedded > 0 ? `\n（本次补嵌入 ${String(result.embedded)} 个会话）` : "";
  return [head, "", ...sections, "", `模型：${result.model}${note}`].join("\n");
}

/** UTC ISO → 本地 HH:MM。 */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}