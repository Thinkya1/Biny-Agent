/**
 * 对话时间线：逐轮渲染用户消息、思考过程、助手回复和工具活动。
 *
 * 数据由 `buildSessionTimeline` 算好，这里只做渲染和局部交互（展开思考、复制、编辑重发、
 * 回滚文件等）。整体用 memo 包住，因为流式输出期间父组件会高频重渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { splitAttachmentReferences, type AttachmentReference } from "../../../attachmentReferences.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { useInlineImage } from "../inlineImage.js";
import { listChangedFiles, type TimelineReasoningStep, type TimelineRunStatus, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { reasoningDetailText } from "../reasoningPresentation.js";
import { turnMetrics } from "../chatModel.js";
import { speak, speechSupported } from "../speech.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { useTypewriter } from "./useTypewriter.js";
import { ToolActivity } from "./ToolActivity.js";
import { CompactionRow } from "./chat/NoticeRow.js";
import { RunErrorCard } from "./chat/RunErrorCard.js";
import { MessageClock } from "./chat/MessageClock.js";
import { ThinkingBlock } from "./chat/ThinkingBlock.js";
import { ExecutionGroup, type ExecutionGroupStep } from "./chat/ExecutionGroup.js";

interface MessageTimelineProps {
  projectId: string;
  sessionId?: string;
  turns: TimelineTurn[];
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, sessionId, turns, onPreviewFile, onOpenExternal, onResolvePermission, onResume, onRetry, onEditUserMessage, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  const [editing, setEditing] = useState<{ turnId: string; value: string; userMessageIndex: number }>();
  // 供稳定回调读取最新编辑状态：submitEditing 若直接依赖 editing，每次击键都会得到新引用，
  // 进而让所有 Turn 的 memo 失效。用 ref 读取后，回调引用在整个编辑过程保持稳定。
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // 这些回调作为 prop 传给被 React.memo 包裹的 Turn，必须保持引用稳定：流式期间父组件每帧
  // 重渲染，只有回调与 turn 引用都稳定，没有变化的轮次才会被 memo 跳过。
  const startEditing = useCallback((turn: TimelineTurn): void => {
    if (turn.userMessageIndex === undefined) return;
    // 编辑框里只放用户真正输入的那部分；附件清单是发送时补的，重发也带不回原来的附件。
    setEditing({ turnId: turn.id, value: splitAttachmentReferences(turn.user).text, userMessageIndex: turn.userMessageIndex });
  }, []);

  const cancelEditing = useCallback((): void => setEditing(undefined), []);

  const changeEditing = useCallback((value: string): void => {
    // 只有正在被编辑的那一轮会渲染输入框并触发 onChange，无需再按 turnId 过滤。
    setEditing((current) => current ? { ...current, value } : current);
  }, []);

  const submitEditing = useCallback(async (): Promise<void> => {
    const current = editingRef.current;
    if (!current || !sessionId) return;
    await onEditUserMessage(current.value, current.userMessageIndex);
    setEditing(undefined);
  }, [onEditUserMessage, sessionId]);

  return (
    <div className="message-timeline">
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          onCreateBranch={onCreateBranch}
          onDeleteUserMessage={onDeleteUserMessage}
          editing={editing?.turnId === turn.id ? editing : undefined}
          onCancelEdit={cancelEditing}
          onChangeEdit={changeEditing}
          onStartEdit={startEditing}
          onSubmitEdit={submitEditing}
          onPreviewFile={onPreviewFile}
          onOpenExternal={onOpenExternal}
          onResolvePermission={onResolvePermission}
          onResume={onResume}
          onRollbackFiles={onRollbackFiles}
          onRetry={onRetry}
          projectId={projectId}
          turn={turn}
        />
      ))}
    </div>
  );
});

const Turn = memo(function Turn({
  projectId,
  turn,
  editing,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  onResume,
  onRetry,
  onCancelEdit,
  onChangeEdit,
  onStartEdit,
  onSubmitEdit,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  projectId: string;
  turn: TimelineTurn;
  editing?: { value: string };
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(input: string): void;
  onCancelEdit(): void;
  onChangeEdit(value: string): void;
  onStartEdit(turn: TimelineTurn): void;
  onSubmitEdit(): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const running = turn.status === "running" || turn.status === "waiting_permission";
  const executionSteps = turn.steps.length ? turn.steps : fallbackExecutionSteps(turn);
  return (
    <section className={`timeline-turn is-${turn.status}`}>
      {turn.user ? (
        <UserMessage
          content={turn.user}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          editing={editing}
          onCreateBranch={onCreateBranch}
          onDelete={() => onDeleteUserMessage(turn.id)}
          onCancelEdit={onCancelEdit}
          onChangeEdit={onChangeEdit}
          onEdit={() => onStartEdit(turn)}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          onRegenerate={() => onRetry(turn.user)}
          onRollbackFiles={() => onRollbackFiles(turn)}
          onSubmitEdit={onSubmitEdit}
          projectId={projectId}
          time={turn.timestamp}
        />
      ) : null}
      <ChatMessage className="desktop-assistant-message" sender="assistant">
        <div className="agent-response">
        {executionSteps.length || turn.skills.length ? (
          <ExecutionTimeline
            onPreviewFile={onPreviewFile}
            onOpenExternal={onOpenExternal}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            running={running}
            steps={executionSteps}
            skills={turn.skills}
          />
        ) : null}
        {!executionSteps.some((step) => step.kind === "assistant") && turn.assistant ? <TypewriterMarkdown active={running} content={turn.assistant} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}

        {turn.assistant ? (
          <AssistantActions
            content={turn.assistant}
            metrics={turnMetrics(turn)}
            onCreateBranch={onCreateBranch}
            onRegenerate={turn.user ? () => onRetry(turn.user) : undefined}
            runMs={turn.durationMs}
            timestamp={turn.timestamp}
          />
        ) : null}

        {/* 底部不再展示统计与模型行；运行信息只保留在 hover 揭示的时钟里。 */}
        {/* 失败/阻塞/未完成/取消/中止统一收敛成一张错误卡片：图标 + 标题 + 人话错误 + 继续/重试。 */}
        {turn.error && isRunErrorStatus(turn.status) ? (
          <RunErrorCard
            message={turn.error}
            onResume={() => void onResume()}
            onRetry={turn.user ? () => onRetry(turn.user) : undefined}
            resumable={turn.resumable}
            status={turn.status}
          />
        ) : null}
        </div>
      </ChatMessage>
    </section>
  );
});

function fallbackExecutionSteps(turn: TimelineTurn): TimelineStep[] {
  if (!turn.reasoningStatus && !turn.reasoning && turn.durationMs === undefined) return [];
  return [{
    kind: "reasoning",
    id: `${turn.id}:reasoning:fallback`,
    content: turn.reasoning,
    status: turn.reasoningStatus,
    durationMs: turn.reasoningDurationMs ?? (turn.status === "running" || turn.status === "waiting_permission" ? undefined : turn.durationMs),
    completed: turn.status !== "running" && turn.status !== "waiting_permission"
  }];
}

/** 流式打字机版 Markdown：仅 reveal 新增量，历史/完结内容直出 */
const TypewriterMarkdown = memo(function TypewriterMarkdown({ active, content, onOpenExternal, onPreviewFile, projectId }: {
  active: boolean;
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  const typed = useTypewriter(content, active);
  return (
    <div className={active ? "with-streaming-cursor" : undefined}>
      <MarkdownContent content={typed} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
});

function ExecutionTimeline({
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  projectId,
  running,
  skills,
  steps
}: {
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  projectId: string;
  running: boolean;
  skills: string[];
  steps: TimelineStep[];
}): React.JSX.Element {
  return (
    <div className="execution-timeline">
      {skills.length ? (
        <div className="execution-step execution-skills">
          <Icon name="wand" size={14} />
          <span>使用 {String(skills.length)} 个技能</span>
          <span className="execution-skills-list">{skills.join(" · ")}</span>
        </div>
      ) : null}
      {groupExecutionSteps(steps).map((entry) => {
        // 连续的工具 + 思考步骤聚合成一个可展开块（Alma 同款）；单个步骤不套聚合壳。
        if (Array.isArray(entry)) {
          if (entry.length === 1) {
            const only = entry[0];
            // noUncheckedIndexedAccess：entry[0] 类型含 undefined，先收窄再判 kind。
            if (!only) return null;
            if (only.kind === "tool") {
              return <ToolActivity key={only.id} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} onResolvePermission={onResolvePermission} projectId={projectId} tool={only.tool} />;
            }
            return <ReasoningStepView key={only.id} running={running} step={only} />;
          }
          return (
            <ExecutionGroup
              key={entry[0]?.id ?? "execution-group"}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              projectId={projectId}
              running={running}
              steps={entry}
            />
          );
        }
        const step = entry;
        if (step.kind === "reasoning") {
          // 上下文压缩标记渲染为独立的压缩通知行。
          if (step.notice === "compaction") {
            return (
              <section className="execution-step" key={step.id}>
                <CompactionRow summary={step.status ?? ""} title="上下文已压缩" />
              </section>
            );
          }
          return <ReasoningStepView key={step.id} running={running} step={step} />;
        }
        if (step.kind === "user") {
          return (
            <div className="execution-step execution-user-step user-message" key={step.id}>
              <div className="user-bubble"><MarkdownContent content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>
            </div>
          );
        }
        if (step.kind === "tool") return null;
        if (step.summary) {
          return (
            <ActivitySummaryStep
              content={step.content}
              key={step.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              projectId={projectId}
            />
          );
        }
        return <div className="execution-step execution-assistant-step" key={step.id}><TypewriterMarkdown active={running} content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>;
      })}
    </div>
  );
}

/**
 * 把连续的可聚合步骤（工具调用 + 非压缩通知的思考）收成一组；其余步骤原样保留顺序。
 *
 * 思考不再把工具组切断：reasoning 步骤与相邻 tool 步骤进同一个聚合块。压缩标记
 * （notice === "compaction"）、assistant 正文/摘要、用户插话仍然是分组断点。
 */
function groupExecutionSteps(steps: TimelineStep[]): Array<TimelineStep | ExecutionGroupStep[]> {
  const grouped: Array<TimelineStep | ExecutionGroupStep[]> = [];
  for (const step of steps) {
    if (!isGroupableStep(step)) {
      grouped.push(step);
      continue;
    }
    const last = grouped.at(-1);
    if (Array.isArray(last)) last.push(step);
    else grouped.push([step]);
  }
  return grouped;
}

function isGroupableStep(step: TimelineStep): step is ExecutionGroupStep {
  if (step.kind === "tool") return true;
  return step.kind === "reasoning" && step.notice !== "compaction";
}

/** 失败/阻塞/未完成/取消/中止：这些终态的错误输出统一走 RunErrorCard。 */
function isRunErrorStatus(status: TimelineRunStatus): boolean {
  return status === "failed"
    || status === "blocked"
    || status === "incomplete"
    || status === "cancelled"
    || status === "aborted";
}

function ActivitySummaryStep({ content, onOpenExternal, onPreviewFile, projectId }: {
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  return (
    <div className="execution-step execution-assistant-step execution-summary-step">
      <MarkdownContent content={content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
}

function ReasoningStepView({ running, step }: {
  running: boolean;
  step: TimelineReasoningStep;
}): React.JSX.Element {
  // The status is a label for the disclosure row, not the model's reasoning
  // content. Providers that do not return reasoning deltas must not make
  // statuses such as “分析完成” look like generated content.
  const text = reasoningDetailText(step);
  return (
    <section className="execution-step execution-reasoning">
      <ThinkingBlock
        durationMs={step.durationMs}
        running={running && !step.completed}
        text={text}
      />
    </section>
  );
}

function UserMessage({
  content,
  hasChangedFiles,
  editing,
  onCreateBranch,
  onDelete,
  onEdit,
  onCancelEdit,
  onChangeEdit,
  onOpenExternal,
  onPreviewFile,
  onRegenerate,
  onRollbackFiles,
  onSubmitEdit,
  projectId,
  time
}: {
  content: string;
  hasChangedFiles: boolean;
  editing?: { value: string };
  onCreateBranch(): void;
  onDelete(): void;
  onEdit(): void;
  onCancelEdit(): void;
  onChangeEdit(value: string): void;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  onRegenerate(): void;
  onRollbackFiles(): void;
  onSubmitEdit(): Promise<void>;
  projectId: string;
  /** 消息时间（ISO 字符串）；存在时操作行前置 hover 揭示的日期感知时钟。 */
  time?: string;
}): React.JSX.Element {
  const { open: menuOpen, setOpen: setMenuOpen, containerRef: actionsRef } = useDismissableMenu();
  // 发送时追加给模型的附件清单不该原样显示，拆出来渲染成附件卡片。
  const message = useMemo(() => splitAttachmentReferences(content), [content]);

  if (editing) {
    return (
      <ChatMessage className="user-message is-editing" sender="user">
        <ChatMessageBubble>
          <InlineUserMessageEditor
            value={editing.value}
            onCancel={onCancelEdit}
            onChange={onChangeEdit}
            onSubmit={onSubmitEdit}
          />
        </ChatMessageBubble>
      </ChatMessage>
    );
  }

  const closeMenu = (): void => setMenuOpen(false);
  const clock = time ? <MessageClock time={Date.parse(time)} /> : null;
  return (
    <ChatMessage className="user-message" sender="user">
      <ChatMessageBubble className="user-bubble">
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </ChatMessageBubble>
      <div className={`user-message-actions${menuOpen ? " is-open" : ""}`} data-time-hover-root ref={actionsRef}>
        {clock}
        <button aria-label="复制消息" className="user-message-action" onClick={() => copyText(message.text)} title="复制消息" type="button"><Icon name="copy" size={16} /></button>
        <button aria-label="重新生成" className="user-message-action" onClick={onRegenerate} title="重新生成" type="button"><Icon name="refresh" size={16} /></button>
        <button aria-label="编辑消息" className="user-message-action" onClick={onEdit} title="编辑消息" type="button"><Icon name="edit" size={16} /></button>
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多消息操作" className="user-message-action" onClick={() => setMenuOpen(!menuOpen)} title="更多" type="button"><Icon name="more" size={16} /></button>
        {menuOpen ? (
          <div className="user-message-menu" role="menu">
            <button className="message-menu-item" onClick={() => { copyText(message.text); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
            <button className="message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(message.text)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
            <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
            <button className="message-menu-item" disabled={!hasChangedFiles} onClick={() => { onRollbackFiles(); closeMenu(); }} role="menuitem" title={hasChangedFiles ? "回滚本条消息产生的文件修改" : "当前消息没有可回滚的文件修改"} type="button"><Icon name="arrow-left" size={14} /><span>回滚文件</span></button>
            <div className="message-menu-separator" />
            <button className="message-menu-item is-danger" onClick={() => { onDelete(); closeMenu(); }} role="menuitem" type="button"><Icon name="trash" size={14} /><span>删除消息</span></button>
          </div>
        ) : null}
      </div>
    </ChatMessage>
  );
}

function InlineUserMessageEditor({ value, onCancel, onChange, onSubmit }: {
  value: string;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const initialValueRef = useRef(value);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(initialValueRef.current.length, initialValueRef.current.length);
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="user-message-editor">
      <textarea
        aria-label="编辑用户消息"
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={() => { composingRef.current = false; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || composingRef.current || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
        ref={textareaRef}
        rows={1}
        value={value}
      />
      {error ? <div className="user-message-editor-error"><Icon name="warning" size={12} /><span>{error}</span></div> : null}
      <div className="user-message-editor-actions">
        <button disabled={busy} onClick={onCancel} type="button">取消</button>
        <button className="is-primary" disabled={busy || !value.trim()} onClick={() => void submit()} type="button">{busy ? "发送中…" : "发送"}</button>
      </div>
    </div>
  );
}

function copyText(content: string): void {
  void copyToClipboard(content);
}

function plainTextFromMarkdown(content: string): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .trim();
}

/** 助手回复下方的操作条：复制、朗读、重新生成，以及放次要操作的更多菜单；
 *  操作条尾部是日期感知时钟 + 运行指标（用时 / 首 token / 解码吞吐），hover 揭示。 */
function AssistantActions({ content, timestamp, metrics, runMs, onCreateBranch, onRegenerate }: {
  content: string;
  timestamp?: string;
  metrics?: { ttftMs?: number; tokensPerSecond?: number; llmMs?: number };
  runMs?: number;
  onCreateBranch(): void;
  onRegenerate?(): void;
}): React.JSX.Element {
  const { open: menuOpen, setOpen: setMenuOpen, containerRef: actionsRef } = useDismissableMenu();
  const [speaking, setSpeaking] = useState(false);
  const stopSpeechRef = useRef<() => void>(undefined);

  // 组件卸载（切会话、消息被折叠）时朗读要跟着停，否则声音会一直放到读完。
  useEffect(() => () => stopSpeechRef.current?.(), []);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeechRef.current?.();
      return;
    }
    setSpeaking(true);
    stopSpeechRef.current = speak(plainTextFromMarkdown(content), () => setSpeaking(false));
  };

  const closeMenu = (): void => setMenuOpen(false);
  const clock = timestamp ? (
    <MessageClock
      llmMs={metrics?.llmMs}
      runMs={runMs}
      time={Date.parse(timestamp)}
      tokensPerSecond={metrics?.tokensPerSecond}
      ttftMs={metrics?.ttftMs}
    />
  ) : null;
  return (
    <div className={`assistant-actions${menuOpen ? " is-open" : ""}`} data-time-hover-root ref={actionsRef}>
      <CopyButton className="assistant-action" label="复制回复" size={16} value={content} />
      {speechSupported() ? (
        <button aria-label={speaking ? "停止朗读" : "朗读回复"} className={`assistant-action${speaking ? " is-active" : ""}`} onClick={toggleSpeech} title={speaking ? "停止朗读" : "朗读回复"} type="button"><Icon name={speaking ? "volume-off" : "volume"} size={16} /></button>
      ) : null}
      {onRegenerate ? (
        <button aria-label="重新生成" className="assistant-action" onClick={onRegenerate} title="重新生成" type="button"><Icon name="refresh" size={16} /></button>
      ) : null}
      <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多回复操作" className="assistant-action" onClick={() => setMenuOpen(!menuOpen)} title="更多" type="button"><Icon name="more" size={16} /></button>
      {menuOpen ? (
        <div className="assistant-message-menu" role="menu">
          <button className="message-menu-item" onClick={() => { copyText(content); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
          <button className="message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(content)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
        </div>
      ) : null}
      {clock}
    </div>
  );
}

/** 用户消息里的附件：图片直接显示缩略图，其他类型退回成带文件名的卡片。 */
function MessageAttachments({ attachments, projectId }: { attachments: AttachmentReference[]; projectId: string }): React.JSX.Element {
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentCard attachment={attachment} key={attachment.path} projectId={projectId} />
      ))}
    </div>
  );
}

function AttachmentCard({ attachment, projectId }: { attachment: AttachmentReference; projectId: string }): React.JSX.Element {
  const isImage = attachment.mimeType?.startsWith("image/") ?? false;
  const source = useInlineImage(projectId, isImage ? attachment.path : "");
  if (source) return <img alt={attachment.name} className="message-attachment-image" src={source} title={attachment.name} />;
  return (
    <div className="message-attachment" title={attachment.path}>
      <Icon name={isImage ? "spark" : "file"} size={13} />
      <span>{attachment.name}</span>
    </div>
  );
}

/**
 * 悬浮菜单的开合：点到容器外面或按 Esc 就关。
 *
 * `containerRef` 要挂在同时包住触发按钮和菜单的那层容器上，否则点菜单项本身也会被当成外部点击。
 */
function useDismissableMenu(): {
  open: boolean;
  setOpen(open: boolean): void;
  containerRef: React.RefObject<HTMLDivElement | null>;
} {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return { open, setOpen, containerRef };
}
