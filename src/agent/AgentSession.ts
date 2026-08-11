import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configSchema, type AgentConfig } from "../config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import {
  listModelChoices,
  modelRuntimeInfo,
  type ModelChoice,
  type ModelManager,
  type ModelRuntimeInfo,
  type ThinkingSelection
} from "../llm/ModelManager.js";
import { PermissionManager, type PermissionMode } from "../permission/PermissionManager.js";
import { runPermissionCommand } from "../permission/commands.js";
import { listSessionSummaries, parseSessionEvents, readSessionEvents, type SessionSummary } from "../session/events.js";
import { SessionRecorder, type ReasoningBlock, type SessionEvent } from "../session/recorder.js";
import { replaySessionEvents, type SessionMessageReference, type SessionReplay } from "../session/replay.js";
import { runtimeEventsForRun, type RuntimeEventSink, type RuntimeHighWater } from "../session/runtimeEvent.js";
import type { CapabilityStore } from "../runtime/CapabilityStore.js";
import {
  TurnStore,
  type InterruptedTurn,
  type InterruptedTurnTerminal
} from "../session/turnStore.js";
import { ensureAgentDirs, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import {
  readSessionCatalogRecord,
  SESSION_CATALOG_MISSING_REVISION,
  sessionCatalogRecordRevision,
  updateSessionCatalogMetadata,
  writeSessionCatalogRecord
} from "../session/catalog.js";
import type { ToolRegistry } from "../tools/registry.js";
import { agentLoopContinue } from "./core/agentLoop.js";
import type {
  AgentAssistantMessage,
  AgentModel,
  AgentContext,
  AgentMessage,
  AgentUserMessage,
  AgentUsage,
  ModelRequestContext,
  ModelRequestMetrics
} from "./core/types.js";
import { ToolExecutionCoordinator } from "./toolExecutionCoordinator.js";
import {
  buildSystemPrompt,
  personalizationRuntimePolicyFromSystemPrompt,
  refreshRuntimeSystemPrompt,
  systemPromptForTelemetry,
  withActiveRunCompactionSummary
} from "./prompts.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResult,
  AgentRuntimeContext,
  AgentSessionEvent,
  AgentTurnOutcome
} from "./types.js";
import { ContextMemory } from "./context/ContextMemory.js";
import { LocalMemory, MemoryRevisionConflictError, redactSecrets } from "./context/LocalMemory.js";
import { runMemoryCommand } from "./context/memoryCommands.js";
import { WorkspaceContext } from "./context/WorkspaceContext.js";
import type { CompactionResult, ContextStatus } from "./context/types.js";
import { recordNativeTelemetry } from "../observability/telemetry.js";
import { summarizeModelRequests, type ModelRequestSummary } from "../observability/modelRequests.js";
import { createSessionUsage, formatUsageSummary, sumSessionUsage, summarizeUsage, type UsageModelInfo } from "../observability/usage.js";
import type { SessionContextCheckpoint, SessionUsage, UsageSummary } from "../session/metadata.js";
import { defaultModelContextWindow } from "../ai/capabilities.js";
import { modelCapabilities } from "../ai/capabilities.js";
import { createNativeModelForConfig } from "../llm/nativeFactory.js";
import type { NativeModelSettings } from "../llm/nativeFactory.js";
import { isModelContextOverflowError } from "../llm/nativeModel.js";
import { readAttachment, type AgentAttachment } from "../attachments/store.js";
import type { AttachmentReference } from "../attachments/store.js";
import { TodoStore } from "../session/todoStore.js";
import { CompletionStateStore } from "./completionState.js";
import {
  CompletionGate,
  RunFactsCollector,
  type CompletionDecision,
  type CompletionGateVerifier,
  type CompletionVerification,
  type ProcessFact,
  type RunFacts,
  type StructuredVerificationCheck,
  type VerificationFact
} from "./completionGate.js";
import { resolveRunBudget, type RunBudget } from "./runBudget.js";
import {
  deriveAgentVerificationPlan,
  type AgentVerificationFacts,
  type AgentVerificationPlan
} from "./verification.js";
import { AcceptanceVerifier, type ManagedProcessInspector } from "../harness/AcceptanceVerifier.js";
import {
  createControlledAcceptanceCommandExecutor,
  type AcceptanceCommandExecutor
} from "../harness/AcceptanceCommandExecutor.js";
import {
  captureWorkspaceState,
  diffWorkspaceStates,
  type WorkspaceStateSnapshot
} from "../harness/WorkspaceState.js";
import {
  chatPersonalizationOverrideSchema,
  cloneChatPersonalizationOverride,
  defaultChatPersonalizationOverride,
  globalPersonalizationUpdateSchema,
  mergeChatPersonalizationOverride,
  metadataForPersonalization,
  personalizationSettingsSchema,
  memoryPolicySchema,
  resolveChatPersonalization,
  type AgentPersonalizationState,
  type ChatPersonalizationOverridePatch,
  type GlobalPersonalizationUpdate,
  type ResolvedChatPersonalization
} from "../personalization/index.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  persistenceRoot?: string;
  configStore?: AgentConfigStore;
  config: AgentConfig;
  model?: AgentModel;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  recorder: SessionRecorder;
  modelManager?: ModelManager;
  skillPrompt?: string | (() => string);
  /** 具名子代理定义元数据段（delegate_task 可用的 agent 列表）。 */
  subagentPrompt?: string;
  skillPaths?: string[] | (() => string[]);
  /** MCP 服务器 initialize 返回的 instructions 汇总；重连后会变化，因此每回合实时读取。 */
  mcpPrompt?: () => string;
  /** 模型自己维护的计划清单；每回合实时读取，历史压缩不会让它丢失。 */
  todoPrompt?: () => string | undefined;
  /** Todo 真值源；Completion Gate 与 session resume 共用同一个实例。 */
  todoStore?: TodoStore;
  /** 模型声明的 blocked / verification 状态，只在当前根回合内有效。 */
  completionState?: CompletionStateStore;
  /** Completion Gate 检查本回合启动的受管进程。 */
  managedProcesses?: ManagedProcessInspector;
  /** 回合内首次改动工作区前建快照，供 /undo 回退；不在 git 仓库时省略。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  /** 会话恢复时按虚拟路径重新读取项目级附件。 */
  attachmentRoot?: string;
  /** Host composition root 注入 SQLite authority；独立 AgentSession 可省略。 */
  runtimeEventSink?: RuntimeEventSink;
  /** Host-owned MCP/Plugin 调用的统一 Capability authority。 */
  capabilities?: CapabilityStore;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  mode?: AgentRunMode;
  /** 本次调用可消费的硬 step 上限；普通根回合默认使用配置的 hardStepLimit。 */
  maxSteps?: number;
  /**
   * 从已有 context 直接续跑，跳过上下文组装，也不再记一条用户消息。
   * 续跑的是同一个回合，不是新的一轮对话。
   */
  continueFrom?: AgentMessage[];
  /** 与 continueFrom 对应的系统提示词；普通根回合由 ContextMemory 生成。 */
  continueSystemPrompt?: string;
  /** 续跑同一 Turn 时不重复追加公开用户消息。 */
  recordSessionUserMessage?: boolean;
  /** 宿主显式要求 Completion Gate 执行确定性验证；不从用户文本关键词推断。 */
  verificationRequired?: boolean;
  /** 宿主提供的结构化验证条件，会与模型通过 request_verification 声明的条件合并。 */
  verificationChecks?: StructuredVerificationCheck[];
  attachments?: AgentAttachment[];
  /** Runtime host 为本次执行分配的 invocation identity。 */
  runId?: string;
  /** 同一个根任务及其 continuation 共用的稳定 turn identity。 */
  turnId?: string;
}

export type AgentPromptOptions = Pick<
  AgentRunOptions,
  "abortSignal" | "confirmPermission" | "mode" | "verificationRequired" | "verificationChecks" | "attachments" | "runId" | "turnId"
>;

export type { AgentAttachment } from "../attachments/store.js";

export interface AgentSessionInfo {
  workspaceRoot: string;
  sessionId: string;
  sessionFile: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  modelAlias: string;
  thinking: ThinkingSelection;
  contextWindow?: number;
  /** 单轮允许注入的输入 token 预算；`getInfo()` 一直带着它，界面用它算上下文用量。 */
  maxInputTokens?: number;
  skills?: string[];
}

/** 普通交互统一走 chat；plan 只改变工具策略。 */
export type AgentRunMode = "chat" | "plan";
export type InteractiveAgentRunMode = AgentRunMode;

export interface ResumedAgentSession extends SessionReplay {
  filePath: string;
  sessionId: string;
}

interface NativeTurnArgs {
  input: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  messageReferences: Array<SessionMessageReference | undefined>;
  runOptions: AgentRunOptions & {
    initialRunFacts?: RunFacts;
    previousTerminals?: InterruptedTurnTerminal[];
  };
  abortSignal: AbortSignal;
  mode: AgentRunMode;
  runBudget: RunBudget;
  completedStepsBeforeRun: number;
  workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined;
  captureWorkspaceBaseline: () => Promise<void>;
  messageQueues: ActiveRunMessageQueues;
  personalization: ResolvedChatPersonalization;
}

interface QueuedRunMessage {
  messageId: string;
  input: string;
  attachments: AgentAttachment[];
  message: AgentUserMessage;
  delivery: "steer" | "followUp";
}

interface ActiveRunMessageQueues {
  steering: QueuedRunMessage[];
  followUps: QueuedRunMessage[];
  delivered: WeakMap<AgentUserMessage, QueuedRunMessage>;
  projectedAssistants: WeakSet<AgentAssistantMessage>;
  accepting: boolean;
}

const maxQueuedRunMessages = 100;

/**
 * Stateful core agent for one workspace. Hosts use this public surface instead
 * of reaching into the model, recorder, tools or mutable conversation directly.
 */
export class AgentSession {
  private readonly contextMemory: ContextMemory;
  private readonly localMemory: LocalMemory;
  private usageRecords: SessionUsage[] = [];
  private modelRequestRecords: ModelRequestMetrics[] = [];
  private unpersistedRelatedUsage: SessionUsage[] = [];
  private recorder: SessionRecorder;
  private turnStore: TurnStore;
  private activeOperation: string | undefined;
  private activeRunMessageQueues: ActiveRunMessageQueues | undefined;
  private readonly lingeringExternalTools = new Map<Promise<unknown>, { tool: string; toolCallId: string }>();
  /** 与 ContextMemory history 一一对应；内部 steering 消息没有持久化引用。 */
  private contextMessageReferences: Array<SessionMessageReference | undefined> = [];
  private nextSessionMessageIndex = 0;
  /** 新 root turn 开始时替换；同一 turn 的所有 model step 固定使用这份快照。 */
  private activeConfig: AgentConfig;
  private activePersonalization: ResolvedChatPersonalization;

  constructor(private readonly options: AgentSessionOptions) {
    this.activeConfig = options.config;
    this.activePersonalization = resolveChatPersonalization(
      options.config.personalization,
      options.config.context.memory,
      defaultChatPersonalizationOverride
    );
    const persistenceRoot = this.persistenceRoot();
    const workspace = new WorkspaceContext(
      options.workspaceRoot,
      options.config.workspace.ignore,
      options.config.context.instructionsMaxBytes
    );
    const getModel = (): AgentModel => {
      const model = options.modelManager?.getModel() ?? options.model;
      if (!model) throw new Error("Agent model is not configured.");
      return model;
    };
    const onUsage = async (usage: AgentUsage, operation: "agent" | "plan" | "compaction" | "memory" | "subagent"): Promise<void> => {
      this.recordModelUsage(usage, operation);
    };
    const onModelRequest = async (metrics: ModelRequestMetrics): Promise<void> => {
      await this.recordModelRequest(metrics);
    };
    const memoryConfig = options.config.context.memory;
    // 抽取与整理可使用不同模型。getter 读取 root-turn 快照，因此外部配置变更不会让运行中的
    // turn 漂移；下一根回合才会切换。按 alias 缓存 adapter，避免每个候选重复创建。
    const memoryModels = new Map<string, AgentModel>();
    const memoryModel = (field: "extractModel" | "consolidationModel"): AgentModel => {
      const alias = this.activeConfig.context.memory[field];
      if (!alias) return getModel();
      const cached = memoryModels.get(alias);
      if (cached) return cached;
      const created = createNativeModelForConfig(this.activeConfig, alias);
      memoryModels.set(alias, created);
      return created;
    };
    const initialContextBudget = options.modelManager?.getContextBudget();
    this.localMemory = new LocalMemory(
      persistenceRoot,
      () => memoryModel("extractModel"),
      onUsage,
      memoryConfig.maxRecalled,
      onModelRequest,
      () => this.sideModelRequestContext(),
      () => memoryModel("consolidationModel")
    );
    this.contextMemory = new ContextMemory(
      getModel,
      workspace,
      this.localMemory,
      initialContextBudget?.maxInputTokens ?? options.config.context.maxInputTokens ?? defaultModelContextWindow,
      options.config.context.instructionsMaxBytes,
      onUsage,
      () => {
        if (options.modelManager) return options.modelManager.getContextBudget();
        // 直接注入 AgentModel 的宿主没有 ModelManager，只能使用显式上下文上限；这里不猜测模型能力。
        const fallback = options.config.context.maxInputTokens ?? defaultModelContextWindow;
        return { contextWindow: fallback, maxInputTokens: fallback, maxOutputTokens: undefined };
      },
      options.config.context.compaction,
      onModelRequest,
      () => this.sideModelRequestContext()
    );
    this.contextMemory.setPersonalization(
      metadataForPersonalization(this.activePersonalization),
      this.activePersonalization.useMemories
    );
    this.recorder = options.recorder;
    this.turnStore = new TurnStore(this.persistenceRoot(), options.recorder.sessionId);
  }

  async initialize(): Promise<void> {
    await this.contextMemory.initialize();
  }

  /** 技能元数据、具名子代理清单与 MCP instructions 共同构成 system prompt 的扩展段。 */
  private extensionPrompt(): string | undefined {
    const sections = [
      this.skillPrompt()?.trim(),
      this.options.subagentPrompt?.trim(),
      this.options.mcpPrompt?.().trim(),
      (this.options.todoStore?.promptSection() ?? this.options.todoPrompt?.())?.trim()
    ].filter(Boolean);
    return sections.length ? sections.join("\n\n") : undefined;
  }

  private skillPrompt(): string | undefined {
    return typeof this.options.skillPrompt === "function" ? this.options.skillPrompt() : this.options.skillPrompt;
  }

  private skillPaths(): string[] {
    const paths = typeof this.options.skillPaths === "function" ? this.options.skillPaths() : this.options.skillPaths;
    return [...(paths ?? [])];
  }

  /** 只把当前模型步骤真正可见的工具元数据交给提示词构建器。 */
  private promptTools(toolNames?: readonly string[]) {
    if (!toolNames) return this.options.toolRegistry.list();
    const active = new Set(toolNames);
    return this.options.toolRegistry.list().filter((tool) => active.has(tool.name));
  }

  /** 上次被打断、尚未收尾的回合；没有则为 undefined。 */
  async interruptedTurn(): Promise<InterruptedTurn | undefined> {
    return await this.turnStore.load();
  }

  /** 只补齐 session 中缺失的协议结果；恢复过程不调用任何工具执行函数。 */
  private async reconcileInterruptedToolExecutions(expectedRuntimeHighWater?: RuntimeHighWater): Promise<SessionReplay> {
    await this.recorder.flush().catch(() => undefined);
    const events = await readSessionEvents(this.recorder.filePath);
    const replay = replaySessionEvents(events, {
      sessionId: this.recorder.sessionId,
      expectedRuntimeHighWater
    });
    for (const event of replay.recoveredToolResults) await this.recorder.recordAndFlush(event);
    return replay;
  }

  /**
   * 从被打断的地方继续同一个回合。
   *
   * 用的是断点时的完整 context，所以已完成步骤的工具结果都还在，模型不需要重跑它们。
   * 没有可续跑的状态时抛错而不是静默开一个新回合 —— 后者会让用户以为续上了，其实是重来。
   */
  async *continueInterruptedTurn(runOptions: AgentRunOptions = {}): AsyncGenerator<AgentSessionEvent> {
    const turn = await this.turnStore.load();
    if (!turn) throw new Error("There is no interrupted turn to continue.");
    const runId = runOptions.runId ?? randomUUID();
    const turnId = turn.turnId ?? runOptions.turnId ?? randomUUID();
    const previousContext = this.recorder.runtimeContextSnapshot();
    this.recorder.setRuntimeContext({ runId, turnId });
    try {
      let replay: SessionReplay;
      try {
        replay = await this.reconcileInterruptedToolExecutions(turn.runtimeHighWater);
      } catch (error) {
        const message = `Recovery is blocked because the session runtime high-water could not be verified: ${errorMessage(error)}`;
        const outcome: AgentTurnOutcome = {
          status: "blocked",
          stopReason: "blocked",
          steps: turn.completedSteps,
          output: "",
          error: message,
          resumable: false,
          blockedReason: "environment_unavailable",
          requiredAction: "Inspect the session facts and explicitly start a new turn after resolving the recovery mismatch."
        };
        this.recordError(message);
        await this.turnStore.clear().catch(() => undefined);
        await this.recordTurnOutcome(outcome);
        yield { type: "error", message };
        yield { type: "status", status: "blocked" };
        yield doneEvent(outcome);
        return;
      }
      if (
        turn.terminal?.status === "blocked"
        && (turn.terminal.blockedReason === "missing_user_input"
          || turn.terminal.blockedReason === "unsafe_action_required")
      ) {
        throw new Error(
          turn.terminal.requiredAction
            ? `This blocked turn requires a new user message: ${turn.terminal.requiredAction}`
            : "This blocked turn requires a new user message before it can continue."
        );
      }
      const turnLimit = runOptions.maxSteps ?? resolveRunBudget(this.options.config.agent).hardStepLimit;
      const remainingSteps = turnLimit - turn.completedSteps;
      if (remainingSteps < 1) {
        await this.turnStore.clear().catch(() => undefined);
        throw new Error(
          `The interrupted turn already reached its ${String(turnLimit)}-step limit. `
          + "Send a new user message to start another turn."
        );
      }
      if (turn.terminal?.status === "blocked") this.options.completionState?.clearBlocked();
      const replayMessages = await this.rehydrateSessionAttachments(
        replay.messages,
        replay.events,
        replay.contextStartUserMessageIndex
      );
      const recoveredMessages = replayMessages.length ? replayMessages : turn.messages;
      const recoveredReferences = replay.messages.length
        ? replay.messageReferences
        : turn.messages.map(() => undefined);
      const continuationMessages = turn.terminal
        ? [...recoveredMessages, runtimeContinuationMessage(turn.terminal)]
        : recoveredMessages;
      const continuationReferences = turn.terminal
        ? [...recoveredReferences, undefined]
        : recoveredReferences;
      this.contextMemory.restore(recoveredMessages, replay.contextState ?? replay.contextUsage);
      if (replay.contextCheckpoint) this.contextMemory.setCheckpoint(replay.contextCheckpoint);
      this.contextMessageReferences = recoveredReferences.map((reference) => reference === undefined ? undefined : { ...reference });
      this.nextSessionMessageIndex = replay.totalMessageCount;
      const previousTerminals = [
        ...(turn.previousTerminals ?? []),
        ...(turn.terminal ? [turn.terminal] : [])
      ];
      yield* this.runTurn(turn.prompt, {
        ...runOptions,
        runId,
        turnId,
        maxSteps: remainingSteps,
        continueFrom: continuationMessages,
        continueMessageReferences: continuationReferences,
        continueSystemPrompt: turn.systemPrompt,
        recordSessionUserMessage: false,
        completedStepsBeforeRun: turn.completedSteps,
        initialRunFacts: restartRunFactsBudget(readRunFacts(turn.facts), turn.completedSteps === 0),
        previousTerminals
      });
    } finally {
      this.recorder.setRuntimeContext(previousContext);
    }
  }

  /** 持久记忆存储句柄；读取/自动贡献开关不影响显式 /memory 管理操作。 */
  getLocalMemory(): LocalMemory {
    return this.localMemory;
  }

  /** 三端共享的读模型；正文只在 global/chat 配置中，resolved 元数据可安全投影到 session。 */
  async getPersonalizationState(): Promise<AgentPersonalizationState> {
    return (await this.readPersonalizationState()).state;
  }

  /** 更新当前聊天覆盖。catalog 的内容哈希是跨进程 CAS，过期界面不能覆盖新值。 */
  async updateChatPersonalization(
    patch: ChatPersonalizationOverridePatch,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    const release = this.beginOperation("personalization update");
    try {
      const existing = await readSessionCatalogRecord(this.persistenceRoot(), this.recorder.sessionId);
      const current = existing?.personalization === undefined
        ? defaultChatPersonalizationOverride
        : existing.personalization;
      const personalization = mergeChatPersonalizationOverride(current, patch);
      const now = new Date().toISOString();
      if (existing) {
        await updateSessionCatalogMetadata(
          this.persistenceRoot(),
          this.recorder.sessionId,
          { personalization },
          expectedRevision
        );
      } else if (this.recorder.isUnrecordedDraft()) {
        await writeSessionCatalogRecord(this.persistenceRoot(), {
          version: 1,
          sessionId: this.recorder.sessionId,
          rootSessionId: this.recorder.sessionId,
          personalization,
          createdAt: now,
          updatedAt: now
        }, { expectedRevision });
      } else {
        await updateSessionCatalogMetadata(
          this.persistenceRoot(),
          this.recorder.sessionId,
          { personalization },
          expectedRevision
        );
      }
      return (await this.readPersonalizationState()).state;
    } finally {
      release();
    }
  }

  /**
   * 更新全局基础策略。调用方必须带 overview 返回的 configRevision；不支持 versioned CAS 的
   * 嵌入式测试 store 只能读取，不能通过这个入口执行可能丢更新的写入。
   */
  async updateGlobalPersonalization(
    update: GlobalPersonalizationUpdate,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    const release = this.beginOperation("global personalization update");
    try {
      const store = this.options.configStore;
      if (!store?.loadVersioned || !store.saveVersioned) {
        throw new Error("This config store does not support versioned personalization updates.");
      }
      const current = await store.loadVersioned(this.options.workspaceRoot);
      const parsedUpdate = globalPersonalizationUpdateSchema.parse(update);
      const next = configSchema.parse({
        ...current.config,
        personalization: parsedUpdate.personalization === undefined
          ? current.config.personalization
          : personalizationSettingsSchema.parse(parsedUpdate.personalization),
        context: {
          ...current.config.context,
          memory: parsedUpdate.memory === undefined
            ? current.config.context.memory
            : memoryPolicySchema.parse(parsedUpdate.memory)
        }
      });
      const saved = await store.saveVersioned(next, expectedRevision, this.options.workspaceRoot);
      return (await this.readPersonalizationState(saved)).state;
    } finally {
      release();
    }
  }

  async runMemoryCommand(args: string[]): Promise<string> {
    return await runMemoryCommand(this.localMemory, args);
  }

  /** Desktop/TUI 的公开交互入口，只接受 chat / plan 策略。 */
  async *prompt(input: string, options: AgentPromptOptions = {}): AsyncGenerator<AgentSessionEvent> {
    yield* this.runTurn(input, options);
  }

  queueSteering(messageId: string, input: string, attachments: AgentAttachment[] = []): void {
    this.queueRunMessage(messageId, input, attachments, "steer");
  }

  queueFollowUp(messageId: string, input: string, attachments: AgentAttachment[] = []): void {
    this.queueRunMessage(messageId, input, attachments, "followUp");
  }

  private queueRunMessage(
    messageId: string,
    input: string,
    attachments: AgentAttachment[],
    delivery: "steer" | "followUp"
  ): void {
    const queues = this.activeRunMessageQueues;
    if (!queues?.accepting) throw new Error("The active run is no longer accepting queued messages.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
    this.assertAttachmentsSupported(attachments);
    if (queues.steering.length + queues.followUps.length >= maxQueuedRunMessages) {
      throw new Error(`The active run already has ${String(maxQueuedRunMessages)} queued messages.`);
    }
    const clonedAttachments = attachments.map((attachment) => ({ ...attachment }));
    const item: QueuedRunMessage = {
      messageId,
      input,
      attachments: clonedAttachments,
      message: queuedUserMessage(input, clonedAttachments),
      delivery
    };
    (delivery === "steer" ? queues.steering : queues.followUps).push(item);
  }

  private async *runTurn(
    input: string,
    runOptions: AgentRunOptions & {
      completedStepsBeforeRun?: number;
      initialRunFacts?: RunFacts;
      previousTerminals?: InterruptedTurnTerminal[];
      continueMessageReferences?: Array<SessionMessageReference | undefined>;
    } = {}
  ): AsyncGenerator<AgentSessionEvent> {
    const release = this.beginOperation("agent turn");
    const messageQueues: ActiveRunMessageQueues = {
      steering: [],
      followUps: [],
      delivered: new WeakMap(),
      projectedAssistants: new WeakSet(),
      accepting: true
    };
    this.activeRunMessageQueues = messageQueues;
    const turnController = new AbortController();
    const abortSignal = runOptions.abortSignal
      ? AbortSignal.any([runOptions.abortSignal, turnController.signal])
      : turnController.signal;
    const continuing = Boolean(runOptions.continueFrom?.length);
    const persistedPolicy = continuing
      ? personalizationRuntimePolicyFromSystemPrompt(runOptions.continueSystemPrompt)
      : undefined;
    let turnPersonalization: ResolvedChatPersonalization = persistedPolicy === undefined
      ? this.activePersonalization
      : {
        ...this.activePersonalization,
        ...persistedPolicy,
        enabled: true,
        customInstructions: ""
      };
    this.contextMemory.setPersonalization(
      metadataForPersonalization(turnPersonalization),
      turnPersonalization.useMemories
    );
    const runtimeRunId = runOptions.runId ?? randomUUID();
    const runtimeTurnId = runOptions.turnId ?? randomUUID();
    runOptions = { ...runOptions, runId: runtimeRunId, turnId: runtimeTurnId };
    this.recorder.setRuntimeContext({ runId: runtimeRunId, turnId: runtimeTurnId });
    const completedStepsBeforeRun = continuing ? runOptions.completedStepsBeforeRun ?? 0 : 0;
    if (!continuing) this.options.completionState?.reset();
    if (!Number.isSafeInteger(completedStepsBeforeRun) || completedStepsBeforeRun < 0) {
      throw new RangeError("Completed turn steps must be a non-negative safe integer.");
    }
    let workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined;
    const captureWorkspaceBaseline = async (): Promise<void> => {
      const baseline = workspaceBaseline ??= captureWorkspaceState(
        this.options.workspaceRoot,
        this.options.config.workspace.ignore
      );
      try {
        await baseline;
      } catch {
        // 已知文件工具仍会直接记录 changedFiles；快照不可用时不要留下一个稍后必然 reject
        // 的 Promise，把本来成功的工具调用变成回合级 provider_error。
        if (workspaceBaseline === baseline) workspaceBaseline = undefined;
      }
    };
    const usageBeforePreparation = this.usageRecords.length;
    let userMessageRecorded = false;
    let userMessageReference: SessionMessageReference | undefined;
    const recordUserMessage = (): SessionMessageReference | undefined => {
      if (userMessageRecorded) return userMessageReference;
      userMessageRecorded = true;
      if (runOptions.recordSessionUserMessage === false) return undefined;
      userMessageReference = this.recordCanonicalMessage({
        type: "user_message",
        content: input,
        attachments: sessionAttachments(runOptions.attachments),
        skills: this.skillPaths(),
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        preparationUsage: this.usageRecords.slice(usageBeforePreparation)
      });
      return userMessageReference;
    };
    try {
    // 新根输入明确放弃旧断点；否则它在首个新 step 落盘前崩溃时，恢复逻辑会错误复活上一回合。
    if (!continuing) await this.turnStore.clear().catch(() => undefined);
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = cancelledTurn("Current turn cancelled before execution.", completedStepsBeforeRun);
      await this.turnStore.clear().catch(() => undefined);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "cancelled" };
      yield doneEvent(outcome);
      return;
    }
    try {
      await this.options.modelManager?.preparePrompt(abortSignal);
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? cancelledTurn("Current turn cancelled during model preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, "provider_error");
      this.recordError(outcome.error);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
      return;
    }
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) {
      recordUserMessage();
      const outcome = failedTurn("Native model runtime is not configured.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }
    const mode = runOptions.mode ?? "chat";
    let systemPrompt: string | undefined;
    let messages: AgentMessage[];
    let messageReferences: Array<SessionMessageReference | undefined>;
    if (runOptions.continueFrom?.length) {
      // 续跑用的是被打断那一刻的 context，重新组装会丢掉已完成步骤的工具结果。
      messages = [...runOptions.continueFrom];
      messageReferences = [...(runOptions.continueMessageReferences ?? messages.map(() => undefined))];
      systemPrompt = runOptions.continueSystemPrompt;
      userMessageRecorded = true;
    } else {
    // 先把用户原始输入（以及附件引用）写进 JSONL，再组装上下文或检查模型能力。
    // 这样即使模型不支持图片、上下文构建失败或进程随后中断，恢复会话时仍能看到这次输入。
    try {
      const snapshot = await this.readPersonalizationState();
      this.activeConfig = snapshot.config;
      this.activePersonalization = snapshot.state.resolved;
      turnPersonalization = snapshot.state.resolved;
      this.contextMemory.setPersonalization(
        metadataForPersonalization(turnPersonalization),
        turnPersonalization.useMemories
      );
      recordUserMessage();
      const initialTools = this.options.toolRegistry.list().filter((tool) => mode !== "plan" || tool.risk === "read");
      const baseSystemPrompt = buildSystemPrompt({
        mode: mode === "plan" ? "plan" : "qa",
        extensionPrompt: this.extensionPrompt(),
        tools: initialTools,
        personalization: turnPersonalization,
        cwd: this.options.workspaceRoot
      });
      const prepared = await this.contextMemory.prepareTurn(
        input,
        baseSystemPrompt,
        abortSignal,
        this.supportedAttachments(runOptions.attachments),
        turnPersonalization.useMemories,
        turnPersonalization.maxRecalled
      );
      if (prepared.compaction) {
        this.persistContextCheckpoint(
          prepared.compaction,
          "threshold",
          this.contextMessageReferences,
          userMessageReference
        );
      }
      systemPrompt = prepared.systemPrompt;
      messages = prepared.messages;
      const selectedHistoryCount = Math.max(0, messages.length - 1);
      messageReferences = [
        ...this.contextMessageReferences.slice(-selectedHistoryCount),
        userMessageReference
      ];
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? cancelledTurn("Current turn cancelled during context preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(outcome.error);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
      return;
    }
    }
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = cancelledTurn("Current turn cancelled during context preparation.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      await this.turnStore.clear().catch(() => undefined);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "cancelled" };
      yield doneEvent(outcome);
      return;
    }
    if (!continuing) {
      try {
        await this.recorder.flush();
        await this.turnStore.save(
          input,
          systemPrompt,
          messages,
          completedStepsBeforeRun,
          undefined,
          undefined,
          runOptions.previousTerminals,
          undefined,
          this.recorder.runtimeHighWater()
        );
      } catch {
        // 初始断点写入失败时不伪装成可恢复；真正的终态仍由下面的 durable commit 记录。
      }
    }
    const configuredBudget = resolveRunBudget(this.options.config.agent);
    const remainingConfiguredSteps = configuredBudget.hardStepLimit - completedStepsBeforeRun;
    const requestedSteps = runOptions.maxSteps ?? remainingConfiguredSteps;
    if (
      !Number.isSafeInteger(requestedSteps)
      || requestedSteps < 1
      || requestedSteps > remainingConfiguredSteps
    ) {
      throw new RangeError(
        `Agent run maxSteps must be between 1 and ${String(Math.max(0, remainingConfiguredSteps))}; `
        + `the configured hard limit is ${String(configuredBudget.hardStepLimit)}.`
      );
    }
    const runBudget: RunBudget = {
      ...configuredBudget,
      softStepLimit: Math.min(configuredBudget.softStepLimit, completedStepsBeforeRun + requestedSteps),
      hardStepLimit: completedStepsBeforeRun + requestedSteps
    };
    yield* this.runNativeTurn({
      input,
      systemPrompt,
      messages,
      messageReferences,
      runOptions,
      abortSignal,
      mode,
      runBudget,
      completedStepsBeforeRun,
      workspaceBaseline,
      captureWorkspaceBaseline,
      messageQueues,
      personalization: turnPersonalization
    });
    return;
    } finally {
      this.recorder.setRuntimeContext(undefined);
      messageQueues.accepting = false;
      if (this.activeRunMessageQueues === messageQueues) this.activeRunMessageQueues = undefined;
      release();
    }
  }

  /**
   * Native Biny runtime path.
   *
   * The session boundary uses the same native message protocol as the loop,
   * provider transport and persisted turn state.
   */
  private async *runNativeTurn(args: NativeTurnArgs): AsyncGenerator<AgentSessionEvent> {
    const {
      input,
      systemPrompt,
      messages,
      messageReferences,
      runOptions,
      abortSignal,
      mode,
      runBudget,
      completedStepsBeforeRun,
      workspaceBaseline,
      captureWorkspaceBaseline,
      messageQueues,
      personalization
    } = args;
    const nativeModel = this.options.modelManager?.getModel() ?? this.options.model;
    const nativeSettings: NativeModelSettings | undefined = this.options.modelManager?.getModelSettings()
      ?? (nativeModel ? { model: nativeModel, contextWindow: undefined } : undefined);
    if (!nativeSettings) {
      const outcome = failedTurn("Native model runtime is not configured.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      await this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Native model runtime is not configured." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }
    let activeModelSettings = nativeSettings;
    let relatedToolCallIds: string[] = [];
    const modelRequestContext = (step: number): ModelRequestContext => ({
      sessionId: this.recorder.sessionId,
      runId: args.runOptions.runId,
      turnId: args.runOptions.turnId,
      step,
      operation: mode === "plan" ? "plan" : "agent",
      relatedToolCallIds: [...relatedToolCallIds]
    });

    const permissionManager = this.options.permissionManager;
    const facts = new RunFactsCollector(runOptions.initialRunFacts);
    if (runOptions.verificationRequired === true) facts.setUserRequestedVerification(true);
    let pendingApprovalCount = 0;
    const confirmPermission = runOptions.confirmPermission === undefined
      ? undefined
      : async (request: AgentPermissionRequest): Promise<AgentPermissionResult> => {
        pendingApprovalCount += 1;
        facts.setPendingApprovals(pendingApprovalCount);
        try {
          return await runOptions.confirmPermission!(request);
        } finally {
          pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
          facts.setPendingApprovals(pendingApprovalCount);
        }
      };
    const runtime = this.runtimeContext(
      { ...runOptions, abortSignal, confirmPermission },
      captureWorkspaceBaseline
    );
    const allowedToolNames = mode === "plan"
      ? new Set(this.options.toolRegistry.list().filter((tool) => tool.risk === "read").map((tool) => tool.name))
      : undefined;
    let stepAssistantContent = "";
    let stepReasoningOutput = "";
    let stepReasoningBlocks: ReasoningBlock[] | undefined;
    const pendingEvents: AgentSessionEvent[] = [];
    const emitUpdate = (event: AgentSessionEvent): void => {
      if (
        event.type === "tool.started"
        || event.type === "tool.progress"
        || event.type === "tool.completed"
        || event.type === "tool.failed"
      ) facts.observeToolEvent(event);
      pendingEvents.push(event);
    };
    let observedSteps = 0;
    let toolResultCheckpointBarrier = Promise.resolve();
    const coordinatorRef: { current?: ToolExecutionCoordinator } = {};
    const persistToolResultCheckpoint = (): Promise<void> => {
      const current = toolResultCheckpointBarrier.then(async () => {
        const coordinator = coordinatorRef.current;
        if (!coordinator) return;
        const replay = replaySessionEvents(
          await readSessionEvents(this.recorder.filePath),
          { sessionId: this.recorder.sessionId }
        );
        if (!replay.messages.length) return;
        await this.recorder.flush();
        await this.turnStore.save(
          input,
          systemPrompt,
          replay.messages,
          completedStepsBeforeRun + observedSteps + 1,
          facts.snapshot(false),
          undefined,
          runOptions.previousTerminals,
          coordinator.getExecutionCheckpoints(),
          this.recorder.runtimeHighWater()
        );
      });
      toolResultCheckpointBarrier = current.catch(() => undefined);
      return current;
    };
    const coordinator = new ToolExecutionCoordinator(
      runtime,
      permissionManager,
      emitUpdate,
      () => ({
        // 工具审计必须绑定到发起它的模型 step，不能等整个 run 结束后再取累计 reasoning。
        assistantContent: stepAssistantContent || undefined,
        reasoningContent: stepReasoningOutput || undefined,
        reasoningProviderOptions: stepReasoningBlocks?.length === 1 ? stepReasoningBlocks[0]?.providerOptions : undefined,
        reasoningBlocks: stepReasoningBlocks
      }),
      allowedToolNames,
      {
        maxToolCalls: runBudget.maxToolCalls,
        maxRepeatedActions: runBudget.maxRepeatedActions,
        initialToolCallCount: runOptions.initialRunFacts?.actualToolCallCount,
        initialMaxRepeatedActionCount: runOptions.initialRunFacts?.maxRepeatedActionCount
      },
      persistToolResultCheckpoint
    );
    coordinatorRef.current = coordinator;

    const verificationCommandExecutor = createControlledAcceptanceCommandExecutor({
      workspaceRoot: this.options.workspaceRoot,
      ignore: this.options.config.workspace.ignore,
      sandbox: this.options.config.sandbox,
      permissionManager,
      sessionId: this.recorder.sessionId,
      confirmPermission,
      maxConcurrency: this.options.config.agent.maxConcurrentTools,
      maxQueuedCommands: this.options.config.agent.maxQueuedToolCalls,
      beforeCommandExecution: async () => await captureWorkspaceBaseline()
    });
    const completionGate = new CompletionGate({
      verifier: createCompletionGateVerifier({
        workspaceRoot: this.options.workspaceRoot,
        ignore: this.options.config.workspace.ignore,
        managedProcesses: this.options.managedProcesses,
        commandExecutor: verificationCommandExecutor
      }),
      listTodos: () => this.options.todoStore?.list() ?? [],
      listRequestedChecks: () => [
        ...(runOptions.verificationChecks ?? []).map((check) => ({ ...check })),
        ...(this.options.completionState?.listChecks() ?? [])
      ],
      blockedState: () => this.options.completionState?.getBlocked(),
      onVerification: (verification) => facts.recordVerification(verification)
    });

    const nativeContext: AgentContext = { systemPrompt, messages: [...messages], tools: [] };
    nativeContext.tools = activeModelSettings.model.supportsTools === false ? [] : coordinator.createAgentTools();
    this.contextMemory.recordToolSchema(nativeContext.tools);
    let completionDecision: CompletionDecision | undefined;
    let pendingSteering: AgentMessage[] = [];
    let lastAssistant: AgentAssistantMessage | undefined;
    let newMessages: AgentMessage[] = [];
    let finalContextMessages: AgentMessage[] = [...messages];
    const referenceByMessage = new WeakMap<AgentMessage, SessionMessageReference>();
    for (const [index, message] of messages.entries()) {
      const reference = messageReferences[index];
      if (reference) referenceByMessage.set(message, reference);
    }
    let reasoningActive = false;
    let lastStepReasoningOutput = "";
    const stepUsageRecords: SessionUsage[] = [];
    let streamFailure: string | undefined;
    let streamFailureReported = false;
    let softLimitWarningInjected = completedStepsBeforeRun >= runBudget.softStepLimit;
    let contextRecoveryAttempts = 0;

    yield { type: "status", status: "thinking" };
    await recordNativeTelemetry(this.options.config, this.options.workspaceRoot, {
      type: "start",
      provider: activeModelSettings.model.provider,
      modelId: activeModelSettings.model.modelId,
      input: { systemPrompt: systemPromptForTelemetry(systemPrompt), messages }
    });
    try {
      const loop = agentLoopContinue(nativeContext, {
        model: activeModelSettings.model,
        tools: nativeContext.tools,
        modelOptions: {
          maxOutputTokens: activeModelSettings.maxOutputTokens,
          reasoning: activeModelSettings.reasoning,
          providerOptions: activeModelSettings.providerOptions,
          timeoutMs: activeModelSettings.timeoutMs,
          onRequestMetrics: (metrics) => this.recordModelRequest(metrics),
          requestContext: modelRequestContext(completedStepsBeforeRun + 1)
        },
        maxSteps: runBudget.hardStepLimit - completedStepsBeforeRun,
        prepareNextTurn: async ({ context }) => {
          await this.options.modelManager?.preparePrompt(abortSignal);
          const settings = this.options.modelManager?.getModelSettings() ?? activeModelSettings;
          activeModelSettings = settings;
          const tools = settings.model.supportsTools === false ? [] : coordinator.createAgentTools();
          context.systemPrompt = refreshRuntimeSystemPrompt(
            context.systemPrompt,
            this.extensionPrompt(),
            this.promptTools(tools.map((tool) => tool.name))
          );
          this.contextMemory.recordToolSchema(tools);
          return {
            context,
            model: settings.model,
            tools,
            modelOptions: {
              maxOutputTokens: settings.maxOutputTokens,
              reasoning: settings.reasoning,
              providerOptions: settings.providerOptions,
              timeoutMs: settings.timeoutMs,
              onRequestMetrics: (metrics) => this.recordModelRequest(metrics),
              requestContext: modelRequestContext(completedStepsBeforeRun + observedSteps + 1)
            }
          };
        },
        recoverFromModelError: async (error, context, signal) => {
          if (!isModelContextOverflowError(error) || contextRecoveryAttempts >= 2) return undefined;
          const sourceReferences = context.messages.map((message) => referenceByMessage.get(message));
          const compacted = await this.contextMemory.compactRunContext(context.messages, signal);
          if (!compacted) return undefined;
          contextRecoveryAttempts += 1;
          this.persistContextCheckpoint(compacted, "overflow", sourceReferences);
          const retainedReferences = sourceReferences.slice(compacted.compactedMessageCount);
          for (const [index, message] of compacted.messages.entries()) {
            const reference = retainedReferences[index];
            if (reference) referenceByMessage.set(message, reference);
          }
          context.messages.splice(0, context.messages.length, ...compacted.messages);
          // 基于当前提示词替换摘要，保留前一步刚刷新的工具和扩展能力信息。
          context.systemPrompt = withActiveRunCompactionSummary(context.systemPrompt, compacted.summary);
          return {
            reason: "context_overflow",
            attempt: contextRecoveryAttempts,
            compactedMessages: compacted.compactedMessageCount
          };
        },
        transformContext: async (contextMessages) => {
          const prunedMessages = this.contextMemory.pruneToolResultsForStep(contextMessages);
          const absoluteStep = completedStepsBeforeRun + observedSteps;
          if (!softLimitWarningInjected && absoluteStep >= runBudget.softStepLimit) {
            softLimitWarningInjected = true;
            return [
              ...prunedMessages,
              {
                role: "user",
                content: "## Biny run budget\n\nThe soft limit of provider steps has been reached. Review unfinished work, avoid repeated actions, run the necessary checks, and converge without claiming completion early."
              }
            ];
          }
          return prunedMessages;
        },
        getSteeringMessages: async () => {
          const next = [
            ...pendingSteering,
            ...this.takeQueuedRunMessages(messageQueues, "steer", lastAssistant, referenceByMessage)
          ];
          pendingSteering = [];
          return next;
        },
        getFollowUpMessages: async () => {
          const next = this.takeQueuedRunMessages(messageQueues, "followUp", lastAssistant, referenceByMessage);
          if (!next.length) messageQueues.accepting = false;
          return next;
        },
        shouldStopAfterTurn: async (turn) => {
          // 含工具调用的 assistant 后必须继续一步，让模型消费结构化结果并形成答复。
          if (turn.message.content.some((part) => part.type === "toolCall")) return false;
          await coordinator.waitForIdle();
          await refreshRunFacts(
            facts,
            workspaceBaseline,
            this.options.workspaceRoot,
            this.options.config.workspace.ignore,
            this.options.managedProcesses
          );
          const decision = await completionGate.decide(facts.snapshot(abortSignal.aborted), {
            steps: completedStepsBeforeRun + observedSteps,
            softStepLimit: runBudget.softStepLimit,
            hardStepLimit: runBudget.hardStepLimit,
            maxToolCalls: runBudget.maxToolCalls,
            maxCompletionContinuations: runBudget.maxCompletionContinuations,
            maxRepeatedActions: runBudget.maxRepeatedActions
          }, abortSignal);
          if (decision.kind === "continue") {
            pendingSteering.push(decision.feedback);
            return false;
          }
          completionDecision = decision;
          // Loop 自然退出前还要检查 follow-up 队列；没有排队消息时才真正结束。
          return false;
        }
      }, abortSignal);

      for await (const event of loop) {
        while (pendingEvents.length) {
          const next = pendingEvents.shift();
          if (next) yield next;
        }
        if (event.type === "message_update") {
          stepAssistantContent = agentMessageText(event.message);
          if (event.event.type === "text-delta") {
            yield { type: "assistant.delta", content: event.event.text };
          } else if (event.event.type === "reasoning-start") {
            if (!reasoningActive) {
              reasoningActive = true;
              yield { type: "reasoning.started", phase: observedSteps === 0 ? "initial" : "continuing" };
            }
          } else if (event.event.type === "reasoning-delta") {
            stepReasoningOutput += event.event.text;
            yield { type: "reasoning.delta", content: event.event.text };
          } else if (event.event.type === "reasoning-end" && reasoningActive) {
            reasoningActive = false;
            yield { type: "reasoning.completed" };
          } else if (event.event.type === "error") {
            streamFailure = errorMessage(event.event.error);
            streamFailureReported = true;
            yield { type: "error", message: streamFailure, fatal: true };
          }
        } else if (event.type === "turn_start") {
          // 每个 provider step 都重新开始计数，后续 tool_call 才能携带对应的 Thought。
          stepAssistantContent = "";
          stepReasoningOutput = "";
          stepReasoningBlocks = undefined;
        } else if (event.type === "message_end") {
          if (event.message.role === "assistant") {
            stepAssistantContent = agentMessageText(event.message);
            stepReasoningBlocks = reasoningBlocks(event.message);
            if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
              referenceByMessage.set(
                event.message,
                this.recordCanonicalMessage({ type: "agent_message", message: event.message })
              );
            }
          } else if (event.message.role === "user") {
            const queued = messageQueues.delivered.get(event.message);
            if (queued) {
              yield {
                type: "message.user",
                messageId: queued.messageId,
                content: queued.input,
                delivery: queued.delivery
              };
            }
          }
        } else if (event.type === "turn_end") {
          relatedToolCallIds = event.toolResults.map((toolResult) => toolResult.toolCallId);
          for (const toolResult of event.toolResults) {
            referenceByMessage.set(
              toolResult,
              this.recordCanonicalMessage({ type: "agent_message", message: toolResult })
            );
          }
          observedSteps += 1;
          lastStepReasoningOutput = stepReasoningOutput;
          lastAssistant = event.message;
          const usage = event.message.usage;
          if (usage) {
            stepUsageRecords.push(this.recordModelUsage(usage, mode === "plan" ? "plan" : "agent"));
            this.contextMemory.recordProviderUsage(usage);
          }
          await recordNativeTelemetry(this.options.config, this.options.workspaceRoot, {
            type: "step",
            provider: activeModelSettings.model.provider,
            modelId: activeModelSettings.model.modelId,
            step: completedStepsBeforeRun + observedSteps,
            finishReason: event.message.stopReason,
            usage,
            output: agentMessageText(event.message)
          });
          // 保存每个已完成的工具步。进程可能在下一次 provider 请求前退出，
          // 续跑必须从最后一个完整的 assistant + tool result context 开始。
          if (
            event.toolResults.length > 0
            && completedStepsBeforeRun + observedSteps < runBudget.hardStepLimit
          ) {
            try {
              await this.recorder.flush();
              await this.turnStore.save(
                input,
                systemPrompt,
                event.messages,
                completedStepsBeforeRun + observedSteps,
                facts.snapshot(false),
                undefined,
                runOptions.previousTerminals,
                coordinator.getExecutionCheckpoints(),
                this.recorder.runtimeHighWater()
              );
            } catch {
              // 步间 checkpoint 失败时不伪装为可恢复；工具结果和最终终态仍照常提交。
            }
          }
        } else if (event.type === "agent_end") {
          newMessages = event.messages;
          finalContextMessages = event.contextMessages;
        } else if (event.type === "model_retry") {
          yield {
            type: "context.retrying",
            reason: "context_overflow",
            attempt: event.attempt,
            compactedMessages: event.compactedMessages
          };
        } else if (event.type === "error") {
          if (event.fatal) {
            streamFailure ??= event.error;
            streamFailureReported = true;
            yield { type: "error", message: event.error, fatal: true };
          } else {
            yield { type: "error", message: event.error };
          }
        }
      }
      while (pendingEvents.length) {
        const next = pendingEvents.shift();
        if (next) yield next;
      }
      await coordinator.waitForIdle();
      if (reasoningActive) yield { type: "reasoning.completed" };
      if (streamFailure) throw new Error(streamFailure);
      if (!completionDecision) {
        completionDecision = {
          kind: "incomplete",
          reason: "hard_step_limit",
          summary: `The run reached its hard limit of ${String(runBudget.hardStepLimit)} provider steps.`,
          resumable: true
        };
      }
      const finalDecision = completionDecision;
      if (!finalDecision || finalDecision.kind === "continue") throw new Error("Native completion gate returned an unconsumed continuation.");

      const currentUserMessage = messages.at(-1);
      const finalMessages = runOptions.continueFrom?.length || contextRecoveryAttempts > 0
        ? finalContextMessages
        : [
          ...this.contextMemory.getHistory(),
          ...(currentUserMessage ? [currentUserMessage] : []),
          ...newMessages
        ];
      const finalReferences = runOptions.continueFrom?.length || contextRecoveryAttempts > 0
        ? finalMessages.map((message) => referenceByMessage.get(message))
        : [
          ...this.contextMessageReferences,
          ...(currentUserMessage ? [referenceByMessage.get(currentUserMessage)] : []),
          ...newMessages.map((message) => referenceByMessage.get(message))
        ];
      this.contextMemory.replaceHistory(finalMessages);
      this.contextMessageReferences = finalReferences;
      const usageRecord = stepUsageRecords.length ? sumSessionUsage(stepUsageRecords) : undefined;
      const content = lastAssistant ? agentMessageText(lastAssistant) : "";
      await recordNativeTelemetry(this.options.config, this.options.workspaceRoot, {
        type: "end",
        provider: activeModelSettings.model.provider,
        modelId: activeModelSettings.model.modelId,
        steps: completedStepsBeforeRun + observedSteps,
        usage: lastAssistant?.usage,
        output: content
      });
      this.recorder.record({
        type: "assistant_message",
        content,
        reasoningContent: lastStepReasoningOutput || undefined,
        reasoningProviderOptions: stepReasoningBlocks?.length === 1 ? stepReasoningBlocks[0]?.providerOptions : undefined,
        reasoningBlocks: stepReasoningBlocks,
        usage: usageRecord,
        relatedUsage: this.takeRelatedUsage(),
        contextState: this.contextMemory.snapshot()
      });
      let outcome = completionOutcome(
        finalDecision,
        content,
        lastAssistant?.stopReason,
        completedStepsBeforeRun + observedSteps,
        usageRecord
      );
      if (content && (outcome.status === "completed" || outcome.status === "incomplete" || outcome.status === "blocked")) {
        yield { type: "assistant.completed", content };
      }
      if (outcome.status === "blocked" || outcome.status === "incomplete" && outcome.resumable === true) {
        try {
          await this.recorder.flush();
          await this.turnStore.save(
            input,
            systemPrompt,
            finalMessages,
            0,
            facts.snapshot(false),
            {
              status: outcome.status,
              stopReason: outcome.stopReason,
              summary: outcome.error ?? `${outcome.status} (${outcome.stopReason})`,
              blockedReason: outcome.blockedReason,
              requiredAction: outcome.requiredAction
            },
            runOptions.previousTerminals,
            coordinator.getExecutionCheckpoints(),
            this.recorder.runtimeHighWater()
          );
        } catch (error) {
          outcome = {
            ...outcome,
            resumable: false,
            error: `${outcome.error ?? `${outcome.status} (${outcome.stopReason})`} Checkpoint persistence failed: ${errorMessage(error)}`
          };
        }
      } else {
        try {
          await this.turnStore.clear();
        } catch (error) {
          outcome = {
            ...outcome,
            status: "failed",
            stopReason: "provider_error",
            resumable: false,
            blockedReason: undefined,
            requiredAction: undefined,
            error: `Turn checkpoint cleanup failed: ${errorMessage(error)}`
          };
        }
      }
      await this.recordTurnOutcome(outcome);
      if (outcome.status === "completed") {
        await this.enqueueCompletedMemoryCandidate(
          input,
          content,
          runOptions.continueFrom?.length ? [...runOptions.continueFrom, ...newMessages] : newMessages,
          personalization,
          runOptions
        ).catch(() => undefined);
        yield { type: "status", status: "completed" };
      } else if (outcome.status === "incomplete") {
        yield { type: "status", status: "incomplete" };
      } else if (outcome.status === "blocked") {
        yield { type: "status", status: "blocked" };
      } else if (outcome.status === "cancelled") {
        yield { type: "status", status: "cancelled" };
      } else {
        this.recordError(outcome.error ?? "Native agent run failed.");
        yield { type: "error", message: outcome.error ?? "Native agent run failed." };
        yield { type: "status", status: "error" };
      }
      yield doneEvent(outcome);
    } catch (error) {
      const message = errorMessage(error);
      await recordNativeTelemetry(this.options.config, this.options.workspaceRoot, {
        type: "error",
        provider: activeModelSettings.model.provider,
        modelId: activeModelSettings.model.modelId,
        step: completedStepsBeforeRun + observedSteps,
        error: message
      });
      const outcome = abortSignal.aborted
        ? cancelledTurn(message || "Current turn cancelled.", completedStepsBeforeRun + observedSteps)
        : failedTurn(message, completedStepsBeforeRun + observedSteps, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(message);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      await this.recordTurnOutcome(outcome);
      if (!streamFailureReported) yield { type: "error", message };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
    }
  }

  async runTask(input: string, runOptions: AgentRunOptions = {}): Promise<AgentTurnOutcome> {
    let outcome: AgentTurnOutcome | undefined;
    try {
      for await (const event of this.runTurn(input, runOptions)) {
        if (event.type === "done") outcome = event.outcome;
      }
    } catch (error) {
      const message = errorMessage(error);
      this.recordError(message);
      return failedTurn(message, 0, isTimeoutFailure(error) ? "timeout" : "provider_error");
    }
    return outcome ?? failedTurn("Agent stream ended without a terminal result.", 0);
  }

  async resume(session: string | undefined): Promise<ResumedAgentSession> {
    const release = this.beginOperation("session resume");
    try {
    await ensureAgentDirs(this.persistenceRoot());
    const filePath = await resolveSessionFile(this.persistenceRoot(), session);
    const previousRecorder = this.recorder;
    const previousFilePath = await fs.realpath(previousRecorder.filePath).catch(() => path.resolve(previousRecorder.filePath));
    const resumingCurrent = filePath === previousFilePath;
    let previousClosed = false;
    let replacementRecorder: SessionRecorder | undefined;
    try {
      if (resumingCurrent) {
        previousClosed = true;
        await previousRecorder.close();
      }
      replacementRecorder = new SessionRecorder(this.persistenceRoot(), sessionIdFromFile(filePath), filePath, this.options.runtimeEventSink);
      replacementRecorder.repairTailForAppend();
      const replay = replaySessionEvents(parseSessionEvents(replacementRecorder.readText()), { sessionId: replacementRecorder.sessionId });
      replacementRecorder.restoreToolCallSequence(maxToolCallSequence(replay.events));
      replacementRecorder.restoreMessageParent(replay.messageTree.at(-1)?.id);

      if (!resumingCurrent) {
        previousClosed = true;
        await previousRecorder.close();
      }
      for (const event of replay.recoveredToolResults) await replacementRecorder.recordAndFlush(event);
      this.options.permissionManager.resetSession();
      this.usageRecords = [...replay.usage];
      this.modelRequestRecords = replay.modelRequests.map((metrics) => ({
        ...metrics,
        attempts: metrics.attempts.map((attempt) => ({ ...attempt })),
        requestContext: metrics.requestContext === undefined
          ? undefined
          : {
            ...metrics.requestContext,
            relatedToolCallIds: metrics.requestContext.relatedToolCallIds === undefined
              ? undefined
              : [...metrics.requestContext.relatedToolCallIds]
          }
      }));
      this.unpersistedRelatedUsage = [];
      const messages = await this.rehydrateSessionAttachments(
        replay.messages,
        replay.events,
        replay.contextStartUserMessageIndex
      );
      this.contextMemory.restore(messages, replay.contextState ?? replay.contextUsage);
      if (replay.contextCheckpoint) this.contextMemory.setCheckpoint(replay.contextCheckpoint);
      this.contextMessageReferences = replay.messageReferences.map((reference) => ({ ...reference }));
      this.nextSessionMessageIndex = replay.totalMessageCount;
      await this.options.todoStore?.useSession(replacementRecorder.sessionId);
      restoreCompletionState(this.options.completionState, replay.events);
      this.recorder = replacementRecorder;
      this.turnStore = new TurnStore(this.persistenceRoot(), replacementRecorder.sessionId);
      return { ...replay, messages, filePath, sessionId: replacementRecorder.sessionId };
    } catch (error) {
      await replacementRecorder?.close().catch(() => undefined);
      if (previousClosed) {
        this.recorder = new SessionRecorder(this.persistenceRoot(), undefined, undefined, this.options.runtimeEventSink);
      }
      throw error;
    }
    } finally {
      release();
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await listSessionSummaries(this.persistenceRoot());
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.contextMemory.status();
  }

  /** 本会话累计用量的快照；evals 和宿主用它做度量，拿到的是副本不是内部数组。 */
  usageSummary(): UsageSummary {
    return summarizeUsage(this.usageRecords);
  }

  /** 当前 AgentSession 内原生 Provider 请求的性能快照；正文不进入该汇总。 */
  modelRequestSummary(): ModelRequestSummary {
    return summarizeModelRequests(this.modelRequestRecords);
  }

  private sideModelRequestContext(): ModelRequestContext | undefined {
    if (this.activeOperation !== "agent turn") return undefined;
    const runtime = this.recorder.runtimeContextSnapshot();
    return runtime === undefined
      ? undefined
      : { runId: runtime.runId, turnId: runtime.turnId };
  }

  usageReport(): string {
    return formatUsageSummary(summarizeUsage(this.usageRecords));
  }

  /** 当前激活模型不支持媒体时返回明确错误；输入本身已先写入会话，方便恢复和切换模型后重试。 */
  assertAttachmentsSupported(attachments: AgentAttachment[]): void {
    if (!attachments.length) return;
    const unsupported = attachments.find((attachment) => !attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("audio/"));
    if (unsupported) throw new Error(`不支持的附件类型：${unsupported.mimeType}。当前只接受图片和 MP3/WAV 音频。`);
    const modelAlias = this.options.modelManager?.getInfo().modelAlias ?? this.options.config.defaultModel;
    const model = this.options.config.models[modelAlias];
    if (!model) throw new Error(`当前模型配置不存在：${modelAlias}`);
    const capabilities = modelCapabilities(model);
    const image = attachments.find((attachment) => attachment.mimeType.startsWith("image/"));
    if (image && !capabilities.vision) {
      throw new Error(`当前模型 ${modelAlias} 未声明 vision 能力，无法发送图片附件。请切换到支持图片的模型，或在模型配置中明确启用 capabilities.vision。`);
    }
    const audio = attachments.find((attachment) => attachment.mimeType.startsWith("audio/"));
    if (audio && !capabilities.audio) {
      throw new Error(`当前模型 ${modelAlias} 未声明 audio 能力，无法发送音频附件。请切换到支持音频的模型，或在模型配置中明确启用 capabilities.audio。`);
    }
    if (audio && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(audio.mimeType)) {
      throw new Error(`不支持的音频类型：${audio.mimeType}。当前只接受 MP3 或 WAV。`);
    }
  }

  observeModelUsage(
    usage: AgentUsage,
    operation: "agent" | "plan" | "compaction" | "memory" | "subagent",
    modelAlias?: string
  ): void {
    this.recordModelUsage(usage, operation, modelAlias);
  }

  private async enqueueCompletedMemoryCandidate(
    task: string,
    answer: string,
    messages: AgentMessage[],
    personalization: ResolvedChatPersonalization,
    runOptions: AgentRunOptions
  ): Promise<void> {
    if (!personalization.contributeMemories) return;
    const sessionId = this.recorder.sessionId;
    const turnId = runOptions.turnId;
    const runId = runOptions.runId;
    if (!turnId || !runId) return;
    const externalContext = this.usedExternalContext(messages);
    const summary = completedMemoryCandidateSummary(task, answer);
    if (!summary) return;
    const input = {
      summary,
      completed: true as const,
      lineage: {
        source: "completed_task" as const,
        sessionId,
        turnId,
        runId,
        externalContext
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const overview = await this.localMemory.getOverview();
      try {
        await this.localMemory.enqueueCandidate(input, {
          expectedRevision: overview.scopes.project.revision,
          excludeExternalContext: personalization.excludeExternalContext
        });
        return;
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt > 0) throw error;
      }
    }
  }

  private usedExternalContext(messages: readonly AgentMessage[]): boolean {
    const externalTools = new Set(
      this.options.toolRegistry.listEntries()
        .filter((entry) => entry.source === "mcp" || entry.source === "plugin" || entry.source === "subagent")
        .map((entry) => entry.tool.name)
    );
    externalTools.add("web_search");
    externalTools.add("web_fetch");
    return messages.some((message) => message.role === "assistant" && message.content.some(
      (part) => part.type === "toolCall" && externalTools.has(part.name)
    ));
  }

  async compactConversation(hint?: string, signal?: AbortSignal): Promise<string> {
    const release = this.beginOperation("conversation compaction");
    try {
    const usageBeforeCompaction = this.usageRecords.length;
    const result = await this.contextMemory.compact(hint, signal);
    if (result.compacted) this.persistContextCheckpoint(result, "manual", this.contextMessageReferences);
    const compactionUsage = this.usageRecords.slice(usageBeforeCompaction).at(-1);
    this.recorder.record({
      type: "assistant_message",
      content: "",
      reasoningContent: undefined,
      usage: compactionUsage,
      contextState: this.contextMemory.snapshot()
    });
    return this.contextMemory.formatCompaction(result);
    } finally {
      release();
    }
  }

  private persistContextCheckpoint(
    result: CompactionResult,
    reason: "threshold" | "overflow" | "manual",
    sourceReferences: Array<SessionMessageReference | undefined>,
    nextKeptReference?: SessionMessageReference
  ): SessionContextCheckpoint | undefined {
    if (!result.compacted || !result.summary) return undefined;
    const retainedReferences = sourceReferences.slice(result.compactedMessageCount);
    const firstKept = retainedReferences.find((reference) => reference !== undefined) ?? nextKeptReference;
    const checkpoint: SessionContextCheckpoint = {
      summary: result.summary,
      firstKeptMessageId: firstKept?.id,
      firstKeptMessageIndex: firstKept?.index ?? this.nextSessionMessageIndex,
      tokensBefore: Math.max(0, Math.round(result.tokensBefore)),
      compactedMessages: this.contextMemory.snapshot().compactedMessages,
      createdAt: new Date().toISOString()
    };
    this.recorder.record({ type: "context_checkpoint", reason, ...checkpoint });
    this.contextMessageReferences = retainedReferences;
    this.contextMemory.setCheckpoint(checkpoint);
    return checkpoint;
  }

  listModels(): ModelChoice[] {
    return this.options.modelManager?.listModels() ?? listModelChoices(this.options.config);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const release = this.beginOperation("model switch");
    try {
    if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
    return await this.options.modelManager.switchModel(alias, thinking);
    } finally {
      release();
    }
  }

  async refreshModelFromDisk(): Promise<ModelRuntimeInfo> {
    const release = this.beginOperation("model refresh");
    try {
    if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
    return await this.options.modelManager.refreshFromDisk();
    } finally {
      release();
    }
  }

  async refreshModelCatalog(providerAlias?: string): Promise<ModelChoice[]> {
    const release = this.beginOperation("model catalog refresh");
    try {
      if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
      await this.options.modelManager.refreshModelCatalog(providerAlias);
      return this.options.modelManager.listModels();
    } finally {
      release();
    }
  }

  getInfo(): AgentSessionInfo {
    const model = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    return {
      workspaceRoot: this.options.workspaceRoot,
      sessionId: this.recorder.sessionId,
      sessionFile: this.recorder.filePath,
      ...model,
      skills: this.skillPaths()
    };
  }

  getPermissionMode(): PermissionMode {
    return this.options.permissionManager.getStatus().mode;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const release = this.beginOperation("permission update");
    const previousMode = this.options.permissionManager.getStatus().mode;
    try {
      this.options.permissionManager.setMode(mode);
      this.options.config.permission.mode = mode;
      await this.savePermissionMode(mode);
    } catch (error) {
      this.options.permissionManager.setMode(previousMode);
      this.options.config.permission.mode = previousMode;
      throw error;
    } finally {
      release();
    }
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    const release = this.beginOperation("permission command");
    const previousMode = this.options.permissionManager.getStatus().mode;
    try {
      const output = runPermissionCommand(this.options.permissionManager, args);
      const nextMode = this.options.permissionManager.getStatus().mode;
      if (nextMode !== previousMode) {
        this.options.config.permission.mode = nextMode;
        try {
          await this.savePermissionMode(nextMode);
        } catch (error) {
          this.options.permissionManager.setMode(previousMode);
          this.options.config.permission.mode = previousMode;
          throw error;
        }
      }
      return output;
    } finally {
      release();
    }
  }

  recordError(error: unknown): void {
    this.recorder.record({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      relatedUsage: this.takeRelatedUsage()
    });
  }

  private async recordModelRequest(metrics: ModelRequestMetrics): Promise<void> {
    const requestContext = {
      sessionId: this.recorder.sessionId,
      ...(metrics.requestContext ?? {}),
      relatedToolCallIds: metrics.requestContext?.relatedToolCallIds === undefined
        ? undefined
        : [...metrics.requestContext.relatedToolCallIds]
    };
    const recordedMetrics: ModelRequestMetrics = {
      ...metrics,
      attempts: metrics.attempts.map((attempt) => ({ ...attempt })),
      requestContext
    };
    this.modelRequestRecords.push(recordedMetrics);
    if (this.modelRequestRecords.length > 2_000) this.modelRequestRecords.shift();
    const runtime = requestContext.runId !== undefined && requestContext.turnId !== undefined
      ? { runId: requestContext.runId, turnId: requestContext.turnId }
      : undefined;
    try {
      this.recorder.recordWithRuntimeContext({ type: "model_request", metrics: recordedMetrics }, runtime);
    } catch {
      // 请求观测是旁路；session/authority 写入失败不能改变 provider 结果。
    }
    await recordNativeTelemetry(this.options.config, this.options.workspaceRoot, {
      type: "request",
      provider: recordedMetrics.provider,
      modelId: recordedMetrics.modelId,
      metrics: recordedMetrics
    });
  }

  private async recordTurnOutcome(outcome: AgentTurnOutcome): Promise<RuntimeHighWater | undefined> {
    const context = this.recorder.runtimeContextSnapshot();
    if (context) return await this.ensureTerminalOutcome(context.runId, context.turnId, outcome);
    const recorded = await this.recorder.recordAndFlush({
      type: "turn_status",
      status: outcome.status,
      stopReason: outcome.stopReason,
      finishReason: outcome.finishReason,
      steps: outcome.steps,
      summary: outcome.error,
      resumable: outcome.resumable,
      blockedReason: outcome.blockedReason,
      requiredAction: outcome.requiredAction,
      affectedTodoIds: outcome.affectedTodoIds
    });
    return recorded.runtime;
  }

  /**
   * Host 层收尾时的幂等终态入口。正常 Agent Loop 已经写过 turn_status；
   * 未捕获异常等宿主级失败则由这里补一条 canonical terminal fact。
   */
  async readTerminalOutcome(
    runId: string,
    turnId: string
  ): Promise<Extract<SessionEvent, { type: "turn_status" }> | undefined> {
    await this.recorder.flush();
    const events = await readSessionEvents(this.recorder.filePath);
    const terminals = runtimeEventsForRun(events, runId)
      .filter((event): event is Extract<SessionEvent, { type: "turn_status" }> => event.type === "turn_status");
    if (terminals.length > 1) throw new Error(`Run ${runId} has multiple canonical terminal events.`);
    const terminal = terminals[0];
    if (terminal?.runtime && terminal.runtime.turnId !== turnId) {
      throw new Error(`Run ${runId} terminal event belongs to another turn.`);
    }
    return terminal;
  }

  async ensureTerminalOutcome(runId: string, turnId: string, outcome: AgentTurnOutcome): Promise<RuntimeHighWater> {
    const terminal = await this.readTerminalOutcome(runId, turnId);
    const existing = terminal?.runtime;
    if (existing) {
      if (!sameTerminalOutcome(terminal, outcome)) {
        throw new Error(`Run ${runId} already has a conflicting terminal outcome.`);
      }
      return existing;
    }
    const previousContext = this.recorder.runtimeContextSnapshot();
    this.recorder.setRuntimeContext({ runId, turnId });
    try {
      const recorded = await this.recorder.recordAndFlush({
        type: "turn_status",
        status: outcome.status,
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        summary: outcome.error,
        resumable: outcome.resumable,
        blockedReason: outcome.blockedReason,
        requiredAction: outcome.requiredAction,
        affectedTodoIds: outcome.affectedTodoIds
      });
      if (!recorded.runtime) throw new Error(`Run ${runId} terminal event has no runtime identity.`);
      return recorded.runtime;
    } finally {
      this.recorder.setRuntimeContext(previousContext);
    }
  }

  recordHostedUserMessage(content: string): void {
    this.assertNotQuarantined("hosted user message");
    this.recorder.record({
      type: "user_message",
      content,
      skills: this.skillPaths(),
      auditOnly: true
    });
  }

  recordHostedAssistantMessage(content: string): void {
    this.recorder.record({ type: "assistant_message", content, auditOnly: true });
  }

  recordHostedToolCall(tool: string, args: unknown, toolCallId: string): number {
    this.assertNotQuarantined("hosted tool call");
    const sequence = this.recorder.nextToolCallSequence();
    this.recorder.record({ type: "tool_call", tool, args, toolCallId, sequence, auditOnly: true });
    return sequence;
  }

  recordHostedToolResult(tool: string, result: unknown, toolCallId: string, sequence: number): void {
    this.recorder.record({
      type: "tool_result",
      tool,
      result,
      toolCallId,
      sequence,
      relatedUsage: this.takeRelatedUsage(),
      auditOnly: true
    });
  }

  private takeQueuedRunMessages(
    queues: ActiveRunMessageQueues,
    delivery: "steer" | "followUp",
    previousAssistant: AgentAssistantMessage | undefined,
    referenceByMessage: WeakMap<AgentMessage, SessionMessageReference>
  ): AgentUserMessage[] {
    const pending = delivery === "steer" ? queues.steering : queues.followUps;
    if (!pending.length) return [];
    this.recordIntermediateAssistant(queues, previousAssistant);
    const items = pending.splice(0, pending.length);
    for (const item of items) {
      const reference = this.recordCanonicalMessage({
        type: "user_message",
        content: item.input,
        attachments: sessionAttachments(item.attachments),
        skills: this.skillPaths(),
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        messageId: item.messageId
      });
      referenceByMessage.set(item.message, reference);
      queues.delivered.set(item.message, item);
    }
    return items.map((item) => item.message);
  }

  private recordCanonicalMessage(
    event: Extract<SessionEvent, { type: "user_message" | "agent_message" }>
  ): SessionMessageReference {
    const recorded = this.recorder.record(event);
    const reference = {
      id: "messageId" in recorded ? recorded.messageId : undefined,
      index: this.nextSessionMessageIndex
    };
    this.nextSessionMessageIndex += 1;
    return reference;
  }

  private recordIntermediateAssistant(
    queues: ActiveRunMessageQueues,
    message: AgentAssistantMessage | undefined
  ): void {
    if (!message || queues.projectedAssistants.has(message)) return;
    queues.projectedAssistants.add(message);
    const blocks = reasoningBlocks(message);
    this.recorder.record({
      type: "assistant_message",
      content: agentMessageText(message),
      reasoningContent: blocks?.map((block) => block.text).join("") || undefined,
      reasoningProviderOptions: blocks?.length === 1 ? blocks[0]?.providerOptions : undefined,
      reasoningBlocks: blocks
    });
  }

  async close(): Promise<void> {
    await this.contextMemory.shutdownMemory();
    const relatedUsage = this.takeRelatedUsage();
    if (relatedUsage) {
      this.recorder.record({
        type: "assistant_message",
        content: "",
        relatedUsage,
        contextState: this.contextMemory.persistedState()
      });
    }
    await this.recorder.close();
  }

  private beginOperation(operation: string): () => void {
    if (this.activeOperation) throw new Error(`Cannot start ${operation} while ${this.activeOperation} is running.`);
    this.assertNotQuarantined(operation);
    this.activeOperation = operation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperation = undefined;
    };
  }

  private assertNotQuarantined(operation: string): void {
    const lingering = this.lingeringExternalTools.values().next().value as { tool: string; toolCallId: string } | undefined;
    if (lingering) {
      throw new Error(`Cannot start ${operation}: this agent session is quarantined while cancelled external tool ${lingering.tool} (${lingering.toolCallId}) is still settling.`);
    }
  }

  private recordModelUsage(
    usage: AgentUsage,
    operation: "agent" | "plan" | "compaction" | "memory" | "subagent",
    modelAlias?: string
  ): SessionUsage {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    const info = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    const resolvedAlias = modelAlias ?? info.modelAlias;
    const resolved = this.options.config.models[resolvedAlias];
    const catalogPricing = this.options.modelManager?.listModels().find((choice) => choice.alias === resolvedAlias)?.pricing;
    const provider = resolved ? this.options.config.providers[resolved.provider] : undefined;
    const modelInfo: UsageModelInfo = {
      modelAlias: resolvedAlias,
      provider: provider?.type ?? info.provider,
      model: resolved?.model ?? (model ? modelIdentifier(model) : info.modelLabel),
      pricing: resolved?.pricing ?? catalogPricing ?? info.pricing
    };
    const record = createSessionUsage(usage, operation, modelInfo);
    this.usageRecords.push(record);
    if (operation === "subagent" || operation === "memory") this.unpersistedRelatedUsage.push(record);
    return record;
  }

  private takeRelatedUsage(): SessionUsage[] | undefined {
    if (!this.unpersistedRelatedUsage.length) return undefined;
    return this.unpersistedRelatedUsage.splice(0, this.unpersistedRelatedUsage.length);
  }

  private runtimeContext(
    runOptions: AgentRunOptions,
    beforeWorkspaceMutation?: () => Promise<void>
  ): AgentRuntimeContext {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) throw new Error("Native model runtime is not configured.");
    return {
      workspaceRoot: this.options.workspaceRoot,
      config: this.options.config,
      model,
      recorder: this.recorder,
      contextMemory: this.contextMemory,
      toolRegistry: this.options.toolRegistry,
      permissionManager: this.options.permissionManager,
      confirmPermission: runOptions.confirmPermission,
      createCheckpoint: this.options.createCheckpoint,
      beforeWorkspaceMutation,
      quarantineExternalTool: (tool, toolCallId, settlement) => {
        if (this.lingeringExternalTools.has(settlement)) return;
        this.lingeringExternalTools.set(settlement, { tool, toolCallId });
        void settlement.then(
          () => this.lingeringExternalTools.delete(settlement),
          () => this.lingeringExternalTools.delete(settlement)
        );
      },
      abortSignal: runOptions.abortSignal,
      capabilities: this.options.capabilities,
      runId: runOptions.runId,
      turnId: runOptions.turnId
    };
  }

  private persistenceRoot(): string {
    return this.options.persistenceRoot ?? this.options.workspaceRoot;
  }

  private configStore(): AgentConfigStore {
    return this.options.configStore ?? createFileConfigStore(this.persistenceRoot());
  }

  private async readPersonalizationState(
    supplied?: { config: AgentConfig; revision: string }
  ): Promise<{ state: AgentPersonalizationState; config: AgentConfig }> {
    const store = this.options.configStore;
    const snapshot = supplied ?? (store?.loadVersioned
      ? await store.loadVersioned(this.options.workspaceRoot)
      : store
        ? { config: await store.load(this.options.workspaceRoot), revision: undefined }
        : { config: this.options.config, revision: undefined });
    const record = await readSessionCatalogRecord(this.persistenceRoot(), this.recorder.sessionId);
    const override = record?.personalization === undefined
      ? cloneChatPersonalizationOverride(defaultChatPersonalizationOverride)
      : chatPersonalizationOverrideSchema.parse(record.personalization);
    const resolved = resolveChatPersonalization(
      snapshot.config.personalization,
      snapshot.config.context.memory,
      override
    );
    return {
      config: snapshot.config,
      state: {
        global: { ...snapshot.config.personalization },
        memory: { ...snapshot.config.context.memory },
        override: cloneChatPersonalizationOverride(override),
        resolved: { ...resolved },
        catalogRevision: record === undefined
          ? SESSION_CATALOG_MISSING_REVISION
          : sessionCatalogRecordRevision(record),
        configRevision: snapshot.revision
      }
    };
  }

  /**
   * 只把权限模式写回配置文件。
   *
   * 内存里的 config 是运行时创建时读到的快照，之后可能已经落后于磁盘（桌面端多个项目共用
   * 同一份配置，别的运行时切模型、刷新 OAuth token 都会改盘上的内容）。整份写回会把这些改动
   * 覆盖掉——表现出来就是「改一次权限模式，模型被切回旧的默认模型」。因此这里读盘后只改
   * `permission.mode` 再保存。
   */
  private async savePermissionMode(mode: PermissionMode): Promise<void> {
    const store = this.configStore();
    const persisted = await store.load(this.options.workspaceRoot);
    persisted.permission.mode = mode;
    await store.save(persisted, this.options.workspaceRoot);
  }

  private supportedAttachments(attachments: AgentAttachment[] | undefined): AgentAttachment[] {
    const native = attachments?.filter((attachment) => Boolean(attachment.data)) ?? [];
    this.assertAttachmentsSupported(native);
    return native;
  }

  private async rehydrateSessionAttachments(
    messages: AgentMessage[],
    events: SessionReplay["events"],
    firstUserEventIndex = 0
  ): Promise<AgentMessage[]> {
    if (!this.options.attachmentRoot) return messages;
    const userEvents = events.filter((event): event is Extract<typeof event, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly);
    let userIndex = firstUserEventIndex;
    const hydrated: AgentMessage[] = [];
    for (const message of messages) {
      if (message.role !== "user") {
        hydrated.push(message);
        continue;
      }
      const event = userEvents[userIndex];
      userIndex += 1;
      const attachments = await Promise.all((event?.attachments ?? []).map(async (attachment) => await readAttachment(this.options.attachmentRoot!, attachment)));
      const files = attachments.filter((attachment): attachment is AgentAttachment => attachment !== undefined);
      this.assertAttachmentsSupported(files);
      if (!files.length || typeof message.content !== "string") {
        hydrated.push(message);
        continue;
      }
      hydrated.push({
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...files.map((attachment) => ({
            type: attachment.mimeType.startsWith("audio/") ? "audio" as const : "image" as const,
            data: attachment.data,
            mimeType: attachment.mimeType
          }))
        ]
      });
    }
    return hydrated;
  }
}

function agentMessageText(message: AgentAssistantMessage): string {
  return message.content.filter((part): part is Extract<AgentAssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function queuedUserMessage(input: string, attachments: AgentAttachment[]): AgentUserMessage {
  if (!attachments.length) return { role: "user", content: input };
  return {
    role: "user",
    content: [
      { type: "text", text: input },
      ...attachments.map((attachment) => ({
        type: attachment.mimeType.startsWith("audio/") ? "audio" as const : "image" as const,
        data: attachment.data,
        mimeType: attachment.mimeType
      }))
    ]
  };
}

function reasoningBlocks(message: AgentAssistantMessage): ReasoningBlock[] | undefined {
  const blocks = message.content
    .filter((part): part is Extract<AgentAssistantMessage["content"][number], { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => ({ text: part.text, providerOptions: part.providerMetadata }));
  return blocks.length ? blocks : undefined;
}

function modelIdentifier(model: AgentModel): string {
  return model.modelId;
}

function maxToolCallSequence(events: SessionReplay["events"]): number {
  return events.reduce((maximum, event) => {
    if ((event.type !== "tool_call" && event.type !== "tool_result") || typeof event.sequence !== "number") return maximum;
    return Math.max(maximum, event.sequence);
  }, 0);
}

function doneEvent(outcome: AgentTurnOutcome): Extract<AgentSessionEvent, { type: "done" }> {
  return {
    type: "done",
    content: outcome.output,
    usage: outcome.usage,
    outcome
  };
}

function completionOutcome(
  decision: Exclude<CompletionDecision, { kind: "continue" }>,
  output: string,
  finishReason: string | undefined,
  steps: number,
  usage?: SessionUsage
): AgentTurnOutcome {
  if (decision.kind === "complete") {
    return { status: "completed", stopReason: "completion_gate", finishReason, steps, output, usage };
  }
  if (decision.kind === "blocked") {
    return {
      status: "blocked",
      stopReason: "blocked",
      finishReason,
      steps,
      output,
      usage,
      error: decision.summary,
      resumable: decision.reason !== "missing_user_input" && decision.reason !== "unsafe_action_required",
      blockedReason: decision.reason,
      requiredAction: decision.requiredAction,
      affectedTodoIds: decision.affectedTodoIds
    };
  }
  if (decision.kind === "incomplete") {
    return {
      status: "incomplete",
      stopReason: decision.reason === "model_output_limit" ? "model_length" : decision.reason,
      finishReason,
      steps,
      output,
      usage,
      error: decision.summary,
      resumable: decision.resumable
    };
  }
  return {
    status: "cancelled",
    stopReason: "cancelled",
    finishReason,
    steps,
    output,
    usage,
    error: "Current turn was cancelled."
  };
}

function failedTurn(
  message: string,
  steps: number,
  stopReason: "timeout" | "provider_error" = "provider_error"
): AgentTurnOutcome {
  return {
    status: "failed",
    stopReason,
    finishReason: undefined,
    steps,
    output: "",
    usage: undefined,
    error: message || "Agent run failed."
  };
}

function cancelledTurn(message: string, steps: number): AgentTurnOutcome {
  return {
    status: "cancelled",
    stopReason: "cancelled",
    finishReason: undefined,
    steps,
    output: "",
    usage: undefined,
    error: message
  };
}

function createCompletionGateVerifier(options: {
  workspaceRoot: string;
  ignore?: string[];
  managedProcesses?: ManagedProcessInspector;
  commandExecutor: AcceptanceCommandExecutor;
}): CompletionGateVerifier {
  const verifier = new AcceptanceVerifier({
    workspaceRoot: options.workspaceRoot,
    ignore: options.ignore,
    managedProcesses: options.managedProcesses,
    commandExecutor: options.commandExecutor
  });
  let plan: AgentVerificationPlan = { required: false, criteria: [], reasons: [] };
  return {
    derive: async (
      facts: RunFacts,
      requestedChecks: readonly StructuredVerificationCheck[]
    ): Promise<CompletionVerification> => {
      const checks: NonNullable<AgentVerificationFacts["checks"]> = requestedChecks.flatMap((check) => {
        if (check.kind !== "command" || !check.command) return [];
        return [{
          id: check.id,
          command: check.command,
          cwd: check.cwd,
          timeoutMs: undefined,
          description: check.description
        }];
      });
      const processes = new Map<string, NonNullable<AgentVerificationFacts["startedProcesses"]>[number]>();
      for (const processId of facts.startedProcessIds) {
        const process = facts.activeProcesses.find((candidate) => candidate.processId === processId);
        const readinessType = processReadinessType(process?.readiness);
        processes.set(processId, {
          processId,
          cwd: process?.cwd,
          url: process?.url,
          readinessType,
          requireHttpReadiness: readinessType === "http" ? true : undefined,
          description: process?.command
        });
      }
      for (const check of requestedChecks) {
        if (check.kind !== "managed_process" || !check.processId) continue;
        processes.set(check.processId, {
          processId: check.processId,
          cwd: check.cwd,
          url: undefined,
          readinessType: undefined,
          requireHttpReadiness: undefined,
          description: check.description
        });
      }
      plan = await deriveAgentVerificationPlan(
        options.workspaceRoot,
        {
          changedFiles: facts.changedFiles,
          workspaceMutationObserved: facts.workspaceMutationObserved,
          userRequestedVerification: facts.userRequestedVerification,
          checks,
          startedProcesses: [...processes.values()]
        },
        options.ignore
      );
      return {
        required: plan.required,
        checks: requestedChecks.map((check) => ({ ...check }))
      };
    },
    verify: async (
      _requirement: CompletionVerification,
      signal?: AbortSignal
    ): Promise<VerificationFact> => {
      const result = await verifier.verifyCriteria(plan.criteria, {
        signal,
        requireCriteria: true
      });
      return {
        passed: result.passed,
        summary: result.summary,
        evidence: result.evidence.map((evidence) => ({
          id: evidence.criterionId,
          passed: evidence.passed,
          summary: evidence.summary,
          details: evidence.details
        }))
      };
    }
  };
}

async function refreshRunFacts(
  facts: RunFactsCollector,
  workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined,
  workspaceRoot: string,
  ignore: string[],
  managedProcesses?: ManagedProcessInspector
): Promise<void> {
  if (workspaceBaseline) {
    try {
      const [before, after] = await Promise.all([
        workspaceBaseline,
        captureWorkspaceState(workspaceRoot, ignore)
      ]);
      facts.setChangedFiles(diffWorkspaceStates(before, after).changedFiles);
    } catch {
      // 已知文件工具的路径已经由 RunFactsCollector 记录；快照失败时保留这些事实。
    }
  }
  if (!managedProcesses) return;
  let processes: Awaited<ReturnType<ManagedProcessInspector["listProcesses"]>>;
  try {
    processes = await managedProcesses.listProcesses();
  } catch {
    return;
  }
  facts.setActiveProcesses(processes.map((process): ProcessFact => ({
    processId: process.processId,
    state: process.state,
    command: process.command,
    cwd: process.cwd,
    url: process.url,
    readiness: process.readiness
  })));
}

function processReadinessType(value: unknown): "http" | "tcp" | "log" | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const type = value.type;
  return type === "http" || type === "tcp" || type === "log" ? type : undefined;
}

function restoreCompletionState(
  store: CompletionStateStore | undefined,
  events: SessionReplay["events"]
): void {
  if (!store) return;
  store.reset();
  for (const event of events) {
    if (event.type === "user_message" && !event.auditOnly) {
      store.reset();
      continue;
    }
    if (event.type !== "tool_result") continue;
    if (event.tool === "report_blocked") {
      const blocked = readBlockedState(event.result);
      if (blocked) store.reportBlocked(blocked);
    } else if (event.tool === "request_verification") {
      const checks = readVerificationChecks(event.result);
      if (checks) store.replaceChecks(checks);
    }
  }
}

function readBlockedState(value: unknown): ReturnType<CompletionStateStore["getBlocked"]> {
  if (!isRecord(value)) return undefined;
  const reason = value.reason;
  if (
    reason !== "missing_user_input"
    && reason !== "waiting_for_approval"
    && reason !== "permission_denied"
    && reason !== "missing_dependency"
    && reason !== "environment_unavailable"
    && reason !== "external_service_failure"
    && reason !== "unsafe_action_required"
  ) return undefined;
  if (typeof value.summary !== "string" || !value.summary) return undefined;
  const requiredAction = typeof value.requiredAction === "string" ? value.requiredAction : undefined;
  const affectedTodoIds = Array.isArray(value.affectedTodoIds)
    ? value.affectedTodoIds.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    reason,
    summary: value.summary,
    requiredAction,
    affectedTodoIds
  };
}

function readVerificationChecks(value: unknown): StructuredVerificationCheck[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.checks)) return undefined;
  const checks = value.checks.flatMap((item): StructuredVerificationCheck[] => {
    if (
      !isRecord(item)
      || item.kind !== "command"
      || typeof item.id !== "string"
      || typeof item.description !== "string"
      || typeof item.command !== "string"
    ) return [];
    return [{
      id: item.id,
      kind: "command",
      description: item.description,
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      processId: undefined
    }];
  });
  return checks.length ? checks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completedMemoryCandidateSummary(task: string, answer: string): string | undefined {
  const taskSummary = boundedCandidateText(task, 600);
  const outcomeSummary = boundedCandidateText(answer, 1_200);
  // 短寒暄和一次性确认不具备可复用价值。门槛只计算脱敏后的真实内容，
  // 不能让固定的标签或占位符把 hi/ok 之类的回合推过 durable 候选门槛。
  if (Array.from(`${taskSummary}\n${outcomeSummary}`).length < 180) return undefined;
  return [
    `Completed task: ${taskSummary || "(no public task summary)"}`,
    `Outcome: ${outcomeSummary || "(no public outcome summary)"}`
  ].join("\n");
}

function boundedCandidateText(value: string, maxCharacters: number): string {
  const normalized = redactSecrets(value).replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

function readRunFacts(value: unknown): RunFacts | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.actualToolCallCount)
    || typeof value.actualToolCallCount !== "number"
    || value.actualToolCallCount < 0
    || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.executedCommands)
    || !Array.isArray(value.failedToolCalls)
    || !Number.isSafeInteger(value.pendingApprovals)
    || typeof value.pendingApprovals !== "number"
    || !Number.isSafeInteger(value.activeToolCalls)
    || typeof value.activeToolCalls !== "number"
    || !Array.isArray(value.activeProcesses)
    || !Array.isArray(value.startedProcessIds)
    || !Array.isArray(value.verificationResults)
    || typeof value.userCancelled !== "boolean"
    || !Number.isSafeInteger(value.maxRepeatedActionCount)
    || typeof value.maxRepeatedActionCount !== "number"
  ) return undefined;
  return structuredClone(value) as unknown as RunFacts;
}

function restartRunFactsBudget(facts: RunFacts | undefined, restartBudget: boolean): RunFacts | undefined {
  if (!facts || !restartBudget) return facts;
  return {
    ...facts,
    actualToolCallCount: 0,
    pendingApprovals: 0,
    activeToolCalls: 0,
    userCancelled: false,
    maxRepeatedActionCount: 0
  };
}

function runtimeContinuationMessage(terminal: InterruptedTurnTerminal): AgentUserMessage {
  return {
    role: "user",
    content: [
      "## Biny runtime continuation",
      "",
      `The previous run stopped as ${terminal.status} (${terminal.stopReason}): ${terminal.summary}`,
      "The user explicitly requested continuation. Re-evaluate the remaining structured facts and continue the same task without repeating completed work."
    ].join("\n")
  };
}

function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|deadline/i.test(`${error.name} ${error.message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameTerminalOutcome(
  event: Extract<SessionEvent, { type: "turn_status" }>,
  outcome: AgentTurnOutcome
): boolean {
  return event.status === outcome.status
    && event.stopReason === outcome.stopReason
    && event.finishReason === outcome.finishReason
    && event.steps === outcome.steps
    && event.summary === outcome.error
    && event.resumable === outcome.resumable
    && event.blockedReason === outcome.blockedReason
    && event.requiredAction === outcome.requiredAction
    && sameStringArray(event.affectedTodoIds, outcome.affectedTodoIds);
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sessionAttachments(attachments: AgentAttachment[] | undefined): AttachmentReference[] | undefined {
  const references = attachments
    ?.filter((attachment) => Boolean(attachment.path))
    .map(({ name, mimeType, path: virtualPath, size }) => ({ name, mimeType, path: virtualPath!, size }));
  return references?.length ? references : undefined;
}
