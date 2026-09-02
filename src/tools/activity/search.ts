/**
 * activity_search 工具模块（keyword / semantic 双模式）。
 *
 * 两条检索路径合并暴露、内部分开实现（分开实现更便于调节排序）：
 * - mode=keyword（默认）：走现有 FTS5，搜的是脱敏事件行（粒度细，能命中「某条操作」）。
 * - mode=semantic：优先对截图 OCR frame 做本地 embedding，再以 analysis 行补充，做 cosine
 *   top N，适合「那个讲 XX 的页面/那件事」这类模糊指向；本地嵌入模型不可用或尚无向量时
 *   返回友好提示，由模型回退到 keyword 模式，不抛给调用方。
 *
 * 两侧都只接触 store 查询层提供的脱敏数据；语义结果只显示脱敏 OCR 短摘录，不暴露快照路径。
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
  mode?: "keyword" | "semantic";
  limit?: number;
}

export interface ActivitySearchToolDeps {
  /** 读取最新的 activity 设置（存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
  /**
   * 本地嵌入运行时（与记忆同一套 LocalEmbeddingRuntime）；未安装/不可用时 semantic 模式
   * 返回友好提示，由模型回退到 keyword 模式。
   */
  getEmbeddingRuntime?(): Promise<EmbeddingModelRuntime | undefined>;
  /** 可注入时钟，便于测试固定「现在」。 */
  now?(): Date;
}

export function createActivitySearchTool(deps: ActivitySearchToolDeps): Tool<ActivitySearchArgs, string> {
  return {
    name: "activity_search",
    description: [
      "Search the user's recorded on-device activity (redacted summaries, applications, windows).",
      "mode=keyword (default) full-text-searches individual event lines for explicit keyword lookups;",
      "mode=semantic finds OCR-backed activity sessions about a topic even when wording differs — use it for vague references to past work.",
      "Semantic mode embeds redacted OCR and analysis text locally on-device and reports a friendly message when the local embedding model is unavailable.",
      "Screenshots stay on-device; semantic results contain only redacted text excerpts."
    ].join(" "),
    promptSnippet: "Search recorded activity events (keyword) or analyzed sessions (semantic)",
    promptGuidelines: [
      "Explicit 搜/搜索 requests about past activity go to activity_search mode=keyword; vague references to a thing (那个…的XX / 之前那次…) go to mode=semantic",
      "If semantic mode reports the embedding model is unavailable, retry with mode=keyword and the same query"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Keyword (keyword mode) or natural-language description (semantic mode) of the activity to find." },
        mode: { type: "string", enum: ["keyword", "semantic"], description: "keyword = FTS over event lines (default); semantic = embedding similarity over analyzed sessions." },
        limit: { type: "number", minimum: 1, maximum: 50, description: "Max results (keyword default 20, semantic default 5)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().trim().min(1).max(200),
      mode: z.enum(["keyword", "semantic"]).default("keyword"),
      limit: z.number().int().min(1).max(50).optional()
    }),
    capability: "activity.search",
    risk: "read",
    resolveExecution(args) {
      const semantic = args.mode === "semantic";
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: semantic ? `语义检索活动会话：${args.query}` : `检索活动记录：${args.query}` },
        description: semantic ? `Semantic search analyzed activity sessions: ${args.query}` : `Keyword search recorded activity for: ${args.query}`,
        approvalRule: "activity_search",
        async execute({ signal }) {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            if (semantic) {
              const result = await searchActivitySemantic({
                store,
                getEmbeddingRuntime: async () => await deps.getEmbeddingRuntime?.(),
                query: args.query,
                limit: args.limit,
                signal,
                now: deps.now
              });
              return renderSemanticSearchResult(args.query, result);
            }
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
  const head = `## activity_search (semantic): ${query}`;
  if (!result.ok) return `${head}\n\n${result.message}`;
  if (!result.hits.length) return `${head}\n\n没有相似度足够高的分析会话。`;
  const sections = result.hits.map((hit) => {
    const project = hit.project?.trim() ? ` [${hit.project.trim()}]` : "";
    const topics = hit.topics.length ? `\n  - 主题：${hit.topics.join("；")}` : "";
    const highlights = hit.highlights.length ? `\n  - 亮点：${hit.highlights.join("；")}` : "";
    const source = hit.source === "ocr" ? "OCR" : "分析";
    const excerpt = hit.excerpt?.trim() && hit.excerpt.trim() !== hit.summary.trim()
      ? `\n  - OCR 摘录：${hit.excerpt.trim()}`
      : "";
    return `- ${formatLocalTime(hit.occurredAt ?? hit.startedAt)}${project} 相似度 ${hit.similarity.toFixed(3)}（${source}）\n  ${hit.summary.trim()}${excerpt}${topics}${highlights}`;
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
