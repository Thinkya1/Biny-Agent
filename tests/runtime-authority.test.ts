import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { AutomationStore, type AutomationExecutionTemplate } from "../src/runtime/AutomationScheduler.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { evaluateTaskRetry } from "../src/runtime/TaskRetryPolicy.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-authority-test-"));
const authority = await RuntimeEventAuthority.open(root);
const tasks = await DurableTaskRunStore.open(root, authority);
const automations = await AutomationStore.open(root, authority);
const graphs = await GoalGraphStore.open(root, authority);
const capabilities = await CapabilityStore.open(root, authority);

try {
  const admitted = authority.startRun({
    workspaceId: authority.workspaceId,
    sessionId: "session-1",
    invocationId: "invocation-1",
    runId: "run-1",
    turnId: "turn-1",
    payload: { input: "test" }
  });
  assert.equal(admitted.status, "admitted");
  const terminal = authority.finishRun({ runId: "run-1", status: "completed", payload: { output: "ok" } });
  assert.equal(terminal.status, "completed");
  assert.equal(authority.finishRun({ runId: "run-1", status: "completed", payload: { output: "ok" } }).status, "completed");
  assert.equal(authority.readEvents({ runId: "run-1" }).events.length, 2);

  const retryAdmission = authority.startRun({
    sessionId: "session-retry",
    runId: "run-retry",
    turnId: "turn-retry",
    payload: { input: "retry" }
  });
  assert.equal(retryAdmission.created, true);
  assert.equal(authority.startRun({
    sessionId: "session-retry",
    runId: "run-retry",
    turnId: "turn-retry",
    payload: { input: "retry" }
  }).created, false, "repeated admission must return the existing run without creating another execution");

  const continuationSource = authority.startRun({ sessionId: "session-continuation", runId: "run-continuation-source", turnId: "turn-continuation" });
  const continuationClaim = authority.claimContinuation(continuationSource.runId, "run-continuation-child");
  assert.equal(authority.releaseContinuationClaim(continuationSource.runId, continuationClaim.childRunId), true);
  assert.equal(authority.claimContinuation(continuationSource.runId, "run-continuation-child-2").childRunId, "run-continuation-child-2");

  const legacySessionEvent = {
    eventId: "session-event-with-late-time",
    sessionId: "session-legacy",
    invocationId: "run-legacy",
    runId: "run-legacy",
    turnId: "turn-legacy",
    eventType: "session.assistant_message",
    payload: { type: "assistant_message", content: "hello" }
  };
  authority.appendEvent(legacySessionEvent);
  const backfilledSessionEvent = authority.appendEvent({
    ...legacySessionEvent,
    eventSeq: 1,
    payload: { type: "assistant_message", content: "hello", time: "2026-08-06T00:00:00.000Z" }
  });
  assert.equal(backfilledSessionEvent.eventSeq, 1);

  const task = tasks.create({ taskRunId: "task-1", task: { prompt: "background" }, sessionId: "session-1" });
  const attempt = tasks.createAttempt(task.taskRunId, { runId: "run-1", turnId: "turn-1", retrySafety: "unknown" });
  assert.equal(tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId }).status, "running");
  assert.equal(tasks.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId }).attempts.length, 1);
  assert.throws(
    () => tasks.transition(task.taskRunId, "cancelled", { attemptId: attempt.attemptId }),
    /already terminal/
  );
  assert.equal(tasks.get(task.taskRunId)?.status, "completed");
  assert.equal(tasks.events(task.taskRunId).length, 2);

  const retryableTask = tasks.create({ taskRunId: "task-retryable", task: { prompt: "retry" }, sessionId: "session-1" });
  const retryableAttempt = tasks.createAttempt(retryableTask.taskRunId, {
    runId: "retry-run-1",
    turnId: "retry-turn-1",
    retrySafety: "idempotent"
  });
  tasks.transition(retryableTask.taskRunId, "running", { attemptId: retryableAttempt.attemptId });
  const failedRetryable = tasks.transition(retryableTask.taskRunId, "failed", {
    attemptId: retryableAttempt.attemptId,
    failure: { failureClass: "RateLimit" }
  });
  const retryDecision = evaluateTaskRetry(failedRetryable);
  assert.equal(retryDecision.allowed, true);
  if (retryDecision.allowed) assert.equal(retryDecision.failureClass, "RateLimit");

  const unknownTask = tasks.create({ taskRunId: "task-unknown", task: { prompt: "unknown" }, sessionId: "session-1" });
  const unknownAttempt = tasks.createAttempt(unknownTask.taskRunId, {
    runId: "unknown-run-1",
    turnId: "unknown-turn-1",
    retrySafety: "unknown"
  });
  tasks.transition(unknownTask.taskRunId, "running", { attemptId: unknownAttempt.attemptId });
  const failedUnknown = tasks.transition(unknownTask.taskRunId, "failed", {
    attemptId: unknownAttempt.attemptId,
    failure: { failureClass: "RateLimit" }
  });
  const unknownDecision = evaluateTaskRetry(failedUnknown);
  assert.equal(unknownDecision.allowed, false);
  if (!unknownDecision.allowed) assert.equal(unknownDecision.code, "retry_safety_unknown");

  const ordinaryFailureTask = tasks.create({ taskRunId: "task-ordinary-failure", task: { prompt: "ordinary" }, sessionId: "session-1" });
  const ordinaryFailureAttempt = tasks.createAttempt(ordinaryFailureTask.taskRunId, {
    runId: "ordinary-run-1",
    turnId: "ordinary-turn-1",
    retrySafety: "safe"
  });
  tasks.transition(ordinaryFailureTask.taskRunId, "running", { attemptId: ordinaryFailureAttempt.attemptId });
  const failedOrdinary = tasks.transition(ordinaryFailureTask.taskRunId, "failed", {
    attemptId: ordinaryFailureAttempt.attemptId,
    failure: { failureClass: "ToolError" }
  });
  const ordinaryDecision = evaluateTaskRetry(failedOrdinary);
  assert.equal(ordinaryDecision.allowed, false);
  if (!ordinaryDecision.allowed) assert.equal(ordinaryDecision.code, "failure_not_retryable");

  const automation = automations.create({
    automationId: "automation-1",
    name: "once",
    triggerType: "once",
    schedule: { at: new Date(Date.now() - 1_000).toISOString() },
    executionTemplate: { prompt: "run once" },
    maxFires: 1
  });
  const fires = automations.claimDue(new Date());
  assert.equal(fires.length, 1);
  const claimed = automations.claimFire(fires[0]!.fireId);
  assert.ok(claimed);
  assert.equal(automations.completeFire(fires[0]!.fireId, "run-1").status, "completed");
  assert.equal(automations.get(automation.automationId)?.status, "completed");

  assert.throws(
    () => automations.create({
      automationId: "automation-unsupported-template",
      name: "unsupported-template",
      triggerType: "once",
      schedule: { at: new Date(Date.now() + 10_000).toISOString() },
      executionTemplate: { prompt: "must reject", modelAlias: "other-model" } as unknown as AutomationExecutionTemplate
    }),
    /unsupported field/
  );

  const goal = graphs.createGoal("goal");
  const graph = graphs.createGraph(goal.goalId, [
    { nodeKey: "first", prompt: "first" },
    { nodeKey: "second", prompt: "second", dependencies: ["first"] }
  ]);
  graphs.startGraph(graph.graphId);
  const first = graphs.readyNodes(graph.graphId).find((node) => node.nodeKey === "first");
  assert.ok(first);
  assert.ok(graphs.claimIntent(graph.graphId, first.nodeId));
  graphs.completeNode(graph.graphId, first.nodeId, "completed", { artifact: "a" });
  assert.equal(graphs.readyNodes(graph.graphId).find((node) => node.nodeKey === "second")?.nodeKey, "second");

  const recoverableGraph = graphs.createGraph(undefined, [{ nodeKey: "recoverable", prompt: "recoverable" }]);
  graphs.startGraph(recoverableGraph.graphId);
  const recoverableNode = graphs.readyNodes(recoverableGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(recoverableGraph.graphId, recoverableNode.nodeId, "claim-before-restart", "graph-recoverable-task"));
  graphs.recoverRunningNodes(tasks);
  assert.equal(graphs.inspectGraph(recoverableGraph.graphId).nodes[0]!.status, "ready");
  assert.ok(graphs.claimIntent(recoverableGraph.graphId, recoverableNode.nodeId, "claim-after-restart", "graph-recoverable-task"));

  const blockedGraph = graphs.createGraph(undefined, [{ nodeKey: "uncertain", prompt: "uncertain" }]);
  graphs.startGraph(blockedGraph.graphId);
  const blockedNode = graphs.readyNodes(blockedGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(blockedGraph.graphId, blockedNode.nodeId, "claim-uncertain", "graph-uncertain-task"));
  const uncertainTask = tasks.create({ taskRunId: "graph-uncertain-task", task: { prompt: "uncertain" } });
  const uncertainAttempt = tasks.createAttempt(uncertainTask.taskRunId, { runId: "graph-uncertain-run", turnId: "graph-uncertain-turn" });
  tasks.transition(uncertainTask.taskRunId, "running", { attemptId: uncertainAttempt.attemptId });
  graphs.recoverRunningNodes(tasks);
  assert.equal(graphs.inspectGraph(blockedGraph.graphId).status, "blocked");
  assert.equal(graphs.inspectGraph(blockedGraph.graphId).nodes[0]!.status, "blocked");

  const cancelledGraph = graphs.createGraph(undefined, [{ nodeKey: "cancelled", prompt: "cancelled" }]);
  graphs.startGraph(cancelledGraph.graphId);
  const cancelledNode = graphs.readyNodes(cancelledGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(cancelledGraph.graphId, cancelledNode.nodeId));
  graphs.cancelGraph(cancelledGraph.graphId);
  const lateGraph = graphs.completeNode(cancelledGraph.graphId, cancelledNode.nodeId, "completed", { late: true });
  assert.equal(lateGraph.status, "cancelled");
  assert.equal(lateGraph.nodes[0]!.status, "cancelled");
  assert.throws(() => graphs.resumeGraph(cancelledGraph.graphId), /cannot transition from cancelled/);

  const terminalGoal = graphs.createGoal("terminal goal");
  graphs.updateGoal(terminalGoal.goalId, "completed");
  assert.throws(() => graphs.updateGoal(terminalGoal.goalId, "active"), /cannot transition from completed/);

  const registration = capabilities.register({
    registrationId: "cap-1",
    ownerType: "client",
    ownerId: "client-1",
    capabilityName: "echo",
    schema: { type: "object", required: ["value"] }
  });
  assert.equal(capabilities.admit(registration.registrationId).status, "admitted");
  const invocation = capabilities.invoke({ registrationId: registration.registrationId, request: { value: "x" } }, "invocation-1");
  assert.throws(() => capabilities.result(invocation.invocationId, { value: "too early" }), /cannot finish from status admitted/);
  capabilities.accept(invocation.invocationId);
  capabilities.start(invocation.invocationId);
  const result = capabilities.chunk(invocation.invocationId, 0, { value: "x" }, true);
  assert.equal(result.status, "result");
  assert.equal(capabilities.getInvocation(invocation.invocationId)?.chunks.length, 1);

  const hostResult = await capabilities.executeHostCapability(
    {
      capabilityName: "host:test.echo",
      schema: { type: "object", required: ["value"] },
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      request: { value: "host" },
      timeoutMs: 1_000
    },
    async () => ({ value: "host" })
  );
  assert.deepEqual(hostResult, { value: "host" });
  assert.equal(capabilities.list().find((candidate) => candidate.capabilityName === "host:test.echo")?.status, "admitted");

  const page = authority.readEvents({ limit: 10 });
  assert.ok(page.events.every((event, index) => index === 0 || event.sequence > page.events[index - 1]!.sequence));
  await testSessionBackfillWatermark();
  console.log("runtime authority tests passed");
} finally {
  capabilities.close();
  graphs.close();
  automations.close();
  tasks.close();
  authority.close();
  await rm(root, { recursive: true, force: true });
}

async function testSessionBackfillWatermark(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-authority-backfill-test-"));
  try {
    await ensureAgentDirs(workspace);
    const sessionId = "2026-08-23-backfill";
    const sessionFile = sessionFilePath(workspace, sessionId);
    await writeFile(sessionFile, `${JSON.stringify({ type: "user_message", content: "first" })}\n`, "utf8");

    (await RuntimeEventAuthority.open(workspace)).close();
    const databasePath = path.join(agentDir(workspace), "runtime.sqlite");
    let database = new DatabaseSync(databasePath);
    database.prepare("UPDATE runtime_backfills SET completed_at = ? WHERE session_id = ?").run("sentinel", sessionId);
    database.close();

    (await RuntimeEventAuthority.open(workspace)).close();
    database = new DatabaseSync(databasePath);
    const unchanged = database.prepare("SELECT completed_at, file_size FROM runtime_backfills WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
    assert.equal(unchanged.completed_at, "sentinel", "unchanged JSONL must not be reparsed");
    const previousSize = Number(unchanged.file_size);
    database.close();

    await appendFile(sessionFile, `${JSON.stringify({ type: "assistant_message", content: "second" })}\n`, "utf8");
    (await RuntimeEventAuthority.open(workspace)).close();
    database = new DatabaseSync(databasePath);
    const changed = database.prepare("SELECT completed_at, file_size FROM runtime_backfills WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
    assert.notEqual(changed.completed_at, "sentinel");
    assert.ok(Number(changed.file_size) > previousSize);
    database.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
