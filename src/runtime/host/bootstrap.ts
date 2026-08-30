/**
 * Runtime Host owner 启动入口。
 *
 * 这里只完成 lock、registration 和 Server 装配；业务 composition 不在 CLI/Desktop 入口复制。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import { RuntimeHostServer } from "./server.js";
import { issueRuntimeHostAccessCredential } from "./credentials.js";
import {
  acquireHostLock,
  ensureRuntimeHostDirectory,
  removeSocketIfStale,
  removeStaleRegistration,
  runtimeHostPaths,
  writeRegistration
} from "./lifecycle.js";
import { runtimeHostProtocolVersion as protocolVersion } from "./protocol.js";
import type { HostRegistration, RuntimeHostStartOptions } from "./types.js";

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
  const token = issueRuntimeHostAccessCredential().secret;
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
    server = new RuntimeHostServer(runtime, commands, registration, lock, options.createRuntime, {
      workspaceRoot: options.workspaceRoot,
      maxSessionRuntimes: options.maxSessionRuntimes,
      maxConcurrentRuns: options.maxConcurrentRuns,
      shutdownDrainMs: options.shutdownDrainMs
    });
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
