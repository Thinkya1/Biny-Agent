/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { UsageSummary } from "../../../../session/metadata.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection } from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { pickThinkingMessage } from "../thinkingMessages.js";
import { formatCacheHitRate, formatUsageCost } from "../usagePresentation.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { UsageSummaryPopover } from "./UsageSummaryPopover.js";

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  runtimeProjection?: DesktopRuntimeProjection;
  sessionUsage: UsageSummary;
  onOpenProject(): void;
  onPreviewFile(path: string): void;
  inspectorOpen: boolean;
  onToggleInspector(): void;
  runtimePanelOpen: boolean;
  onRuntimePanelOpenChange(open: boolean): void;
  thinking: boolean;
  thinkingStartedAt?: string;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
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
  sessionUsage,
  onOpenProject,
  onPreviewFile,
  inspectorOpen,
  onToggleInspector,
  runtimePanelOpen,
  onRuntimePanelOpenChange,
  thinking,
  thinkingStartedAt,
  onOpenExternal,
  onResolvePermission,
  onResume,
  onRetry,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  children
}: WorkspaceProps): React.JSX.Element {
  const [usageOpen, setUsageOpen] = useState(false);
  const usageControlRef = useRef<HTMLDivElement>(null);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
  const streaming = turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  const isHome = !loading && !runtimeError && !projectId;

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
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : (turns.length > 0 || thinking) && projectId ? (
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
          {children}
          <div aria-label="会话状态" aria-live="polite" className="cindy-composer-status">
            <div className="cindy-composer-status-actions">
              <div className="cindy-usage-control" ref={usageControlRef}>
                <button
                  aria-expanded={usageOpen}
                  aria-label="查看本会话费用与缓存命中率"
                  className={`cindy-composer-status-button${usageOpen ? " is-open" : ""}`}
                  onClick={() => setUsageOpen((current) => !current)}
                  title="本会话费用与缓存命中率"
                  type="button"
                >
                  <Icon name="chart" size={13} />
                  <span>
                    {sessionUsage.calls ? formatUsageCost(sessionUsage) : "费用"}
                    {sessionUsage.latestCacheHitRate === undefined ? "" : ` · CH ${formatCacheHitRate(sessionUsage.latestCacheHitRate)}`}
                    {sessionUsage.sessionCacheHitRate === undefined ? "" : ` · S-CH ${formatCacheHitRate(sessionUsage.sessionCacheHitRate)}`}
                  </span>
                </button>
                <UsageSummaryPopover anchorRef={usageControlRef} onClose={closeUsage} open={usageOpen} summary={sessionUsage} />
              </div>
              <button
                aria-expanded={runtimePanelOpen}
                aria-label="打开后台运行面板"
                className={`cindy-composer-status-button${runtimePanelOpen ? " is-open" : ""}`}
                disabled={!projectId}
                onClick={() => onRuntimePanelOpenChange(!runtimePanelOpen)}
                title="后台运行"
                type="button"
              >
                <Icon name="activity" size={13} />
              </button>
            </div>
          </div>
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
