/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection, DesktopSessionWriterConflict } from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { pickThinkingMessage } from "../thinkingMessages.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { WelcomeState } from "./WelcomeState.js";

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
  onRetry(input: string): void;
  onRetryWriterConflict(): Promise<void>;
  writerConflict?: DesktopSessionWriterConflict;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
  onPrefillPrompt(prompt: string): void;
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
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  onPrefillPrompt,
  children
}: WorkspaceProps): React.JSX.Element {
  const streaming = running || turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  const isHome = !loading && !runtimeError && !projectId;
  const showWelcome = !loading && !runtimeError && !sessionId && !streaming && turns.length === 0;

  if (isHome) {
    return (
      <div className="workspace cindy-workspace cindy-workspace-home">
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen && Boolean(projectId)}
          projection={runtimeProjection}
        />
        <div className="cindy-home-content">
          <WelcomeState hasProject={false} onOpenProject={onOpenProject} onPrefill={onPrefillPrompt} />
          <div className="cindy-home-composer">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace cindy-workspace cindy-workspace-chat">
      <div className="cindy-workspace-main">
        <header className="cindy-chat-toolbar">
          <div className="cindy-chat-drag-region">
            <div className="cindy-chat-title">
              <strong>{sessionTitle ?? project?.name ?? "Biny"}</strong>
              {project ? <span>{project.name}{project.branch ? ` · ${project.branch}` : ""}</span> : <span>打开一个本地项目开始</span>}
            </div>
          </div>
          <div className="cindy-chat-actions">
            <button
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "收起工作区工具" : "打开工作区工具"}
              className={`cindy-toolbar-button${inspectorOpen ? " is-active" : ""}`}
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
        <div className="cindy-chat-body">
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : showWelcome ? (
            <div className="cindy-chat-welcome"><WelcomeState hasProject={Boolean(projectId)} onOpenProject={onOpenProject} onPrefill={onPrefillPrompt} /></div>
          ) : (turns.length > 0 || thinking) && projectId ? (
            <ChatScroll>
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
            <div className="cindy-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        <div className="cindy-chat-composer">
          {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
        </div>
      </div>
      {streaming ? <span className="cindy-streaming-state" aria-hidden="true" /> : null}
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
    <div className="cindy-thinking-status" role="status">
      <ThinkingOrb aria-label={thinkingMessage} className="cindy-thinking-status-orb" size={20} state="connecting" theme="auto" />
      <span className="cindy-thinking-status-label dsh-thinking-shimmer">{thinkingMessage}…</span>
      <span className="cindy-thinking-status-duration">{elapsedSeconds}s</span>
    </div>
  );
}

function elapsedSecondsSince(startedAt?: string): number {
  if (!startedAt) return 0;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
}

function ChatScroll({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [scrollActive, setScrollActive] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
  }, []);

  const revealScrollbar = (): void => {
    setScrollActive(true);
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = undefined;
      setScrollActive(false);
    }, 1000);
  };

  return (
    <div className={`cindy-chat-scroll${scrollActive ? " is-scroll-active" : ""}`} onScroll={revealScrollbar} onWheel={revealScrollbar}>
      {children}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="cindy-status-state" role="status"><ThinkingOrb aria-label="正在恢复会话" className="thinking-orb" size={20} state="connecting" theme="auto" /><span>正在恢复会话…</span></div>;
}

function RuntimeError({ error, onOpenProject }: { error: string; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="cindy-runtime-error" role="alert">
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
    <div aria-live="polite" className="cindy-session-writer-conflict" role="alert">
      <Icon name="lock" size={17} />
      <div className="cindy-session-writer-conflict-copy">
        <strong>已在另一个应用中打开</strong>
        <span>请先在那边关闭会话，才能在这里继续。</span>
      </div>
      <button disabled={retrying} onClick={() => void retry()} type="button">{retrying ? "重试中…" : "重试"}</button>
    </div>
  );
}
