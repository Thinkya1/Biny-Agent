/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection, DesktopSessionLimits, DesktopSessionWriterConflict } from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { pickThinkingMessage } from "../thinkingMessages.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { WelcomeState } from "./WelcomeState.js";

/** 首页提交过场信号：App 在「无会话的首页」发出首条消息时下发，text 用于渲染气泡预览。 */
export interface HomeFlightSignal {
  text: string;
  nonce: number;
}

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  runtimeProjection?: DesktopRuntimeProjection;
  onOpenProject(): void;
  onPreviewFile(path: string): void;
  inspectorOpen: boolean;
  onToggleInspector(): void;
  runtimePanelOpen: boolean;
  onRuntimePanelOpenChange(open: boolean): void;
  thinking: boolean;
  running: boolean;
  thinkingStartedAt?: string;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(input: string, userMessageIndex: number, idempotencyKey: string): Promise<void>;
  onRetryWriterConflict(): Promise<void>;
  writerConflict?: DesktopSessionWriterConflict;
  /** 会话体量接近持久化上限时的预警信息；未接近时缺省。 */
  sessionLimits?: DesktopSessionLimits;
  onEditUserMessage(input: string, userMessageIndex: number, idempotencyKey: string): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
  /** 建议 pill 点击即提交（Alma 行为），由 App 转发给 Composer 的统一提交路径。 */
  onSubmitPrompt(prompt: string): void;
  /** 首页提交过场信号；发送失败时 App 会清空它触发回滚。 */
  homeFlight?: HomeFlightSignal;
  /** 过场动画落地完成（500ms）后回调，App 借此清掉信号。 */
  onHomeFlightLanded(): void;
  /** 顶部工具条：自动化/技能入口（搜索与新建任务在侧栏 chrome，对齐 Alma）。 */
  onOpenRuntime(): void;
  onOpenExtensions(): void;
  children?: React.ReactNode;
}

export function Workspace({
  project,
  projectId,
  sessionId,
  sessionTitle,
  turns,
  loading,
  runtimeError,
  runtimeProjection,
  onOpenProject,
  onPreviewFile,
  inspectorOpen,
  onToggleInspector,
  runtimePanelOpen,
  onRuntimePanelOpenChange,
  thinking,
  running,
  thinkingStartedAt,
  onOpenExternal,
  onResolvePermission,
  onResume,
  onRetry,
  onRetryWriterConflict,
  writerConflict,
  sessionLimits,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  onSubmitPrompt,
  homeFlight,
  onHomeFlightLanded,
  onOpenRuntime,
  onOpenExtensions,
  children
}: WorkspaceProps): React.JSX.Element {
  const streaming = running || turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  const isHome = !loading && !runtimeError && !projectId;
  const showWelcome = !loading && !runtimeError && !sessionId && !streaming && turns.length === 0;
  // 上限预警按会话 dismiss：换会话要重新提示，同会话点掉后不再打扰。
  const [limitBannerDismissedFor, setLimitBannerDismissedFor] = useState<string>();
  const showLimitBanner = Boolean(sessionLimits?.nearSizeLimit && sessionId && limitBannerDismissedFor !== sessionId);

  // —— 首页 → 聊天 过场（Alma 式 FLIP，0.5s cubic-bezier(.32,.72,0,1)）——
  // flying：保持首页布局、播动画；landed：落地完成、切聊天布局（此时 sessionId/消息通常已就位，
  // 正好无缝接管）。发送失败时 App 清空 homeFlight，走回滚分支。
  const [flight, setFlight] = useState<{ text: string } | null>(null);
  const [landed, setLanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerSlotRef = useRef<HTMLDivElement>(null);
  const flightCleanupRef = useRef<(() => void) | null>(null);
  const onHomeFlightLandedRef = useRef(onHomeFlightLanded);
  useEffect(() => {
    onHomeFlightLandedRef.current = onHomeFlightLanded;
  });

  // 新会话/新项目后允许再次过场。
  useEffect(() => {
    if (!sessionId) setLanded(false);
  }, [sessionId]);

  useEffect(() => {
    if (!homeFlight || flight) return;
    if (!composerSlotRef.current || !bodyRef.current) return;
    setFlight({ text: homeFlight.text });
  }, [homeFlight, flight]);

  // 回滚：发送失败（App 清空信号）且过场仍在飞 → 取消动画、撤掉气泡、还原首页。
  useEffect(() => {
    if (homeFlight || !flight) return;
    flightCleanupRef.current?.();
    flightCleanupRef.current = null;
    setFlight(null);
  }, [homeFlight, flight]);

  useEffect(() => {
    if (!flight) return;
    const slot = composerSlotRef.current;
    const body = bodyRef.current;
    if (!slot || !body) {
      setFlight(null);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setFlight(null);
      setLanded(true);
      onHomeFlightLandedRef.current();
      return;
    }
    let cancel: (() => void) | undefined;
    const raf = requestAnimationFrame(() => {
      const rect = slot.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      // dock 几何：composer 宽 = 内容宽（100% - 48px）水平居中，顶边 = body 底边。
      const deltaY = bodyRect.bottom - rect.top;
      const targetWidth = bodyRect.width - 48;
      const ease = "cubic-bezier(.32,.72,0,1)";
      slot.style.width = `${String(rect.width)}px`;
      const composerAnim = slot.animate(
        [
          { transform: "translateY(0px)", width: `${String(rect.width)}px` },
          { transform: `translateY(${String(deltaY)}px)`, width: `${String(targetWidth)}px` }
        ],
        { duration: 500, easing: ease, fill: "forwards" }
      );
      // 用户气泡预览：fixed 在最终落点（消息区顶 28px、右缩 24px 内容沟），
      // 从 composer 顶边上滑入——视觉上像消息「从输入框升起来、输入框顺势沉到底部」。
      const bubbleTop = bodyRect.top + 28;
      const bubble = document.createElement("div");
      bubble.className = "biny-flight-bubble";
      bubble.textContent = flight.text;
      bubble.style.top = `${String(bubbleTop)}px`;
      bubble.style.right = `${String(window.innerWidth - bodyRect.right + 24)}px`;
      bubble.style.maxWidth = `${String((bodyRect.width - 48) * 0.85)}px`;
      document.body.appendChild(bubble);
      const bubbleAnim = bubble.animate(
        [
          { transform: `translateY(${String(rect.top - bubbleTop)}px)`, opacity: 0 },
          { transform: "translateY(0px)", opacity: 1 }
        ],
        { duration: 500, easing: ease, fill: "forwards" }
      );
      const timer = window.setTimeout(() => {
        flightCleanupRef.current = null;
        composerAnim.cancel();
        bubbleAnim.cancel();
        bubble.remove();
        slot.style.width = "";
        setFlight(null);
        setLanded(true);
        onHomeFlightLandedRef.current();
      }, 500);
      cancel = () => {
        window.clearTimeout(timer);
        composerAnim.cancel();
        bubbleAnim.cancel();
        bubble.remove();
        slot.style.width = "";
      };
      flightCleanupRef.current = cancel;
    });
    return () => {
      cancelAnimationFrame(raf);
      cancel?.();
      flightCleanupRef.current = null;
    };
  }, [flight]);

  const renderWelcome = (showWelcome && !landed) || flight !== null;

  if (isHome) {
    return (
      <div className="workspace biny-workspace biny-workspace-home">
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen && Boolean(projectId)}
          projection={runtimeProjection}
        />
        <div className="biny-chat-body is-welcome">
          <WelcomeState hasProject={false} onOpenProject={onOpenProject} onPickSuggestion={onSubmitPrompt}>
            <div className="biny-welcome-composer-slot biny-hero-fade">{children}</div>
          </WelcomeState>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace biny-workspace biny-workspace-chat">
      <div className="biny-workspace-main">
        <header className="biny-chat-toolbar">
          <div className="biny-chat-drag-region">
            <div className="biny-chat-title">
              <strong>{sessionTitle ?? project?.name ?? "Biny"}</strong>
              {project ? <span>{project.name}{project.branch ? ` · ${project.branch}` : ""}</span> : <span>打开一个本地项目开始</span>}
            </div>
          </div>
          <div className="biny-chat-actions">
            <button
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "收起工作区工具" : "打开工作区工具"}
              className={`biny-toolbar-button${inspectorOpen ? " is-active" : ""}`}
              disabled={!projectId}
              onClick={onToggleInspector}
              title={inspectorOpen ? "收起工作区工具" : "打开工作区工具"}
              type="button"
            >
              <Icon name="panel-right" size={15} />
            </button>
          </div>
        </header>
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen}
          projection={runtimeProjection}
        />
        <div className={`biny-chat-body${renderWelcome ? " is-welcome" : ""}`} ref={bodyRef}>
          {showLimitBanner && sessionLimits && sessionId ? (
            <div className="biny-session-limit-banner" role="status">
              <span>
                这个会话已写入 {(sessionLimits.sizeBytes / 1048576).toFixed(1)} MB / {Math.round(sessionLimits.maxSizeBytes / 1048576)} MB（{sessionLimits.eventCount.toLocaleString()} 个事件）。
                越大打开和回放越慢，建议分叉出新会话继续。
              </span>
              <button onClick={onCreateBranch} type="button">分叉新会话</button>
              <button aria-label="忽略" className="biny-session-limit-dismiss" onClick={() => setLimitBannerDismissedFor(sessionId)} type="button">×</button>
            </div>
          ) : null}
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : renderWelcome ? (
            <WelcomeState hasProject={Boolean(projectId)} leaving={flight !== null} onOpenProject={onOpenProject} onPickSuggestion={onSubmitPrompt}>
              <div className="biny-welcome-composer-slot biny-hero-fade" ref={composerSlotRef}>
                {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
              </div>
            </WelcomeState>
          ) : (turns.length > 0 || thinking) && projectId ? (
            <ChatScroll sessionId={sessionId} streaming={streaming}>
              <MessageTimeline
                onCreateBranch={onCreateBranch}
                onDeleteUserMessage={onDeleteUserMessage}
                onEditUserMessage={onEditUserMessage}
                onOpenExternal={onOpenExternal}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                onResume={onResume}
                onRollbackFiles={onRollbackFiles}
                onRetry={onRetry}
                projectId={projectId}
                sessionId={sessionId}
                turns={turns}
              />
              {/* 运行状态行：消息流末尾，与 DSH 的 TurnStatus 同位置。 */}
              {thinking ? <ThinkingStatus key={thinkingStartedAt ?? "thinking"} startedAt={thinkingStartedAt} /> : null}
            </ChatScroll>
          ) : (
            <div className="biny-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        {renderWelcome ? null : (
          <div className="biny-chat-composer">
            {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
          </div>
        )}
      </div>
      {streaming ? <span className="biny-streaming-state" aria-hidden="true" /> : null}
    </div>
  );
}

function ThinkingStatus({ startedAt }: { startedAt?: string }): React.JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => elapsedSecondsSince(startedAt));
  const [thinkingMessage] = useState(() => pickThinkingMessage());

  useEffect(() => {
    const update = (): void => setElapsedSeconds(elapsedSecondsSince(startedAt));
    update();
    if (!startedAt) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="biny-thinking-status" role="status">
      <ThinkingOrb aria-label={thinkingMessage} className="biny-thinking-status-orb" size={20} state="connecting" theme="auto" />
      <span className="biny-thinking-status-label chat-shimmer-text">{thinkingMessage}…</span>
      <span className="biny-thinking-status-duration">{elapsedSeconds}s</span>
    </div>
  );
}

function elapsedSecondsSince(startedAt?: string): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
}

/** 距底小于该值视为「钉在底部」：新内容进来继续贴底，回底按钮也在这时收起。 */
const PIN_DISTANCE = 48;
/** 距底超过该值才显示回底按钮；与 PIN_DISTANCE 之间是滞回区，防阈值附近抖动。 */
const JUMP_BUTTON_DISTANCE = 160;

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function ChatScroll({ children, sessionId, streaming }: { children: React.ReactNode; sessionId?: string; streaming: boolean }): React.JSX.Element {
  const [scrollActive, setScrollActive] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 「钉在底部」用 ref 不用 state：流式期间滚动事件极频繁，贴底状态翻转不该触发重渲染。
  const pinnedRef = useRef(true);

  useEffect(() => () => {
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
  }, []);

  // 切会话从头贴底；内容随后异步长高，由下面的 ResizeObserver 持续贴住。
  useEffect(() => {
    pinnedRef.current = true;
    setJumpVisible(false);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        container.scrollTop = container.scrollHeight;
      } else {
        setJumpVisible(distanceFromBottom(container) > JUMP_BUTTON_DISTANCE);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const revealScrollbar = (): void => {
    setScrollActive(true);
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = undefined;
      setScrollActive(false);
    }, 1000);
  };

  const handleScroll = (): void => {
    revealScrollbar();
    const container = containerRef.current;
    if (!container) return;
    const distance = distanceFromBottom(container);
    pinnedRef.current = distance < PIN_DISTANCE;
    if (distance > JUMP_BUTTON_DISTANCE) setJumpVisible(true);
    else if (distance < PIN_DISTANCE) setJumpVisible(false);
  };

  // 直达用瞬时滚动而非平滑滚动：流式期间内容一直在长，平滑滚动追不上新底部。
  const jumpToBottom = (): void => {
    const container = containerRef.current;
    if (!container) return;
    pinnedRef.current = true;
    container.scrollTop = container.scrollHeight;
    setJumpVisible(false);
  };

  return (
    <>
      <div
        className={`biny-chat-scroll${scrollActive ? " is-scroll-active" : ""}`}
        onScroll={handleScroll}
        onWheel={revealScrollbar}
        ref={containerRef}
      >
        <div className="biny-chat-scroll-content" ref={contentRef}>{children}</div>
      </div>
      <button
        aria-hidden={!jumpVisible}
        aria-label={streaming ? "正在生成，回到底部" : "回到底部"}
        className={`biny-jump-bottom${jumpVisible ? " is-visible" : ""}`}
        onClick={jumpToBottom}
        tabIndex={jumpVisible ? 0 : -1}
        title={streaming ? "正在生成，回到底部" : "回到底部"}
        type="button"
      >
        {streaming
          ? <ThinkingOrb aria-hidden="true" className="biny-jump-bottom-orb" size={20} state="connecting" theme="auto" />
          : <Icon name="arrow-down" size={16} />}
      </button>
    </>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="biny-status-state" role="status"><ThinkingOrb aria-label="正在恢复会话" className="thinking-orb" size={20} state="connecting" theme="auto" /><span>正在恢复会话…</span></div>;
}

function RuntimeError({ error, onOpenProject }: { error: string; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="biny-runtime-error" role="alert">
      <Icon name="warning" size={22} />
      <h2>Agent Runtime 无法启动</h2>
      <p>{error}</p>
      <small>若另一个 Biny/CLI 会话正在占用项目，请先退出该会话；其他错误请检查共享配置后重试。</small>
      <button onClick={onOpenProject} type="button">打开其他项目</button>
    </div>
  );
}

function SessionWriterConflictBanner({ onRetry }: { onRetry(): Promise<void> }): React.JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const retry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div aria-live="polite" className="biny-session-writer-conflict" role="alert">
      <Icon name="lock" size={17} />
      <div className="biny-session-writer-conflict-copy">
        <strong>已在另一个应用中打开</strong>
        <span>请先在那边关闭会话，才能在这里继续。</span>
      </div>
      <button disabled={retrying} onClick={() => void retry()} type="button">{retrying ? "重试中…" : "重试"}</button>
    </div>
  );
}
