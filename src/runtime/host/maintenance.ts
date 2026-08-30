/**
 * Runtime Host 的后台业务维护边界。
 *
 * 候选整理和 embedding 派生索引都属于 owner 侧业务组合，不应由 socket Server
 * 持有计时器和 AbortController。这里也只通过 getter 访问 runtime/commands，支持 runtime 重建后
 * 继续使用新的 AgentSession。
 */
import type { AgentRuntimeUpdate } from "../agentEvents.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import { runtimeHostMemoryMaintenanceIntervalMs } from "./protocol.js";

export interface RuntimeHostMemoryMaintenance {
  start(): void;
  stop(): void;
  handleRuntimeUpdate(update: AgentRuntimeUpdate): void;
  scheduleEmbeddingRebuild(): void;
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

  const run = async (): Promise<void> => {
    if (stopped || maintenancePromise || options.getRuntime().getSnapshot().state.kind !== "idle") return;
    const controller = new AbortController();
    maintenanceAbort = controller;
    const commands = options.getCommands();
    const promise = (async () => {
      await commands.agent.getLocalMemory().loadMaintenanceStatus({ signal: controller.signal });
      controller.signal.throwIfAborted();
      // 候选入队时已经应用当回合的有效策略。这里按真实队列处理，避免聊天覆盖允许贡献后，
      // 又被当前全局开关拦住，导致已经承诺生成的候选永久滞留。
      if (options.getRuntime().getSnapshot().state.kind !== "idle") return;
      let rebuildRequested = false;
      try {
        await commands.agent.getLocalMemory().processEligibleCandidates(
          { signal: controller.signal },
          {
            indexEntry: async (entry) => await commands.agent.indexMemoryEntry(entry),
            requestRebuild: () => { rebuildRequested = true; }
          }
        );
      } finally {
        // LocalMemory 只发失效信号；等整个批次退出后再启动 generation 重建，避免与下一条
        // 候选的 Markdown mutation 竞态。即使维护被前台任务中断，已提交的整理也会到达这里。
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
