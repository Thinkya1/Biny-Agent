import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { runtimeHostPaths, startRuntimeHost, connectRuntimeHost, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { defaultChatPersonalizationOverride, resolveChatPersonalization } from "../src/personalization/index.js";

const snapshot = {
  revision: 0,
  info: {
    sessionId: "session-host-test",
    sessionFile: "/tmp/session-host-test.jsonl",
    workspaceRoot: "/tmp/biny-host-test",
    provider: "test",
    modelAlias: "test-model",
    modelLabel: "Test Model",
    reasoningLabel: "Off",
    thinking: "off",
    skills: []
  },
  permissionMode: "ask",
  state: { kind: "idle" }
} as unknown as InteractiveRuntimeSnapshot;

interface FakeRuntime extends InteractiveRuntimeHandle {
  publish(update: AgentRuntimeUpdate): void;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "Timed out waiting for Runtime Host cancellation.");
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-test-"));
  const listeners = new Set<(update: AgentRuntimeUpdate) => void>();
  let currentSnapshot = snapshot;
  let switchedThinking: string | undefined;
  let interruptedStarts = 0;
  let cancellationRequests = 0;
  let activeRunId = "run-host-test";
  const exclusiveOperations: string[] = [];
  let memoryExpectedRevision: number | undefined;
  let chatExpectedRevision: string | undefined;
  let globalExpectedRevision: string | undefined;
  const globalPersonalization = { enabled: true, personality: "none" as const, customInstructions: "" };
  const memoryPolicy = {
    useMemories: false,
    generateMemories: false,
    extractModel: undefined,
    consolidationModel: undefined,
    excludeExternalContext: true,
    maxRecalled: 3
  };
  const personalizationState = () => ({
    global: globalPersonalization,
    memory: memoryPolicy,
    override: defaultChatPersonalizationOverride,
    resolved: resolveChatPersonalization(globalPersonalization, memoryPolicy),
    catalogRevision: "catalog-revision-1",
    configRevision: "config-revision-1"
  });
  const runtime: FakeRuntime = {
    publish(update): void {
      currentSnapshot = update.snapshot;
      for (const listener of listeners) listener(update);
    },
    submitPrompt: (input, mode, _attachments, ids) => {
      const runId = ids?.runId ?? "run-host-test";
      const messageId = ids?.messageId ?? "message-host-test";
      const completedSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
      const event: AgentRuntimeUpdate["event"] = {
        type: "run.completed",
        sessionId: currentSnapshot.info.sessionId,
        runId,
        timestamp: new Date().toISOString(),
        durationMs: 1,
        stopReason: "model_stop",
        steps: 1
      };
      runtime.publish({ event, snapshot: completedSnapshot });
      return {
        runId,
        messageId,
        completion: Promise.resolve({
          runId,
          status: "completed",
          stopReason: "model_stop",
          steps: 1,
          output: `done: ${input} (${mode})`,
          durationMs: 1
        })
      };
    },
    steer: () => { throw new Error("not used"); },
    followUp: () => { throw new Error("not used"); },
    continueInterruptedTurn: async () => undefined,
    startInterruptedTurn: async () => {
      interruptedStarts += 1;
      return undefined;
    },
    waitForIdle: async () => undefined,
    cancelCurrentRun: () => { cancellationRequests += 1; },
    cancelRun: (runId) => {
      if (runId !== activeRunId) return false;
      cancellationRequests += 1;
      return true;
    },
    answerPermission: () => undefined,
    resumeSession: async () => { throw new Error("not used"); },
    runExclusiveOperation: async (operation, execute) => {
      exclusiveOperations.push(operation);
      return await execute(new AbortController().signal);
    },
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => currentSnapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined
  };
  const commands = {
    agent: {
      switchModel: async (_alias: string, thinking?: string) => {
        switchedThinking = thinking;
        const nextThinking = thinking ?? "off";
        currentSnapshot = {
          ...currentSnapshot,
          revision: currentSnapshot.revision + 1,
          info: {
            ...currentSnapshot.info,
            thinking: nextThinking,
            reasoningLabel: nextThinking === "max" ? "Max" : "Off"
          }
        };
        return {
          modelAlias: "test-model",
          provider: "test",
          modelLabel: "Test Model",
          reasoningLabel: nextThinking === "max" ? "Max" : "Off",
          thinking: nextThinking
        };
      },
      getPersonalizationState: async () => personalizationState(),
      updateChatPersonalization: async (_patch: unknown, expectedRevision: string) => {
        chatExpectedRevision = expectedRevision;
        return personalizationState();
      },
      updateGlobalPersonalization: async (_update: unknown, expectedRevision: string) => {
        globalExpectedRevision = expectedRevision;
        return personalizationState();
      },
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => ({ state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 }),
        processEligibleCandidates: async () => ({ scanned: 0, processed: 0, written: 0, failed: 0, startedAt: "", finishedAt: "" }),
        getOverview: async () => ({
          scopes: {
            global: { scope: "global", revision: 3, entryCount: 0, candidateCount: 0, indexChars: 0 },
            project: { scope: "project", revision: 7, entryCount: 0, candidateCount: 0, indexChars: 0 }
          },
          revision: { global: 3, project: 7 }
        }),
        listStoredEntries: async () => ({ entries: [], revision: { global: 3, project: 7 } }),
        writeScoped: async (_entry: unknown, options: { expectedRevision: number }) => {
          memoryExpectedRevision = options.expectedRevision;
          return { written: true, revision: options.expectedRevision + 1 };
        }
      })
    }
  } as unknown as CommandRuntime;
  const host = await startRuntimeHost(workspace, runtime, commands);
  assert.equal(interruptedStarts, 0, "普通 Host 启动不得自动恢复中断回合");
  const client = await connectRuntimeHost(workspace, { clientId: "test-client", surface: "tui" });
  assert.ok(client);
  assert.equal(client.getSnapshot().info.sessionId, "session-host-test");
  assert.equal(client.hostInfo?.hostEpoch, host.info.hostEpoch);
  assert.equal(client.hostInfo?.capabilities.includes("personalization"), true);

  const updatePromise = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      unsubscribe();
      resolve(update);
    });
  });
  const runningSnapshot = {
    ...snapshot,
    state: {
      kind: "runs",
      activeRun: {
        sessionId: "session-host-test",
        runId: "run-host-test",
        messageId: "message-host-test",
        input: "hello",
        mode: "chat",
        status: "thinking",
        startedAt: new Date().toISOString()
      }
    }
  } as InteractiveRuntimeSnapshot;
  const update: AgentRuntimeUpdate = {
    event: {
      type: "run.started",
      sessionId: "session-host-test",
      runId: "run-host-test",
      timestamp: new Date().toISOString(),
      messageId: "message-host-test",
      input: "hello",
      mode: "chat",
      model: {
        alias: "test-model",
        provider: "test",
        label: "Test Model",
        reasoning: "Off"
      },
      skills: []
    },
    snapshot: runningSnapshot
  };
  runtime.publish(update);
  assert.equal((await updatePromise).event?.type, "run.started");

  const submitted = client.submitPrompt("hello", "chat");
  assert.equal(submitted.runId.length > 0, true);
  assert.equal((await submitted.completion).status, "completed");

  const modelUpdate = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      if (update.snapshot.info.thinking === "max") {
        unsubscribe();
        resolve(update);
      }
    });
  });
  const switched = await client.switchModel("test-model", "max");
  assert.equal(switched.thinking, "max");
  assert.equal(switchedThinking, "max");
  assert.equal((await modelUpdate).snapshot.info.thinking, "max", "模型切换必须广播给已连接的 TUI/App");
  assert.equal(client.getSnapshot().info.thinking, "max");

  assert.equal((await client.getPersonalizationState()).catalogRevision, "catalog-revision-1");
  await client.updateChatPersonalization({ personality: "friendly" }, "catalog-revision-1");
  assert.equal(chatExpectedRevision, "catalog-revision-1");
  await client.updateGlobalPersonalization({ personalization: globalPersonalization }, "config-revision-1");
  assert.equal(globalExpectedRevision, "config-revision-1");

  const exclusiveOperationsBeforeMemory = exclusiveOperations.length;
  await client.memory("write-v2", {
    expectedRevision: 7,
    entry: {
      scope: "project",
      kind: "fact",
      topic: "runtime-host",
      title: "Scoped revision",
      summary: "The scoped memory revision must reach the owner unchanged.",
      lineage: { source: "explicit", externalContext: false }
    }
  });
  assert.equal(memoryExpectedRevision, 7, "v2 memory CAS must not be replaced by the Runtime Host snapshot revision");
  assert.deepEqual(
    exclusiveOperations.slice(exclusiveOperationsBeforeMemory),
    ["memory"],
    "attached v2 memory requests must use the runtime maintenance boundary"
  );

  // 同一 run 的取消可绕过滞后的 revision；Host 改为按 runId 匹配而不是取消当前运行。
  currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
  client.cancelCurrentRun();
  await waitUntil(() => cancellationRequests === 1);
  const cancellation = await client.cancelRunRequest("run-host-test");
  assert.equal(cancellation.accepted, true, "取消不应被客户端滞后的 revision 拒绝");
  assert.equal(cancellationRequests, 2);

  // 旧客户端晚到的取消不能停止已经替换为新 run 的 Host 当前运行。
  activeRunId = "new-run";
  currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
  const staleCancellation = await client.cancelRunRequest("run-host-test");
  assert.equal(staleCancellation.accepted, false, "Host must reject a cancellation for a superseded run");
  assert.equal(cancellationRequests, 2, "a stale cancellation must not reach the newer run");

  const secondClient = await connectRuntimeHost(workspace, { clientId: "test-client-2", surface: "desktop" });
  assert.ok(secondClient);
  assert.equal(secondClient.getSnapshot().info.sessionId, "session-host-test");
  const replayedTypes: string[] = [];
  const unsubscribeReplay = secondClient.subscribe((replayed) => {
    if (replayed.event) replayedTypes.push(replayed.event.type);
  });
  assert.equal(replayedTypes.includes("run.started"), true);
  unsubscribeReplay();
  await secondClient.close();
  await client.close();
  await host.close();
  const explicitResumeHost = await startRuntimeHost(workspace, runtime, commands, { resumeInterrupted: true });
  assert.equal(interruptedStarts, 1, "只有显式恢复开关才允许启动中断回合");
  await explicitResumeHost.close();
  assert.equal(await connectRuntimeHost(workspace, { clientId: "after-close", surface: "tui" }), undefined);

  const spawnedWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-process-test-"));
  const configDir = path.join(spawnedWorkspace, "config");
  await saveConfig(spawnedWorkspace, {
    ...defaultConfig,
    defaultModel: "host-test",
    providers: {
      host: {
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        requiresApiKey: false
      }
    },
    models: {
      "host-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "host",
        model: "host-test-model",
        displayName: "Host Test"
      }
    }
  }, { globalDir: configDir });
  const spawned = await spawnRuntimeHost(spawnedWorkspace, {
    workspaceRoot: spawnedWorkspace,
    configDir,
    resumeInterrupted: false,
    clientId: "process-client",
    surface: "cli"
  });
  assert.equal(spawned.client.getSnapshot().info.workspaceRoot, spawnedWorkspace);
  const initialEpoch = spawned.client.hostInfo?.hostEpoch;
  await spawned.client.restartOwner();
  const restartedEpoch = spawned.client.hostInfo?.hostEpoch;
  assert.notEqual(restartedEpoch, initialEpoch);
  assert.equal(spawned.client.getSnapshot().info.workspaceRoot, spawnedWorkspace);
  // 模拟 owner 被系统杀掉：不会执行 Host.close，验证 registration/lock 的接管路径。
  const restartedRegistration = JSON.parse(await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")) as { pid?: unknown };
  if (typeof restartedRegistration.pid === "number") process.kill(restartedRegistration.pid, "SIGKILL");
  const takeoverDeadline = Date.now() + 10_000;
  while (spawned.client.hostInfo?.hostEpoch === restartedEpoch && Date.now() < takeoverDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.notEqual(spawned.client.hostInfo?.hostEpoch, initialEpoch);
  await spawned.client.close();
  const replacementRegistration = JSON.parse(await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")) as { pid?: unknown };
  if (typeof replacementRegistration.pid === "number") process.kill(replacementRegistration.pid, "SIGTERM");
  const exited = new Promise<void>((resolve) => {
    if (spawned.process.exitCode !== null || spawned.process.signalCode !== null) {
      resolve();
      return;
    }
    spawned.process.once("exit", () => resolve());
  });
  spawned.process.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (spawned.process.exitCode === null && spawned.process.signalCode === null) spawned.process.kill("SIGKILL");
  await rm(spawnedWorkspace, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

await main();
console.log("runtime-host tests passed");
