import assert from "node:assert/strict";
import { createRuntimeHostBusinessComposition } from "../src/runtime/host/composition.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const runtime = {} as InteractiveRuntimeHandle;
const commands = {
  automationStore: undefined,
  graphs: undefined,
  taskRuns: undefined
} as unknown as CommandRuntime;
let restartCount = 0;
const composition = createRuntimeHostBusinessComposition({
  getRuntime: () => runtime,
  getCommands: () => commands,
  restartRuntime: async () => {
    restartCount += 1;
  }
});

composition.start();
composition.recoverGraphs();
await assert.rejects(composition.runAutomation("automation-1"), /Automation scheduler is unavailable/u);
composition.stop();
composition.start();
assert.equal(restartCount, 0);

console.log("runtime-host composition tests passed");
