/**
 * activity_digest 工具模块。
 *
 * 与 activity_report 的分工：report 是「某一天的结构化打工日记」（需要时补分析、按项目分组）；
 * digest 是「最近 N 分钟的浅时间线」，刻意不补分析（不烧模型）——已分析的 session 用
 * project+summary+topics 一行带过，还没分析的直接退化展示脱敏事件摘要并标注「未分析」，
 * 让「我刚才在干嘛」在 session 刚结束、分析还在途时也能立刻回答。
 *
 * 读取的全部是 store 查询层提供的脱敏 occurredAt/summary/application，截图与 OCR 原文
 * 从查询层就不在这条链路上。执行后若有可用记忆库，顺手同步 worth_memory=1 的 analysis
 * 行成记忆条目（幂等，重复调用不产生重复记忆）。
 */
import { z } from "zod";
import { buildActivityDigest, type ActivityDigestResult } from "../../activity/digest.js";
import { syncWorthwhileActivityMemories } from "../../activity/memorySync.js";
import { ActivityStore } from "../../activity/store.js";
import type { ActivitySettings } from "../../activity/settings.js";
import type { LocalMemory } from "../../agent/context/LocalMemory.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface ActivityDigestArgs {
  lookbackMin?: number;
}

export interface ActivityDigestToolDeps {
  /** 读取最新的 activity 设置（存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
  /** worthMemory 同步的目标记忆库；缺省时只读分析、不同步记忆。 */
  getMemory?(): LocalMemory | undefined;
  /** 可注入时钟，便于测试固定「现在」。 */
  now?(): Date;
}

export function createActivityDigestTool(deps: ActivityDigestToolDeps): Tool<ActivityDigestArgs, string> {
  return {
    name: "activity_digest",
    description: [
      "Render a shallow chronological timeline of the user's recent recorded on-device activity (last two hours by default).",
      "Use it when the user asks what they were just doing (e.g. \"我刚才在干嘛\") or wants a quick recent recap.",
      "It never analyzes on the fly: sessions without an analysis row fall back to their redacted event summaries and are marked 未分析.",
      "Reads only redacted on-device event summaries; screenshots and OCR text never leave the device."
    ].join(" "),
    promptSnippet: "Render a recent short activity timeline (what was I just doing)",
    promptGuidelines: [
      "Use activity_digest for \"我刚才在干嘛\" or a quick recap of the last minutes/hours; activity_report is for a dated per-project work diary",
      "activity_digest does not analyze new sessions; recent unfinished analysis shows as 未分析"
    ],
    parameters: {
      type: "object",
      properties: {
        lookbackMin: {
          type: "number",
          minimum: 1,
          maximum: 1_440,
          description: "How many minutes of activity to include (default 120)."
        }
      },
      additionalProperties: false
    },
    schema: z.object({
      lookbackMin: z.number().int().min(1).max(1_440).optional()
    }),
    capability: "activity.digest",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "生成近期活动时间线" },
        description: "Build a recent activity digest timeline",
        approvalRule: "activity_digest",
        async execute({ signal }) {
          const settings = await deps.loadSettings();
          const store = new ActivityStore();
          await store.open(settings.outputDirectory);
          try {
            const result = await buildActivityDigest({
              store,
              lookbackMin: args.lookbackMin,
              now: deps.now
            });
            const memory = deps.getMemory?.();
            if (memory) {
              await syncWorthwhileActivityMemories({
                store,
                memory,
                signal,
                now: deps.now
              }).catch(() => undefined);
            }
            return result.markdown;
          } finally {
            await store.close();
          }
        }
      };
    }
  };
}

/** digest 业务结果的可序列化形态，供测试与桌面侧复用。 */
export type ActivityDigestToolResult = ActivityDigestResult;