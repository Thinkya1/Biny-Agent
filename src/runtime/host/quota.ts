/**
 * Runtime Host 的总量闸门和 drain 状态。
 *
 * 注册表负责 session runtime 的数量和 LRU；这里负责运行中 AgentRun 的数量，以及关闭
 * 开始后禁止新 admission。两者分开，避免“能建 runtime”误表示“能再启动一个 run”。
 */
import type { InteractiveRuntimeSnapshot } from "../agentEvents.js";
import type { ManagedSessionRuntime, SessionRuntimeRegistry } from "./registry.js";

export const defaultMaxConcurrentRuns = 4;

export class HostDrainingError extends Error {
  readonly code = "host_draining";

  constructor() {
    super("Runtime Host is draining and no longer accepts new work.");
    this.name = "HostDrainingError";
  }
}

export class RuntimeConcurrencyLimitError extends Error {
  readonly code = "runtime_concurrency_exceeded";

  constructor(readonly maxConcurrentRuns: number) {
    super(`Runtime Host already has ${String(maxConcurrentRuns)} active runs; retry after one finishes.`);
    this.name = "RuntimeConcurrencyLimitError";
  }
}

export class RuntimeHostQuota {
  readonly maxConcurrentRuns: number;
  private draining = false;

  constructor(maxConcurrentRuns = defaultMaxConcurrentRuns) {
    if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new Error("maxConcurrentRuns must be a positive safe integer.");
    }
    this.maxConcurrentRuns = maxConcurrentRuns;
  }

  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  assertAdmission(): void {
    if (this.draining) throw new HostDrainingError();
  }

  assertRunCapacity(registry: SessionRuntimeRegistry, target: ManagedSessionRuntime): void {
    this.assertAdmission();
    const targetSnapshot = target.runtime.getSnapshot();
    // 一个 session 自己已经在 runs 状态时，queue/permission 等操作不应再次占配额。
    if (targetSnapshot.state.kind !== "idle") return;
    const activeRuns = registry.list().filter((entry) => isActiveRun(entry.runtime.getSnapshot())).length;
    if (activeRuns >= this.maxConcurrentRuns) throw new RuntimeConcurrencyLimitError(this.maxConcurrentRuns);
  }

  canStartRun(registry: SessionRuntimeRegistry): boolean {
    return !this.draining
      && registry.list().filter((entry) => isActiveRun(entry.runtime.getSnapshot())).length < this.maxConcurrentRuns;
  }
}

export function isRuntimeHostAdmissionOperation(operation: string): boolean {
  return operation === "session.ensure"
    || operation === "runtime.start-draft"
    || operation === "runtime.restart"
    || operation === "runtime.rotate-primary"
    || operation === "submit"
    || operation === "queue"
    || operation === "start-interrupted"
    || operation === "run.submit"
    || operation === "run.queue"
    || operation === "run.continue"
    || operation === "automation.run"
    || operation === "graph.start"
    || operation === "graph.resume"
    || operation === "goal.resume"
    || operation === "task.create"
    || operation === "task.start"
    || operation === "task.approve"
    || operation === "task.resume"
    || operation === "task.retry"
    || operation === "capability.register"
    || operation === "capability.replace"
    || operation === "capability.admit"
    || operation === "capability.invoke"
    || operation === "capability.accept"
    || operation === "capability.start"
    || operation === "capability.result"
    || operation === "capability.chunk";
}

function isActiveRun(snapshot: InteractiveRuntimeSnapshot): boolean {
  return snapshot.state.kind === "runs";
}
