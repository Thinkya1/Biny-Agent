import assert from "node:assert/strict";
import { OperationDispatcher, operationLane } from "../src/runtime/host/operations.js";

assert.equal(operationLane("runtime.restart"), "mutation");
assert.equal(operationLane("run.submit"), "run");
assert.equal(operationLane("host.info"), "query");
assert.equal(operationLane("run.cancel"), "run");
assert.equal(operationLane("capability.fail"), "control");
assert.equal(operationLane("graph.start"), "admission");

const dispatcher = new OperationDispatcher();
const order: string[] = [];
let releaseFirst!: () => void;
const first = dispatcher.dispatch("mutation", async () => {
  order.push("first:start");
  await new Promise<void>((resolve) => { releaseFirst = resolve; });
  order.push("first:end");
});
const second = dispatcher.dispatch("mutation", async () => {
  order.push("second");
});

await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(order, ["first:start"]);
releaseFirst();
await Promise.all([first, second]);
assert.deepEqual(order, ["first:start", "first:end", "second"]);

const runDispatcher = new OperationDispatcher();
const runOrder: string[] = [];
let releaseSessionA!: () => void;
const sessionA = runDispatcher.dispatch("run", async () => {
  runOrder.push("a:start");
  await new Promise<void>((resolve) => { releaseSessionA = resolve; });
  runOrder.push("a:end");
}, "session-a");
const sessionASecond = runDispatcher.dispatch("run", async () => {
  runOrder.push("a:second");
}, "session-a");
const sessionB = runDispatcher.dispatch("run", async () => {
  runOrder.push("b");
}, "session-b");
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(runOrder, ["a:start", "b"], "不同 session 的 run lane 应并行，同 session 仍串行");
releaseSessionA();
await Promise.all([sessionA, sessionASecond, sessionB]);
assert.deepEqual(runOrder, ["a:start", "b", "a:end", "a:second"]);

console.log("runtime-host operations tests passed");
