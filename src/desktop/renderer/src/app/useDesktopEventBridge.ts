/**
 * Desktop Agent 事件桥。
 *
 * 主进程为所有项目共用一条事件通道。本 hook 负责按帧批处理、按项目/会话过滤、刷新终态快照，
 * 并把结果写回 React 状态；组件无需理解事件时序或处理流式输出的高频更新。
 */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ContextBudgetStatus } from "../../../../agent/context/types.js";
import { isTerminalRunEvent, type AgentHostEvent } from "../../../../runtime/agentEvents.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopSessionDocument,
  DesktopSessionWriterConflict,
  DesktopSessionSummary,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";
import { liveTimelineEvents } from "../sessionTimeline.js";
import { applyUpdatesToSidebarSessions, applyUpdatesToWorkspace, hasContextStatus } from "./desktopState.js";

/** 聊天内技能草稿审核卡片的最小数据；从 `skill.draft_created` host event 提取。 */
export interface SkillDraftNotice {
  id: string;
  name: string;
  description: string;
  toolCalls: number;
  sessionId: string;
}

interface DesktopEventBridgeOptions {
  activeProjectIdRef: { current: string | undefined };
  selectedSessionIdRef: { current: string | undefined };
  mergeProjectSnapshot(snapshot: DesktopWorkspaceSnapshot): void;
  onError(error: unknown): void;
  setContextBudget: Dispatch<SetStateAction<ContextBudgetStatus | undefined>>;
  setDocument: Dispatch<SetStateAction<DesktopSessionDocument | undefined>>;
  /** 收集当前选中会话的技能草稿通知；事件不进消息时间线，只驱动聊天内的审核卡片。 */
  setSkillDraftNotices: Dispatch<SetStateAction<SkillDraftNotice[]>>;
  setWriterConflict: Dispatch<SetStateAction<DesktopSessionWriterConflict | undefined>>;
  setSidebarSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>;
  setWorkspace: Dispatch<SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
}

export function useDesktopEventBridge({
  activeProjectIdRef,
  selectedSessionIdRef,
  mergeProjectSnapshot,
  onError,
  setContextBudget,
  setDocument,
  setSkillDraftNotices,
  setWriterConflict,
  setSidebarSessions,
  setWorkspace
}: DesktopEventBridgeOptions): void {
  useEffect(() => {
    const eventQueue: DesktopAgentEventEnvelope[] = [];
    const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let eventFrame: number | undefined;

    const scheduleRefresh = (projectId: string, sessionId: string): void => {
      const existing = refreshTimers.get(projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        refreshTimers.delete(projectId);
        void window.biny.refreshProject(projectId).then(async (snapshot) => {
          mergeProjectSnapshot(snapshot);
          if (activeProjectIdRef.current === projectId && selectedSessionIdRef.current === sessionId) {
            const refreshedDocument = await window.biny.openSession(projectId, sessionId);
            if (activeProjectIdRef.current === projectId && selectedSessionIdRef.current === sessionId) {
              setDocument(refreshedDocument);
              setWriterConflict(refreshedDocument.writerConflict);
            }
          }
        }).catch(onError);
      }, 260);
      refreshTimers.set(projectId, timer);
    };

    const flushEvents = (): void => {
      eventFrame = undefined;
      const batch = eventQueue.splice(0);
      if (!batch.length) return;
      setSidebarSessions((current) => applyUpdatesToSidebarSessions(current, batch));
      const activeProjectId = activeProjectIdRef.current;
      const projectBatch = activeProjectId
        ? batch.filter((envelope) => envelope.projectId === activeProjectId)
        : [];
      if (projectBatch.length) {
        setWorkspace((current) => current && current.project.id === activeProjectId
          ? applyUpdatesToWorkspace(current, projectBatch)
          : current);
        const currentSessionId = selectedSessionIdRef.current;
        if (currentSessionId) {
          const currentEvents = projectBatch
            .map((envelope) => envelope.event)
            .filter((event): event is AgentHostEvent => event !== undefined && event.sessionId === currentSessionId);
          // skill.draft_created 是审核通知而非对话内容：不进消息时间线，单独收集成聊天内草稿卡。
          const draftNotices = currentEvents.filter((event) => event.type === "skill.draft_created");
          if (draftNotices.length) {
            setSkillDraftNotices((current) => {
              const seen = new Set(current.map((notice) => notice.id));
              const fresh = draftNotices
                .filter((event) => !seen.has(event.draft.id))
                .map((event) => ({ ...event.draft, sessionId: currentSessionId }));
              return fresh.length ? [...current, ...fresh] : current;
            });
          }
          const timelineSource = draftNotices.length
            ? currentEvents.filter((event) => event.type !== "skill.draft_created")
            : currentEvents;
          const timelineEvents = liveTimelineEvents(timelineSource);
          if (timelineEvents.length) {
            setDocument((current) => current?.session.id === currentSessionId
              ? { ...current, liveEvents: [...current.liveEvents, ...timelineEvents] }
              : current);
          }
          const contextEvents = currentEvents.filter(hasContextStatus);
          const latestContext = contextEvents.at(-1);
          if (latestContext) setContextBudget(latestContext.context.budget);
        }
      }

      const completedProjects = new Map<string, string>();
      for (const envelope of batch) {
        if (isTerminalRunEvent(envelope.event)) {
          completedProjects.set(envelope.projectId, envelope.event.sessionId);
        }
      }
      for (const [projectId, sessionId] of completedProjects) scheduleRefresh(projectId, sessionId);
    };

    const unsubscribe = window.biny.onAgentEvent((envelope) => {
      eventQueue.push(envelope);
      eventFrame ??= window.requestAnimationFrame(flushEvents);
    });
    return () => {
      unsubscribe();
      if (eventFrame !== undefined) window.cancelAnimationFrame(eventFrame);
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
    };
  }, [activeProjectIdRef, mergeProjectSnapshot, onError, selectedSessionIdRef, setContextBudget, setDocument, setSkillDraftNotices, setSidebarSessions, setWorkspace, setWriterConflict]);
}
