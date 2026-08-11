/**
 * 桌面端 agent 运行时管理。
 *
 * 每个项目一个 runtime handle，按需懒创建并缓存在 `runtimes` 里；当前进程可能是
 * Runtime Host owner，也可能 attach 到其它 Desktop/TUI owner。一个项目同一时刻只能
 * 有一个活动会话在跑，切换会话前必须先停掉当前运行。
 *
 * 几处需要注意的状态：
 * - `runtimeInitializations` 缓存正在创建中的 promise，避免并发请求把同一个项目初始化两次；
 * - `liveEvents` 暂存本轮的实时事件，界面重新打开会话时要把它们接在历史事件后面；
 * - `runtimeErrors` 记住初始化失败原因，让界面能显示「为什么这个项目起不来」而不是一直转圈。
 *
 * 模型配置的保存与连通性测试也在这里：写入前先用候选配置实际发一次请求，避免存下一份用不了的配置。
 */
import type { AgentAttachment, InteractiveAgentRunMode } from "../../../agent/AgentSession.js";
import type {
  MemoryEntriesResult,
  MemoryOverview,
  MemorySearchResult
} from "../../../agent/context/memoryTypes.js";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { providerDefinition } from "../../../ai/provider.js";
import { loadProjectSettings } from "../../../config/projectSettings.js";
import { globalConfigDir } from "../../../config/paths.js";
import { configSchema, type AgentConfig, type ProviderConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import { createNativeModelSettings, validateModelConfiguration } from "../../../llm/nativeFactory.js";
import { ModelRuntime } from "../../../llm/ModelRuntime.js";
import { FileModelsStore, restoreProviderCatalogs, type ModelsStore } from "../../../llm/ModelsStore.js";
import { hasUsableModelConfiguration, listConfiguredModelChoices, type ModelRuntimeInfo, type ThinkingSelection } from "../../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { webSearchKeyEnvNames } from "../../../tools/web/search.js";
import { executeRuntimeCommand } from "../../../runtime/commands.js";
import {
  createInteractiveAgentHost,
  type AgentRunOutcome,
  type InteractiveAgentHost,
  type InteractiveRuntimeHandle
} from "../../../runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../../../runtime/CommandRuntime.js";
import {
  connectOrSpawnRuntimeHostWithOwnership,
  startRuntimeHost,
  RuntimeHostClient,
  type HostOperationResult,
  type RuntimeHostFactory,
  type RuntimeHostServer
} from "../../../runtime/RuntimeHost.js";
import { SessionLeaseError } from "../../../runtime/SessionLease.js";
import { sessionCatalogRecordRevision } from "../../../session/catalog.js";
import type { AgentPersonalizationState, GlobalPersonalizationUpdate } from "../../../personalization/index.js";
import { activeRun, isTerminalRunEvent, runtimeIsBusy, type AgentHostEvent, type AgentRuntimeUpdate } from "../../../runtime/agentEvents.js";
import { evaluateTaskRetry } from "../../../runtime/TaskRetryPolicy.js";
import { isTaskRunTerminal } from "../../../runtime/TaskRunStore.js";
import { withAttachmentReferences } from "../../attachmentReferences.js";
import type {
  DesktopAttachment,
  DesktopChatPersonalizationOverride,
  DesktopMemoryCompactionResult,
  DesktopMemoryEntryInput,
  DesktopMemoryOverview,
  DesktopMemoryScope,
  DesktopMemorySearchMatch,
  DesktopMemorySettingsInput,
  DesktopMemorySettingsSnapshot,
  DesktopModelCatalogResult,
  DesktopModelConfigurationInput,
  DesktopModelConnection,
  DesktopModelConnectionTestResult,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopPersonalizationOverview,
  DesktopPersonalizationSettingsInput,
  DesktopRunReceipt,
  DesktopRuntimeMutation,
  DesktopRuntimeProjection,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopSessionTreePage,
  DesktopSessionTreePageOptions,
  DesktopSlashResult,
  DesktopWebSearchSettings,
  DesktopWebSearchSettingsInput,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import type { AutomationCreateInput } from "../../../runtime/AutomationScheduler.js";
import type { GraphNodeInput } from "../../../runtime/GoalGraphStore.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopModelLoginService, type AuthenticatedModelLogin } from "./DesktopModelLoginService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

interface ManagedRuntime {
  runtime: InteractiveRuntimeHandle;
  commands?: CommandRuntime;
  host?: RuntimeHostServer;
  spawnedHost?: ChildProcess;
  unsubscribe(): void;
}

export class DesktopAgentManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>();
  private readonly liveEvents = new Map<string, Map<string, AgentHostEvent[]>>();
  private readonly runtimeErrors = new Map<string, string>();
  private readonly modelLogin: DesktopModelLoginService;
  private closing = false;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly projects: DesktopProjectService,
    private readonly configStore: AgentConfigStore,
    private readonly emit: (projectId: string, update: AgentRuntimeUpdate) => void,
    openExternal?: (url: string) => Promise<void>,
    private readonly modelsStore: ModelsStore = new FileModelsStore()
  ) {
    this.modelLogin = new DesktopModelLoginService(openExternal ?? (async () => {
      throw new Error("当前环境无法打开浏览器。");
    }));
  }

  async workspaceSnapshot(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const storedProject = this.projects.requireProject(projectId);
    const project = await this.projects.inspectProject(storedProject);
    // Keep lastOpenedAt stable on select/refresh so the sidebar order does not jump.
    await this.state.upsertProject(project);
    const runtime = this.runtimes.get(projectId)?.runtime;
    const [config, sessions, sessionPage] = await Promise.all([
      this.configStore.load(project.path).catch(() => undefined),
      this.projects.listSessions(project, runtime?.getSnapshot(), this.projectEvents(projectId)),
      this.projects.listSessionTreePage(project, runtime?.getSnapshot(), this.projectEvents(projectId))
    ]);
    const models = config ? listConfiguredModelChoices(config) : [];
    const runtimeProjection = runtime === undefined ? undefined : await this.runtimeProjection(projectId);
    return {
      project,
      sessions,
      sessionPage,
      selectedSessionId: this.state.selectedSessionId(projectId),
      runtime: runtime?.getSnapshot(),
      runtimeError: this.runtimeErrors.get(projectId),
      requiresModelConfiguration: !config || !hasUsableModelConfiguration(config),
      models,
      connections: config ? describeModelConnections(config) : [],
      runtimeProjection
    };
  }

  /**
   * 侧栏首屏只读取每个项目的根会话；子节点通过 listSessionTreePage 单独按需读取。
   * 这不会初始化其它项目的 runtime。
   */
  async sidebarSessions(workspace?: DesktopWorkspaceSnapshot): Promise<DesktopSessionSummary[]> {
    const sessionGroups = await Promise.all(this.state.projects().map(async (storedProject) => {
      if (workspace?.project.id === storedProject.id) return workspace.sessionPage?.sessions ?? workspace.sessions;
      const project = await this.projects.inspectProject(storedProject);
      const runtime = this.runtimes.get(project.id)?.runtime;
      return (await this.projects.listSessionTreePage(project, runtime?.getSnapshot(), this.projectEvents(project.id))).sessions;
    }));
    return sessionGroups.flat();
  }

  async listSessionTreePage(projectId: string, options: DesktopSessionTreePageOptions = {}): Promise<DesktopSessionTreePage> {
    const project = await this.projects.inspectProject(this.projects.requireProject(projectId));
    const runtime = this.runtimes.get(projectId)?.runtime;
    return await this.projects.listSessionTreePage(project, runtime?.getSnapshot(), this.projectEvents(projectId), options);
  }

  async startDraft(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("当前项目仍有任务运行。请先停止它，或稍后再开始新任务。");
    }
    if (managed) {
      if (managed.runtime instanceof RuntimeHostClient) {
        await managed.runtime.restartRuntime();
      } else {
        await this.closeManagedRuntime(managed);
        this.runtimes.delete(projectId);
      }
    }
    this.runtimeErrors.delete(projectId);
    return await this.workspaceSnapshot(projectId);
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectPinned(projectId, pinned);
    return await this.workspaceSnapshot(projectId);
  }

  async renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectName(projectId, name);
    return await this.workspaceSnapshot(projectId);
  }

  async openSession(projectId: string, sessionId: string): Promise<DesktopSessionDocument> {
    const project = this.projects.requireProject(projectId);
    const runtime = this.runtimes.get(projectId)?.runtime;
    const document = await this.projects.openSession(project, sessionId, runtime?.getSnapshot(), this.projectEvents(projectId));
    // markSessionRead 在锁内重读 catalog，返回的整条记录才与 revision 属于同一版本。
    // 只拼 revision 会让并发重命名等操作产生「旧字段 + 新 revision」的伪一致快照。
    const metadata = await this.projects.markSessionRead(project, sessionId);
    return {
      ...document,
      session: {
        ...document.session,
        title: metadata.title ?? document.session.title,
        pinned: metadata.pinned ?? document.session.pinned,
        archived: metadata.archived ?? document.session.archived,
        unread: metadata.unread ?? false,
        labels: metadata.labels === undefined ? document.session.labels : [...metadata.labels],
        personalization: metadata.personalization ?? document.session.personalization,
        metadataRevision: sessionCatalogRecordRevision(metadata),
        rootSessionId: metadata.rootSessionId,
        parentSessionId: metadata.parentSessionId,
        branchPoint: metadata.branchPoint
      }
    };
  }

  async renameSession(projectId: string, sessionId: string, title: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { title }, expectedRevision);
    return await this.workspaceSnapshot(projectId);
  }

  async pinSession(projectId: string, sessionId: string, pinned: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { pinned }, expectedRevision);
    return await this.workspaceSnapshot(projectId);
  }

  async archiveSession(projectId: string, sessionId: string, archived: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    await this.projects.updateSessionMetadata(this.projects.requireProject(projectId), sessionId, { archived }, expectedRevision);
    return await this.workspaceSnapshot(projectId);
  }

  async markSessionRead(projectId: string, sessionId: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot> {
    await this.projects.markSessionRead(this.projects.requireProject(projectId), sessionId, expectedRevision);
    return await this.workspaceSnapshot(projectId);
  }

  async sendPrompt(
    projectId: string,
    sessionId: string | undefined,
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[],
    delivery?: "steer" | "followUp"
  ): Promise<DesktopRunReceipt> {
    let managed = await this.ensureRuntime(projectId);
    let runtime = managed.runtime;
    let snapshot = runtime.getSnapshot();
    // 没有显式选中历史 session 时，第一条消息必须落到新聊天，而不是附加到
    // Desktop 启动前 Host 恰好持有的旧空闲 session。运行中的 Host 仍保持可观察和可 follow-up。
    if (!sessionId && !runtimeIsBusy(snapshot)) {
      await this.startDraft(projectId);
      managed = await this.ensureRuntime(projectId);
      runtime = managed.runtime;
      snapshot = runtime.getSnapshot();
    }
    if (runtimeIsBusy(snapshot)) {
      if (!sessionId || snapshot.info.sessionId !== sessionId) {
        throw new Error("当前项目已有任务正在运行。请先在 Desktop 中明确打开该会话，或在 TUI 使用 /app 交接后再继续。");
      }
      const project = this.projects.requireProject(projectId);
      const prompt = withAttachmentReferences(input, attachments);
      const nativeAttachments = await loadNativeAttachments(this.projects.attachmentsRoot(project), attachments);
      const queued = delivery === "steer"
        ? runtime.steer(prompt, nativeAttachments)
        : runtime.followUp(prompt, nativeAttachments);
      await this.state.setSelectedSession(projectId, snapshot.info.sessionId);
      return {
        sessionId: snapshot.info.sessionId,
        runId: queued.runId,
        messageId: queued.messageId
      };
    }
    // 目标会话不是运行时当前会话时需要切过去，但只能在完全空闲时切。
    if (sessionId && runtime.getSnapshot().info.sessionId !== sessionId) {
      snapshot = runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) {
        throw new Error("The selected session is still running. Return to it or stop the task before resuming another session.");
      }
      await runtime.resumeSession(sessionId);
    }
    const info = runtime.getSnapshot().info;
    const prompt = withAttachmentReferences(input, attachments);
    const project = this.projects.requireProject(projectId);
    const nativeAttachments = await loadNativeAttachments(this.projects.attachmentsRoot(project), attachments);
    const submitted = runtime.submitPrompt(prompt, mode, nativeAttachments);
    await this.state.setSelectedSession(projectId, info.sessionId);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId: info.sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  async resumeInterruptedTurn(projectId: string, sessionId: string): Promise<DesktopRunReceipt | undefined> {
    const { runtime } = await this.ensureRuntime(projectId);
    const snapshot = runtime.getSnapshot();
    if (snapshot.info.sessionId !== sessionId) {
      if (runtimeIsBusy(snapshot)) throw new Error("当前项目仍有另一条会话正在运行，请先停止任务。");
      await runtime.resumeSession(sessionId);
    }
    const submitted = await runtime.startInterruptedTurn();
    if (!submitted) return undefined;
    await this.state.setSelectedSession(projectId, sessionId);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  /**
   * 编辑并重发某条用户消息。
   *
   * 做法是分叉出一个只保留该消息之前内容的新会话，再在新会话里发送新消息，原会话保持不变。
   * 因此必须先取消当前运行、等它真正结束、销毁旧运行时，否则旧运行时还会往老会话里写事件。
   */
  async editPrompt(
    projectId: string,
    sessionId: string,
    userMessageIndex: number,
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[]
  ): Promise<DesktopRunReceipt> {
    const managed = await this.ensureRuntime(projectId);
    const { runtime } = managed;
    if (runtime.getSnapshot().info.sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) {
        throw new Error("当前项目仍有其他会话正在运行，请先停止后再编辑消息。");
      }
      await runtime.resumeSession(sessionId);
    }
    const snapshot = runtime.getSnapshot();
    if (runtimeIsBusy(snapshot)) {
      runtime.cancelCurrentRun();
      await runtime.waitForIdle();
    }
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.forkSessionAtUserMessage(project, sessionId, userMessageIndex);
    await this.state.setSelectedSession(projectId, targetSessionId);
    this.runtimeErrors.delete(projectId);

    let nextRuntime: InteractiveRuntimeHandle;
    if (runtime instanceof RuntimeHostClient) {
      await runtime.restartRuntime(targetSessionId);
      nextRuntime = runtime;
    } else {
      await this.disposeRuntime(projectId);
      nextRuntime = (await this.ensureRuntime(projectId)).runtime;
    }
    const info = nextRuntime.getSnapshot().info;
    const prompt = withAttachmentReferences(input, attachments);
    const nativeAttachments = await loadNativeAttachments(this.projects.attachmentsRoot(project), attachments);
    const submitted = nextRuntime.submitPrompt(prompt, mode, nativeAttachments);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId: info.sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  async cancelRun(projectId: string, runId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) throw new Error("Project runtime is not active.");
    if (runtime instanceof RuntimeHostClient) {
      const result = await runtime.cancelRunRequest(runId);
      if (!result.accepted) throw new Error(result.reason ?? "Runtime Host did not accept cancellation.");
      return;
    }
    if (!runtime.cancelRun(runId)) throw new Error(`Run ${runId} is not active.`);
  }

  async resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void> {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) throw new Error("Project runtime is not active.");
    runtime.answerPermission(requestId, result);
  }

  async setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) {
      await runtime.runExclusiveOperation(
        "permission",
        async () => await commands.agent.setPermissionMode(mode)
      );
    } else {
      await requireRemoteRuntime(runtime).setPermissionMode(mode);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) {
      return await runtime.runExclusiveOperation(
        "switch_model",
        async () => await commands.agent.switchModel(alias, thinking)
      );
    }
    return await requireRemoteRuntime(runtime).switchModel(alias, thinking);
  }

  async startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult> {
    this.projects.requireProject(projectId);
    return await this.modelLogin.start(provider);
  }

  async completeModelLogin(
    projectId: string,
    provider: DesktopModelLoginProvider,
    authRequestId: string,
    pastedAuthorization?: string
  ): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const authenticated = await this.modelLogin.complete(provider, authRequestId, pastedAuthorization);
    const current = await this.loadProjectConfig(projectId);
    const candidate = this.buildConfigWithAuthenticatedLogin(current, authenticated);
    const test = await this.testCandidate(candidate, candidate.defaultModel);
    if (!test.ok) throw new Error(`账号已授权，但模型验证失败：${test.message}`);
    await this.saveProjectConfig(projectId, candidate);
    this.runtimeErrors.delete(projectId);
    if (managed) await this.rebuildManagedRuntime(projectId, managed);
    return await this.workspaceSnapshot(projectId);
  }

  async cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void> {
    this.projects.requireProject(projectId);
    this.modelLogin.cancel(provider, authRequestId);
  }

  async saveModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const next = this.buildConfigWithModel(current, input);
    // 写入全局配置前先验证候选模型的 endpoint、协议和凭据；运行时切换还会再次经过
    // ModelManager 的同一校验，避免设置页和 TUI/CLI 产生两套可用性规则。
    if (input.makeDefault || next.defaultModel === input.alias) validateModelConfiguration(next, input.alias);
    await this.saveProjectConfig(projectId, next);
    this.runtimeErrors.delete(projectId);
    if (managed) await this.rebuildManagedRuntime(projectId, managed);
    return await this.workspaceSnapshot(projectId);
  }

  async removeModelConfiguration(projectId: string, alias: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const configuredAlias = resolveConfiguredModelAlias(current, alias);
    if (!configuredAlias) throw new Error(`未知模型：${alias}`);
    const projectSettings = await loadProjectSettings(this.projects.requireProject(projectId).path);
    if (projectSettings.defaultModel === configuredAlias) {
      throw new Error(`不能删除项目 .biny/settings.json 当前引用的模型：${configuredAlias}`);
    }
    const remaining = Object.entries(current.models).filter(([key]) => key !== configuredAlias);
    if (!remaining.length) throw new Error("至少需要保留一个可用模型。");
    const nextDefault = current.defaultModel === configuredAlias ? remaining[0]![0] : current.defaultModel;
    const next = configSchema.parse({
      ...current,
      defaultModel: nextDefault,
      models: Object.fromEntries(remaining)
    });
    await this.saveProjectConfig(projectId, next);
    this.runtimeErrors.delete(projectId);
    if (managed) await this.rebuildManagedRuntime(projectId, managed);
    return await this.workspaceSnapshot(projectId);
  }

  async webSearchSettings(projectId: string): Promise<DesktopWebSearchSettings> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    return describeWebSearchSettings(config.web.search);
  }

  async saveWebSearchSettings(projectId: string, input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改联网搜索配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    // 密钥槽位是各 provider 共用的：换 provider 时必须丢弃旧密钥和自定义 env 名，
    // 否则上一家的密钥会被原样发给新服务商，并遮蔽环境变量里的正确密钥。
    const sameProvider = input.provider === current.web.search.provider;
    const next = configSchema.parse({
      ...current,
      web: {
        ...current.web,
        search: {
          enabled: input.enabled,
          provider: input.provider,
          // undefined 保留同 provider 的已存密钥，空字符串表示清除。
          apiKey: input.apiKey === undefined ? (sameProvider ? current.web.search.apiKey : undefined) : input.apiKey || undefined,
          apiKeyEnv: sameProvider ? input.apiKeyEnv : undefined,
          timeoutMs: input.timeoutMs,
          maxResults: input.maxResults
        }
      }
    });
    await this.saveProjectConfig(projectId, next);
    // 工具注册表在 runtime 装配时读取搜索配置，关闭后下次使用即按新配置重建。
    if (managed) await this.rebuildManagedRuntime(projectId, managed);
    return describeWebSearchSettings(next.web.search);
  }

  /** 个性化总览：全局设置读取真实 global config，聊天有效值由当前 runtime 统一解析。 */
  async personalizationOverview(projectId: string, sessionId?: string): Promise<DesktopPersonalizationOverview> {
    this.projects.requireProject(projectId);
    const state = sessionId === undefined
      ? await this.currentPersonalizationState(projectId)
      : await this.personalizationState(projectId, sessionId);
    return describePersonalizationOverview(state, sessionId);
  }

  async savePersonalizationSettings(
    projectId: string,
    input: DesktopPersonalizationSettingsInput
  ): Promise<DesktopPersonalizationOverview> {
    this.projects.requireProject(projectId);
    const state = await this.updateGlobalPersonalization(projectId, {
      personalization: input.settings,
      memory: input.memory
    }, input.expectedRevision);
    return describePersonalizationOverview(state);
  }

  async saveChatPersonalization(
    projectId: string,
    sessionId: string,
    input: DesktopChatPersonalizationOverride,
    expectedRevision: string
  ): Promise<DesktopWorkspaceSnapshot> {
    const managed = await this.runtimeForSession(projectId, sessionId, "任务运行期间不能修改当前聊天的个性化设置。");
    if (managed.commands) {
      await managed.commands.agent.updateChatPersonalization(input, expectedRevision);
    } else {
      await requireRemoteRuntime(managed.runtime).updateChatPersonalization(input, expectedRevision);
    }
    return await this.workspaceSnapshot(projectId);
  }

  /** 当前 scope 的 store 条目与 revision；策略始终来自全局 versioned config。 */
  async memoryOverview(projectId: string, scope: DesktopMemoryScope): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const [personalization, store] = await Promise.all([
      this.currentPersonalizationState(projectId),
      this.readMemoryStore(projectId, scope)
    ]);
    const entries = store.entries.entries.filter((entry) => entry.scope === scope);
    const topicCounts = new Map<string, number>();
    for (const entry of entries) topicCounts.set(entry.topic, (topicCounts.get(entry.topic) ?? 0) + 1);
    return {
      scope,
      configRevision: requireConfigRevision(personalization),
      // listStoredEntries 的 entries 与 revision 来自同一份 scope 快照；overview 可能在
      // 另一进程并发写入时更新得更早或更晚，不能拿它的 revision 给这批条目做 CAS。
      revision: store.entries.revision[scope],
      settings: { ...personalization.memory },
      totalEntries: entries.length,
      topics: [...topicCounts.entries()].map(([topic, count]) => ({ topic, entries: count })),
      entries
    };
  }

  async saveMemorySettings(projectId: string, input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot> {
    this.projects.requireProject(projectId);
    const state = await this.updateGlobalPersonalization(
      projectId,
      { memory: input.settings },
      input.expectedRevision
    );
    return { configRevision: requireConfigRevision(state), settings: { ...state.memory } };
  }

  async searchMemory(projectId: string, scope: DesktopMemoryScope, query: string): Promise<DesktopMemorySearchMatch[]> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const result = commands
      ? await runtime.runExclusiveOperation(
        "memory",
        async () => await requireLocalMemory(commands).searchScoped(query, [], { scopes: [scope], limit: 8 })
      )
      : await requireRemoteRuntime(runtime).memory<MemorySearchResult>("search-v2", { scope, query });
    return result.matches.map((match) => ({
      id: match.entry.id,
      scope: match.entry.scope,
      topic: match.topic,
      kind: match.entry.kind,
      lineage: match.entry.lineage,
      importance: match.entry.importance,
      createdAt: match.entry.createdAt,
      updatedAt: match.entry.updatedAt,
      path: match.path,
      excerpt: match.excerpt,
      score: match.score
    }));
  }

  async addMemoryEntry(
    projectId: string,
    scope: DesktopMemoryScope,
    input: DesktopMemoryEntryInput,
    expectedRevision: number
  ): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const sessionId = this.state.selectedSessionId(projectId);
    const entry = {
      scope,
      kind: input.kind,
      topic: input.topic,
      title: input.note.split("\n", 1)[0]?.slice(0, 120) || "手动记忆",
      summary: input.note,
      importance: input.importance,
      lineage: {
        source: "explicit" as const,
        externalContext: false,
        sessionId,
        userEvidence: input.note
      }
    };
    const result = commands
      ? await runtime.runExclusiveOperation(
        "memory",
        async () => await requireLocalMemory(commands).writeScoped(entry, { expectedRevision })
      )
      : await requireRemoteRuntime(runtime).memory<{ written: boolean; path?: string }>("write-v2", { entry, expectedRevision });
    if (!result.written) {
      throw new Error(result.path ? "已存在等价的记忆条目，未重复保存。" : "内容太短，至少需要 20 个字符才能作为持久记忆。");
    }
    return await this.memoryOverview(projectId, scope);
  }

  async deleteMemoryEntry(
    projectId: string,
    scope: DesktopMemoryScope,
    entryId: string,
    expectedRevision: number
  ): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const result = commands
      ? await runtime.runExclusiveOperation(
        "memory",
        async () => await requireLocalMemory(commands).deleteStoredEntry(scope, entryId, { expectedRevision })
      )
      : await requireRemoteRuntime(runtime).memory<{ deleted: boolean }>("delete-v2", { scope, id: entryId, expectedRevision });
    if (!result.deleted) throw new Error("未找到该记忆条目，可能已被删除。");
    return await this.memoryOverview(projectId, scope);
  }

  async clearMemory(projectId: string, scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) {
      await runtime.runExclusiveOperation(
        "memory",
        async () => await requireLocalMemory(commands).clearScope(scope, { expectedRevision })
      );
    } else {
      await requireRemoteRuntime(runtime).memory("clear-v2", { scope, expectedRevision });
    }
    return await this.memoryOverview(projectId, scope);
  }

  async compactMemory(
    projectId: string,
    scope: DesktopMemoryScope,
    expectedRevision: number
  ): Promise<DesktopMemoryCompactionResult> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    return commands
      ? await runtime.runExclusiveOperation(
        "memory",
        async () => await requireLocalMemory(commands).consolidateScope(scope, { expectedRevision })
      )
      : await requireRemoteRuntime(runtime).memory<DesktopMemoryCompactionResult>("consolidate-v2", { scope, expectedRevision });
  }

  /**
   * 拉取服务商的实时模型目录。离线或鉴权失效时不向界面抛错，而是返回上次成功缓存的目录；
   * 静态内置目录仍由渲染层合并，避免一次网络故障让模型选择器变空。
   */
  async fetchModelCatalog(projectId: string, providerAlias: string): Promise<DesktopModelCatalogResult> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    const provider = config.providers[providerAlias];
    if (!provider) throw new Error(`未找到服务商配置：${providerAlias}`);
    const fetchedAt = new Date().toISOString();
    const catalogs = await restoreProviderCatalogs(Object.keys(config.providers), this.modelsStore);
    const runtime = new ModelRuntime(config, catalogs, undefined, this.modelsStore);
    try {
      const models = await runtime.refreshModels(providerAlias);
      return { providerAlias, source: "fetched", fetchedAt, models };
    } catch {
      const models = catalogs.find(([alias]) => alias === providerAlias)?.[1] ?? [];
      return { providerAlias, source: "fallback", fetchedAt, models };
    }
  }

  async testModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> {
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const candidate = this.buildConfigWithModel(current, input);
    return await this.testCandidate(candidate, input.alias);
  }

  private async testCandidate(candidate: AgentConfig, alias: string): Promise<DesktopModelConnectionTestResult> {
    const model = candidate.models[alias];
    if (!model) return { ok: false, message: `未知模型：${alias}` };
    const provider = candidate.providers[model.provider];
    if (!provider) {
      return { ok: false, message: `未找到服务商配置：${model.provider}` };
    }
    const profile = providerDefinition(provider.type);
    const envName = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const hasKey = Boolean(provider.apiKey || (envName && process.env[envName]));
    if ((provider.requiresApiKey ?? profile.requiresApiKey) && !hasKey) {
      return { ok: false, message: envName ? `缺少 API Key。请填写密钥，或设置环境变量 ${envName}。` : "缺少 API Key。请先填写密钥后再测试。" };
    }
    const started = Date.now();
    try {
      const settings = createNativeModelSettings(candidate, alias);
      let providerError: string | undefined;
      for await (const event of await settings.model.stream({
        messages: [{ role: "user", content: "ping" }],
        tools: []
      }, {
        maxOutputTokens: 16,
        reasoning: settings.reasoning,
        providerOptions: settings.providerOptions,
        timeoutMs: settings.timeoutMs
      })) {
        if (event.type === "error") providerError = event.error instanceof Error ? event.error.message : String(event.error);
      }
      if (providerError) throw new Error(providerError);
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        message: `连接成功 · ${String(latencyMs)}ms`,
        latencyMs
      };
    } catch (error) {
      return {
        ok: false,
        message: formatModelConnectionError(error),
        latencyMs: Date.now() - started
      };
    }
  }

  private buildConfigWithModel(current: AgentConfig, input: DesktopModelConfigurationInput): AgentConfig {
    const existingProvider = current.providers[input.providerAlias];
    const profile = providerDefinition(input.providerType);
    const sameProvider = existingProvider?.type === input.providerType;
    const provider = {
      type: input.providerType,
      protocol: input.protocol,
      baseUrl: input.baseUrl ?? existingProvider?.baseUrl ?? profile.baseUrl,
      apiKey: input.apiKey ?? existingProvider?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existingProvider?.apiKeyEnv ?? profile.apiKeyEnv,
      requiresApiKey: input.requiresApiKey,
      authMode: existingProvider?.authMode,
      oauth: existingProvider?.oauth,
      timeoutMs: sameProvider ? existingProvider.timeoutMs : undefined,
      retry: sameProvider ? existingProvider.retry : undefined,
      modelsEndpoint: sameProvider ? existingProvider.modelsEndpoint : undefined,
      headers: sameProvider ? existingProvider.headers : undefined,
      apiBackend: sameProvider ? existingProvider.apiBackend : undefined,
      compatibility: sameProvider ? existingProvider.compatibility : undefined
    };
    const existingModel = current.models[input.alias];
    const sameModel = existingModel?.provider === input.providerAlias && existingModel.model === input.model;
    const models = Object.fromEntries(Object.entries(current.models).filter(([alias, model]) => (
      alias === input.alias || model.provider !== input.providerAlias || model.model !== input.model
    )));
    // Enabling an extra model, rotating a key or editing a base URL must not
    // silently hijack the active default — only an explicit connect does, and
    // the de-dup above can still strip the previous default out from under us.
    const keepsCurrentDefault = input.alias === current.defaultModel || Boolean(models[current.defaultModel]);
    const defaultModel = input.makeDefault || !keepsCurrentDefault ? input.alias : current.defaultModel;
    const parsed = configSchema.parse({
      ...current,
      defaultModel,
      providers: { ...current.providers, [input.providerAlias]: provider },
      models: {
        ...models,
        [input.alias]: {
          provider: input.providerAlias,
          model: input.model,
          displayName: input.displayName,
          supportsTools: input.supportsTools,
          capabilities: {
            tools: input.supportsTools,
            reasoning: input.supportsThinking,
            parallelToolCalls: input.parallelToolCalls,
            reasoningStream: input.reasoningStream,
            reasoningSummary: input.reasoningSummary,
            vision: input.supportsVision,
            audio: input.supportsAudio
          },
          // 目录元数据只参与当前运行时解析，不自动写成用户覆盖；已有同模型配置中的
          // 限制字段则继续保留，用户可以在 config.json 中显式维护它们。
          contextWindow: sameModel ? existingModel.contextWindow : undefined,
          maxInputTokens: sameModel ? existingModel.maxInputTokens : undefined,
          maxOutputTokens: sameModel ? existingModel.maxOutputTokens : undefined,
          limits: sameModel ? existingModel.limits : undefined,
          apiBackend: input.apiBackend,
          baseUrl: sameModel ? existingModel.baseUrl : undefined,
          headers: sameModel ? existingModel.headers : undefined,
          thinkingLevelMap: input.thinkingLevelMap,
          compatibility: input.compatibility ?? (sameModel ? existingModel.compatibility : undefined),
          pricing: sameModel ? existingModel.pricing : undefined
        }
      },
      // Thinking is validated against the *default* model, so it only has to be
      // reset when the default actually moves to a freshly configured model.
      thinking: defaultModel === current.defaultModel ? current.thinking : { enabled: false, effort: current.thinking.effort }
    });
    return parsed;
  }

  async compact(projectId: string, hint?: string): Promise<string> {
    return await (await this.ensureRuntime(projectId)).runtime.compactConversation(hint);
  }

  /**
   * 桌面端斜杠命令。报告类命令直接读 runtime 状态，不产生会话消息；
   * `/subagent <task>` 与 `/review` 会实际派发一个子代理任务（权限档位随会话权限推导，
   * 与 TUI 相同），结果同样只进弹层、不写入会话。
   */
  async runSlashCommand(projectId: string, sessionId: string | undefined, input: string): Promise<DesktopSlashResult> {
    await this.requireConfiguredModel(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    // /status、/usage 依赖当前会话：用户查看的会话与 runtime 不一致且空闲时先切换。
    if (sessionId && runtime.getSnapshot().info.sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (!runtimeIsBusy(snapshot)) await runtime.resumeSession(sessionId);
    }
    const result = commands
      ? await executeRuntimeCommand(runtime, commands, input, "desktop")
      : await requireRemoteRuntime(runtime).executeCommand(input, "desktop");
    if (!result) throw new Error(`未知命令：${input.trim().split(/\s+/, 1)[0] ?? input}`);
    return result;
  }

  async runtimeProjection(projectId: string): Promise<DesktopRuntimeProjection> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) {
      return {
        tasks: commands.taskRuns.list(),
        automations: commands.automationStore.list(),
        pendingFires: commands.automationStore.listPending(),
        goals: commands.graphs.listGoals(),
        graphs: commands.graphs.listGraphs(),
        capabilities: commands.capabilities.list()
      };
    }
    const remote = requireRemoteRuntime(runtime);
    const [tasks, automations, pendingFires, goals, graphs, capabilities] = await Promise.all([
      remote.taskList(),
      remote.automationList(),
      remote.automationPending(),
      remote.goalList(),
      remote.graphList(),
      remote.capabilityList()
    ]);
    return { tasks, automations, pendingFires, goals, graphs, capabilities };
  }

  async runtimeEvents(projectId: string, afterSequence?: number, limit?: number): Promise<unknown> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) return commands.runtimeAuthority.readEvents({ afterSequence, limit });
    return await requireRemoteRuntime(runtime).subscribeRuntimeEvents({ afterSequence, limit });
  }

  async runtimeMutation(projectId: string, operation: DesktopRuntimeMutation, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { runtime, commands, host } = await this.ensureRuntime(projectId);
    if (!commands) return await executeRemoteRuntimeMutation(requireRemoteRuntime(runtime), operation, payload);
    if (operation === "task.create") return commands.taskRuns.create({ task: payload.task, sessionId: optionalPayloadString(payload.sessionId), parentRunId: optionalPayloadString(payload.parentRunId) });
    if (operation === "task.start") throw new Error("TaskRun start is unavailable until a TaskRun execution adapter is attached; use an explicit AgentRun, Automation, or Graph entrypoint.");
    if (operation === "task.cancel") {
      const taskRunId = requiredPayloadString(payload.taskRunId, "taskRunId");
      const reason = optionalPayloadString(payload.reason) ?? "TaskRun cancelled.";
      const task = commands.taskRuns.get(taskRunId);
      const subagent = commands.subagents?.getSnapshot(taskRunId);
      const cancelledSubagent = commands.subagents?.cancelTask(taskRunId, reason) ?? false;
      const runId = task?.attempts.at(-1)?.runId;
      if (runId !== undefined) runtime.cancelRun(runId);
      const subagentActive = subagent !== undefined && !["completed", "failed", "aborted", "timed_out"].includes(subagent.status);
      if (subagentActive && !cancelledSubagent && !isTaskRunTerminal(task?.status ?? "created")) {
        throw new Error(`Unable to cancel active subagent task ${taskRunId}.`);
      }
      if (task !== undefined) {
        const current = commands.taskRuns.get(taskRunId);
        if (!current) throw new Error(`TaskRun ${taskRunId} does not exist.`);
        if (isTaskRunTerminal(current.status)) return current;
        return commands.taskRuns.transition(taskRunId, "cancelled");
      }
      throw new Error(`TaskRun ${taskRunId} does not exist.`);
    }
    if (operation === "task.approve") throw new Error("TaskRun approval cannot start execution without an attached TaskRun execution adapter.");
    if (operation === "task.retry") {
      const taskRunId = requiredPayloadString(payload.taskRunId, "taskRunId");
      const decision = evaluateTaskRetry(commands.taskRuns.get(taskRunId));
      if (!decision.allowed) throw new Error(`Task retry rejected (${decision.code}): ${decision.reason}`);
      throw new Error(`Task retry admitted for ${decision.failureClass}, but no TaskRun execution adapter is attached; refusing to mark the task running without starting a new AgentRun.`);
    }
    if (operation === "task.resume") throw new Error("TaskRun resume requires an explicit safe-boundary continuation admission; it cannot be inferred from a TaskRun status.");
    if (operation === "automation.create") return commands.automationStore.create(payload as unknown as AutomationCreateInput);
    if (operation === "automation.pause") return commands.automationStore.pause(requiredPayloadString(payload.automationId, "automationId"));
    if (operation === "automation.resume") return commands.automationStore.resume(requiredPayloadString(payload.automationId, "automationId"));
    if (operation === "automation.delete") {
      commands.automationStore.delete(requiredPayloadString(payload.automationId, "automationId"));
      return undefined;
    }
    if (operation === "automation.run") {
      if (!host) throw new Error("Automation scheduler is unavailable.");
      return await host.runAutomation(requiredPayloadString(payload.automationId, "automationId"));
    }
    if (operation === "goal.create") return commands.graphs.createGoal(requiredPayloadString(payload.title, "title"), payload.payload, optionalPayloadString(payload.goalId));
    if (operation === "goal.pause") return commands.graphs.updateGoal(requiredPayloadString(payload.goalId, "goalId"), "paused");
    if (operation === "goal.resume") return commands.graphs.updateGoal(requiredPayloadString(payload.goalId, "goalId"), "active");
    if (operation === "goal.cancel") return commands.graphs.updateGoal(requiredPayloadString(payload.goalId, "goalId"), "cancelled");
    if (operation === "graph.create") return commands.graphs.createGraph(optionalPayloadString(payload.goalId), (payload.nodes ?? []) as GraphNodeInput[], payload.payload, optionalPayloadString(payload.graphId));
    if (operation === "graph.start") {
      const graph = commands.graphs.startGraph(requiredPayloadString(payload.graphId, "graphId"));
      commands.graphs.createWake(graph.graphId, "graph_started");
      return graph;
    }
    if (operation === "graph.pause") return commands.graphs.pauseGraph(requiredPayloadString(payload.graphId, "graphId"));
    if (operation === "graph.resume") {
      const graph = commands.graphs.resumeGraph(requiredPayloadString(payload.graphId, "graphId"));
      commands.graphs.createWake(graph.graphId, "graph_resumed");
      return graph;
    }
    if (operation === "graph.cancel") {
      const graphId = requiredPayloadString(payload.graphId, "graphId");
      const graph = commands.graphs.inspectGraph(graphId);
      const activeRuns = graph.nodes
        .filter((node) => node.status === "running" && node.taskRunId !== undefined)
        .map((node) => ({
          taskRunId: node.taskRunId!,
          runId: commands.taskRuns.get(node.taskRunId!)?.attempts.at(-1)?.runId
        }));
      const result = commands.graphs.cancelGraph(graphId);
      for (const active of activeRuns) {
        commands.subagents?.cancelTask(active.taskRunId, "Graph cancelled.");
        if (active.runId !== undefined) runtime.cancelRun(active.runId);
        try {
          const task = commands.taskRuns.get(active.taskRunId);
          if (task && !isTaskRunTerminal(task.status)) commands.taskRuns.transition(active.taskRunId, "cancelled");
        } catch {
          // Graph cancellation is already durable; late AgentRun results are ignored by the store.
        }
      }
      return result;
    }
    if (operation === "capability.register") return commands.capabilities.register({ ...(payload as { ownerType: "host" | "client"; ownerId: string; capabilityName: string; schema: unknown }), ownerId: optionalPayloadString(payload.ownerId) ?? "desktop-" + process.pid });
    if (operation === "capability.replace") return commands.capabilities.replace(requiredPayloadString(payload.registrationId, "registrationId"), payload.schema, optionalPayloadString(payload.expiresAt));
    if (operation === "capability.admit") return commands.capabilities.admit(requiredPayloadString(payload.registrationId, "registrationId"));
    if (operation === "capability.reject") return commands.capabilities.reject(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason) ?? "rejected");
    if (operation === "capability.release") return commands.capabilities.release(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason) ?? "released");
    if (operation === "capability.invoke") return commands.capabilities.invoke(payload as never);
    if (operation === "capability.accept") return commands.capabilities.accept(requiredPayloadString(payload.invocationId, "invocationId"));
    if (operation === "capability.start") return commands.capabilities.start(requiredPayloadString(payload.invocationId, "invocationId"));
    if (operation === "capability.result") return commands.capabilities.result(requiredPayloadString(payload.invocationId, "invocationId"), payload.result);
    if (operation === "capability.chunk") return commands.capabilities.chunk(requiredPayloadString(payload.invocationId, "invocationId"), Number(payload.chunkIndex), payload.data, payload.final === true);
    if (operation === "capability.fail") return commands.capabilities.fail(requiredPayloadString(payload.invocationId, "invocationId"), optionalPayloadString(payload.error) ?? "capability failed");
    if (operation === "capability.cancel") return commands.capabilities.cancel(requiredPayloadString(payload.invocationId, "invocationId"), optionalPayloadString(payload.reason) ?? "capability cancelled");
    throw new Error(`Unsupported desktop runtime mutation: ${operation}`);
  }

  async duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.duplicateSession(project, sessionId);
    await this.state.setSelectedSession(projectId, targetSessionId);
    return await this.workspaceSnapshot(projectId);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed?.runtime.getSnapshot().info.sessionId === sessionId) {
      const snapshot = managed.runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) throw new Error("Stop the running task before deleting this session.");
      if (managed.runtime instanceof RuntimeHostClient) {
        // 先让 owner 切到新会话，再删除旧文件，避免 detached host 继续持有已删除 JSONL。
        await managed.runtime.restartRuntime();
      } else {
        await this.closeManagedRuntime(managed);
        this.runtimes.delete(projectId);
      }
    }
    await this.projects.deleteSession(this.projects.requireProject(projectId), sessionId);
    if (this.state.selectedSessionId(projectId) === sessionId) {
      await this.state.setSelectedSession(projectId, undefined);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async disposeProject(projectId: string): Promise<void> {
    const managed = this.runtimes.get(projectId);
    if (!managed) return;
    await this.closeManagedRuntime(managed);
    this.runtimes.delete(projectId);
  }

  /** 关窗前用它决定要不要提示用户：等待权限也算「在跑」，直接关掉会丢掉这次询问。 */
  hasRunningTasks(): boolean {
    return [...this.runtimes.values()].some(({ runtime }) => {
      return runtimeIsBusy(runtime.getSnapshot());
    });
  }

  isProjectRunning(projectId: string): boolean {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) return false;
    return runtimeIsBusy(runtime.getSnapshot());
  }

  cancelAll(): void {
    for (const { runtime } of this.runtimes.values()) runtime.cancelCurrentRun();
  }

  /**
   * Desktop 显式停止/退出时，必须先让取消请求到达 remote Host 并等待快照收敛。
   * 超时只是不再阻塞窗口关闭；本次 Desktop 自己启动的 owner 会在 closeAll 中被回收。
   */
  async stopAllForExit(timeoutMs = 2_500): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async ({ runtime }) => {
      const deadline = Date.now() + timeoutMs;
      const run = activeRun(runtime.getSnapshot());
      if (run && runtime instanceof RuntimeHostClient) {
        await waitForRuntimeOperation(runtime.cancelRunRequest(run.runId), remainingTimeout(deadline));
      } else if (run) {
        runtime.cancelRun(run.runId);
      } else {
        runtime.cancelCurrentRun();
      }
      await waitForRuntimeIdle(runtime, remainingTimeout(deadline));
    }));
  }

  /**
   * 退出前收尾。先置 `closing` 挡住新的创建请求，再等正在初始化的运行时结束（否则它们会
   * 在关闭之后才注册进来，成为泄漏的运行时），最后统一取消订阅并关闭。
   */
  async closeAll(options: { terminateOwnedHosts?: boolean } = {}): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.runtimeInitializations.values());
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(managedRuntimes.map(async (managed) => await this.closeManagedRuntime(managed, options)));
  }

  private async disposeRuntime(projectId: string): Promise<void> {
    const managed = this.runtimes.get(projectId);
    if (!managed) return;
    await this.closeManagedRuntime(managed);
    this.runtimes.delete(projectId);
  }

  /** 配置变更需要 owner 重建 CommandRuntime；远端 client 通过 Host RPC 完成同一件事。 */
  private async rebuildManagedRuntime(projectId: string, managed: ManagedRuntime): Promise<void> {
    if (managed.runtime instanceof RuntimeHostClient) {
      await managed.runtime.restartRuntime();
      return;
    }
    await this.closeManagedRuntime(managed);
    this.runtimes.delete(projectId);
  }

  private async closeManagedRuntime(
    managed: ManagedRuntime,
    options: { terminateOwnedHosts?: boolean } = {}
  ): Promise<void> {
    managed.unsubscribe();
    await managed.host?.close();
    await managed.runtime.close();
    if (options.terminateOwnedHosts) await terminateOwnedHost(managed.spawnedHost);
  }

  /**
   * 取得项目运行时，没有就创建。并发调用会复用同一个初始化 promise，避免同一项目被初始化两次
   * （两个运行时抢同一份 session 和运行锁）。
   */
  private async ensureRuntime(projectId: string): Promise<ManagedRuntime> {
    if (this.closing) throw new Error("Desktop runtime is shutting down.");
    const current = this.runtimes.get(projectId);
    if (current) return current;
    const pending = this.runtimeInitializations.get(projectId);
    if (pending) return await pending;
    const initialization = this.initializeRuntime(projectId);
    this.runtimeInitializations.set(projectId, initialization);
    try {
      return await initialization;
    } catch (error) {
      const message = formatRuntimeInitializationError(error);
      this.runtimeErrors.set(projectId, message);
      if (error instanceof SessionLeaseError) throw new Error(message);
      throw error;
    } finally {
      if (this.runtimeInitializations.get(projectId) === initialization) this.runtimeInitializations.delete(projectId);
    }
  }

  private observeRunCompletion(projectId: string, completion: Promise<AgentRunOutcome>): void {
    void completion.then(
      (outcome) => {
        // 正常的终态结果通过 AgentHostEvent 呈现，这里不重复上报；
        // 只有真正跑成功了才清掉之前记下的初始化错误。
        if (outcome.status === "completed") this.runtimeErrors.delete(projectId);
      },
      (error: unknown) => {
        this.runtimeErrors.set(projectId, error instanceof Error ? error.message : String(error));
      }
    );
  }

  private async initializeRuntime(projectId: string): Promise<ManagedRuntime> {
    const project = this.projects.requireProject(projectId);
    if (project.missing) throw new Error(`Project path is unavailable: ${project.path}`);
    // session 走全局项目目录，附件仍在项目 `.biny`；三端通过同一个 workspace 定位同一份历史。
    const persistenceRoot = await this.projects.dataRoot(project);
    let runtime: InteractiveRuntimeHandle;
    let commands: CommandRuntime | undefined;
    let host: RuntimeHostServer | undefined;
    let attached: RuntimeHostClient | undefined;
    let spawnedHost: ChildProcess | undefined;
    try {
      const connected = await connectOrSpawnRuntimeHostWithOwnership(persistenceRoot, {
        workspaceRoot: project.path,
        configDir: globalConfigDir(),
        attachmentRoot: this.projects.attachmentsRoot(project),
        // Desktop 启动本身不是恢复动作；只有用户打开会话或发送新消息时才选择 session。
        sessionId: undefined,
        resumeInterrupted: false,
        clientId: `desktop-${process.pid}`,
        surface: "desktop"
      });
      attached = connected?.client;
      spawnedHost = connected?.spawnedProcess;
    } catch {
      // 独立 Host 不是可用配置时，保留同进程 owner fallback，并让下面的真实初始化给出错误。
      attached = undefined;
    }
    if (attached) {
      runtime = attached;
    } else {
      const createLocalRuntime: RuntimeHostFactory = async (sessionId?: string): Promise<InteractiveAgentHost> => {
        const local = await createInteractiveAgentHost(project.path, {
          persistenceRoot,
          configStore: this.configStore,
          attachmentRoot: this.projects.attachmentsRoot(project)
        });
        try {
          if (sessionId !== undefined) await local.runtime.resumeSession(sessionId);
          return local;
        } catch (error) {
          await local.runtime.close();
          throw error;
        }
      };
      const local = await createLocalRuntime(undefined);
      runtime = local.runtime;
      commands = local.commands;
    }
    if (commands) {
      try {
        const createLocalRuntime: RuntimeHostFactory = async (sessionId?: string): Promise<InteractiveAgentHost> => {
          const local = await createInteractiveAgentHost(project.path, {
            persistenceRoot,
            configStore: this.configStore,
            attachmentRoot: this.projects.attachmentsRoot(project)
          });
          try {
            if (sessionId !== undefined) await local.runtime.resumeSession(sessionId);
            return local;
          } catch (error) {
            await local.runtime.close();
            throw error;
          }
        };
        host = await startRuntimeHost(persistenceRoot, runtime, commands, {
          createRuntime: createLocalRuntime,
          resumeInterrupted: false
        });
      } catch (error) {
        // 两个入口同时启动时，只有抢到 Host lock 的一方创建 owner；另一方丢弃
        // 刚装配的本地 runtime，再接回已存在的 owner，避免第二份 AgentSession 抢写。
        await runtime.close();
        const retry = await connectOrSpawnRuntimeHostWithOwnership(persistenceRoot, {
          workspaceRoot: project.path,
          configDir: globalConfigDir(),
          attachmentRoot: this.projects.attachmentsRoot(project),
          sessionId: undefined,
          resumeInterrupted: false,
          clientId: `desktop-${process.pid}`,
          surface: "desktop"
        });
        if (!retry) throw error;
        runtime = retry.client;
        spawnedHost = retry.spawnedProcess;
        commands = undefined;
      }
    }
    const unsubscribe = runtime.subscribe((update) => {
      const event = update.event;
      if (event) {
        const projectEvents = this.projectEvents(projectId);
        const sessionEvents = projectEvents.get(event.sessionId) ?? [];
        sessionEvents.push(event);
        // 实时事件只为「重新打开会话时补上本轮内容」，按会话保留最近 4000 条，防止长跑占满内存。
        if (sessionEvents.length > 4_000) sessionEvents.splice(0, sessionEvents.length - 4_000);
        projectEvents.set(event.sessionId, sessionEvents);
        if (isTerminalRunEvent(event) && this.state.selectedSessionId(projectId) !== event.sessionId) {
          void this.projects.updateSessionMetadata(project, event.sessionId, { unread: true }).catch(() => undefined);
        }
      }
      this.emit(projectId, update);
    });
    const managed: ManagedRuntime = { runtime, commands, host, spawnedHost, unsubscribe };
    this.runtimes.set(projectId, managed);
    this.runtimeErrors.delete(projectId);
    return managed;
  }

  private async requireConfiguredModel(projectId: string): Promise<void> {
    const config = await this.loadProjectConfig(projectId);
    if (!hasUsableModelConfiguration(config)) {
      throw new Error("请先在设置的“模型”中配置一个可用模型，再开始任务。");
    }
  }

  private async personalizationState(projectId: string, sessionId: string): Promise<AgentPersonalizationState> {
    const managed = await this.ensureRuntime(projectId);
    const snapshot = managed.runtime.getSnapshot();
    if (snapshot.info.sessionId !== sessionId) {
      if (runtimeIsBusy(snapshot)) {
        throw new Error("当前项目有其他聊天正在运行，暂时无法读取所选聊天的个性化覆盖。");
      }
      await managed.runtime.resumeSession(sessionId);
    }
    return await this.readManagedPersonalizationState(managed);
  }

  private async currentPersonalizationState(projectId: string): Promise<AgentPersonalizationState> {
    return await this.readManagedPersonalizationState(await this.ensureRuntime(projectId));
  }

  private async readManagedPersonalizationState(managed: ManagedRuntime): Promise<AgentPersonalizationState> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return managed.commands
          ? await managed.commands.agent.getPersonalizationState()
          : await requireRemoteRuntime(managed.runtime).getPersonalizationState();
      } catch (error) {
        lastError = error;
        // Host 启动时的记忆维护也会读取 config；loader 在校正文件权限时可能改变 ctime，
        // 让两个只读请求之一得到瞬时快照冲突。这里只重试明确的只读竞态，不重试写操作。
        if (attempt === 2 || !(error instanceof Error) || !error.message.includes("config.json changed while it was being read")) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async updateGlobalPersonalization(
    projectId: string,
    update: GlobalPersonalizationUpdate,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    const managed = await this.ensureRuntime(projectId);
    const commands = managed.commands;
    return commands
      ? await managed.runtime.runExclusiveOperation(
        "personalization",
        async () => await commands.agent.updateGlobalPersonalization(update, expectedRevision)
      )
      : await requireRemoteRuntime(managed.runtime).updateGlobalPersonalization(update, expectedRevision);
  }

  private async runtimeForSession(projectId: string, sessionId: string, busyMessage: string): Promise<ManagedRuntime> {
    const managed = await this.ensureRuntime(projectId);
    const snapshot = managed.runtime.getSnapshot();
    if (runtimeIsBusy(snapshot)) throw new Error(busyMessage);
    if (snapshot.info.sessionId !== sessionId) await managed.runtime.resumeSession(sessionId);
    return managed;
  }

  private async readMemoryStore(
    projectId: string,
    scope: DesktopMemoryScope
  ): Promise<{ overview: MemoryOverview; entries: MemoryEntriesResult }> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    if (commands) {
      return await runtime.runExclusiveOperation("memory", async () => {
        const memory = requireLocalMemory(commands);
        return {
          overview: await memory.getOverview(),
          entries: await memory.listStoredEntries({ scopes: [scope] })
        };
      });
    }
    return await requireRemoteRuntime(runtime).memory<{ overview: MemoryOverview; entries: MemoryEntriesResult }>(
      "overview-v2",
      { scope }
    );
  }

  private buildConfigWithAuthenticatedLogin(current: AgentConfig, authenticated: AuthenticatedModelLogin): AgentConfig {
    const providerAlias = authenticated.provider;
    const providerType = authenticated.provider === "claude-code" ? "claude-subscription" : "openai-codex";
    const profile = providerDefinition(providerType);
    const models = Object.fromEntries(Object.entries(current.models).filter(([, model]) => model.provider !== providerAlias));
    const configuredModels = authenticated.models.map((model) => {
      const alias = modelAliasForAuthenticatedModel(providerAlias, model.id);
      return [alias, {
        provider: providerAlias,
        model: model.id,
        displayName: model.displayName,
        supportsTools: true,
        capabilities: { tools: true, reasoning: model.supportsThinking }
      }] as const;
    });
    const defaultModel = configuredModels[0]?.[0];
    if (!defaultModel) throw new Error("账号没有返回可用模型。");
    const existingProvider = current.providers[providerAlias];
    return configSchema.parse({
      ...current,
      defaultModel,
      providers: {
        ...current.providers,
        [providerAlias]: {
          type: providerType,
          baseUrl: profile.baseUrl,
          apiKey: authenticated.accessToken,
          apiKeyEnv: undefined,
          authMode: "oauth-bearer",
          oauth: {
            provider: authenticated.provider,
            refreshToken: authenticated.refreshToken,
            expiresAt: authenticated.expiresAt,
            accountId: authenticated.accountId
          },
          timeoutMs: existingProvider?.timeoutMs
        }
      },
      models: { ...models, ...Object.fromEntries(configuredModels) },
      thinking: { enabled: false, effort: "high" }
    });
  }

  private async loadProjectConfig(projectId: string): Promise<AgentConfig> {
    return await this.configStore.load(this.projects.requireProject(projectId).path);
  }

  private async saveProjectConfig(projectId: string, config: AgentConfig): Promise<void> {
    await this.configStore.save(config, this.projects.requireProject(projectId).path);
  }

  private projectEvents(projectId: string): Map<string, AgentHostEvent[]> {
    const current = this.liveEvents.get(projectId);
    if (current) return current;
    const events = new Map<string, AgentHostEvent[]>();
    this.liveEvents.set(projectId, events);
    return events;
  }
}

function modelAliasForAuthenticatedModel(providerAlias: string, modelId: string): string {
  return `${providerAlias}-${modelId}`.replace(/[^a-z0-9.-]+/gi, "-");
}

function resolveConfiguredModelAlias(config: AgentConfig, aliasOrReference: string): string | undefined {
  if (config.models[aliasOrReference]) return aliasOrReference;
  const separator = aliasOrReference.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = aliasOrReference.slice(0, separator);
  const model = aliasOrReference.slice(separator + 1);
  return Object.entries(config.models).find(([, candidate]) => candidate.provider === provider && candidate.model === model)?.[0];
}

/**
 * Projects the saved provider configs into the credential/endpoint facts the
 * settings UI needs. Only presence is reported — an API key or refresh token
 * never crosses the IPC bridge.
 */
function describeWebSearchSettings(search: AgentConfig["web"]["search"]): DesktopWebSearchSettings {
  const envKeyName = search.provider === "duckduckgo" || search.provider === "google"
    ? undefined
    : search.apiKeyEnv ?? webSearchKeyEnvNames[search.provider];
  return {
    enabled: search.enabled,
    provider: search.provider,
    apiKeyEnv: search.apiKeyEnv,
    timeoutMs: search.timeoutMs,
    maxResults: search.maxResults,
    hasApiKey: Boolean(search.apiKey),
    envKeyName,
    envKeyDetected: Boolean(envKeyName && process.env[envKeyName])
  };
}

function describePersonalizationOverview(
  state: AgentPersonalizationState,
  sessionId?: string
): DesktopPersonalizationOverview {
  return {
    configRevision: requireConfigRevision(state),
    settings: { ...state.global },
    memory: { ...state.memory },
    chat: sessionId === undefined ? undefined : {
      sessionId,
      override: state.override,
      effective: {
        enabled: state.resolved.enabled,
        personality: state.resolved.personality,
        customInstructions: state.resolved.customInstructions,
        useMemories: state.resolved.useMemories,
        contributeMemories: state.resolved.contributeMemories
      },
      metadataRevision: state.catalogRevision
    }
  };
}

function requireConfigRevision(state: AgentPersonalizationState): string {
  if (!state.configRevision) throw new Error("当前配置存储没有返回 versioned CAS revision。");
  return state.configRevision;
}

function describeModelConnections(config: AgentConfig): DesktopModelConnection[] {
  return Object.entries(config.providers).map(([providerAlias, provider]) => {
    const profile = providerDefinition(provider.type);
    const apiKeyEnv = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const credentialSource = describeCredentialSource(provider, apiKeyEnv);
    return {
      providerAlias,
      providerType: provider.type,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl ?? profile.baseUrl,
      requiresApiKey: provider.requiresApiKey ?? profile.requiresApiKey,
      hasCredential: credentialSource !== undefined,
      credentialSource,
      apiKeyEnv,
      authMode: provider.authMode,
      oauthProvider: provider.oauth?.provider,
      oauthExpiresAt: provider.oauth?.expiresAt
    };
  });
}

function describeCredentialSource(provider: ProviderConfig, apiKeyEnv: string | undefined): "keychain" | "config" | "env" | undefined {
  if (provider.apiKey) return process.platform === "darwin" ? "keychain" : "config";
  if (apiKeyEnv && process.env[apiKeyEnv]) return "env";
  return undefined;
}

function requireLocalMemory(services: CommandRuntime) {
  return services.agent.getLocalMemory();
}

function requireRemoteRuntime(runtime: InteractiveRuntimeHandle): RuntimeHostClient {
  if (!(runtime instanceof RuntimeHostClient)) throw new Error("Remote runtime client is unavailable.");
  return runtime;
}

async function waitForRuntimeIdle(runtime: InteractiveRuntimeHandle, timeoutMs: number): Promise<void> {
  await waitForRuntimeOperation(runtime.waitForIdle(), timeoutMs);
}

async function waitForRuntimeOperation(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void operation.then(finish, finish);
  });
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** 只终止当前 Desktop 本次 spawn 的精确子进程，attach 到其它 surface 的 Host 不会走这里。 */
async function terminateOwnedHost(host: ChildProcess | undefined): Promise<void> {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.off("exit", finish);
      host.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2_500);
    host.once("exit", finish);
    host.once("error", finish);
    try {
      if (!host.kill("SIGTERM")) finish();
    } catch {
      finish();
    }
  });
}

async function executeRemoteRuntimeMutation(runtime: RuntimeHostClient, operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<unknown> {
  if (operation === "task.create") return await unwrapHostOperationResult(runtime.taskCreate({ task: payload.task, sessionId: optionalPayloadString(payload.sessionId), parentRunId: optionalPayloadString(payload.parentRunId) }));
  if (operation === "task.start") return await unwrapHostOperationResult(runtime.taskStart(requiredPayloadString(payload.taskRunId, "taskRunId"), { attemptId: optionalPayloadString(payload.attemptId), runId: optionalPayloadString(payload.runId), turnId: optionalPayloadString(payload.turnId), retrySafety: optionalPayloadString(payload.retrySafety) }));
  if (operation === "task.cancel") return await unwrapHostOperationResult(runtime.taskCancel(requiredPayloadString(payload.taskRunId, "taskRunId"), optionalPayloadString(payload.reason)));
  if (operation === "task.approve") return await unwrapHostOperationResult(runtime.taskApprove(requiredPayloadString(payload.taskRunId, "taskRunId")));
  if (operation === "task.resume") return await unwrapHostOperationResult(runtime.taskResume(requiredPayloadString(payload.taskRunId, "taskRunId"), { runId: optionalPayloadString(payload.runId), turnId: optionalPayloadString(payload.turnId), retrySafety: optionalPayloadString(payload.retrySafety) }));
  if (operation === "task.retry") return await unwrapHostOperationResult(runtime.taskRetry(requiredPayloadString(payload.taskRunId, "taskRunId")));
  if (operation === "automation.create") return await unwrapHostOperationResult(runtime.automationCreate(payload as unknown as AutomationCreateInput));
  if (operation === "automation.pause") return await unwrapHostOperationResult(runtime.automationPause(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.resume") return await unwrapHostOperationResult(runtime.automationResume(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.run") return await unwrapHostOperationResult(runtime.automationRun(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "automation.delete") return await unwrapHostOperationResult(runtime.automationDelete(requiredPayloadString(payload.automationId, "automationId")));
  if (operation === "goal.create") return await unwrapHostOperationResult(runtime.goalCreate(requiredPayloadString(payload.title, "title"), payload.payload, optionalPayloadString(payload.goalId)));
  if (operation === "goal.pause") return await unwrapHostOperationResult(runtime.goalPause(requiredPayloadString(payload.goalId, "goalId")));
  if (operation === "goal.resume") return await unwrapHostOperationResult(runtime.goalResume(requiredPayloadString(payload.goalId, "goalId")));
  if (operation === "goal.cancel") return await unwrapHostOperationResult(runtime.goalCancel(requiredPayloadString(payload.goalId, "goalId")));
  if (operation === "graph.create") return await unwrapHostOperationResult(runtime.graphCreate({ goalId: optionalPayloadString(payload.goalId), graphId: optionalPayloadString(payload.graphId), nodes: (payload.nodes ?? []) as GraphNodeInput[], payload: payload.payload }));
  if (operation === "graph.start") return await unwrapHostOperationResult(runtime.graphStart(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "graph.pause") return await unwrapHostOperationResult(runtime.graphPause(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "graph.resume") return await unwrapHostOperationResult(runtime.graphResume(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "graph.cancel") return await unwrapHostOperationResult(runtime.graphCancel(requiredPayloadString(payload.graphId, "graphId")));
  if (operation === "capability.register") return await unwrapHostOperationResult(runtime.capabilityRegister({ registrationId: optionalPayloadString(payload.registrationId), ownerType: payload.ownerType as "host" | "client", capabilityName: requiredPayloadString(payload.capabilityName, "capabilityName"), schema: payload.schema, expiresAt: optionalPayloadString(payload.expiresAt) }));
  if (operation === "capability.replace") return await unwrapHostOperationResult(runtime.capabilityReplace(requiredPayloadString(payload.registrationId, "registrationId"), payload.schema, optionalPayloadString(payload.expiresAt)));
  if (operation === "capability.admit") return await unwrapHostOperationResult(runtime.capabilityAdmit(requiredPayloadString(payload.registrationId, "registrationId")));
  if (operation === "capability.reject") return await unwrapHostOperationResult(runtime.capabilityReject(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason)));
  if (operation === "capability.release") return await unwrapHostOperationResult(runtime.capabilityRelease(requiredPayloadString(payload.registrationId, "registrationId"), optionalPayloadString(payload.reason)));
  if (operation === "capability.invoke") return await unwrapHostOperationResult(runtime.capabilityInvoke(payload as never));
  if (operation === "capability.accept") return await unwrapHostOperationResult(runtime.capabilityAccept(requiredPayloadString(payload.invocationId, "invocationId")));
  if (operation === "capability.start") return await unwrapHostOperationResult(runtime.capabilityStart(requiredPayloadString(payload.invocationId, "invocationId")));
  if (operation === "capability.result") return await unwrapHostOperationResult(runtime.capabilityResult(requiredPayloadString(payload.invocationId, "invocationId"), payload.result));
  if (operation === "capability.chunk") return await unwrapHostOperationResult(runtime.capabilityChunk(requiredPayloadString(payload.invocationId, "invocationId"), Number(payload.chunkIndex), payload.data, payload.final === true));
  if (operation === "capability.fail") return await unwrapHostOperationResult(runtime.capabilityFail(requiredPayloadString(payload.invocationId, "invocationId"), requiredPayloadString(payload.error, "error")));
  return await unwrapHostOperationResult(runtime.capabilityCancel(requiredPayloadString(payload.invocationId, "invocationId"), optionalPayloadString(payload.reason)));
}

async function unwrapHostOperationResult<T>(operation: Promise<HostOperationResult<T>>): Promise<T | undefined> {
  const result = await operation;
  if (!result.accepted) throw new Error(result.reason ?? "Runtime operation was rejected.");
  return result.result;
}

function requiredPayloadString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Desktop runtime field ${name} must be a non-empty string.`);
  return value;
}

function optionalPayloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatModelConnectionError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "未知错误");
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) parts.push(`鉴权失败（HTTP ${String(statusCode)}）`);
    else if (statusCode === 404) parts.push(`接口不存在（HTTP 404）`);
    else if (statusCode === 429) parts.push(`请求过于频繁（HTTP 429）`);
    else parts.push(`HTTP ${String(statusCode)}`);
  }
  const message = typeof record.message === "string" ? record.message.trim() : error instanceof Error ? error.message : String(error);
  if (message) parts.push(message);
  const responseBody = typeof record.responseBody === "string" ? record.responseBody.trim() : undefined;
  if (responseBody) {
    const compact = compactJsonError(responseBody);
    if (compact && !parts.some((part) => part.includes(compact))) parts.push(compact);
  }
  const url = typeof record.url === "string" ? record.url : undefined;
  if (url) parts.push(`请求：${url}`);
  const cause = record.cause;
  if (cause instanceof Error && cause.message && !parts.some((part) => part.includes(cause.message))) {
    parts.push(cause.message);
  }
  return parts.filter(Boolean).join(" · ") || "连接失败";
}

function formatRuntimeInitializationError(error: unknown): string {
  if (error instanceof SessionLeaseError) {
    return `当前项目正在被另一个 Biny/CLI 会话占用（进程 ${String(error.pid)}）。请先退出该会话，或切换到其他项目后重试。`;
  }
  return error instanceof Error ? error.message : String(error);
}

function compactJsonError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const detail = error as Record<string, unknown>;
      if (typeof detail.message === "string") return detail.message;
      if (typeof detail.msg === "string") return detail.msg;
    }
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.msg === "string") return parsed.msg;
  } catch {
    // fall through
  }
  const trimmed = body.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed || undefined;
}

async function loadNativeAttachments(root: string, attachments: DesktopAttachment[]): Promise<AgentAttachment[]> {
  const normalizedRoot = path.resolve(root);
  const native: AgentAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("audio/")) continue;
    const relative = attachment.path.replace(/^@attachments\//u, "");
    if (!relative || relative.includes("/") || relative.includes("\\")) continue;
    const filePath = path.resolve(normalizedRoot, relative);
    if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${path.sep}`)) continue;
    try {
      const bytes = await fs.readFile(filePath);
      native.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: attachment.path,
        size: attachment.size,
        data: bytes.toString("base64")
      });
    } catch {
      throw new Error(`附件文件不可读取：${attachment.name}`);
    }
  }
  return native;
}
