/**
 * activity_sessions / activity_session_show 工具模块。
 *
 * sessions 用于「最近录到了哪些活动」的快速浏览；show 用于展开单个 session 的事件摘要
 * 与已落库的分析结果，是调试/回溯「我刚刚到底干了什么」的最后一级。
 *
 * 读取的全部是 store 查询层提供的脱敏 occurredAt/summary/application；快照路径与 OCR
 * 原文不进入渲染文本，session_show 也只展示与工具、分析输入同级的摘要级信息。
 */
import { z } from "zod";
import { ActivityStore } from "../../activity/store.js";
import type { ActivitySettings } from "../../activity/settings.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface ActivitySessionsArgs {
  limit?: number;
}

export interface ActivitySessionShowArgs {
  sessionId: string;
}

export interface ActivitySessionsToolDeps {
  /** 读取最新的 activity 设置（存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
}

export function createActivitySessionsTool(deps: ActivitySessionsToolDeps): Tool<ActivitySessionsArgs, string> {
  return {
    name: "activity_sessions",
    description: [
      "List the user's most recent recorded activity sessions with their analysis (project, summary, topics) when available.",
      "Use it to orient \"what sessions exist\" before digging into one session; activity_session_show opens a single session.",
      "Reads only redacted on-device activity metadata; screenshots and OCR text never leave the device."
    ].join(" "),
    promptSnippet: "List recent recorded activity sessions",
    promptGuidelines: [
      "Use activity_sessions to list what sessions exist, then activity_session_show to open one by its id"
    ],
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 30, description: "Max number of sessions (default 10)." }
      },
      additionalProperties: false
    },
    schema: z.object({
      limit: z.number().int().min(1).max(30).optional()
    }),
    capability: "activity.sessions",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "列出最近的活动会话" },
        description: "List recent activity sessions",
        approvalRule: "activity_sessions",
        async execute() {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
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

export function createActivitySessionShowTool(deps: ActivitySessionsToolDeps): Tool<ActivitySessionShowArgs, string> {
  return {
    name: "activity_session_show",
    description: [
      "Show one recorded activity session's timeline: start/end, event count, redacted event summaries, and its analysis when it exists.",
      "Use it after activity_sessions to open a specific session by id.",
      "Reads only redacted event summaries; screenshots and OCR text never leave the device."
    ].join(" "),
    promptSnippet: "Show one activity session's timeline",
    promptGuidelines: [
      "Use activity_session_show with a session id from activity_sessions to inspect that session's event timeline"
    ],
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 64, description: "Activity session id (uuid)." }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    schema: z.object({
      sessionId: z.string().trim().min(1).max(64)
    }),
    capability: "activity.session_show",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `查看活动会话 ${args.sessionId.slice(0, 8)}` },
        description: "Show activity session detail",
        approvalRule: "activity_session_show",
        async execute() {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            const record = store.getSessionRecord(args.sessionId);
            if (!record) return `没有找到会话 ${args.sessionId}。`;
            const events = store.listSessionEventSummaries(args.sessionId);
            const analysis = store.getAnalysis(args.sessionId);
            return renderSessionDetail(record, events, analysis);
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