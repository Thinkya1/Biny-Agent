import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
  let maintenanceRuns = 0;
  let chatExpectedRevision: string | undefined;
  let globalExpectedRevision: string | undefined;
  const memoryPolicy = {
    useMemories: false,
    generateMemories: false,
    extractModel: undefined,
    excludeExternalContext: true,
    maxRecalled: 3
  };
  const indexedMemoryEntries: string[] = [];
  let downloadedEmbeddingModel: string | undefined;
  let removedEmbeddingModel: string | undefined;
  let embeddingRebuilds = 0;
  const embeddingStatus = () => ({
    activeModel: { kind: "local" as const, model: "multilingual-e5-small" as const },
    models: [],
    localModels: [],
    index: { building: 0, failed: 0 },
    totalEntries: 0,
    indexedEntries: 0,
    pendingEntries: 0,
    failedEntries: 0
  });
  const personalizationState = () => ({
    memory: memoryPolicy,
    override: defaultChatPersonalizationOverride,
    resolved: resolveChatPersonalization(memoryPolicy),
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
    claimSession: async () => undefined,
    releaseSessionClaim: async () => undefined,
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
      setPermissionMode: async (mode: InteractiveRuntimeSnapshot["permissionMode"]) => {
        currentSnapshot = {
          ...currentSnapshot,
          revision: currentSnapshot.revision + 1,
          permissionMode: mode
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
        runMemoryMaintenance: async () => {
          maintenanceRuns += 1;
          return { scanned: 1, processed: 1, written: 1, failed: 0, startedAt: "", finishedAt: "" };
        },
        getOverview: async () => ({
          storeRevision: 7,
          entryCount: 0,
          origins: { user: 0, currentWorkspace: 0, otherWorkspaces: 0 }
        }),
        listMemoryEntries: async () => ({ entries: [], storeRevision: 7 }),
        writeEntry: async (_entry: unknown, options: { expectedRevision: number }) => {
          memoryExpectedRevision = options.expectedRevision;
          return { written: true, revision: options.expectedRevision + 1, entry: { id: "memory-entry-1" } };
        },
      }),
      indexMemoryEntry: async (entry: { id: string }) => { indexedMemoryEntries.push(entry.id); },
      removeMemoryEmbeddingEntries: () => undefined,
      memoryEmbeddingStatus: async () => embeddingStatus(),
      downloadMemoryEmbeddingModel: async (model: string) => { downloadedEmbeddingModel = model; },
      cancelMemoryEmbeddingDownload: (model: string) => model === "multilingual-e5-small",
      removeMemoryEmbeddingModel: async (model: string) => {
        removedEmbeddingModel = model;
        return { filesDeleted: 2, bytesFreed: 128 };
      },
      rebuildMemoryEmbeddingIndex: async () => { embeddingRebuilds += 1; },
      cancelMemoryEmbeddingRebuild: () => true
    }
  } as unknown as CommandRuntime;
  const hostPaths = runtimeHostPaths(workspace);
  const attackerRegistration = path.join(workspace, "attacker-registration.json");
  await fs.mkdir(path.dirname(hostPaths.registrationPath), { recursive: true });
  await fs.writeFile(attackerRegistration, "attacker-registration\n");
  await symlink(attackerRegistration, hostPaths.registrationPath);
  const host = await startRuntimeHost(workspace, runtime, commands);
  assert.equal(await readFile(attackerRegistration, "utf8"), "attacker-registration\n", "registration writes must replace a symlink, not follow it");
  const hostDirectory = await fs.lstat(path.dirname(hostPaths.endpoint));
  assert.equal(hostDirectory.mode & 0o077, 0, "Runtime Host directory must not be group/world accessible");
  const hostSocket = await fs.lstat(hostPaths.endpoint);
  assert.equal(hostSocket.mode & 0o077, 0, "Runtime Host socket must not be group/world accessible");
  assert.equal(interruptedStarts, 0, "普通 Host 启动不得自动恢复中断回合");
  // registration 落盘前 lock 就必须携带 owner pid；注册窗口内的竞争进程据此判活。
  const ownerRegistration = JSON.parse(await readFile(hostPaths.registrationPath, "utf8")) as { pid?: unknown };
  assert.equal((await readFile(hostPaths.lockPath, "utf8")).trim(), String(ownerRegistration.pid));
  const client = await connectRuntimeHost(workspace, { clientId: "test-client", surface: "tui" });
  assert.ok(client);
  await waitUntil(() => maintenanceRuns >= 1);
  assert.equal(client.getSnapshot().info.sessionId, "session-host-test");
  assert.equal(client.hostInfo?.hostEpoch, host.info.hostEpoch);
  assert.equal(client.hostInfo?.capabilities.includes("personalization"), true);
  assert.equal(client.hostInfo?.capabilities.includes("memory.v3"), true);
  assert.equal(client.hostInfo?.capabilities.includes("telos.v1"), false);
  assert.equal(client.hostInfo?.capabilities.includes("memory.v2"), false);

  const isolatedAgentRoot = path.join(workspace, "isolated-agent");
  const isolatedConfigRoot = path.join(workspace, "isolated-config");
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = isolatedAgentRoot;
  try {
    await assert.rejects(
      connectRuntimeHost(workspace, {
        clientId: "isolated-client",
        surface: "desktop",
        spawnOptions: {
          workspaceRoot: workspace,
          configDir: isolatedConfigRoot,
          resumeInterrupted: false
        }
      }),
      /Cannot replace a Runtime Host owned by the current process/u
    );
    const legacyClient = await connectRuntimeHost(workspace, {
      clientId: "legacy-environment-client",
      surface: "cli"
    });
    assert.equal(legacyClient, undefined);
  } finally {
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
  }

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

  const permissionUpdate = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      if (update.snapshot.permissionMode === "full-access") {
        unsubscribe();
        resolve(update);
      }
    });
  });
  await client.setPermissionMode("full-access");
  assert.equal((await permissionUpdate).snapshot.permissionMode, "full-access", "权限切换必须广播给已连接的 TUI/App");
  assert.equal(client.getSnapshot().permissionMode, "full-access");

  // Runtime 重建后 revision 从 0 重新开始；客户端应刷新 Host 快照并重试幂等的权限写入。
  const staleRevision = client.getSnapshot().revision;
  assert.notEqual(staleRevision, 0);
  currentSnapshot = { ...currentSnapshot, revision: 0, permissionMode: "ask" };
  await client.setPermissionMode("full-access");
  assert.equal(client.getSnapshot().permissionMode, "full-access");

  assert.equal((await client.getPersonalizationState()).catalogRevision, "catalog-revision-1");
  await client.updateChatPersonalization({ useMemories: "inherit", contributeMemories: "inherit" }, "catalog-revision-1");
  assert.equal(chatExpectedRevision, "catalog-revision-1");
  await client.updateGlobalPersonalization({ memory: memoryPolicy }, "config-revision-1");
  assert.equal(globalExpectedRevision, "config-revision-1");

  const exclusiveOperationsBeforeMemory = exclusiveOperations.length;
  await client.memory("write-v3", {
    expectedRevision: 7,
    entry: {
      audience: "workspace",
      kind: "fact",
      topic: "runtime-host",
      title: "Scoped revision",
      summary: "The scoped memory revision must reach the owner unchanged.",
      lineage: { source: "explicit", externalContext: false }
    }
  });
  assert.equal(memoryExpectedRevision, 7, "v3 memory CAS must not be replaced by the Runtime Host snapshot revision");
  assert.deepEqual(
    exclusiveOperations.slice(exclusiveOperationsBeforeMemory),
    ["memory"],
    "attached v3 memory requests must use the runtime maintenance boundary"
  );
  const exclusiveOperationsBeforeRead = exclusiveOperations.length;
  const remoteOverview = await client.memory<{
    maintenance: { state: string; eligible: number };
  }>("overview-v3", { selector: "all" });
  assert.deepEqual(
    exclusiveOperations.slice(exclusiveOperationsBeforeRead),
    [],
    "ordinary v3 memory reads must not occupy the runtime maintenance boundary"
  );
  assert.deepEqual(remoteOverview.maintenance, {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  });

  assert.equal((await client.memoryEmbeddingStatus()).activeModel?.kind, "local");
  await client.downloadMemoryEmbeddingModel("multilingual-e5-small");
  assert.equal(downloadedEmbeddingModel, "multilingual-e5-small");
  assert.deepEqual(await client.cancelMemoryEmbeddingDownload("multilingual-e5-small"), {
    cancelled: true,
    status: embeddingStatus()
  });
  const deletedEmbedding = await client.deleteMemoryEmbeddingModel("paraphrase-multilingual-MiniLM-L12-v2");
  assert.equal(removedEmbeddingModel, "paraphrase-multilingual-MiniLM-L12-v2");
  assert.equal(deletedEmbedding.filesDeleted, 2);
  assert.equal(deletedEmbedding.bytesFreed, 128);
  await client.rebuildMemoryEmbeddingIndex();
  assert.equal(embeddingRebuilds, 1);
  assert.deepEqual(await client.cancelMemoryEmbeddingRebuild(), { cancelled: true, status: embeddingStatus() });


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

  // startInterruptedTurn 非瞬时失败时，调用方拿不到的 completion 不得成为 unhandled rejection。
  // 前面的取消用例绕过了 revision 断言；这里先广播一次快照把客户端 revision 对齐到 Host。
  runtime.publish({ snapshot: currentSnapshot });
  await waitUntil(() => client.getSnapshot().revision === currentSnapshot.revision);
  const originalStartInterrupted = runtime.startInterruptedTurn;
  runtime.startInterruptedTurn = async () => { throw new Error("Cannot continue an interrupted turn while the runtime is busy."); };
  try {
    await assert.rejects(client.startInterruptedTurn(), /runtime is busy/u);
  } finally {
    runtime.startInterruptedTurn = originalStartInterrupted;
  }

  const secondClient = await connectRuntimeHost(workspace, { clientId: "test-client-2", surface: "desktop" });
  assert.ok(secondClient);
  assert.equal(secondClient.getSnapshot().info.sessionId, "session-host-test");
  await client.claimSession("session-host-test");
  const foreignSubmit = await secondClient.submitRun("must be rejected by the session writer claim");
  assert.equal(foreignSubmit.accepted, false, "另一个 client 不能绕过已登记的 session writer claim");
  assert.equal(foreignSubmit.errorCode, "session_writer_conflict");
  await assert.rejects(
    secondClient.claimSession("session-host-test"),
    /already open in another tui client/u
  );
  await client.releaseSessionClaim("session-host-test");
  const replayedTypes: string[] = [];
  const unsubscribeReplay = secondClient.subscribe((replayed) => {
    if (replayed.event) replayedTypes.push(replayed.event.type);
  });
  assert.equal(replayedTypes.includes("run.started"), true);
  unsubscribeReplay();
  await secondClient.close();
  // close() 必须了结挂起的 waitForIdle：busy 快照下挂起的等待不能永久悬置、泄漏 listener。
  runtime.publish({ snapshot: { ...currentSnapshot, state: runningSnapshot.state } });
  await waitUntil(() => client.getSnapshot().state.kind === "runs");
  const idleWait = client.waitForIdle();
  await client.close();
  await idleWait;
  await host.close();
  currentSnapshot = snapshot;
  const explicitResumeHost = await startRuntimeHost(workspace, runtime, commands, { resumeInterrupted: true });
  assert.equal(interruptedStarts, 1, "只有显式恢复开关才允许启动中断回合");
  await explicitResumeHost.close();
  assert.equal(await connectRuntimeHost(workspace, { clientId: "after-close", surface: "tui" }), undefined);

  // 注册窗口回归：registration 尚未落盘时，lock 内的活 pid 必须阻止第二个 owner 接管。
  await fs.writeFile(hostPaths.lockPath, `${String(process.pid)}\n`, { mode: 0o600 });
  await assert.rejects(startRuntimeHost(workspace, runtime, commands), /already running/u);
  assert.equal(await readFile(hostPaths.lockPath, "utf8"), `${String(process.pid)}\n`, "存活 owner 的 lock 不得被当作 stale 删除");
  await fs.rm(hostPaths.lockPath, { force: true });

  const incompatibleRegistration = {
    protocolVersion: 2,
    endpoint: hostPaths.endpoint,
    rootHash: hostPaths.rootHash,
    persistenceRoot: workspace,
    hostEpoch: "old-host-epoch",
    token: "old-host-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(hostPaths.registrationPath, JSON.stringify(incompatibleRegistration), { mode: 0o600 });
  await fs.chmod(hostPaths.registrationPath, 0o600);
  await assert.rejects(
    connectRuntimeHost(workspace, { clientId: "incompatible-client", surface: "tui" }),
    /protocol 2 is incompatible with 5/u
  );
  assert.deepEqual(JSON.parse(await readFile(hostPaths.registrationPath, "utf8")), incompatibleRegistration);
  await fs.rm(hostPaths.registrationPath);

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
        contextWindow: 128_000,
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
  await spawned.client.close();
  const replacementAgentRoot = path.join(spawnedWorkspace, "replacement-agent");
  const replacementConfigRoot = path.join(spawnedWorkspace, "replacement-config");
  const previousReplacementAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = replacementAgentRoot;
  try {
    // configDir 里可能短暂存在由 Runtime Host 读写锁创建的 .config.write.lock；
    // 它不是配置数据，复制整个目录会与锁的释放形成 TOCTOU，替换环境只复制稳定配置文件。
    await fs.mkdir(replacementConfigRoot, { recursive: true });
    await fs.copyFile(path.join(configDir, "config.json"), path.join(replacementConfigRoot, "config.json"));
    const replacementClient = await connectRuntimeHost(spawnedWorkspace, {
      clientId: "environment-replacement-client",
      surface: "desktop",
      spawnOptions: {
        workspaceRoot: spawnedWorkspace,
        configDir: replacementConfigRoot,
        resumeInterrupted: false
      }
    });
    assert.ok(replacementClient);
    const replacementRegistration = JSON.parse(
      await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")
    ) as { configRoot?: unknown; agentRoot?: unknown };
    assert.equal(replacementRegistration.configRoot, replacementConfigRoot);
    assert.equal(replacementRegistration.agentRoot, replacementAgentRoot);
    await replacementClient.close();
  } finally {
    if (previousReplacementAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousReplacementAgentRoot;
  }
  const replacementConfig = replacementConfigRoot;
  const replacementAgent = replacementAgentRoot;
  process.env.BINY_AGENT_DIR = replacementAgent;
  const reattached = await connectRuntimeHost(spawnedWorkspace, {
    clientId: "post-environment-replacement-client",
    surface: "cli",
    spawnOptions: {
      workspaceRoot: spawnedWorkspace,
      configDir: replacementConfig,
      resumeInterrupted: false
    }
  });
  assert.ok(reattached);
  await reattached.restartOwner();
  const restartedEpoch = reattached.hostInfo?.hostEpoch;
  assert.notEqual(restartedEpoch, initialEpoch);
  assert.equal(reattached.getSnapshot().info.workspaceRoot, spawnedWorkspace);
  // 模拟 owner 被系统杀掉：不会执行 Host.close，验证 registration/lock 的接管路径。
  const restartedRegistration = JSON.parse(await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")) as { pid?: unknown };
  if (typeof restartedRegistration.pid === "number") process.kill(restartedRegistration.pid, "SIGKILL");
  const takeoverDeadline = Date.now() + 10_000;
  while (reattached.hostInfo?.hostEpoch === restartedEpoch && Date.now() < takeoverDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.notEqual(reattached.hostInfo?.hostEpoch, initialEpoch);
  await reattached.close();
  if (previousReplacementAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousReplacementAgentRoot;
  const replacementRegistrationPath = runtimeHostPaths(spawnedWorkspace).registrationPath;
  try {
    const replacementRegistration = JSON.parse(await readFile(replacementRegistrationPath, "utf8")) as { pid?: unknown };
    if (typeof replacementRegistration.pid === "number") process.kill(replacementRegistration.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
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
