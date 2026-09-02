/**
 * Activity 分析层：把单个已结束 session 的脱敏事件与 OCR 投影归纳成结构化 SessionAnalysis 落库，
 * 并把指定日期的分析结果聚合成一份确定性的「打工日记」。
 *
 * 隐私边界（与 privacyPolicy 的注释一一对应）：
 * - 送给分析模型的只有 store.listSessionEventSummaries 提供的时间、应用、事件摘要和已脱敏
 *   OCR。它们在写入 SQLite 前已经过了 redactActivityText；原始截图和 snapshot 路径从查询层
 *   就不在这条链路上，任何策略下都不出设备。
 * - 是否放行由 ActivityPrivacyPolicy 的 analysis 维度（analysisPolicy）统一决定；未放行时
 *   runAnalysis 不执行回调，对应 session 保持「待分析」，等策略放开后由 sweep 补分析。
 * - 只有同时满足“时长小于 30 秒、事件少于 20 条、截图少于 3 张”的 session 才直接落一条低
 *   置信度占位记录；短 session 中有足够事件或截图时仍允许分析。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../llm/nativeJson.js";
import type { ActivityAnalysisDecision, ActivityPrivacyPolicy } from "./privacyPolicy.js";
import type {
  ActivityAnalysisCommit,
  ActivityAnalysisReference,
  ActivityAnalysisEntityDetails,
  ActivityAnalysisReportRow,
  ActivityEventSummary,
  ActivityPendingAnalysisSession,
  ActivitySessionAnalysis,
  ActivityStore
} from "./store.js";

/** 零星 session 判定：三个条件同时成立才跳过模型。 */
export const ACTIVITY_ANALYSIS_MIN_SESSION_DURATION_MS = 30_000;
export const ACTIVITY_ANALYSIS_MIN_EVENTS = 20;
export const ACTIVITY_ANALYSIS_MIN_SNAPSHOTS = 3;
/** 单个 session 放进分析 prompt 的 OCR 字符预算。 */
export const ACTIVITY_ANALYSIS_MAX_OCR_CHARS = 18_000;
/** 单个 session 放进分析 prompt 的事件上限。 */
export const ACTIVITY_ANALYSIS_MAX_EVENTS_IN_PROMPT = 80;
/** 心跳/零星 session 的占位摘要；报告渲染会把这类占位过滤掉。 */
export const ACTIVITY_TRIVIAL_SUMMARY = "零星活动";
/** 模型两次输出都无法解析时落库的占位摘要；同样不进报告。 */
export const ACTIVITY_ANALYSIS_FAILED_SUMMARY = "活动分析失败";

const ANALYSIS_MAX_OUTPUT_TOKENS = 1_200;
const ANALYSIS_TIMEOUT_MS = 60_000;
const KNOWN_PROJECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_PROJECT_LIMIT = 20;
/** 进入 inputHash 的 prompt/解析版本；改动它会让已分析 session 因 hash 变化而重跑。 */
const ACTIVITY_ANALYSIS_VERSION = "activity-session-analysis/v4";

const analysisReferenceSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  number: z.number().int().positive().optional(),
  url: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().min(1).max(300).optional()
});

const analysisCommitSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  ref: z.string().trim().min(1).max(160).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  hash: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  url: z.string().trim().min(1).max(500).optional()
});

const analysisPersonSchema = z.union([
  z.string().trim().min(1).max(120),
  z.object({
    handle: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160).optional()
  })
]);

const memoryCandidateSchema = z.object({
  type: z.enum(["project", "feedback", "reference", "user"]),
  content: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(160)
});

const analysisEntityDetailsSchema = z.object({
  prs: z.array(analysisReferenceSchema).max(32).default([]),
  issues: z.array(analysisReferenceSchema).max(32).default([]),
  commits: z.array(analysisCommitSchema).max(64).default([]),
  people: z.array(analysisPersonSchema).max(32).default([]),
  identifiers: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  repos: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  versions: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  events: z.array(z.string().trim().min(1).max(300)).max(32).default([]),
  decisions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  urls: z.array(z.string().trim().min(1).max(500)).max(64).default([])
});

/** 模型输出的强校验契约；数组字段给默认值，summary 缺失视为解析失败。 */
const analysisOutputSchema = z.object({
  project: z.string().trim().min(1).max(120).nullish(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().min(1).max(800).optional(),
  summary: z.string().trim().min(1).max(1_000).optional(),
  topics: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
  prs: z.array(analysisReferenceSchema).max(32).default([]),
  issues: z.array(analysisReferenceSchema).max(32).default([]),
  people: z.array(analysisPersonSchema).max(32).default([]),
  versions: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  decisions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  // 使用分组对象；旧版本 Biny 曾使用 string[]，两种形态都接受并在落库前归一化。
  entities: z.union([
    z.array(z.string().trim().min(1).max(200)).max(64),
    analysisEntityDetailsSchema
  ]).default([]),
  highlights: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
  commits: z.array(analysisCommitSchema).max(64).default([]),
  identifiers: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  repos: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  events: z.array(z.string().trim().min(1).max(300)).max(32).default([]),
  urls: z.array(z.string().trim().min(1).max(500)).max(64).default([]),
  memoryCandidates: z.array(memoryCandidateSchema).max(16).default([]),
  worth: z.boolean().optional(),
  worthMemory: z.boolean().default(false),
  worthKnowledge: z.boolean().default(false),
  isMeeting: z.boolean().default(false),
  storageTier: z.enum(["ephemeral", "standard", "important"]).default("standard"),
  confidence: z.number().min(0).max(1).default(0)
});

type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export type ActivityAnalysisOutcome =
  | { status: "analyzed"; analysis: ActivitySessionAnalysis; cached: boolean }
  | { status: "trivial"; analysis: ActivitySessionAnalysis }
  | { status: "blocked"; decision: ActivityAnalysisDecision }
  | { status: "skipped"; reason: "session_not_ended" | "no_model" }
  | { status: "error"; error: string };

export interface ActivityAnalyzerDeps {
  store: ActivityStore;
  policy: ActivityPrivacyPolicy;
  /**
   * 分析所用模型。省略（未配置模型）时只落「零星活动」占位，需要模型的 session 保持待分析；
   * 调用方据此区分「策略拒绝」与「没有模型可用」。
   */
  model?: AgentModel;
  signal?: AbortSignal;
  /** 可注入时钟，便于测试固定 analyzedAt 与「今天」。 */
  now?: () => Date;
}

export interface ActivitySweepResult {
  evaluated: number;
  analyzed: number;
  trivial: number;
  blocked: number;
  errors: number;
}

export interface ActivityReportRange {
  startIso: string;
  endIso: string;
  label: string;
}

export interface ActivityReportResult {
  date: string;
  startIso: string;
  endIso: string;
  markdown: string;
  /** 范围内可入报告的分析行数（已过滤零星/失败占位）。 */
  sessionCount: number;
  /** 本次调用新分析（含零星占位）的 session 数。 */
  analyzedNow: number;
  /** 范围内仍需模型但本次未分析的 session 数（策略拒绝或无可用模型）。 */
  pendingModel: number;
  /** 是否有 session 因策略拒绝或无模型而未分析。 */
  blocked: boolean;
  /** blocked 时携带的原因说明（策略消息或「未配置模型」）。 */
  message?: string;
}

const ANALYSIS_SYSTEM_PROMPT = [
  "You analyze one session of a user's on-screen activity and extract rich, citable structure for a later work-journal generator.",
  "Respond ONLY with a single JSON object — no prose, no markdown fence, no commentary.",
  "Schema:",
  '{',
  '  "worth": boolean,',
  '  "title": string,                     // <=80 chars, concrete and specific',
  '  "description": string,               // 2-4 factual sentences; no filler',
  '  "project": string | null,             // canonical project or workspace, null if unclear',
  '  "topics": string[],                  // 1-5 short tags',
  '  "highlights": string[],              // 0-3 short accomplishments or decisions',
  '  "entities": {',
  '    "prs": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],',
  '    "issues": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],',
  '    "commits": [{"label": string, "ref"?: string, "repo"?: string, "url"?: string}],',
  '    "people": [{"handle": string, "name"?: string}],',
  '    "identifiers": string[], "repos": string[], "versions": string[],',
  '    "events": string[], "decisions": string[], "urls": string[]',
  '  },',
  '  "memoryCandidates": [{"type": "project"|"feedback"|"reference"|"user", "content": string, "why": string}],',
  '  "worthKnowledge": boolean,',
  '  "isMeeting": boolean',
  '}',
  "Only use evidence in the event stream and redacted OCR. Do not invent people, identifiers, versions, PRs, issues, or URLs.",
  "Do not put ordinary activity, one-off reviews, code details, or debugging steps in memoryCandidates.",
  "The parser also accepts Biny compatibility fields summary, top-level entity arrays, storageTier, and confidence."
].join("\n");

/**
 * 分析单个已结束 session。幂等：输入 hash 未变时直接返回已落库结果，不重复调用模型。
 * 除 store 读取本身的故障外不向调用方抛错；模型/网络的瞬时失败返回 error 且不落库，
 * 让 session 保持待分析，等下一个周期重试。
 */
export async function analyzeActivitySession(
  deps: ActivityAnalyzerDeps,
  sessionId: string
): Promise<ActivityAnalysisOutcome> {
  const { store } = deps;
  const session = store.getEndedSession(sessionId);
  if (!session) return { status: "skipped", reason: "session_not_ended" };
  const events = store.listSessionEventSummaries(sessionId);
  const semanticEventCount = events.filter((event) => event.eventType !== "screenshot_ocr").length;
  const inputHash = activityAnalysisInputHash(events);
  const existing = store.getAnalysis(sessionId);
  if (existing && existing.inputHash === inputHash) {
    return { status: "analyzed", analysis: existing, cached: true };
  }
  const now = deps.now?.() ?? new Date();
  const analyzedAt = now.toISOString();

  if (
    session.durationMs < ACTIVITY_ANALYSIS_MIN_SESSION_DURATION_MS
    && semanticEventCount < ACTIVITY_ANALYSIS_MIN_EVENTS
    && session.snapshotCount < ACTIVITY_ANALYSIS_MIN_SNAPSHOTS
  ) {
    const analysis = buildTrivialAnalysis(session, semanticEventCount, analyzedAt, inputHash);
    store.recordAnalysis(analysis);
    return { status: "trivial", analysis };
  }
  if (!deps.model) return { status: "skipped", reason: "no_model" };
  const model = deps.model;
  const knownProjects = store.listRecentProjects(
    new Date(now.getTime() - KNOWN_PROJECT_LOOKBACK_MS).toISOString(),
    KNOWN_PROJECT_LIMIT
  );

  let parsed: AnalysisOutput;
  try {
    const run = await deps.policy.runAnalysis(model, async () => await requestSessionAnalysis(
      model,
      session,
      events,
      deps.signal
    ));
    if (run.status === "blocked") return { status: "blocked", decision: run.decision };
    if (!run.value) return { status: "error", error: "analysis returned no value" };
    parsed = run.value;
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }

  const entityDetails = normalizeEntityDetails(parsed);
  const genericEntities = Array.isArray(parsed.entities)
    ? parsed.entities
    : uniqueStrings([
      ...entityDetails.repos,
      ...entityDetails.identifiers,
      ...entityDetails.events,
      ...entityDetails.prs.flatMap(referenceEntityLabels),
      ...entityDetails.issues.flatMap(referenceEntityLabels),
      ...entityDetails.commits.flatMap(commitEntityLabels)
    ]);
  const summary = parsed.summary?.trim() || parsed.description?.trim() || parsed.title?.trim() || ACTIVITY_ANALYSIS_FAILED_SUMMARY;
  const memoryCandidates = parsed.memoryCandidates;
  const analysis: ActivitySessionAnalysis = {
    sessionId: session.id,
    analyzedAt,
    analyzerModel: model.modelId,
    project: normalizeProject(parsed.project, knownProjects),
    title: parsed.title?.trim() || deriveTitle(summary),
    description: parsed.description?.trim() || summary,
    summary,
    topics: parsed.topics,
    prs: entityDetails.prs,
    issues: entityDetails.issues,
    people: entityDetails.people,
    versions: entityDetails.versions,
    decisions: entityDetails.decisions,
    entities: genericEntities,
    highlights: parsed.highlights,
    commits: entityDetails.commits,
    identifiers: entityDetails.identifiers,
    repos: entityDetails.repos,
    events: entityDetails.events,
    urls: entityDetails.urls,
    entityDetails,
    memoryCandidates,
    // 根据候选数组判定 worthMemory；模型直接给出的 boolean 只兼容旧协议。
    worthMemory: memoryCandidates.length > 0,
    worthKnowledge: parsed.worthKnowledge,
    isMeeting: parsed.isMeeting,
    storageTier: parsed.storageTier,
    confidence: parsed.confidence,
    sourceEventCount: semanticEventCount,
    inputHash
  };
  store.recordAnalysis(analysis);
  return { status: "analyzed", analysis, cached: false };
}

/** 兜底 sweep：分析所有「已结束但还没分析行」的 session，按结束时间升序逐个处理。 */
export async function analyzePendingActivitySessions(
  deps: ActivityAnalyzerDeps,
  limit = 50
): Promise<ActivitySweepResult> {
  const pending = deps.store.listSessionsPendingAnalysis(limit);
  const result: ActivitySweepResult = { evaluated: pending.length, analyzed: 0, trivial: 0, blocked: 0, errors: 0 };
  for (const session of pending) {
    if (deps.signal?.aborted) break;
    try {
      const outcome = await analyzeActivitySession(deps, session.id);
      if (outcome.status === "analyzed") result.analyzed += 1;
      else if (outcome.status === "trivial") result.trivial += 1;
      else if (outcome.status === "blocked" || outcome.status === "skipped") result.blocked += 1;
      else if (outcome.status === "error") result.errors += 1;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

/**
 * 生成指定日期的工作日记。先补分析该日期内已结束但还没分析的 session（范围外的积压由
 * 周期 sweep 处理），再从分析表读取并按项目分组渲染成确定性 Markdown——不再过一次模型。
 */
export async function buildActivityReport(
  deps: ActivityAnalyzerDeps,
  date: string
): Promise<ActivityReportResult> {
  const now = deps.now?.() ?? new Date();
  const range = resolveActivityReportRange(date, now);
  const pending = deps.store.listSessionsPendingAnalysisForDateRange(range.startIso, range.endIso, 200);

  let analyzedNow = 0;
  let pendingModel = 0;
  let blocked = false;
  let message: string | undefined;
  for (const session of pending) {
    if (deps.signal?.aborted) break;
    const outcome = await analyzeActivitySession(deps, session.id);
    if (outcome.status === "analyzed" || outcome.status === "trivial") analyzedNow += 1;
    else if (outcome.status === "blocked") {
      blocked = true;
      pendingModel += 1;
      message = outcome.decision.message;
    } else if (outcome.status === "skipped" && outcome.reason === "no_model") {
      blocked = true;
      pendingModel += 1;
      message ??= "未配置可用的分析模型。";
    }
  }

  const rows = deps.store.listAnalysisForDateRange(range.startIso, range.endIso);
  return {
    date: range.label,
    startIso: range.startIso,
    endIso: range.endIso,
    markdown: renderActivityReport(rows, range.label),
    sessionCount: rows.filter(isReportableAnalysis).length,
    analyzedNow,
    pendingModel,
    blocked,
    message
  };
}

/**
 * 把一天的分析行渲染成可读的工作日记：按项目分组、组内按时间排，条目去重。
 * 确定性模板渲染——分析已是结构化数据，聚合不需要再过模型，也避免二次编造。
 */
export function renderActivityReport(rows: readonly ActivityAnalysisReportRow[], label: string): string {
  const title = `## ${label} 工作日记`;
  const reportable = rows.filter(isReportableAnalysis);
  if (!reportable.length) return `${title}\n\n（这一天没有已分析的活动记录。）`;

  const groups = new Map<string, ActivityAnalysisReportRow[]>();
  for (const row of reportable) {
    const key = row.project?.trim() || "未归类";
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  // 项目按当天最早一个 session 的开始时间排序，让日记读起来是时间推进的。
  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const a = left[1][0]?.sessionStartedAt ?? "";
    const b = right[1][0]?.sessionStartedAt ?? "";
    return a.localeCompare(b);
  });
  const sections = orderedGroups.map(([project, group]) => `### ${project}\n${renderProjectBullets(group)}`);
  return [title, "", ...sections].join("\n\n");
}

/**
 * 解析 activity_report 的日期参数。`today`/`yesterday` 相对当前本地时间，`YYYY-MM-DD`
 * 按本地日界解析；start/end 转回 ISO（UTC）用于和 started_at 的字典序比较。
 */
export function resolveActivityReportRange(date: string, now: Date = new Date()): ActivityReportRange {
  const trimmed = date.trim().toLowerCase();
  let base: Date;
  if (trimmed === "today") {
    base = now;
  } else if (trimmed === "yesterday") {
    base = new Date(now.getTime());
    base.setDate(base.getDate() - 1);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
    if (!match) {
      throw new Error(`无法识别的日期“${date}”。支持 today、yesterday 或 YYYY-MM-DD。`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    base = new Date(year, month - 1, day);
    // Date 构造对越界日期（如 2026-02-31）会进位成另一天而非得到 NaN，必须回读组件校验。
    if (base.getFullYear() !== year || base.getMonth() !== month - 1 || base.getDate() !== day) {
      throw new Error(`无效日期：${date}。`);
    }
  }
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString(), label: formatLocalDate(start) };
}

/** 输入指纹：版本 + 每条事件的时间、类型、应用、窗口、URL、摘要和已脱敏 OCR。 */
function activityAnalysisInputHash(events: readonly ActivityEventSummary[]): string {
  const hash = createHash("sha256");
  hash.update(ACTIVITY_ANALYSIS_VERSION);
  for (const event of events) {
    hash.update("\0");
    hash.update(event.occurredAt);
    hash.update(" ");
    hash.update(event.eventType ?? "");
    hash.update(" ");
    hash.update(event.application ?? "");
    hash.update(" ");
    hash.update(event.windowTitle ?? "");
    hash.update(" ");
    hash.update(event.url ?? "");
    hash.update(" ");
    hash.update(event.ocrText ?? "");
    hash.update(" ");
    hash.update(event.summary);
  }
  return hash.digest("hex");
}

function buildTrivialAnalysis(
  session: ActivityPendingAnalysisSession,
  sourceEventCount: number,
  analyzedAt: string,
  inputHash: string
): ActivitySessionAnalysis {
  return {
    sessionId: session.id,
    analyzedAt,
    analyzerModel: "none",
    title: "零星活动",
    description: ACTIVITY_TRIVIAL_SUMMARY,
    summary: ACTIVITY_TRIVIAL_SUMMARY,
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    memoryCandidates: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "ephemeral",
    confidence: 0,
    sourceEventCount,
    inputHash
  };
}

/**
 * 调用分析模型并强校验输出；解析/校验失败重试一次，再失败返回 confidence=0 的占位输出
 * （由调用方落库）。网络错误、中止等不在此兜底，直接抛给调用方保持「待分析」。
 */
async function requestSessionAnalysis(
  model: AgentModel,
  session: ActivityPendingAnalysisSession,
  events: readonly ActivityEventSummary[],
  signal: AbortSignal | undefined
): Promise<AnalysisOutput> {
  const prompt = buildAnalysisPrompt(session, events);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generateNativeText(model, nativeJsonMessages(ANALYSIS_SYSTEM_PROMPT, prompt), {
      signal,
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      reasoning: "off",
      timeoutMs: ANALYSIS_TIMEOUT_MS
    });
    try {
      const parsed = analysisOutputSchema.parse(parseNativeJson(result.text));
      if (!parsed.summary?.trim() && !parsed.title?.trim() && !parsed.description?.trim()) {
        throw new Error("analysis output is missing title, description, and summary");
      }
      return parsed;
    } catch {
      // 解析失败重试一次；第二次仍失败则落到下面的低置信度占位。
    }
  }
  return {
    project: null,
    title: "活动分析失败",
    description: ACTIVITY_ANALYSIS_FAILED_SUMMARY,
    summary: ACTIVITY_ANALYSIS_FAILED_SUMMARY,
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    commits: [],
    identifiers: [],
    repos: [],
    events: [],
    urls: [],
    memoryCandidates: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "ephemeral",
    confidence: 0
  };
}

/** 按四段结构组装事件、窗口标题、浏览器访问和已脱敏 OCR。 */
function buildAnalysisPrompt(
  session: ActivityPendingAnalysisSession,
  events: readonly ActivityEventSummary[]
): string {
  const semanticEvents = events.filter((event) => event.eventType !== "screenshot_ocr");
  const applications = uniqueStrings(
    semanticEvents
      .map((event) => event.application)
      .filter((value): value is string => Boolean(value))
  );
  const promptEvents = semanticEvents.slice(0, ACTIVITY_ANALYSIS_MAX_EVENTS_IN_PROMPT);
  const eventSample = formatEventSample(promptEvents);
  const windowTitleSample = formatWindowTitleSample(promptEvents);
  const browserVisitSample = formatBrowserVisitSample(promptEvents);
  const ocrTexts = dedupeOcrTexts(
    events
      .filter((event) => event.eventType === "screenshot_ocr")
      .map((event) => event.ocrText?.trim())
      .filter((value): value is string => Boolean(value))
  );
  const ocrPrompt = truncateOcrText(ocrTexts.join("\n---\n"), ACTIVITY_ANALYSIS_MAX_OCR_CHARS);
  return [
    `Session ${session.id}`,
    `Started: ${isoTimestamp(session.startedAt)}`,
    `Duration: ${String(Math.round(session.durationMs / 1_000))}s`,
    `Apps: ${applications.join(", ") || "(unknown)"}`,
    `Events: ${String(session.eventCount)}  Snapshots: ${String(session.snapshotCount)}`,
    "",
    "Event sample:",
    eventSample,
    "",
    ...(windowTitleSample ? ["Window titles (frontmost app state):", windowTitleSample, ""] : []),
    ...(browserVisitSample ? ["Browser visits (URL + tab title):", browserVisitSample, ""] : []),
    "OCR text (deduped across frames):",
    ocrPrompt || "(no OCR text)"
  ].join("\n");
}

function formatEventSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const eventType = event.eventType ?? "activity";
    if (eventType === "browser_visit" || eventType === "window_title") continue;
    const time = formatEventTime(event.occurredAt, 19);
    const application = event.application ? `[${event.application}]` : "";
    const kind = eventType === "click"
      ? "click"
      : eventType === "keypress"
        ? "key"
        : eventType === "app_focus"
          ? "focus"
          : eventType;
    lines.push([time, application, kind].filter(Boolean).join(" "));
  }
  return lines.slice(0, 40).join("\n");
}

function formatBrowserVisitSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  let previousUrl: string | undefined;
  for (const event of events) {
    if (event.eventType !== "browser_visit" || !event.url || event.url === previousUrl) continue;
    previousUrl = event.url;
    const title = browserVisitTitle(event, events);
    const titleSuffix = title ? `  —  ${title.slice(0, 140)}` : "";
    lines.push(`${formatEventTime(event.occurredAt, 16)} ${event.url}${titleSuffix}`);
    if (lines.length >= 30) break;
  }
  return lines.join("\n");
}

function formatWindowTitleSample(events: readonly ActivityEventSummary[]): string {
  const lines: string[] = [];
  let previousKey: string | undefined;
  for (const event of events) {
    if (event.eventType !== "window_title") continue;
    const title = event.windowTitle?.trim();
    if (!title) continue;
    const key = `${event.application ?? ""}||${title}`;
    if (key === previousKey) continue;
    previousKey = key;
    lines.push(`${formatEventTime(event.occurredAt, 16)} [${event.application ?? "?"}] ${title.slice(0, 180)}`);
    if (lines.length >= 40) break;
  }
  return lines.join("\n");
}

function browserVisitTitle(event: ActivityEventSummary, events: readonly ActivityEventSummary[]): string | undefined {
  const directTitle = event.windowTitle?.trim();
  if (directTitle) return directTitle;
  return events.find((candidate) => candidate.eventType === "window_title"
    && candidate.occurredAt === event.occurredAt
    && candidate.application === event.application)?.windowTitle?.trim();
}

function formatEventTime(value: string, end: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(11, end) : value;
}

function isoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

/** OCR 相邻帧高度重复；只和上一帧比较，保持既定的时序去重语义。 */
function dedupeOcrTexts(texts: readonly string[]): string[] {
  const result: string[] = [];
  let previous: string | undefined;
  for (const text of texts) {
    if (previous !== undefined && textSimilarity(previous, text) > 0.9) continue;
    result.push(text);
    previous = text;
  }
  return result;
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = new Set(left.toLocaleLowerCase().split(/\s+/u).filter(Boolean));
  const rightTokens = new Set(right.toLocaleLowerCase().split(/\s+/u).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function truncateOcrText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… [truncated]`;
}

function normalizeProject(project: string | null | undefined, knownProjects: readonly string[]): string | undefined {
  const trimmed = project?.trim();
  if (!trimmed) return undefined;
  // 归一化：模型若写出了已知项目的大小写/空格变体，归一到已存储的写法，避免同一项目多个名字。
  const known = knownProjects.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  return known ?? trimmed;
}

function normalizeEntityDetails(output: AnalysisOutput): ActivityAnalysisEntityDetails {
  const grouped = Array.isArray(output.entities) ? undefined : output.entities;
  const prs = output.prs.length ? output.prs : grouped?.prs ?? [];
  const issues = output.issues.length ? output.issues : grouped?.issues ?? [];
  const commits = output.commits.length ? output.commits : grouped?.commits ?? [];
  const people = output.people.length ? output.people : grouped?.people ?? [];
  return {
    prs,
    issues,
    commits,
    people: normalizePeople(people),
    identifiers: output.identifiers.length ? output.identifiers : grouped?.identifiers ?? [],
    repos: output.repos.length ? output.repos : grouped?.repos ?? [],
    versions: output.versions.length ? output.versions : grouped?.versions ?? [],
    events: output.events.length ? output.events : grouped?.events ?? [],
    decisions: output.decisions.length ? output.decisions : grouped?.decisions ?? [],
    urls: output.urls.length ? output.urls : grouped?.urls ?? []
  };
}

type AnalysisPerson = z.infer<typeof analysisPersonSchema>;

function normalizePeople(values: readonly AnalysisPerson[]): string[] {
  return uniqueStrings(values.map((value) => {
    if (typeof value === "string") return value;
    const name = value.name?.trim();
    return name ? `${value.handle} (${name})` : value.handle;
  }));
}

function referenceEntityLabels(reference: ActivityAnalysisReference): string[] {
  return [reference.label, reference.ref, reference.repo, reference.title, reference.url]
    .filter((value): value is string => Boolean(value));
}

function commitEntityLabels(commit: ActivityAnalysisCommit): string[] {
  return [commit.label, commit.ref, commit.repo, commit.hash, commit.message, commit.url]
    .filter((value): value is string => Boolean(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function deriveTitle(summary: string): string {
  const firstSentence = summary.split(/[。.!?！？]/u, 1)[0]?.trim() || summary.trim();
  return firstSentence.slice(0, 240);
}

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

function isReportableAnalysis(row: ActivityAnalysisReportRow): boolean {
  const itemCount = row.topics.length + row.prs.length + row.issues.length + row.decisions.length
    + row.people.length + row.versions.length + row.highlights.length + row.entities.length;
  if (itemCount > 0) return true;
  if (row.title?.trim() && !PLACEHOLDER_SUMMARIES.has(row.title.trim())) return true;
  return row.summary.trim().length > 0 && !PLACEHOLDER_SUMMARIES.has(row.summary);
}

function renderProjectBullets(group: readonly ActivityAnalysisReportRow[]): string {
  const bullets: string[] = [];
  const seen = new Set<string>();
  const push = (text: string): void => {
    const normalized = text.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    bullets.push(`- ${normalized}`);
  };
  // group 已按 session 开始时间升序；条目按时间顺序去重合并。
  for (const row of group) {
    const marker = row.isMeeting ? " 📅" : "";
    const titleLead = row.title?.trim() && !PLACEHOLDER_SUMMARIES.has(row.title.trim())
      ? `${row.title.trim()}${row.description?.trim() && row.description.trim() !== row.title.trim() ? `：${row.description.trim()}` : ""}`
      : undefined;
    const leads = row.topics.length
      ? row.topics
      : titleLead ? [titleLead] : row.summary.trim() && !PLACEHOLDER_SUMMARIES.has(row.summary) ? [row.summary] : [];
    for (const topic of leads) push(`${topic}${marker}`);
    for (const pr of row.prs) push(formatReference("PR", pr));
    for (const issue of row.issues) push(formatReference("Issue", issue));
    for (const decision of row.decisions) push(`决策：${decision}`);
    for (const highlight of row.highlights) push(`亮点：${highlight}`);
    if (row.worthKnowledge) push("知识沉淀：值得记录");
    if (row.people.length) push(`涉及：${row.people.join("、")}`);
    if (row.versions.length) push(`版本：${row.versions.join("、")}`);
  }
  return bullets.join("\n");
}

function formatReference(kind: "PR" | "Issue", reference: ActivityAnalysisReference): string {
  const parts: string[] = [kind];
  if (reference.repo && reference.ref) parts.push(`${reference.repo}#${reference.ref}`);
  else if (reference.repo && reference.number !== undefined) parts.push(`${reference.repo}#${String(reference.number)}`);
  else if (reference.ref) parts.push(reference.ref);
  else if (reference.number !== undefined) parts.push(`#${String(reference.number)}`);
  else if (reference.repo) parts.push(reference.repo);
  else if (reference.label) parts.push(reference.label);
  const head = parts.join(" ");
  const detail = reference.title ?? (reference.label && parts.length > 1 ? "" : reference.url ?? "");
  return detail ? `${head} ${detail}` : head;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
