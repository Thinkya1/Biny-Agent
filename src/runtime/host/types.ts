/**
 * Runtime Host 的跨模块类型边界。
 *
 * 这里只放生命周期、客户端和线协议都会依赖的值对象；业务命令类型继续归属各自模块。
 */
import type { ChildProcess } from "node:child_process";
import type { CommandSurface } from "../commandRegistry.js";
import type { InteractiveAgentHost } from "../InteractiveAgentRuntime.js";
import type { RuntimeHostClient } from "./client.js";

export type HostSurface = CommandSurface | "cli";

export interface HostOperationResult<T = unknown> {
  accepted: boolean;
  sessionId?: string;
  revision: number;
  result?: T;
  reason?: string;
  errorCode?: string;
}

export interface RuntimeHostSessionSummary {
  sessionId: string;
  snapshot: import("../agentEvents.js").InteractiveRuntimeSnapshot;
  primary: boolean;
  lastActiveAt: number;
}

export interface HostRegistration {
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

export interface RuntimeHostPaths {
  endpoint: string;
  registrationPath: string;
  lockPath: string;
  rootHash: string;
}

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

export type RuntimeIsolation = "shared" | "worktree";

/** Runtime Host 在创建 session runtime 时传给 composition root 的上下文。 */
export interface RuntimeHostFactoryOptions {
  /** 新 runtime 应使用的实际工作区；持久化根仍由 composition root 自己保持。 */
  readonly workspaceRoot?: string;
  /** 预先分配的 session id；fresh 为 true 时不能再调用 resume。 */
  readonly sessionId?: string;
  readonly fresh?: boolean;
  readonly isolation?: RuntimeIsolation;
}

export interface HostClientOptions {
  clientId?: string;
  surface?: HostSurface;
  /** owner 退出后，client 是否有足够 composition root 重新选举 Host。 */
  spawnOptions?: RuntimeHostSpawnOptions;
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
export type RuntimeHostFactory = (sessionId?: string, options?: RuntimeHostFactoryOptions) => Promise<InteractiveAgentHost>;

export interface RuntimeHostStartOptions {
  /** Host 的主 checkout；初始 runtime 可能已经位于某个 worktree，不能从它反推仓库根。 */
  workspaceRoot?: string;
  /** 远端请求新会话、配置重载或编辑分支时，按 sessionId 重建 owner。 */
  createRuntime?: RuntimeHostFactory;
  /** 显式要求 owner 进程启动后检查并续跑在途 turn。默认不续跑。 */
  resumeInterrupted?: boolean;
  /** Host 发现身份必须包含配置根，避免同一工作区的隔离实例复用错误 owner。 */
  configDir?: string;
  maxSessionRuntimes?: number;
  maxConcurrentRuns?: number;
  shutdownDrainMs?: number;
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

export type OperationLane = "query" | "mutation" | "admission" | "control" | "run";
