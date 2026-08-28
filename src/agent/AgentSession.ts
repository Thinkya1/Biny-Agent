import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configSchema, type AgentConfig } from "../config/schema.js";
import { createFileConfigStore, updateConfig, type AgentConfigStore } from "../config/store.js";
import { globalAgentDir } from "../config/paths.js";
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
import { assertSessionFileSize } from "../session/limits.js";
import { cachedSessionEvents, sessionFileFingerprint } from "../session/parseCache.js";
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
import { ToolExecutionCoordinator, type ToolExecutionBudgetSnapshot } from "./toolExecutionCoordinator.js";
import {
  buildSystemPrompt,
  personalizationRuntimePolicyFromSystemPrompt,
  refreshRuntimeSystemPrompt,
  systemPromptForTelemetry,
  withActiveRunCompactionSummary
} from "./prompts.js";
import { selectPlanTools } from "./planMode.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResult,
  AgentRuntimeContext,
  AgentToolEvent,
  AgentSessionEvent,
  AgentTurnOutcome
} from "./types.js";
import {
  CompletionGuard,
  parseCompletionGuardSnapshot,
  type CompletionGuardDecision,
  type CompletionGuardSnapshot
} from "./completionGuard.js";
import { evaluateCompletion } from "./completionReview.js";
import { ContextMemory } from "./context/ContextMemory.js";
import { LocalMemory, withFreshRevision, redactSecrets } from "./context/LocalMemory.js";
import { TelosStorage } from "./context/telosStorage.js";
import { IdentityStorage } from "./context/identityStorage.js";
import { proposeIdentityEvolution } from "./context/identityEvolution.js";
import type { IdentityProposal } from "./context/identityTypes.js";
import { runMemoryCommand } from "./context/memoryCommands.js";
import { MemoryVectorIndex } from "./context/MemoryVectorIndex.js";
import { HybridMemoryRetriever } from "./context/HybridMemoryRetriever.js";
import {
  MemoryEmbeddingService,
  type MemoryEmbeddingRuntimeStatus
} from "./context/MemoryEmbeddingService.js";
import { parseMemoryCitations } from "./context/memoryCitations.js";
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
import { generateNativeText } from "../llm/nativeJson.js";
import { ProviderRegistry } from "../llm/ProviderRuntime.js";
import { LocalEmbeddingManager } from "../llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime, LocalEmbeddingModelId } from "../llm/embedding/types.js";
import { readAttachment, type AgentAttachment } from "../attachments/store.js";
import type { AttachmentReference } from "../attachments/store.js";
import { parseSkillDocument } from "../extensions/skillCatalog.js";
import { createSkillDraft } from "../extensions/skillDrafts.js";
import { TodoStore } from "../session/todoStore.js";
import { resolveRunBudget, type RunBudget } from "./runBudget.js";
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
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "./context/memoryTypes.js";

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
  /** Todo 真值源；session resume 与模型计划工具共用同一个实例。 */
  todoStore?: TodoStore;
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
  attachments?: AgentAttachment[];
  /** Runtime host 为本次执行分配的 invocation identity。 */
  runId?: string;
  /** 同一个根任务及其 continuation 共用的稳定 turn identity。 */
  turnId?: string;
}

export type AgentPromptOptions = Pick<
  AgentRunOptions,
  "abortSignal" | "confirmPermission" | "mode" | "attachments" | "runId" | "turnId"
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
  /** 按模型有效窗口比例计算的可用输入窗口。 */
  effectiveContextWindow?: number;
  effectiveContextWindowPercent?: number;
  contextReserveTokens?: number;
  autoCompactTokenLimit?: number;
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
    initialToolBudget?: ToolExecutionBudgetSnapshot;
    initialCompletionEvidence?: CompletionGuardSnapshot;
    previousTerminals?: InterruptedTurnTerminal[];
  };
  abortSignal: AbortSignal;
  mode: AgentRunMode;
  runBudget: RunBudget;
  completedStepsBeforeRun: number;
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
type MemoryModelField = "memoryModel" | "rewriteModel" | "extractModel" | "consolidationModel";

/**
 * Stateful core agent for one workspace. Hosts use this public surface instead
 * of reaching into the model, recorder, tools or mutable conversation directly.
 */
export class AgentSession {
  private readonly contextMemory: ContextMemory;
  private readonly localMemory: LocalMemory;
  private readonly telosStorage: TelosStorage;
  private readonly identityStorage: IdentityStorage;
  private readonly memoryModelFor: (field: MemoryModelField) => AgentModel;
  private readonly localEmbeddingManager: LocalEmbeddingManager;
  private readonly memoryRetriever: HybridMemoryRetriever;
  private readonly memoryEmbeddingService: MemoryEmbeddingService;
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
    // 抽取与整理可使用不同模型。getter 读取 root-turn 快照，因此外部配置变更不会让运行中的
    // turn 漂移；下一根回合才会切换。按 alias 缓存 adapter，避免每个候选重复创建。
    const memoryModels = new Map<string, AgentModel>();
    const memoryModel = (field: MemoryModelField): AgentModel => {
      const alias = this.activeConfig.context.memory[field]
        ?? (field === "memoryModel" ? undefined : this.activeConfig.context.memory.memoryModel);
      if (!alias) return getModel();
      const cached = memoryModels.get(alias);
      if (cached) return cached;
      const created = createNativeModelForConfig(this.activeConfig, alias);
      memoryModels.set(alias, created);
      return created;
    };
    this.memoryModelFor = memoryModel;
    const initialContextBudget = options.modelManager?.getContextBudget();
    this.localMemory = new LocalMemory(
      persistenceRoot,
      () => this.memoryModelFor("extractModel"),
      onUsage,
      undefined,
      onModelRequest,
      () => this.sideModelRequestContext(),
      () => this.memoryModelFor("consolidationModel")
    );
    this.telosStorage = new TelosStorage(options.workspaceRoot);
    this.identityStorage = new IdentityStorage();
    this.localEmbeddingManager = new LocalEmbeddingManager(path.join(globalAgentDir(), "models", "embeddings"));
    this.memoryEmbeddingService = new MemoryEmbeddingService({
      localMemory: this.localMemory,
      localManager: this.localEmbeddingManager,
      getVectorIndex: () => new MemoryVectorIndex(path.join(globalAgentDir(), "memory")),
      getActiveModel: () => this.activeConfig.context.memory.embeddingModel,
      getProviderModels: () => this.providerEmbeddingModels(),
      getRuntime: async () => await this.activeMemoryEmbeddingRuntime()
    });
    this.memoryRetriever = new HybridMemoryRetriever({
      localMemory: this.localMemory,
      workspaceRoot: options.workspaceRoot,
      getEmbeddingRuntime: async () => await this.memoryEmbeddingService.embeddingRuntime(),
      getVectorIndex: () => this.memoryEmbeddingService.vectorIndex(),
      getThresholds: (fingerprint, recommended) => (
        this.activeConfig.context.memory.similarityThresholds[fingerprint] ?? recommended
      ),
      queryRewriteEnabled: () => this.activePersonalization.queryRewrite,
      rewriteQuery: async (query, signal) => {
        const result = await generateNativeText(this.memoryModelFor("rewriteModel"), [{
          role: "user",
          content: [{
            type: "text",
            text: [
              "Rewrite the user's question as one concise semantic memory search query.",
              "Preserve concrete identifiers, paths and technical terms. Return only the query.",
              "",
              query
            ].join("\n")
          }]
        }], {
          signal,
          timeoutMs: 3_000,
          maxOutputTokens: 128,
          reasoning: "off",
          onRequestMetrics: onModelRequest,
          requestContext: { ...(this.sideModelRequestContext() ?? {}), operation: "memory" }
        });
        if (result.usage) await onUsage(result.usage, "memory");
        return result.text;
      },
      closeVectorIndex: false
    });
    // 压缩摘要可切换到更便宜的模型。与 memoryModel 一样读取 root-turn 快照；解析失败只
    // 打 warning 并回退当前对话模型，绝不让配置问题阻断会话压缩。按 alias 缓存成功结果。
    const summaryModels = new Map<string, AgentModel>();
    const resolveSummaryModel = (): AgentModel => {
      const alias = this.activeConfig.context.compaction.summaryModel;
      if (!alias) return getModel();
      const cached = summaryModels.get(alias);
      if (cached) return cached;
      try {
        const created = createNativeModelForConfig(this.activeConfig, alias);
        summaryModels.set(alias, created);
        return created;
      } catch (error) {
        console.warn(`[biny] 压缩摘要模型 ${alias} 解析失败，回退当前对话模型：${errorMessage(error)}`);
        return getModel();
      }
    };
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
      { ...options.config.context.compaction, resolveSummaryModel },
      onModelRequest,
      () => this.sideModelRequestContext(),
      this.memoryRetriever
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
    await this.telosStorage.initialize();
    await this.identityStorage.initialize();
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
        const message = `无法校验会话运行高水位，恢复已阻塞：${errorMessage(error)}`;
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
      const unknownToolNames = new Set(
        replay.recoveredToolResults
          .filter((event) => event.executionStatus === "unknown")
          .map((event) => event.tool)
      );
      // resume() 可能已经把合成结果写回 JSONL，不能只看本次 replay 新生成的结果。
      for (const event of replay.events) {
        if (
          event.type === "tool_result"
          && event.executionStatus === "unknown"
        ) unknownToolNames.add(event.tool);
      }
      if (unknownToolNames.size > 0) {
        const toolNames = [...unknownToolNames];
        const message = `${toolNames.join("、")} 可能产生了未确认的副作用，恢复已阻塞。`;
        const outcome: AgentTurnOutcome = {
          status: "blocked",
          stopReason: "blocked",
          steps: turn.completedSteps,
          output: "",
          error: message,
          resumable: false,
          blockedReason: "unsafe_action_required",
          requiredAction: "Inspect the session facts and workspace, then start a new turn after resolving the unknown tool operation."
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
        initialToolBudget: restartToolBudget(readToolBudget(turn.facts), turn.completedSteps === 0),
        initialCompletionEvidence: restartCompletionEvidence(
          readCompletionEvidence(turn.facts)
        ),
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

  /**
   * 当前配置下可用的嵌入运行时（记忆语义召回与活动语义搜索共用）。
   * 配置位于 context.memory.embeddingModel；本地模型直接构造运行时，云端模型要求
   * 已确认隐私同意。未配置或不可用时返回 undefined（调用方降级为文本检索）。
   */
  async getEmbeddingRuntime(): Promise<EmbeddingModelRuntime | undefined> {
    const ref = this.activeConfig.context.memory.embeddingModel;
    if (!ref) return undefined;
    if (ref.kind === "local") return await this.localEmbeddingManager.createRuntime(ref.model);
    const providers = new ProviderRegistry(this.activeConfig);
    const descriptor = providers.listEmbeddingModels().find((candidate) => (
      candidate.ref.kind === "provider"
      && candidate.ref.provider === ref.provider
      && candidate.ref.model === ref.model
    ));
    if (!descriptor?.endpoint || descriptor.available === false) {
      throw new Error(`Embedding model ${ref.provider}/${ref.model} is currently unavailable.`);
    }
    const endpointHash = descriptor.privacyEndpointHash;
    if (!endpointHash) throw new Error(`Embedding endpoint identity is unavailable for ${ref.provider}.`);
    const confirmed = Object.values(this.activeConfig.context.memory.cloudEmbeddingConsents)
      .some((consent) => consent.endpointHash === endpointHash);
    if (!confirmed) {
      throw new Error(`Cloud embedding privacy confirmation is required for ${ref.provider}.`);
    }
    return providers.createEmbeddingRuntime(ref);
  }

  /** TELOS 由独立存储维护；Desktop/Host 通过 AgentSession 取得同一份本地权威。 */
  getTelosStorage(): TelosStorage {
    return this.telosStorage;
  }

  /** 身份资料由同一个 AgentSession 读取，Desktop 也可通过本地存储服务复用这份权威。 */
  getIdentityStorage(): IdentityStorage {
    return this.identityStorage;
  }

  /** 空闲维护阶段从本地候选提出 STYLE/USER 演进；提案仍需 Desktop 人工接受。 */
  async proposeIdentityEvolution(signal?: AbortSignal): Promise<IdentityProposal | undefined> {
    await this.refreshMemoryConfig();
    if (!this.activeConfig.context.identity.enabled) return undefined;
    const scan = await this.localMemory.listEligibleCandidates({ limit: 8, signal });
    if (!scan.candidates.length) return undefined;
    const modelAlias = this.activeConfig.context.memory.extractModel
      ?? this.activeConfig.context.memory.memoryModel;
    return await proposeIdentityEvolution({
      storage: this.identityStorage,
      candidates: scan.candidates,
      model: this.memoryModelFor("extractModel"),
      signal,
      onUsage: async (usage, operation) => {
        this.recordModelUsage(usage, operation, modelAlias);
      },
      onRequestMetrics: (metrics) => this.recordModelRequest(metrics),
      requestContext: { ...(this.sideModelRequestContext() ?? {}), operation: "memory" }
    });
  }

  /** 手动浏览与自动召回共用混合检索；跨项目内容仅在显式选择对应 origin 时可见。 */
  async searchMemory(query: string, paths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.memoryRetriever.retrieve(query, paths, {
      limit: options.limit ?? this.localMemory.recallLimit,
      maxChars: options.maxChars,
      signal: options.signal,
      origins: options.origins,
      automatic: false
    });
  }

  async memoryEmbeddingStatus(): Promise<MemoryEmbeddingRuntimeStatus> {
    await this.refreshMemoryConfig();
    return await this.memoryEmbeddingService.status();
  }

  async downloadMemoryEmbeddingModel(model: LocalEmbeddingModelId, signal?: AbortSignal): Promise<void> {
    await this.refreshMemoryConfig();
    await this.memoryEmbeddingService.download(model, signal);
  }

  cancelMemoryEmbeddingDownload(model: LocalEmbeddingModelId): boolean {
    return this.memoryEmbeddingService.cancelDownload(model);
  }

  async removeMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<{ filesDeleted: number; bytesFreed: number }> {
    await this.refreshMemoryConfig();
    return await this.memoryEmbeddingService.removeLocalModel(model);
  }

  async rebuildMemoryEmbeddingIndex(signal?: AbortSignal): Promise<void> {
    await this.refreshMemoryConfig();
    await this.memoryEmbeddingService.rebuild(signal);
  }

  cancelMemoryEmbeddingRebuild(): boolean {
    return this.memoryEmbeddingService.cancelRebuild();
  }

  async indexMemoryEntry(entry: MemoryEntry): Promise<void> {
    // Markdown 已在调用前提交。配置瞬时读取失败也只能让该条目留待重建，不能把成功写入
    // 对外伪装成失败并诱发重复提交；旧快照若仍可用，Service 会安全尝试同指纹增量写。
    await this.refreshMemoryConfig().catch(() => undefined);
    await this.memoryEmbeddingService.indexEntry(entry);
  }

  removeMemoryEmbeddingEntries(entryIds: readonly string[]): void {
    this.memoryEmbeddingService.removeEntries(entryIds);
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
    const searchMemory = this.searchMemory.bind(this);
    return await runMemoryCommand(this.localMemory, args, searchMemory);
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
      initialToolBudget?: ToolExecutionBudgetSnapshot;
      initialCompletionEvidence?: CompletionGuardSnapshot;
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
    if (!Number.isSafeInteger(completedStepsBeforeRun) || completedStepsBeforeRun < 0) {
      throw new RangeError("Completed turn steps must be a non-negative safe integer.");
    }
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
    const permissionMode = this.options.permissionManager.getStatus().mode;
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
      // Plan 的协作状态独立于权限模式：普通权限收窄为只读工具，full-access 才恢复
      // 写入/执行工具；这与 Plan 提示词的分支必须使用同一份权限快照。
      const initialTools = mode === "plan"
        ? selectPlanTools(this.options.toolRegistry.list(), permissionMode)
        : this.options.toolRegistry.list();
      const telosPrompt = turnPersonalization.telos.enabled
        ? await this.telosStorage.promptText()
        : undefined;
      const identityPrompt = this.activeConfig.context.identity.enabled
        ? await this.identityStorage.promptText(this.activeConfig.context.identity.userEnabled)
        : undefined;
      const baseSystemPrompt = buildSystemPrompt({
        mode: mode === "plan" ? "plan" : "qa",
        permissionMode,
        extensionPrompt: this.extensionPrompt(),
        tools: initialTools,
        personalization: turnPersonalization,
        identityPrompt,
        telosPrompt,
        cwd: this.options.workspaceRoot
      });
      const prepared = await this.contextMemory.prepareTurn(
        input,
        baseSystemPrompt,
        abortSignal,
        this.supportedAttachments(runOptions.attachments),
        turnPersonalization.useMemories
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
    const permissionMode = this.options.permissionManager.getStatus().mode;
    this.contextMemory.observePromptModel(activeModelSettings.model.provider, activeModelSettings.model.modelId);
    let relatedToolCallIds: string[] = [];
    const modelRequestContext = (step: number): ModelRequestContext => ({
      sessionId: this.recorder.sessionId,
      runId: args.runOptions.runId,
      turnId: args.runOptions.turnId,
      step,
      operation: mode === "plan" ? "plan" : "agent",
      promptEpoch: this.contextMemory.getPromptEpoch(),
      promptEpochReason: this.contextMemory.getPromptEpochReason(),
      promptEpochCreatedAt: this.contextMemory.getPromptEpochCreatedAt(),
      relatedToolCallIds: [...relatedToolCallIds]
    });

    const permissionManager = this.options.permissionManager;
    const confirmPermission = runOptions.confirmPermission;
    const runtime = this.runtimeContext({ ...runOptions, abortSignal, confirmPermission });
    const allowedToolNames = mode === "plan"
      ? new Set(selectPlanTools(this.options.toolRegistry.list(), permissionMode).map((tool) => tool.name))
      : undefined;
    let stepAssistantContent = "";
    let stepReasoningOutput = "";
    let stepReasoningBlocks: ReasoningBlock[] | undefined;
    const pendingEvents: AgentSessionEvent[] = [];
    const completionGuard = new CompletionGuard(runOptions.initialCompletionEvidence);
    const emitUpdate = (event: AgentSessionEvent): void => {
      if (
        event.type === "tool.started"
        || event.type === "tool.progress"
        || event.type === "tool.completed"
        || event.type === "tool.failed"
      ) completionGuard.observeToolEvent(event as AgentToolEvent);
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
          {
            ...coordinator.getExecutionBudgetSnapshot(),
            completionEvidence: completionGuard.snapshot()
          },
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
        initialToolCallCount: runOptions.initialToolBudget?.accountedToolCalls,
        initialMaxRepeatedActionCount: runOptions.initialToolBudget?.maxRepeatedActionCount
      },
      persistToolResultCheckpoint
    );
    coordinatorRef.current = coordinator;

    const nativeContext: AgentContext = { systemPrompt, messages: [...messages], tools: [] };
    nativeContext.tools = activeModelSettings.model.supportsTools === false ? [] : coordinator.createAgentTools();
    this.contextMemory.recordToolSchema(nativeContext.tools);
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
    let hardStepLimitReached = false;
    let softLimitWarningInjected = completedStepsBeforeRun >= runBudget.softStepLimit;
    let contextRecoveryAttempts = 0;
    let completionDecision: Exclude<CompletionGuardDecision, { kind: "continue" }> | undefined;
    let pendingCompletionMessages: AgentMessage[] = [];

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
          // 与 prepareNextTurn 对齐：全局聊天参数显式配置时覆盖模型别名默认；未配置则不下发温度。
          // 首个请求也必须带，否则纯单步问答永远用不上用户配置。
          maxOutputTokens: this.activeConfig.chat.maxOutputTokens ?? activeModelSettings.maxOutputTokens,
          temperature: this.activeConfig.chat.temperature,
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
          this.contextMemory.observePromptModel(activeModelSettings.model.provider, activeModelSettings.model.modelId);
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
              // 全局聊天参数显式配置时覆盖模型别名默认；未配置则不下发温度。
              maxOutputTokens: this.activeConfig.chat.maxOutputTokens ?? settings.maxOutputTokens,
              temperature: this.activeConfig.chat.temperature,
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
                content: "## Biny run budget\n\nThe soft provider-step limit has been reached. Continue only if more work is needed for the user's request, and avoid repeating completed actions."
              }
            ];
          }
          return prunedMessages;
        },
        getSteeringMessages: async () => {
          const completionMessages = pendingCompletionMessages;
          pendingCompletionMessages = [];
          return [
            ...completionMessages,
            ...this.takeQueuedRunMessages(messageQueues, "steer", lastAssistant, referenceByMessage)
          ];
        },
        getFollowUpMessages: async () => {
          const next = this.takeQueuedRunMessages(messageQueues, "followUp", lastAssistant, referenceByMessage);
          if (!next.length) messageQueues.accepting = false;
          return next;
        },
        shouldStopAfterTurn: async (turn) => {
          // 工具调用后的 assistant 只代表“工具已经被请求”，必须先让 Loop 消费结构化结果。
          if (turn.message.content.some((part) => part.type === "toolCall")) return false;
          completionGuard.noteTextCompletionClaim(agentMessageText(turn.message));
          const budget = coordinator.getExecutionBudgetSnapshot();
          let decision = completionGuard.decide({
            steps: completedStepsBeforeRun + observedSteps,
            hardStepLimit: runBudget.hardStepLimit,
            accountedToolCalls: budget.accountedToolCalls,
            maxToolCalls: runBudget.maxToolCalls,
            maxRepeatedActionCount: budget.maxRepeatedActionCount,
            maxRepeatedActions: runBudget.maxRepeatedActions,
            finishReason: turn.message.stopReason,
            explicitCompletionExpected: mode !== "plan"
          });
          if (decision.kind === "continue") {
            pendingCompletionMessages.push(decision.feedback);
            return false;
          }
          if (
            decision.kind === "complete"
            && turn.message.stopReason === "stop"
            && mode !== "plan"
            && completionGuard.requiresSemanticReview()
          ) {
            const review = await evaluateCompletion({
              model: activeModelSettings.model,
              task: input,
              messages: turn.context.messages,
              signal: abortSignal,
              providerOptions: activeModelSettings.providerOptions,
              timeoutMs: Math.min(activeModelSettings.timeoutMs ?? 30_000, 30_000),
              onRequestMetrics: (metrics) => this.recordModelRequest(metrics),
              requestContext: {
                ...modelRequestContext(completedStepsBeforeRun + observedSteps),
                operation: "completion_review"
              }
            });
            // 评审器自身故障（模型配置/网络/解析错误）不代表工作未完成：结构性检查已通过，
            // 采信完成声明正常收口。否则同一基础设施错误会以相同指纹反复打回，
            // 停滞计数耗尽后把正常回合误判成 incomplete。故障痕迹留在 operation=completion_review 的请求指标里。
            if (!review.met && !review.evaluatorFailed) {
              decision = completionGuard.requestContinuation(
                `Independent completion review did not confirm completion: ${review.reason}`,
                "completion-review:not-met"
              );
              if (decision.kind === "continue") {
                pendingCompletionMessages.push(decision.feedback);
                return false;
              }
            }
          }
          completionDecision = decision;
          // 用户在收口前排入的 steering/follow-up 仍然要先交给模型，不能被内部复核吞掉。
          return messageQueues.steering.length === 0 && messageQueues.followUps.length === 0;
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
                {
                  ...coordinator.getExecutionBudgetSnapshot(),
                  completionEvidence: completionGuard.snapshot()
                },
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
          } else if (event.reason === "step_limit") {
            hardStepLimitReached = true;
            yield { type: "error", message: event.error };
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
      if (!completionDecision) {
        completionDecision = hardStepLimitReached
          ? {
            kind: "incomplete",
            stopReason: "hard_step_limit",
            summary: `The run reached its hard limit of ${String(runBudget.hardStepLimit)} provider steps.`
          }
          : lastAssistant?.stopReason !== undefined
            ? { kind: "complete" }
            : {
              kind: "failed",
              stopReason: "missing_terminal_event",
              summary: "The Agent Loop ended without a canonical terminal completion decision."
            };
      }
      let outcome = nativeTurnOutcome(
        hardStepLimitReached,
        content,
        lastAssistant?.stopReason,
        completedStepsBeforeRun + observedSteps,
        usageRecord
      );
      if (completionDecision.kind === "incomplete") {
        outcome = {
          ...outcome,
          status: "incomplete",
          stopReason: completionDecision.stopReason,
          error: completionDecision.summary,
          resumable: true,
          blockedReason: undefined,
          requiredAction: undefined
        };
      } else if (completionDecision.kind === "blocked") {
        outcome = {
          ...outcome,
          status: "blocked",
          stopReason: "blocked",
          error: completionDecision.summary,
          resumable: false,
          blockedReason: completionDecision.blockedReason,
          requiredAction: completionDecision.requiredAction
        };
      } else if (completionDecision.kind === "failed") {
        outcome = {
          ...outcome,
          status: "failed",
          stopReason: completionDecision.stopReason,
          error: completionDecision.summary,
          resumable: false,
          blockedReason: undefined,
          requiredAction: undefined
        };
      }
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
            {
              ...coordinator.getExecutionBudgetSnapshot(),
              completionEvidence: completionGuard.snapshot()
            },
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
            error: `${outcome.error ?? `${outcome.status} (${outcome.stopReason})`}；检查点持久化失败：${errorMessage(error)}`
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
            error: `轮次检查点清理失败：${errorMessage(error)}`
          };
        }
      }
      await this.recordTurnOutcome(outcome);
      if (outcome.status === "completed") {
        await this.recordCitedMemories(content).catch(() => undefined);
        await this.enqueueCompletedMemoryCandidate(
          input,
          content,
          runOptions.continueFrom?.length ? [...runOptions.continueFrom, ...newMessages] : newMessages,
          personalization,
          runOptions
        ).catch(() => undefined);
        if (!runOptions.continueFrom?.length) {
          void this.enqueueCompletedSkillDraft(input, content, newMessages, runOptions).catch(() => undefined);
        }
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
      // 解析走缓存：openSession 刚 parse 过的文件这里直接命中。recorder 构造（O_NOFOLLOW + 绑定
      // 校验）和 repairTailForAppend 已在上面照常执行；缓存只替代"读字节 + JSON.parse + zod"这一步，
      // 大小上限校验不能省——超限会话即使曾经命中也必须照常拒绝。
      const resumeRecorder = replacementRecorder;
      const resumeStat = await fs.stat(resumeRecorder.filePath);
      assertSessionFileSize(resumeStat.size, resumeRecorder.filePath);
      const replay = replaySessionEvents(
        cachedSessionEvents(resumeRecorder.filePath, sessionFileFingerprint(resumeStat), () => ({
          events: parseSessionEvents(resumeRecorder.readText()),
          complete: true
        })),
        { sessionId: resumeRecorder.sessionId }
      );
      const catalogRecord = await readSessionCatalogRecord(this.persistenceRoot(), replacementRecorder.sessionId);
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
      if (catalogRecord?.parentSessionId !== undefined) this.contextMemory.advancePromptEpoch("fork");
      this.contextMessageReferences = replay.messageReferences.map((reference) => ({ ...reference }));
      this.nextSessionMessageIndex = replay.totalMessageCount;
      await this.options.todoStore?.useSession(replacementRecorder.sessionId);
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

  /**
   * 开始一个全新的空会话，但不销毁这个 AgentSession。
   *
   * 常驻 runtime 的昂贵基础设施（MCP 连接、记忆索引、技能、工具注册、模型管理）全部保留，
   * 只把会话级状态重置到「刚构造」的样子：换一个全新的 SessionRecorder（新 sessionId）、
   * 清空用量与上下文、丢掉上一会话的权限授予和计划清单。这样 Desktop 点「新聊天」时不必
   * 付出整量重建（重连 MCP、重开 store、重扫 skill）的代价。
   *
   * 只能在空闲时调用——由 InteractiveAgentRuntime 的 maintenance 临界区保证没有进行中的回合。
   * 返回新会话的 sessionId。
   */
  async startNewSession(): Promise<string> {
    const release = this.beginOperation("new session");
    const previousRecorder = this.recorder;
    let nextRecorder: SessionRecorder | undefined;
    try {
      await ensureAgentDirs(this.persistenceRoot());
      // 先打开新会话的 recorder，再收尾旧会话；若这里失败，当前会话保持原样。
      nextRecorder = new SessionRecorder(this.persistenceRoot(), undefined, undefined, this.options.runtimeEventSink);
      // 旧会话可能还有旁路用量（记忆/子代理）没落盘，先补写进旧会话再收尾，不丢账单。
      // 这与 close() 的收尾一致；此刻 recorder 仍是旧会话，contextMemory 仍是旧上下文。
      const pendingRelated = this.takeRelatedUsage();
      if (pendingRelated) {
        previousRecorder.record({
          type: "assistant_message",
          content: "",
          relatedUsage: pendingRelated,
          contextState: this.contextMemory.persistedState()
        });
      }
      // 旧 recorder 只是被丢弃；关闭失败不阻断切换到新会话（空草稿关闭时会顺带删除草稿文件）。
      await previousRecorder.close().catch(() => undefined);
      // 会话级状态全部回到「刚构造」：历史、用量、权限授予、计划清单都不带入新会话。
      this.options.permissionManager.resetSession();
      this.usageRecords = [];
      this.modelRequestRecords = [];
      this.unpersistedRelatedUsage = [];
      this.contextMemory.restore([], undefined);
      // 工作区快照缓存可能已陈旧（如切了分支）；标记脏，让下一回合重新扫描，而不在切换时扫描。
      this.contextMemory.invalidateWorkspace();
      // 新会话没有聊天级覆盖；用当前全局配置按默认覆盖重新解析，避免沿用上一会话的策略。
      this.activePersonalization = resolveChatPersonalization(
        this.activeConfig.personalization,
        this.activeConfig.context.memory,
        defaultChatPersonalizationOverride
      );
      this.contextMemory.setPersonalization(
        metadataForPersonalization(this.activePersonalization),
        this.activePersonalization.useMemories
      );
      this.contextMessageReferences = [];
      this.nextSessionMessageIndex = 0;
      await this.options.todoStore?.useSession(nextRecorder.sessionId);
      this.recorder = nextRecorder;
      this.turnStore = new TurnStore(this.persistenceRoot(), nextRecorder.sessionId);
      return nextRecorder.sessionId;
    } catch (error) {
      // 还没到切换点就失败时，丢掉半成品新 recorder，当前会话保持原样。
      await nextRecorder?.close().catch(() => undefined);
      throw error;
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
      : {
        runId: runtime.runId,
        turnId: runtime.turnId,
        promptEpoch: this.contextMemory.getPromptEpoch(),
        promptEpochReason: this.contextMemory.getPromptEpochReason(),
        promptEpochCreatedAt: this.contextMemory.getPromptEpochCreatedAt()
      };
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

  /**
   * 解析回答末尾的记忆引用块并回写使用统计（仅计入真实存在的条目）。
   * 失败只丢一次统计，不影响回合结果；session JSONL 保留原始块供审计与渲染角标。
   */
  private async recordCitedMemories(answer: string): Promise<void> {
    if (!answer.includes("<memory-citations>")) return;
    const { citations } = parseMemoryCitations(answer);
    if (!citations.length) return;
    const storedIds = new Set((await this.localMemory.listMemoryEntries({ origins: ["all"] })).entries.map(({ id }) => id));
    const valid = citations.filter(({ id }) => storedIds.has(id)).map(({ id }) => id);
    if (!valid.length) return;
    await this.localMemory.recordRecallUsage(valid);
  }

  private async enqueueCompletedMemoryCandidate(
    task: string,
    answer: string,
    messages: AgentMessage[],
    personalization: ResolvedChatPersonalization,
    runOptions: AgentRunOptions
  ): Promise<void> {
    if (!personalization.contributeMemories && !personalization.telos.autoObserve) return;
    const sessionId = this.recorder.sessionId;
    const turnId = runOptions.turnId;
    const runId = runOptions.runId;
    if (!turnId || !runId) return;
    const externalContext = Boolean(runOptions.attachments?.length) || this.usedExternalContext(messages);
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
    if (personalization.contributeMemories) {
      await withFreshRevision(this.localMemory, undefined, async (expectedRevision) => (
        await this.localMemory.enqueueCandidate(input, {
          expectedRevision,
          excludeExternalContext: personalization.excludeExternalContext
        })
      )).catch(() => undefined);
    }
    if (personalization.telos.autoObserve && (!externalContext || !personalization.excludeExternalContext)) {
      try {
        await this.telosStorage.recordObservation({
          scope: "workspace",
          summary,
          sessionId,
          turnId,
          runId,
          externalContext
        });
      } catch {
        // TELOS 是后台辅助能力，不能让一条已经成功的用户任务变成失败。
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

  /**
   * 自动 Skill 抽取是成功根回合后的旁路任务。它只接受没有附件、网页、MCP、Plugin、子代理
   * 的本地上下文；模型输出先过 frontmatter 校验再写入草稿，原回合不等待这次请求。
   */
  private async enqueueCompletedSkillDraft(
    task: string,
    answer: string,
    messages: readonly AgentMessage[],
    runOptions: AgentRunOptions
  ): Promise<void> {
    const extraction = this.activeConfig.extensions.skillExtraction;
    if (!extraction.enabled || (runOptions.attachments?.length ?? 0) > 0) return;
    const toolCalls = messages.reduce((total, message) => (
      total + (message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall").length : 0)
    ), 0);
    if (toolCalls < extraction.minToolCalls || this.usedExternalContext(messages)) return;
    const transcript = redactSecrets(buildLocalSkillTranscript(task, answer, messages)).slice(0, 32_000);
    if (!transcript.trim()) return;
    const modelAlias = this.activeConfig.context.memory.extractModel;
    const model = modelAlias === undefined
      ? (this.options.modelManager?.getModel() ?? this.options.model)
      : createNativeModelForConfig(this.activeConfig, modelAlias);
    if (!model) return;
    const prompt = [
      "从下面这次已成功完成的本地 Agent 回合中提炼一个可复用的 Biny Skill。",
      "只返回完整 Markdown，不要代码围栏；必须以 YAML frontmatter 开始：",
      "---",
      "name: lowercase-kebab-case",
      "description: 一句话说明",
      "---",
      "正文写成可执行、可复用的步骤和边界。不要复制密钥、个人数据、网页内容或外部工具内容。",
      "如果没有稳定的复用模式，仍返回一个简短、诚实的 Skill 草稿。",
      "",
      transcript
    ].join("\n");
    try {
      const result = await generateNativeText(model, [{ role: "user", content: [{ type: "text", text: prompt }] }], {
        maxOutputTokens: 1_500,
        reasoning: "off",
        timeoutMs: 20_000,
        requestContext: { ...(this.sideModelRequestContext() ?? {}), operation: "memory" }
      });
      if (result.usage) this.recordModelUsage(result.usage, "memory", modelAlias);
      const content = normalizeGeneratedSkill(result.text);
      const parsed = parseSkillDocument(content);
      const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
      const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64 || !description || description.length > 1_024) {
        throw new Error("抽取模型返回的 Skill frontmatter 无效。");
      }
      await createSkillDraft({ workspaceRoot: this.options.workspaceRoot, name, description, content, toolCalls });
    } catch (error) {
      const name = `extracted-${randomUUID().slice(0, 8)}`;
      const description = "自动技能提取失败，请检查草稿并重试。";
      const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
      await createSkillDraft({
        workspaceRoot: this.options.workspaceRoot,
        name,
        description,
        content,
        toolCalls,
        status: "failed",
        error: errorMessage(error)
      });
    }
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
      promptShape: metrics.promptShape === undefined ? undefined : {
        ...metrics.promptShape,
        epoch: { ...metrics.promptShape.epoch }
      },
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
    this.memoryRetriever.close();
    this.memoryEmbeddingService.close();
    await this.localEmbeddingManager.close();
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
    const record = createSessionUsage(usage, operation, modelInfo, new Date().toISOString(), this.modelRequestRecords.at(-1)?.promptShape);
    this.usageRecords.push(record);
    if (operation === "subagent" || operation === "memory") this.unpersistedRelatedUsage.push(record);
    return record;
  }

  private takeRelatedUsage(): SessionUsage[] | undefined {
    if (!this.unpersistedRelatedUsage.length) return undefined;
    return this.unpersistedRelatedUsage.splice(0, this.unpersistedRelatedUsage.length);
  }

  private runtimeContext(runOptions: AgentRunOptions): AgentRuntimeContext {
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

  private providerEmbeddingModels(): EmbeddingModelDescriptor[] {
    return new ProviderRegistry(this.activeConfig).listEmbeddingModels();
  }

  private async activeMemoryEmbeddingRuntime(): Promise<EmbeddingModelRuntime | undefined> {
    const ref = this.activeConfig.context.memory.embeddingModel;
    if (!ref) return undefined;
    if (ref.kind === "local") return await this.localEmbeddingManager.createRuntime(ref.model);
    const providers = new ProviderRegistry(this.activeConfig);
    const descriptor = providers.listEmbeddingModels().find((candidate) => (
      candidate.ref.kind === "provider"
      && candidate.ref.provider === ref.provider
      && candidate.ref.model === ref.model
    ));
    if (!descriptor?.endpoint || descriptor.available === false) {
      throw new Error(`Embedding model ${ref.provider}/${ref.model} is currently unavailable.`);
    }
    const endpointHash = descriptor.privacyEndpointHash;
    if (!endpointHash) throw new Error(`Embedding endpoint identity is unavailable for ${ref.provider}.`);
    const confirmed = Object.values(this.activeConfig.context.memory.cloudEmbeddingConsents)
      .some((consent) => consent.endpointHash === endpointHash);
    if (!confirmed) {
      throw new Error(`Cloud embedding privacy confirmation is required for ${ref.provider}.`);
    }
    return providers.createEmbeddingRuntime(ref);
  }

  private async refreshMemoryConfig(): Promise<void> {
    const snapshot = await this.readPersonalizationState();
    this.activeConfig = snapshot.config;
    this.activePersonalization = snapshot.state.resolved;
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
    await updateConfig(store, this.options.workspaceRoot, (persisted) => ({
      ...persisted,
      permission: {
        ...persisted.permission,
        mode
      }
    }));
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

function buildLocalSkillTranscript(task: string, answer: string, messages: readonly AgentMessage[]): string {
  const lines = [`USER: ${task}`, `ASSISTANT: ${answer}`];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) lines.push(`ASSISTANT: ${part.text}`);
        if (part.type === "toolCall") lines.push(`LOCAL_TOOL: ${part.name}`);
      }
    } else if (message.role === "toolResult") {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) lines.push(`LOCAL_TOOL_RESULT (${message.toolName}): ${text}`);
    }
  }
  return lines.join("\n\n");
}

function normalizeGeneratedSkill(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown|md)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function nativeTurnOutcome(
  hardStepLimitReached: boolean,
  output: string,
  finishReason: string | undefined,
  steps: number,
  usage?: SessionUsage
): AgentTurnOutcome {
  if (hardStepLimitReached) {
    return {
      status: "incomplete",
      stopReason: "hard_step_limit",
      finishReason,
      steps,
      output,
      usage,
      error: "已达到本轮配置的最大模型步数。",
      resumable: true
    };
  }
  if (finishReason === "length") {
    return {
      status: "incomplete",
      stopReason: "model_length",
      finishReason,
      steps,
      output,
      usage,
      error: "模型输出达到长度上限，回复未能完整生成。",
      resumable: true
    };
  }
  if (finishReason === "error") {
    return {
      status: "failed",
      stopReason: "provider_error",
      finishReason,
      steps,
      output,
      usage,
      error: "模型响应以错误结束。"
    };
  }
  if (finishReason === "aborted") {
    return {
      status: "cancelled",
      stopReason: "cancelled",
      finishReason,
      steps,
      output,
      usage,
      error: "模型响应在确认任务完成前被中止。"
    };
  }
  if (finishReason !== undefined && finishReason !== "stop") {
    return {
      status: "incomplete",
      stopReason: "budget_exhausted",
      finishReason,
      steps,
      output,
      usage,
      error: `模型以非终结原因（${finishReason}）结束了响应。`,
      resumable: true
    };
  }
  return { status: "completed", stopReason: "model_stop", finishReason, steps, output, usage };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completedMemoryCandidateSummary(task: string, answer: string): string | undefined {
  const taskSummary = boundedCandidateText(task, 600);
  const outcomeSummary = boundedCandidateText(answer, 1_200);
  // 短寒暄和一次性确认不具备可复用价值。这里保留本地 durable memory 的原文，
  // 只用长度门槛排除没有信息量的回合；外发边界由模型/Provider 策略决定。
  if (Array.from(`${taskSummary}\n${outcomeSummary}`).length < 180) return undefined;
  return [
    `Completed task: ${taskSummary || "(no public task summary)"}`,
    `Outcome: ${outcomeSummary || "(no public outcome summary)"}`
  ].join("\n");
}

function boundedCandidateText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

function readToolBudget(value: unknown): ToolExecutionBudgetSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.accountedToolCalls)
    || typeof value.accountedToolCalls !== "number"
    || value.accountedToolCalls < 0
    || !Number.isSafeInteger(value.maxRepeatedActionCount)
    || typeof value.maxRepeatedActionCount !== "number"
    || value.maxRepeatedActionCount < 0
  ) return undefined;
  return {
    accountedToolCalls: value.accountedToolCalls,
    maxRepeatedActionCount: value.maxRepeatedActionCount
  };
}

function readCompletionEvidence(value: unknown): CompletionGuardSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return parseCompletionGuardSnapshot(value.completionEvidence);
}

function restartCompletionEvidence(
  evidence: CompletionGuardSnapshot | undefined
): CompletionGuardSnapshot | undefined {
  if (!evidence) return undefined;
  // 用户显式继续代表一次新的有界尝试；continuation 计数重置，但失败和未知副作用事实必须保留。
  return {
    ...evidence,
    continuationAttempts: 0,
    stagnantAttempts: 0,
    lastBlockFingerprint: ""
  };
}

function restartToolBudget(
  budget: ToolExecutionBudgetSnapshot | undefined,
  restartBudget: boolean
): ToolExecutionBudgetSnapshot | undefined {
  if (!budget || !restartBudget) return budget;
  return {
    accountedToolCalls: 0,
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
