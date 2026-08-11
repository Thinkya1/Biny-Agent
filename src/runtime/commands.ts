/**
 * 交互端共享的 slash command 注册表与运行时命令执行器。
 *
 * 注册表是 Desktop、TUI 的唯一命令声明来源；只涉及界面布局的命令仍由对应前端处理，
 * 会读取或修改 Agent/runtime 状态的命令统一在这里执行。
 */
import { randomUUID } from "node:crypto";
import { formatSubagentAgentList } from "../extensions/report.js";
import { redactSecrets } from "../utils/secrets.js";
import { formatSubagentTaskReport } from "./subagentTaskReport.js";
import { formatStatusReport } from "./statusReport.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { CommandSurface } from "./commandRegistry.js";
import type { TaskRunStatus } from "./TaskRunStore.js";
import type {
  AgentPersonalizationState,
  ChatPersonalizationOverridePatch,
  PersonalityPreset
} from "../personalization/index.js";

export interface RuntimeCommandResult {
  command: string;
  title: string;
  content: string;
}

/**
 * 执行不依赖具体界面布局的命令。返回 undefined 表示该命令应由前端本地处理。
 */
export async function executeRuntimeCommand(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  input: string,
  source: CommandSurface
): Promise<RuntimeCommandResult | undefined> {
  const [command = "", ...args] = input.trim().replace(/^\/+/, "/").split(/\s+/);
  if (command === "/status") {
    const snapshot = runtime.getSnapshot();
    const info = snapshot.info;
    const context = await services.agent.contextStatus();
    return result(command, "Status", formatStatusReport(
      info,
      snapshot.permissionMode,
      context,
      services.agent.usageSummary(),
      services.extensionReport(),
      typeof services.agent.modelRequestSummary === "function" ? services.agent.modelRequestSummary() : undefined
    ));
  }
  if (command === "/usage") return result(command, "Usage", services.agent.usageReport());
  if (command === "/tasks") {
    const page = services.taskRuns.list({ status: args[0] === undefined ? undefined : readTaskStatus(args[0]) });
    return result(command, "Tasks", JSON.stringify(page, null, 2));
  }
  if (command === "/automation") {
    const action = args[0]?.toLowerCase();
    if (!action || action === "list") return result(command, "Automation", JSON.stringify(services.automationStore.list(), null, 2));
    const automationId = args[1]?.trim();
    if (!automationId) throw new Error("Usage: /automation list | pause <id> | resume <id> | run <id> | delete <id>");
    if (action === "pause") return result(command, "Automation", JSON.stringify(services.automationStore.pause(automationId), null, 2));
    if (action === "resume") return result(command, "Automation", JSON.stringify(services.automationStore.resume(automationId), null, 2));
    if (action === "delete") {
      services.automationStore.delete(automationId);
      return result(command, "Automation", `Deleted ${automationId}.`);
    }
    if (action === "run") throw new Error("Use `biny automation run` or the Desktop automation action to execute a fire.");
    throw new Error("Usage: /automation list | pause <id> | resume <id> | run <id> | delete <id>");
  }
  if (command === "/goal") {
    const action = args[0]?.toLowerCase() ?? "get";
    const goalId = action === "get" ? args[1] ?? args[0] : args[1];
    if (!goalId) throw new Error("Usage: /goal get <id> | pause <id> | resume <id> | cancel <id>");
    if (action === "get") return result(command, "Goal", JSON.stringify(services.graphs.getGoal(goalId), null, 2));
    if (action === "pause") return result(command, "Goal", JSON.stringify(services.graphs.updateGoal(goalId, "paused"), null, 2));
    if (action === "resume") return result(command, "Goal", JSON.stringify(services.graphs.updateGoal(goalId, "active"), null, 2));
    if (action === "cancel") return result(command, "Goal", JSON.stringify(services.graphs.updateGoal(goalId, "cancelled"), null, 2));
    throw new Error("Usage: /goal get <id> | pause <id> | resume <id> | cancel <id>");
  }
  if (command === "/graph") {
    const action = args[0]?.toLowerCase() ?? "inspect";
    const graphId = action === "inspect" || action === "events" ? args[1] ?? args[0] : args[1];
    if (!graphId) throw new Error("Usage: /graph inspect <id> | start <id> | pause <id> | resume <id> | cancel <id> | events <id>");
    if (action === "inspect") return result(command, "Graph", JSON.stringify(services.graphs.inspectGraph(graphId), null, 2));
    if (action === "events") return result(command, "Graph events", JSON.stringify(services.graphs.listGraphEvents(graphId), null, 2));
    if (action === "start") {
      const graph = services.graphs.startGraph(graphId);
      services.graphs.createWake(graph.graphId, "graph_started");
      return result(command, "Graph", JSON.stringify(graph, null, 2));
    }
    if (action === "pause") return result(command, "Graph", JSON.stringify(services.graphs.pauseGraph(graphId), null, 2));
    if (action === "resume") {
      const graph = services.graphs.resumeGraph(graphId);
      services.graphs.createWake(graph.graphId, "graph_resumed");
      return result(command, "Graph", JSON.stringify(graph, null, 2));
    }
    if (action === "cancel") return result(command, "Graph", JSON.stringify(services.graphs.cancelGraph(graphId), null, 2));
    throw new Error("Usage: /graph inspect <id> | start <id> | pause <id> | resume <id> | cancel <id> | events <id>");
  }
  if (command === "/capabilities") {
    return result(command, "Capabilities", JSON.stringify(services.capabilities.list(), null, 2));
  }
  if (command === "/mcp") {
    if (args[0]?.toLowerCase() !== "reconnect") {
      return result(command, "MCP", services.extensionReport("mcp").replace(/^MCP\n/, ""));
    }
    const serverName = args[1]?.trim();
    if (!serverName || args.length !== 2) throw new Error("Usage: /mcp reconnect <server>");
    const status = await runtime.runExclusiveOperation(
      "mcp",
      async () => await services.mcp.reconnectServer(serverName)
    );
    return result(
      command,
      "MCP",
      status.connected
        ? `Reconnected ${serverName} (${String(status.toolNames.length)} tools).`
        : `Reconnect failed for ${serverName}: ${status.lastError ?? "unknown error"}`
    );
  }
  if (command === "/skills") return result(command, "[Skills]", services.extensionReport("skills").replace(/^Skills\n/, ""));
  if (command === "/plugins") return result(command, "Plugins", services.extensionReport("plugins").replace(/^Plugins\n/, ""));
  if (command === "/personality") {
    const patch = personalityPatch(args);
    if (!patch) return result(command, "Personality", formatPersonalizationState(await services.agent.getPersonalizationState()));
    const state = await services.agent.getPersonalizationState();
    if (!state.catalogRevision) throw new Error("Chat personalization revision is unavailable.");
    const updated = await runtime.runExclusiveOperation(
      "personalization",
      async () => await services.agent.updateChatPersonalization(patch, state.catalogRevision)
    );
    return result(command, "Personality", `${formatPersonalizationState(updated)}\n\nChanges apply from the next root turn.`);
  }
  if (command === "/memories") {
    const patch = memoryPolicyPatch(args[0]);
    if (!patch) return result(command, "Memories", formatPersonalizationState(await services.agent.getPersonalizationState()));
    const state = await services.agent.getPersonalizationState();
    if (!state.catalogRevision) throw new Error("Chat personalization revision is unavailable.");
    const updated = await runtime.runExclusiveOperation(
      "personalization",
      async () => await services.agent.updateChatPersonalization(patch, state.catalogRevision)
    );
    return result(command, "Memories", `${formatPersonalizationState(updated)}\n\nChanges apply from the next root turn.`);
  }
  if (command === "/memory") {
    return result(
      command,
      "Memory",
      await runtime.runExclusiveOperation("memory", async () => await services.agent.runMemoryCommand(args))
    );
  }
  if (command === "/subagent") return await executeSubagentCommand(runtime, services, command, args, source);
  if (command === "/review") {
    const task = args.join(" ").trim()
      || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    return result(command, "Code Review", await runForegroundSubagent(runtime, services, task) || "No review findings.");
  }
  if (command === "/compact") {
    return result(command, "Compact", await runtime.compactConversation(args.join(" ").trim() || undefined));
  }
  if (command === "/undo") {
    const checkpointStore = services.checkpoints;
    const checkpoints = checkpointStore ? await checkpointStore.list() : [];
    if (!checkpoints.length) {
      return result(command, "Undo", "No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
    }
    if (args[0] === "list") {
      return result(command, "Checkpoints", checkpoints.map((entry) => `${entry.id}  ${entry.createdAt}  ${entry.label}`).join("\n"));
    }
    if (!checkpointStore) {
      throw new Error("Checkpoints need a git repository; this workspace is not one.");
    }
    const summary = await runtime.runExclusiveOperation(
      "checkpoint",
      async () => await checkpointStore.restore(args[0] ?? "latest")
    );
    const moved = summary.movedAside.length
      ? `\nMoved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}:\n${summary.movedAside.join("\n")}`
      : "";
    return result(command, "Undo", `Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).${moved}`);
  }
  return undefined;
}

function personalityPatch(args: string[]): ChatPersonalizationOverridePatch | undefined {
  const action = args[0]?.toLowerCase();
  if (!action) return undefined;
  if (action === "inherit" || action === "none" || action === "friendly" || action === "pragmatic") {
    return { personality: action as "inherit" | PersonalityPreset };
  }
  if (action === "instructions") {
    const instructionAction = args[1]?.toLowerCase();
    if (instructionAction === "inherit") return { customInstructions: { mode: "inherit" } };
    if (instructionAction === "off" || instructionAction === "disabled" || instructionAction === "clear") {
      return { customInstructions: { mode: "disabled" } };
    }
    if (instructionAction === "set") {
      const value = args.slice(2).join(" ").trim();
      if (value) return { customInstructions: { mode: "replace", value } };
    }
  }
  throw new Error("Usage: /personality [inherit|none|friendly|pragmatic] | instructions [set <text>|inherit|off]");
}

function memoryPolicyPatch(action: string | undefined): ChatPersonalizationOverridePatch | undefined {
  if (action === undefined) return undefined;
  if (action === "inherit") return { useMemories: "inherit", contributeMemories: "inherit" };
  if (action === "both") return { useMemories: true, contributeMemories: true };
  if (action === "use") return { useMemories: true, contributeMemories: false };
  if (action === "contribute") return { useMemories: false, contributeMemories: true };
  if (action === "off") return { useMemories: false, contributeMemories: false };
  throw new Error("Usage: /memories [inherit|both|use|contribute|off]");
}

function formatPersonalizationState(state: AgentPersonalizationState): string {
  return [
    `Personality: ${state.resolved.personality} (override: ${state.override.personality})`,
    `Custom instructions: ${state.override.customInstructions.mode}; ${state.resolved.instructionsHash}`,
    `Use memories: ${state.resolved.useMemories ? "yes" : "no"} (override: ${String(state.override.useMemories)})`,
    `Contribute memories: ${state.resolved.contributeMemories ? "yes" : "no"} (override: ${String(state.override.contributeMemories)})`
  ].join("\n");
}

async function executeSubagentCommand(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  command: string,
  args: string[],
  source: CommandSurface
): Promise<RuntimeCommandResult> {
  const action = args[0]?.toLowerCase();
  // Inspector 这类结构化入口用分隔符声明“后续全是任务文本”，不能再把首词解释成控制动作。
  if (action === "--") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent -- <read-only task>");
    return result(command, "Subagent", await runForegroundSubagent(runtime, services, task) || "Subagent returned no text.");
  }
  if (action === "agents") {
    return result(command, "Subagent", formatSubagentAgentList(await services.listSubagentAgents()));
  }
  if (action === "status") {
    return result(command, "Subagent", formatSubagentTaskReport(services.subagents?.listSnapshots() ?? []));
  }
  if (action === "cancel") {
    const taskId = args[1]?.trim();
    if (!taskId) throw new Error("Usage: /subagent cancel <task-id>");
    const cancelled = services.subagents?.cancelTask(taskId, `Cancelled from the ${source}.`) ?? false;
    return result(command, "Subagent", cancelled
      ? `Cancelled subagent task ${taskId}.`
      : `No active subagent task found for ${taskId}.`);
  }
  if (action === "start") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent start <read-only task>");
    const submitted = runtime.startBackgroundOperation(
      "subagent",
      (signal) => services.startSubagentTask(task, { signal })
    );
    void submitted.completion.catch(() => undefined);
    return result(command, "Subagent", `Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
  }
  const task = args.join(" ").trim();
  if (!task) {
    return result(command, "Subagent", "Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id> | agents");
  }
  return result(command, "Subagent", await runForegroundSubagent(runtime, services, task) || "Subagent returned no text.");
}

async function runForegroundSubagent(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  task: string
): Promise<string> {
  try {
    return await runtime.runExclusiveOperation(
      "subagent",
      async (signal) => await services.startSubagentTask(task, { taskId: randomUUID(), signal }).completion
    );
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(redactSecrets(String(error)));
    const publicMessage = redactSecrets(error.message);
    if (publicMessage === error.message) throw error;
    try {
      Object.defineProperty(error, "message", { value: publicMessage, configurable: true });
    } catch {
      const publicError = new Error(publicMessage);
      publicError.name = error.name;
      throw publicError;
    }
    throw error;
  }
}

function result(command: string, title: string, content: string): RuntimeCommandResult {
  return { command, title, content };
}

function readTaskStatus(value: string): TaskRunStatus {
  if (value === "queued" || value === "created" || value === "running" || value === "verifying" || value === "completed" || value === "failed" || value === "incomplete" || value === "blocked" || value === "policy_denied" || value === "budget_exhausted" || value === "needs_approval" || value === "aborted" || value === "cancelled") return value;
  throw new Error(`Unknown TaskRun status: ${value}`);
}
