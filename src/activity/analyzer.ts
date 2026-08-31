/**
 * Activity 分析层：把单个已结束 session 的脱敏事件摘要归纳成结构化 SessionAnalysis 落库，
 * 并把指定日期的分析结果聚合成一份确定性的「打工日记」。
 *
 * 隐私边界（与 privacyPolicy 的注释一一对应）：
 * - 送给分析模型的只有 store.listSessionEventSummaries 提供的 occurredAt/summary/application
 *   三列，它们在写入 SQLite 前已经过了 redactActivityText。截图、OCR 原文、snapshot 路径
 *   从查询层就不在这条链路上，任何策略下都不出设备。
 * - 是否放行由 ActivityPrivacyPolicy 的 analysis 维度（analysisPolicy）统一决定；未放行时
 *   runAnalysis 不执行回调，对应 session 保持「待分析」，等策略放开后由 sweep 补分析。
 * - 心跳空 session（事件数 < ACTIVITY_ANALYSIS_MIN_EVENTS）不调用模型，直接落一条低置信度
 *   占位记录，避免每个 30s 空闲 session 都叫醒一次模型。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../llm/nativeJson.js";
import type { ActivityAnalysisDecision, ActivityPrivacyPolicy } from "./privacyPolicy.js";
import type {
  ActivityAnalysisReference,
  ActivityAnalysisReportRow,
  ActivityEventSummary,
  ActivityPendingAnalysisSession,
  ActivitySessionAnalysis,
  ActivityStore
} from "./store.js";

/** 事件数低于该阈值的 session 不值得烧 token，直接记「零星活动」。 */
export const ACTIVITY_ANALYSIS_MIN_EVENTS = 3;
/** 单个 session 送给分析模型的输入预算（token），超出按时间等比采样并保留首尾。 */
export const ACTIVITY_ANALYSIS_MAX_INPUT_TOKENS = 2_000;
/** 心跳/零星 session 的占位摘要；报告渲染会把这类占位过滤掉。 */
export const ACTIVITY_TRIVIAL_SUMMARY = "零星活动";
/** 模型两次输出都无法解析时落库的占位摘要；同样不进报告。 */
export const ACTIVITY_ANALYSIS_FAILED_SUMMARY = "活动分析失败";

const ANALYSIS_MAX_OUTPUT_TOKENS = 1_200;
const ANALYSIS_TIMEOUT_MS = 60_000;
const KNOWN_PROJECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_PROJECT_LIMIT = 20;
/** 进入 inputHash 的 prompt/解析版本；改动它会让已分析 session 因 hash 变化而重跑。 */
const ACTIVITY_ANALYSIS_VERSION = "activity-session-analysis/v1";

const analysisReferenceSchema = z.object({
  repo: z.string().trim().min(1).max(200).optional(),
  number: z.number().int().positive().optional(),
  url: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().min(1).max(300).optional()
});

/** 模型输出的强校验契约；数组字段给默认值，summary 缺失视为解析失败。 */
const analysisOutputSchema = z.object({
  project: z.string().trim().min(1).max(120).nullish(),
  summary: z.string().trim().min(1).max(1_000),
  topics: z.array(z.string().trim().min(1).max(300)).max(32).default([]),
  prs: z.array(analysisReferenceSchema).max(32).default([]),
  issues: z.array(analysisReferenceSchema).max(32).default([]),
  people: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
  versions: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  decisions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  entities: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  highlights: z.array(z.string().trim().min(1).max(300)).max(16).default([]),
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
  "你是本地活动分析器，把一段已脱敏的屏幕活动事件流归纳成结构化的工作记录。",
  "只输出一个 JSON 对象，不要代码围栏，不要任何额外文字。字段：",
  '- project: string|null 归一化项目名；优先复用给出的已知项目名，无法判断用 null',
  '- summary: string 一句话概括这个 session 在做什么',
  '- topics: string[] 具体做了哪些事，每条一个短句',
  '- prs/issues: [{"repo"?,"number"?,"url"?,"title"?}] 只填事件流里明确出现的 PR / issue',
  '- people: string[] 出现的 @人 或同事',
  '- versions: string[] 出现的版本号（如 v2.4.1）',
  '- decisions: string[] 做过的决定',
  '- entities: string[] 提到的具体实体（项目、库、服务、文件/页面名等），不是人名或版本号',
  '- highlights: string[] 1-3 条值得记住的高光/产出，短句',
  '- worthMemory: boolean 这个 session 是否值得写进长期记忆（重要决定/产出/事实）',
  '- worthKnowledge: boolean 是否值得沉淀为可复用的知识（新流程/踩坑/架构结论）',
  '- isMeeting: boolean 是否是会议/沟通（视频、语音、聊天窗口）',
  '- storageTier: "ephemeral"|"standard"|"important" 存储档位；普通工作用 standard，琐碎用 ephemeral，高价值产出用 important',
  '- confidence: number 0-1，证据不足就给低分',
  '规则：只根据可见事件填写，绝不编造 PR 号、人名或版本号；事件流里没有截图或 OCR 原文，也不要假设它们的内容。'
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
  const inputHash = activityAnalysisInputHash(events);
  const existing = store.getAnalysis(sessionId);
  if (existing && existing.inputHash === inputHash) {
    return { status: "analyzed", analysis: existing, cached: true };
  }
  const now = deps.now?.() ?? new Date();
  const analyzedAt = now.toISOString();

  if (events.length < ACTIVITY_ANALYSIS_MIN_EVENTS) {
    const analysis = buildTrivialAnalysis(session, events.length, analyzedAt, inputHash);
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
      knownProjects,
      deps.signal
    ));
    if (run.status === "blocked") return { status: "blocked", decision: run.decision };
    if (!run.value) return { status: "error", error: "analysis returned no value" };
    parsed = run.value;
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }

  const analysis: ActivitySessionAnalysis = {
    sessionId: session.id,
    analyzedAt,
    analyzerModel: model.modelId,
    project: normalizeProject(parsed.project, knownProjects),
    summary: parsed.summary,
    topics: parsed.topics,
    prs: parsed.prs,
    issues: parsed.issues,
    people: parsed.people,
    versions: parsed.versions,
    decisions: parsed.decisions,
    entities: parsed.entities,
    highlights: parsed.highlights,
    worthMemory: parsed.worthMemory,
    worthKnowledge: parsed.worthKnowledge,
    isMeeting: parsed.isMeeting,
    storageTier: parsed.storageTier,
    confidence: parsed.confidence,
    sourceEventCount: events.length,
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
  const pending = deps.store.listSessionsPendingAnalysis(50)
    .filter((session) => session.startedAt >= range.startIso && session.startedAt < range.endIso);

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

/** 输入指纹：版本 + 每条事件的 occurredAt/summary/application。输入或 prompt 版本变了才重分析。 */
function activityAnalysisInputHash(events: readonly ActivityEventSummary[]): string {
  const hash = createHash("sha256");
  hash.update(ACTIVITY_ANALYSIS_VERSION);
  for (const event of events) {
    hash.update("\0");
    hash.update(event.occurredAt);
    hash.update(" ");
    hash.update(event.application ?? "");
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
    summary: ACTIVITY_TRIVIAL_SUMMARY,
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
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
  knownProjects: readonly string[],
  signal: AbortSignal | undefined
): Promise<AnalysisOutput> {
  const prompt = buildAnalysisPrompt(session, events, knownProjects);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generateNativeText(model, nativeJsonMessages(ANALYSIS_SYSTEM_PROMPT, prompt), {
      signal,
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      reasoning: "off",
      timeoutMs: ANALYSIS_TIMEOUT_MS
    });
    try {
      return analysisOutputSchema.parse(parseNativeJson(result.text));
    } catch {
      // 解析失败重试一次；第二次仍失败则落到下面的低置信度占位。
    }
  }
  return {
    project: null,
    summary: ACTIVITY_ANALYSIS_FAILED_SUMMARY,
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "ephemeral",
    confidence: 0
  };
}

/** 只组装 occurredAt/summary/application 三列；超预算时按时间等比采样并保留首尾。 */
function buildAnalysisPrompt(
  session: ActivityPendingAnalysisSession,
  events: readonly ActivityEventSummary[],
  knownProjects: readonly string[]
): string {
  const applications = [...new Set(events.map((event) => event.application).filter((value): value is string => Boolean(value)))];
  const durationMin = Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000));
  const lines = sampleEventLines(events, ACTIVITY_ANALYSIS_MAX_INPUT_TOKENS);
  return [
    `session 开始：${session.startedAt}`,
    `session 结束：${session.endedAt}`,
    `时长：约 ${String(durationMin)} 分钟`,
    `涉及应用：${applications.join("、") || "未知"}`,
    `事件数：${String(events.length)}`,
    knownProjects.length ? `已知项目名（优先复用）：${knownProjects.join("、")}` : "已知项目名：无",
    "",
    "事件流（[时间] (应用) 摘要）：",
    ...lines
  ].join("\n");
}

function formatEventLine(event: ActivityEventSummary): string {
  return `[${event.occurredAt}]${event.application ? ` (${event.application})` : ""} ${event.summary}`;
}

function sampleEventLines(events: readonly ActivityEventSummary[], maxTokens: number): string[] {
  const lines = events.map(formatEventLine);
  if (estimateTokens(lines.join("\n")) <= maxTokens) return lines;
  // 预算不足：逐步加大采样间隔直到落入预算；首条（i=0）恒在采样点上，末条单独补齐。
  for (let stride = 2; stride <= lines.length; stride += 1) {
    const picked: string[] = [];
    for (let index = 0; index < lines.length; index += stride) picked.push(lines[index]!);
    const last = lines[lines.length - 1]!;
    if (picked[picked.length - 1] !== last) picked.push(last);
    if (estimateTokens(picked.join("\n")) <= maxTokens) return picked;
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  return first === undefined ? [] : last === undefined || first === last ? [first] : [first, last];
}

function normalizeProject(project: string | null | undefined, knownProjects: readonly string[]): string | undefined {
  const trimmed = project?.trim();
  if (!trimmed) return undefined;
  // 归一化：模型若写出了已知项目的大小写/空格变体，归一到已存储的写法，避免同一项目多个名字。
  const known = knownProjects.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  return known ?? trimmed;
}

const PLACEHOLDER_SUMMARIES = new Set([ACTIVITY_TRIVIAL_SUMMARY, ACTIVITY_ANALYSIS_FAILED_SUMMARY]);

function isReportableAnalysis(row: ActivityAnalysisReportRow): boolean {
  const itemCount = row.topics.length + row.prs.length + row.issues.length + row.decisions.length
    + row.people.length + row.versions.length + row.highlights.length + row.entities.length;
  if (itemCount > 0) return true;
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
    const leads = row.topics.length
      ? row.topics
      : row.summary.trim() && !PLACEHOLDER_SUMMARIES.has(row.summary) ? [row.summary] : [];
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
  if (reference.repo && reference.number !== undefined) parts.push(`${reference.repo}#${String(reference.number)}`);
  else if (reference.number !== undefined) parts.push(`#${String(reference.number)}`);
  else if (reference.repo) parts.push(reference.repo);
  const head = parts.join(" ");
  const detail = reference.title ?? reference.url ?? "";
  return detail ? `${head} ${detail}` : head;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
