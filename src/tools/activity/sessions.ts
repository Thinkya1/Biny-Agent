/**
 * activity_sessions 工具模块（列表 / 详情双模式）。
 *
 * 不带 sessionId 时列出最近录到的活动（快速浏览「录到了哪些」）；带 sessionId 时展开单个
 * session 的事件摘要与已落库的分析结果，是调试/回溯「我刚刚到底干了什么」的最后一级。
 *
 * 读取的全部是 store 查询层提供的脱敏 occurredAt/summary/application；快照路径与 OCR
 * 原文不进入渲染文本，详情也只展示与工具、分析输入同级的摘要级信息。
 */
import { z } from "zod";
import { ActivityStore } from "../../activity/store.js";
import type { ActivitySettings } from "../../activity/settings.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface ActivitySessionsArgs {
  /** 提供时展开单个 session 详情；省略时列出最近会话。 */
  sessionId?: string;
  limit?: number;
}

export interface ActivitySessionsToolDeps {
  /** 读取最新的 activity 设置（存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
}

export function createActivitySessionsTool(deps: ActivitySessionsToolDeps): Tool<ActivitySessionsArgs, string> {
  return {
    name: "activity_sessions",
    description: [
      "List the user's most recent recorded activity sessions with their analysis (project, summary, topics) when available, or show one session in full when sessionId is given.",
      "Call without sessionId to orient \"what sessions exist\", then pass a session id from the list to open its timeline (start/end, event count, redacted event summaries, analysis).",
      "Reads only redacted on-device activity metadata; screenshots and OCR text never leave the device."
    ].join(" "),
    promptSnippet: "List recent activity sessions, or show one session's timeline by id",
    promptGuidelines: [
      "Call activity_sessions without sessionId to list what sessions exist, then pass a session id to inspect that session's event timeline"
    ],
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 64, description: "Activity session id (uuid). Omit to list recent sessions instead." },
        limit: { type: "number", minimum: 1, maximum: 30, description: "Max number of sessions when listing (default 10); ignored when sessionId is given." }
      },
      additionalProperties: false
    },
    schema: z.object({
      sessionId: z.string().trim().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(30).optional()
    }),
    capability: "activity.sessions",
    risk: "read",
    resolveExecution(args) {
      const sessionId = args.sessionId;
      const detail = sessionId !== undefined;
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: detail ? `查看活动会话 ${sessionId.slice(0, 8)}` : "列出最近的活动会话" },
        description: detail ? "Show activity session detail" : "List recent activity sessions",
        approvalRule: "activity_sessions",
        async execute() {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            if (sessionId !== undefined) {
              const record = store.getSessionRecord(sessionId);
              if (!record) return `没有找到会话 ${sessionId}。`;
              const events = store.listSessionEventSummaries(sessionId);
              const analysis = store.getAnalysis(sessionId);
              return renderSessionDetail(record, events, analysis);
            }
            const rows = store.listRecentSessionsWithAnalysis("1970-01-01T00:00:00.000Z", args.limit ?? 10);
            return renderSessionList(rows);
          } finally {
            await store.close();
          }
        }
      };
    }
  };
}

function renderSessionList(rows: readonly {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  analysis?: { project?: string; summary: string; topics: string[] };
}[]): string {
  const head = "## 最近的活动会话";
  if (!rows.length) return `${head}\n\n（还没有录到的活动会话。）`;
  const lines = rows.map((row) => {
    const range = sessionTimeRange(row.startedAt, row.endedAt);
    const ongoing = row.endedAt === undefined ? "（进行中）" : "";
    const count = `事件 ${String(row.eventCount)}`;
    if (row.analysis) {
      const project = row.analysis.project?.trim() ? ` [${row.analysis.project.trim()}]` : "";
      const lead = row.analysis.topics.length ? row.analysis.topics.join("；") : row.analysis.summary.trim();
      return `- ${range}${ongoing}${project} ${count}：${lead}  (\`${row.id}\`)`;
    }
    return `- ${range}${ongoing} ${count}（未分析）  (\`${row.id}\`)`;
  });
  return [head, "", ...lines].join("\n");
}

function renderSessionDetail(
  record: { id: string; startedAt: string; endedAt?: string; eventCount: number },
  events: readonly { occurredAt: string; summary: string; application?: string }[],
  analysis: { project?: string; summary: string; topics: string[]; highlights: string[]; decisions: string[]; isMeeting: boolean } | undefined
): string {
  const range = sessionTimeRange(record.startedAt, record.endedAt);
  const ongoing = record.endedAt === undefined ? "（进行中）" : "";
  const parts = [
    `## 会话 ${record.id}`,
    `${range}${ongoing} · 事件 ${String(record.eventCount)} · 摘要 ${String(events.length)} 条`
  ];
  if (analysis) {
    const project = analysis.project?.trim() ? ` [${analysis.project.trim()}]` : "";
    const meeting = analysis.isMeeting ? " 📅" : "";
    parts.push(`分析${meeting}${project}：${analysis.summary.trim()}`);
    if (analysis.topics.length) parts.push(`主题：${analysis.topics.join("；")}`);
    if (analysis.decisions.length) parts.push(`决策：${analysis.decisions.join("；")}`);
    if (analysis.highlights.length) parts.push(`亮点：${analysis.highlights.join("；")}`);
  } else {
    parts.push("分析：(尚未分析)");
  }
  if (events.length) {
    parts.push("事件时间线：");
    for (const event of events.slice(0, 60)) {
      const time = formatLocalTime(event.occurredAt);
      const app = event.application?.trim() ? ` (${event.application.trim()})` : "";
      parts.push(`- ${time}${app} ${event.summary.trim()}`);
    }
    if (events.length > 60) parts.push(`…（其余 ${String(events.length - 60)} 条略）`);
  } else {
    parts.push("事件时间线：(空)");
  }
  return parts.join("\n");
}

function sessionTimeRange(startedAt: string, endedAt: string | undefined): string {
  const start = formatLocalTime(startedAt);
  if (!endedAt) return `${start}–`;
  return `${start}–${formatLocalTime(endedAt)}`;
}

/** UTC ISO → 本地 HH:MM。 */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}