/**
 * Desktop 渲染进程的装配根。
 *
 * 这里只保留跨区域的项目、会话、导航和浮层状态；运行时事件投影、设置命令、Inspector
 * 与 Composer 本地交互分别下沉到 `app/` 和对应组件。子组件通过回调表达意图，不直接持有
 * Agent、Session 或 Provider。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InteractiveAgentRunMode } from "../../../agent/AgentSession.js";
import type { ContextBudgetStatus } from "../../../agent/context/types.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { activeRun, pendingPermission } from "../../../runtime/agentEvents.js";
import type {
  DesktopActiveView,
  DesktopAttachment,
  DesktopFontPreference,
  DesktopMenuAction,
  DesktopProject,
  DesktopRuntimeMutation,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopSessionTreePage,
  DesktopSettingsCloseRequest,
  DesktopSettingsCloseResponse,
  DesktopSettingsSnapshot,
  DesktopSlashResult,
  DesktopThemePreference,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_FONT_PREFERENCE, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";
import {
  canNavigateBack,
  canNavigateForward,
  createNavigationState,
  moveNavigation,
  pushNavigation,
  replaceNavigation,
  type DesktopNavigationState,
  type DesktopNavigationTarget
} from "./navigationHistory.js";
import { buildSessionTimeline, listChangedFiles, type TimelineTurn } from "./sessionTimeline.js";
import { desktopApiVersionMismatchMessage, errorMessage } from "./app/desktopApi.js";
import {
  applyProjectOrder,
  eventsBeforeUserMessage,
  lastReportedInputTokens,
  mergeProject,
  mergeProjectSessionPage,
  replaceProjectSessions,
  replaceProjectSessionRoots,
  syntheticSession
} from "./app/desktopState.js";
import { useDesktopEventBridge } from "./app/useDesktopEventBridge.js";
import { useDesktopSettingsActions } from "./app/useDesktopSettingsActions.js";
import { useSidebarLayout } from "./app/useSidebarLayout.js";
import { Composer, type ContextUsage } from "./components/Composer.js";
import { summarizeTimelineUsage } from "./usagePresentation.js";
import { DesktopShell } from "./components/DesktopShell.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillHubView } from "./components/SkillHubView.js";
import { Workspace } from "./components/Workspace.js";
import { DesktopToast } from "./components/overlays/DesktopToast.js";
import { RenameOverlay } from "./components/overlays/RenameOverlay.js";
import { SearchOverlay } from "./components/overlays/SearchOverlay.js";
import { SlashResultOverlay } from "./components/overlays/SlashResultOverlay.js";
import { SettingsOverlay, type SettingsTab } from "./components/settings/SettingsOverlay.js";
import { useWorkspaceInspector } from "./components/workspace/useWorkspaceInspector.js";

interface RenameTarget {
  kind: "project" | "session";
  projectId: string;
  sessionId?: string;
  title: string;
  metadataRevision?: string;
}

type DesktopPage = Exclude<DesktopActiveView, "runtime">;

export function App(): React.JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DesktopSessionSummary[]>([]);
  const [workspace, setWorkspace] = useState<DesktopWorkspaceSnapshot>();
  const [document, setDocument] = useState<DesktopSessionDocument>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  const [themePreference, setThemePreference] = useState<DesktopThemePreference>("system");
  const [fontPreference, setFontPreference] = useState<DesktopFontPreference>(DEFAULT_FONT_PREFERENCE);
  const [focusToken, setFocusToken] = useState(0);
  const [deletedUserMessages, setDeletedUserMessages] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTargetTab, setSettingsTargetTab] = useState<SettingsTab>();
  const [settingsCloseRequest, setSettingsCloseRequest] = useState<DesktopSettingsCloseRequest>();
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
  const [page, setPage] = useState<DesktopPage>("chat");
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [slashResult, setSlashResult] = useState<DesktopSlashResult>();
  const [toast, setToast] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef<DesktopNavigationState>(createNavigationState());
  const [navigationState, setNavigationState] = useState<DesktopNavigationState>(() => createNavigationState());
  const loadRequestRef = useRef(0);
  const menuActionRef = useRef<(action: DesktopMenuAction) => void>(() => undefined);

  const persistSidebarWidth = useCallback((width: number): void => {
    void window.biny.setSidebarWidth(width);
  }, []);
  const {
    layout: sidebarLayout,
    drawerHandlers: sidebarPeekDrawerHandlers,
    drawerRef: sidebarPeekDrawerRef,
    triggerHandlers: sidebarPeekTriggerHandlers,
    hydrateExpandedWidth: hydrateSidebarWidth,
    toggle: toggleSidebar,
    onResizeKeyDown: onSidebarResizeKeyDown,
    onResizePointerDown: onSidebarResizePointerDown
  } = useSidebarLayout({ persistWidth: persistSidebarWidth });

  const openSettings = useCallback((targetTab?: SettingsTab): void => {
    setSettingsTargetTab(targetTab);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsTargetTab(undefined);
  }, []);

  const resolveSettingsCloseRequest = useCallback(async (
    requestId: string,
    response: DesktopSettingsCloseResponse
  ): Promise<void> => {
    try {
      await window.biny.respondSettingsCloseRequest(requestId, response);
    } finally {
      setSettingsCloseRequest((current) => current?.requestId === requestId ? undefined : current);
    }
  }, []);

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
  }, []);

  const openExtensions = useCallback((): void => {
    loadRequestRef.current += 1;
    setPage("extensions");
    setRuntimePanelOpen(false);
    setLoading(false);
    setSearchOpen(false);
    setSettingsOpen(false);
    setSettingsTargetTab(undefined);
    void window.biny.setActiveView("extensions").catch((error) => setToast(errorMessage(error)));
  }, []);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  const commitNavigation = useCallback((next: DesktopNavigationState): void => {
    navigationRef.current = next;
    setNavigationState(next);
  }, []);

  const mergeWorkspaceProject = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions)
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    setWorkspace(snapshot);
  }, []);

  const mergeProjectSnapshot = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions)
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    if (projectRef.current === snapshot.project.id) setWorkspace(snapshot);
  }, []);

  const refreshRuntimeProjection = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    const runtimeProjection = await window.biny.runtimeProjection(projectId);
    setWorkspace((current) => current?.project.id === projectId ? { ...current, runtimeProjection } : current);
  }, []);

  const mutateRuntime = useCallback(async (operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开的项目。");
    await window.biny.runtimeMutation(projectId, operation, payload);
    await refreshRuntimeProjection();
  }, [refreshRuntimeProjection]);

  const reportRuntimeError = useCallback((error: unknown): void => {
    setToast(errorMessage(error));
  }, []);

  const loadSessionChildren = useCallback(async (
    projectId: string,
    parentSessionId: string,
    cursor?: string
  ): Promise<DesktopSessionTreePage> => {
    const page = await window.biny.listSessionTreePage(projectId, {
      parentSessionId,
      cursor,
      limit: 32,
      includeArchived: true
    });
    setSidebarSessions((current) => mergeProjectSessionPage(current, projectId, page.sessions));
    return page;
  }, []);

  const reportEventError = useCallback((error: unknown): void => {
    setToast(errorMessage(error));
  }, []);

  const {
    addMemoryEntry,
    cancelMemoryEmbeddingDownload,
    cancelMemoryEmbeddingRebuild,
    cancelModelLogin,
    clearMemory,
    compactMemory,
    deleteMemoryEntry,
    deleteMemoryEmbeddingModel,
    downloadMemoryEmbeddingModel,
    fetchModelCatalog,
    fetchModelCatalogCandidate,
    loadCookieJarStatus,
    loadMemoryEmbeddingStatus,
    loadMemoryOverview,
    openBrowser,
    rebuildMemoryEmbeddingIndex,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration,
    updateMemoryEntry
  } = useDesktopSettingsActions({
    mergeProjectSnapshot,
    projectIdRef: projectRef,
    setContextBudget,
    setWorkspace
  });

  const openSession = useCallback(async (
    projectId: string,
    sessionId: string,
    showLoader = true,
    activeRequest?: number,
    nextWorkspace?: DesktopWorkspaceSnapshot,
    activeView: DesktopActiveView = "chat"
  ): Promise<boolean> => {
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) loadRequestRef.current = request;
    if (loadRequestRef.current !== request) return false;
    if (showLoader) setLoading(true);
    try {
      const nextDocument = await window.biny.openSession(projectId, sessionId);
      if (loadRequestRef.current !== request) return false;
      if (nextWorkspace) {
        projectRef.current = nextWorkspace.project.id;
        mergeWorkspaceProject(nextWorkspace);
      }
      setPage("chat");
      setRuntimePanelOpen(activeView === "runtime");
      selectedRef.current = sessionId;
      setSelectedSessionId(sessionId);
      // 上下文用量属于某一个会话，换会话就作废，等新会话跑出 context.updated 再显示。
      setContextBudget(undefined);
      setDocument(nextDocument);
      setSidebarSessions((current) => mergeProjectSessionPage(current, projectId, [nextDocument.session]));
      setWorkspace((current) => current?.project.id === projectId
        ? {
            ...current,
            selectedSessionId: sessionId,
            sessions: mergeProjectSessionPage(current.sessions, projectId, [nextDocument.session])
          }
        : current);
      // 读取成功且仍持有最新请求后才提交持久化选择；失败或过期请求不会触碰主进程状态。
      void window.biny.commitSelection(projectId, sessionId, activeView).catch((error) => setToast(errorMessage(error)));
      return true;
    } catch (error) {
      if (loadRequestRef.current !== request) return false;
      throw error;
    } finally {
      if (showLoader && loadRequestRef.current === request) setLoading(false);
    }
  }, [mergeWorkspaceProject]);

  const adoptWorkspace = useCallback(async (
    snapshot: DesktopWorkspaceSnapshot,
    preferredSessionId?: string,
    activeRequest?: number
  ): Promise<boolean> => {
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) loadRequestRef.current = request;
    if (loadRequestRef.current !== request) return false;
    if (preferredSessionId) return await openSession(snapshot.project.id, preferredSessionId, true, request, snapshot);
    setPage("chat");
    setRuntimePanelOpen(false);
    projectRef.current = snapshot.project.id;
    selectedRef.current = undefined;
    mergeWorkspaceProject(snapshot);
    // 显式切换项目或新建任务时进入空白草稿，不沿用该项目之前保存的会话正文。
    setSelectedSessionId(undefined);
    setDocument(undefined);
    setContextBudget(undefined);
    setLoading(false);
    void window.biny.commitSelection(snapshot.project.id, undefined, "chat").catch((error) => setToast(errorMessage(error)));
    return true;
  }, [mergeWorkspaceProject, openSession]);

  const openNavigationTarget = useCallback(async (target: DesktopNavigationTarget): Promise<boolean> => {
    // 从项目选择到会话读取共用同一个请求号，较早的跨项目请求不能在较新的点击后重新取得提交权。
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    const startingCurrentDraft = target.sessionId === undefined && target.projectId === projectRef.current;
    if (startingCurrentDraft) {
      // 当前项目的新建任务应立即呈现空白输入框。startDraft 只负责重置旧运行时，
      // 这里不能把它伪装成“恢复会话”，也不能继续显示上一段聊天正文。
      setPage("chat");
      setRuntimePanelOpen(false);
      selectedRef.current = undefined;
      setSelectedSessionId(undefined);
      setDocument(undefined);
      setContextBudget(undefined);
      setWorkspace((current) => current?.project.id === target.projectId
        ? { ...current, selectedSessionId: undefined }
        : current);
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      if (target.sessionId === undefined) {
        const snapshot = await window.biny.startDraft(target.projectId);
        if (loadRequestRef.current !== request) return false;
        const adopted = await adoptWorkspace(snapshot, undefined, request);
        if (adopted) setFocusToken((value) => value + 1);
        return adopted;
      }
      if (target.projectId === projectRef.current) {
        return await openSession(target.projectId, target.sessionId, false, request);
      }
      const snapshot = await window.biny.selectProject(target.projectId);
      if (loadRequestRef.current !== request) return false;
      return await openSession(target.projectId, target.sessionId, false, request, snapshot);
    } catch (error) {
      if (loadRequestRef.current !== request) return false;
      throw error;
    } finally {
      if (loadRequestRef.current === request) setLoading(false);
    }
  }, [adoptWorkspace, openSession]);

  useEffect(() => {
    let active = true;
    void window.biny.bootstrap().then(async (bootstrap) => {
      if (!active) return;
      setVersion(bootstrap.version);
      setProjects(bootstrap.projects);
      setSidebarSessions(bootstrap.sidebarSessions);
      hydrateSidebarWidth(bootstrap.sidebarWidth);
      setFilePanelWidth(bootstrap.filePanelWidth ?? DEFAULT_FILE_PANEL_WIDTH);
      setThemePreference(bootstrap.themePreference ?? "system");
      setFontPreference(bootstrap.fontPreference ?? DEFAULT_FONT_PREFERENCE);
      setPage(bootstrap.activeView === "extensions" ? "extensions" : "chat");
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(bootstrap.workspace));
      if (bootstrap.workspace) {
        mergeWorkspaceProject(bootstrap.workspace);
        // 显式 `/app` 交接优先于持久化位置；普通启动则恢复上次会话正文，
        // 但不会自动继续中断的运行。
        const nextSessionId = bootstrap.selectedSessionId;
        if (nextSessionId) {
          const opened = await openSession(
            bootstrap.workspace.project.id,
            nextSessionId,
            true,
            undefined,
            undefined,
            bootstrap.activeView
          );
          if (opened) commitNavigation(pushNavigation(createNavigationState(), { projectId: bootstrap.workspace.project.id, sessionId: nextSessionId }));
        }
        else setLoading(false);
      } else {
        setLoading(false);
      }
    }).catch((error) => {
      if (!active) return;
      setLoading(false);
      setToast(`Biny 启动失败：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [commitNavigation, hydrateSidebarWidth, mergeWorkspaceProject, openSession]);

  useDesktopEventBridge({
    activeProjectIdRef: projectRef,
    selectedSessionIdRef: selectedRef,
    mergeProjectSnapshot,
    onError: reportEventError,
    setContextBudget,
    setDocument,
    setSidebarSessions,
    setWorkspace
  });

  useEffect(() => window.biny.onSessionHandoff((target) => {
    void openNavigationTarget(target).catch((error) => setToast(errorMessage(error)));
  }), [openNavigationTarget]);

  useEffect(() => window.biny.onMenuAction((action) => menuActionRef.current(action)), []);

  useEffect(() => window.biny.onSettingsCloseRequest((request) => {
    setSettingsCloseRequest(request);
    setSettingsOpen(true);
  }), []);

  const openProject = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.biny.openProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const createEmptyProject = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.biny.createEmptyProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
        setFocusToken((value) => value + 1);
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const selectProject = useCallback(async (projectId: string): Promise<void> => {
    if (projectId === projectRef.current) return;
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    setLoading(true);
    try {
      const snapshot = await window.biny.selectProject(projectId);
      if (loadRequestRef.current === request) await adoptWorkspace(snapshot, undefined, request);
    } catch (error) {
      if (loadRequestRef.current === request) setToast(errorMessage(error));
    } finally {
      if (loadRequestRef.current === request) setLoading(false);
    }
  }, [adoptWorkspace]);

  const newTask = useCallback(async (targetProjectId = projectRef.current): Promise<void> => {
    setRuntimePanelOpen(false);
    const projectId = targetProjectId;
    if (!projectId) {
      await openProject();
      return;
    }
    const target: DesktopNavigationTarget = { projectId, sessionId: undefined };
    const previousNavigation = navigationRef.current;
    try {
      if (await openNavigationTarget(target)) commitNavigation(pushNavigation(previousNavigation, target));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget, openProject]);

  const openRuntimePanel = useCallback((): void => {
    if (!projectRef.current) {
      setToast("请先打开项目，再查看自动化与后台运行。");
      return;
    }
    loadRequestRef.current += 1;
    setPage("chat");
    setSearchOpen(false);
    setLoading(false);
    setRuntimePanelOpen(true);
    void window.biny.setActiveView("runtime").catch((error) => setToast(errorMessage(error)));
  }, []);

  const changeRuntimePanelOpen = useCallback((open: boolean): void => {
    setRuntimePanelOpen(open);
    void window.biny.setActiveView(open ? "runtime" : "chat").catch((error) => setToast(errorMessage(error)));
  }, []);

  const navigateToSession = useCallback(async (projectId: string, sessionId: string): Promise<void> => {
    const previousNavigation = navigationRef.current;
    const target: DesktopNavigationTarget = { projectId, sessionId };
    try {
      if (await openNavigationTarget(target)) commitNavigation(pushNavigation(previousNavigation, target));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget]);

  const navigateHistory = useCallback(async (direction: -1 | 1): Promise<void> => {
    const previousNavigation = navigationRef.current;
    const nextNavigation = moveNavigation(previousNavigation, direction);
    if (!nextNavigation.target) return;
    try {
      if (await openNavigationTarget(nextNavigation.target)) commitNavigation(nextNavigation.state);
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget]);

  const toggleSessionPinned = useCallback(async (session: DesktopSessionSummary, pinned = !session.pinned): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.pinSession(session.projectId, session.id, pinned, session.metadataRevision));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

  const openSessionMenu = useCallback(async (session: DesktopSessionSummary): Promise<void> => {
    try {
      const action = await window.biny.showSessionMenu(session.projectId, session.id, session.pinned, session.archived ?? false);
      if (!action) return;
      if (action === "rename") {
        setRenameTarget({ kind: "session", projectId: session.projectId, sessionId: session.id, title: session.title, metadataRevision: session.metadataRevision });
        return;
      }
      if (action === "pin" || action === "unpin") {
        await toggleSessionPinned(session, action === "pin");
        return;
      }
      if (action === "archive" || action === "unarchive") {
        mergeProjectSnapshot(await window.biny.archiveSession(session.projectId, session.id, action === "archive", session.metadataRevision));
        return;
      }
      if (action === "duplicate") {
        const previousNavigation = navigationRef.current;
        let snapshot = await window.biny.duplicateSession(session.projectId, session.id);
        if (projectRef.current !== session.projectId) {
          snapshot = await window.biny.selectProject(session.projectId);
        }
        await adoptWorkspace(snapshot, snapshot.selectedSessionId);
        if (snapshot.selectedSessionId) {
          commitNavigation(pushNavigation(previousNavigation, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
        return;
      }
      if (action !== "delete") return;
      const deletingSelectedSession = projectRef.current === session.projectId && selectedRef.current === session.id;
      const snapshot = await window.biny.deleteSession(session.projectId, session.id);
      if (projectRef.current === session.projectId) {
        await adoptWorkspace(snapshot, snapshot.selectedSessionId);
        if (deletingSelectedSession) {
          commitNavigation(replaceNavigation(navigationRef.current, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
      } else {
        mergeProjectSnapshot(snapshot);
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation, mergeProjectSnapshot, toggleSessionPinned]);

  useEffect(() => {
    menuActionRef.current = (action) => {
      if (action === "new-task") void newTask();
      if (action === "open-project") void openProject();
      if (action === "search") openSearch();
      if (action === "settings") openSettings();
      if (action === "toggle-sidebar") toggleSidebar();
      if (action === "focus-composer") setFocusToken((value) => value + 1);
    };
  }, [newTask, openProject, openSearch, openSettings, toggleSidebar]);

  const sendPrompt = useCallback(async (input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp"): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const previousSessionId = selectedRef.current;
    const previousNavigation = navigationRef.current;
    const receipt = await window.biny.sendPrompt(projectId, selectedRef.current, input, mode, attachments, delivery);
    setSelectedSessionId(receipt.sessionId);
    if (receipt.sessionId !== previousSessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    if (!document || document.session.id !== receipt.sessionId) {
      const summary = workspace?.sessions.find((session) => session.id === receipt.sessionId) ?? syntheticSession(projectId, receipt.sessionId, input);
      setDocument({ session: summary, events: [], liveEvents: [] });
    }
  }, [commitNavigation, document, workspace?.sessions]);

  const resumeInterruptedTurn = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) return;
    const receipt = await window.biny.resumeInterruptedTurn(projectId, sessionId);
    if (!receipt) {
      setToast("当前会话没有可恢复的在途回合。");
      return;
    }
    setSelectedSessionId(receipt.sessionId);
  }, []);

  const runSlashCommand = useCallback(async (command: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    setSlashResult(await window.biny.runSlashCommand(projectId, selectedRef.current, command));
  }, []);

  const runInspectorCommand = useCallback(async (command: string): Promise<DesktopSlashResult> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.runSlashCommand(projectId, selectedRef.current, command);
  }, []);

  const editPrompt = useCallback(async (
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[],
    sessionId: string,
    userMessageIndex: number
  ): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (selectedRef.current !== sessionId) throw new Error("请回到原消息所在的会话后再提交编辑。");
    const previousNavigation = navigationRef.current;
    const previousDocument = document;
    const edit = window.biny.editPrompt;
    if (typeof edit !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const receipt = await edit(projectId, sessionId, userMessageIndex, input, mode, attachments);
    setSelectedSessionId(receipt.sessionId);
    if (receipt.sessionId !== sessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    const sourceSummary = workspace?.sessions.find((session) => session.id === sessionId) ?? previousDocument?.session;
    const summary = sourceSummary
      ? { ...sourceSummary, id: receipt.sessionId, fileName: `${receipt.sessionId}.jsonl`, status: "running" as const, updatedAt: new Date().toISOString() }
      : syntheticSession(projectId, receipt.sessionId, input);
    const prefixEvents = previousDocument?.session.id === sessionId
      ? eventsBeforeUserMessage(previousDocument.events, userMessageIndex)
      : [];
    setDocument({ session: summary, events: prefixEvents, liveEvents: [] });
  }, [commitNavigation, document, workspace?.sessions]);

  const editUserMessage = useCallback(async (input: string, userMessageIndex: number): Promise<void> => {
    const sessionId = selectedRef.current;
    if (!sessionId) {
      throw new Error("当前消息还没有可编辑的会话。");
    }
    await editPrompt(input, "chat", [], sessionId, userMessageIndex);
  }, [editPrompt]);

  const deleteUserMessage = useCallback((turnId: string): void => {
    const scope = `${projectRef.current ?? "none"}:${selectedRef.current ?? "draft"}`;
    const key = `${scope}:${turnId}`;
    setDeletedUserMessages((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setToast("已删除这条用户消息");
  }, []);

  const createBranch = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setToast("当前草稿还没有可创建的分支");
      return;
    }
    const previousNavigation = navigationRef.current;
    try {
      const snapshot = await window.biny.duplicateSession(projectId, sessionId);
      await adoptWorkspace(snapshot, snapshot.selectedSessionId);
      if (snapshot.selectedSessionId) commitNavigation(pushNavigation(previousNavigation, { projectId, sessionId: snapshot.selectedSessionId }));
      setToast("已创建会话分支");
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation]);

  const rollbackFiles = useCallback((turn: TimelineTurn): void => {
    const files = listChangedFiles(turn);
    setToast(files.length ? "当前消息的文件变更没有安全快照，暂不自动回滚" : "当前消息没有可回滚的文件");
  }, []);

  useEffect(() => {
    window.document.documentElement.dataset.theme = themePreference;
  }, [themePreference]);

  const changeThemePreference = useCallback((theme: DesktopThemePreference): void => {
    setThemePreference(theme);
  }, []);

  // 字号通过 --app-font-size 驱动样式表里的 --font-scale 等比缩放全部文字；
  // 自定义字体族插到默认字体栈前面，缺字时仍能落到系统 CJK 字体。
  useEffect(() => {
    const style = window.document.documentElement.style;
    style.setProperty("--app-font-size", String(fontPreference.size));
    if (fontPreference.family === SYSTEM_FONT_FAMILY) style.removeProperty("--font-sans");
    else style.setProperty("--font-sans", `"${fontPreference.family.replaceAll('"', "")}", var(--font-sans-stack)`);
  }, [fontPreference]);

  const changeFontPreference = useCallback((font: DesktopFontPreference): void => {
    setFontPreference(font);
  }, []);

  const settingsCommitted = useCallback((snapshot: DesktopSettingsSnapshot): void => {
    setThemePreference(snapshot.themePreference);
    setFontPreference(snapshot.fontPreference);
    void window.biny.refreshProject(snapshot.projectId)
      .then(mergeProjectSnapshot)
      .catch((error: unknown) => setToast(errorMessage(error)));
  }, [mergeProjectSnapshot]);

  const toggleProjectPinned = useCallback(async (projectId: string, pinned: boolean): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.setProjectPinned(projectId, pinned));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

  const reorderProjects = useCallback(async (projectIds: string[]): Promise<void> => {
    // Quiet optimistic reorder — this is a low-stakes UI preference, not a warnable action.
    setProjects((current) => applyProjectOrder(current, projectIds));
    try {
      setProjects(await window.biny.reorderProjects(projectIds));
    } catch {
      // Keep the optimistic order; persistence can catch up on the next successful reorder.
    }
  }, []);

  const renameProject = useCallback((projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) setRenameTarget({ kind: "project", projectId, title: project.name, sessionId: undefined });
  }, [projects]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    try {
      const bootstrap = await window.biny.removeProject(projectId);
      setProjects(bootstrap.projects);
      setSidebarSessions(bootstrap.sidebarSessions);
      setWorkspace(bootstrap.workspace);
      setDocument(undefined);
      setSelectedSessionId(undefined);
      setPage(bootstrap.activeView === "extensions" ? "extensions" : "chat");
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(bootstrap.workspace));
      commitNavigation(createNavigationState());
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation]);

  const setPermissionMode = useCallback(async (mode: PermissionMode): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    mergeWorkspaceProject(await window.biny.setPermissionMode(projectId, mode));
  }, [mergeWorkspaceProject]);

  const saveAttachment = useCallback(async (file: File): Promise<DesktopAttachment> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MB。`);
    return await window.biny.saveAttachment(projectId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  }, []);

  const resolvePermission = useCallback(async (requestId: string, result: PermissionResult): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    await window.biny.resolvePermission(projectId, requestId, result);
  }, []);

  const readWorkspaceFile = useCallback(async (path: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.readWorkspaceFile(projectId, path);
  }, []);

  const listWorkspaceDirectory = useCallback(async (path: string): Promise<DesktopWorkspaceDirectory> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.listWorkspaceDirectory(projectId, path);
  }, []);

  const openWorkspaceFile = useCallback((path: string): void => {
    const projectId = projectRef.current;
    if (!projectId) return;
    void window.biny.openWorkspaceFile(projectId, path).catch((error) => setToast(errorMessage(error)));
  }, []);

  const inspector = useWorkspaceInspector({
    filePanelResizing,
    filePanelWidth,
    onFilePanelResizeEnd: (width) => {
      setFilePanelResizing(false);
      void window.biny.setFilePanelWidth(width);
    },
    onFilePanelResizeStart: () => setFilePanelResizing(true),
    onFilePanelWidthChange: setFilePanelWidth,
    onListDirectory: listWorkspaceDirectory,
    onOpenFile: openWorkspaceFile,
    onOpenBrowser: openBrowser,
    onReadFile: readWorkspaceFile,
    onRunCommand: runInspectorCommand,
    projectId: workspace?.project.id,
    source: `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`
  });

  const turns = useMemo(() => document ? buildSessionTimeline(document.events, document.liveEvents) : [], [document]);
  const sessionUsage = useMemo(() => summarizeTimelineUsage(turns), [turns]);
  const messageScope = `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`;
  const visibleTurns = useMemo(() => turns
    .map((turn) => deletedUserMessages.has(`${messageScope}:${turn.id}`) ? { ...turn, user: "" } : turn)
    .filter((turn) => turn.user || turn.assistant || turn.tools.length || turn.error), [deletedUserMessages, messageScope, turns]);
  // 上下文用量：优先用运行时刚上报的实时值；重开会话或刚启动时运行时还没跑过一轮，
  // 就退回会话里最后一次 provider 报告的输入 token 数——和运行时的 usedTokens 是同一个口径。
  const contextUsage = useMemo<ContextUsage | undefined>(() => {
    const info = workspace?.runtime?.info;
    const models = workspace?.models ?? [];
    const selectedModel = models.find((model) => model.alias === info?.modelAlias) ?? models[0];
    const maxTokens = contextBudget?.maxTokens ?? info?.maxInputTokens ?? selectedModel?.inputBudgetTokens;
    const usedTokens = contextBudget?.usedTokens ?? lastReportedInputTokens(document);
    if (!maxTokens || !usedTokens) return undefined;
    return { usedTokens, maxTokens };
  }, [contextBudget, document, workspace?.models, workspace?.runtime?.info]);
  const clearToast = useCallback(() => setToast(undefined), []);
  const sessionSummary = workspace?.sessions.find((session) => session.id === selectedSessionId) ?? document?.session;
  const activeRunSnapshot = activeRun(workspace?.runtime);
  const pendingPermissionSnapshot = pendingPermission(workspace?.runtime);
  const activeSessionId = activeRunSnapshot?.sessionId ?? pendingPermissionSnapshot?.sessionId;
  const selectedActiveRun = activeRunSnapshot?.sessionId === selectedSessionId ? activeRunSnapshot : undefined;
  const selectedPendingPermission = pendingPermissionSnapshot?.sessionId === selectedSessionId ? pendingPermissionSnapshot : undefined;
  const selectedRunId = selectedActiveRun?.runId ?? selectedPendingPermission?.runId;
  const selectedRunning = Boolean(activeSessionId && activeSessionId === selectedSessionId);
  const selectedThinking = selectedActiveRun?.status === "thinking";
  const activeElsewhere = Boolean(activeSessionId && selectedSessionId && activeSessionId !== selectedSessionId);
  const composer = (
    <Composer
      activeElsewhere={activeElsewhere}
      contextUsage={contextUsage}
      focusToken={focusToken}
      modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
      models={workspace?.pickerModels ?? workspace?.models ?? []}
      onPermissionMode={setPermissionMode}
      onSaveAttachment={saveAttachment}
      onSend={sendPrompt}
      onSlashCommand={runSlashCommand}
      onStop={async () => {
        const projectId = projectRef.current;
        if (!projectId || !selectedRunId) throw new Error("当前运行已结束或状态尚未同步，未发送取消请求。");
        await window.biny.cancelRun(projectId, selectedRunId);
      }}
      onSwitchModel={switchModel}
      permissionMode={workspace?.runtime?.permissionMode ?? "ask"}
      project={workspace?.project}
      running={selectedRunning}
      runtimeInfo={workspace?.runtime?.info}
    />
  );

  return (
    <DesktopShell
      overlays={(
        <>
          <SearchOverlay
            onClose={closeSearch}
            onProject={(projectId) => void selectProject(projectId)}
            onSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
            open={searchOpen}
            projects={projects}
            sessions={sidebarSessions}
          />
          <SettingsOverlay
            closeRequest={settingsCloseRequest}
            modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
            onAddMemoryEntry={addMemoryEntry}
            onCancelMemoryEmbeddingDownload={cancelMemoryEmbeddingDownload}
            onCancelMemoryEmbeddingRebuild={cancelMemoryEmbeddingRebuild}
            onCancelModelLogin={cancelModelLogin}
            onClearCookies={async () => await window.biny.clearCookies()}
            onClearMemory={clearMemory}
            onClose={closeSettings}
            onCompactMemory={compactMemory}
            onDeleteMemoryEntry={deleteMemoryEntry}
            onDeleteMemoryEmbeddingModel={deleteMemoryEmbeddingModel}
            onDownloadMemoryEmbeddingModel={downloadMemoryEmbeddingModel}
            onUpdateMemoryEntry={updateMemoryEntry}
            onExportCookies={async () => await window.biny.exportCookies()}
            onFetchModelCatalog={fetchModelCatalog}
            onFetchModelCatalogCandidate={fetchModelCatalogCandidate}
            onFontPreference={changeFontPreference}
            onSettingsCommitted={settingsCommitted}
            onResolveCloseRequest={resolveSettingsCloseRequest}
            onImportCookies={async () => await window.biny.importCookies()}
            onNotify={setToast}
            onLoadCookieJarStatus={loadCookieJarStatus}
            onLoadMemoryOverview={loadMemoryOverview}
            onLoadMemoryEmbeddingStatus={loadMemoryEmbeddingStatus}
            onOpenBrowser={openBrowser}
            onOpenExternal={async (url) => await window.biny.openExternal(url)}
            onRebuildMemoryEmbeddingIndex={rebuildMemoryEmbeddingIndex}
            onSearchMemory={searchMemory}
            onStartModelLogin={startModelLogin}
            onTestModelConfiguration={testModelConfiguration}
            onThemePreference={changeThemePreference}
            open={settingsOpen}
            sessionId={selectedSessionId}
            sessionRunning={Boolean(activeSessionId)}
            targetTab={settingsTargetTab}
            themePreference={themePreference}
            fontPreference={fontPreference}
            version={version}
            workspace={workspace}
          />
          <RenameOverlay
            initialValue={renameTarget?.title ?? ""}
            onClose={() => setRenameTarget(undefined)}
            onSave={async (title) => {
              if (!renameTarget) return;
              if (renameTarget.kind === "project") {
                mergeProjectSnapshot(await window.biny.renameProject(renameTarget.projectId, title));
              } else if (renameTarget.sessionId) {
                mergeProjectSnapshot(await window.biny.renameSession(renameTarget.projectId, renameTarget.sessionId, title, renameTarget.metadataRevision));
                setDocument((current) => {
                  if (!current || current.session.id !== renameTarget.sessionId) return current;
                  return { events: current.events, liveEvents: current.liveEvents, session: { ...current.session, title } };
                });
              }
              setRenameTarget(undefined);
            }}
            open={Boolean(renameTarget)}
            title={renameTarget?.kind === "project" ? "重命名项目" : "重命名会话"}
          />
          <SlashResultOverlay onClose={() => setSlashResult(undefined)} result={slashResult} />
          <DesktopToast message={toast} onClose={clearToast} />
      </>
      )}
      rightPanel={inspector.dock}
      rightSidebar={inspector.layout}
      sidebarLayout={sidebarLayout}
      sideNav={(
        <Sidebar
          activeNavigation={page === "extensions" ? "extensions" : runtimePanelOpen ? "runtime" : undefined}
          activeProjectId={workspace?.project.id}
          onCreateEmptyProject={() => void createEmptyProject()}
          onNewTask={(projectId) => void newTask(projectId)}
          onOpenProject={() => void openProject()}
          onOpenRuntime={openRuntimePanel}
          onOpenTerminalProject={(projectId) => { void window.biny.openProjectTerminal(projectId).catch((error) => setToast(errorMessage(error))); }}
          onProjectPinned={(projectId, pinned) => void toggleProjectPinned(projectId, pinned)}
          onRefreshProject={(projectId) => { void window.biny.refreshProject(projectId).then(mergeProjectSnapshot).catch((error) => setToast(errorMessage(error))); }}
          onRemoveProject={(projectId) => void removeProject(projectId)}
          onRenameProject={renameProject}
          onReorderProjects={(projectIds) => void reorderProjects(projectIds)}
          onRevealProject={(projectId) => { void window.biny.revealProject(projectId).catch((error) => setToast(errorMessage(error))); }}
          onSearch={openSearch}
          onSelectSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
          onLoadSessionChildren={loadSessionChildren}
          onSessionMenu={(session) => void openSessionMenu(session)}
          onSessionPin={(session) => { void toggleSessionPinned(session); }}
          onExtensions={openExtensions}
          onSettings={() => openSettings()}
          onResizeKeyDown={onSidebarResizeKeyDown}
          onResizePointerDown={onSidebarResizePointerDown}
          onToggleSidebar={toggleSidebar}
          canGoBack={canNavigateBack(navigationState)}
          canGoForward={canNavigateForward(navigationState)}
          onNavigateBack={() => { void navigateHistory(-1); }}
          onNavigateForward={() => { void navigateHistory(1); }}
          layout={sidebarLayout}
          projects={projects}
          selectedSessionId={selectedSessionId}
          sessions={sidebarSessions}
          peekDrawerHandlers={sidebarPeekDrawerHandlers}
          peekDrawerRef={sidebarPeekDrawerRef}
          peekTriggerHandlers={sidebarPeekTriggerHandlers}
        />
      )}
      theme={themePreference}
    >
      {page === "extensions" ? <SkillHubView onError={setToast} /> : <Workspace
        loading={loading}
        onCreateBranch={() => { void createBranch(); }}
        onDeleteUserMessage={deleteUserMessage}
        onEditUserMessage={editUserMessage}
        onOpenExternal={(url) => void window.biny.openExternal(url).catch((error) => setToast(errorMessage(error)))}
        onOpenProject={() => void openProject()}
        onPreviewFile={inspector.previewFile}
        inspectorOpen={inspector.open}
        onResolvePermission={resolvePermission}
        onResume={resumeInterruptedTurn}
        onRollbackFiles={rollbackFiles}
        onRetry={(input) => void sendPrompt(input, "chat", []).catch((error) => setToast(errorMessage(error)))}
        onToggleInspector={inspector.toggleInspector}
        onRuntimePanelOpenChange={changeRuntimePanelOpen}
        project={workspace?.project}
        projectId={workspace?.project.id}
        runtimeError={workspace?.runtimeError}
        runtimePanelOpen={runtimePanelOpen}
        runtimeProjection={workspace?.runtimeProjection}
        sessionId={selectedSessionId}
        sessionTitle={sessionSummary?.title}
        sessionUsage={sessionUsage}
        thinking={selectedThinking}
        thinkingStartedAt={selectedActiveRun?.startedAt}
        turns={visibleTurns}
        onRuntimeError={reportRuntimeError}
        onRuntimeMutation={mutateRuntime}
        onRuntimeRefresh={refreshRuntimeProjection}
      >
        {composer}
      </Workspace>}
    </DesktopShell>
  );
}
