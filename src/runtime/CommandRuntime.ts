/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { randomUUID } from "node:crypto";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import { AgentSession } from "../agent/AgentSession.js";
import { ModelManager } from "../llm/ModelManager.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry } from "../tools/registry.js";
import { createTodoTool } from "../tools/todo.js";
import type { ActivitySettings } from "../activity/settings.js";

import { TodoStore } from "../session/todoStore.js";
import { CheckpointStore } from "../session/checkpointStore.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createSkillResourceTool, createSkillTool, expandSkillCommand as expandSkillCommandText, loadSkills, type SkillBundle, type SkillDefinition } from "../extensions/skills.js";
import { skillPathsForSelection, skillPromptForSelection } from "../extensions/skills.js";
import type { ToolRisk, ToolSource } from "../tools/types.js";
import { perfNow, recordPerfPhase } from "../observability/perfTiming.js";
import { loadPlugins } from "../extensions/plugins.js";
import { createMcpResourceTools, McpToolHost } from "../extensions/mcp.js";
import { createSubagentTool, runSubagentTask as executeSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { buildSubagentDefinitionsPrompt, loadSubagentDefinitions, type SubagentDefinition } from "../extensions/agents.js";
import { createMemoryTools } from "../extensions/memory.js";
import { createEmotionTool } from "../tools/emotion.js";
import { createActivityReportTool } from "../tools/activity/report.js";
import { createActivityDigestTool } from "../tools/activity/digest.js";
import { createActivitySearchTool } from "../tools/activity/search.js";
import { createActivitySessionsTool } from "../tools/activity/sessions.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createNativeModelSettings, type NativeModelSettings } from "../llm/nativeFactory.js";
import {
  SubagentTaskManager,
  type SubagentTaskRunOptions,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { ManagedProcessService } from "./ManagedProcessService.js";
import { subagentAccessMode } from "./subagentAccess.js";
import { modelReasoningConfig } from "../ai/capabilities.js";
import { attachmentRoot, ensureAttachmentRoot } from "../attachments/store.js";
import { AiRegistry } from "../llm/AiRegistry.js";
import { RuntimeEventAuthority } from "./RuntimeAuthority.js";
import { DurableTaskRunStore } from "./TaskRunStore.js";
import { AutomationStore } from "./AutomationScheduler.js";
import { GoalGraphStore } from "./GoalGraphStore.js";
import { CapabilityStore } from "./CapabilityStore.js";
import { createProjectSkillKey } from "../extensions/skillRef.js";
import { listEnabledProjectPluginPaths } from "../extensions/pluginRegistry.js";

export interface CommandRuntime {
  workspaceRoot: string;
  /** Location that owns durable runtime/session state. Project work uses the workspace; desktop may pass a global root for non-project sessions. */
  persistenceRoot: string;
  config: AgentConfig;
  agent: AgentSession;
  managedProcesses: ManagedProcessService;
  checkpoints: CheckpointStore | undefined;
  mcp: McpToolHost;
  runtimeAuthority: RuntimeEventAuthority;
  taskRuns: DurableTaskRunStore;
  automationStore: AutomationStore;
  graphs: GoalGraphStore;
  capabilities: CapabilityStore;
  subagents: SubagentTaskManager | undefined;
  extensionReport(section?: ExtensionSection): string;
  /** 扩展实时状态的快照；`/status` 等命令的卡片和文本报告共用。 */
  extensionStatus(): ExtensionStatus;
  /** 当前可用于 TUI 补全的 Skill 元数据；正文仍按需加载。 */
  listSkills(): SkillDefinition[];
  /** 当前注册表的脱敏工具目录，供 Desktop 的单回合能力选择器使用。 */
  listTools(): RuntimeToolCatalogEntry[];
  /** 用户提交 `/skill:name` 后才读取并展开 Skill 正文。 */
  expandSkillCommand(input: string): Promise<string>;
  /** 每个新根回合前重新扫描 Skill，使新增和元数据修改无需重启即可生效。 */
  refreshSkills(): Promise<void>;
  /** 实时重新扫描具名子代理定义（会话期间可编辑生效）。 */
  listSubagentAgents(): Promise<SubagentDefinition[]>;
  startSubagentTask(task: string, options?: SubagentTaskRunOptions): SubmittedSubagentTask;
  setSubagentParentRunId(parentRunId?: string): void;
  close(): Promise<void>;
}

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  risk?: ToolRisk;
}

export interface CommandRuntimeOptions {
  persistenceRoot?: string;
  configStore?: AgentConfigStore;
  attachmentRoot?: string;
  /** Host 为新 session 预先分配的 id；历史 session 仍由 InteractiveAgentRuntime.resumeSession 载入。 */
  sessionId?: string;
}

export async function createCommandRuntime(workspaceRoot: string, options: CommandRuntimeOptions = {}): Promise<CommandRuntime> {
  // Session store 根据 workspace 定位全局项目分区；persistenceRoot 继续承载其余项目运行状态。
  const persistenceRoot = options.persistenceRoot ?? workspaceRoot;
  const projectAttachmentRoot = options.attachmentRoot ?? attachmentRoot(persistenceRoot);
  const configStore = options.configStore ?? createFileConfigStore(persistenceRoot);
  const config = await configStore.load(workspaceRoot);
  const ai = new AiRegistry();
  await ensureAgentDirs(persistenceRoot);
  await ensureAttachmentRoot(persistenceRoot);
  const runtimeAuthority = await RuntimeEventAuthority.open(persistenceRoot);
  const taskRuns = await DurableTaskRunStore.open(persistenceRoot, runtimeAuthority);
  const automationStore = await AutomationStore.open(persistenceRoot, runtimeAuthority);
  const graphs = await GoalGraphStore.open(persistenceRoot, runtimeAuthority);
  const capabilities = await CapabilityStore.open(persistenceRoot, runtimeAuthority);
  const recorder = new SessionRecorder(persistenceRoot, options.sessionId, undefined, runtimeAuthority.asSink());
  const managedProcesses = new ManagedProcessService({ workspaceRoot, persistenceRoot });
  await managedProcesses.initialize();
  const toolRegistry = createToolRegistry(
    { workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: projectAttachmentRoot },
    config.web.search,
    managedProcesses,
    config.web.fetch,
    config.sandbox,
    config.web.cookies
  );
  // 快照挂在工作区的 git 仓库上；非 git 目录下这项能力直接不可用。
  const checkpoints = config.checkpoints.enabled ? await CheckpointStore.open(workspaceRoot) : undefined;
  const todos = new TodoStore(persistenceRoot, recorder.sessionId);
  await todos.initialize();
  toolRegistry.registerBuiltinTool(createTodoTool(todos));
  const permissionManager = new PermissionManager({ ...config.permission, source: "global config.json + project .biny/settings.json" });
  const mcpHost = new McpToolHost();
  let skills: SkillBundle | undefined;
  let agent: AgentSession | undefined;
  let modelManager: ModelManager | undefined;
  let subagentParentRunId: string | undefined;
  let subagentDefinitions: SubagentDefinition[] = [];
  // 具名子代理定义每次委派时重新读取（会话期间可编辑生效）；启动时读一次用于 prompt 与报告。
  const loadAgentDefinitions = (): Promise<SubagentDefinition[]> => loadSubagentDefinitions({
    workspaceRoot,
    projectPaths: config.extensions.subagent.agentPaths
  });
  const subagentOptions: SubagentOptions = {
    workspaceRoot,
    config,
    getModelSettings: (modelAlias?: string) => subagentModelSettings(config, requireModelManager(modelManager), modelAlias),
    getAccessMode: () => subagentAccessMode(permissionManager),
    getParentRunId: () => subagentParentRunId,
    loadAgentDefinitions,
    toolRegistry,
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias)
  };
  const subagentTaskManager = config.extensions.subagent.enabled
    ? new SubagentTaskManager({
      maxConcurrentSubagents: config.extensions.subagent.maxConcurrentSubagents,
      maxPendingSubagents: config.extensions.subagent.maxPendingSubagents,
      timeoutMs: config.extensions.subagent.timeoutMs,
      onSnapshot: (snapshot) => {
        taskRuns.syncSubagentSnapshot(snapshot);
      },
      execute: async (task, context) => await executeSubagentTask(subagentOptions, task, context.signal, context.accessMode, context.agent)
    })
    : undefined;
  const loadedPlugins: string[] = [];
  const skillProjectOverrides = config.extensions.skillProjectOverrides[createProjectSkillKey(workspaceRoot)];
  try {
    // 技能扫描可能因项目内配置路径的软链/硬链问题抛错，放在清理保护内执行。
    const loadSkillsPerfStartedAt = perfNow();
    skills = await loadSkills({
      workspaceRoot,
      projectPaths: config.extensions.skills,
      globalDefaults: config.extensions.skillDefaults,
      projectOverrides: skillProjectOverrides
    });
    recordPerfPhase("host.loadSkills", loadSkillsPerfStartedAt, { count: skills.skills.length }, workspaceRoot);
    toolRegistry.registerUserTool(createSkillTool(() => requireSkillBundle(skills)));
    toolRegistry.registerUserTool(createSkillResourceTool(() => requireSkillBundle(skills)));
    // 先注册通用资源工具。若服务器工具归一化后撞名，connectConfiguredServers 中的
    // 按工具隔离会跳过它，而不会让整个 runtime 在之后重复注册时失败。
    if (Object.values(config.extensions.mcp).some((server) => server.enabled)) {
      for (const tool of createMcpResourceTools(mcpHost)) toolRegistry.registerMcpTool(tool);
    }
    const mcpPerfStartedAt = perfNow();
    await mcpHost.connectConfiguredServers(workspaceRoot, config, toolRegistry);
    recordPerfPhase("host.mcpConnect", mcpPerfStartedAt, undefined, workspaceRoot);
    const pluginsPerfStartedAt = perfNow();
    const managedPluginPaths = await listEnabledProjectPluginPaths(workspaceRoot).catch((error: unknown) => {
      loadedPlugins.push(`managed plugins (failed: ${error instanceof Error ? error.message : String(error)})`);
      return [];
    });
    for (const pluginPath of [...config.extensions.plugins, ...managedPluginPaths]) {
      try {
        loadedPlugins.push(...await loadPlugins(workspaceRoot, [pluginPath], config, toolRegistry, ai));
      } catch (error) {
        // 单个 Plugin 失败只影响它自己；主 Runtime、其它 Plugin 和内置工具仍可用。
        loadedPlugins.push(`${pluginPath} (failed: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
    recordPerfPhase("host.loadPlugins", pluginsPerfStartedAt, { count: loadedPlugins.length }, workspaceRoot);
    // 插件必须先完成 Provider/API 注册，默认模型才能使用插件提供的新类型。
    const modelManagerPerfStartedAt = perfNow();
    modelManager = await ModelManager.create(workspaceRoot, config, configStore, ai);
    recordPerfPhase("host.modelManagerCreate", modelManagerPerfStartedAt, undefined, workspaceRoot);
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions, subagentTaskManager!));
      subagentDefinitions = await loadAgentDefinitions();
    }
    // 读取/写入 durable memory 与“当前聊天是否自动召回/贡献”是两组独立开关。
    // 工具始终注册；显式 save_memory 不会因聊天策略关闭而丢失。
    for (const tool of createMemoryTools(() => agent?.getLocalMemory())) {
      toolRegistry.registerBuiltinTool(tool);
    }
    if (config.context.emotion.enabled && config.context.emotion.allowModelUpdate) {
      toolRegistry.registerBuiltinTool(createEmotionTool({
        getStorage: () => agent?.getEmotionStorage(),
        getFatigue: () => agent?.getFatigue() ?? 0
      }));
    }
    // Activity 回忆改为主动工具集：模型按需生成打工日记/时间线/搜索，而不是把脱敏事件
    // 注入每个回合。模型、策略、记忆库与嵌入运行时都在调用时现取（当前聊天模型 + 最新
    // activity 设置），不沿用装配时的快照；report/digest 执行后会顺手把 worth_memory=1
    // 的分析行同步成记忆条目（幂等）。
    const loadActivitySettings = async (): Promise<ActivitySettings> =>
      (await configStore.load(workspaceRoot)).activity;

    const activityMemoryDeps = {
      getMemory: () => agent?.getLocalMemory()
    } as const;
    toolRegistry.registerBuiltinTool(createActivityReportTool({
      getModel: () => modelManager?.getModel(),
      loadSettings: loadActivitySettings,
      ...activityMemoryDeps
    }));
    toolRegistry.registerBuiltinTool(createActivityDigestTool({
      loadSettings: loadActivitySettings,
      ...activityMemoryDeps
    }));
    toolRegistry.registerBuiltinTool(createActivitySearchTool({
      loadSettings: loadActivitySettings,
      getEmbeddingRuntime: async () => await agent?.getEmbeddingRuntime()
    }));
    toolRegistry.registerBuiltinTool(createActivitySessionsTool({ loadSettings: loadActivitySettings }));
    // MCP/Plugin 仍由 Host 持有连接和执行权，但先把工具能力注册进统一 envelope，
    // 这样 Desktop/TUI 查询 capability projection 时能看到已加载的 Host-owned 能力。
    for (const entry of toolRegistry.listEntries()) {
      if (entry.source !== "mcp" && entry.source !== "plugin") continue;
      try {
        capabilities.ensureHostCapability(`host:${entry.source}:${entry.tool.name}`, entry.tool.parameters);
      } catch {
        // 扩展 schema 不合法时保留原有工具加载行为；实际调用会由 coordinator 记录失败。
      }
    }
    agent = new AgentSession({
      workspaceRoot,
      persistenceRoot,
      configStore,
      config,
      model: undefined,
      modelManager,
      toolRegistry,
      permissionManager,
      recorder,
      skillPrompt: (selection) => skillPromptForSelection(requireSkillBundle(skills), selection),
      subagentPrompt: buildSubagentDefinitionsPrompt(subagentDefinitions),
      skillPaths: (selection) => skillPathsForSelection(requireSkillBundle(skills), selection),
      mcpPrompt: () => mcpHost.instructionsPrompt(),
      todoStore: todos,
      createCheckpoint: checkpoints ? async (label) => await checkpoints.create(label) : undefined,
      attachmentRoot: projectAttachmentRoot,
      runtimeEventSink: runtimeAuthority.asSink(),
      capabilities
    });
    await agent.initialize();
  } catch (error) {
    // agent.initialize() 失败时 agent 已构造但不随下方资源关闭；recorder.close 幂等，重复调用安全。
    await agent?.close().catch(() => undefined);
    await subagentTaskManager?.close();
    await managedProcesses.close();
    await mcpHost.close();
    await recorder.close();
    automationStore.close();
    graphs.close();
    capabilities.close();
    taskRuns.close();
    runtimeAuthority.close();
    throw error;
  }
  if (!agent || !skills) throw new Error("Failed to initialize Biny agent runtime.");

  // MCP 连接状态与工具集合在运行期会变（断线、重连、list_changed），报告每次实时取。
  const extensionStatus = (): ExtensionStatus => ({
    mcp: mcpHost.listServers(),
    skills: [...requireSkillBundle(skills).skills],
    skillWarnings: [...requireSkillBundle(skills).warnings],
    plugins: [...loadedPlugins],
    subagent: { ...config.extensions.subagent, agents: [...subagentDefinitions] },
    toolScheduling: {
      maxConcurrentTools: config.agent.maxConcurrentTools,
      maxQueuedToolCalls: config.agent.maxQueuedToolCalls
    },
    toolCounts: createToolCounts(toolRegistry.listEntries())
  });

  const startSubagentTask = (task: string, taskOptions?: SubagentTaskRunOptions): SubmittedSubagentTask => {
    if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in config.json.");
    if (!subagentTaskManager) throw new Error("Subagent runtime is unavailable.");
    const taskId = taskOptions?.taskId ?? randomUUID();
    agent.recordHostedUserMessage(task);
    const sequence = agent.recordHostedToolCall("delegate_task", taskOptions?.agent ? { task, agent: taskOptions.agent } : { task }, taskId);
    let submitted: SubmittedSubagentTask;
    try {
      taskOptions?.signal?.throwIfAborted();
      submitted = subagentTaskManager.submit(task, {
        taskId,
        parentRunId: taskOptions?.parentRunId,
        signal: taskOptions?.signal,
        timeoutMs: taskOptions?.timeoutMs,
        accessMode: taskOptions?.accessMode ?? subagentAccessMode(permissionManager),
        agent: taskOptions?.agent
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      agent.recordHostedToolResult("delegate_task", { error: failure.message }, taskId, sequence);
      throw failure;
    }

    const completion = submitted.completion.then(
      (result) => {
        agent.recordHostedToolResult("delegate_task", result, taskId, sequence);
        agent.recordHostedAssistantMessage(result);
        return result;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        agent.recordHostedToolResult("delegate_task", { error: failure.message }, taskId, sequence);
        throw failure;
      }
    );
    // Background CLI starts intentionally do not await completion. Attaching a
    // rejection observer keeps cancellation/failure from becoming unhandled;
    // foreground callers can still await the original completion promise.
    void completion.catch(() => undefined);
    return { ...submitted, completion };
  };

  const runtime: CommandRuntime = {
    workspaceRoot,
    persistenceRoot,
    config,
    agent,
    managedProcesses,
    checkpoints,
    mcp: mcpHost,
    runtimeAuthority,
    taskRuns,
    automationStore,
    graphs,
    capabilities,
    subagents: subagentTaskManager,
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus(), section),
    extensionStatus: (): ExtensionStatus => extensionStatus(),
    listSkills: (): SkillDefinition[] => [...requireSkillBundle(skills).skills],
    listTools: (): RuntimeToolCatalogEntry[] => toolRegistry.listEntries().map(({ source, tool }) => ({
      name: tool.name,
      description: tool.description,
      source,
      risk: tool.risk
    })),
    expandSkillCommand: async (input: string): Promise<string> => await expandSkillCommandText(requireSkillBundle(skills), input),
    refreshSkills: async (): Promise<void> => {
      skills = await loadSkills({
        workspaceRoot,
        projectPaths: config.extensions.skills,
        globalDefaults: config.extensions.skillDefaults,
        projectOverrides: skillProjectOverrides
      });
    },
    listSubagentAgents: async (): Promise<SubagentDefinition[]> => {
      subagentDefinitions = await loadAgentDefinitions();
      return [...subagentDefinitions];
    },
    startSubagentTask,
    setSubagentParentRunId: (parentRunId?: string): void => {
      subagentParentRunId = parentRunId;
    },
    close: async () => {
      try {
        await subagentTaskManager?.close();
        await agent.close();
      } finally {
        try {
          await managedProcesses.close();
        } finally {
          try {
            await mcpHost.close();
          } finally {
            try {
              automationStore.close();
            } finally {
              try {
                graphs.close();
              } finally {
                try {
                  capabilities.close();
                } finally {
                  try {
                    taskRuns.close();
                  } finally {
                    runtimeAuthority.close();
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  return runtime;
}

function subagentModelSettings(config: AgentConfig, modelManager: ModelManager, modelAlias?: string): NativeModelSettings {
  // 具名定义的 model 覆盖优先于全局 subagent model；两者都未配置时沿用当前会话模型。
  const alias = modelAlias ?? config.extensions.subagent.model;
  if (!alias) return modelManager.getModelSettings();
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  if (model.supportsTools === false) throw new Error(`Subagent model ${alias} does not support tools.`);
  const reasoning = modelReasoningConfig(model);
  const modelConfig = {
    ...config,
    defaultModel: alias,
    thinking: reasoning
      ? { enabled: true, effort: reasoning.defaultEffort }
      : { enabled: false, effort: "high" as const }
  };
  return createNativeModelSettings(modelConfig, alias);
}

function requireModelManager(modelManager: ModelManager | undefined): ModelManager {
  if (!modelManager) throw new Error("Model runtime is not initialized.");
  return modelManager;
}

function requireSkillBundle(skills: SkillBundle | undefined): SkillBundle {
  if (!skills) throw new Error("Skill runtime is not initialized.");
  return skills;
}

export async function withCommandRuntime(workspaceRoot: string, fn: (runtime: CommandRuntime) => Promise<void>): Promise<void> {
  const runtime = await createCommandRuntime(workspaceRoot);
  try {
    await fn(runtime);
  } catch (error) {
    // 命令层的异常统一落到 session，方便 resume 时看到失败原因。
    runtime.agent.recordError(error);
    throw error;
  } finally {
    await runtime.close();
  }
}
