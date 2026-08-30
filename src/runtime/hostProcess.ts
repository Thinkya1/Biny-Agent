/**
 * 独立 Runtime Host 进程入口。
 *
 * 这个文件只负责 composition root 和进程信号；协议、owner 选举、生命周期和 runtime
 * 重建都留在 `runtime/host/`，便于 CLI、Desktop 和测试共享同一套边界。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileConfigStore } from "../config/store.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "./InteractiveAgentRuntime.js";
import { WorktreeManager } from "./host/worktree.js";
import {
  findLatestInterruptedSession,
  startRuntimeHost,
  type RuntimeHostFactory,
  type RuntimeHostFactoryOptions
} from "./RuntimeHost.js";

export interface RuntimeHostProcessOptions {
  workspaceRoot: string;
  persistenceRoot: string;
  configDir?: string;
  attachmentRoot?: string;
  sessionId?: string;
  resumeInterrupted: boolean;
}

export async function runRuntimeHostProcess(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  const selectedSession = options.sessionId
    ?? (options.resumeInterrupted ? await findLatestInterruptedSession(options.persistenceRoot) : undefined);
  const configStore = createFileConfigStore(options.workspaceRoot, {
    globalDir: options.configDir
  });
  const createRuntime: RuntimeHostFactory = async (sessionId?: string, factoryOptions?: RuntimeHostFactoryOptions): Promise<InteractiveAgentHost> => {
    const fresh = factoryOptions?.fresh === true;
    const host = await createInteractiveAgentHost(factoryOptions?.workspaceRoot ?? options.workspaceRoot, {
      persistenceRoot: options.persistenceRoot,
      configStore,
      attachmentRoot: options.attachmentRoot,
      sessionId: fresh ? sessionId : undefined
    });
    try {
      if (sessionId !== undefined && !fresh) await host.runtime.resumeSession(sessionId);
      return host;
    } catch (error) {
      await host.runtime.close();
      throw error;
    }
  };

  const worktrees = new WorktreeManager(options.workspaceRoot, options.persistenceRoot);
  const initialFactoryOptions = selectedSession === undefined
    ? undefined
    : await worktrees.runtimeFactoryOptions(selectedSession);
  const initial = await createRuntime(selectedSession, initialFactoryOptions);
  let server;
  try {
    server = await startRuntimeHost(options.persistenceRoot, initial.runtime, initial.commands, {
      workspaceRoot: options.workspaceRoot,
      createRuntime,
      resumeInterrupted: options.resumeInterrupted,
      configDir: options.configDir
    });
  } catch (error) {
    await initial.runtime.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.closeOwner().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => undefined);
}

function parseOptions(argv: readonly string[]): RuntimeHostProcessOptions {
  const values = new Map<string, string>();
  let resumeInterrupted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--resume-interrupted") {
      resumeInterrupted = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unknown Runtime Host argument: ${argument ?? ""}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Runtime Host argument ${argument} needs a value.`);
    values.set(name, value);
    index += 1;
  }
  const workspaceRoot = requiredOption(values, "workspace-root");
  const persistenceRoot = requiredOption(values, "persistence-root");
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    persistenceRoot: path.resolve(persistenceRoot),
    configDir: values.get("config-dir"),
    attachmentRoot: values.get("attachment-root"),
    sessionId: values.get("session-id"),
    resumeInterrupted
  };
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value?.trim()) throw new Error(`Runtime Host requires --${name}.`);
  return value;
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedFile === currentFile) await runRuntimeHostProcess();
