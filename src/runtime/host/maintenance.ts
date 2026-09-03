/**
 * Runtime Host 的后台业务维护边界。
 *
 * 记忆整理和 embedding 派生索引都属于 owner 侧业务组合，不应由 socket Server
 * 持有计时器和 AbortController。这里也只通过 getter 访问 runtime/commands，支持 runtime 重建后
 * 继续使用新的 AgentSession。
 */
import type { AgentRuntimeUpdate } from "../agentEvents.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import type { MemoryEntry, MemoryMaintenanceStatus, MemorySleepPreview, MemorySleepRun } from "../../agent/context/memoryTypes.js";
import { runtimeHostMemoryMaintenanceIntervalMs } from "./protocol.js";

export interface RuntimeHostMemoryMaintenance {
  start(): void;
  stop(): void;
  handleRuntimeUpdate(update: AgentRuntimeUpdate): void;
  scheduleEmbeddingRebuild(): void;
  runNow(): Promise<unknown>;
  preview(): Promise<unknown>;
  cancel(): boolean;
}

export interface RuntimeHostMemoryMaintenanceOptions {
  getRuntime(): InteractiveRuntimeHandle;
  getCommands(): CommandRuntime;
}

export function createRuntimeHostMemoryMaintenance(
  options: RuntimeHostMemoryMaintenanceOptions
): RuntimeHostMemoryMaintenance {
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let maintenanceAbort: AbortController | undefined;
  let maintenancePromise: Promise<void> | undefined;
  let embeddingRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const run = async (force = false): Promise<void> => {
    if (stopped || maintenancePromise || options.getRuntime().getSnapshot().state.kind !== "idle") return;
    const commands = options.getCommands();
    const agent = commands.agent as CommandRuntime["agent"] & {
      getPersonalizationState?: () => Promise<{ memory?: { enabled?: boolean; sleepEnabled?: boolean; sleepTime?: string; archiveRetentionDays?: number; temporaryTtl?: number; useLlm?: boolean; llmMergeLow?: number; llmBatchSize?: number } }>;
    };
    if (!agent) return;
    const state = agent.getPersonalizationState
      ? await agent.getPersonalizationState().catch(() => undefined)
      : undefined;
    const sleep = state?.memory;
    const now = new Date();
    const localMemory = typeof agent.getLocalMemory === "function" ? agent.getLocalMemory() : undefined;
    if (sleep && !localMemory) return;
    const [hour = 3, minute = 0] = (sleep?.sleepTime ?? "03:00").split(":").map(Number);
    const due = now.getHours() > hour || now.getHours() === hour && now.getMinutes() >= minute;
    if (!force && sleep?.enabled === false) return;
    if (!force && sleep?.sleepEnabled === false) return;
    if (!force && !due) return;
    const controller = new AbortController();
    maintenanceAbort = controller;
    const promise = (async () => {
      // 先读磁盘上的状态，再判断当天是否已经跑过或是否需要退避；否则新建
      // AgentSession 时内存里的初始状态会让调度器重复执行当天的 Sleep。
      const persistedStatus = await localMemory!.loadMaintenanceStatus({ signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!force && shouldSkipScheduledRun(persistedStatus, now)) return;
      if (options.getRuntime().getSnapshot().state.kind !== "idle") return;
      let rebuildRequested = false;
      try {
        await localMemory!.runMemoryMaintenance(
          {
            signal: controller.signal,
            trigger: force ? "manual" : "scheduled",
            archiveRetentionDays: sleep?.archiveRetentionDays,
            temporaryTtl: sleep?.temporaryTtl,
            useLlm: sleep?.useLlm,
            llmMergeLow: sleep?.llmMergeLow,
            llmBatchSize: sleep?.llmBatchSize
          },
          {
            indexEntry: async (entry: MemoryEntry) => await commands.agent.indexMemoryEntry(entry),
            requestRebuild: () => { rebuildRequested = true; },
            findSimilarPairs: async (entries: readonly MemoryEntry[], minimumSimilarity: number, signal?: AbortSignal) => (
              await commands.agent.findMemorySimilarityPairs(entries, minimumSimilarity, signal)
            )
          }
        );
      } finally {
        // LocalMemory 只发失效信号；等整个批次退出后再启动 generation 重建，避免与下一条
        // SQLite mutation 竞态。即使维护被前台任务中断，已提交的整理也会到达这里。
        if (rebuildRequested) api.scheduleEmbeddingRebuild();
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        // LocalMemory 将抽取/整理失败写入 maintenanceStatus；Host 不改变任何任务终态。
        void error;
      }
    }).finally(() => {
      if (maintenancePromise === promise) maintenancePromise = undefined;
      if (maintenanceAbort === controller) maintenanceAbort = undefined;
    });
    maintenancePromise = promise;
    await promise;
  };

  const api: RuntimeHostMemoryMaintenance = {
    runNow(): Promise<unknown> {
      return run(true);
    },
    preview: async (): Promise<unknown> => {
      const agent = options.getCommands().agent as CommandRuntime["agent"] & { getLocalMemory?: () => {
        previewMaintenance: (options?: { temporaryTtl?: number; archiveRetentionDays?: number }) => Promise<MemorySleepPreview>;
      } };
      if (typeof agent.getLocalMemory !== "function") return { available: false, entries: 0, temporaryToArchive: 0, archivedToDelete: 0, recentRuns: 0 };
      return await agent.getLocalMemory().previewMaintenance();
    },
    cancel(): boolean {
      if (!maintenanceAbort) return false;
      maintenanceAbort.abort();
      return true;
    },
    start(): void {
      if (stopped || maintenanceTimer) return;
      void run();
      maintenanceTimer = setInterval(() => {
        void run();
      }, runtimeHostMemoryMaintenanceIntervalMs);
      maintenanceTimer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
      maintenanceAbort?.abort();
      if (embeddingRebuildTimer) clearTimeout(embeddingRebuildTimer);
      embeddingRebuildTimer = undefined;
    },
    handleRuntimeUpdate(update: AgentRuntimeUpdate): void {
      if (update.snapshot.state.kind !== "idle") maintenanceAbort?.abort();
    },
    scheduleEmbeddingRebuild(): void {
      if (stopped || embeddingRebuildTimer) return;
      embeddingRebuildTimer = setTimeout(() => {
        embeddingRebuildTimer = undefined;
        void options.getRuntime().runExclusiveOperation(
          "memory",
          async (signal) => await options.getCommands().agent.rebuildMemoryEmbeddingIndex(signal)
        ).catch(() => undefined);
      }, 0);
      embeddingRebuildTimer.unref?.();
    }
  };

  return api;
}

function shouldSkipScheduledRun(status: MemoryMaintenanceStatus | undefined, now: Date): boolean {
  if (status?.state === "running" || status?.lastRun?.status === "running") return true;
  const todayRuns = maintenanceRuns(status)
    .filter((run) => run.finishedAt !== undefined && sameLocalDay(run.finishedAt, now))
    .sort((left, right) => runTime(left) - runTime(right));
  const latest = todayRuns.at(-1);
  if (latest?.status === "completed") return true;

  let consecutiveFailures = 0;
  for (let index = todayRuns.length - 1; index >= 0; index -= 1) {
    if (todayRuns[index]?.status !== "failed") break;
    consecutiveFailures += 1;
  }
  return consecutiveFailures >= 3;
}

function maintenanceRuns(status: MemoryMaintenanceStatus | undefined): MemorySleepRun[] {
  if (status === undefined) return [];
  const runs = [...(status.sleepRuns ?? [])];
  if (status.lastRun !== undefined && !runs.some((run) => run.id === status.lastRun?.id)) {
    runs.push(status.lastRun);
  }
  return runs;
}

function sameLocalDay(timestamp: string, reference: Date): boolean {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  return localDayKey(date) === localDayKey(reference);
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function runTime(run: MemorySleepRun): number {
  const timestamp = run.finishedAt ?? run.startedAt;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : 0;
}
