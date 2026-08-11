/**
 * 设置面板使用的 Desktop 命令集合。
 *
 * 模型、记忆、联网搜索和登录都通过 preload API 执行；这里统一补上当前项目与 API 版本边界，
 * 并只在服务端快照真正变化时回写根状态。
 */
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ThinkingSelection } from "../../../../llm/ModelManager.js";
import type {
  DesktopChatPersonalizationOverride,
  DesktopMemoryEntryInput,
  DesktopMemoryScope,
  DesktopMemorySettingsInput,
  DesktopModelConfigurationInput,
  DesktopModelLoginProvider,
  DesktopPersonalizationSettingsInput,
  DesktopWebSearchSettingsInput,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";
import { desktopApiVersionMismatchMessage } from "./desktopApi.js";
import { updateRuntimeInfo } from "./desktopState.js";

interface DesktopSettingsActionsOptions {
  projectIdRef: RefObject<string | undefined>;
  mergeProjectSnapshot(snapshot: DesktopWorkspaceSnapshot): void;
  mergeWorkspaceProject(snapshot: DesktopWorkspaceSnapshot): void;
  setWorkspace: Dispatch<SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
}

export function useDesktopSettingsActions({
  projectIdRef,
  mergeProjectSnapshot,
  mergeWorkspaceProject,
  setWorkspace
}: DesktopSettingsActionsOptions) {
  const switchModel = useCallback(async (alias: string, thinking: ThinkingSelection): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    const info = await window.biny.switchModel(projectId, alias, thinking);
    setWorkspace((current) => updateRuntimeInfo(current, info));
    // 切模型可能刚创建运行时，而旧快照还没有 runtime；完整刷新可避免界面继续显示旧模型。
    mergeProjectSnapshot(await window.biny.refreshProject(projectId));
  }, [mergeProjectSnapshot, projectIdRef, setWorkspace]);

  const saveModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput): Promise<void> => {
    const projectId = requireProject(projectIdRef.current);
    mergeWorkspaceProject(await window.biny.saveModelConfiguration(projectId, configuration));
  }, [mergeWorkspaceProject, projectIdRef]);

  const testModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput) => {
    return await window.biny.testModelConfiguration(requireProject(projectIdRef.current), configuration);
  }, [projectIdRef]);

  const removeModelConfiguration = useCallback(async (alias: string): Promise<void> => {
    const projectId = requireProject(projectIdRef.current);
    mergeWorkspaceProject(await window.biny.removeModelConfiguration(projectId, alias));
  }, [mergeWorkspaceProject, projectIdRef]);

  const fetchModelCatalog = useCallback(async (providerAlias: string) => {
    const fetchCatalog = window.biny.fetchModelCatalog;
    if (typeof fetchCatalog !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await fetchCatalog(requireProject(projectIdRef.current), providerAlias);
  }, [projectIdRef]);

  const startModelLogin = useCallback(async (provider: DesktopModelLoginProvider) => {
    const startLogin = window.biny.startModelLogin;
    if (typeof startLogin !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await startLogin(requireProject(projectIdRef.current), provider);
  }, [projectIdRef]);

  const completeModelLogin = useCallback(async (
    provider: DesktopModelLoginProvider,
    authRequestId: string,
    pastedAuthorization?: string
  ): Promise<void> => {
    const completeLogin = window.biny.completeModelLogin;
    if (typeof completeLogin !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const projectId = requireProject(projectIdRef.current);
    mergeWorkspaceProject(await completeLogin(projectId, provider, authRequestId, pastedAuthorization));
  }, [mergeWorkspaceProject, projectIdRef]);

  const cancelModelLogin = useCallback(async (
    provider: DesktopModelLoginProvider,
    authRequestId: string
  ): Promise<void> => {
    const projectId = projectIdRef.current;
    const cancelLogin = window.biny.cancelModelLogin;
    if (!projectId || typeof cancelLogin !== "function") return;
    await cancelLogin(projectId, provider, authRequestId);
  }, [projectIdRef]);

  const loadWebSearchSettings = useCallback(async () => {
    const webSearchSettings = window.biny.webSearchSettings;
    if (typeof webSearchSettings !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await webSearchSettings(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const saveWebSearchSettings = useCallback(async (input: DesktopWebSearchSettingsInput) => {
    return await window.biny.saveWebSearchSettings(requireProject(projectIdRef.current), input);
  }, [projectIdRef]);

  const loadCookieJarStatus = useCallback(async () => {
    const cookieJarStatus = window.biny.cookieJarStatus;
    if (typeof cookieJarStatus !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cookieJarStatus();
  }, []);

  const openBrowser = useCallback(async (url?: string) => {
    const open = window.biny.openBrowser;
    if (typeof open !== "function") throw new Error(desktopApiVersionMismatchMessage);
    await open(url);
  }, []);

  const loadPersonalizationOverview = useCallback(async (sessionId?: string) => {
    const personalizationOverview = window.biny.personalizationOverview;
    if (typeof personalizationOverview !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await personalizationOverview(requireProject(projectIdRef.current), sessionId);
  }, [projectIdRef]);

  const savePersonalizationSettings = useCallback(async (input: DesktopPersonalizationSettingsInput, sessionId?: string) => {
    const save = window.biny.savePersonalizationSettings;
    if (typeof save !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const projectId = requireProject(projectIdRef.current);
    await save(projectId, input);
    return await window.biny.personalizationOverview(projectId, sessionId);
  }, [projectIdRef]);

  const saveChatPersonalization = useCallback(async (
    sessionId: string,
    input: DesktopChatPersonalizationOverride,
    expectedRevision: string
  ) => {
    const save = window.biny.saveChatPersonalization;
    if (typeof save !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const projectId = requireProject(projectIdRef.current);
    mergeProjectSnapshot(await save(projectId, sessionId, input, expectedRevision));
    return await window.biny.personalizationOverview(projectId, sessionId);
  }, [mergeProjectSnapshot, projectIdRef]);

  const loadMemoryOverview = useCallback(async (scope: DesktopMemoryScope) => {
    const memoryOverview = window.biny.memoryOverview;
    if (typeof memoryOverview !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryOverview(requireProject(projectIdRef.current), scope);
  }, [projectIdRef]);

  const saveMemorySettings = useCallback(async (input: DesktopMemorySettingsInput) => {
    return await window.biny.saveMemorySettings(requireProject(projectIdRef.current), input);
  }, [projectIdRef]);

  const searchMemory = useCallback(async (scope: DesktopMemoryScope, query: string) => {
    return await window.biny.searchMemory(requireProject(projectIdRef.current), scope, query);
  }, [projectIdRef]);

  const addMemoryEntry = useCallback(async (scope: DesktopMemoryScope, input: DesktopMemoryEntryInput, expectedRevision: number) => {
    return await window.biny.addMemoryEntry(requireProject(projectIdRef.current), scope, input, expectedRevision);
  }, [projectIdRef]);

  const deleteMemoryEntry = useCallback(async (scope: DesktopMemoryScope, entryId: string, expectedRevision: number) => {
    return await window.biny.deleteMemoryEntry(requireProject(projectIdRef.current), scope, entryId, expectedRevision);
  }, [projectIdRef]);

  const clearMemory = useCallback(async (scope: DesktopMemoryScope, expectedRevision: number) => {
    return await window.biny.clearMemory(requireProject(projectIdRef.current), scope, expectedRevision);
  }, [projectIdRef]);

  const compactMemory = useCallback(async (scope: DesktopMemoryScope, expectedRevision: number) => {
    return await window.biny.compactMemory(requireProject(projectIdRef.current), scope, expectedRevision);
  }, [projectIdRef]);

  return {
    addMemoryEntry,
    cancelModelLogin,
    clearMemory,
    compactMemory,
    completeModelLogin,
    deleteMemoryEntry,
    fetchModelCatalog,
    loadCookieJarStatus,
    loadMemoryOverview,
    loadPersonalizationOverview,
    loadWebSearchSettings,
    openBrowser,
    removeModelConfiguration,
    saveMemorySettings,
    saveModelConfiguration,
    saveChatPersonalization,
    savePersonalizationSettings,
    saveWebSearchSettings,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration
  };
}

function requireProject(projectId: string | undefined): string {
  if (!projectId) throw new Error("请先打开一个项目。");
  return projectId;
}
