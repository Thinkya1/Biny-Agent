/**
 * 交互 Agent 的跨进程 Host。
 *
 * 一个 persistenceRoot 只有一个 owner 持有 InteractiveAgentRuntime；Desktop、TUI
 * 和其它本地客户端通过 Unix domain socket 共享同一份快照、事件序列和控制入口。
 * 这里不复制 Session/Agent 状态，也不把 Desktop IPC 复用成第二套协议。
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAttachment, AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { ContextStatus } from "../agent/context/types.js";
import type {
  BehaviorPatternReviewAction,
  TelosDocumentInput,
  TelosDriftResolutionAction,
  TelosScope
} from "../agent/context/telosTypes.js";
import type {
  MemoryEntryInput,
  MemoryEntryPatch,
  MemoryKind,
  MemoryLineage,
  MemoryLineageSource,
  MemoryOriginSelector
} from "../agent/context/memoryTypes.js";
import { thinkingLevelSchema } from "../config/schema.js";
import { globalAgentDir, globalConfigDir } from "../config/paths.js";
import {
  chatPersonalizationOverrideSchema,
  memoryPolicySchema,
  personalizationSettingsSchema,
  type AgentPersonalizationState,
  type ChatPersonalizationOverridePatch,
  type GlobalPersonalizationUpdate
} from "../personalization/index.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionSummary } from "../session/events.js";
import type { UsageSummary } from "../session/metadata.js";
import type { RuntimeCommandResult } from "./commands.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { CommandSurface } from "./commandRegistry.js";
import {
  type AgentRunOutcome,
  type InteractiveAgentHost,
  type InteractiveRuntimeHandle,
  type QueuedAgentMessage,
  type RuntimeRequestIds,
  type SubmittedAgentRun
} from "./InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot, RuntimeOperation } from "./agentEvents.js";
import type { RuntimeRunStatus } from "./RuntimeAuthority.js";
import { isTaskRunTerminal, type TaskRunStatus } from "./TaskRunStore.js";
import { evaluateTaskRetry } from "./TaskRetryPolicy.js";
import { AutomationScheduler, type AutomationCreateInput } from "./AutomationScheduler.js";
import { GraphSupervisor, type GraphNodeInput } from "./GoalGraphStore.js";
import type {
  CapabilityInvocation,
  CapabilityInvocationInput,
  CapabilityRegistration,
  CapabilityRegistrationInput,
  CapabilityStore
} from "./CapabilityStore.js";
import { cancelRuntimeGraph, executeRuntimeCommand } from "./commands.js";
import { listSessionSummaries } from "../session/events.js";
import { ensureAgentDirs, sessionIdFromFile } from "../session/store.js";
import { TurnStore } from "../session/turnStore.js";
import { SessionWriterConflictError } from "./SessionLease.js";

const protocolVersion = 3;
const eventHistoryLimit = 4_000;
const maxFrameBytes = 8 * 1024 * 1024;
const reconnectDelayMs = 250;
const maxUnixSocketPathLength = 90;
const hostStartupTimeoutMs = 8_000;
const hostJournalFile = "runtime-host-events.jsonl";
const memoryMaintenanceIntervalMs = 60 * 60 * 1_000;
const runtimeHostDirectoryName = "biny-runtime-host";

const hostCapabilities = [
  "runtime.authority",
  "runtime.events.cursor",
  "runtime.run.admission",
  "runtime.run.reconnect",
  "runtime.run.continuation",
  "runtime.start-draft",
  "task.ledger",
  "automation.scheduler",
  "agent.graph",
  "capability.channel",
  "personalization",
  "memory.v3",
  "telos.v1"
] as const;

type OperationLane = "query" | "mutation" | "admission" | "control" | "run";

export interface HostOperationResult<T = unknown> {
  accepted: boolean;
  revision: number;
  result?: T;
  reason?: string;
}

class OperationDispatcher {
  private readonly tails: Record<OperationLane, Promise<void>> = {
    query: Promise.resolve(),
    mutation: Promise.resolve(),
    admission: Promise.resolve(),
    control: Promise.resolve(),
    run: Promise.resolve()
  };

  dispatch<T>(lane: OperationLane, work: () => Promise<T>): Promise<T> {
    const result = this.tails[lane].then(work, work);
    this.tails[lane] = result.then(() => undefined, () => undefined);
    return result;
  }
}

type HostSurface = CommandSurface | "cli";

interface HostRegistration {
  protocolVersion: number;
  endpoint: string;
  registrationPath: string;
  lockPath: string;
  rootHash: string;
  persistenceRoot: string;
  configRoot?: string;
  agentRoot?: string;
  hostEpoch: string;
  token: string;
  pid: number;
  createdAt: string;
}

interface HostHelloFrame {
  kind: "hello";
  requestId: string;
  protocolVersion: number;
  rootHash: string;
  token: string;
  configRoot: string;
  agentRoot: string;
  clientId: string;
  surface: HostSurface;
  capabilities: string[];
}

interface HostRequestFrame {
  kind: "request";
  requestId: string;
  operation: string;
  payload: unknown;
}

interface HostResponseFrame {
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorData?: unknown;
}

interface HostEventFrame {
  kind: "event";
  hostEpoch: string;
  sequence: number;
  update: AgentRuntimeUpdate;
}

interface HostCompletionFrame {
  kind: "completion";
  runId: string;
  outcome: AgentRunOutcome;
}

interface HostGapFrame {
  kind: "gap";
  hostEpoch: string;
  sequence: number;
  snapshot: InteractiveRuntimeSnapshot;
}

interface HostCapabilityOfferFrame {
  kind: "capability-offer";
  invocation: CapabilityInvocation;
  registration: CapabilityRegistration;
}

type HostFrame = HostHelloFrame | HostRequestFrame | HostResponseFrame | HostEventFrame | HostCompletionFrame | HostGapFrame | HostCapabilityOfferFrame;

export interface RuntimeHostSpawnOptions {
  workspaceRoot: string;
  configDir?: string;
  attachmentRoot?: string;
  sessionId?: string;
  /** 仅显式恢复命令可以打开；普通 Host 启动必须保持 false。 */
  resumeInterrupted?: boolean;
  /** Electron 打包时由主进程显式提供；CLI/TUI 会自动推导 source/dist 路径。 */
  entryPath?: string;
}

export interface HostClientOptions {
  clientId?: string;
  surface?: HostSurface;
  /** owner 退出后，client 是否有足够 composition root 重新选举 Host。 */
  spawnOptions?: RuntimeHostSpawnOptions;
}

interface RuntimeHostClientOptions extends HostClientOptions {
  registration: HostRegistration;
  /** 仅用于先连上旧环境的空闲 owner，并立即完成同 endpoint 接管。 */
  environmentTakeover?: boolean;
}

interface HostConnection {
  socket: net.Socket;
  clientId: string;
  surface: HostSurface;
  subscribed: boolean;
  authenticated: boolean;
  buffer: string;
}

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingCompletion {
  resolve(outcome: AgentRunOutcome): void;
  reject(error: Error): void;
}

interface RuntimeHostPaths {
  endpoint: string;
  registrationPath: string;
  lockPath: string;
  rootHash: string;
}

export interface RuntimeHostInfo {
  endpoint: string;
  hostEpoch: string;
  sequence: number;
  persistenceRoot: string;
  protocolRevision: number;
  capabilities: readonly string[];
}

/** Runtime Host 重建 runtime 时使用的 composition root。 */
export type RuntimeHostFactory = (sessionId?: string) => Promise<InteractiveAgentHost>;

export interface RuntimeHostStartOptions {
  /** 远端请求新会话、配置重载或编辑分支时，按 sessionId 重建 owner。 */
  createRuntime?: RuntimeHostFactory;
  /** 显式要求 owner 进程启动后检查并续跑在途 turn。默认不续跑。 */
  resumeInterrupted?: boolean;
  /** Host 发现身份必须包含配置根，避免同一工作区的隔离实例复用错误 owner。 */
  configDir?: string;
}

export interface SpawnRuntimeHostOptions extends HostClientOptions, RuntimeHostSpawnOptions {}

export interface SpawnedRuntimeHost {
  process: ChildProcess;
  client: RuntimeHostClient;
}

/** 调用方可据此区分 attach 到已有 owner 与本次自行启动的 owner。 */
export interface ConnectedRuntimeHost {
  client: RuntimeHostClient;
  spawnedProcess?: ChildProcess;
}

/** 计算本机 runtime 的发现信息；socket 本身放在用户临时目录，不写入项目目录。 */
export function runtimeHostPaths(persistenceRoot: string): RuntimeHostPaths {
  const resolvedRoot = path.resolve(persistenceRoot);
  const rootHash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 24);
  const baseName = `biny-${rootHash}`;
  const temporaryRoot = os.tmpdir();
  const preferredDirectory = path.join(temporaryRoot, runtimeHostDirectoryName);
  const fallbackDirectory = path.join("/tmp", runtimeHostDirectoryName);
  const preferred = path.join(preferredDirectory, `${baseName}.sock`);
  // macOS 的临时目录有时很深，Unix socket 路径过长会直接返回 ENAMETOOLONG。
  const directory = preferred.length <= maxUnixSocketPathLength ? preferredDirectory : fallbackDirectory;
  const endpoint = path.join(directory, `${baseName}.sock`);
  return {
    endpoint,
    registrationPath: `${endpoint}.json`,
    lockPath: `${endpoint}.lock`,
    rootHash
  };
}

/** 连接现有 Host；没有注册信息或发现的是已退出的 owner 时返回 undefined。 */
export async function connectRuntimeHost(
  persistenceRoot: string,
  options: HostClientOptions = {}
): Promise<RuntimeHostClient | undefined> {
  if (process.platform === "win32") return undefined;
  const paths = runtimeHostPaths(persistenceRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = await readRegistration(paths);
  if (!registration) return undefined;
  if (registration.protocolVersion !== protocolVersion) {
    if (isProcessAlive(registration.pid)) {
      throw new Error(
        `Runtime Host protocol ${String(registration.protocolVersion)} is incompatible with ${String(protocolVersion)}. `
        + "Quit the running Biny Desktop/TUI process before starting this version."
      );
    }
    await removeStaleRegistration(registration);
    return undefined;
  }
  const identityMatches = registrationMatchesCurrentEnvironment(registration, options.spawnOptions);
  if (!identityMatches && options.spawnOptions === undefined) return undefined;
  try {
    const client = await RuntimeHostClient.connect({
      registration,
      clientId: options.clientId,
      surface: options.surface,
      spawnOptions: options.spawnOptions,
      environmentTakeover: !identityMatches
    });
    if (identityMatches) return client;
    try {
      // 已连接的 owner 来自另一个配置环境时，先通过只读 snapshot 确认空闲，
      // 再沿同一 endpoint 完成接管，保证运行账本始终只有一个 writer。
      await client.restartOwner();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!isConnectionRefused(error)) throw error;
    if (isProcessAlive(registration.pid)) return undefined;
    await removeStaleRegistration(registration);
    return undefined;
  }
}

/**
 * 先 attach，找不到 owner 时启动一个独立 Node Host 再 attach。
 *
 * 只有本次 spawn 的进程会通过 spawnedProcess 返回；attach 到其它 surface 的 owner 时，
 * 调用方不得把它当成可随意关闭的子进程。
 */
export async function connectOrSpawnRuntimeHostWithOwnership(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<ConnectedRuntimeHost | undefined> {
  const spawnOptions = toSpawnOptions(options);
  const attached = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions
  });
  if (attached) return { client: attached };
  try {
    const spawned = await spawnRuntimeHost(persistenceRoot, options);
    return { client: spawned.client, spawnedProcess: spawned.process };
  } catch (error) {
    // 两个 surface 同时启动时，另一个可能刚拿到 Host lock。失败后再 attach 一次，
    // 避免把正常的 owner 竞争误报成 Desktop 初始化失败。
    const raced = await connectRuntimeHost(persistenceRoot, {
      clientId: options.clientId,
      surface: options.surface,
      spawnOptions
    });
    if (raced) return { client: raced };
    throw error;
  }
}

/** 兼容不需要 owner 进程所有权的 TUI / CLI 调用方。 */
export async function connectOrSpawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<RuntimeHostClient | undefined> {
  return (await connectOrSpawnRuntimeHostWithOwnership(persistenceRoot, options))?.client;
}

/** 启动独立 Host 进程，并等待 registration/socket 真正可用。 */
export async function spawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<SpawnedRuntimeHost> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const child = spawnRuntimeHostProcess(persistenceRoot, options);
  const client = await waitForSpawnedRuntimeHost(persistenceRoot, options, child);
  return { process: child, client };
}

/** 只启动 owner 进程；用于已有 client 在断线后重新选举，不重复创建第二个 client。 */
export function spawnRuntimeHostProcess(
  persistenceRoot: string,
  options: RuntimeHostSpawnOptions
): ChildProcess {
  const entryPath = options.entryPath ?? process.env.BINY_RUNTIME_HOST_ENTRY ?? runtimeHostEntryPath();
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const nodeArgs = entryPath.endsWith(".ts") ? ["--import", "tsx", entryPath] : [entryPath];
  const child = spawn(process.execPath, [
    ...nodeArgs,
    "--workspace-root",
    path.resolve(options.workspaceRoot),
    "--persistence-root",
    path.resolve(persistenceRoot),
    ...(options.configDir === undefined ? [] : ["--config-dir", path.resolve(options.configDir)]),
    ...(options.attachmentRoot === undefined ? [] : ["--attachment-root", path.resolve(options.attachmentRoot)]),
    ...(options.sessionId === undefined ? [] : ["--session-id", options.sessionId]),
    ...(options.resumeInterrupted === true ? ["--resume-interrupted"] : [])
  ], {
    cwd: moduleRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" })
    }
  });
  child.unref();
  return child;
}

/** 在途状态按最近更新的会话选择；显式 sessionId 仍由调用方优先。 */
export async function findLatestInterruptedSession(persistenceRoot: string): Promise<string | undefined> {
  // Runtime Host 可能是当前工作区第一次启动；在扫描 session 之前先建立全局
  // session 目录，否则 `resumeInterrupted` 会在空工作区被不存在的目录阻断。
  await ensureAgentDirs(persistenceRoot);
  const summaries = await listSessionSummaries(persistenceRoot);
  for (const summary of summaries) {
    const sessionId = sessionIdFromFile(summary.fileName);
    if (await new TurnStore(persistenceRoot, sessionId).load()) return sessionId;
  }
  return undefined;
}

/** 当前进程创建 owner Host。若另一个 owner 抢先成功，调用方应关闭本地 runtime 后重连。 */
export async function startRuntimeHost(
  persistenceRoot: string,
  runtime: InteractiveRuntimeHandle,
  commands: CommandRuntime,
  options: RuntimeHostStartOptions = {}
): Promise<RuntimeHostServer> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const paths = runtimeHostPaths(persistenceRoot);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const lock = await acquireHostLock(paths, persistenceRoot);
  const hostEpoch = randomUUID();
  const token = randomUUID();
  const registration: HostRegistration = {
    protocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: path.resolve(persistenceRoot),
    configRoot: path.resolve(options.configDir ?? globalConfigDir()),
    agentRoot: path.resolve(globalAgentDir()),
    hostEpoch,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  let server: RuntimeHostServer | undefined;
  try {
    await removeSocketIfStale(paths.endpoint);
    server = new RuntimeHostServer(runtime, commands, registration, lock, options.createRuntime);
    await server.initialize();
    await server.listen();
    await writeRegistration(registration);
    server.startAutomationScheduler();
    if (options.resumeInterrupted) await server.resumeInterruptedTurn();
    server.startMemoryMaintenance();
    return server;
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (!server) await lock.close().catch(() => undefined);
    await removeStaleRegistration(registration).catch(() => undefined);
    throw error;
  }
}

/** Runtime owner 的本地 server。一个 server 可以被多个 Desktop/TUI client 订阅。 */
export class RuntimeHostServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly connections = new Set<HostConnection>();
  /** 一个 owner Runtime 只能同时切换一条 live session；ownership 绑定到具体 client。 */
  private readonly sessionWriterOwners = new Map<string, { clientId: string; surface: HostSurface }>();
  private readonly history: Array<{ sequence: number; update: AgentRuntimeUpdate }> = [];
  private readonly journalPath: string;
  private sequence = 0;
  private readonly dispatcher = new OperationDispatcher();
  private readonly automationScheduler: AutomationScheduler | undefined;
  private readonly graphSupervisor: GraphSupervisor | undefined;
  private journalTail: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  private runtime: InteractiveRuntimeHandle;
  private commands: CommandRuntime;
  private readonly createRuntime: RuntimeHostFactory | undefined;
  private closePromise: Promise<void> | undefined;
  private runtimeRestartPromise: Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> | undefined;
  private memoryMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private memoryMaintenanceAbort: AbortController | undefined;
  private memoryMaintenancePromise: Promise<void> | undefined;
  private listening = false;
  private initialized = false;

  constructor(
    runtime: InteractiveRuntimeHandle,
    commands: CommandRuntime,
    private readonly registration: HostRegistration,
    private readonly lock: FileHandle,
    createRuntime?: RuntimeHostFactory
  ) {
    this.runtime = runtime;
    this.commands = commands;
    this.createRuntime = createRuntime;
    this.journalPath = path.join(registration.persistenceRoot, ".biny", "runs", hostJournalFile);
    if (commands.automationStore) {
      this.automationScheduler = new AutomationScheduler({
        getRuntime: () => this.runtime,
        getStore: () => this.commands.automationStore,
        createFreshRuntime: createRuntime === undefined
          ? undefined
          : async () => {
            await this.restartRuntime(undefined);
            return this.runtime;
          }
      });
    }
    if (commands.graphs) {
      this.graphSupervisor = new GraphSupervisor({
        getStore: () => this.commands.graphs,
        getRuntime: () => this.runtime,
        getTaskRuns: () => this.commands.taskRuns
      });
    }
    this.unsubscribe = runtime.subscribe((update) => this.handleRuntimeUpdate(update));
  }

  startAutomationScheduler(): void {
    this.automationScheduler?.start();
    this.graphSupervisor?.start();
  }

  /**
   * 候选抽取是可中断的后台维护：启动时补扫，之后每小时扫描一次。用户一旦开始新回合，
   * handleRuntimeUpdate 会立即中断模型调用，让前台聊天始终优先；候选仍留在磁盘等待下次扫描。
   */
  startMemoryMaintenance(): void {
    if (this.memoryMaintenanceTimer) return;
    void this.runMemoryMaintenance();
    this.memoryMaintenanceTimer = setInterval(() => {
      void this.runMemoryMaintenance();
    }, memoryMaintenanceIntervalMs);
    this.memoryMaintenanceTimer.unref?.();
  }

  async runAutomation(automationId: string): Promise<unknown> {
    if (!this.automationScheduler) throw new Error("Automation scheduler is unavailable.");
    return await this.automationScheduler.runNow(automationId);
  }

  get info(): RuntimeHostInfo {
    return {
      endpoint: this.registration.endpoint,
      hostEpoch: this.registration.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.registration.persistenceRoot,
      protocolRevision: protocolVersion,
      capabilities: hostCapabilities
    };
  }

  /** 载入最近的持久事件；session JSONL 和 turnStore 仍是恢复事实来源。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const currentSessionId = this.runtime.getSnapshot().info.sessionId;
    try {
      const text = await fs.readFile(this.journalPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as unknown;
          const parsed = asRecord(record);
          const sequence = parsed.sequence;
          const update = parsed.update;
          if (!Number.isSafeInteger(sequence) || !isRuntimeUpdate(update)) continue;
          this.sequence = Math.max(this.sequence, sequence as number);
          if (update.snapshot.info.sessionId === currentSessionId) {
            this.history.push({ sequence: sequence as number, update });
          }
        } catch {
          // 单行损坏只影响该行；新的事件仍可继续追加。
        }
      }
      if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.initialized = true;
  }

  /** 由显式恢复入口触发续跑；普通 Host 启动不会调用此方法。 */
  async resumeInterruptedTurn(): Promise<void> {
    const submitted = await this.runtime.startInterruptedTurn();
    if (submitted) this.trackCompletion(submitted);
  }

  /** 当前 owner runtime；仅供同进程的 TUI fallback 在重建 session 后重新绑定。 */
  getCurrentRuntime(): InteractiveRuntimeHandle {
    return this.runtime;
  }

  /** 当前 owner command runtime；与 getCurrentRuntime() 成对使用。 */
  getCurrentCommands(): CommandRuntime {
    return this.commands;
  }

  /** 独立 Host 进程退出时同时关闭当前 owner runtime。 */
  async closeOwner(): Promise<void> {
    const runtime = this.runtime;
    await this.close();
    await runtime.close();
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        void secureRuntimeSocket(this.registration.endpoint).then(() => {
          this.listening = true;
          resolve();
        }, reject);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.registration.endpoint);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = (async () => {
      this.unsubscribe();
      this.automationScheduler?.stop();
      this.graphSupervisor?.stop();
      if (this.memoryMaintenanceTimer) clearInterval(this.memoryMaintenanceTimer);
      this.memoryMaintenanceTimer = undefined;
      this.memoryMaintenanceAbort?.abort();
      for (const connection of this.connections) connection.socket.destroy();
      await Promise.all([...this.sessionWriterOwners.keys()].map(async (sessionId) => await this.runtime.releaseSessionClaim(sessionId)));
      this.sessionWriterOwners.clear();
      this.connections.clear();
      if (this.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        this.listening = false;
      }
      await this.journalTail;
      await removeRegistration(this.registration);
      await this.lock.close();
    })();
    return await this.closePromise;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    const connection: HostConnection = {
      socket,
      clientId: "",
      surface: "cli",
      subscribed: false,
      authenticated: false,
      buffer: ""
    };
    this.connections.add(connection);
    socket.on("data", (chunk: string) => this.read(connection, chunk));
    socket.once("close", () => {
      this.connections.delete(connection);
      if (connection.clientId) this.commands.capabilities?.releaseOwner(connection.clientId);
      void this.releaseSessionWriters(connection.clientId);
    });
    socket.once("error", () => {
      this.connections.delete(connection);
      if (connection.clientId) this.commands.capabilities?.releaseOwner(connection.clientId);
      void this.releaseSessionWriters(connection.clientId);
    });
  }

  private handleRuntimeUpdate(update: AgentRuntimeUpdate): void {
    if (update.snapshot.state.kind !== "idle") this.memoryMaintenanceAbort?.abort();
    this.publish(update);
  }

  private async runMemoryMaintenance(): Promise<void> {
    if (this.memoryMaintenancePromise || this.runtime.getSnapshot().state.kind !== "idle") return;
    const controller = new AbortController();
    this.memoryMaintenanceAbort = controller;
    const commands = this.commands;
    const promise = (async () => {
      await commands.agent.getLocalMemory().loadMaintenanceStatus({ signal: controller.signal });
      controller.signal.throwIfAborted();
      // 候选入队时已经应用当回合的有效策略。这里按真实队列处理，避免聊天覆盖允许贡献后，
      // 又被当前全局开关拦住，导致已经承诺生成的候选永久滞留。
      if (this.runtime.getSnapshot().state.kind !== "idle") return;
      // 候选入队时已经应用当回合的有效策略。这里按真实队列处理，避免聊天覆盖允许贡献后，
      // 又被当前全局开关拦住，导致已经承诺生成的候选永久滞留。
      await commands.agent.getLocalMemory().processEligibleCandidates({ signal: controller.signal });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        // LocalMemory 将抽取/整理失败写入 maintenanceStatus；Host 不改变任何任务终态。
        void error;
      }
    }).finally(() => {
      if (this.memoryMaintenancePromise === promise) this.memoryMaintenancePromise = undefined;
      if (this.memoryMaintenanceAbort === controller) this.memoryMaintenanceAbort = undefined;
    });
    this.memoryMaintenancePromise = promise;
    await promise;
  }


  private read(connection: HostConnection, chunk: string): void {
    connection.buffer += chunk;
    if (Buffer.byteLength(connection.buffer, "utf8") > maxFrameBytes) {
      connection.socket.destroy(new Error("Runtime Host frame is too large."));
      return;
    }
    while (true) {
      const newline = connection.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        connection.socket.destroy(new Error("Invalid Runtime Host JSON frame."));
        return;
      }
      void this.handleFrame(connection, frame);
    }
  }

  private async handleFrame(connection: HostConnection, frame: unknown): Promise<void> {
    if (!connection.authenticated) {
      if (!isHelloFrame(frame)) {
        connection.socket.destroy(new Error("Runtime Host handshake required."));
        return;
      }
      if (
        frame.protocolVersion !== protocolVersion
        || frame.rootHash !== this.registration.rootHash
        || frame.token !== this.registration.token
        || frame.configRoot !== this.registration.configRoot
        || frame.agentRoot !== this.registration.agentRoot
      ) {
        connection.socket.destroy(new Error("Runtime Host handshake rejected."));
        return;
      }
      connection.authenticated = true;
      connection.clientId = frame.clientId;
      connection.surface = frame.surface;
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: true,
        result: {
          hostEpoch: this.registration.hostEpoch,
          persistenceRoot: this.registration.persistenceRoot,
          sequence: this.sequence,
          protocolRevision: protocolVersion,
          capabilities: hostCapabilities,
          eventCursor: this.sequence
        }
      });
      return;
    }
    if (!isRequestFrame(frame)) {
      connection.socket.destroy(new Error("Invalid Runtime Host request."));
      return;
    }
    try {
      const result = await this.dispatcher.dispatch(operationLane(frame.operation), async () => await this.execute(connection, frame));
      this.send(connection, { kind: "response", requestId: frame.requestId, ok: true, result });
    } catch (error) {
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: false,
        error: publicError(error),
        errorCode: publicErrorCode(error),
        errorData: publicErrorData(error)
      });
    }
  }

  private async execute(connection: HostConnection, frame: HostRequestFrame): Promise<unknown> {
    const payload = asRecord(frame.payload);
    switch (frame.operation) {
      case "snapshot":
        return { snapshot: this.runtime.getSnapshot(), sequence: this.sequence };
      case "subscribe":
        return this.subscribeConnection(
          connection,
          optionalSafeInteger(payload.afterSequence),
          optionalString(payload.afterHostEpoch)
        );
      case "submit": {
        this.assertRevision(payload);
        const ids = readRequestIds(payload);
        const submitted = this.runtime.submitPrompt(
          requiredString(payload.input, "input"),
          readRunMode(payload.mode),
          readAttachments(payload.attachments),
          ids
        );
        this.trackCompletion(submitted);
        return {
          runId: submitted.runId,
          messageId: submitted.messageId
        };
      }
      case "run.submit":
        return await this.executeAdmission(async () => {
          this.assertRevision(payload);
          const ids = readRequestIds(payload);
          const submitted = this.runtime.submitPrompt(
            requiredString(payload.input, "input"),
            readRunMode(payload.mode),
            readAttachments(payload.attachments),
            ids
          );
          this.trackCompletion(submitted);
          return { runId: submitted.runId, messageId: submitted.messageId };
        });
      case "queue": {
        this.assertRevision(payload);
        const ids = readRequestIds(payload);
        const input = requiredString(payload.input, "input");
        const attachments = readAttachments(payload.attachments);
        const delivery = payload.delivery === "steer" ? "steer" : "followUp";
        const queued = delivery === "steer"
          ? this.runtime.steer(input, attachments, ids)
          : this.runtime.followUp(input, attachments, ids);
        return queued;
      }
      case "run.queue":
        return await this.executeAdmission(async () => {
          this.assertRevision(payload);
          const ids = readRequestIds(payload);
          const input = requiredString(payload.input, "input");
          const attachments = readAttachments(payload.attachments);
          const delivery = payload.delivery === "steer" ? "steer" : "followUp";
          return delivery === "steer"
            ? this.runtime.steer(input, attachments, ids)
            : this.runtime.followUp(input, attachments, ids);
        });
      case "session.claim":
        await this.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return undefined;
      case "session.release":
        await this.releaseSessionWriter(connection, optionalString(payload.session));
        return undefined;
      case "resume":
        this.assertRevision(payload);
        await this.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return await this.runtime.resumeSession(requiredString(payload.session, "session"));
      case "start-interrupted": {
        this.assertRevision(payload);
        const submitted = await this.runtime.startInterruptedTurn(readRequestIds(payload));
        if (submitted) this.trackCompletion(submitted);
        return submitted === undefined
          ? undefined
          : { runId: submitted.runId, messageId: submitted.messageId };
      }
      case "cancel": {
        // 取消可绕过滞后的 revision，但必须绑定具体 run，不能让迟到请求影响后续运行。
        return this.runtime.cancelRun(requiredString(payload.runId, "runId"));
      }
      case "permission":
        this.assertRevision(payload);
        this.runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
        return undefined;
      case "run.cancel":
        return await this.executeControl(async () => {
          // 取消与运行状态更新并发到达时，不用 revision 拒绝同一 run，但不允许旧请求取消新 run。
          const runId = requiredString(payload.runId, "runId");
          const accepted = this.runtime.cancelRun(runId);
          if (!accepted) throw new Error(`Run ${runId} is not active.`);
          return { runId };
        });
      case "run.permission":
        return await this.executeControl(async () => {
          this.assertRevision(payload);
          this.runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
          return { requestId: requiredString(payload.requestId, "requestId") };
        });
      case "run.continue":
        return await this.executeAdmission(async () => await this.continueRun(payload));
      case "run.inspect": {
        const authority = this.commands.runtimeAuthority;
        if (!authority) return undefined;
        return authority.getRun(requiredString(payload.runId, "runId"));
      }
      case "run.list": {
        const authority = this.commands.runtimeAuthority;
        if (!authority) return { runs: [], hasMore: false };
        return authority.listRuns({
          sessionId: optionalString(payload.sessionId),
          status: readOptionalRunStatus(payload.status),
          limit: optionalSafeInteger(payload.limit),
          cursor: optionalString(payload.cursor)
        });
      }
      case "runtime.events": {
        const authority = this.commands.runtimeAuthority;
        if (!authority) return { events: [], hasMore: false, gap: false };
        return authority.readEvents({
          afterSequence: optionalSafeInteger(payload.afterSequence),
          limit: optionalSafeInteger(payload.limit),
          runId: optionalString(payload.runId),
          sessionId: optionalString(payload.sessionId)
        });
      }
      case "task.create":
        return await this.executeAdmission(async () => {
          const task = this.commands.taskRuns;
          const record = task.create({
            task: payload.task,
            sessionId: optionalString(payload.sessionId) ?? this.runtime.getSnapshot().info.sessionId,
            parentRunId: optionalString(payload.parentRunId)
          });
          return record;
        });
      case "task.start":
        return await this.executeAdmission(async () => {
          throw new Error("TaskRun start is unavailable until a TaskRun execution adapter is attached; use an explicit AgentRun, Automation, or Graph entrypoint.");
        });
      case "task.cancel":
        return await this.executeControl(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const reason = optionalString(payload.reason) ?? "TaskRun cancelled.";
          const task = this.commands.taskRuns.get(taskRunId);
          const subagent = this.commands.subagents?.getSnapshot(taskRunId);
          const cancelledSubagent = this.commands.subagents?.cancelTask(taskRunId, reason) ?? false;
          const runId = task?.attempts.at(-1)?.runId;
          if (runId !== undefined) this.runtime.cancelRun(runId);
          const subagentActive = subagent !== undefined && !["completed", "failed", "aborted", "timed_out"].includes(subagent.status);
          if (subagentActive && !cancelledSubagent && !isTaskRunTerminal(task?.status ?? "created")) {
            throw new Error(`Unable to cancel active subagent task ${taskRunId}.`);
          }
          if (task === undefined) throw new Error(`TaskRun ${taskRunId} does not exist.`);
          const current = this.commands.taskRuns.get(taskRunId);
          if (!current) throw new Error(`TaskRun ${taskRunId} does not exist.`);
          if (isTaskRunTerminal(current.status)) return current;
          return this.commands.taskRuns.transition(taskRunId, "cancelled");
        });
      case "task.approve":
        return await this.executeAdmission(async () => {
          throw new Error("TaskRun approval cannot start execution without an attached TaskRun execution adapter.");
        });
      case "task.resume":
        return await this.executeAdmission(async () => {
          throw new Error("TaskRun resume requires an explicit safe-boundary continuation admission; it cannot be inferred from a TaskRun status.");
        });
      case "task.retry":
        return await this.executeAdmission(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const decision = evaluateTaskRetry(this.commands.taskRuns.get(taskRunId));
          if (!decision.allowed) throw new Error(`Task retry rejected (${decision.code}): ${decision.reason}`);
          throw new Error(`Task retry admitted for ${decision.failureClass}, but no TaskRun execution adapter is attached; refusing to mark the task running without starting a new AgentRun.`);
        });
      case "task.get":
        return this.commands.taskRuns.get(requiredString(payload.taskRunId, "taskRunId"));
      case "task.list":
        return this.commands.taskRuns.list({
          status: readOptionalTaskStatus(payload.status),
          limit: optionalSafeInteger(payload.limit),
          cursor: optionalSafeInteger(payload.cursor)
        });
      case "task.events":
        return this.commands.taskRuns.events(requiredString(payload.taskRunId, "taskRunId"), optionalSafeInteger(payload.limit) ?? 100);
      case "automation.create":
        return await this.executeAdmission(async () => this.commands.automationStore.create(readAutomationCreateInput(payload)));
      case "automation.list":
        return this.commands.automationStore.list();
      case "automation.pause":
        return await this.executeControl(async () => this.commands.automationStore.pause(requiredString(payload.automationId, "automationId")));
      case "automation.resume":
        return await this.executeControl(async () => this.commands.automationStore.resume(requiredString(payload.automationId, "automationId")));
      case "automation.delete":
        return await this.executeControl(async () => {
          this.commands.automationStore.delete(requiredString(payload.automationId, "automationId"));
          return undefined;
        });
      case "automation.run":
        return await this.executeAdmission(async () => {
          if (!this.automationScheduler) throw new Error("Automation scheduler is unavailable.");
          return await this.automationScheduler.runNow(requiredString(payload.automationId, "automationId"));
        });
      case "automation.pending":
        return this.commands.automationStore.listPending(optionalString(payload.automationId));
      case "goal.create":
        return await this.executeAdmission(async () => this.commands.graphs.createGoal(
          requiredString(payload.title, "title"),
          payload.payload,
          optionalString(payload.goalId)
        ));
      case "goal.get":
        return this.commands.graphs.getGoal(requiredString(payload.goalId, "goalId"));
      case "goal.list":
        return this.commands.graphs.listGoals();
      case "goal.pause":
        return await this.executeControl(async () => this.commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "paused"));
      case "goal.resume":
        return await this.executeAdmission(async () => this.commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "active"));
      case "goal.cancel":
        return await this.executeControl(async () => this.commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "cancelled"));
      case "graph.create":
        return await this.executeAdmission(async () => this.commands.graphs.createGraph(
          optionalString(payload.goalId),
          readGraphNodes(payload.nodes),
          payload.payload,
          optionalString(payload.graphId)
        ));
      case "graph.start":
        return await this.executeAdmission(async () => {
          const graph = this.commands.graphs.startGraph(requiredString(payload.graphId, "graphId"));
          this.commands.graphs.createWake(graph.graphId, "graph_started");
          return graph;
        });
      case "graph.pause":
        return await this.executeControl(async () => this.commands.graphs.pauseGraph(requiredString(payload.graphId, "graphId")));
      case "graph.resume":
        return await this.executeAdmission(async () => {
          const graph = this.commands.graphs.resumeGraph(requiredString(payload.graphId, "graphId"));
          this.commands.graphs.createWake(graph.graphId, "graph_resumed");
          return graph;
        });
      case "graph.cancel":
        return await this.executeControl(async () => await this.cancelGraph(requiredString(payload.graphId, "graphId")));
      case "graph.inspect":
        return this.commands.graphs.inspectGraph(requiredString(payload.graphId, "graphId"));
      case "graph.list":
        return this.commands.graphs.listGraphs();
      case "graph.events":
        return this.commands.graphs.listGraphEvents(requiredString(payload.graphId, "graphId"));
      case "capability.register":
        return await this.executeAdmission(async () => {
          const ownerType = readCapabilityOwnerType(payload.ownerType);
          if (ownerType !== "client") throw new Error("Remote clients may only register client-owned capabilities.");
          const input: CapabilityRegistrationInput = {
            registrationId: optionalString(payload.registrationId),
            ownerType,
            ownerId: connection.clientId,
            capabilityName: requiredString(payload.capabilityName, "capabilityName"),
            schema: payload.schema,
            expiresAt: optionalString(payload.expiresAt)
          };
          return this.commands.capabilities.register(input);
        });
      case "capability.replace":
        return await this.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.replace(registrationId, payload.schema, optionalString(payload.expiresAt))
        ));
      case "capability.admit":
        return await this.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.admit(registrationId)
        ));
      case "capability.reject":
        return await this.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.reject(registrationId, optionalString(payload.reason) ?? "rejected")
        ));
      case "capability.release":
        return await this.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.release(registrationId, optionalString(payload.reason) ?? "released")
        ));
      case "capability.list":
        return this.commands.capabilities.list(payload.ownerId === undefined ? undefined : connection.clientId);
      case "capability.invoke":
        return await this.executeAdmission(async () => {
          const registrationId = requiredString(payload.registrationId, "registrationId");
          const registration = this.commands.capabilities.get(registrationId);
          if (!registration || registration.ownerType !== "client") {
            throw new Error("Remote clients may only invoke client-owned capabilities.");
          }
          const invocation = this.commands.capabilities.invoke({
            registrationId,
            offerId: optionalString(payload.offerId),
            sessionId: optionalString(payload.sessionId),
            turnId: optionalString(payload.turnId),
            toolCallId: optionalString(payload.toolCallId),
            request: payload.request
          }, optionalString(payload.invocationId));
          const owner = [...this.connections].find((candidate) => candidate.clientId === registration.ownerId && candidate.authenticated);
          if (owner) this.send(owner, { kind: "capability-offer", invocation, registration });
          return invocation;
        });
      case "capability.accept":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.accept(invocationId)));
      case "capability.start":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.start(invocationId)));
      case "capability.result":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.result(invocationId, payload.result)));
      case "capability.chunk":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.chunk(invocationId, requiredInteger(payload.chunkIndex, "chunkIndex"), payload.data, payload.final === true)));
      case "capability.fail":
        return await this.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.fail(invocationId, optionalString(payload.error) ?? "capability failed")));
      case "capability.cancel":
        return await this.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.cancel(invocationId, optionalString(payload.reason) ?? "capability cancelled")));
      case "capability.get":
        return this.commands.capabilities.getInvocation(requiredString(payload.invocationId, "invocationId"));
      case "wait-idle":
        await this.runtime.waitForIdle();
        return undefined;
      case "compact":
        this.assertRevision(payload);
        return await this.runtime.compactConversation(optionalString(payload.hint));
      case "command": {
        this.assertRevision(payload);
        const source = readSurface(payload.source ?? connection.surface);
        const result = await executeRuntimeCommand(
          this.runtime,
          this.commands,
          requiredString(payload.input, "input"),
          source === "desktop" ? "desktop" : "tui"
        );
        return result;
      }
      case "agent.context":
        return await this.commands.agent.contextStatus();
      case "agent.usage":
        return {
          summary: this.commands.agent.usageSummary(),
          report: this.commands.agent.usageReport(),
          modelRequests: this.commands.agent.modelRequestSummary()
        };
      case "agent.models":
        return this.commands.agent.listModels();
      case "agent.refresh-model":
        this.assertRevision(payload);
        return await this.runtime.runExclusiveOperation("refresh_model", async () => {
          const info = await this.commands.agent.refreshModelFromDisk();
          this.publishSnapshot();
          return info;
        });
      case "agent.switch-model":
        this.assertRevision(payload);
        return await this.runtime.runExclusiveOperation(
          "switch_model",
          async () => {
            const info = await this.commands.agent.switchModel(requiredString(payload.alias, "alias"), readThinking(payload.thinking));
            // 模型信息不一定伴随回合事件变化；主动广播才能让已连接的 App/TUI
            // 共享同一份当前模型和思考深度，而不是只有发起请求的一侧拿到新值。
            this.publishSnapshot();
            return info;
          }
        );
      case "agent.permission-mode":
        this.assertRevision(payload);
        await this.runtime.runExclusiveOperation(
          "permission",
          async () => await this.commands.agent.setPermissionMode(readPermissionMode(payload.mode))
        );
        // 权限模式是跨端共享的配置状态；模型切换后已有广播，权限切换也必须让其它
        // 已连接的 Desktop/TUI 立即收到同一份快照。
        this.publishSnapshot();
        return this.runtime.getSnapshot().permissionMode;
      case "agent.permission-command": {
        this.assertRevision(payload);
        const permissionCommandResult = await this.runtime.runExclusiveOperation(
          "permission",
          async () => await this.commands.agent.runPermissionCommand(readStringArray(payload.args, "args"))
        );
        this.publishSnapshot();
        return permissionCommandResult;
      }
      case "agent.sessions":
        return await this.commands.agent.listSessions();
      case "personalization.get":
        return await this.commands.agent.getPersonalizationState();
      case "personalization.update-chat":
        return await this.runtime.runExclusiveOperation(
          "personalization",
          async () => await this.commands.agent.updateChatPersonalization(
            chatPersonalizationOverrideSchema.partial().strict().parse(payload.patch),
            requiredString(payload.expectedRevision, "expectedRevision")
          )
        );
      case "personalization.update-global": {
        const update = asRecord(payload.update);
        return await this.runtime.runExclusiveOperation(
          "personalization",
          async () => await this.commands.agent.updateGlobalPersonalization({
            personalization: update.personalization === undefined
              ? undefined
              : personalizationSettingsSchema.parse(update.personalization),
            memory: update.memory === undefined
              ? undefined
              : memoryPolicySchema.parse(update.memory)
          }, requiredString(payload.expectedRevision, "expectedRevision"))
        );
      }
      case "skills.list":
        return this.commands.listSkills();
      case "skills.expand":
        return await this.commands.expandSkillCommand(requiredString(payload.input, "input"));
      case "mcp.status":
        return this.commands.mcp.listServers();
      case "mcp.details":
        return await this.commands.mcp.describeServer(requiredString(payload.server, "server"));
      case "mcp.reconnect":
        return await this.runtime.runExclusiveOperation(
          "mcp",
          async () => await this.commands.mcp.reconnectServer(requiredString(payload.server, "server"))
        );
      case "memory":
        // 记忆写入与整理不能和活动回合竞争同一 AgentSession。
        return await this.runtime.runExclusiveOperation(
          "memory",
          async () => await this.executeMemory(payload)
        );
      case "telos":
        // TELOS 与事实记忆共用同一个 runtime 独占边界，但使用独立存储和 revision。
        return await this.runtime.runExclusiveOperation(
          "telos",
          async () => await this.executeTelos(payload)
        );
      case "runtime.restart":
        this.assertRevision(payload);
        {
          const sessionId = optionalString(payload.sessionId);
          // 编辑历史消息会先重建对应 AgentSession；它和 resume 一样必须先取得
          // writer claim，否则第二个 surface 可能在重建后悄悄接管同一份 transcript。
          if (sessionId !== undefined) await this.claimSessionWriter(connection, sessionId);
          const result = await this.restartRuntime(sessionId);
          if (sessionId !== undefined) {
            this.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface });
          }
          return result;
        }
      case "runtime.start-draft":
        this.assertRevision(payload);
        return await this.startDraftRuntime();
      case "host.info":
        return this.info;
      default:
        throw new Error(`Unknown Runtime Host operation: ${frame.operation}`);
    }
  }

  private async executeAdmission<T>(execute: () => Promise<T>): Promise<HostOperationResult<T>> {
    try {
      const result = await execute();
      return { accepted: true, revision: this.runtime.getSnapshot().revision, result };
    } catch (error) {
      return { accepted: false, revision: this.runtime.getSnapshot().revision, reason: publicError(error) };
    }
  }

  private async executeControl<T>(execute: () => Promise<T>): Promise<HostOperationResult<T>> {
    try {
      const result = await execute();
      return { accepted: true, revision: this.runtime.getSnapshot().revision, result };
    } catch (error) {
      return { accepted: false, revision: this.runtime.getSnapshot().revision, reason: publicError(error) };
    }
  }

  private withCapabilityOwner<T>(connection: HostConnection, invocationId: string, execute: (capabilities: CapabilityStore, invocationId: string) => T): T {
    const invocation = this.commands.capabilities.getInvocation(invocationId);
    if (!invocation) throw new Error(`Capability invocation ${invocationId} was not found.`);
    const registration = this.commands.capabilities.get(invocation.registrationId);
    if (!registration || registration.ownerType !== "client" || registration.ownerId !== connection.clientId) {
      throw new Error("Capability invocation owner mismatch.");
    }
    return execute(this.commands.capabilities, invocationId);
  }

  private withCapabilityRegistrationOwner<T>(
    connection: HostConnection,
    registrationId: string,
    execute: (capabilities: CapabilityStore, registrationId: string) => T
  ): T {
    const registration = this.commands.capabilities.get(registrationId);
    if (!registration || registration.ownerType !== "client" || registration.ownerId !== connection.clientId) {
      throw new Error("Capability registration owner mismatch.");
    }
    return execute(this.commands.capabilities, registrationId);
  }

  private async cancelGraph(graphId: string): Promise<unknown> {
    return await cancelRuntimeGraph(this.runtime, this.commands, graphId);
  }

  private async continueRun(payload: Record<string, unknown>): Promise<{ runId: string; messageId: string }> {
    const authority = this.commands.runtimeAuthority;
    const sourceRunId = requiredString(payload.sourceRunId, "sourceRunId");
    const source = authority?.getRun(sourceRunId);
    if (!source) throw new Error(`Continuation source run ${sourceRunId} was not found.`);
    if (source.terminalStatus !== "incomplete" && source.terminalStatus !== "blocked" && source.terminalStatus !== "unknown") {
      throw new Error(`Run ${sourceRunId} is not resumable.`);
    }
    const ids = readRequestIds(payload);
    const childRunId = ids.runId ?? randomUUID();
    const claim = authority?.claimContinuation(sourceRunId, childRunId);
    const existingChild = claim === undefined ? undefined : authority?.getRun(claim.childRunId);
    if (existingChild) {
      const childPayload = asRecord(existingChild.payload);
      return {
        runId: existingChild.runId,
        messageId: typeof childPayload.messageId === "string" ? childPayload.messageId : ids.messageId ?? randomUUID()
      };
    }
    try {
      const submitted = await this.runtime.startInterruptedTurn({
        ...ids,
        runId: claim?.childRunId ?? childRunId,
        turnId: source.turnId,
        parentRunId: sourceRunId,
        continuationSource: "safe_boundary_continuation"
      });
      if (!submitted) throw new Error("There is no interrupted turn available for continuation.");
      this.trackCompletion(submitted);
      return { runId: submitted.runId, messageId: submitted.messageId };
    } catch (error) {
      // claim 发生在真正读取断点之前；读取失败或没有断点时必须释放它，否则
      // 后续恢复请求会被旧 childRunId 永久挡住。若 child 已经落库，release 会保留 claim。
      if (claim) authority?.releaseContinuationClaim(sourceRunId, claim.childRunId, "continuation admission failed");
      throw error;
    }
  }

  private subscribeConnection(
    connection: HostConnection,
    afterSequence: number | undefined,
    afterHostEpoch: string | undefined
  ): { hostEpoch: string; snapshot: InteractiveRuntimeSnapshot; sequence: number; replayed: boolean; capabilities: readonly string[] } {
    connection.subscribed = true;
    const sameEpoch = afterHostEpoch === undefined || afterHostEpoch === this.registration.hostEpoch;
    const replayed = sameEpoch && (afterSequence === undefined || this.canReplay(afterSequence));
    if (afterSequence === undefined && sameEpoch) {
      for (const item of this.history) this.sendEvent(connection, item.sequence, item.update);
    } else if (replayed && afterSequence !== undefined) {
      for (const item of this.history) {
        if (item.sequence > afterSequence) {
          this.sendEvent(connection, item.sequence, item.update);
        }
      }
    } else if (!replayed) {
      this.send(connection, {
        kind: "gap",
        hostEpoch: this.registration.hostEpoch,
        sequence: this.sequence,
        snapshot: this.runtime.getSnapshot()
      });
    }
    return { hostEpoch: this.registration.hostEpoch, snapshot: this.runtime.getSnapshot(), sequence: this.sequence, replayed, capabilities: hostCapabilities };
  }

  private async claimSessionWriter(connection: HostConnection, session: string): Promise<void> {
    const sessionId = sessionIdFromFile(session);
    const foreignOwner = [...this.sessionWriterOwners.entries()].find(([, owner]) => owner.clientId !== connection.clientId);
    if (foreignOwner) {
      throw new SessionWriterConflictError(
        sessionId,
        this.registration.pid,
        foreignOwner[1].surface,
        `Session ${sessionId} is already open in another ${foreignOwner[1].surface} client.`
      );
    }
    const currentOwner = this.sessionWriterOwners.get(sessionId);
    if (currentOwner?.clientId === connection.clientId) return;
    await this.releaseSessionWriters(connection.clientId);
    await this.runtime.claimSession(sessionId);
    this.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface });
  }

  private async releaseSessionWriter(connection: HostConnection, session?: string): Promise<void> {
    if (session === undefined) {
      await this.releaseSessionWriters(connection.clientId);
      return;
    }
    const sessionId = sessionIdFromFile(session);
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.clientId !== connection.clientId) return;
    this.sessionWriterOwners.delete(sessionId);
    await this.runtime.releaseSessionClaim(sessionId);
  }

  private async releaseSessionWriters(clientId: string): Promise<void> {
    if (!clientId) return;
    const owned = [...this.sessionWriterOwners.entries()]
      .filter(([, owner]) => owner.clientId === clientId)
      .map(([sessionId]) => sessionId);
    for (const sessionId of owned) {
      this.sessionWriterOwners.delete(sessionId);
      await this.runtime.releaseSessionClaim(sessionId);
    }
  }

  private canReplay(afterSequence: number): boolean {
    if (afterSequence >= this.sequence) return true;
    const first = this.history[0]?.sequence;
    return first !== undefined && afterSequence >= first - 1;
  }

  private publish(update: AgentRuntimeUpdate): void {
    this.sequence += 1;
    const sequence = this.sequence;
    this.history.push({ sequence, update });
    if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    const compactedJournal = sequence % eventHistoryLimit === 0
      ? this.history.map((item) => JSON.stringify(item)).join("\n") + "\n"
      : undefined;
    this.journalTail = this.journalTail
      .then(async () => {
        if (compactedJournal !== undefined) await fs.writeFile(this.journalPath, compactedJournal, { mode: 0o600 });
        else await fs.appendFile(this.journalPath, `${JSON.stringify({ sequence, update })}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed) this.sendEvent(connection, sequence, update);
    }
  }

  private publishSnapshot(): void {
    this.publish({ snapshot: this.runtime.getSnapshot() });
  }

  private sendEvent(connection: HostConnection, sequence: number, update: AgentRuntimeUpdate): void {
    this.send(connection, { kind: "event", hostEpoch: this.registration.hostEpoch, sequence, update });
  }

  private trackCompletion(submitted: SubmittedAgentRun): void {
    void submitted.completion.then(
      (outcome) => this.broadcastCompletion(submitted.runId, outcome),
      () => undefined
    );
  }

  private broadcastCompletion(runId: string, outcome: AgentRunOutcome): void {
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed) this.send(connection, { kind: "completion", runId, outcome });
    }
  }

  private async executeMemory(payload: Record<string, unknown>): Promise<unknown> {
    const memory = this.commands.agent.getLocalMemory();
    const action = requiredString(payload.action, "action");
    if (action === "overview-v3") {
      const selector = readMemoryOriginSelector(payload.selector, true);
      // 两个投影必须对应同一个单库 revision；其它进程可能在两次读取之间提交写入。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const overview = await memory.getOverview();
        const entries = await memory.listMemoryEntries({ origins: [selector] });
        const allEntries = await memory.listMemoryEntries({ origins: ["all"] });
        if (overview.storeRevision === entries.storeRevision && overview.storeRevision === allEntries.storeRevision) {
          return {
            overview,
            entries,
            allEntries,
            maintenance: await memory.loadMaintenanceStatus()
          };
        }
      }
      throw new Error("Memory store changed repeatedly while reading the v3 overview.");
    }
    if (action === "list-v3") {
      return await memory.listMemoryEntries({
        origins: [readMemoryOriginSelector(payload.selector, true)],
        topic: optionalString(payload.topic),
        limit: optionalSafeInteger(payload.limit)
      });
    }
    if (action === "search-v3") {
      return await this.commands.agent.searchMemory(
        requiredString(payload.query, "query"),
        payload.paths === undefined ? [] : readStringArray(payload.paths, "paths"),
        {
          origins: [readMemoryOriginSelector(payload.selector, true)],
          limit: optionalSafeInteger(payload.limit),
          maxChars: optionalSafeInteger(payload.maxChars)
        }
      );
    }
    if (action === "write-v3") {
      const result = await memory.writeEntry(readMemoryEntryInput(payload.entry), {
        expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
      });
      return result;
    }
    if (action === "update-v3") {
      const result = await memory.updateEntry(
        requiredString(payload.id, "id"),
        readMemoryEntryPatch(payload.patch),
        { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
      );
      return result;
    }
    if (action === "delete-v3") {
      const id = requiredString(payload.id, "id");
      const result = await memory.deleteEntryById(
        id,
        { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
      );
      return result;
    }
    if (action === "clear-v3") {
      const selector = readMemoryOriginSelector(payload.selector, true);
      const result = await memory.clearEntries(selector, {
        expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
      });
      return result;
    }
    if (action === "consolidate-v3") {
      const selector = readMemoryOriginSelector(payload.selector, true);
      const expectedRevision = requiredInteger(payload.expectedRevision, "expectedRevision");
      const result = await memory.consolidateEntries(selector, {
        expectedRevision,
        topic: optionalString(payload.topic)
      });
      return result;
    }
    throw new Error(`Unknown memory operation: ${action}`);
  }

  private async executeTelos(payload: Record<string, unknown>): Promise<unknown> {
    const storage = this.commands.agent.getTelosStorage();
    const action = requiredString(payload.action, "action");
    if (action === "overview-v1") return await storage.overview();
    if (action === "save-v1") {
      return await storage.saveDocument(
        readTelosDocumentInput(payload.input),
        requiredInteger(payload.expectedRevision, "expectedRevision")
      );
    }
    if (action === "review-pattern-v1") {
      return await storage.reviewPattern(
        requiredString(payload.patternId, "patternId"),
        readTelosPatternAction(payload.reviewAction),
        requiredInteger(payload.expectedRevision, "expectedRevision"),
        { detectDrift: payload.detectDrift !== false }
      );
    }
    if (action === "resolve-drift-v1") {
      return await storage.resolveDrift(
        requiredString(payload.driftId, "driftId"),
        readTelosDriftAction(payload.driftAction),
        requiredInteger(payload.expectedRevision, "expectedRevision")
      );
    }
    if (action === "snooze-drift-v1") {
      const until = requiredString(payload.until, "until");
      if (Number.isNaN(Date.parse(until))) throw new Error("Runtime Host TELOS snooze date is invalid.");
      return await storage.snoozeDrift(
        requiredString(payload.driftId, "driftId"),
        until,
        requiredInteger(payload.expectedRevision, "expectedRevision")
      );
    }
    throw new Error(`Unknown TELOS operation: ${action}`);
  }

  private assertRevision(payload: Record<string, unknown>): void {
    const expected = optionalSafeInteger(payload.expectedRevision);
    if (expected === undefined) return;
    const current = this.runtime.getSnapshot().revision;
    if (expected !== current) {
      throw new Error(`Runtime Host revision conflict: expected ${String(expected)}, current ${String(current)}.`);
    }
  }

  async restartRuntime(sessionId?: string): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    if (this.runtimeRestartPromise) return await this.runtimeRestartPromise;
    const restart = this.performRuntimeRestart(sessionId);
    this.runtimeRestartPromise = restart;
    try {
      return await restart;
    } finally {
      if (this.runtimeRestartPromise === restart) this.runtimeRestartPromise = undefined;
    }
  }

  /** 让 owner 切到一个全新的空会话（plan draft），不重建 runtime；旧的 writer claim 一并作废。 */
  async startDraftRuntime(): Promise<AgentSessionInfo> {
    const info = await this.runtime.startDraft();
    this.sessionWriterOwners.clear();
    this.publish({ snapshot: this.runtime.getSnapshot() });
    return info;
  }

  private async performRuntimeRestart(sessionId?: string): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    if (!this.createRuntime) throw new Error("Runtime Host owner cannot rebuild its runtime.");
    if (this.runtime.getSnapshot().state.kind !== "idle") throw new Error("Cannot rebuild the Runtime Host while it is busy.");
    const next = await this.createRuntime(sessionId);
    const previous = this.runtime;
    this.unsubscribe();
    this.runtime = next.runtime;
    this.commands = next.commands;
    this.unsubscribe = next.runtime.subscribe((update) => this.handleRuntimeUpdate(update));
    this.commands.graphs.recoverRunningNodes(this.commands.taskRuns);
    await previous.close();
    this.sessionWriterOwners.clear();
    this.history.splice(0);
    this.publish({ snapshot: this.runtime.getSnapshot() });
    return { snapshot: this.runtime.getSnapshot(), sequence: this.sequence };
  }

  private send(connection: HostConnection, frame: HostFrame): void {
    if (connection.socket.destroyed) return;
    connection.socket.write(`${JSON.stringify(frame)}\n`);
  }
}

/** 可重连的 owner client。实时事件使用 host sequence，重连后优先从内存历史补发。 */
export class RuntimeHostClient implements InteractiveRuntimeHandle {
  readonly persistenceRoot: string;
  readonly clientId: string;
  private socket: net.Socket | undefined;
  private buffer = "";
  private readyPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly listeners = new Set<(update: AgentRuntimeUpdate) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly capabilityOfferListeners = new Set<(offer: { invocation: CapabilityInvocation; registration: CapabilityRegistration }) => void>();
  private readonly pendingUpdates: AgentRuntimeUpdate[] = [];
  private snapshot: InteractiveRuntimeSnapshot | undefined;
  private sequence = 0;
  private hostEpoch: string | undefined;
  private capabilities: readonly string[] = [];
  private closed = false;
  private lastError: Error | undefined;
  private reconnectInProgress = false;
  private ownerRestartPromise: Promise<void> | undefined;
  private environmentTakeoverHandshake: boolean;

  private constructor(private readonly options: RuntimeHostClientOptions) {
    this.persistenceRoot = options.registration.persistenceRoot;
    this.clientId = options.clientId ?? `client-${randomUUID()}`;
    this.environmentTakeoverHandshake = options.environmentTakeover === true;
  }

  static async connect(options: RuntimeHostClientOptions): Promise<RuntimeHostClient> {
    const client = new RuntimeHostClient(options);
    await client.open();
    return client;
  }

  get hostInfo(): RuntimeHostInfo | undefined {
    if (!this.hostEpoch) return undefined;
    return {
      endpoint: this.options.registration.endpoint,
      hostEpoch: this.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.persistenceRoot,
      protocolRevision: protocolVersion,
      capabilities: this.capabilities
    };
  }

  submitPrompt(input: string, mode: AgentRunMode = "chat", attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): SubmittedAgentRun {
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    void this.request<{ runId: string; messageId: string }>("submit", {
      input,
      mode,
      attachments,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      parentRunId: ids.parentRunId,
      continuationSource: ids.continuationSource,
      expectedRevision: this.currentRevision()
    })
      .catch((error) => {
        if (isTransientHostError(error)) {
          this.reportError(error);
          this.scheduleReconnect();
        } else {
          this.rejectCompletion(ids.runId, error);
        }
      });
    return { runId: ids.runId, messageId: ids.messageId, completion };
  }

  /** 明确返回 admission 结果的跨进程 API；旧 submitPrompt 保持乐观同步句柄兼容。 */
  async submitRun(
    input: string,
    mode: AgentRunMode = "chat",
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds
  ): Promise<HostOperationResult<{ runId: string; messageId: string }>> {
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.submit", {
      input,
      mode,
      attachments,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      parentRunId: ids.parentRunId,
      continuationSource: ids.continuationSource,
      expectedRevision: this.currentRevision()
    });
  }

  async queueRunMessage(
    input: string,
    delivery: "steer" | "followUp",
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds
  ): Promise<HostOperationResult<QueuedAgentMessage>> {
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.queue", {
      input,
      delivery,
      attachments,
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    });
  }

  async cancelRunRequest(runId: string): Promise<HostOperationResult<{ runId: string }>> {
    return await this.request("run.cancel", { runId });
  }

  async answerPermissionRequest(requestId: string, result: PermissionResult): Promise<HostOperationResult<{ requestId: string }>> {
    return await this.request("run.permission", { requestId, result, expectedRevision: this.currentRevision() });
  }

  async continueRun(sourceRunId: string, requestIds?: RuntimeRequestIds): Promise<HostOperationResult<{ runId: string; messageId: string }>> {
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.continue", {
      sourceRunId,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      expectedRevision: this.currentRevision()
    });
  }

  async inspectRun(runId: string): Promise<unknown> {
    return await this.request("run.inspect", { runId });
  }

  async listRuns(options: { sessionId?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<unknown> {
    return await this.request("run.list", options);
  }

  async subscribeRuntimeEvents(options: { afterSequence?: number; runId?: string; sessionId?: string; limit?: number } = {}): Promise<unknown> {
    return await this.request("runtime.events", options);
  }

  async taskCreate(input: { task: unknown; taskRunId?: string; sessionId?: string; parentRunId?: string }): Promise<HostOperationResult<unknown>> {
    return await this.request("task.create", input);
  }

  async taskStart(taskRunId: string, input: { attemptId?: string; runId?: string; turnId?: string; retrySafety?: string } = {}): Promise<HostOperationResult<unknown>> {
    return await this.request("task.start", { taskRunId, ...input });
  }

  async taskCancel(taskRunId: string, reason?: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.cancel", { taskRunId, reason });
  }

  async taskApprove(taskRunId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.approve", { taskRunId });
  }

  async taskResume(taskRunId: string, input: { runId?: string; turnId?: string; retrySafety?: string } = {}): Promise<HostOperationResult<unknown>> {
    return await this.request("task.resume", { taskRunId, ...input });
  }

  async taskRetry(taskRunId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.retry", { taskRunId });
  }

  async taskGet(taskRunId: string): Promise<unknown> {
    return await this.request("task.get", { taskRunId });
  }

  async taskList(options: { status?: string; limit?: number; cursor?: number } = {}): Promise<unknown> {
    return await this.request("task.list", options);
  }

  async taskEvents(taskRunId: string, limit?: number): Promise<unknown> {
    return await this.request("task.events", { taskRunId, limit });
  }

  async automationCreate(input: AutomationCreateInput): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.create", input);
  }

  async automationList(): Promise<unknown> {
    return await this.request("automation.list", {});
  }

  async automationPause(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.pause", { automationId });
  }

  async automationResume(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.resume", { automationId });
  }

  async automationDelete(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.delete", { automationId });
  }

  async automationRun(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.run", { automationId });
  }

  async automationPending(automationId?: string): Promise<unknown> {
    return await this.request("automation.pending", { automationId });
  }

  async goalCreate(title: string, payload?: unknown, goalId?: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.create", { title, payload, goalId });
  }

  async goalGet(goalId: string): Promise<unknown> {
    return await this.request("goal.get", { goalId });
  }

  async goalList(): Promise<unknown> {
    return await this.request("goal.list", {});
  }

  async goalPause(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.pause", { goalId });
  }

  async goalResume(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.resume", { goalId });
  }

  async goalCancel(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.cancel", { goalId });
  }

  async graphCreate(input: { goalId?: string; nodes: GraphNodeInput[]; payload?: unknown; graphId?: string }): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.create", input);
  }

  async graphStart(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.start", { graphId });
  }

  async graphPause(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.pause", { graphId });
  }

  async graphResume(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.resume", { graphId });
  }

  async graphCancel(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.cancel", { graphId });
  }

  async graphInspect(graphId: string): Promise<unknown> {
    return await this.request("graph.inspect", { graphId });
  }

  async graphList(): Promise<unknown> {
    return await this.request("graph.list", {});
  }

  async graphEvents(graphId: string): Promise<unknown> {
    return await this.request("graph.events", { graphId });
  }

  async capabilityRegister(input: Omit<CapabilityRegistrationInput, "ownerId">): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.register", input);
  }

  async capabilityReplace(registrationId: string, schema: unknown, expiresAt?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.replace", { registrationId, schema, expiresAt });
  }

  async capabilityAdmit(registrationId: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.admit", { registrationId });
  }

  async capabilityReject(registrationId: string, reason?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.reject", { registrationId, reason });
  }

  async capabilityRelease(registrationId: string, reason?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.release", { registrationId, reason });
  }

  async capabilityList(): Promise<CapabilityRegistration[]> {
    return await this.request("capability.list", {});
  }

  async capabilityInvoke(input: Omit<CapabilityInvocationInput, "invocationId">): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.invoke", input);
  }

  async capabilityAccept(invocationId: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.accept", { invocationId });
  }

  async capabilityStart(invocationId: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.start", { invocationId });
  }

  async capabilityResult(invocationId: string, result: unknown): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.result", { invocationId, result });
  }

  async capabilityChunk(invocationId: string, chunkIndex: number, data: unknown, final = false): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.chunk", { invocationId, chunkIndex, data, final });
  }

  async capabilityFail(invocationId: string, error: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.fail", { invocationId, error });
  }

  async capabilityCancel(invocationId: string, reason?: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.cancel", { invocationId, reason });
  }

  async capabilityGet(invocationId: string): Promise<CapabilityInvocation | undefined> {
    return await this.request("capability.get", { invocationId });
  }

  onCapabilityOffer(listener: (offer: { invocation: CapabilityInvocation; registration: CapabilityRegistration }) => void): () => void {
    this.capabilityOfferListeners.add(listener);
    return () => this.capabilityOfferListeners.delete(listener);
  }

  steer(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): QueuedAgentMessage {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    void this.request("queue", {
      input,
      attachments,
      delivery: "steer",
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    }).catch((error) => this.reportError(error));
    return { runId: this.activeRunId() ?? "", messageId: ids.messageId, delivery: "steer" };
  }

  followUp(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): QueuedAgentMessage {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    void this.request("queue", {
      input,
      attachments,
      delivery: "followUp",
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    }).catch((error) => this.reportError(error));
    return { runId: this.activeRunId() ?? "", messageId: ids.messageId, delivery: "followUp" };
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    const submitted = await this.startInterruptedTurn();
    return submitted?.completion;
  }

  async startInterruptedTurn(requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined> {
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    let result: { runId: string; messageId: string } | undefined;
    try {
      result = await this.request<{ runId: string; messageId: string } | undefined>("start-interrupted", {
        runId: ids.runId,
        messageId: ids.messageId,
        turnId: ids.turnId,
        parentRunId: ids.parentRunId,
        continuationSource: ids.continuationSource,
        expectedRevision: this.currentRevision()
      });
    } catch (error) {
      if (!isTransientHostError(error)) {
        // 失败随 throw 返回，调用方拿不到 completion 句柄；不挂观察会让进程出现 unhandled rejection。
        void completion.catch(() => undefined);
        this.rejectCompletion(ids.runId, error);
      } else {
        this.scheduleReconnect();
      }
      throw error;
    }
    if (!result) {
      this.completions.delete(ids.runId);
      return undefined;
    }
    return { runId: result.runId, messageId: result.messageId, completion };
  }

  async waitForIdle(): Promise<void> {
    if (this.closed) return;
    if (!this.snapshot || this.snapshot.state.kind === "idle") return;
    await new Promise<void>((resolve) => {
      // subscribe 会同步回放 pendingUpdates，settle 可能在 unsubscribe 返回前就触发。
      const waiter: { settled: boolean; unsubscribe?: () => void } = { settled: false };
      const settle = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.idleWaiters.delete(settle);
        waiter.unsubscribe?.();
        resolve();
      };
      waiter.unsubscribe = this.subscribe((update) => {
        if (update.snapshot.state.kind === "idle") settle();
      });
      // close() 或永久断线后不会再有 idle 事件，挂起的等待由 close() 统一了结。
      if (!waiter.settled) this.idleWaiters.add(settle);
    });
  }

  cancelCurrentRun(): void {
    const runId = this.activeRunId();
    if (!runId) return;
    void this.request("cancel", { runId }).catch((error) => this.reportError(error));
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRunId();
    if (active !== runId) return false;
    void this.request("cancel", { runId }).catch((error) => this.reportError(error));
    return true;
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    void this.request("permission", { requestId, result, expectedRevision: this.currentRevision() }).catch((error) => this.reportError(error));
  }

  async claimSession(session: string): Promise<void> {
    await this.request("session.claim", { session });
  }

  async releaseSessionClaim(session?: string): Promise<void> {
    await this.request("session.release", { session });
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    return await this.request<ResumedAgentSession>("resume", { session, expectedRevision: this.currentRevision() });
  }

  async runExclusiveOperation<T>(_operation: RuntimeOperation, _execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    throw new Error("Remote runtime operations must use the Runtime Host command methods.");
  }

  startBackgroundOperation<T extends { completion: Promise<unknown> }>(
    _operation: RuntimeOperation,
    _start: (signal: AbortSignal) => T
  ): T {
    throw new Error("Remote background operations must use executeCommand().");
  }

  async compactConversation(hint?: string): Promise<string> {
    return await this.request<string>("compact", { hint, expectedRevision: this.currentRevision() });
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    if (!this.snapshot) throw this.lastError ?? new Error("Runtime Host snapshot is not ready.");
    return this.snapshot;
  }

  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.pendingUpdates.length) {
      const updates = this.pendingUpdates.splice(0);
      for (const update of updates) listener(update);
    }
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("Runtime Host client closed."));
    this.pending.clear();
    this.rejectCompletions(new Error("Runtime Host client closed."));
    for (const settle of [...this.idleWaiters]) settle();
    this.socket?.destroy();
    this.socket = undefined;
    return Promise.resolve();
  }

  async executeCommand(input: string, source: HostSurface): Promise<RuntimeCommandResult | undefined> {
    return await this.request<RuntimeCommandResult | undefined>("command", { input, source, expectedRevision: this.currentRevision() });
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.request<ContextStatus>("agent.context", {});
  }

  async usage(): Promise<{ summary: UsageSummary; report: string; modelRequests?: unknown }> {
    return await this.request<{ summary: UsageSummary; report: string; modelRequests?: unknown }>("agent.usage", {});
  }

  async listModels(): Promise<ModelChoice[]> {
    return await this.request<ModelChoice[]>("agent.models", {});
  }

  async refreshModel(): Promise<ModelRuntimeInfo> {
    return await this.requestWithRuntimeRevision<ModelRuntimeInfo>("agent.refresh-model", {});
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    return await this.requestWithRuntimeRevision<ModelRuntimeInfo>("agent.switch-model", { alias, thinking });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const nextMode = await this.requestWithRuntimeRevision<PermissionMode>("agent.permission-mode", { mode });
    if (this.snapshot) this.snapshot = { ...this.snapshot, permissionMode: nextMode };
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    return await this.requestWithRuntimeRevision<string>("agent.permission-command", { args });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.request<SessionSummary[]>("agent.sessions", {});
  }

  async getPersonalizationState(): Promise<AgentPersonalizationState> {
    return await this.request("personalization.get", {});
  }

  async updateChatPersonalization(
    patch: ChatPersonalizationOverridePatch,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    return await this.request("personalization.update-chat", { patch, expectedRevision });
  }

  async updateGlobalPersonalization(
    update: GlobalPersonalizationUpdate,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    return await this.request("personalization.update-global", { update, expectedRevision });
  }

  async listSkills(): Promise<Awaited<ReturnType<CommandRuntime["listSkills"]>>> {
    return await this.request("skills.list", {});
  }

  async expandSkillCommand(input: string): Promise<string> {
    return await this.request<string>("skills.expand", { input });
  }

  async mcpStatus(): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["listServers"]>>> {
    return await this.request("mcp.status", {});
  }

  async mcpDetails(server: string): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["describeServer"]>>> {
    return await this.request("mcp.details", { server });
  }

  async mcpReconnect(server: string): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["reconnectServer"]>>> {
    return await this.request("mcp.reconnect", { server });
  }

  async memory<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const v3 = action.endsWith("-v3");
    return await this.request<T>(
      "memory",
      v3 ? { action, ...payload } : { action, ...payload, expectedRevision: this.currentRevision() }
    );
  }

  async telos<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return await this.request<T>("telos", { action, ...payload });
  }


  /** 让 owner 按指定会话或新会话重建 AgentSession。 */
  async restartRuntime(sessionId?: string): Promise<InteractiveRuntimeSnapshot> {
    const result = await this.requestWithRuntimeRevision<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("runtime.restart", { sessionId });
    this.snapshot = result.snapshot;
    this.sequence = result.sequence;
    return result.snapshot;
  }

  /** 让 owner 切到一个全新的空会话（草稿），返回新会话信息（含新的 sessionId）。 */
  async startDraft(): Promise<AgentSessionInfo> {
    const info = await this.requestWithRuntimeRevision<AgentSessionInfo>("runtime.start-draft", {});
    await this.refreshRuntimeSnapshot();
    return info;
  }

  /** 在运行时空闲时接管另一个配置环境的 owner，保证持久化根仍只有一个 writer。 */
  async restartOwner(): Promise<void> {
    if (this.ownerRestartPromise) return await this.ownerRestartPromise;
    const replacement = this.replaceOwner();
    this.ownerRestartPromise = replacement;
    try {
      await replacement;
    } finally {
      if (this.ownerRestartPromise === replacement) this.ownerRestartPromise = undefined;
    }
  }

  private async open(): Promise<void> {
    await this.openSocket();
    const result = await this.request<{ hostEpoch: string; persistenceRoot: string; snapshot: InteractiveRuntimeSnapshot; sequence: number; capabilities: string[] }>("subscribe", { afterSequence: undefined });
    this.capabilities = result.capabilities;
    this.applySnapshot(result.snapshot, result.sequence, result.hostEpoch);
    if (!this.snapshot) {
      const snapshot = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("snapshot", {});
      this.applySnapshot(snapshot.snapshot, snapshot.sequence);
    }
  }

  private openSocket(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    // 旧 socket 可能只收到半个 JSON 帧；新握手必须从干净的 JSONL 边界开始。
    this.buffer = "";
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.options.registration.endpoint);
      this.socket = socket;
      socket.setEncoding("utf8");
      const helloRequestId = randomUUID();
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          this.pending.delete(helloRequestId);
          this.readyPromise = undefined;
          reject(error);
        }
      };
      socket.on("connect", () => {
        const registrationIdentity = this.options.registration.configRoot !== undefined
          && this.options.registration.agentRoot !== undefined
          ? { configRoot: this.options.registration.configRoot, agentRoot: this.options.registration.agentRoot }
          : undefined;
        const identity = this.environmentTakeoverHandshake && registrationIdentity !== undefined
          ? registrationIdentity
          : currentRuntimeHostIdentity(this.options.spawnOptions);
        this.send(socket, {
          kind: "hello",
          requestId: helloRequestId,
          protocolVersion,
          rootHash: this.options.registration.rootHash,
          token: this.options.registration.token,
          configRoot: identity.configRoot,
          agentRoot: identity.agentRoot,
          clientId: this.clientId,
          surface: this.options.surface ?? "cli",
          capabilities: ["runtime.events.cursor", "runtime.run.reconnect"]
        });
      });
      socket.on("data", (chunk: string) => this.readClientData(socket, chunk));
      socket.once("error", (error: Error) => {
        this.lastError = error;
        fail(error);
      });
      socket.once("close", () => {
        if (this.socket !== socket) return;
        if (!settled) fail(new Error("Runtime Host connection closed during handshake."));
        const error = new Error("Runtime Host connection closed.");
        this.rejectPendingRequests(error);
        this.buffer = "";
        this.socket = undefined;
        this.readyPromise = undefined;
        if (!this.closed && !this.reconnectInProgress) this.scheduleReconnect();
      });
      this.pending.set(helloRequestId, {
        resolve: (value) => {
          settled = true;
          this.environmentTakeoverHandshake = false;
          const result = value as { hostEpoch: string; persistenceRoot: string; sequence: number; capabilities: string[] };
          this.hostEpoch = result.hostEpoch;
          this.sequence = result.sequence;
          this.capabilities = result.capabilities;
          resolve();
        },
        reject: fail
      });
    });
    return this.readyPromise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect().catch(() => this.scheduleReconnect());
    }, reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    let registration = await readRegistration(runtimeHostPaths(this.persistenceRoot));
    if (registration && !isProcessAlive(registration.pid)) {
      await removeStaleRegistration(registration);
      registration = undefined;
    }
    if (registration && !registrationMatchesCurrentEnvironment(registration, this.options.spawnOptions)) {
      throw new Error("Runtime Host belongs to a different Biny configuration environment.");
    }
    if (!registration && this.options.spawnOptions) {
      const child = spawnRuntimeHostProcess(this.persistenceRoot, this.options.spawnOptions);
      registration = await waitForHostRegistration(this.persistenceRoot, child);
    }
    if (!registration) throw new Error("Runtime Host registration is not available.");
    const previousHostEpoch = this.hostEpoch;
    this.options.registration = registration;
    await this.openSocket();
    const result = await this.request<{ hostEpoch: string; snapshot: InteractiveRuntimeSnapshot; sequence: number; replayed: boolean; capabilities: string[] }>("subscribe", {
      afterSequence: this.sequence,
      afterHostEpoch: previousHostEpoch
    });
    this.capabilities = result.capabilities;
    this.applySnapshot(result.snapshot, result.sequence, result.hostEpoch);
    await this.recoverCompletions();
  }

  private async recoverCompletions(): Promise<void> {
    for (const [runId, pending] of [...this.completions.entries()]) {
      try {
        const inspected = await this.inspectRun(runId);
        if (inspected === undefined) {
          this.completions.delete(runId);
          pending.reject(new Error(`Runtime run ${runId} was not admitted before the Host connection was lost.`));
          continue;
        }
        const record = asRecord(inspected);
        const terminalStatus = record.terminalStatus;
        if (typeof terminalStatus !== "string") {
          if (this.activeRunId() !== runId) {
            this.completions.delete(runId);
            pending.reject(new Error(`Runtime run ${runId} was admitted, but no active Host execution could be recovered.`));
          }
          continue;
        }
        const terminalPayload = asRecord(record.terminalPayload);
        const projection = asRecord(terminalPayload.projection);
        const outcome: AgentRunOutcome = {
          runId,
          status: terminalStatus as AgentRunOutcome["status"],
          stopReason: readRecoveryStopReason(terminalPayload.stopReason),
          finishReason: typeof terminalPayload.finishReason === "string" ? terminalPayload.finishReason : undefined,
          steps: typeof terminalPayload.steps === "number" ? terminalPayload.steps : 0,
          output: typeof terminalPayload.output === "string" ? terminalPayload.output : "",
          durationMs: typeof projection.durationMs === "number" ? projection.durationMs : 0,
          error: typeof terminalPayload.error === "string" ? terminalPayload.error : undefined
        };
        if (!isAgentRunOutcome(outcome)) continue;
        this.completions.delete(runId);
        pending.resolve(outcome);
      } catch (error) {
        if (!isTransientHostError(error)) this.reportError(error);
      }
    }
  }

  private async replaceOwner(): Promise<void> {
    if (this.closed) throw new Error("Runtime Host client is closed.");
    if (this.options.spawnOptions === undefined) throw new Error("Runtime Host cannot be replaced from this client.");
    const current = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("snapshot", {});
    this.snapshot = current.snapshot;
    this.sequence = current.sequence;
    if (current.snapshot.state.kind !== "idle") throw new Error("Cannot replace the Runtime Host while it is busy.");

    const paths = runtimeHostPaths(this.persistenceRoot);
    const registration = await readRegistration(paths);
    if (!registration) {
      await this.reconnect();
      return;
    }
    if (this.hostEpoch !== undefined && registration.hostEpoch !== this.hostEpoch) {
      await this.reconnect();
      return;
    }
    if (registration.pid === process.pid) throw new Error("Cannot replace a Runtime Host owned by the current process.");

    this.reconnectInProgress = true;
    try {
      try {
        process.kill(registration.pid, "SIGTERM");
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
      await waitForHostExit(paths, registration);
      await this.disconnectSocket();
      await this.reconnect();
    } finally {
      this.reconnectInProgress = false;
    }
  }

  private async disconnectSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.off("close", onClose);
        resolve();
      }, 1_000);
      const onClose = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.once("close", onClose);
      socket.destroy();
    });
  }

  private readClientData(socket: net.Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > maxFrameBytes) {
      this.socket?.destroy(new Error("Runtime Host frame is too large."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleClientFrame(JSON.parse(line) as unknown);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private handleClientFrame(frame: unknown): void {
    if (isResponseFrame(frame)) {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(errorFromHostFrame(frame));
      return;
    }
    if (isEventFrame(frame)) {
      this.hostEpoch = frame.hostEpoch;
      this.sequence = frame.sequence;
      this.snapshot = frame.update.snapshot;
      if (this.listeners.size) {
        for (const listener of this.listeners) listener(frame.update);
      } else {
        this.pendingUpdates.push(frame.update);
        if (this.pendingUpdates.length > eventHistoryLimit) this.pendingUpdates.splice(0, this.pendingUpdates.length - eventHistoryLimit);
      }
      return;
    }
    if (isCompletionFrame(frame)) {
      const pending = this.completions.get(frame.runId);
      if (!pending) return;
      this.completions.delete(frame.runId);
      pending.resolve(frame.outcome);
      return;
    }
    if (isCapabilityOfferFrame(frame)) {
      for (const listener of this.capabilityOfferListeners) listener({ invocation: frame.invocation, registration: frame.registration });
      return;
    }
    if (isGapFrame(frame)) {
      this.hostEpoch = frame.hostEpoch;
      this.sequence = frame.sequence;
      this.snapshot = frame.snapshot;
      const update: AgentRuntimeUpdate = { snapshot: frame.snapshot };
      for (const listener of this.listeners) listener(update);
    }
  }

  private request<T>(operation: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Runtime Host client is closed."));
    return this.openSocket().then(() => new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        this.pending.delete(requestId);
        reject(new Error("Runtime Host is disconnected."));
        return;
      }
      this.send(socket, { kind: "request", requestId, operation, payload });
    }));
  }

  /** Runtime 重建会重置快照 revision；这些幂等控制写入可在刷新快照后安全重试一次。 */
  private async requestWithRuntimeRevision<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request<T>(operation, { ...payload, expectedRevision: this.currentRevision() });
      } catch (error) {
        if (attempt > 0 || !isRuntimeRevisionConflict(error)) throw error;
        await this.refreshRuntimeSnapshot();
      }
    }
    throw new Error("Runtime Host revision retry was exhausted.");
  }

  private async refreshRuntimeSnapshot(): Promise<void> {
    const current = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("snapshot", {});
    this.applySnapshot(current.snapshot, current.sequence);
  }

  /**
   * subscribe/snapshot 响应在 Host execute 时取样，但客户端在 await 后的微任务里落地；
   * 窗口内到达的事件帧已把 sequence 推得更新。同 epoch 下禁止回退，epoch 切换则整体替换。
   */
  private applySnapshot(snapshot: InteractiveRuntimeSnapshot, sequence: number, hostEpoch?: string): void {
    if (hostEpoch !== undefined && hostEpoch !== this.hostEpoch) {
      this.hostEpoch = hostEpoch;
      this.snapshot = snapshot;
      this.sequence = sequence;
      return;
    }
    if (sequence < this.sequence) return;
    this.snapshot = snapshot;
    this.sequence = sequence;
  }

  private createCompletion(runId: string): Promise<AgentRunOutcome> {
    return new Promise<AgentRunOutcome>((resolve, reject) => this.completions.set(runId, { resolve, reject }));
  }

  private rejectCompletion(runId: string, error: unknown): void {
    const pending = this.completions.get(runId);
    if (!pending) return;
    this.completions.delete(runId);
    pending.reject(asError(error));
  }

  private activeRunId(): string | undefined {
    const state = this.snapshot?.state;
    return state?.kind === "runs" ? state.activeRun.runId : undefined;
  }

  private assertQueueable(input: string, attachments: AgentAttachment[]): void {
    if (!this.activeRunId()) throw new Error("There is no active run to receive a queued message.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
  }

  private reportError(error: unknown): void {
    this.lastError = asError(error);
  }

  private currentRevision(): number | undefined {
    return this.snapshot?.revision;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rejectCompletions(error: Error): void {
    for (const completion of this.completions.values()) completion.reject(error);
    this.completions.clear();
  }

  private send(socket: net.Socket, frame: HostFrame): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }
}

function runtimeHostEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  return path.join(path.dirname(current), `hostProcess${current.endsWith(".ts") ? ".ts" : ".js"}`);
}

async function waitForSpawnedRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions,
  child: ChildProcess
): Promise<RuntimeHostClient> {
  await waitForHostRegistration(persistenceRoot, child);
  const client = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions: toSpawnOptions(options)
  });
  if (!client) throw new Error("Runtime Host registration disappeared before attach.");
  return client;
}

function toSpawnOptions(options: SpawnRuntimeHostOptions): RuntimeHostSpawnOptions {
  return {
    workspaceRoot: options.workspaceRoot,
    configDir: options.configDir,
    attachmentRoot: options.attachmentRoot,
    sessionId: options.sessionId,
    resumeInterrupted: options.resumeInterrupted,
    entryPath: options.entryPath
  };
}

async function waitForHostRegistration(
  persistenceRoot: string,
  child: ChildProcess
): Promise<HostRegistration> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < hostStartupTimeoutMs) {
    if (child.exitCode !== null) throw new Error(`Runtime Host process exited before attach (code ${String(child.exitCode)}).`);
    const registration = await readRegistration(runtimeHostPaths(persistenceRoot));
    if (registration) {
      if (isProcessAlive(registration.pid)) return registration;
      await removeStaleRegistration(registration);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode !== null) throw new Error(`Runtime Host process exited before attach (code ${String(child.exitCode)}).`);
  throw new Error(`Runtime Host did not become ready within ${String(hostStartupTimeoutMs)}ms.`);
}

async function waitForHostExit(paths: RuntimeHostPaths, registration: HostRegistration): Promise<void> {
  const deadline = Date.now() + hostStartupTimeoutMs;
  while (Date.now() < deadline) {
    const current = await readRegistration(paths);
    if (!isProcessAlive(registration.pid)) return;
    if (current && current.hostEpoch !== registration.hostEpoch && current.pid !== registration.pid) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runtime Host process ${String(registration.pid)} did not stop within ${String(hostStartupTimeoutMs)}ms.`);
}

function isHelloFrame(value: unknown): value is HostHelloFrame {
  const record = asRecord(value);
  return record.kind === "hello"
    && typeof record.requestId === "string"
    && record.protocolVersion === protocolVersion
    && typeof record.rootHash === "string"
    && typeof record.token === "string"
    && typeof record.configRoot === "string"
    && typeof record.agentRoot === "string"
    && typeof record.clientId === "string"
    && Array.isArray(record.capabilities)
    && record.capabilities.every((capability) => typeof capability === "string")
    && isSurface(record.surface);
}

function currentRuntimeHostIdentity(options?: RuntimeHostSpawnOptions): { configRoot: string; agentRoot: string } {
  return {
    configRoot: path.resolve(options?.configDir ?? globalConfigDir()),
    agentRoot: path.resolve(globalAgentDir())
  };
}

function registrationMatchesCurrentEnvironment(
  registration: HostRegistration,
  options?: RuntimeHostSpawnOptions
): boolean {
  const identity = currentRuntimeHostIdentity(options);
  return registration.configRoot === identity.configRoot && registration.agentRoot === identity.agentRoot;
}

function operationLane(operation: string): OperationLane {
  // Runtime 重建会替换快照并重置 revision。权限模式写入必须与重建共用 mutation
  // 队列，避免在 owner 切换 runtime 的中间状态读取旧 revision。
  if (operation === "agent.permission-mode" || operation === "agent.permission-command" || operation === "runtime.restart") return "mutation";
  // Admission 与取消/审批共享一条因果队列。这样客户端先发 submit、随后立即发
  // cancel 时，取消不会在 activeRun 建立前先执行成一个无效 no-op。
  if (
    operation === "cancel"
    || operation === "permission"
    || operation === "run.cancel"
    || operation === "run.permission"
    || operation === "submit"
    || operation === "start-interrupted"
    || operation === "run.submit"
    || operation === "run.continue"
    || operation === "queue"
    || operation === "run.queue"
  ) return "run";
  if (
    operation === "snapshot"
    || operation === "subscribe"
    || operation === "wait-idle"
    || operation === "agent.context"
    || operation === "agent.usage"
    || operation === "agent.models"
    || operation === "agent.sessions"
    || operation === "personalization.get"
    || operation === "memory.embedding.status-v3"
    || operation === "skills.list"
    || operation === "mcp.status"
    || operation === "mcp.details"
    || operation === "run.inspect"
    || operation === "run.list"
    || operation === "runtime.events"
    || operation === "task.get"
    || operation === "task.list"
    || operation === "task.events"
    || operation === "automation.list"
    || operation === "automation.pending"
    || operation === "goal.get"
    || operation === "goal.list"
    || operation === "graph.inspect"
    || operation === "graph.events"
    || operation === "graph.list"
    || operation === "capability.list"
    || operation === "capability.get"
    || operation === "host.info"
  ) return "query";
  if (operation === "memory.embedding.cancel-download-v3" || operation === "memory.embedding.cancel-rebuild-v3") return "control";
  if (operation === "capability.cancel" || operation === "capability.fail" || operation === "capability.release" || operation === "capability.reject") return "control";
  if (operation === "goal.pause" || operation === "goal.cancel" || operation === "graph.pause" || operation === "graph.cancel") return "control";
  if (operation === "capability.register" || operation === "capability.replace" || operation === "capability.invoke" || operation === "capability.accept" || operation === "capability.start" || operation === "capability.result" || operation === "capability.chunk" || operation === "capability.admit" || operation === "graph.start" || operation === "graph.resume" || operation === "goal.resume") return "admission";
  return "mutation";
}

function isRequestFrame(value: unknown): value is HostRequestFrame {
  const record = asRecord(value);
  return record.kind === "request" && typeof record.requestId === "string" && typeof record.operation === "string";
}

function isResponseFrame(value: unknown): value is HostResponseFrame {
  const record = asRecord(value);
  return record.kind === "response" && typeof record.requestId === "string" && typeof record.ok === "boolean";
}

function isEventFrame(value: unknown): value is HostEventFrame {
  const record = asRecord(value);
  return record.kind === "event" && typeof record.hostEpoch === "string" && typeof record.sequence === "number" && isRuntimeUpdate(record.update);
}

function isCompletionFrame(value: unknown): value is HostCompletionFrame {
  const record = asRecord(value);
  return record.kind === "completion" && typeof record.runId === "string" && isAgentRunOutcome(record.outcome);
}

function isGapFrame(value: unknown): value is HostGapFrame {
  const record = asRecord(value);
  return record.kind === "gap" && typeof record.hostEpoch === "string" && typeof record.sequence === "number" && isSnapshot(record.snapshot);
}

function isCapabilityOfferFrame(value: unknown): value is HostCapabilityOfferFrame {
  const record = asRecord(value);
  const invocation = asRecord(record.invocation);
  const registration = asRecord(record.registration);
  return record.kind === "capability-offer"
    && typeof invocation.invocationId === "string"
    && typeof registration.registrationId === "string";
}

function isRuntimeUpdate(value: unknown): value is AgentRuntimeUpdate {
  const record = asRecord(value);
  return isSnapshot(record.snapshot);
}

function isSnapshot(value: unknown): value is InteractiveRuntimeSnapshot {
  const record = asRecord(value);
  return typeof record.revision === "number" && typeof record.info === "object" && record.info !== null && typeof record.permissionMode === "string" && typeof record.state === "object" && record.state !== null;
}

function isAgentRunOutcome(value: unknown): value is AgentRunOutcome {
  const record = asRecord(value);
  return typeof record.runId === "string" && typeof record.status === "string" && typeof record.stopReason === "string" && typeof record.steps === "number" && typeof record.durationMs === "number" && typeof record.output === "string";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime Host field ${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Runtime Host field ${name} must be a safe integer.`);
  return value as number;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Runtime Host field ${name} must be a string array.`);
  return value;
}

function readMemoryOriginSelector(value: unknown, allowAll: boolean): MemoryOriginSelector {
  if (value === "current_workspace" || value === "user" || value === "other_workspaces" || (allowAll && value === "all")) return value;
  throw new Error(`Runtime Host memory selector must be ${allowAll ? "all, " : ""}current_workspace, user, or other_workspaces.`);
}

function readTelosDocumentInput(value: unknown): TelosDocumentInput {
  const record = asRecord(value);
  return {
    scope: readTelosScope(record.scope),
    mission: requiredString(record.mission, "input.mission"),
    goals: record.goals === undefined ? undefined : readTelosGoals(record.goals),
    principles: record.principles === undefined ? undefined : readTelosRules(record.principles, "input.principles"),
    constraints: record.constraints === undefined ? undefined : readTelosRules(record.constraints, "input.constraints"),
    antiGoals: record.antiGoals === undefined ? undefined : readTelosRules(record.antiGoals, "input.antiGoals")
  };
}

function readTelosScope(value: unknown): TelosScope {
  if (value === "universal" || value === "workspace") return value;
  throw new Error("Runtime Host TELOS scope is invalid.");
}

function readTelosGoals(value: unknown): TelosDocumentInput["goals"] {
  if (!Array.isArray(value)) throw new Error("Runtime Host TELOS goals must be an array.");
  return value.map((item, index) => {
    const record = asRecord(item);
    const status = record.status;
    if (status !== "active" && status !== "paused" && status !== "completed") {
      throw new Error(`Runtime Host TELOS goal ${String(index)} status is invalid.`);
    }
    return {
      id: requiredString(record.id, `input.goals[${String(index)}].id`),
      text: requiredString(record.text, `input.goals[${String(index)}].text`),
      status,
      horizon: optionalString(record.horizon)
    };
  });
}

function readTelosRules(value: unknown, name: string): TelosDocumentInput["principles"] {
  if (!Array.isArray(value)) throw new Error(`Runtime Host ${name} must be an array.`);
  return value.map((item, index) => {
    const record = asRecord(item);
    return {
      id: requiredString(record.id, `${name}[${String(index)}].id`),
      text: requiredString(record.text, `${name}[${String(index)}].text`)
    };
  });
}

function readTelosPatternAction(value: unknown): BehaviorPatternReviewAction {
  if (value === "confirm" || value === "reject" || value === "expire") return value;
  throw new Error("Runtime Host TELOS pattern action is invalid.");
}

function readTelosDriftAction(value: unknown): TelosDriftResolutionAction {
  if (value === "adjust_telos" || value === "adjust_behavior" || value === "dismiss" || value === "resolve") return value;
  throw new Error("Runtime Host TELOS drift action is invalid.");
}

function readMemoryEntryInput(value: unknown): MemoryEntryInput {
  const record = asRecord(value);
  const importance = record.importance === undefined ? undefined : requiredInteger(record.importance, "entry.importance");
  if (importance !== undefined && (importance < 1 || importance > 5)) {
    throw new Error("Runtime Host memory entry importance must be between 1 and 5.");
  }
  const lineageValues = Array.isArray(record.lineage) ? record.lineage : [record.lineage];
  if (lineageValues.some((item) => item === undefined)) throw new Error("Runtime Host memory entry lineage is required.");
  return {
    audience: readMemoryAudience(record.audience),
    kind: readMemoryKind(record.kind),
    topic: requiredString(record.topic, "entry.topic"),
    title: requiredString(record.title, "entry.title"),
    summary: requiredString(record.summary, "entry.summary"),
    decisions: record.decisions === undefined ? undefined : readStringArray(record.decisions, "entry.decisions"),
    paths: record.paths === undefined ? undefined : readStringArray(record.paths, "entry.paths"),
    keywords: record.keywords === undefined ? undefined : readStringArray(record.keywords, "entry.keywords"),
    importance,
    lineage: lineageValues.map(readMemoryLineage)
  };
}

function readMemoryAudience(value: unknown): "workspace" | "universal" {
  if (value === "workspace" || value === "universal") return value;
  throw new Error("Runtime Host memory audience must be workspace or universal.");
}

function readMemoryEntryPatch(value: unknown): MemoryEntryPatch {
  const record = asRecord(value);
  const importance = record.importance === undefined ? undefined : requiredInteger(record.importance, "patch.importance");
  if (importance !== undefined && (importance < 1 || importance > 5)) {
    throw new Error("Runtime Host memory patch importance must be between 1 and 5.");
  }
  return {
    kind: record.kind === undefined ? undefined : readMemoryKind(record.kind),
    topic: optionalString(record.topic),
    title: optionalString(record.title),
    summary: optionalString(record.summary),
    decisions: record.decisions === undefined ? undefined : readStringArray(record.decisions, "patch.decisions"),
    paths: record.paths === undefined ? undefined : readStringArray(record.paths, "patch.paths"),
    keywords: record.keywords === undefined ? undefined : readStringArray(record.keywords, "patch.keywords"),
    importance,
    userEvidence: optionalString(record.userEvidence)
  };
}

function readMemoryKind(value: unknown): MemoryKind {
  if (value === "preference" || value === "working_style" || value === "fact" || value === "decision" || value === "workflow" || value === "gotcha") {
    return value;
  }
  throw new Error("Runtime Host memory entry kind is invalid.");
}


function readMemoryLineage(value: unknown): MemoryLineage {
  const record = asRecord(value);
  if (typeof record.externalContext !== "boolean") throw new Error("Runtime Host memory lineage externalContext must be boolean.");
  return {
    source: readMemoryLineageSource(record.source),
    externalContext: record.externalContext,
    sessionId: optionalString(record.sessionId),
    turnId: optionalString(record.turnId),
    runId: optionalString(record.runId),
    candidateId: optionalString(record.candidateId),
    sourceEntryIds: record.sourceEntryIds === undefined ? undefined : readStringArray(record.sourceEntryIds, "entry.lineage.sourceEntryIds"),
    legacyPath: optionalString(record.legacyPath),
    userEvidence: optionalString(record.userEvidence)
  };
}

function readMemoryLineageSource(value: unknown): MemoryLineageSource {
  if (value === "explicit" || value === "completed_task" || value === "candidate" || value === "migration" || value === "consolidation") {
    return value;
  }
  throw new Error("Runtime Host memory lineage source is invalid.");
}

function readAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Runtime Host attachments must be an array.");
  return value.map((item) => {
    const record = asRecord(item);
    if (typeof record.name !== "string" || typeof record.mimeType !== "string" || typeof record.data !== "string") {
      throw new Error("Runtime Host attachment is invalid.");
    }
    return {
      name: record.name,
      mimeType: record.mimeType,
      data: record.data,
      path: optionalString(record.path),
      size: Number.isSafeInteger(record.size) ? record.size as number : undefined
    };
  });
}

function readRequestIds(payload: Record<string, unknown>): RuntimeRequestIds {
  const runId = optionalString(payload.runId);
  const messageId = optionalString(payload.messageId);
  const turnId = optionalString(payload.turnId);
  const parentRunId = optionalString(payload.parentRunId);
  const continuationSource = optionalString(payload.continuationSource);
  return { runId, messageId, turnId, parentRunId, continuationSource };
}

function readOptionalRunStatus(value: unknown): RuntimeRunStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "admitted" || value === "running" || value === "completed" || value === "blocked" || value === "incomplete" || value === "cancelled" || value === "aborted" || value === "failed" || value === "unknown") return value;
  throw new Error("Runtime Host run status is invalid.");
}

function readOptionalTaskStatus(value: unknown): TaskRunStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "queued" || value === "created" || value === "running" || value === "verifying" || value === "completed" || value === "failed" || value === "incomplete" || value === "blocked" || value === "policy_denied" || value === "budget_exhausted" || value === "needs_approval" || value === "aborted" || value === "cancelled") return value;
  throw new Error("Runtime Host TaskRun status is invalid.");
}

function readCapabilityOwnerType(value: unknown): "host" | "client" {
  if (value === "host" || value === "client") return value;
  throw new Error("Capability owner type must be host or client.");
}

function readAutomationCreateInput(payload: Record<string, unknown>): AutomationCreateInput {
  const schedule = asRecord(payload.schedule);
  const template = asRecord(payload.executionTemplate);
  const triggerType = payload.triggerType;
  if (triggerType !== "heartbeat" && triggerType !== "cron" && triggerType !== "interval" && triggerType !== "once") {
    throw new Error("Automation trigger type is invalid.");
  }
  const mode = template.mode;
  if (mode !== undefined && mode !== "chat" && mode !== "plan") throw new Error("Automation mode is invalid.");
  assertAllowedKeys(template, ["prompt", "sessionId", "mode"], "Automation execution template");
  const intervalMs = schedule.intervalMs;
  if (intervalMs !== undefined && !Number.isSafeInteger(intervalMs)) throw new Error("Automation intervalMs is invalid.");
  const jitterMs = schedule.jitterMs;
  if (jitterMs !== undefined && !Number.isSafeInteger(jitterMs)) throw new Error("Automation jitterMs is invalid.");
  const maxFires = payload.maxFires;
  if (maxFires !== undefined && !Number.isSafeInteger(maxFires)) throw new Error("Automation maxFires is invalid.");
  return {
    automationId: optionalString(payload.automationId),
    name: requiredString(payload.name, "name"),
    triggerType,
    schedule: {
      cron: optionalString(schedule.cron),
      intervalMs: intervalMs as number | undefined,
      at: optionalString(schedule.at),
      jitterMs: jitterMs as number | undefined
    },
    executionTemplate: {
      prompt: requiredString(template.prompt, "executionTemplate.prompt"),
      sessionId: optionalString(template.sessionId),
      mode
    },
    maxFires: maxFires as number | undefined,
    expiresAt: optionalString(payload.expiresAt)
  };
}

function readGraphNodes(value: unknown): GraphNodeInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Graph nodes must be a non-empty array.");
  return value.map((item, index) => {
    const node = asRecord(item);
    const dependencies = node.dependencies;
    if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string"))) {
      throw new Error(`Graph node ${String(index)} dependencies are invalid.`);
    }
    return {
      nodeKey: requiredString(node.nodeKey, `nodes[${String(index)}].nodeKey`),
      prompt: requiredString(node.prompt, `nodes[${String(index)}].prompt`),
      dependencies: dependencies as string[] | undefined,
      intent: node.intent
    };
  });
}

interface NormalizedRequestIds {
  runId: string;
  messageId: string;
  turnId: string;
  parentRunId?: string;
  continuationSource?: string;
}

function normalizeRequestIds(ids: RuntimeRequestIds | undefined): NormalizedRequestIds {
  return {
    runId: ids?.runId ?? randomUUID(),
    messageId: ids?.messageId ?? randomUUID(),
    turnId: ids?.turnId ?? randomUUID(),
    parentRunId: ids?.parentRunId,
    continuationSource: ids?.continuationSource
  };
}

function readRunMode(value: unknown): AgentRunMode {
  if (value === "chat" || value === "plan") return value;
  throw new Error("Runtime Host run mode must be chat or plan.");
}

function readPermissionMode(value: unknown): PermissionMode {
  if (value === "ask" || value === "read-only" || value === "auto" || value === "full-access") return value;
  throw new Error("Runtime Host permission mode is invalid.");
}

function readPermissionResult(value: unknown): PermissionResult {
  const record = asRecord(value);
  if (typeof record.approved !== "boolean") throw new Error("Runtime Host permission result is invalid.");
  return {
    approved: record.approved,
    scope: record.scope as PermissionResult["scope"],
    nextMode: record.nextMode as PermissionResult["nextMode"],
    message: optionalString(record.message),
    confirmation: optionalString(record.confirmation)
  };
}

function readThinking(value: unknown): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const parsed = thinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error("Runtime Host thinking selection is invalid.");
  return parsed.data;
}

function readSurface(value: unknown): HostSurface {
  if (isSurface(value)) return value;
  throw new Error("Runtime Host surface is invalid.");
}

function isSurface(value: unknown): value is HostSurface {
  return value === "desktop" || value === "tui" || value === "cli";
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicErrorCode(error: unknown): string | undefined {
  return error instanceof SessionWriterConflictError ? error.code : undefined;
}

function publicErrorData(error: unknown): unknown {
  if (!(error instanceof SessionWriterConflictError)) return undefined;
  return {
    sessionId: error.sessionId,
    ownerPid: error.ownerPid,
    ownerSurface: error.ownerSurface
  };
}

function errorFromHostFrame(frame: HostResponseFrame): Error {
  if (frame.errorCode === "session_writer_conflict") {
    const data = asRecord(frame.errorData);
    return new SessionWriterConflictError(
      typeof data.sessionId === "string" ? data.sessionId : "unknown",
      typeof data.ownerPid === "number" ? data.ownerPid : undefined,
      typeof data.ownerSurface === "string" ? data.ownerSurface : undefined,
      frame.error ?? "Session is already open in another application."
    );
  }
  return new Error(frame.error ?? "Runtime Host request failed.");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isTransientHostError(error: unknown): boolean {
  const message = asError(error).message;
  return message.includes("connection closed")
    || message.includes("disconnected")
    || message.includes("registration is not available")
    || message.includes("did not become ready");
}

function isRuntimeRevisionConflict(error: unknown): boolean {
  return asError(error).message.startsWith("Runtime Host revision conflict:");
}

function readRecoveryStopReason(value: unknown): AgentRunOutcome["stopReason"] {
  if (
    value === "model_stop"
    || value === "step_limit"
    || value === "hard_step_limit"
    || value === "tool_call_limit"
    || value === "repeated_action_limit"
    || value === "timeout"
    || value === "model_length"
    || value === "content_filter"
    || value === "provider_error"
    || value === "blocked"
    || value === "cancelled"
    || value === "aborted"
    || value === "budget_exhausted"
  ) return value;
  return "provider_error";
}

async function readRegistration(paths: RuntimeHostPaths): Promise<HostRegistration | undefined> {
  try {
    const raw = await readPrivateHostFile(paths.registrationPath);
    if (raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    const registration = asRecord(parsed);
    if (
      !Number.isSafeInteger(registration.protocolVersion)
      || registration.endpoint !== paths.endpoint
      || registration.rootHash !== paths.rootHash
      || typeof registration.token !== "string"
      || typeof registration.hostEpoch !== "string"
      || typeof registration.persistenceRoot !== "string"
      || !Number.isSafeInteger(registration.pid)
    ) return undefined;
    return {
      protocolVersion: registration.protocolVersion as number,
      endpoint: paths.endpoint,
      registrationPath: paths.registrationPath,
      lockPath: paths.lockPath,
      rootHash: paths.rootHash,
      persistenceRoot: registration.persistenceRoot,
      configRoot: typeof registration.configRoot === "string" ? path.resolve(registration.configRoot) : undefined,
      agentRoot: typeof registration.agentRoot === "string" ? path.resolve(registration.agentRoot) : undefined,
      hostEpoch: registration.hostEpoch,
      token: registration.token,
      pid: registration.pid as number,
      createdAt: typeof registration.createdAt === "string" ? registration.createdAt : ""
    };
  } catch {
    return undefined;
  }
}

async function writeRegistration(registration: HostRegistration): Promise<void> {
  const temporary = `${registration.registrationPath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, hostWriteNewFlags(), 0o600);
    await handle.writeFile(`${JSON.stringify(registration)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await fs.rename(temporary, registration.registrationPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireHostLock(paths: RuntimeHostPaths, persistenceRoot: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(paths.lockPath, hostWriteNewFlags(), 0o600);
      await handle.chmod(0o600);
      // registration 要等 server initialize/listen 之后才落盘；先把 pid 写进 lock，
      // 让竞争进程在这个窗口内也能判活，而不是把存活 owner 的 lock/socket 当 stale 清掉。
      await handle.writeFile(`${String(process.pid)}\n`, "utf8");
      await handle.sync();
      return handle;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const registration = await readRegistration(paths);
      const ownerPid = registration?.pid ?? await readLockPid(paths.lockPath);
      if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
        throw new Error(`Runtime Host is already running for ${path.resolve(persistenceRoot)}.`);
      }
      await removeStaleRegistration(registration ?? {
        protocolVersion,
        endpoint: paths.endpoint,
        registrationPath: paths.registrationPath,
        lockPath: paths.lockPath,
        rootHash: paths.rootHash,
        persistenceRoot: path.resolve(persistenceRoot),
        configRoot: undefined,
        agentRoot: undefined,
        hostEpoch: "",
        token: "",
        pid: 0,
        createdAt: ""
      });
    }
  }
  throw new Error("Unable to acquire Runtime Host lock.");
}

/** lock 文件内容是 owner pid；读不出有效 pid 时按无法证明存活处理。 */
async function readLockPid(lockPath: string): Promise<number | undefined> {
  const raw = await readPrivateHostFile(lockPath);
  if (raw === undefined) return undefined;
  const pid = Number(raw.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function removeStaleRegistration(registration: HostRegistration): Promise<void> {
  await fs.rm(registration.registrationPath, { force: true });
  await removeSocketIfStale(registration.endpoint);
  await fs.rm(registration.lockPath, { force: true });
}

async function removeRegistration(registration: HostRegistration): Promise<void> {
  const current = await readRegistration({
    endpoint: registration.endpoint,
    registrationPath: registration.registrationPath,
    lockPath: registration.lockPath,
    rootHash: registration.rootHash
  });
  // registration/lock/socket 都可能已被新 owner 接管；只删除仍能证明归属自己的文件，
  // 否则旧 owner 退出时会删掉新 owner 的 endpoint，造成双 owner 之外的另一种断连。
  const ownsRegistration = current?.hostEpoch === registration.hostEpoch;
  const lockPid = await readLockPid(registration.lockPath);
  const ownsLock = lockPid === undefined || lockPid === registration.pid;
  if (ownsRegistration) await fs.rm(registration.registrationPath, { force: true });
  if (ownsRegistration || (current === undefined && ownsLock)) await removeSocketIfStale(registration.endpoint);
  if (ownsLock) await fs.rm(registration.lockPath, { force: true });
}

async function removeSocketIfStale(endpoint: string): Promise<void> {
  try {
    const stat = await fs.lstat(endpoint);
    if (stat.isSymbolicLink()) {
      await fs.unlink(endpoint);
      return;
    }
    if (!stat.isSocket() || !isOwnedByCurrentUser(stat)) {
      throw new Error("Runtime Host endpoint must be an owned Unix socket.");
    }
    await fs.unlink(endpoint);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function ensureRuntimeHostDirectory(directory: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  const realParent = await fs.realpath(path.dirname(directory));
  const realDirectory = await fs.realpath(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realDirectory !== path.join(realParent, path.basename(directory))) {
    throw new Error("Runtime Host directory must be a real directory.");
  }
  if (!isOwnedByCurrentUser(stat)) throw new Error("Runtime Host directory is not owned by the current user.");
  await fs.chmod(directory, 0o700);
}

async function readPrivateHostFile(filePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | hostNoFollowFlag());
    const stat = await handle.stat();
    if (!isPrivateHostFile(stat)) return undefined;
    return await handle.readFile("utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureRuntimeSocket(endpoint: string): Promise<void> {
  const stat = await fs.lstat(endpoint);
  if (!stat.isSocket() || !isOwnedByCurrentUser(stat)) {
    throw new Error("Runtime Host endpoint must be an owned Unix socket.");
  }
  await fs.chmod(endpoint, 0o600);
}

function hostWriteNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | hostNoFollowFlag();
}

function hostNoFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isPrivateHostFile(stat: Stats): boolean {
  return stat.isFile()
    && stat.nlink === 1
    && (stat.mode & 0o077) === 0
    && isOwnedByCurrentUser(stat);
}

function isOwnedByCurrentUser(stat: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isConnectionRefused(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ESRCH";
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unsupported field: ${unexpected}.`);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
