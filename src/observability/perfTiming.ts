/**
 * 「发送消息 → 首个模型输出」链路的耗时打点（纯诊断用）。
 *
 * 设置环境变量 BINY_PERF_TIMING=1 后，各阶段耗时以 JSONL 追加到 `<workspace>/.biny/perf.jsonl`；
 * 未开启时每个打点只是一次环境变量读取，开销可忽略。写入失败一律吞掉——诊断不能影响被测路径。
 *
 * 分析方式：按 runId 分组、按 t 排序，相邻阶段的 t 差就是无打点区间（如模型请求建连）的耗时。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

let defaultWorkspaceRoot: string | undefined;
let ensuredDir: string | undefined;

/** 进程级默认 workspace：Runtime Host / AgentSession 装配时设置一次，之后的打点可省略 root。 */
export function setPerfTimingRoot(workspaceRoot: string): void {
  defaultWorkspaceRoot = workspaceRoot;
}

export function perfTimingEnabled(): boolean {
  const value = process.env.BINY_PERF_TIMING;
  return value !== undefined && value !== "" && value !== "0";
}

/** 阶段起点。统一走 performance.now()，避免 Date 精度在短阶段上失真。 */
export function perfNow(): number {
  return performance.now();
}

export function recordPerfPhase(
  phase: string,
  startedAtMs: number,
  detail?: Record<string, string | number | boolean | undefined>,
  workspaceRoot?: string
): void {
  if (!perfTimingEnabled()) return;
  const root = workspaceRoot ?? defaultWorkspaceRoot;
  if (!root) return;
  try {
    const dir = path.join(root, ".biny");
    if (ensuredDir !== dir) {
      mkdirSync(dir, { recursive: true });
      ensuredDir = dir;
    }
    const line = JSON.stringify({
      t: new Date().toISOString(),
      phase,
      ms: Math.round((performance.now() - startedAtMs) * 10) / 10,
      ...detail
    });
    appendFileSync(path.join(dir, "perf.jsonl"), `${line}\n`);
  } catch {
    // 诊断写入失败不影响主路径。
  }
}
