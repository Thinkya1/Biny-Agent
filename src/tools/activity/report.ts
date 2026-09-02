/**
 * activity_report 工具模块。
 *
 * 这是 Activity 进入主动报告模型的入口，取代旧的「把脱敏事件被动注入每个回合」做法：模型只在
 * 用户明确询问「我今天/某天做了什么」时主动拉取一份按项目分组的打工日记。读取的是分析层已
 * 落库的结构化结果，必要时才补分析——整条链路只接触脱敏的 occurredAt/summary/application
 * 和受控的 OCR 投影，截图文件、原始 OCR 和输入键值从查询层就不在模型输入里。
 *
 * 是否用当前聊天模型补分析由 ActivityPrivacyPolicy 的 analysis 维度决定：外部模型默认需要
 * 用户在设置页确认，未放行时报告只渲染已分析的部分并说明原因，绝不降级到别的模型。
 */
import { z } from "zod";
import type { AgentModel } from "../../agent/core/types.js";
import { buildActivityReport, resolveActivityReportRange, type ActivityReportResult } from "../../activity/analyzer.js";
import { ActivityPrivacyPolicy } from "../../activity/privacyPolicy.js";
import { ActivityStore } from "../../activity/store.js";
import type { ActivitySettings } from "../../activity/settings.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface ActivityReportArgs {
  date?: string;
}

/** 同一日期报告结果的短 TTL 缓存：避免模型在会话里反复问「今天干了啥」时重复补分析烧 token。 */
export interface ActivityReportCache {
  get(dateLabel: string): ActivityReportResult | undefined;
  set(dateLabel: string, result: ActivityReportResult): void;
}

export interface ActivityReportToolDeps {
  /** 取当前聊天模型；未配置时返回 undefined，报告只渲染已分析的数据。 */
  getModel(): AgentModel | undefined;
  /** 读取最新的 activity 设置（策略与存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
  /** 报告结果缓存；缺省时用进程内 10 分钟 TTL 的默认缓存。 */
  cache?: ActivityReportCache;
  /** 可注入时钟，便于测试固定「今天」。 */
  now?: () => Date;
}

/** `date` 参数 → 规范化日期 label（today/yesterday 按注入时钟解析）。 */
function resolveReportDateLabel(date: string, now: Date): string {
  return resolveActivityReportRange(date, now).label;
}

/** 进程内默认缓存：按规范化日期 key，TTL 默认 10 分钟。 */
export function createInMemoryActivityReportCache(ttlMs = 600_000): ActivityReportCache {
  const entries = new Map<string, { at: number; result: ActivityReportResult }>();
  return {
    get(dateLabel) {
      const entry = entries.get(dateLabel);
      if (!entry) return undefined;
      if (Date.now() - entry.at >= ttlMs) {
        entries.delete(dateLabel);
        return undefined;
      }
      return entry.result;
    },
    set(dateLabel, result) {
      entries.set(dateLabel, { at: Date.now(), result });
    }
  };
}

export function createActivityReportTool(deps: ActivityReportToolDeps): Tool<ActivityReportArgs, string> {
  return {
    name: "activity_report",
    description: [
      "Summarize the user's recorded on-device screen activity into a dated work diary, grouped by project.",
      "Use it when the user asks what they worked on, wants to recap a day, or recalls past activity.",
      "It reads only redacted on-device event summaries (application, window, timestamp); original screenshots and unredacted OCR never leave the device.",
      "Analyzing sessions that have no result yet uses the current chat model only when the activity privacy policy allows it; otherwise the report covers what is already analyzed and explains why."
    ].join(" "),
    promptSnippet: "Summarize recorded on-device activity into a dated work diary",
    promptGuidelines: [
      "Use activity_report when the user asks what they worked on or wants a recap of a specific day; pass date as \"today\", \"yesterday\", or YYYY-MM-DD (default today)"
    ],
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          minLength: 1,
          maxLength: 40,
          description: "Which day to summarize: \"today\", \"yesterday\", or a YYYY-MM-DD date. Defaults to today."
        }
      },
      additionalProperties: false
    },
    schema: z.object({
      date: z.string().trim().min(1).max(40).optional()
    }),
    capability: "activity.report",
    risk: "read",
    resolveExecution(args) {
      const date = args.date ?? "today";
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `生成 ${date} 的活动日记` },
        description: `Build the local activity work diary for ${date}`,
        approvalRule: "activity_report",
        async execute({ signal }) {
          const settings = await deps.loadSettings();
          const policy = new ActivityPrivacyPolicy(settings);
          const now = deps.now?.() ?? new Date();
          // 用独立连接读分析表并补分析，避免长时间模型调用占用采集器自己的那条写连接。
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            const cache = deps.cache ?? defaultActivityReportCache;
            // 缓存必须同时受原始事件、分析输入、模型和策略影响；否则今天新增活动或模型切换后，
            // 仍会返回旧日报。第一次补分析会改变 analysis revision，因此 set 使用补分析后的 key。
            const dateLabel = resolveReportDateLabel(date, now);
            const model = deps.getModel();
            const cacheKey = reportCacheKey(dateLabel, settings, model, store.activityRevision());
            const cached = cache.get(cacheKey);
            const result = cached ?? await buildActivityReport({
              store,
              policy,
              model,
              signal,
              now: deps.now
            }, dateLabel);
            if (!cached) cache.set(reportCacheKey(dateLabel, settings, model, store.activityRevision()), result);
            return formatReportToolResult(result);
          } finally {
            await store.close();
          }
        }
      };
    }
  };
}

function reportCacheKey(
  dateLabel: string,
  settings: ActivitySettings,
  model: AgentModel | undefined,
  revision: string
): string {
  return [
    dateLabel,
    revision,
    settings.analysisPolicy,
    settings.analysisExternalConfirmed ? "confirmed" : "unconfirmed",
    settings.analysisModel ?? "follow-current",
    model?.provider ?? "no-model",
    model?.modelId ?? "",
    model?.runtime ?? "",
    model?.dataResidency ?? ""
  ].join("\u0000");
}

/** 工具模块级共享的默认缓存：未注入 cache 时所有 activity_report 调用共用同一个 10 分钟 TTL。 */
const defaultActivityReportCache = createInMemoryActivityReportCache();

/** 工具结果用纯文本（markdown 日记 + 必要的策略说明），让模型直接读到可转述的内容。 */
function formatReportToolResult(result: ActivityReportResult): string {
  const notes: string[] = [];
  if (result.blocked && result.message) notes.push(result.message);
  if (result.pendingModel > 0) {
    notes.push(`还有 ${String(result.pendingModel)} 个已结束会话尚未分析（策略未放行或没有可用模型），上面的日记只覆盖已分析的部分。`);
  }
  return [result.markdown, ...notes].join("\n\n");
}
