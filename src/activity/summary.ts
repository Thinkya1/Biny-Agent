/**
 * Activity 的日/周聚合。
 *
 * 日报只统计 session 的开始时间落在日期范围内的记录；session 时长、应用切换和
 * 截图/OCR 计数都以完整 session 为单位，不按日期边界裁剪。这里保留 weekly 类型供旧调用方
 * 编译，但 ActivityRecorderService 只会统一生成 daily summary。
 */
import type { ActivitySessionAnalysis, ActivityStore } from "./store.js";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages } from "../llm/nativeJson.js";
import type { ActivityPrivacyPolicy } from "./privacyPolicy.js";

export type ActivitySummaryKind = "daily" | "weekly";

export interface ActivitySummaryApplication {
  app: string;
  durationMs: number;
}

export interface ActivitySummaryHour {
  hour: number;
  count: number;
}

export interface ActivitySummaryKeyMoment {
  sessionId: string;
  title: string;
  startedAt: string;
  durationMs: number;
}

export interface ActivitySummaryStats {
  dateKey: string;
  sessionCount: number;
  totalActiveMs: number;
  analyzedCount: number;
  notWorthCount: number;
  snapshotCount: number;
  ocrCharCount: number;
  apps: ActivitySummaryApplication[];
  hours: ActivitySummaryHour[];
  keyMoments: ActivitySummaryKeyMoment[];
}

export interface ActivitySummaryRecord {
  kind: ActivitySummaryKind;
  dateKey: string;
  summary: string;
  /** 只有 narrative 成功生成时才有值；确定性 fallback 不伪装成模型摘要。 */
  model?: string;
  stats: ActivitySummaryStats;
  isPartial: boolean;
  generatedAt: string;
}

export interface ActivitySummaryNarrativeOptions {
  model?: AgentModel;
  policy?: ActivityPrivacyPolicy;
  signal?: AbortSignal;
  now?: Date;
  withNarrative?: boolean;
}

export interface ActivitySummarySourceSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  snapshotCount: number;
  ocrCharCount: number;
  appNames: string[];
  /** 只包含 event_type = app_focus 的切换事件，顺序与 perAppDurationsForSession 一致。 */
  applicationEvents: Array<{ occurredAt: string; application?: string }>;
  analysis?: ActivitySessionAnalysis;
}

export interface ActivitySummarySource {
  sessions: ActivitySummarySourceSession[];
}

const MAX_APPS = 10;
const MAX_KEY_MOMENTS = 10;

/** 构造指定本地日历范围；weekly 的 dateKey 代表该周周一。 */
export function activitySummaryRange(kind: ActivitySummaryKind, dateKey: string): { start: Date; end: Date } {
  const start = parseLocalDateKey(dateKey);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + (kind === "weekly" ? 7 : 1));
  return { start, end };
}

export function buildActivitySummary(
  store: ActivityStore,
  kind: ActivitySummaryKind,
  dateKey: string,
  now = new Date()
): ActivitySummaryRecord {
  const range = activitySummaryRange(kind, dateKey);
  const source = store.getActivitySummarySource(range.start.toISOString(), range.end.toISOString());
  const stats = aggregateActivitySummaryStats(dateKey, source, now);
  return {
    kind,
    dateKey,
    summary: renderActivitySummary(stats),
    stats,
    // 只按日期是否仍在今天/未来标记 partial；缺分析的历史 session 仍会出现在统计里，
    // 但不会冒充 analyzed/key moment。
    isPartial: kind === "daily"
      ? dateKey >= formatLocalDateKey(now)
      : range.end.getTime() > now.getTime(),
    generatedAt: now.toISOString()
  };
}

export function refreshActivitySummary(
  store: ActivityStore,
  kind: ActivitySummaryKind,
  dateKey: string,
  now = new Date()
): ActivitySummaryRecord {
  const summary = buildActivitySummary(store, kind, dateKey, now);
  store.upsertSummary(summary);
  return summary;
}

/**
 * 生成并持久化 narrative 日结。模型只接收聚合后的日期统计和 session 标题，
 * 不接触截图/OCR 原文；策略拒绝、无模型或调用失败时保留本地确定性摘要。
 */
export async function refreshActivitySummaryWithNarrative(
  store: ActivityStore,
  kind: ActivitySummaryKind,
  dateKey: string,
  options: ActivitySummaryNarrativeOptions = {}
): Promise<ActivitySummaryRecord> {
  const base = buildActivitySummary(store, kind, dateKey, options.now ?? new Date());
  let summary = base.summary;
  let model: string | undefined;
  if (options.withNarrative && options.model && options.policy) {
    try {
      const run = await options.policy.runAnalysis(options.model, async () => {
        const result = await generateNativeText(
          options.model!,
          nativeJsonMessages(
            "You write short narrative summaries of the user's computing activity. 3-6 sentences. Neutral, factual, avoid speculation or value judgements. Write in the same language the apps/OCR text are in (default English).",
            activitySummaryNarrativePrompt(base.stats)
          ),
          {
            signal: options.signal,
            maxOutputTokens: 600,
            reasoning: "off",
          }
        );
        const text = result.text.trim();
        return text || undefined;
      });
      if (run.value) {
        summary = run.value;
        model = options.model.modelId;
      }
    } catch {
      // 日报是派生缓存；模型瞬时失败时先保留统计 fallback，下一轮自动检查可重试。
    }
  }
  const result: ActivitySummaryRecord = { ...base, summary, model };
  store.upsertSummary(result);
  return result;
}

function aggregateActivitySummaryStats(
  dateKey: string,
  source: ActivitySummarySource,
  now: Date
): ActivitySummaryStats {
  const appDurations = new Map<string, number>();
  let totalActiveMs = 0;
  let snapshotCount = 0;
  let ocrCharCount = 0;
  let analyzedCount = 0;
  let notWorthCount = 0;
  const hourCounts = Array.from({ length: 24 }, () => 0);
  const keyMoments: ActivitySummaryKeyMoment[] = [];

  for (const session of source.sessions) {
    const durationMs = sessionDurationMs(session);
    totalActiveMs += durationMs;
    snapshotCount += session.snapshotCount;
    ocrCharCount += session.ocrCharCount;

    const startedAt = parseTimestamp(session.startedAt);
    const hour = new Date(startedAt).getHours();
    if (Number.isFinite(startedAt) && hour >= 0 && hour < 24) {
      hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    }

    for (const [app, duration] of perAppDurationsForSession(session, now)) {
      appDurations.set(app, (appDurations.get(app) ?? 0) + duration);
    }

    const analysis = session.analysis;
    if (!isReportableAnalysis(analysis)) continue;
    analyzedCount += 1;
    if (!analysis.worthMemory && !analysis.worthKnowledge) notWorthCount += 1;
    const title = analysis.title?.trim();
    if (title) {
      keyMoments.push({
        sessionId: session.id,
        title,
        startedAt: session.startedAt,
        durationMs
      });
    }
  }

  keyMoments.sort((left, right) => right.durationMs - left.durationMs);
  return {
    dateKey,
    sessionCount: source.sessions.length,
    totalActiveMs,
    analyzedCount,
    notWorthCount,
    snapshotCount,
    ocrCharCount,
    apps: [...appDurations.entries()]
      .map(([app, durationMs]) => ({ app, durationMs: Math.round(durationMs) }))
      .sort((left, right) => right.durationMs - left.durationMs || left.app.localeCompare(right.app))
      .slice(0, MAX_APPS),
    hours: hourCounts.map((count, hour) => ({ hour, count })),
    keyMoments: keyMoments.slice(0, MAX_KEY_MOMENTS)
  };
}

/** 有 app_focus 按切换边界分配；没有时把 session 时长平均分给 appNames。 */
function perAppDurationsForSession(
  session: ActivitySummarySourceSession,
  now: Date
): Map<string, number> {
  const durations = new Map<string, number>();
  const startedAt = parseTimestamp(session.startedAt);
  const endedAt = session.endedAt === undefined ? now.getTime() : parseTimestamp(session.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return durations;

  const focusEvents = session.applicationEvents
    .map((event) => ({ at: parseTimestamp(event.occurredAt), app: event.application?.trim() }))
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => left.at - right.at);
  if (focusEvents.length === 0) {
    const apps = session.appNames.map((app) => app.trim()).filter(Boolean);
    if (apps.length === 0) return durations;
    const duration = Math.max(0, endedAt - startedAt) / apps.length;
    for (const app of apps) durations.set(app, (durations.get(app) ?? 0) + duration);
    return durations;
  }

  let cursor = startedAt;
  let currentApp = focusEvents[0]?.app;
  for (const event of focusEvents) {
    if (currentApp) {
      const duration = Math.max(0, event.at - cursor);
      durations.set(currentApp, (durations.get(currentApp) ?? 0) + duration);
    }
    cursor = event.at;
    currentApp = event.app ?? currentApp;
  }
  if (currentApp) {
    const duration = Math.max(0, endedAt - cursor);
    durations.set(currentApp, (durations.get(currentApp) ?? 0) + duration);
  }
  return durations;
}

function sessionDurationMs(session: ActivitySummarySourceSession): number {
  if (session.endedAt === undefined) return 0;
  const startedAt = parseTimestamp(session.startedAt);
  const endedAt = parseTimestamp(session.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

function renderActivitySummary(stats: ActivitySummaryStats): string {
  const activeMinutes = Math.round(stats.totalActiveMs / 60_000);
  const appText = stats.apps.slice(0, 5).map((app) => app.app).join("、");
  const parts = [
    `${stats.dateKey} 记录了 ${String(stats.sessionCount)} 个活动会话，活跃约 ${String(activeMinutes)} 分钟`,
    appText ? `主要使用：${appText}` : undefined,
    stats.snapshotCount > 0 ? `截图 ${String(stats.snapshotCount)} 张` : undefined,
    stats.ocrCharCount > 0 ? `OCR ${String(stats.ocrCharCount)} 字符` : undefined
  ].filter((value): value is string => Boolean(value));
  return `${parts.join("；")}。`;
}

function activitySummaryNarrativePrompt(stats: ActivitySummaryStats): string {
  const activeMinutes = Math.round(stats.totalActiveMs / 60_000);
  const topApps = stats.apps.slice(0, 5)
    .map((app) => `${app.app} (${Math.round(app.durationMs / 60_000)}m)`)
    .join(", ") || "(none)";
  const notableSessions = stats.keyMoments.slice(0, 5)
    .map((moment) => `• ${moment.title}`)
    .join("\n") || "(none)";
  return [
    `Date: ${stats.dateKey}`,
    `Active time: ${String(activeMinutes)} minutes across ${String(stats.sessionCount)} sessions`,
    `Analyzed: ${String(stats.analyzedCount)}   Not worth: ${String(stats.notWorthCount)}`,
    `Top apps: ${topApps}`,
    "",
    "Notable sessions:",
    notableSessions
  ].join("\n");
}

const PLACEHOLDER_SUMMARIES = new Set(["零星活动", "活动分析失败"]);

function isReportableAnalysis(analysis: ActivitySessionAnalysis | undefined): analysis is ActivitySessionAnalysis {
  return analysis !== undefined && !PLACEHOLDER_SUMMARIES.has(analysis.summary.trim());
}

function parseLocalDateKey(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) throw new Error(`无效的 Activity summary 日期：${value}。`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`无效的 Activity summary 日期：${value}。`);
  }
  return date;
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
