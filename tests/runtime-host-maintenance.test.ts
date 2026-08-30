import assert from "node:assert/strict";
import { createRuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const calls: string[] = [];
const runtime = {
  getSnapshot: () => ({ state: { kind: "idle" } }),
  runExclusiveOperation: async (
    _operation: string,
    execute: (signal: AbortSignal) => Promise<unknown>
  ) => await execute(new AbortController().signal)
} as unknown as InteractiveRuntimeHandle;
const localMemory = {
  loadMaintenanceStatus: async ({ signal }: { signal?: AbortSignal }) => {
    calls.push("load");
    signal?.throwIfAborted();
    return undefined;
  },
  processEligibleCandidates: async (
    _options: unknown,
    derivedIndex: { requestRebuild?: () => void }
  ) => {
    calls.push("process");
    derivedIndex.requestRebuild?.();
    return undefined;
  }
};
const commands = {
  agent: {
    getLocalMemory: () => localMemory,
    indexMemoryEntry: async () => undefined,
    rebuildMemoryEmbeddingIndex: async () => { calls.push("rebuild"); }
  }
} as unknown as CommandRuntime;
const maintenance = createRuntimeHostMemoryMaintenance({
  getRuntime: () => runtime,
  getCommands: () => commands
});

maintenance.start();
await new Promise<void>((resolve) => setTimeout(resolve, 25));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

maintenance.stop();
maintenance.scheduleEmbeddingRebuild();
await new Promise<void>((resolve) => setTimeout(resolve, 10));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

console.log("runtime-host maintenance tests passed");
