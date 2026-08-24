import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TelosRevisionConflictError, TelosStorage, telosWorkspaceId } from "../src/agent/context/telosStorage.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

await main();

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telos-"));
  const agentRoot = path.join(root, "agent");
  const workspaceA = path.join(root, "project-a");
  const workspaceB = path.join(root, "project-b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    await testStorageAndCas(workspaceA, workspaceB, agentRoot);
    console.log("telos tests passed");
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageAndCas(workspaceA: string, workspaceB: string, agentRoot: string): Promise<void> {
  const storageA = new TelosStorage(workspaceA);
  const storageB = new TelosStorage(workspaceB);
  await storageA.initialize();
  assert.equal((await storageA.overview()).revision, 0);

  const universal = await storageA.saveDocument({
    scope: "universal",
    mission: "优先做长期有效、可复用的工作。",
    principles: [{ id: "principle-1", text: "先验证再扩展。" }]
  }, 0);
  assert.equal(universal.scope, "universal");
  assert.equal(universal.revision, 1);

  const workspace = await storageA.saveDocument({
    scope: "workspace",
    mission: "让当前项目保持可维护。",
    goals: [{ id: "goal-1", text: "完成记忆 4.0", status: "active", horizon: "本季度" }],
    constraints: [{ id: "constraint-1", text: "不在任务运行时打断用户。" }]
  }, 1);
  assert.equal(workspace.workspaceId, telosWorkspaceId(workspaceA));
  assert.equal((await storageB.overview()).workspace, undefined, "workspace TELOS must be isolated by workspace id");
  assert.equal((await storageB.overview()).universal?.mission, "优先做长期有效、可复用的工作。");
  assert.match(await storageA.promptText(), /长期有效/u);
  await assert.rejects(
    storageA.saveDocument({ scope: "universal", mission: "stale" }, 1),
    TelosRevisionConflictError
  );

  const firstObservedAt = "2026-08-01T00:00:00.000Z";
  await assert.rejects(storageA.recordObservation({
    scope: "workspace",
    summary: "选择快速交付路径",
    observedAt: firstObservedAt,
    externalContext: true
  }), /External context/u);
  const observationSummary = "选择快速交付路径";
  const first = await storageA.recordObservation({ scope: "workspace", summary: observationSummary, observedAt: firstObservedAt, externalContext: false, sessionId: "session-1" });
  assert.equal(first.status, "candidate");
  assert.equal(first.evidenceCount, 1);
  const second = await storageA.recordObservation({ scope: "workspace", summary: observationSummary, observedAt: "2026-08-05T00:00:00.000Z", externalContext: false, sessionId: "session-2" });
  assert.equal(second.evidenceCount, 2);
  const third = await storageA.recordObservation({ scope: "workspace", summary: observationSummary, observedAt: "2026-08-09T00:00:00.000Z", externalContext: false, sessionId: "session-3" });
  assert.equal(third.evidenceCount, 3);
  assert.ok(third.confidence >= 0.75);
  assert.equal((await storageA.overview()).workspace?.revision, 2, "observations must not mutate the user TELOS document");
  await assert.rejects(
    storageB.reviewPattern(third.id, "reject", 5),
    /行为模式不属于当前工作区/u
  );

  const reviewed = await storageA.reviewPattern(third.id, "confirm", 5, { detectDrift: true });
  assert.equal(reviewed.patterns.find((pattern) => pattern.id === third.id)?.status, "confirmed");
  assert.equal(reviewed.drifts.length, 1, "confirmed pattern crossing the threshold should create one drift");
  const drift = reviewed.drifts[0];
  assert.ok(drift);
  await assert.rejects(
    storageB.resolveDrift(drift.id, "dismiss", reviewed.revision),
    /策略偏差不属于当前工作区/u
  );
  const snoozed = await storageA.snoozeDrift(drift.id, "2026-08-20T00:00:00.000Z", reviewed.revision);
  assert.equal(snoozed.drifts.find((candidate) => candidate.id === drift.id)?.status, "snoozed");
  const dismissed = await storageA.resolveDrift(drift.id, "dismiss", snoozed.revision);
  assert.equal(dismissed.drifts.find((candidate) => candidate.id === drift.id)?.status, "dismissed");

  const files = await fs.readdir(path.join(agentRoot, "telos", "history"));
  assert.ok(files.some((file) => file.endsWith("-1.md")));
  assert.ok(files.some((file) => file.endsWith("-2.md")));
}
