/**
 * 桌面端聊天输入区。
 *
 * Astryx ChatComposer 只负责输入框、附件抽屉和发送按钮的视觉与基础交互；模型切换、
 * 权限变更、附件保存和 Agent 执行仍沿用 Biny 原有的数据流。Slash command 使用
 * Astryx 输入控件内置的 trigger 菜单，避免在组件里复制一套会和 contentEditable 键盘状态冲突的补全逻辑。
 */
import { ChatComposer, ChatComposerDrawer, ChatComposerInput } from "@astryxdesign/core/Chat";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSessionInfo, InteractiveAgentRunMode } from "../../../../agent/AgentSession.js";
import type { ModelChoice } from "../../../../llm/ModelManager.js";
import { modelThinkingSelections, thinkingSelectionForModel, type ThinkingSelection } from "../../../../llm/modelThinking.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopAttachment, DesktopProject, DesktopSkillCatalogEntry } from "../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../protocol.js";
import { catalogForConnection } from "../providerCatalog.js";
import { formatContextUsage, type ContextUsage } from "../usagePresentation.js";
import { AttachmentList } from "./composer/AttachmentList.js";
import type { PendingAttachment } from "./composer/AttachmentList.js";
import { ComposerActionButton } from "./composer/ComposerActionButton.js";
import { AddMenu, PermissionMenu } from "./composer/ComposerMenus.js";
import { ModelPickerMenu } from "./composer/ModelPickerMenu.js";
import { permissionIcon, permissionLabel, thinkingLabel } from "./composer/composerLabels.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";
import { SendOrStopButton } from "./composer/SendOrStopButton.js";
import { useBreathingCaret } from "./composer/useBreathingCaret.js";
import { useTypedPlaceholder } from "./composer/useTypedPlaceholder.js";
import { isSkillSlashCommand, normalizeSkillSlashCommand } from "./composer/desktopSlashCommands.js";
import { createDesktopSlashTrigger } from "./composer/desktopSlashTrigger.js";

interface ComposerProps {
  project?: DesktopProject;
  runtimeInfo?: AgentSessionInfo;
  permissionMode: PermissionMode;
  models: ModelChoice[];
  /** 已解析好的上下文用量；取不到真实数字时为空，此时不展示用量。 */
  contextUsage?: ContextUsage;
  memoryEnabled: boolean;
  memoryToggleBusy: boolean;
  memoryToggleDisabled: boolean;
  memoryToggleDisabledReason?: string;
  permissionModePending: boolean;
  running: boolean;
  runtimeBusy: boolean;
  sessionWriterConflict: boolean;
  modelSetupRequired: boolean;
  focusToken: number;
  prefillInput?: string;
  /** 建议 pill 直达提交：nonce 变化时以该文本走统一提交路径（首页 pill 点击即发送）。 */
  submitDraft?: { text: string; nonce: number };
  /** submitDraft 被领取后回调清掉源头——draft 是单次信号，不清的话 Composer 每次重挂载（过场落地、新建任务回首页）都会把旧草稿再发一遍。 */
  onSubmitDraftConsumed?(): void;
  /** 内联进底栏的工作区/分支选择器（Alma 式：文件夹图标 + 项目名 位于工具栏左组）。 */
  workspaceContext?: React.ReactNode;
  skills: DesktopSkillCatalogEntry[];
  onSend(input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp", idempotencyKey?: string): Promise<void>;
  onSlashCommand(command: string): Promise<void>;
  onExpandSkillCommand(input: string): Promise<string>;
  onStop(): Promise<void>;
  onToggleMemory(): Promise<void>;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
  onWarning(message: string): void;
}

type ComposerMenu = "permission" | "model" | "add" | null;
type PendingModelSelection = { alias: string; thinking: ThinkingSelection };

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const Composer = memo(function Composer({
  project,
  runtimeInfo,
  permissionMode,
  models,
  contextUsage,
  memoryEnabled,
  memoryToggleBusy,
  memoryToggleDisabled,
  memoryToggleDisabledReason,
  permissionModePending,
  running,
  runtimeBusy,
  sessionWriterConflict,
  modelSetupRequired,
  focusToken,
  prefillInput,
  submitDraft,
  onSubmitDraftConsumed,
  workspaceContext,
  skills,
  onSend,
  onSlashCommand,
  onExpandSkillCommand,
  onStop,
  onToggleMemory,
  onPermissionMode,
  onSwitchModel,
  onSaveAttachment,
  onWarning
}: ComposerProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InteractiveAgentRunMode>("chat");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [busy, setBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [optimisticModel, setOptimisticModel] = useState<PendingModelSelection>();
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const breathingCaretRef = useRef<HTMLDivElement>(null);
  useBreathingCaret(editorWrapRef, breathingCaretRef);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addAnchorRef = useRef<HTMLDivElement>(null);
  const permissionAnchorRef = useRef<HTMLDivElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const modelSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const modelSwitchPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const modelSwitchRequestRef = useRef(0);
  const submitFlightRef = useRef(false);

  useEffect(() => {
    modelSwitchRequestRef.current += 1;
    setOptimisticModel(undefined);
    modelSwitchPromiseRef.current = undefined;
    modelSwitchQueueRef.current = Promise.resolve();
    setInput("");
    setAttachments([]);
    setPendingAttachments([]);
    setMode("chat");
    setMenu(null);
  }, [project?.id]);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (prefillInput === undefined) return;
    setInput(prefillInput);
    inputRef.current?.focus();
  }, [prefillInput]);

  useEffect(() => {
    if (!running) setStopPending(false);
  }, [running]);

  useEffect(() => {
    if (!menu) return;
    const isInsideOpenMenu = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".composer-popover")) return true;
      return Boolean(target.closest(`[data-composer-menu="${menu}"]`));
    };
    const close = (event: PointerEvent): void => {
      if (!isInsideOpenMenu(event.target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  const desktopSlashTriggers = useMemo(() => [createDesktopSlashTrigger(skills)], [skills]);

  const runSlash = async (command: string): Promise<void> => {
    if (!project || busy) return;
    setInput("");
    setBusy(true);
    try {
      await onSlashCommand(command);
    } catch (slashError) {
      setInput(command);
      onWarning(errorMessage(slashError));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (delivery?: "steer" | "followUp", submittedInput = input): Promise<void> => {
    const value = submittedInput.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!project || !value || busy || submitFlightRef.current || pendingAttachments.length || permissionModePending || memoryToggleBusy) return;
    submitFlightRef.current = true;
    try {
      const pendingModelSwitch = modelSwitchPromiseRef.current;
      if (pendingModelSwitch) {
        // 斜杠命令也应看到已确认的 Runtime 状态；否则紧接着执行 `/status` 或再次切模
        // 时，命令可能与上一轮切换并发竞争。
        try {
          await pendingModelSwitch;
        } catch {
          // startModelSwitch 已提示具体错误；保留输入，避免继续操作旧模型。
          return;
        }
      }
      const [slashName] = value.split(/\s+/, 1);
      const slashCommand = DESKTOP_SLASH_COMMANDS.find((command) => command.name === slashName);
      if (slashCommand && (value === slashCommand.name || slashCommand.acceptsArgs)) {
        await runSlash(value);
        return;
      }
      if (sessionWriterConflict) return;
      const sentAttachments = attachments;
      setBusy(true);
      try {
        const sendValue = isSkillSlashCommand(value)
          ? await onExpandSkillCommand(normalizeSkillSlashCommand(value))
          : value;
        // 模型标签已经即时更新，但真正的 Runtime 切换仍需完成后才能发送，
        // 否则用户紧接着按 Enter 时可能把消息发给旧模型。
        setInput("");
        setAttachments([]);
        await onSend(sendValue, mode, sentAttachments, delivery, globalThis.crypto.randomUUID());
      } catch (submitError) {
        setInput(value);
        setAttachments(sentAttachments);
        onWarning(errorMessage(submitError));
      } finally {
        setBusy(false);
      }
    } finally {
      submitFlightRef.current = false;
    }
  };

  // 建议 pill 直达提交：nonce 每次自增，文本走与手动输入完全相同的提交路径。
  // 先领走再提交：draft 是单次信号，App 侧不清掉的话每次重挂载都会重复发送。
  useEffect(() => {
    if (!submitDraft) return;
    onSubmitDraftConsumed?.();
    void submit(undefined, submitDraft.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只对 nonce 变化响应，submit 取当帧闭包
  }, [submitDraft]);

  const addFiles = async (files: File[]): Promise<void> => {
    if (!project || !files.length || busy || submitFlightRef.current || running || sessionWriterConflict) return;
    setBusy(true);
    try {
      const existing = new Set([
        ...attachments.map((attachment) => `${attachment.name}:${String(attachment.size)}:${attachment.mimeType}`),
        ...pendingAttachments.map((attachment) => `${attachment.name}:${String(attachment.size)}:${attachment.mimeType}`)
      ]);
      const incoming: File[] = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 50 MB。`);
        const key = `${file.name}:${String(file.size)}:${file.type}`;
        if (existing.has(key) || incoming.some((item) => `${item.name}:${String(item.size)}:${item.type}` === key)) {
          throw new Error(`${file.name} 已经添加。`);
        }
        incoming.push(file);
      }
      if (attachments.length + pendingAttachments.length + incoming.length > MAX_COMPOSER_ATTACHMENTS) {
        throw new Error(`最多添加 ${String(MAX_COMPOSER_ATTACHMENTS)} 个附件。`);
      }
      const uploadItems = incoming.map((file, index) => ({
        file,
        pending: {
          id: `${String(Date.now())}-${String(index)}-${file.name}`,
          mimeType: file.type,
          name: file.name,
          size: file.size,
          status: "uploading" as const
        }
      }));
      setPendingAttachments((current) => [...current, ...uploadItems.map((item) => item.pending)]);
      const results = await Promise.all(uploadItems.map(async ({ file, pending }) => {
        try {
          const saved = await onSaveAttachment(file);
          setPendingAttachments((current) => current.filter((item) => item.id !== pending.id));
          return { pending, saved };
        } catch (uploadError) {
          const message = errorMessage(uploadError);
          setPendingAttachments((current) => current.map((item) => item.id === pending.id ? { ...item, error: message, status: "error" } : item));
          return { error: message, pending };
        }
      }));
      const saved = results.flatMap((result): DesktopAttachment[] => {
        const uploaded = "saved" in result ? result.saved : undefined;
        return uploaded ? [uploaded] : [];
      });
      if (saved.length) setAttachments((current) => [...current, ...saved].slice(0, MAX_COMPOSER_ATTACHMENTS));
      const failed = results.flatMap((result) => "error" in result ? [result.error] : []);
      if (failed.length) onWarning(failed.join("；"));
    } catch (attachmentError) {
      onWarning(errorMessage(attachmentError));
    } finally {
      setBusy(false);
    }
  };

  const requestStop = async (): Promise<void> => {
    setStopPending(true);
    try {
      await onStop();
    } catch (stopError) {
      setStopPending(false);
      onWarning(errorMessage(stopError));
    }
  };

  const activeModel = models.find((model) => model.alias === (optimisticModel?.alias ?? runtimeInfo?.modelAlias));
  const selectedModel = activeModel ?? models[0];
  const currentAlias = activeModel?.alias ?? selectedModel?.alias;
  const runtimeThinking = optimisticModel?.thinking ?? runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";
  const thinkingLevels: ThinkingSelection[] = selectedModel ? modelThinkingSelections(selectedModel) : [];
  const currentThinking = selectedModel
    ? thinkingSelectionForModel(runtimeThinking, selectedModel)
    : undefined;
  const thinkingAvailable = Boolean(currentThinking && thinkingLevels.length);
  const selectedModelCatalog = selectedModel
    ? catalogForConnection(
      { provider: selectedModel.provider, providerType: selectedModel.providerType },
      selectedModel.baseUrl
    )
    : undefined;
  const modelName = selectedModel?.displayName ?? runtimeInfo?.modelLabel ?? "未配置模型";
  const startModelSwitch = (alias: string, thinking: ThinkingSelection): void => {
    const requestId = modelSwitchRequestRef.current + 1;
    modelSwitchRequestRef.current = requestId;
    setOptimisticModel({ alias, thinking });
    const request = modelSwitchQueueRef.current
      .catch(() => undefined)
      .then(async () => await onSwitchModel(alias, thinking));
    modelSwitchQueueRef.current = request.catch(() => undefined);
    modelSwitchPromiseRef.current = request;
    void request.then(
      () => {
        if (modelSwitchRequestRef.current !== requestId) return;
        modelSwitchPromiseRef.current = undefined;
        setOptimisticModel(undefined);
      },
      (modelError) => {
        if (modelSwitchRequestRef.current !== requestId) return;
        modelSwitchPromiseRef.current = undefined;
        setOptimisticModel(undefined);
        onWarning(errorMessage(modelError));
      }
    );
  };
  const chooseModel = (alias: string): void => {
    const nextModel = models.find((model) => model.alias === alias);
    if (!nextModel) return;
    const nextThinking = nextModel.efforts.length ? nextModel.defaultThinking : "off";
    // 选中模型后保留模型设置面板，用户可以继续悬停“推理强度”选择档位。
    startModelSwitch(alias, nextThinking);
  };
  const usage = formatContextUsage(contextUsage);
  const inputDisabled = sessionWriterConflict || busy;
  const attachmentCount = attachments.length + pendingAttachments.length;
  const sendDisabled = permissionModePending || memoryToggleBusy || (running
    ? false
    : (!input.trim() && !attachments.length) || !project || sessionWriterConflict || modelSetupRequired || busy || pendingAttachments.length > 0);
  const sendDisabledReason = !project
    ? "请先打开一个项目。"
      : modelSetupRequired
        ? "还没有可用的模型连接，请先配置模型。"
        : permissionModePending
          ? "正在确认权限模式，请稍候。"
        : memoryToggleBusy
          ? "正在确认当前聊天的记忆状态，请稍候。"
        : sessionWriterConflict
          ? "会话已在另一个应用中打开，请先在那里关闭后重试。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : pendingAttachments.length
            ? "请等待附件处理完成，或移除失败附件。"
          : !input.trim() && !attachments.length
            ? "输入消息或添加附件后发送。"
            : undefined;
  const placeholder = running ? "可以继续补充要求…" : "随便说点什么…";
  // 空输入时 placeholder 逐字打出，让输入框保持「活」的感觉
  const typedPlaceholder = useTypedPlaceholder(placeholder, input.trim().length === 0);
  const modelSwitchPending = Boolean(optimisticModel);
  const modelSwitchDisabled = sessionWriterConflict || running || runtimeBusy || busy;
  const modelSwitchDisabledReason = !project
    ? "请先打开一个项目。"
    : sessionWriterConflict
      ? "会话已在另一个应用中打开。"
      : running
        ? "当前对话正在运行，等结束后再切换模型。"
        : runtimeBusy
          ? "Runtime 正在处理其他操作，请稍候再切换模型。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : undefined;
  const permissionSwitchDisabled = !project || permissionModePending || sessionWriterConflict || runtimeBusy || busy;
  const permissionDisabledReason = !project
    ? "请先打开一个项目。"
    : permissionModePending
      ? "正在确认权限模式，请稍候。"
    : sessionWriterConflict
      ? "会话已在另一个应用中打开。"
      : running
        ? "当前对话正在运行，请等待结束后再切换权限模式。"
        : runtimeBusy
          ? "Runtime 正在处理其他操作，请稍候再切换权限模式。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : undefined;
  useEffect(() => {
    if (permissionSwitchDisabled && menu === "permission") setMenu(null);
  }, [menu, permissionSwitchDisabled]);

  const handleInputChange = (value: string): void => {
    setInput(value);
  };

  return (
    <div
      className={`composer-container biny-composer-frame${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      <ChatComposer
        className={`biny-composer${running ? " is-running" : ""}`}
        density="compact"
        drawer={attachmentCount ? (
          <ChatComposerDrawer count={attachmentCount} label="附件">
            <AttachmentList
              attachments={attachments}
              onRemove={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              onRemovePending={(id) => setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              pending={pendingAttachments}
            />
          </ChatComposerDrawer>
        ) : undefined}
        footerActions={(
          <div className="biny-composer-footer-start">
            <input
              hidden
              multiple
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <div className="composer-menu-anchor" ref={addAnchorRef}>
              <ComposerActionButton
                aria-expanded={menu === "add"}
                aria-haspopup="menu"
                className="biny-composer-add"
                data-composer-menu="add"
                disabled={!project || busy || running}
                disabledReason={!project ? "请先打开一个项目。" : running ? "当前对话正在运行，请等待结束后再添加附件。" : busy ? "当前附件或命令正在处理，请稍候。" : undefined}
                label="添加附件或开启规划模式"
                onClick={() => setMenu(menu === "add" ? null : "add")}
                tooltip="添加文件，或勾选规划模式"
              >
                <Icon name="add" size={15} />
              </ComposerActionButton>
              <AddMenu
                anchorRef={addAnchorRef}
                onPickFiles={() => {
                  setMenu(null);
                  fileInputRef.current?.click();
                }}
                onPlanModeChange={(active) => {
                  setMenu(null);
                  setMode(active ? "plan" : "chat");
                }}
                open={menu === "add"}
                planActive={mode === "plan"}
              />
            </div>
            {/* 规划模式激活后显示为可退出的模式 pill（参考 Maka Agent）。 */}
            {mode === "plan" ? (
              <ComposerActionButton
                active
                className="biny-plan-pill"
                label="退出规划模式"
                onClick={() => setMode("chat")}
                tooltip="规划模式已启用，点击关闭"
              >
                <Icon name="chart" size={13} />
                <span>规划</span>
              </ComposerActionButton>
            ) : null}
            {workspaceContext}
            <div className="composer-menu-anchor" ref={permissionAnchorRef}>
              <ComposerActionButton
                className="biny-permission-pill"
                data-composer-menu="permission"
                disabled={permissionSwitchDisabled}
                disabledReason={permissionDisabledReason}
                active={menu === "permission"}
                aria-expanded={menu === "permission"}
                aria-haspopup="menu"
                data-permission-mode={permissionMode}
                label={permissionLabel(permissionMode)}
                loading={permissionModePending}
                onClick={() => setMenu(menu === "permission" ? null : "permission")}
                tooltip={menu === "permission" ? undefined : "选择当前会话的权限模式"}
              >
                <Icon name={permissionIcon(permissionMode)} size={13} />
                <Icon name="chevron" size={11} />
              </ComposerActionButton>
              <PermissionMenu
                anchorRef={permissionAnchorRef}
                mode={permissionMode}
                open={menu === "permission"}
                onChange={(nextMode) => {
                  setMenu(null);
                  void onPermissionMode(nextMode).catch((permissionError) => onWarning(permissionErrorMessage(permissionError)));
                }}
              />
            </div>
            <div className="composer-menu-anchor" ref={modelAnchorRef}>
              <ComposerActionButton
                className="biny-model-pill"
                data-composer-menu="model"
                disabled={modelSwitchDisabled}
                disabledReason={modelSwitchDisabledReason}
                loading={modelSwitchPending}
                active={menu === "model"}
                aria-expanded={menu === "model"}
                aria-haspopup="menu"
                label={thinkingAvailable && currentThinking ? `${modelName} · ${thinkingLabel(currentThinking)}` : modelName}
                onClick={() => setMenu(menu === "model" ? null : "model")}
                tooltip={menu === "model" ? undefined : "模型与推理强度"}
              >
                {selectedModel ? <span className="model-trigger-brand"><ProviderBrandGlyph type={selectedModelCatalog?.iconTone ?? selectedModel.providerType} /></span> : null}
                <span>{modelName}</span>
                {thinkingAvailable && currentThinking ? <span className="model-trigger-thinking">{thinkingLabel(currentThinking)}</span> : null}
                <Icon name="chevron" size={11} />
              </ComposerActionButton>
              <ModelPickerMenu
                anchorRef={modelAnchorRef}
                currentAlias={currentAlias}
                currentModelName={modelName}
                currentThinking={currentThinking}
                models={models}
                onClose={() => setMenu(null)}
                onSelectModel={chooseModel}
                onSelectThinking={(thinking) => {
                  setMenu(null);
                  if (currentAlias) startModelSwitch(currentAlias, thinking);
                }}
                open={menu === "model"}
                thinkingLevels={thinkingLevels}
              />
            </div>
          </div>
        )}
        input={(
          <div className="biny-composer-editor" ref={editorWrapRef}>
            <ChatComposerInput
              className="biny-composer-input"
              debounceMs={0}
              handleRef={inputRef}
              label="任务输入"
              maxRows={6}
              onFiles={(files) => void addFiles(files)}
              onKeyDown={(event) => {
                // trigger 菜单会先消费 ↑↓/Enter/Tab/Escape；这里只接管运行中的
                // Cmd/Ctrl+Enter，其余 Enter 交给 ChatComposerInput 的提交逻辑。
                if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
                if (running && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit("steer");
                }
              }}
              triggers={desktopSlashTriggers}
            />
            <div ref={breathingCaretRef} className="biny-breathing-caret" aria-hidden="true" />
          </div>
        )}
        isDisabled={inputDisabled}
        isStopShown={running}
        onChange={handleInputChange}
        onStop={() => void requestStop()}
        onSubmit={(value) => void submit(undefined, value)}
        placeholder={typedPlaceholder}
        status={running && input.trim()
          ? { message: "按 Enter 将补充要求排入当前会话；⌘ Enter 立即转向", type: "warning" }
          : undefined}
        statusPosition="bottom"
        sendActions={(
          <div className="biny-composer-footer-end">
            <div className="composer-menu-anchor">
              <ComposerActionButton
                aria-pressed={memoryEnabled}
                className="biny-memory-toggle"
                data-memory-enabled={memoryEnabled ? "true" : "false"}
                disabled={memoryToggleDisabled}
                disabledReason={memoryToggleDisabledReason}
                label={memoryEnabled ? "关闭当前聊天记忆" : "开启当前聊天记忆"}
                loading={memoryToggleBusy}
                onClick={() => { void onToggleMemory(); }}
                tooltip={memoryEnabled ? "隐身模式已关闭 - 点击禁用记忆功能" : "隐身模式已开启 - 点击启用记忆功能"}
              >
                <Icon name={memoryEnabled ? "brain-spark" : "brain-off"} size={20} />
              </ComposerActionButton>
            </div>
            {usage ? (
              <span className="context-usage" role="status">
                <Icon name="timer" size={12} /><span>{usage.percent}%</span>
                <span className="context-usage-tip">
                  <span>上下文使用量</span>
                  <strong>{usage.percent}% 已占用</strong>
                  <strong>{usage.used} / {usage.max} tokens</strong>
                  {usage.reserved ? (
                    <span>模型窗口 {usage.window}，其中 {usage.reserved} 为输出等预留</span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </div>
        )}
        sendButton={(
          <SendOrStopButton
            disabled={sendDisabled}
            disabledReason={sendDisabledReason}
            onSend={() => void submit()}
            onStop={() => void requestStop()}
            running={running}
            stopPending={stopPending}
          />
        )}
        value={input}
      />
    </div>
  );
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  return message.includes("Cannot start permission update while the runtime is busy")
    ? "当前对话正在运行，权限模式需等本轮结束后再修改。"
    : message;
}
