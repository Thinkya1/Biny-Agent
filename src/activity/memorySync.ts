/**
 * worthMemory → 记忆写的协调模块。
 *
 * 分析层只在 activity_session_analysis 上打 worth_memory 标记（分析是纯数据操作，不依赖
 * 记忆库）；这里把已标记的 analysis 行同步成 LocalMemory 条目。语义上完全可重入：
 * 存储层按「同 topic + 内容等价」去重，重复同步返回 written=false 且不推进 revision，
 * 因此周期 sweep 与工具调用各自跑一遍也不会产生重复记忆。
 *
 * 记忆条目来自分析结果（project/summary/topics/highlights/decisions），分析阶段已决定哪些
 * 内容值得沉淀；写入前仍然经过 memoryStorage 的格式、来源和长度校验，不再盲目改写正文。
 * lineage 复用 completed_task（当前记忆格式里唯一面向「由已完成工作派生」的机器来源），
 * externalContext=false，sessionId 指向来源 session，方便回溯。
 */
import type { MemoryEntryInput } from "../agent/context/memoryTypes.js";
import { withFreshRevision } from "../agent/context/LocalMemory.js";
import type { LocalMemory } from "../agent/context/LocalMemory.js";
import type { ActivitySessionAnalysis, ActivityStore } from "./store.js";

export interface ActivityMemorySyncDeps {
  store: ActivityStore;
  memory: LocalMemory;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ActivityMemorySyncResult {
  evaluated: number;
  written: number;
  skipped: number;
  failed: number;
}

/** 把 analysis 表里 worth_memory=1 的 session 同步成记忆条目，返回本次处理统计。 */
export async function syncWorthwhileActivityMemories(
  deps: ActivityMemorySyncDeps,
  limit = 50
): Promise<ActivityMemorySyncResult> {
  const rows = deps.store.listWorthMemoryAnalyses(limit);
  const result: ActivityMemorySyncResult = { evaluated: 0, written: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    if (deps.signal?.aborted) break;
    result.evaluated += 1;
    try {
      const written = await writeAnalysisMemory(deps, row);
      if (written) {
        result.written += 1;
      } else {
        result.skipped += 1; // 已存在等价条目或摘要过短，视为正常幂等跳过。
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function writeAnalysisMemory(
  deps: ActivityMemorySyncDeps,
  analysis: ActivitySessionAnalysis
): Promise<boolean> {
  const input = buildMemoryEntry(analysis);
  const result = await withFreshRevision(deps.memory, deps.signal, async (expectedRevision) => (
    await deps.memory.writeEntry(input, {
      expectedRevision,
      signal: deps.signal,
      now: deps.now?.()
    })
  ));
  return result.written;
}

function buildMemoryEntry(analysis: ActivitySessionAnalysis): MemoryEntryInput {
  const project = analysis.project?.trim() ? ` [${analysis.project.trim()}]` : "";
  const highlights = analysis.highlights.length
    ? analysis.highlights.map((highlight) => `- ${highlight.trim()}`)
    : [analysis.summary.trim()];
  const summaryParts = [
    analysis.summary.trim(),
    ...highlights,
    ...(analysis.topics.length ? ["Topics: " + analysis.topics.map((topic) => topic.trim()).join(" / ")] : [])
  ];
  const summary = summaryParts.join("\n").slice(0, 2_000);
  return {
    audience: "workspace",
    kind: analysis.decisions.length > 0 ? "decision" : "fact",
    topic: analysisMemoryTopic(analysis.sessionId),
    title: `${analysisMemoryTitle(analysis)}${project}`.slice(0, 120),
    summary,
    decisions: analysis.decisions,
    keywords: analysis.topics.slice(0, 8),
    importance: analysis.storageTier === "important" ? 4 : 3,
    lineage: {
      source: "completed_task",
      externalContext: false,
      sessionId: analysis.sessionId
    }
  };
}

function analysisMemoryTopic(sessionId: string): string {
  return `activity-${sessionId}`;
}

function analysisMemoryTitle(analysis: ActivitySessionAnalysis): string {
  // 标题取 summary 前段并在 60 字内截断；太长会被 memoryFormat 再压到 120。
  return analysis.summary.trim().replace(/\s+/gu, " ").slice(0, 60);
}
