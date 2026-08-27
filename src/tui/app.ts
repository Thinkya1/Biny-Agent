/**
 * TUI 应用外壳。
 *
 * 负责把终端渲染循环、TUI runtime、reducer 状态和各展示组件串起来：
 * 组装布局、订阅运行时事件、分发 slash command、处理全局键位。
 * 具体的上下文、会话、工具逻辑仍在 runtime 层，这里不直接执行工具。
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  Spacer,
  TUI,
  type OverlayHandle,
  type SelectItem
} from "@earendil-works/pi-tui";
import { formatPermissionModeChanged } from "../permission/commands.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { filterPickerModelChoices, parseThinkingSelection, type ModelChoice, type ThinkingSelection } from "../llm/ModelManager.js";
import { globalConfigDir } from "../config/paths.js";
import { slashCommandsForSurface } from "../runtime/commandRegistry.js";
import { withAttachmentReferences } from "../attachments/references.js";
import { forkSession } from "../session/fork.js";
import { executeRuntimeCommand } from "../runtime/commands.js";
import {
  createInteractiveAgentHost,
  type InteractiveRuntimeHandle
} from "../runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../runtime/CommandRuntime.js";
import {
  connectOrSpawnRuntimeHost,
  startRuntimeHost,
  RuntimeHostClient,
  type RuntimeHostFactory,
  type RuntimeHostServer
} from "../runtime/RuntimeHost.js";
import {
  isTerminalRunEvent,
  pendingPermission,
  runtimeIsBusy,
  type InteractiveRuntimeSnapshot
} from "../runtime/agentEvents.js";
import type { SessionSummary } from "../session/events.js";
import type { UsageSummary } from "../session/metadata.js";
import { FooterComponent, ShortcutsBarComponent, StatusIndicatorComponent, WelcomeComponent } from "./components/chrome.js";
import { CardComponent } from "./components/cards.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "./components/dialogs.js";
import { PendingAttachmentsComponent } from "./components/pendingAttachments.js";
import { SessionWriterConflictComponent } from "./components/sessionWriterConflict.js";
import { TranscriptView } from "./components/transcriptView.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
import { permissionModeOptions } from "./permissionModeOptions.js";
import { pasteTuiClipboard } from "./runtime/clipboard.js";
import { permissionChoiceToResult } from "./runtime/permissionChoice.js";
import { readGitBranch } from "./runtime/gitBranch.js";
import { openDesktopSession } from "./runtime/desktopHandoff.js";
import { readStoredSessionEvents } from "../session/events.js";
import { isSessionWriterConflictError } from "../runtime/SessionLease.js";
import { sessionEventsToTranscript } from "./sessionTranscript.js";
import { modelThinkingOptions, selectedThinkingForModel } from "./modelOptions.js";
import { createInitialTuiState, tuiReducer } from "./reducer.js";
import { editorTheme, theme } from "./theme/index.js";
import { formatSessionAge } from "./transcriptText.js";
import type { PermissionChoice, TuiLaunchMode, TuiState, TuiStatus } from "./types.js";
import type { AgentAttachment, AgentRunMode } from "../agent/AgentSession.js";
import type { SkillDefinition } from "../extensions/skills.js";
import type {
  AgentPersonalizationState,
  ChatPersonalizationOverridePatch,
  PersonalityPreset
} from "../personalization/index.js";

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

const TUI_SLASH_COMMANDS = slashCommandsForSurface("tui");
const TUI_AUTOCOMPLETE_COMMANDS = TUI_SLASH_COMMANDS.filter((command) => command.name !== "/skills");
const TUI_SHUTDOWN_DRAIN_MS = 1_500;

interface ModelPresentation {
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  thinking: ThinkingSelection;
}

export const personalitySelectOptions = [
  { value: "inherit", label: "Inherit", description: "Use the global personality for this chat." },
  { value: "none", label: "None", description: "Use no additional response-style preset." },
  { value: "friendly", label: "Friendly", description: "Use a warm, approachable and collaborative tone." },
  { value: "pragmatic", label: "Pragmatic", description: "Use a direct, concise and action-oriented tone." },
  { value: "buddy", label: "Buddy 搭子", description: "Talk like a friend texting: opinionated, no filler, no pleasantries." }
] as const;

export const memoryPolicySelectOptions = [
  { value: "inherit", label: "Inherit", description: "Use the global memory defaults for this chat." },
  { value: "both", label: "Use and contribute", description: "Recall relevant memory and contribute successful turns." },
  { value: "use", label: "Use only", description: "Recall relevant memory without automatic contribution." },
  { value: "contribute", label: "Contribute only", description: "Contribute successful turns without recalling memory." },
  { value: "off", label: "All off", description: "Neither recall nor automatically contribute memory." }
] as const;

/** 把已加载 Skill 的元数据投影成 Pi 风格的 `skill:<name>` 补全项。 */
export function skillSlashCommandItems(
  skills: readonly Pick<SkillDefinition, "name" | "description">[]
): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ name: `skill:${skill.name}`, description: skill.description }));
}

export class BinyTui {
  private readonly ui: TUI;
  private readonly workspaceRoot: string;
  private readonly version: string | undefined;
  private readonly initialSession: string | undefined;
  private readonly launchMode: TuiLaunchMode;

  private state: TuiState;
  private runtime: InteractiveRuntimeHandle | undefined;
  private commands: CommandRuntime | undefined;
  private runtimeHost: RuntimeHostServer | undefined;
  private runtimeSnapshot: InteractiveRuntimeSnapshot | undefined;

  private readonly headerContainer = new Container();
  private readonly chatContainer = new TranscriptView();
  private readonly editorContainer = new Container();
  private readonly pendingAttachmentsView = new PendingAttachmentsComponent();
  private sessionWriterConflict: { sessionId: string; ownerSurface?: string } | undefined;
  private sessionWriterConflictView: SessionWriterConflictComponent | undefined;
  private readonly status: StatusIndicatorComponent;
  private readonly footer: FooterComponent;
  private readonly shortcuts = new ShortcutsBarComponent();
  private readonly editor: Editor;

  private mode: Extract<AgentRunMode, "chat" | "plan"> = "chat";
  /** 最近一张命令卡片的 transcript id，供 ctrl+o 展开/折叠细节。 */
  private lastCardId: string | undefined;
  /** 当前输入尚未发送的图片；实际读写剪贴板和存储都在 TUI runtime。 */
  private pendingAttachments: AgentAttachment[] = [];
  private permissionMode: PermissionMode = "ask";
  private thinking: ThinkingSelection = "off";
  /** 模型切换先更新 TUI 展示，再按顺序等待 Runtime 确认。 */
  private modelSwitchQueue: Promise<void> = Promise.resolve();
  private modelSwitchPromise: Promise<void> | undefined;
  private modelSwitchGeneration = 0;
  private confirmedModel: ModelPresentation | undefined;
  private gitBranch: string | undefined;
  private contextUsage: { usedTokens?: number; maxTokens?: number; source?: "estimated" | "provider" } = {};
  private cacheHitRate: number | undefined;
  private sessionCacheHitRate: number | undefined;
  private overlay: OverlayHandle | undefined;
  private permissionDialog: PermissionDialog | undefined;
  /** 当前权限弹层对应的请求 id；同一请求的重复同步不重置用户已选选项和确认输入。 */
  private permissionDialogRequestId: string | undefined;
  /** 与 pi 一致：空闲时 Ctrl+C 需要在短时间内连续按两次才退出。 */
  private lastCtrlCAt = 0;
  private exiting = false;
  private exitSummary: TuiExitSummary | undefined;
  private unsubscribe: (() => void) | undefined;
  private resolveExit: (() => void) | undefined;

  constructor(ui: TUI, workspaceRoot: string, version?: string, initialSession?: string, launchMode: TuiLaunchMode = "new") {
    this.ui = ui;
    this.workspaceRoot = workspaceRoot;
    this.version = version;
    this.initialSession = initialSession;
    this.launchMode = launchMode;
    this.state = createInitialTuiState(workspaceRoot);
    this.status = new StatusIndicatorComponent(ui);
    this.footer = new FooterComponent(this.footerData());
    this.editor = new Editor(ui, editorTheme(), { paddingX: 1 });
    this.editorContainer.addChild(this.pendingAttachmentsView);
    this.editorContainer.addChild(this.editor);
  }

  /** 启动界面并等待退出。 */
  async run(): Promise<TuiExitSummary | undefined> {
    this.ui.addChild(this.headerContainer);
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.status);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.footer);
    this.ui.addChild(this.shortcuts);

    this.headerContainer.addChild(new Spacer(1));
    this.headerContainer.addChild(new WelcomeComponent(this.workspaceRoot, this.version));

    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    this.ui.setFocus(this.editor);
    this.ui.addInputListener((data) => {
      if (shouldConfirmAutocompleteOnEnter(data, this.editor.isShowingAutocomplete(), this.editor.getText())) {
        // pi-tui 的 Editor 对 slash 补全会在 Enter 确认后继续 fall through 到 submit。
        // 在 TUI 边界把这次 Enter 转成 Tab，只完成插入，下一次 Enter 才是用户发送。
        this.editor.handleInput("\t");
        // 全局监听器消费了原始 Enter，TUI 不会再自动请求重绘；补全后的文本要立即可见。
        this.ui.requestRender();
        return { consume: true };
      }
      if (this.editor.isShowingAutocomplete() && matchesKey(data, "escape")) {
        // 忙碌时 Escape 默认会取消 Agent；补全弹层打开时应先关闭弹层，不能误取消当前任务。
        this.dismissAutocomplete();
        return { consume: true };
      }
      return this.handleGlobalKey(data);
    });
    this.ui.start();

    await this.startRuntime();
    // Ctrl+C 可能在 runtime 初始化期间到达；此时 exit 没有等待者可唤醒，
    // 初始化完成后必须直接结束，不能再把 TUI 留在半关闭状态。
    if (this.exiting) return this.exitSummary;
    this.refreshChrome();

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    return this.exitSummary;
  }

  private async startRuntime(): Promise<void> {
    try {
      let attached: RuntimeHostClient | undefined;
      try {
        attached = await connectOrSpawnRuntimeHost(this.workspaceRoot, {
          workspaceRoot: this.workspaceRoot,
          configDir: globalConfigDir(),
          sessionId: this.initialSession,
          resumeInterrupted: false,
          clientId: `tui-${process.pid}`,
          surface: "tui"
        });
      } catch {
        // 无配置或独立 Host 启动失败时，保留当前进程内的最小 fallback。
      }
      let runtime: InteractiveRuntimeHandle;
      let commands: CommandRuntime | undefined;
      if (attached) {
        runtime = attached;
      } else {
        const createLocalRuntime: RuntimeHostFactory = async (sessionId?: string) => {
          const local = await createInteractiveAgentHost(this.workspaceRoot);
          if (sessionId !== undefined) await local.runtime.resumeSession(sessionId);
          return local;
        };
        // 显式 session 在 Host/界面完成 attach 后再恢复；这样 writer conflict 可以
        // 转成只读历史，而不会在本地 fallback 创建阶段直接终止 TUI。
        const local = await createLocalRuntime(undefined);
        runtime = local.runtime;
        commands = local.commands;
        try {
          this.runtimeHost = await startRuntimeHost(this.workspaceRoot, runtime, commands, {
            createRuntime: createLocalRuntime,
            resumeInterrupted: false,
            configDir: globalConfigDir()
          });
        } catch (error) {
          await runtime.close();
          const retry = await connectOrSpawnRuntimeHost(this.workspaceRoot, {
            workspaceRoot: this.workspaceRoot,
            configDir: globalConfigDir(),
            sessionId: this.initialSession,
            resumeInterrupted: false,
            clientId: `tui-${process.pid}`,
            surface: "tui"
          });
          if (!retry) throw error;
          runtime = retry;
          commands = undefined;
        }
      }
      this.runtime = runtime;
      this.commands = commands;
      // 普通进入 TUI 等价于 Codex 的新交互会话：已有 Host 空闲时只重建空白
      // AgentSession，不读取旧 transcript，也不续跑 checkpoint。运行中的 Host
      // 则必须保留，避免打开第二个 owner 或打断用户正在观察的任务。
      if ((this.launchMode === "new" || this.launchMode === "resume-picker")
        && this.initialSession === undefined
        && !runtimeIsBusy(runtime.getSnapshot())) {
        await this.restartRuntimeForNewChat();
        runtime = this.runtime;
        commands = this.commands;
      }
      this.runtimeSnapshot = runtime.getSnapshot();
      const { info, permissionMode } = this.runtimeSnapshot;
      this.permissionMode = permissionMode;
      this.thinking = info.thinking;
      this.confirmedModel = modelPresentationFromInfo(info);
      // 补全器要的是不带斜杠的命令名，它自己会补上 `/`；带斜杠会补出 `//resume`。
      const skills = commands
        ? commands.listSkills()
        : await requireRemoteRuntime(runtime).listSkills();
      this.setAutocompleteProvider(skills, info.workspaceRoot);
      this.editor.borderColor = theme.thinkingBorder(this.thinking);

      void readGitBranch(info.workspaceRoot).then((branch) => {
        this.gitBranch = branch;
        this.refreshChrome();
      });
      void loadInputHistory(info.workspaceRoot)
        .then((history) => {
          for (const entry of history.slice(-100)) this.editor.addToHistory(entry);
        })
        .catch((error) => this.notify(`读取输入历史失败：${describeError(error)}`));

      this.subscribeRuntime(runtime);
      this.dispatch({
        type: "session.started",
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        cwd: info.workspaceRoot,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
      // 显式 session 必须走完整 transcript 加载；如果当前 Host 正在运行另一条
      // session，resumeSession 会拒绝切换，不能静默显示错误会话。
      if (this.initialSession) await this.resumeSession(this.initialSession);
      if (this.launchMode === "resume-picker" && this.initialSession === undefined) await this.showSessionPicker();
      void this.refreshContextUsage();
      void this.refreshUsage();
    } catch (error) {
      this.notify(`TUI startup failed: ${describeError(error)}`);
    }
  }

  private subscribeRuntime(runtime: InteractiveRuntimeHandle): void {
    this.unsubscribe?.();
    this.unsubscribe = runtime.subscribe((update) => {
      this.runtimeSnapshot = update.snapshot;
      if (update.event) this.dispatch(update.event);
      else if (update.snapshot.state.kind === "maintenance") this.dispatch({ type: "maintenance.started" });
      else this.refreshChrome();
      if (isTerminalRunEvent(update.event)) {
        void this.refreshContextUsage();
        void this.refreshUsage();
      }
    });
  }

  /** 创建一个新聊天；只有显式 `/new` 或普通入口才会调用，绝不等同于续跑。 */
  private async restartRuntimeForNewChat(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("TUI runtime is not ready.");
    if (runtimeIsBusy(runtime.getSnapshot())) {
      throw new Error("当前任务仍在运行，请先取消后再创建新聊天。");
    }

    if (runtime instanceof RuntimeHostClient) {
      await runtime.restartRuntime();
      this.runtimeSnapshot = runtime.getSnapshot();
      return;
    }

    const host = this.runtimeHost;
    if (!host) throw new Error("新聊天需要可重建的 Runtime Host。");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await host.restartRuntime();
    this.runtime = host.getCurrentRuntime();
    this.commands = host.getCurrentCommands();
    this.runtimeSnapshot = this.runtime.getSnapshot();
    this.subscribeRuntime(this.runtime);
  }

  private announceCurrentSession(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const info = runtime.getSnapshot().info;
    this.confirmedModel = modelPresentationFromInfo(info);
    this.dispatch({
      type: "session.started",
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      cwd: info.workspaceRoot,
      provider: info.provider,
      modelLabel: info.modelLabel,
      reasoningLabel: info.reasoningLabel
    });
  }

  private async startNewChat(): Promise<void> {
    try {
      await this.restartRuntimeForNewChat();
      this.clearSessionWriterConflict();
      this.chatContainer.reset();
      this.dispatch({ type: "transcript.replaced", items: [], viewingSessionId: this.runtimeSnapshot?.info.sessionId });
      this.mode = "chat";
      this.announceCurrentSession();
      this.setEditorText("");
      await this.refreshContextUsage();
      await this.refreshUsage();
      this.notify("New chat started.");
    } catch (error) {
      this.showTextViewer("New chat", describeError(error));
    }
  }

  private async openCurrentSessionInDesktop(): Promise<void> {
    const info = this.runtime?.getSnapshot().info;
    if (!info) return;
    try {
      await openDesktopSession(info.workspaceRoot, info.sessionId);
      this.notify("已将当前会话交给 Biny Desktop。");
    } catch (error) {
      this.showTextViewer("Desktop", describeError(error));
    }
  }

  private setAutocompleteProvider(skills: readonly SkillDefinition[], workspaceRoot: string): void {
    const provider = new CombinedAutocompleteProvider(
      [
        ...TUI_AUTOCOMPLETE_COMMANDS.map((command) => ({
          name: command.name.replace(/^\//, ""),
          description: command.description
        })),
        ...skillSlashCommandItems(skills)
      ],
      workspaceRoot
    );
    this.editor.setAutocompleteProvider(provider);
  }

  private dispatch(event: Parameters<typeof tuiReducer>[1]): void {
    const nextState = tuiReducer(this.state, event);
    // 长思考会产生大量 reasoning.delta；这些增量只用于 provider/session，TUI
    // 不展示原文。忽略没有改变界面的增量，避免每个 token 都同步组件树并请求重绘。
    if (nextState === this.state && event.type === "reasoning.delta") return;
    this.state = nextState;
    this.syncPermissionDialog();
    this.chatContainer.sync(this.state.transcript);
    this.refreshChrome();
  }

  private notify(content: string): void {
    this.dispatch({ type: "system.message", content });
  }

  private refreshChrome(): void {
    const status = runtimeStatus(this.runtimeSnapshot);
    this.status.setState(status, this.state.turnStartedAt, this.state.lastWorkedMs);
    this.shortcuts.setState(status, this.mode);
    this.footer.setData(this.footerData());
    this.ui.requestRender();
  }

  private footerData(): Parameters<FooterComponent["setData"]>[0] {
    return {
      cwd: this.state.cwd,
      sessionId: this.state.sessionId,
      viewingSessionId: this.state.viewingSessionId,
      gitBranch: this.gitBranch,
      modelLabel: this.state.modelLabel,
      thinkingLabel: this.state.reasoningLabel,
      permissionMode: this.permissionMode,
      mode: this.mode,
      contextUsedTokens: this.contextUsage.usedTokens,
      contextMaxTokens: this.contextUsage.maxTokens,
      contextSource: this.contextUsage.source,
      cacheHitRate: this.cacheHitRate,
      sessionCacheHitRate: this.sessionCacheHitRate
    };
  }

  private async refreshContextUsage(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const context = this.commands
        ? await this.commands.agent.contextStatus()
        : await requireRemoteRuntime(runtime).contextStatus();
      // 百分比按模型自身的上下文窗口算；没有窗口信息时才退回输入预算。
      this.contextUsage = {
        usedTokens: context.budget.usedTokens,
        maxTokens: context.budget.contextWindow ?? context.budget.maxTokens,
        source: context.budget.source
      };
      this.refreshChrome();
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }

  private async refreshUsage(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const summary: UsageSummary = this.commands
        ? await this.commands.agent.usageSummary()
        : (await requireRemoteRuntime(runtime).usage()).summary;
      this.cacheHitRate = summary.latestCacheHitRate;
      this.sessionCacheHitRate = summary.sessionCacheHitRate;
      this.refreshChrome();
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }

  // ---------------------------------------------------------------- 输入分发

  private async submit(text: string): Promise<void> {
    const value = text.trim();
    if (!value && !this.pendingAttachments.length) return;
    const runtime = this.runtime;
    const commands = this.commands;
    // TUI 在 runtime 启动完成前已经可以接收键盘输入；不能因为 Editor 已清空而丢掉这条消息。
    if (!runtime) {
      this.setEditorText(text);
      this.ui.requestRender();
      return;
    }
    const pendingModelSwitch = this.modelSwitchPromise;
    if (pendingModelSwitch) {
      // 底部模型名已经立即变化，但消息必须等真实 Runtime 切换完成后再提交，
      // 避免用户紧接着按 Enter 时仍由旧模型处理。
      try {
        await pendingModelSwitch;
      } catch {
        // applyModel 已经展示具体失败原因；Editor 提交时已清空输入，这里恢复，避免误发到旧模型。
        this.setEditorText(text);
        return;
      }
    }
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    this.setPendingAttachments([]);
    this.setEditorText("");
    this.editor.addToHistory(prompt);
    void appendInputHistory(this.workspaceRoot, prompt)
      .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));

    if (value.startsWith("/skill:") && runtime) {
      try {
        // 与 Pi 一致：补全只显示元数据，按 Enter 后才读取并注入 Skill 正文。
        const expandedPrompt = commands
          ? await commands.expandSkillCommand(value)
          : await requireRemoteRuntime(runtime).expandSkillCommand(value);
        const input = withAttachmentReferences(expandedPrompt, attachments);
        if (runtimeIsBusy(this.runtimeSnapshot)) {
          runtime.followUp(input, attachments);
          this.notify("Skill 消息已加入 follow-up 队列，将在当前任务准备结束时继续处理。");
          return;
        }
        await runtime.submitPrompt(input, this.mode, attachments).completion;
      } catch (error) {
        this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
        this.setEditorText(prompt);
        this.dispatch({ type: "error.message", message: describeError(error) });
      } finally {
        await this.refreshContextUsage();
      }
      return;
    }

    if (value.startsWith("/")) {
      // slash 命令不消费附件；保留它们给用户执行命令后继续编辑并发送。
      this.setPendingAttachments(attachments);
      try {
        await this.handleSlashCommand(value);
      } catch (error) {
        this.showTextViewer("Command Error", describeError(error));
      }
      return;
    }

    try {
      if (runtimeIsBusy(this.runtimeSnapshot)) {
        runtime.followUp(withAttachmentReferences(prompt, attachments), attachments);
        this.notify("消息已加入 follow-up 队列，将在当前任务准备结束时继续处理。");
        return;
      }
      await runtime.submitPrompt(withAttachmentReferences(prompt, attachments), this.mode, attachments).completion;
    } catch (error) {
      this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
      this.setEditorText(prompt);
      this.dispatch({ type: "error.message", message: describeError(error) });
    } finally {
      await this.refreshContextUsage();
    }
  }

  /** 全局键位。返回 `{consume:true}` 表示不再投递给焦点组件。 */
  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    const busy = runtimeIsBusy(this.runtimeSnapshot);

    // 连续两次 Ctrl+C 始终退出（弹层打开时也一样，和 Codex 体感一致）；
    // 单次 Ctrl+C 在弹层打开时交给弹层自己处理（选择器取消、查看器关闭），
    // 避免「想退出却发现被弹层卡住」。
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (ctrlCAction(this.lastCtrlCAt, now) === "exit") {
        this.lastCtrlCAt = 0;
        void this.exit();
      } else {
        this.lastCtrlCAt = now;
        if (this.overlay) return undefined;
        if (busy) {
          this.dismissAutocomplete();
          this.runtime?.cancelCurrentRun();
        } else {
          this.setEditorText("");
          this.setPendingAttachments([]);
        }
      }
      return { consume: true };
    }
    if (this.sessionWriterConflict) {
      if (matchesKey(data, "enter") || data.toLowerCase() === "r") {
        this.sessionWriterConflictView?.handleInput(data);
      }
      // 冲突状态只允许 Retry 和退出，普通输入不能落入 Editor。
      return { consume: true };
    }
    // steer 消费的是编辑器内容，必须排在冲突遮罩之后，避免冲突期间改写已隐藏的编辑器。
    if (matchesKey(data, "ctrl+s") && busy && !this.overlay) {
      this.dismissAutocomplete();
      void this.steerCurrentInput();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.overlay) return undefined;
      if (busy) {
        this.runtime?.cancelCurrentRun();
        return { consume: true };
      }
      return undefined;
    }
    if (this.overlay) return undefined;
    // ctrl+o 展开/折叠最近一张命令卡片的细节；权限弹层内由 PermissionDialog 自己处理。
    if (matchesKey(data, "ctrl+o") && this.lastCardId) {
      const component = this.chatContainer.componentFor(this.lastCardId);
      if (component instanceof CardComponent) {
        this.dismissAutocomplete();
        component.toggleDetails();
        this.ui.requestRender();
        return { consume: true };
      }
    }
    // Windows 终端通常把 Ctrl+V 留给文本粘贴，只用 Alt+V 读取图片剪贴板。
    const isClipboardPaste = process.platform === "win32" ? matchesKey(data, "alt+v") : matchesKey(data, "ctrl+v");
    if (isClipboardPaste) {
      this.dismissAutocomplete();
      void this.pasteClipboard();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") && !this.editor.isShowingAutocomplete()) {
      this.mode = this.mode === "plan" ? "chat" : "plan";
      this.refreshChrome();
      return { consume: true };
    }
    return undefined;
  }

  private async steerCurrentInput(): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    const value = this.editor.getText().trim();
    if (!value && !this.pendingAttachments.length) return;
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    try {
      const expandedPrompt = value.startsWith("/skill:")
        ? commands
          ? await commands.expandSkillCommand(value)
          : await requireRemoteRuntime(runtime).expandSkillCommand(value)
        : prompt;
      runtime.steer(withAttachmentReferences(expandedPrompt, attachments), attachments);
      this.setPendingAttachments([]);
      this.setEditorText("");
      this.editor.addToHistory(prompt);
      void appendInputHistory(this.workspaceRoot, prompt)
        .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));
      this.notify("消息已加入 steer 队列，将在当前模型步骤和工具批次结束后处理。");
    } catch (error) {
      this.dispatch({ type: "error.message", message: describeError(error) });
    }
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const pasted = await pasteTuiClipboard(this.workspaceRoot);
      if (pasted.kind === "image") {
        this.setPendingAttachments([...this.pendingAttachments, pasted.attachment]);
        this.notify(`已附加 [Image #${String(this.pendingAttachments.length)}]。按 Enter 发送；当前模型需声明 vision 能力。`);
        return;
      }
      if (pasted.kind === "text") {
        this.editor.insertTextAtCursor(pasted.text);
        this.ui.requestRender();
        return;
      }
      this.notify("剪贴板中没有可读取的图片或文本。");
    } catch (error) {
      this.notify(`读取剪贴板失败：${describeError(error)}`);
    }
  }

  private setPendingAttachments(attachments: AgentAttachment[]): void {
    this.pendingAttachments = attachments;
    this.pendingAttachmentsView.setAttachments(attachments);
    this.ui.requestRender();
  }

  private setEditorText(text: string): void {
    this.editor.setText(text);
  }

  private dismissAutocomplete(): void {
    if (!this.editor.isShowingAutocomplete()) return;
    this.editor.handleInput("\x1b");
    this.ui.requestRender();
  }

  // ---------------------------------------------------------------- 弹层

  private showOverlay(component: Container, options?: {
    maxHeight?: `${number}%`;
    placement?: "below_editor";
  }): void {
    this.dismissAutocomplete();
    this.closeOverlay();
    const maxHeight = options?.maxHeight ?? "70%";
    const row = options?.placement === "below_editor"
      ? selectDialogRow(
        this.ui.render(this.ui.terminal.columns).length,
        Math.min(
          component.render(this.ui.terminal.columns).length,
          Math.max(1, Math.floor(this.ui.terminal.rows * Number.parseFloat(maxHeight) / 100))
        ),
        this.ui.terminal.rows,
        this.footer.render(this.ui.terminal.columns).length + this.shortcuts.render(this.ui.terminal.columns).length
      )
      : undefined;
    this.overlay = this.ui.showOverlay(component, {
      width: "100%",
      anchor: row === undefined ? "bottom-center" : undefined,
      row,
      maxHeight
    });
    this.overlay.focus();
  }

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.permissionDialog = undefined;
    this.permissionDialogRequestId = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private showTextViewer(title: string, content: string): void {
    const rows = Math.max(4, Math.floor(this.ui.terminal.rows * 0.6));
    const viewer = new TextViewerDialog(title, content, rows, () => this.closeOverlay());
    this.showOverlay(viewer);
  }

  private showSelect(options: {
    title: string;
    items: SelectItem[];
    selectedIndex?: number;
    hint?: string;
    onSelect: (item: SelectItem) => void;
  }): void {
    const dialog = new SelectDialog({
      title: options.title,
      items: options.items,
      selectedIndex: options.selectedIndex,
      hint: options.hint,
      maxVisible: Math.max(4, Math.floor(this.ui.terminal.rows * 0.4)),
      onSelect: (item) => {
        this.closeOverlay();
        options.onSelect(item);
      },
      onCancel: () => this.closeOverlay()
    });
    this.showOverlay(dialog, { placement: "below_editor" });
  }

  /** 权限请求进出时同步弹层，避免请求切换后还留着上一份确认状态。 */
  private syncPermissionDialog(): void {
    const pending = pendingPermission(this.runtimeSnapshot);
    if (!pending) {
      if (this.permissionDialog) this.closeOverlay();
      return;
    }
    if (this.permissionDialog) {
      // 并行工具的进度事件会反复触发同步；同一请求只刷新展开状态，
      // 换成新请求时才允许 setRequest 重置已选选项和已输入的确认词。
      if (pending.requestId !== this.permissionDialogRequestId) {
        this.permissionDialog.setRequest({ ...pending.request });
        this.permissionDialogRequestId = pending.requestId;
      }
      this.permissionDialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
      return;
    }
    const dialog = new PermissionDialog(
      { ...pending.request },
      (choice) => {
        this.closeOverlay();
        this.answerPermission(choice);
      },
      () => {
        this.dispatch({ type: "permission.details.toggled" });
      },
      Math.max(10, this.ui.terminal.rows - 4)
    );
    dialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
    this.showOverlay(dialog, { maxHeight: "100%" });
    // showOverlay 内部会先 closeOverlay 清空弹层引用，归属登记必须放在之后。
    this.permissionDialog = dialog;
    this.permissionDialogRequestId = pending.requestId;
  }

  private answerPermission(choice: PermissionChoice): void {
    const runtime = this.runtime;
    const request = pendingPermission(this.runtimeSnapshot);
    if (!runtime || !request) return;
    runtime.answerPermission(
      request.requestId,
      permissionChoiceToResult(choice, request.request.requireFullYes)
    );
  }

  // ---------------------------------------------------------------- slash

  private async handleSlashCommand(value: string): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    // 容忍多打的斜杠：`//resume` 只可能是想写 `/resume`。
    const [command = "", ...args] = value.trim().replace(/^\/+/, "/").split(/\s+/);

    if (command === "/") {
      this.showSelect({
        title: "Commands",
        items: TUI_SLASH_COMMANDS.map((entry) => ({
          value: entry.name,
          label: entry.name,
          description: entry.description
        })),
        hint: "↑↓ navigate · enter insert · esc/ctrl+c cancel",
        onSelect: (item) => {
          this.setEditorText(`${item.value} `);
          this.ui.requestRender();
        }
      });
      return;
    }

    if (command === "/exit") {
      await this.exit();
      return;
    }

    if (command === "/clear") {
      this.dispatch({ type: "transcript.replaced", items: [] });
      this.chatContainer.reset();
      this.ui.requestRender();
      return;
    }

    if (command === "/new") {
      await this.startNewChat();
      return;
    }

    if (command === "/app") {
      await this.openCurrentSessionInDesktop();
      return;
    }

    if (command === "/model") {
      await this.handleModelCommand(args);
      return;
    }

    if (command === "/personality") {
      await this.handlePersonalityCommand(args);
      return;
    }

    if (command === "/memories") {
      await this.handleMemoriesCommand(args);
      return;
    }

    if (command === "/resume" && runtimeIsBusy(this.runtimeSnapshot)) {
      this.notify("当前任务仍在运行，请先取消后再恢复会话。");
      return;
    }

    if (command === "/resume" && !args[0]) {
      await this.showSessionPicker();
      return;
    }

    if (command === "/resume") {
      await this.resumeSession(args[0] ?? "");
      return;
    }

    if (command === "/fork") {
      const upTo = args[1] === undefined ? undefined : Number.parseInt(args[1], 10);
      if (args[1] !== undefined && !Number.isSafeInteger(upTo)) {
        this.showTextViewer("Fork", "Usage: /fork [session] [upToEvent]");
        return;
      }
      const forked = await forkSession(
        commands?.persistenceRoot ?? this.workspaceRoot,
        args[0],
        upTo === undefined ? {} : { upToEvent: upTo }
      );
      this.showTextViewer("Fork", `Forked ${forked.sourceSessionId} at ${String(forked.events)} event(s) into ${forked.sessionId}\n${forked.filePath}`);
      return;
    }

    if (command === "/permissions") {
      if (runtimeIsBusy(this.runtimeSnapshot)) {
        this.notify("当前任务仍在运行，请先取消后再修改权限设置。");
        return;
      }
      if (args.length === 0) {
        this.showPermissionModePicker();
        return;
      }
      const result = commands
        ? await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.runPermissionCommand(args)
        )
        : await requireRemoteRuntime(runtime).runPermissionCommand(args);
      this.showTextViewer("Permissions", result);
      this.permissionMode = runtime.getSnapshot().permissionMode;
      this.refreshChrome();
      return;
    }

    if (command === "/automation" && args[0]?.toLowerCase() === "run") {
      const automationId = args[1]?.trim();
      if (!automationId) {
        this.notify("Usage: /automation run <automation-id>");
        return;
      }
      const fire = runtime instanceof RuntimeHostClient
        ? await runtime.automationRun(automationId)
        : await this.runtimeHost?.runAutomation(automationId);
      this.showTextViewer("Automation", JSON.stringify(fire, null, 2));
      return;
    }

    const sharedResult = commands
      ? await executeRuntimeCommand(runtime, commands, value, "tui")
      : await requireRemoteRuntime(runtime).executeCommand(value, "tui");
    if (sharedResult) {
      if (sharedResult.card) {
        // 卡片 id 由 reducer 按同一公式生成；这里先算出来，供 ctrl+o 定位组件。
        const cardId = `card-${String(this.state.transcript.committed.length + this.state.transcript.active.length + 1)}`;
        this.lastCardId = cardId;
        this.dispatch({
          type: "command.card",
          command: sharedResult.command,
          title: sharedResult.title,
          data: sharedResult.card
        });
      } else {
        this.showTextViewer(sharedResult.title, sharedResult.content);
      }
      if (command === "/compact") await this.refreshContextUsage();
      return;
    }

    // 未知命令是小错误，用一条通知就够，不必占一整个弹层。
    this.notify(`Unknown command: ${command}. Type / to see the list.`);
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    if (args[0]) {
      this.applyModel(args[0], parseThinkingSelection(args[1]));
      return;
    }
    if (commands) {
      await runtime.runExclusiveOperation(
        "refresh_model",
        async () => await commands.agent.refreshModelFromDisk()
      );
    } else {
      await requireRemoteRuntime(runtime).refreshModel();
    }
    // /model 只读取配置和已恢复的目录缓存，不能因为远程目录请求阻塞模型选择。
    const info = runtime.getSnapshot().info;
    const models = commands
      ? commands.agent.listModels()
      : await requireRemoteRuntime(runtime).listModels();
    const pickerModels = filterPickerModelChoices(models);
    // 选择器只展示配置列表里勾选启用且可用的模型；一个都没有时给出明确提示，
    // 而不是弹一个空列表（对应 Codex 在目录不可用时显示提示而非空 picker 的做法）。
    if (pickerModels.length === 0) {
      this.showTextViewer("Select model", "当前没有可用模型。请在桌面端设置 > 模型供应商中配置并启用模型，或检查连接的密钥/登录状态后重试。");
      return;
    }
    this.showSelect({
      title: "Select model",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, pickerModels.findIndex((model) => model.alias === info.modelAlias)),
      items: pickerModels.map((model) => ({
        value: model.alias,
        label: model.alias === info.modelAlias ? `${model.alias} ← current` : model.alias,
        description: `${model.provider}  ${model.description ?? model.model}`
      })),
      onSelect: (item) => {
        // 远程 listModels 等在 Host 断连时会抛错，就地提示而不是 unhandled rejection。
        void this.selectModel(item.value)
          .catch((error: unknown) => this.notify(`切换模型失败：${describeError(error)}`));
      }
    });
  }

  private async handlePersonalityCommand(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (action === "instructions") {
      await this.handleChatInstructionsCommand(args.slice(1));
      return;
    }
    if (action !== undefined) {
      if (!personalitySelectOptions.some((option) => option.value === action)) {
        this.showTextViewer("Personality", "Usage: /personality [inherit|none|friendly|pragmatic|buddy] | instructions [set <text>|inherit|off]");
        return;
      }
      await this.applyChatPersonalization({ personality: action as "inherit" | PersonalityPreset });
      return;
    }

    const state = await this.readPersonalizationState();
    this.showSelect({
      title: "Chat personality",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, personalitySelectOptions.findIndex((option) => option.value === state.override.personality)),
      items: personalitySelectOptions.map((option) => ({
        ...option,
        label: option.value === state.override.personality ? `${option.label} ← current` : option.label
      })),
      onSelect: (item) => {
        void this.applyChatPersonalization({ personality: item.value as "inherit" | PersonalityPreset });
      }
    });
  }

  private async handleChatInstructionsCommand(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (!action) {
      const state = await this.readPersonalizationState();
      const current = state.override.customInstructions.mode;
      this.showSelect({
        title: "Chat instructions",
        hint: "↑↓ navigate · enter select · esc cancel",
        selectedIndex: current === "inherit" ? 0 : current === "disabled" ? 1 : 2,
        items: [
          {
            value: "inherit",
            label: current === "inherit" ? "Inherit global ← current" : "Inherit global",
            description: "Use global custom instructions for this chat."
          },
          {
            value: "off",
            label: current === "disabled" ? "Disable ← current" : "Disable",
            description: "Ignore global custom instructions in this chat."
          },
          {
            value: "set",
            label: current === "replace" ? "Replace text ← current" : "Replace text",
            description: "Insert a command for entering chat-specific instructions."
          }
        ],
        onSelect: (item) => {
          if (item.value === "set") {
            this.setEditorText("/personality instructions set ");
            this.ui.requestRender();
            return;
          }
          void this.applyChatPersonalization({
            customInstructions: item.value === "inherit" ? { mode: "inherit" } : { mode: "disabled" }
          });
        }
      });
      return;
    }
    if (action === "set") {
      const value = args.slice(1).join(" ").trim();
      if (!value) {
        this.showTextViewer("Personality", "Usage: /personality instructions set <text>");
        return;
      }
      await this.applyChatPersonalization({ customInstructions: { mode: "replace", value } });
      return;
    }
    if (action === "inherit") {
      await this.applyChatPersonalization({ customInstructions: { mode: "inherit" } });
      return;
    }
    if (action === "off" || action === "disabled" || action === "clear") {
      await this.applyChatPersonalization({ customInstructions: { mode: "disabled" } });
      return;
    }
    this.showTextViewer("Personality", "Usage: /personality instructions [set <text>|inherit|off]");
  }

  private async handleMemoriesCommand(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (action !== undefined) {
      if (!memoryPolicySelectOptions.some((option) => option.value === action)) {
        this.showTextViewer("Memories", "Usage: /memories [inherit|both|use|contribute|off]");
        return;
      }
      await this.applyChatMemoryPolicy(action as typeof memoryPolicySelectOptions[number]["value"]);
      return;
    }
    const state = await this.readPersonalizationState();
    const selected = memoryPolicyOptionForOverride(state);
    this.showSelect({
      title: "Chat memory policy",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, memoryPolicySelectOptions.findIndex((option) => option.value === selected)),
      items: memoryPolicySelectOptions.map((option) => ({
        ...option,
        label: option.value === selected ? `${option.label} ← current` : option.label
      })),
      onSelect: (item) => {
        void this.applyChatMemoryPolicy(item.value as typeof memoryPolicySelectOptions[number]["value"]);
      }
    });
  }

  private async applyChatMemoryPolicy(
    policy: typeof memoryPolicySelectOptions[number]["value"]
  ): Promise<void> {
    const patch: ChatPersonalizationOverridePatch = policy === "inherit"
      ? { useMemories: "inherit", contributeMemories: "inherit" }
      : policy === "both"
        ? { useMemories: true, contributeMemories: true }
        : policy === "use"
          ? { useMemories: true, contributeMemories: false }
          : policy === "contribute"
            ? { useMemories: false, contributeMemories: true }
            : { useMemories: false, contributeMemories: false };
    await this.applyChatPersonalization(patch);
  }

  private async readPersonalizationState(): Promise<AgentPersonalizationState> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("TUI runtime is not ready.");
    return this.commands
      ? await this.commands.agent.getPersonalizationState()
      : await requireRemoteRuntime(runtime).getPersonalizationState();
  }

  private async applyChatPersonalization(patch: ChatPersonalizationOverridePatch): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const state = await this.readPersonalizationState();
      if (!state.catalogRevision) throw new Error("Chat personalization revision is unavailable.");
      const updated = this.commands
        ? await runtime.runExclusiveOperation(
          "personalization",
          async () => await this.commands!.agent.updateChatPersonalization(patch, state.catalogRevision)
        )
        : await requireRemoteRuntime(runtime).updateChatPersonalization(patch, state.catalogRevision);
      const memory = memoryPolicyOptionForOverride(updated);
      this.notify(`Chat settings saved (${updated.override.personality}; memory ${memory}). They apply from the next root turn.`);
    } catch (error) {
      this.showTextViewer("Personalization", describeError(error));
    }
  }

  private async selectModel(alias: string): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    const models = commands
      ? commands.agent.listModels()
      : await requireRemoteRuntime(runtime).listModels();
    const model = models.find((candidate) => candidate.alias === alias);
    if (!model) {
      this.showTextViewer("Model", `Unknown model alias: ${alias}`);
      return;
    }
    if (!model.efforts.length) {
      this.applyModel(alias, "off", model);
      return;
    }

    const current = runtime.getSnapshot().info;
    const currentThinking = selectedThinkingForModel(current.modelAlias, current.thinking, model);
    const options = modelThinkingOptions(model);
    this.showSelect({
      title: "Thinking Level",
      hint: "↑↓ navigate · enter select · esc back",
      selectedIndex: Math.max(0, options.findIndex((option) => option.value === currentThinking)),
      items: options.map((option) => ({
        value: option.value,
        label: option.label
      })),
      onSelect: (item) => {
        this.applyModel(alias, item.value as ThinkingSelection, model);
      }
    });
  }

  private applyModel(alias: string, thinking?: ThinkingSelection, model?: ModelChoice): void {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    const requestId = ++this.modelSwitchGeneration;
    const optimistic = modelPresentationFromChoice(
      alias,
      thinking ?? model?.defaultThinking ?? "off",
      model,
      this.state.provider
    );
    this.applyModelPresentation(optimistic);

    const request = this.modelSwitchQueue
      .catch(() => undefined)
      .then(async () => {
        const info = commands
          ? await runtime.runExclusiveOperation(
            "switch_model",
            async () => await commands.agent.switchModel(alias, thinking)
          )
          : await requireRemoteRuntime(runtime).switchModel(alias, thinking);
        const confirmed = modelPresentationFromInfo(info);
        this.confirmedModel = confirmed;
        if (this.modelSwitchGeneration === requestId) {
          this.applyModelPresentation(confirmed);
          this.notify(`Model changed to ${info.modelLabel} ${info.reasoningLabel.toLowerCase()}`);
        }
      });
    this.modelSwitchQueue = request.catch(() => undefined);
    this.modelSwitchPromise = request;
    void request.then(
      () => {
        if (this.modelSwitchGeneration === requestId) this.modelSwitchPromise = undefined;
      },
      (error: unknown) => {
        if (this.modelSwitchGeneration !== requestId) return;
        this.modelSwitchPromise = undefined;
        this.applyModelPresentation(this.confirmedModel ?? modelPresentationFromInfo(runtime.getSnapshot().info));
        this.showTextViewer("Model", `Model switch failed: ${describeError(error)}`);
      }
    );
  }

  private applyModelPresentation(presentation: ModelPresentation): void {
    this.thinking = presentation.thinking;
    this.editor.borderColor = theme.thinkingBorder(this.thinking);
    this.dispatch({
      type: "model.changed",
      provider: presentation.provider,
      modelLabel: presentation.modelLabel,
      reasoningLabel: presentation.reasoningLabel
    });
  }

  private showPermissionModePicker(): void {
    this.showSelect({
      title: "Select permission mode",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, permissionModeOptions.findIndex((option) => option.mode === this.permissionMode)),
      items: permissionModeOptions.map((option) => ({
        value: option.mode,
        label: option.mode === this.permissionMode ? `${option.label} ← current` : option.label,
        description: option.description
      })),
      onSelect: (item) => {
        // applyPermissionMode 在 runtime 忙时会被 runExclusiveOperation 拒绝，就地提示而不是 unhandled rejection。
        void this.applyPermissionMode(item.value as PermissionMode)
          .catch((error: unknown) => this.notify(`切换权限模式失败：${describeError(error)}`));
      }
    });
  }

  private async applyPermissionMode(mode: PermissionMode): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime) return;
    if (commands) {
      await runtime.runExclusiveOperation(
        "permission",
        async () => await commands.agent.setPermissionMode(mode)
      );
    } else {
      await requireRemoteRuntime(runtime).setPermissionMode(mode);
    }
    this.permissionMode = mode;
    this.notify(formatPermissionModeChanged(mode));
  }

  private async showSessionPicker(): Promise<void> {
    const commands = this.commands;
    const runtime = this.runtime;
    if (!runtime) return;
    const summaries = (await (commands
      ? commands.agent.listSessions()
      : requireRemoteRuntime(runtime).listSessions()))
      .filter((summary) => summary.firstUserMessage.trim())
      .slice();
    if (!summaries.length) {
      this.showTextViewer("Sessions", "No sessions yet.");
      return;
    }
    const nowMs = Date.now();
    this.showSelect({
      title: "Resume session",
      hint: "↑↓ navigate · enter resume · esc cancel",
      items: summaries.map((summary) => ({
        value: summary.fileName.replace(/\.jsonl$/, ""),
        label: sessionLabel(summary, nowMs),
        description: summary.firstUserMessage.replace(/\s+/g, " ").slice(0, 80)
      })),
      onSelect: (item) => {
        // resumeSession 会把非 writer-conflict 错误（runtime 忙、会话损坏）重抛，必须就地提示。
        void this.resumeSession(item.value)
          .catch((error: unknown) => this.notify(`恢复会话失败：${describeError(error)}`));
      }
    });
  }

  private async resumeSession(session: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !session) return;
    try {
      const resumed = await runtime.resumeSession(session);
      this.clearSessionWriterConflict();
      this.announceCurrentSession();
      this.chatContainer.reset();
      this.dispatch({
        type: "transcript.replaced",
        viewingSessionId: resumed.sessionId,
        items: sessionEventsToTranscript(resumed.events)
      });
      this.mode = "chat";
      await this.refreshContextUsage();
      await this.refreshUsage();
    } catch (error) {
      if (!isSessionWriterConflictError(error)) throw error;
      await this.showSessionWriterConflict(session, error.ownerSurface);
    }
  }

  private async showSessionWriterConflict(sessionId: string, ownerSurface?: string): Promise<void> {
    this.sessionWriterConflict = { sessionId, ownerSurface };
    this.editorContainer.removeChild(this.pendingAttachmentsView);
    this.editorContainer.removeChild(this.editor);
    this.sessionWriterConflictView = new SessionWriterConflictComponent(
      this.sessionWriterConflict,
      () => {
        // resumeSession 会把非冲突错误重抛，回调里必须兜住，避免 unhandled rejection。
        void this.retrySessionWriterConflict()
          .catch((error: unknown) => this.notify(`恢复会话失败：${describeError(error)}`));
      }
    );
    this.editorContainer.addChild(this.sessionWriterConflictView);
    this.ui.setFocus(this.sessionWriterConflictView);
    this.setPendingAttachments([]);
    this.chatContainer.reset();
    try {
      const stored = await readStoredSessionEvents(this.commands?.persistenceRoot ?? this.workspaceRoot, sessionId);
      this.dispatch({
        type: "transcript.replaced",
        viewingSessionId: sessionId,
        items: sessionEventsToTranscript(stored.events)
      });
    } catch (error) {
      this.dispatch({ type: "error.message", message: `读取只读会话失败：${describeError(error)}` });
    }
    this.ui.requestRender();
  }

  private clearSessionWriterConflict(): void {
    if (!this.sessionWriterConflict && !this.sessionWriterConflictView) return;
    if (this.sessionWriterConflictView) this.editorContainer.removeChild(this.sessionWriterConflictView);
    this.sessionWriterConflictView = undefined;
    this.sessionWriterConflict = undefined;
    this.editorContainer.addChild(this.pendingAttachmentsView);
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private async retrySessionWriterConflict(): Promise<void> {
    const conflict = this.sessionWriterConflict;
    const view = this.sessionWriterConflictView;
    if (!conflict || !view) return;
    view.setRetrying(true);
    this.ui.requestRender();
    try {
      await this.resumeSession(conflict.sessionId);
    } finally {
      if (this.sessionWriterConflictView === view) view.setRetrying(false);
      this.ui.requestRender();
    }
  }

  // ---------------------------------------------------------------- 退出

  async exit(): Promise<void> {
    // 幂等：Ctrl+C 和外部关闭可能同时触发。
    if (this.exiting) return;
    this.exiting = true;
    this.status.dispose();
    try {
      const runtime = this.runtime;
      if (runtime) {
        let snapshot = this.runtimeSnapshot;
        try {
          snapshot ??= runtime.getSnapshot();
        } catch {
          // runtime 可能正处于 Host 断线或初始化失败；仍需继续清理 TUI。
        }
        if (snapshot) {
          const { info } = snapshot;
          this.exitSummary = { sessionId: info.sessionId, sessionFile: info.sessionFile };
        }
        // 只有当前进程创建的 owner 才能在退出时取消自己的 AgentRun。附着到共享 Host
        // 的 TUI 只是观察者，断开时不能结束其他客户端正在执行的任务。
        if (snapshot && runtimeIsBusy(snapshot) && !(runtime instanceof RuntimeHostClient)) {
          await drainRuntimeBeforeExit(runtime);
        }
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await this.runtimeHost?.close();
        await runtime.close();
      } else {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    } catch {
      // 关闭 Host/runtime 失败不能中断退出：终端必须恢复，run() 的等待者必须被唤醒。
    } finally {
      this.ui.stop();
      this.resolveExit?.();
    }
  }
}

/** Skill 补全沿用两步交互，普通 slash 命令则由 Editor 在同一次 Enter 中提交。 */
export function shouldConfirmAutocompleteOnEnter(
  data: string,
  autocompleteVisible: boolean,
  inputText: string
): boolean {
  return autocompleteVisible && /^\/skill(?::|$)/u.test(inputText.trimStart()) && matchesKey(data, "enter");
}

/** 判断两次 Ctrl+C 是否处于 pi 的 500ms 退出窗口内。 */
export function isDoubleCtrlC(lastCtrlCAt: number, now: number): boolean {
  return lastCtrlCAt > 0 && now >= lastCtrlCAt && now - lastCtrlCAt < 500;
}

export function ctrlCAction(lastCtrlCAt: number, now: number): "cancel" | "exit" {
  return isDoubleCtrlC(lastCtrlCAt, now) ? "exit" : "cancel";
}

async function drainRuntimeBeforeExit(runtime: InteractiveRuntimeHandle): Promise<void> {
  runtime.cancelCurrentRun();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runtime.waitForIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TUI_SHUTDOWN_DRAIN_MS);
      })
    ]);
  } catch {
    // 退出路径 fail-closed：取消或等待失败不能阻止 TUI 断开连接。
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sessionLabel(summary: SessionSummary, nowMs: number): string {
  return `${summary.fileName.replace(/\.jsonl$/, "")} · ${formatSessionAge(summary.updatedAt, nowMs)}`;
}

function modelPresentationFromInfo(info: { provider: string; modelLabel: string; reasoningLabel: string; thinking: ThinkingSelection }): ModelPresentation {
  return {
    provider: info.provider,
    modelLabel: info.modelLabel,
    reasoningLabel: info.reasoningLabel,
    thinking: info.thinking
  };
}

function modelPresentationFromChoice(
  alias: string,
  thinking: ThinkingSelection,
  model: ModelChoice | undefined,
  fallbackProvider: string
): ModelPresentation {
  return {
    provider: model?.providerType ?? fallbackProvider,
    modelLabel: model?.displayName ?? alias,
    reasoningLabel: formatReasoningLabel(thinking),
    thinking
  };
}

function formatReasoningLabel(thinking: ThinkingSelection): string {
  if (thinking === "off") return "Off";
  return thinking === "xhigh"
    ? "XHigh"
    : `${thinking[0]?.toUpperCase() ?? ""}${thinking.slice(1)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRemoteRuntime(runtime: InteractiveRuntimeHandle): RuntimeHostClient {
  if (!(runtime instanceof RuntimeHostClient)) throw new Error("Remote runtime client is unavailable.");
  return runtime;
}

export function memoryPolicyOptionForOverride(
  state: Pick<AgentPersonalizationState, "override" | "resolved">
): typeof memoryPolicySelectOptions[number]["value"] {
  const { useMemories, contributeMemories } = state.override;
  if (useMemories === "inherit" && contributeMemories === "inherit") return "inherit";
  if (state.resolved.useMemories && state.resolved.contributeMemories) return "both";
  if (state.resolved.useMemories) return "use";
  if (state.resolved.contributeMemories) return "contribute";
  return "off";
}

export function runtimeStatus(snapshot: InteractiveRuntimeSnapshot | undefined): TuiStatus {
  if (!snapshot || snapshot.state.kind === "idle") return "idle";
  // 模型切换、会话恢复和内存整理等 maintenance 不是 Agent 工作回合，
  // 状态行保持空闲留白，不展示 Working 或耗时。
  if (snapshot.state.kind !== "runs") return "idle";
  if (snapshot.state.pendingPermission) return "waiting_permission";
  return snapshot.state.activeRun.status === "thinking" ? "thinking" : "running";
}

/**
 * 选择器从输入框下方展开，临时覆盖 footer 和快捷键行。
 * 窄终端或长列表时向上收缩，保证弹层不越过当前视口。
 */
export function selectDialogRow(
  contentHeight: number,
  dialogHeight: number,
  terminalHeight: number,
  chromeTailHeight: number
): number {
  const belowEditor = Math.max(0, contentHeight - chromeTailHeight);
  return Math.min(belowEditor, Math.max(0, terminalHeight - dialogHeight));
}
