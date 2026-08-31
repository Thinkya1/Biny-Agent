/**
 * 对话时间线：逐轮渲染用户消息、思考过程、助手回复和工具活动。
 *
 * 数据由 `buildSessionTimeline` 算好，这里只做渲染和局部交互（展开思考、复制、编辑重发、
 * 回滚文件等）。整体用 memo 包住，因为流式输出期间父组件会高频重渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ThinkingOrb } from "thinking-orbs";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { SessionUsage } from "../../../../session/metadata.js";
import { splitAttachmentReferences, type AttachmentReference } from "../../../attachmentReferences.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { useInlineImage } from "../inlineImage.js";
import { listChangedFiles, type TimelineReasoningStep, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { reasoningDetailText } from "../reasoningPresentation.js";
import { buildUsageDetailRows, finishReasonTone, formatDuration, formatMessageClock, formatRunDuration, isRunErrorStatus, runErrorSeenKey, turnMetrics, type TurnMetrics } from "../chatModel.js";
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
import { pickThinkingMessage } from "../thinkingMessages.js";

interface MessageTimelineProps {
  projectId: string;
  sessionId?: string;
  turns: TimelineTurn[];
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  thinking: boolean;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onEditUserMessage(input: string, userMessageIndex: number, idempotencyKey: string): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

interface OptimisticRewrite {
  turnId: string;
  user: string;
  userMessageIndex?: number;
  assistantMessageId?: string;
  mode: "retry" | "edit";
  settled: boolean;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, sessionId, turns, onPreviewFile, onOpenExternal, onResolvePermission, onResume, thinking, onRetry, onSwitchVersion, onEditUserMessage, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  const [editing, setEditing] = useState<{ turnId: string; value: string; userMessageIndex: number }>();
  // 重试/重写会先把目标之后的消息从视图中撤掉，再等待新回合流入；这里保留同样的
  // 乐观投影。持久化仍由 App/Runtime 负责，组件只在请求尚未完成时负责视觉上的覆盖。
  const [optimisticRewrite, setOptimisticRewrite] = useState<OptimisticRewrite>();
  const [rewriteThinkingMessage] = useState(() => pickThinkingMessage());
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

  const cancelEditing = useCallback((): void => {
    setEditing(undefined);
    setOptimisticRewrite(undefined);
  }, []);

  const changeEditing = useCallback((value: string): void => {
    // 只有正在被编辑的那一轮会渲染输入框并触发 onChange，无需再按 turnId 过滤。
    setEditing((current) => current ? { ...current, value } : current);
  }, []);

  const startOptimisticRewrite = useCallback((turn: TimelineTurn, mode: OptimisticRewrite["mode"], user = turn.user): void => {
    setOptimisticRewrite({
      turnId: turn.id,
      user,
      userMessageIndex: turn.userMessageIndex,
      assistantMessageId: turn.assistantMessageId,
      mode,
      settled: false
    });
  }, []);

  const settleOptimisticRewrite = useCallback((turnId: string, succeeded: boolean): void => {
    setOptimisticRewrite((current) => {
      if (!current || current.turnId !== turnId) return current;
      return succeeded ? { ...current, settled: true } : undefined;
    });
  }, []);

  const submitEditing = useCallback(async (): Promise<void> => {
    const current = editingRef.current;
    if (!current || !sessionId) return;
    startOptimisticRewrite({
      id: current.turnId,
      user: current.value,
      assistant: "",
      reasoning: "",
      skills: [],
      status: "running",
      tools: [],
      steps: [],
      userMessageIndex: current.userMessageIndex
    }, "edit", current.value);
    try {
      await onEditUserMessage(current.value, current.userMessageIndex, globalThis.crypto.randomUUID());
      settleOptimisticRewrite(current.turnId, true);
      setEditing(undefined);
    } catch (error) {
      settleOptimisticRewrite(current.turnId, false);
      throw error;
    }
  }, [onEditUserMessage, sessionId, settleOptimisticRewrite, startOptimisticRewrite]);

  useEffect(() => {
    const pending = optimisticRewrite;
    if (!pending?.settled) return;
    const target = turns.find((turn) => turn.id === pending.turnId);
    const hasRetryReplacement = pending.mode === "retry"
      && target !== undefined
      && (target.retryOfMessageId !== undefined
        || target.assistantMessageId !== pending.assistantMessageId);
    const hasEditReplacement = pending.mode === "edit"
      && pending.userMessageIndex !== undefined
      && turns.some((turn) => turn.id !== pending.turnId
        && turn.userMessageIndex === pending.userMessageIndex
        && turn.user === pending.user);
    if (hasRetryReplacement || hasEditReplacement) {
      setOptimisticRewrite((current) => current?.turnId === pending.turnId ? undefined : current);
    }
  }, [optimisticRewrite, turns]);

  // 错误卡按「一个错误只打扰一次」展示：每个会话各记一份当前未读错误清单，切走（或组件
  // 卸载）的一瞬整份标成已看过——用户点进失败的会话第一眼能看到，错过或划走就不再提。
  const unreadRunErrorsRef = useRef(new Map<string, readonly string[]>());
  useEffect(() => {
    const keys = turns
      .filter((turn) => Boolean(turn.error) && isRunErrorStatus(turn.status))
      .map((turn) => runErrorSeenKey(projectId, sessionId, turn));
    // 无依赖 effect 是拿「最新一帧」未读清单的手段：切换发生在提交之后、清理之前，
    // 清理闭包读到的必须是上一帧数据，所以 ref 要跟每次提交同步。列表很小，成本可忽略。
    unreadRunErrorsRef.current.set(sessionId ?? "", keys);
  });

  // 消费「被离开的会话」的全部未读错误：清理闭包里的 sessionKey 固定为创建该 effect
  // 时的会话，切走时正是上一个会话；应用关闭等卸场也顺路消费，重启后不再复活。
  useEffect(() => {
    const sessionKey = sessionId ?? "";
    return () => {
      const leaving = unreadRunErrorsRef.current.get(sessionKey);
      unreadRunErrorsRef.current.delete(sessionKey);
      if (leaving?.length) markRunErrorsSeen(leaving);
    };
    // 只跟随会话身份；依赖清单一变化就会让「上次未读」变成空集，语义就错了。
  }, [sessionId]);

  // 新一轮开跑（本会话出现新的进行中轮次）时回收一次失效标记：编辑/重试会让轮次身份
  // 变化或消失，死标记不该一直占着 localStorage，也不该顶着别的轮次的坑位。
  const roundFingerprintsRef = useRef<{ sessionKey: string; fingerprints: Set<string> }>({ sessionKey: "", fingerprints: new Set() });
  useEffect(() => {
    const sessionKey = sessionId ?? "";
    const fingerprints = new Set(turns.map((turn) => turn.timestamp ?? turn.id));
    const previous = roundFingerprintsRef.current;
    // 首帧（fingerprints 为空）与刚切进来的会话不触发：只有同一会话里长出新轮次才算「新一轮」。
    const becameActive = turns.some((turn) =>
      (turn.status === "running" || turn.status === "waiting_permission")
      && !previous.fingerprints.has(turn.timestamp ?? turn.id));
    if (previous.sessionKey === sessionKey && previous.fingerprints.size > 0 && becameActive) {
      pruneRunErrorsSeen(projectId, sessionId, fingerprints);
    }
    roundFingerprintsRef.current = { sessionKey, fingerprints };
  }, [projectId, sessionId, turns]);

  const displayedTurns = useMemo(() => {
    const pending = optimisticRewrite;
    if (!pending) return turns;
    const targetIndex = turns.findIndex((turn) => turn.id === pending.turnId);
    const replacementIndex = targetIndex >= 0
      ? targetIndex
      : pending.userMessageIndex === undefined
        ? -1
        : turns.findIndex((turn) => turn.userMessageIndex === pending.userMessageIndex && turn.user === pending.user);
    if (replacementIndex >= 0) {
      const target = turns[replacementIndex];
      if (!target) return turns;
      return [...turns.slice(0, replacementIndex), optimisticRewriteTurn(target, pending.user)];
    }
    return [...turns, optimisticRewriteTurn({
      id: pending.turnId,
      user: pending.user,
      userMessageIndex: pending.userMessageIndex,
      userMessageId: undefined,
      assistant: "",
      assistantMessageId: undefined,
      versionSlotId: undefined,
      versionIndex: undefined,
      versionCount: undefined,
      retryOfMessageId: undefined,
      reasoning: "",
      reasoningStatus: undefined,
      reasoningDurationMs: undefined,
      reasoningStartedAt: undefined,
      skills: [],
      status: "running",
      model: undefined,
      tools: [],
      steps: [],
      error: undefined,
      durationMs: undefined,
      usage: undefined,
      timestamp: undefined,
      resumable: undefined,
      firstTokenAt: undefined,
      startedAt: undefined,
      ttftMs: undefined,
      decodeMs: undefined,
      decodeTokens: undefined,
      finishReason: undefined
    }, pending.user)];
  }, [optimisticRewrite, turns]);

  return (
    <div className="message-timeline">
      {displayedTurns.map((turn) => (
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
          onRetryStart={startOptimisticRewrite}
          onRetrySettled={settleOptimisticRewrite}
          onSwitchVersion={onSwitchVersion}
          projectId={projectId}
          sessionId={sessionId}
          turn={turn}
        />
      ))}
      {optimisticRewrite && !thinking ? (
        <div className="biny-thinking-status" role="status">
          <ThinkingOrb aria-label={rewriteThinkingMessage} className="biny-thinking-status-orb" size={20} state="connecting" theme="auto" />
          <span className="biny-thinking-status-label chat-shimmer-text">{rewriteThinkingMessage}…</span>
        </div>
      ) : null}
    </div>
  );
});

function optimisticRewriteTurn(turn: TimelineTurn, user: string): TimelineTurn {
  return {
    ...turn,
    user,
    assistant: "",
    memoryCitations: undefined,
    reasoning: "",
    reasoningStatus: undefined,
    reasoningDurationMs: undefined,
    reasoningStartedAt: undefined,
    skills: [],
    status: "running",
    model: undefined,
    tools: [],
    steps: [],
    error: undefined,
    durationMs: undefined,
    usage: undefined,
    firstTokenAt: undefined,
    startedAt: undefined,
    ttftMs: undefined,
    decodeMs: undefined,
    decodeTokens: undefined,
    finishReason: undefined
  };
}

/**
 * 「已看过」的轮次错误登记处，身份由 runErrorSeenKey 给出（project + session + 轮次终态时间戳）。
 *
 * 展示语义按「一个错误只打扰一次」设计：手动点 ×、或者切走/离开这个会话，都算已读过，
 * 之后无论切回来还是重启应用都不再复活。所以内存集合负责跨会话即时生效，localStorage
 * 负责重启应用也生效。终态持久化在 session 文件里，「读过一次就不再提」正是要压住它。
 *
 * 身份必须与投影方式无关（见 chatModel.runErrorSeenKey），否则实时轮次（runId）重建为
 * 历史轮次（history-N）后标记对不上号。本地存储只是缓存：读失败退回内存集合，写失败只影响
 * 本次运行期；数量有上限，超出淘汰最旧的，不会无限膨胀。
 */
const dismissedRunErrorTurns = new Set<string>();
const DISMISSED_RUN_ERROR_STORAGE_KEY = "biny.desktop.dismissed-run-errors";
/** 持久化上限：超出就淘汰最旧的，避免本地缓存无限增长。 */
const DISMISSED_RUN_ERROR_LIMIT = 500;
/** 是否已从 localStorage 注水；注水只做一次，之后以内存集合为准。 */
let dismissedRunErrorHydrated = false;

function hydrateDismissedRunErrors(): void {
  if (dismissedRunErrorHydrated) return;
  dismissedRunErrorHydrated = true;
  try {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(DISMISSED_RUN_ERROR_STORAGE_KEY);
    if (!raw) return;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return;
    for (const key of stored) {
      if (typeof key === "string" && key) dismissedRunErrorTurns.add(key);
    }
  } catch {
    // 本地存储读失败：退回内存集合，本次运行期内仍然有效。
  }
}

function persistDismissedRunErrors(): void {
  try {
    if (typeof window === "undefined") return;
    // Set 是插入序：markRunErrorsSeen 先用 delete+add 把命中项挪到末尾，这里直接截尾淘汰最旧的。
    window.localStorage.setItem(
      DISMISSED_RUN_ERROR_STORAGE_KEY,
      JSON.stringify([...dismissedRunErrorTurns].slice(-DISMISSED_RUN_ERROR_LIMIT))
    );
  } catch {
    // 本地存储写失败：内存集合已记，本次运行期内仍不会再展示。
  }
}

function isRunErrorSeen(key: string): boolean {
  hydrateDismissedRunErrors();
  return dismissedRunErrorTurns.has(key);
}

/** 批量登记「已看过」；每项先删再插挪到最新端（近似 LRU 触碰序），合并成一次持久化。 */
function markRunErrorsSeen(keys: readonly string[]): void {
  hydrateDismissedRunErrors();
  for (const key of keys) {
    dismissedRunErrorTurns.delete(key);
    dismissedRunErrorTurns.add(key);
  }
  persistDismissedRunErrors();
}

/**
 * 新一轮开始时回收本会话失效的「已看过」标记：编辑/重试会让位置序号漂移或让轮次消失，
 * 只保留还挂在现存轮次上的标记，其余清掉并立即持久化——新失败的轮次有新身份，不受影响。
 */
function pruneRunErrorsSeen(projectId: string, sessionId: string | undefined, validIdentifiers: ReadonlySet<string>): void {
  hydrateDismissedRunErrors();
  const prefix = `${projectId}:${sessionId ?? "draft"}:`;
  let mutated = false;
  for (const key of dismissedRunErrorTurns) {
    if (!key.startsWith(prefix)) continue;
    if (validIdentifiers.has(key.slice(prefix.length))) continue;
    dismissedRunErrorTurns.delete(key);
    mutated = true;
  }
  if (mutated) persistDismissedRunErrors();
}

const Turn = memo(function Turn({
  projectId,
  sessionId,
  turn,
  editing,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  onResume,
  onRetry,
  onRetryStart,
  onRetrySettled,
  onSwitchVersion,
  onCancelEdit,
  onChangeEdit,
  onStartEdit,
  onSubmitEdit,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  projectId: string;
  sessionId?: string;
  turn: TimelineTurn;
  editing?: { value: string };
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onRetryStart(turn: TimelineTurn, mode: "retry" | "edit", user?: string): void;
  onRetrySettled(turnId: string, succeeded: boolean): void;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onCancelEdit(): void;
  onChangeEdit(value: string): void;
  onStartEdit(turn: TimelineTurn): void;
  onSubmitEdit(): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const running = turn.status === "running" || turn.status === "waiting_permission";
  // 「已看过」身份用跨投影稳定的 key（终态时间戳），实时/历史两种重建下都指同一轮。
  const dismissedKey = useMemo(() => runErrorSeenKey(projectId, sessionId, turn), [projectId, sessionId, turn]);
  const [errorDismissed, setErrorDismissed] = useState(() => isRunErrorSeen(dismissedKey));
  const retryPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const dismissError = useCallback((): void => {
    markRunErrorsSeen([dismissedKey]);
    setErrorDismissed(true);
  }, [dismissedKey]);
  const retry = useCallback((): Promise<void> => {
    const targetMessageId = turn.assistantMessageId ?? turn.userMessageId;
    if (!turn.user || !targetMessageId) return Promise.resolve();
    const existing = retryPromiseRef.current;
    if (existing) return existing;
    onRetryStart(turn, "retry");
    const pending = Promise.resolve().then(() => onRetry(targetMessageId, turn.user, globalThis.crypto.randomUUID()));
    retryPromiseRef.current = pending;
    void pending.then(
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, true);
      },
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, false);
      }
    );
    return pending;
  }, [onRetry, onRetrySettled, onRetryStart, turn]);
  const switchVersion = useCallback((direction: "prev" | "next"): Promise<void> => {
    if (!turn.assistantMessageId) return Promise.resolve();
    return onSwitchVersion(turn.assistantMessageId, direction);
  }, [onSwitchVersion, turn.assistantMessageId]);
  const canRetry = Boolean(turn.user && (turn.assistantMessageId ?? turn.userMessageId));
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
          onRegenerate={canRetry ? retry : undefined}
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

        {turn.memoryCitations?.length ? (
          <div className="memory-citation-badge" title={turn.memoryCitations.map(({ id, note }) => note ? `${id} — ${note}` : id).join("\n")}>
            <Icon name="brain" size={12} />
            <span>引用 {String(turn.memoryCitations.length)} 条记忆</span>
          </div>
        ) : null}

        {turn.assistant ? (
          <AssistantActions
            content={turn.assistant}
            finishReason={turn.finishReason}
            metrics={turnMetrics(turn)}
            onCreateBranch={onCreateBranch}
            onRegenerate={canRetry ? retry : undefined}
            onSwitchVersion={turn.versionCount && turn.versionCount > 1 ? switchVersion : undefined}
            runMs={turn.durationMs}
            timestamp={turn.timestamp}
            usage={turn.usage}
            versionCount={turn.versionCount}
            versionIndex={turn.versionIndex}
          />
        ) : null}

        {/* 底部不再展示统计与模型行；运行信息只保留在 hover 揭示的时钟里。 */}
        {/* 失败/阻塞/未完成/取消/中止统一收敛成一张错误卡片：图标 + 标题 + 人话错误 + 继续/重试。 */}
        {turn.error && isRunErrorStatus(turn.status) && !errorDismissed ? (
          <RunErrorCard
            message={turn.error}
            onDismiss={dismissError}
            onResume={() => void onResume()}
            onRetry={canRetry ? retry : undefined}
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
        // 连续的工具 + 思考步骤聚合成一个可展开块；单个步骤不套聚合壳。
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
  onRegenerate?(): Promise<void>;
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
    // 编辑态不套 ChatMessageBubble：气泡自带主题底色/内边距，会把编辑器包成「盒中盒」。
    return (
      <ChatMessage className="user-message is-editing" sender="user">
        <InlineUserMessageEditor
          value={editing.value}
          onCancel={onCancelEdit}
          onChange={onChangeEdit}
          onSubmit={onSubmitEdit}
        />
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
        {onRegenerate ? <button aria-label="重新生成" className="user-message-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button> : null}
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
  const submitFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const initialValueRef = useRef(value);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(initialValueRef.current.length, initialValueRef.current.length);
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || submitFlightRef.current || !value.trim()) return;
    submitFlightRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
      submitFlightRef.current = false;
    }
  };

  return (
    <div className={`user-message-editor${busy ? " is-busy" : ""}`}>
      <textarea
        aria-label="编辑用户消息"
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={() => { composingRef.current = false; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composingRef.current) return;
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void submit();
        }}
        ref={textareaRef}
        rows={1}
        value={value}
      />
      {error ? <div className="user-message-editor-error"><Icon name="warning" size={12} /><span>{error}</span></div> : null}
      <div className="user-message-editor-actions">
        <span className="user-message-editor-hint">
          {busy ? "发送中…" : <><kbd>Esc</kbd> 取消 · <kbd>⏎</kbd> 发送</>}
        </span>
        <button className="user-message-editor-cancel" disabled={busy} onClick={onCancel} type="button">取消</button>
        <button
          aria-label="发送编辑后的消息"
          className="biny-send-button"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
          title="发送（Enter）"
          type="button"
        >
          <Icon name="arrow-up" size={15} />
        </button>
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

/** 助手回复下方的操作条：
 *  复制/朗读/重新生成/更多 四个图标按钮 hover 揭示；日期感知时钟 + 运行指标
 *  （LLM 用时 / 首 token / 解码吞吐）常显。更多菜单与用量悬浮卡都走 portal
 *  fixed 定位：用量项悬停出详情卡（80ms 悬停意图防抖），结束原因带语义色点，
 *  复制成功后图标变勾并延迟收菜单。 */
function AssistantActions({ content, timestamp, metrics, runMs, usage, finishReason, onCreateBranch, onRegenerate, onSwitchVersion, versionIndex, versionCount }: {
  content: string;
  timestamp?: string;
  metrics?: TurnMetrics;
  runMs?: number;
  usage?: SessionUsage;
  finishReason?: string;
  onCreateBranch(): void;
  onRegenerate?(): Promise<void>;
  onSwitchVersion?(direction: "prev" | "next"): Promise<void>;
  versionIndex?: number;
  versionCount?: number;
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false);
  const stopSpeechRef = useRef<() => void>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ direction: "up" | "down"; style: CSSProperties }>();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const usageItemRef = useRef<HTMLButtonElement>(null);
  const [usagePopover, setUsagePopover] = useState<{ top: number; left: number }>();
  const usageHideTimerRef = useRef<number | undefined>(undefined);
  const [copiedKind, setCopiedKind] = useState<"markdown" | "plain">();

  const usageRows = buildUsageDetailRows(usage, metrics ?? {});
  const tone = finishReason ? finishReasonTone(finishReason) : undefined;

  // 组件卸载（切会话、消息被折叠）时朗读与悬浮卡定时器都要跟着停。
  useEffect(() => () => {
    stopSpeechRef.current?.();
    if (usageHideTimerRef.current !== undefined) window.clearTimeout(usageHideTimerRef.current);
  }, []);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeechRef.current?.();
      return;
    }
    setSpeaking(true);
    stopSpeechRef.current = speak(plainTextFromMarkdown(content), () => setSpeaking(false));
  };

  const closeMenu = useCallback((): void => setMenuOpen(false), []);

  // 打开菜单时按更多按钮的视口位置算 fixed 坐标：下方放不下就向上弹。
  const toggleMenu = (): void => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const anchor = moreButtonRef.current?.getBoundingClientRect();
    if (!anchor) {
      setMenuOpen(true);
      return;
    }
    const gap = 6;
    const menuWidth = 208;
    const itemCount = 3 + (usageRows.length ? 1 : 0) + (finishReason ? 1 : 0) + ((usageRows.length || finishReason) ? 1 : 0);
    const estimatedHeight = itemCount * 32 + 12;
    const spaceBelow = window.innerHeight - anchor.bottom - gap;
    const direction = spaceBelow >= estimatedHeight || spaceBelow >= anchor.top - gap ? "down" : "up";
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menuWidth - 8));
    setMenuPosition(direction === "down"
      ? { direction, style: { left, top: anchor.bottom + gap } }
      : { direction, style: { left, bottom: window.innerHeight - anchor.top + gap } });
    setMenuOpen(true);
  };

  // 点击菜单/按钮外部、Esc、滚动或缩放窗口时收起（portal 不在 DOM 树内，外部判断要显式做）。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (moreButtonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const dismiss = (): void => setMenuOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [menuOpen]);

  const cancelUsageHide = useCallback((): void => {
    if (usageHideTimerRef.current === undefined) return;
    window.clearTimeout(usageHideTimerRef.current);
    usageHideTimerRef.current = undefined;
  }, []);

  const scheduleUsageHide = useCallback((): void => {
    cancelUsageHide();
    usageHideTimerRef.current = window.setTimeout(() => {
      usageHideTimerRef.current = undefined;
      setUsagePopover(undefined);
    }, 80);
  }, [cancelUsageHide]);

  // 用量悬浮卡贴用量菜单项右侧（放不下换左侧），垂直方向与条目居中对齐。
  const showUsagePopover = useCallback((): void => {
    if (!usageRows.length) return;
    cancelUsageHide();
    const anchor = usageItemRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const gap = 10;
    const width = 240;
    let left = anchor.right + gap + width <= window.innerWidth ? anchor.right + gap : anchor.left - gap - width;
    left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - width - gap));
    const top = Math.min(Math.max(anchor.top + anchor.height / 2, gap), window.innerHeight - gap);
    setUsagePopover({ top, left });
  }, [usageRows.length, cancelUsageHide]);

  // 菜单收起时悬浮卡与复制成功态一并复位。
  useEffect(() => {
    if (menuOpen) return;
    cancelUsageHide();
    setUsagePopover(undefined);
    setCopiedKind(undefined);
  }, [menuOpen, cancelUsageHide]);

  const copyAs = (kind: "markdown" | "plain"): void => {
    copyText(kind === "markdown" ? content : plainTextFromMarkdown(content));
    setCopiedKind(kind);
    window.setTimeout(() => {
      setCopiedKind(undefined);
      setMenuOpen(false);
    }, 800);
  };

  const durationText = useMemo(() => {
    const parts: string[] = [];
    if (timestamp) {
      parts.push(formatMessageClock(Date.parse(timestamp)));
    }
    if (runMs !== undefined) {
      parts.push(`Worked for ${formatRunDuration(runMs)}`);
    } else if (metrics?.llmMs !== undefined) {
      parts.push(`LLM ${formatDuration(metrics.llmMs)}`);
    }
    return parts.join(" · ");
  }, [runMs, metrics, timestamp]);
  const hasInfoSection = usageRows.length > 0 || Boolean(finishReason);
  return (
    <div className={`assistant-actions${menuOpen ? " is-open" : ""}`}>
      <div className="assistant-actions-duration">
        <Icon name="activity" size={14} />
        <span>{durationText}</span>
      </div>
      <div className="assistant-actions-buttons">
        <CopyButton className="assistant-action" label="复制回复" size={16} value={content} />
        {speechSupported() ? (
          <button aria-label={speaking ? "停止朗读" : "朗读回复"} className={`assistant-action${speaking ? " is-active" : ""}`} onClick={toggleSpeech} title={speaking ? "停止朗读" : "朗读回复"} type="button"><Icon name={speaking ? "volume-off" : "volume"} size={16} /></button>
        ) : null}
        {onRegenerate ? (
          <button aria-label="重新生成" className="assistant-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button>
        ) : null}
        {onSwitchVersion && versionCount !== undefined && versionCount > 1 && versionIndex !== undefined ? (
          <VersionSwitcher
            onSwitchVersion={onSwitchVersion}
            versionCount={versionCount}
            versionIndex={versionIndex}
          />
        ) : null}
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多回复操作" className="assistant-action" onClick={toggleMenu} ref={moreButtonRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div
          className="assistant-menu"
          data-direction={menuPosition.direction}
          onClick={(event) => event.stopPropagation()}
          ref={menuRef}
          role="menu"
          style={menuPosition.style}
        >
          {hasInfoSection ? (
            <>
              {usageRows.length ? (
                <button
                  className="message-menu-item"
                  onBlur={scheduleUsageHide}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  onFocus={showUsagePopover}
                  onMouseEnter={showUsagePopover}
                  onMouseLeave={scheduleUsageHide}
                  ref={usageItemRef}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="info" size={14} /><span>用量</span>
                </button>
              ) : null}
              {finishReason && tone ? (
                <div className="message-menu-item is-static" role="menuitem">
                  <span aria-hidden="true" className={`finish-reason-dot is-${tone}`} />
                  <span className="finish-reason-label">Turn 结束原因</span>
                  <span className="finish-reason-value">{finishReason}</span>
                </div>
              ) : null}
              <div className="message-menu-separator" />
            </>
          ) : null}
          <button className={`message-menu-item${copiedKind === "markdown" ? " is-success" : ""}`} onClick={() => copyAs("markdown")} role="menuitem" type="button">
            <Icon name={copiedKind === "markdown" ? "check" : "copy"} size={14} /><span>复制为 Markdown</span>
          </button>
          <button className={`message-menu-item${copiedKind === "plain" ? " is-success" : ""}`} onClick={() => copyAs("plain")} role="menuitem" type="button">
            <Icon name={copiedKind === "plain" ? "check" : "copy"} size={14} /><span>复制为纯文本</span>
          </button>
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
        </div>,
        document.body
      ) : null}
      {usagePopover && usageRows.length ? createPortal(
        <div
          className="usage-detail-popover"
          onMouseEnter={cancelUsageHide}
          onMouseLeave={scheduleUsageHide}
          role="status"
          style={{ top: usagePopover.top, left: usagePopover.left }}
        >
          <div className="usage-detail-title">用量</div>
          <div className="usage-detail-rows">
            {usageRows.map((row) => (
              <div className="usage-detail-row" key={row.key}>
                <span className="usage-detail-label">{row.label}</span>
                <span className="usage-detail-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

/** 消息版本控件：箭头、当前版本/总版本，跟随回复操作条显示。 */
function VersionSwitcher({ onSwitchVersion, versionIndex, versionCount }: {
  onSwitchVersion(direction: "prev" | "next"): Promise<void>;
  versionIndex: number;
  versionCount: number;
}): React.JSX.Element {
  const [pending, setPending] = useState<"prev" | "next">();
  const switchVersion = async (direction: "prev" | "next"): Promise<void> => {
    if (pending) return;
    setPending(direction);
    try {
      await onSwitchVersion(direction);
    } finally {
      setPending(undefined);
    }
  };
  return (
    <div aria-label="回复版本" className="message-version-switcher">
      <button
        aria-label="上一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("prev"); }}
        title="上一版本"
        type="button"
      >‹</button>
      <span className="message-version-count">{versionIndex + 1} / {versionCount}</span>
      <button
        aria-label="下一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("next"); }}
        title="下一版本"
        type="button"
      >›</button>
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
