/**
 * 桌面端聊天输入区。
 *
 * Astryx ChatComposer 只负责输入框、附件抽屉和发送按钮的视觉与基础交互；模型切换、
 * 权限变更、附件保存和 Agent 执行仍沿用 Biny 原有的数据流。Slash command 继续由
 * Biny 自己的菜单处理，避免把桌面命令协议复制到组件库的 typeahead 状态里。
 */
import { ChatComposer, ChatComposerDrawer, ChatComposerInput } from "@astryxdesign/core/Chat";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { memo, useEffect, useRef, useState } from "react";
import type { AgentSessionInfo, InteractiveAgentRunMode } from "../../../../agent/AgentSession.js";
import type { ModelChoice } from "../../../../llm/ModelManager.js";
import { modelThinkingSelections, type ThinkingSelection } from "../../../../llm/modelThinking.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopAttachment, DesktopProject, DesktopSlashCommand } from "../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../protocol.js";
import { catalogForConnection } from "../providerCatalog.js";
import { AttachmentList } from "./composer/AttachmentList.js";
import type { PendingAttachment } from "./composer/AttachmentList.js";
import { ComposerActionButton } from "./composer/ComposerActionButton.js";
import { PermissionMenu, ThinkingMenu } from "./composer/ComposerMenus.js";
import { ModelMenu } from "./composer/ModelMenu.js";
import { thinkingLabel } from "./composer/composerLabels.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";
import { SendOrStopButton } from "./composer/SendOrStopButton.js";

interface ComposerProps {
  project?: DesktopProject;
  runtimeInfo?: AgentSessionInfo;
  permissionMode: PermissionMode;
  models: ModelChoice[];
  /** 已解析好的上下文用量；取不到真实数字时为空，此时不展示用量。 */
  contextUsage?: ContextUsage;
  running: boolean;
  activeElsewhere: boolean;
  modelSetupRequired: boolean;
  focusToken: number;
  onSend(input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp"): Promise<void>;
  onSlashCommand(command: string): Promise<void>;
  onStop(): Promise<void>;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onConfigureModels(): void;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

type ComposerMenu = "permission" | "model" | "thinking" | null;

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const Composer = memo(function Composer({
  project,
  runtimeInfo,
  permissionMode,
  models,
  contextUsage,
  running,
  activeElsewhere,
  modelSetupRequired,
  focusToken,
  onSend,
  onSlashCommand,
  onStop,
  onPermissionMode,
  onSwitchModel,
  onConfigureModels,
  onSaveAttachment
}: ComposerProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InteractiveAgentRunMode>("chat");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [busy, setBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permissionAnchorRef = useRef<HTMLDivElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const thinkingAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

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

  const slashQuery = input.startsWith("/") && input.length > 0 && !/\s/.test(input) ? input : "";
  const slashMatches = slashQuery && !slashDismissed
    ? DESKTOP_SLASH_COMMANDS.filter((command) => command.name.startsWith(slashQuery))
    : [];
  const slashMenuOpen = slashMatches.length > 0 && !busy;

  const runSlash = async (command: string): Promise<void> => {
    if (!project || busy) return;
    setInput("");
    setError(undefined);
    setBusy(true);
    try {
      await onSlashCommand(command);
    } catch (slashError) {
      setInput(command);
      setError(errorMessage(slashError));
    } finally {
      setBusy(false);
    }
  };

  const chooseSlashCommand = (command: DesktopSlashCommand): void => {
    if (command.requiresArgs) {
      setInput(`${command.name} `);
      inputRef.current?.focus();
      return;
    }
    void runSlash(command.name);
  };

  const submit = async (delivery?: "steer" | "followUp", submittedInput = input): Promise<void> => {
    const value = submittedInput.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!project || !value || busy || pendingAttachments.length) return;
    const [slashName] = value.split(/\s+/, 1);
    const slashCommand = DESKTOP_SLASH_COMMANDS.find((command) => command.name === slashName);
    if (slashCommand && (value === slashCommand.name || slashCommand.acceptsArgs)) {
      await runSlash(value);
      return;
    }
    if (activeElsewhere) return;
    setInput("");
    const sentAttachments = attachments;
    setAttachments([]);
    setError(undefined);
    setBusy(true);
    try {
      await onSend(value, mode, sentAttachments, delivery);
    } catch (submitError) {
      setInput(value);
      setAttachments(sentAttachments);
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (files: File[]): Promise<void> => {
    if (!project || !files.length || busy || running) return;
    setError(undefined);
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
      if (failed.length) setError(failed.join("；"));
    } catch (attachmentError) {
      setError(errorMessage(attachmentError));
    } finally {
      setBusy(false);
    }
  };

  const requestStop = async (): Promise<void> => {
    setStopPending(true);
    setError(undefined);
    try {
      await onStop();
    } catch (stopError) {
      setStopPending(false);
      setError(errorMessage(stopError));
    }
  };

  const activeModel = models.find((model) => model.alias === runtimeInfo?.modelAlias);
  const selectedModel = activeModel ?? models[0];
  const currentAlias = activeModel?.alias ?? selectedModel?.alias;
  const currentThinking = runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";
  const selectedModelCatalog = selectedModel
    ? catalogForConnection(
      { provider: selectedModel.provider, providerType: selectedModel.providerType },
      selectedModel.baseUrl
    )
    : undefined;
  const thinkingLevels: ThinkingSelection[] = selectedModel ? modelThinkingSelections(selectedModel) : [];
  const thinkingSelectable = thinkingLevels.length > 1 || thinkingLevels.some((level) => level !== "off");
  const modelName = selectedModel?.displayName ?? runtimeInfo?.modelLabel ?? "GPT-5.6-Luna";
  const usage = formatContextUsage(contextUsage);
  const inputDisabled = activeElsewhere || modelSetupRequired || busy;
  const attachmentCount = attachments.length + pendingAttachments.length;
  const sendDisabled = running
    ? false
    : (!input.trim() && !attachments.length) || !project || activeElsewhere || modelSetupRequired || busy || pendingAttachments.length > 0;
  const sendDisabledReason = !project
    ? "请先打开一个项目。"
    : modelSetupRequired
      ? "还没有可用的模型连接，请先配置模型。"
      : activeElsewhere
        ? "另一个会话正在运行，请先切回该会话。"
        : busy
          ? "当前附件或命令正在处理，请稍候。"
          : pendingAttachments.length
            ? "请等待附件处理完成，或移除失败附件。"
          : !input.trim() && !attachments.length
            ? "输入消息或添加附件后发送。"
            : undefined;
  const placeholder = running ? "可以继续补充要求…" : "hi biny";
  const modelSwitchDisabled = !selectedModel || modelSetupRequired || activeElsewhere || running || busy;
  const modelSwitchDisabledReason = !project
    ? "请先打开一个项目。"
    : modelSetupRequired
      ? "还没有可用的模型连接，请先配置模型。"
      : activeElsewhere
        ? "另一个会话正在运行，请先切回该会话。"
        : running
          ? "当前对话正在运行，等结束后再切换模型。"
          : busy
            ? "当前附件或命令正在处理，请稍候。"
            : !selectedModel
              ? "当前没有可用的模型。"
              : undefined;
  const permissionDisabledReason = !project
    ? "请先打开一个项目。"
    : modelSetupRequired
      ? "还没有可用的模型连接，请先配置模型。"
      : undefined;

  const handleInputChange = (value: string): void => {
    setInput(value);
    setSlashIndex(0);
    setSlashDismissed(false);
  };

  return (
    <div
      className={`composer-container cindy-composer-frame${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      <ChatComposer
        className={`cindy-composer${running ? " is-running" : ""}`}
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
          <div className="cindy-composer-footer-start">
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
            <ComposerActionButton
              className="cindy-composer-add"
              disabled={!project || busy || running || modelSetupRequired}
              disabledReason={!project ? "请先打开一个项目。" : modelSetupRequired ? "还没有可用的模型连接，请先配置模型。" : running ? "当前对话正在运行，请等待结束后再添加附件。" : busy ? "当前附件或命令正在处理，请稍候。" : undefined}
              label="添加附件"
              onClick={() => fileInputRef.current?.click()}
              tooltip="添加文件或目录"
            >
              <Icon name="add" size={15} />
            </ComposerActionButton>
            <div className="composer-menu-anchor" ref={permissionAnchorRef}>
              <ComposerActionButton
                className="cindy-permission-pill"
                data-composer-menu="permission"
                disabled={!project || modelSetupRequired}
                disabledReason={permissionDisabledReason}
                active={menu === "permission"}
                aria-expanded={menu === "permission"}
                aria-haspopup="menu"
                label={cindyPermissionLabel(permissionMode)}
                onClick={() => setMenu(menu === "permission" ? null : "permission")}
                tooltip={menu === "permission" ? undefined : "选择当前会话的权限模式"}
              >
                <Icon name="spark" size={13} />
                <span>{cindyPermissionLabel(permissionMode)}</span>
                <Icon name="chevron" size={11} />
              </ComposerActionButton>
              <PermissionMenu
                anchorRef={permissionAnchorRef}
                mode={permissionMode}
                open={menu === "permission"}
                onChange={(nextMode) => {
                  setMenu(null);
                  void onPermissionMode(nextMode).catch((permissionError) => setError(errorMessage(permissionError)));
                }}
              />
            </div>
            <ComposerActionButton
              active={mode === "plan"}
              className="cindy-plan-pill"
              label={mode === "plan" ? "退出规划模式" : "进入规划模式"}
              onClick={() => setMode(mode === "plan" ? "chat" : "plan")}
              tooltip={mode === "plan" ? "规划模式已启用，点击关闭" : "让 Agent 先分析任务并制定计划"}
            >
              <Icon name="chart" size={13} />
              <span>{mode === "plan" ? "规划" : "计划"}</span>
            </ComposerActionButton>
          </div>
        )}
        input={(
          <div className="cindy-composer-editor">
            {slashMenuOpen ? (
              <div className="composer-popover slash-menu desktop-composer-menu" role="menu">
                <div className="popover-heading">命令</div>
                {slashMatches.map((command, index) => (
                  <button
                    className={`menu-option${index === slashIndex ? " is-selected" : ""}`}
                    key={command.name}
                    onClick={() => chooseSlashCommand(command)}
                    onMouseEnter={() => setSlashIndex(index)}
                    role="menuitem"
                    type="button"
                  >
                    <span className="menu-option-copy"><strong>{command.name}</strong><small>{command.description}</small></span>
                  </button>
                ))}
              </div>
            ) : null}
            <ChatComposerInput
              className="cindy-composer-input"
              handleRef={inputRef}
              label="任务输入"
              maxRows={6}
              onFiles={(files) => void addFiles(files)}
              onKeyDown={(event) => {
                if (slashMenuOpen) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setSlashIndex((current) => (current + step + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing)) {
                    event.preventDefault();
                    const selected = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
                    if (selected) chooseSlashCommand(selected);
                    return;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit(running && (event.metaKey || event.ctrlKey) ? "steer" : undefined);
              }}
            />
          </div>
        )}
        isDisabled={inputDisabled}
        isStopShown={running}
        onChange={handleInputChange}
        onStop={() => void requestStop()}
        onSubmit={(value) => void submit(undefined, value)}
        placeholder={placeholder}
        status={error
          ? { message: error, type: "error" }
          : running && input.trim()
            ? { message: "按 Enter 将补充要求排入当前会话；⌘ Enter 立即转向", type: "warning" }
            : undefined}
        statusPosition="bottom"
        sendActions={(
          <div className="cindy-composer-footer-end">
            {thinkingSelectable ? (
              <div className="composer-menu-anchor" ref={thinkingAnchorRef}>
                <ComposerActionButton
                  className="cindy-thinking-pill"
                  data-composer-menu="thinking"
                  disabled={modelSwitchDisabled}
                  disabledReason={modelSwitchDisabled ? modelSwitchDisabledReason : undefined}
                  active={menu === "thinking"}
                  aria-expanded={menu === "thinking"}
                  aria-haspopup="menu"
                  label={`思考级别：${thinkingLabel(currentThinking)}`}
                  onClick={() => setMenu(menu === "thinking" ? null : "thinking")}
                  tooltip={menu === "thinking" ? undefined : "调整当前模型的思考级别"}
                >
                  <Icon name="brain" size={13} />
                  <span>{thinkingLabel(currentThinking)}</span>
                  <Icon name="chevron" size={11} />
                </ComposerActionButton>
                <ThinkingMenu
                  anchorRef={thinkingAnchorRef}
                  current={currentThinking}
                  levels={thinkingLevels}
                  open={menu === "thinking"}
                  onChange={(thinking) => {
                    setMenu(null);
                    if (currentAlias) void onSwitchModel(currentAlias, thinking).catch((modelError) => setError(errorMessage(modelError)));
                  }}
                />
              </div>
            ) : null}
            <div className="composer-menu-anchor" ref={modelAnchorRef}>
              <ComposerActionButton
                className="cindy-model-pill"
                data-composer-menu="model"
                disabled={modelSwitchDisabled}
                disabledReason={modelSwitchDisabledReason}
                active={menu === "model"}
                aria-expanded={menu === "model"}
                aria-haspopup="menu"
                label={modelName}
                onClick={() => setMenu(menu === "model" ? null : "model")}
                tooltip={menu === "model" ? undefined : "切换当前会话使用的模型"}
              >
                {selectedModel ? <span className="model-trigger-brand"><ProviderBrandGlyph type={selectedModelCatalog?.iconTone ?? selectedModel.providerType} /></span> : null}
                <span>{modelName}</span>
                <Icon name="chevron" size={11} />
              </ComposerActionButton>
              <ModelMenu
                anchorRef={modelAnchorRef}
                currentAlias={currentAlias}
                models={models}
                open={menu === "model"}
                onChange={(alias) => {
                  setMenu(null);
                  const nextModel = models.find((model) => model.alias === alias);
                  void onSwitchModel(alias, nextModel?.defaultThinking ?? currentThinking).catch((modelError) => setError(errorMessage(modelError)));
                }}
                onConfigureModels={() => {
                  setMenu(null);
                  onConfigureModels();
                }}
              />
            </div>
            {usage ? (
              <span className="context-usage" role="status">
                <Icon name="timer" size={12} /><span>{usage.percent}%</span>
                <span className="context-usage-tip">上下文使用量<strong>{usage.used} / {usage.max} tokens</strong></span>
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

function cindyPermissionLabel(mode: PermissionMode): string {
  if (mode === "auto") return "自动审批";
  if (mode === "full-access") return "完全访问";
  if (mode === "read-only") return "只读";
  return "每次询问";
}

/**
 * 上下文用量展示值。`usedTokens` 是上一轮实际占用，`maxTokens` 是本模型允许注入的输入预算，
 * 超过它就会触发压缩，所以百分比按这个分母算才有意义。
 */
function formatContextUsage(usage?: ContextUsage): { percent: number; used: string; max: string } | undefined {
  if (!usage || usage.maxTokens <= 0 || usage.usedTokens <= 0) return undefined;
  return {
    percent: Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100)),
    used: usage.usedTokens.toLocaleString("en-US"),
    max: usage.maxTokens.toLocaleString("en-US")
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
