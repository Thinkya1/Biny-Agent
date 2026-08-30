/**
 * 计划命令模块。
 *
 * CLI 只负责启动共享 runtime；计划消息的上下文组装和记录由 AgentSession 处理。
 */
import { createInteractiveAgentHost, type InteractiveAgentHost, type InteractiveRuntimeHandle } from "../../runtime/InteractiveAgentRuntime.js";
import {
  connectOrSpawnRuntimeHost,
  startRuntimeHost,
  type RuntimeHostFactory,
  type RuntimeHostFactoryOptions,
  type RuntimeHostServer
} from "../../runtime/RuntimeHost.js";
import { withCliAbortSignal } from "../sigint.js";

export async function planCommand(workspaceRoot: string, task: string): Promise<void> {
  let attached;
  try {
    attached = await connectOrSpawnRuntimeHost(workspaceRoot, {
      workspaceRoot,
      resumeInterrupted: false,
      surface: "cli",
      clientId: `plan-${process.pid}`
    });
  } catch {
    attached = undefined;
  }
  let runtime: InteractiveRuntimeHandle;
  let host: RuntimeHostServer | undefined;
  if (attached) {
    runtime = attached;
  } else {
    const createLocalRuntime: RuntimeHostFactory = async (sessionId?: string, factoryOptions?: RuntimeHostFactoryOptions): Promise<InteractiveAgentHost> => {
      const fresh = factoryOptions?.fresh === true;
      const local = await createInteractiveAgentHost(factoryOptions?.workspaceRoot ?? workspaceRoot, {
        persistenceRoot: workspaceRoot,
        sessionId: fresh ? sessionId : undefined
      });
      if (sessionId !== undefined && !fresh) await local.runtime.resumeSession(sessionId);
      return local;
    };
    const local = await createLocalRuntime();
    runtime = local.runtime;
    try {
      host = await startRuntimeHost(workspaceRoot, runtime, local.commands, {
        createRuntime: createLocalRuntime,
        resumeInterrupted: false
      });
    } catch (error) {
      await runtime.close();
      const retry = await connectOrSpawnRuntimeHost(workspaceRoot, {
        workspaceRoot,
        resumeInterrupted: false,
        surface: "cli",
        clientId: `plan-${process.pid}`
      });
      if (!retry) throw error;
      runtime = retry;
    }
  }
  try {
    const outcome = await withCliAbortSignal(async (signal) => {
      const submitted = runtime.submitPrompt(task, "plan");
      const onAbort = (): void => {
        runtime.cancelRun(submitted.runId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await submitted.completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    if (outcome.output) console.log(outcome.output);
    if (outcome.status !== "completed") {
      throw new Error(outcome.error ?? `Plan stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`);
    }
    console.log(`\nSession: ${runtime.getSnapshot().info.sessionFile}`);
  } finally {
    await host?.close();
    await runtime.close();
  }
}
