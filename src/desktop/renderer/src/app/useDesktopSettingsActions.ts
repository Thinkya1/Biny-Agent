/**
 * 设置面板使用的 Desktop 命令集合。
 *
 * 模型、记忆、联网搜索和登录都通过 preload API 执行；这里统一补上当前项目与 API 版本边界，
 * 并只在服务端快照真正变化时回写根状态。
 */
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ContextBudgetStatus } from "../../../../agent/context/types.js";
import type { ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { LocalEmbeddingModelId } from "../../../../llm/embedding/types.js";
import type {
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopMemoryOriginFilter,
  DesktopBehaviorPatternReviewAction,
  DesktopTelosDocumentInput,
  DesktopTelosDriftResolutionAction,
  DesktopModelConfigurationInput,
  DesktopModelLoginProvider,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";
import { desktopApiVersionMismatchMessage } from "./desktopApi.js";
import { updateRuntimeInfo } from "./desktopState.js";

interface DesktopSettingsActionsOptions {
  projectIdRef: RefObject<string | undefined>;
  mergeProjectSnapshot(snapshot: DesktopWorkspaceSnapshot): void;
  setContextBudget: Dispatch<SetStateAction<ContextBudgetStatus | undefined>>;
  setWorkspace: Dispatch<SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
}

export function useDesktopSettingsActions({
  projectIdRef,
  mergeProjectSnapshot,
  setContextBudget,
  setWorkspace
}: DesktopSettingsActionsOptions) {
  const modelSwitchGenerationRef = useRef(0);

  const switchModel = useCallback(async (alias: string, thinking: ThinkingSelection): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    const generation = ++modelSwitchGenerationRef.current;
    const info = await window.biny.switchModel(projectId, alias, thinking);
    // 切换模型后上一轮会话的上下文预算是旧模型的，立即作废；新模型的实际用量
    // 会在下一轮 `context.updated` 中重新建立。
    setContextBudget(undefined);
    setWorkspace((current) => current?.project.id === projectId ? updateRuntimeInfo(current, info) : current);
    // 切模型可能刚创建运行时；完整快照只负责补齐 Runtime/会话投影，不应阻塞
    // 模型按钮的响应。旧请求的刷新不能覆盖后续更快完成的新切换。
    void window.biny.refreshProject(projectId)
      .then((snapshot) => {
        if (modelSwitchGenerationRef.current === generation) mergeProjectSnapshot(snapshot);
      })
      .catch(() => undefined);
  }, [mergeProjectSnapshot, projectIdRef, setContextBudget, setWorkspace]);

  const testModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput) => {
    return await window.biny.testModelConfiguration(requireProject(projectIdRef.current), configuration);
  }, [projectIdRef]);

  const fetchModelCatalog = useCallback(async (providerAlias: string) => {
    const fetchCatalog = window.biny.fetchModelCatalog;
    if (typeof fetchCatalog !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await fetchCatalog(requireProject(projectIdRef.current), providerAlias);
  }, [projectIdRef]);

  const fetchModelCatalogCandidate = useCallback(async (configuration: DesktopModelConfigurationInput) => {
    const fetchCandidate = window.biny.fetchModelCatalogCandidate;
    if (typeof fetchCandidate !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await fetchCandidate(requireProject(projectIdRef.current), configuration);
  }, [projectIdRef]);

  const startModelLogin = useCallback(async (provider: DesktopModelLoginProvider) => {
    const startLogin = window.biny.startModelLogin;
    if (typeof startLogin !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await startLogin(requireProject(projectIdRef.current), provider);
  }, [projectIdRef]);

  const cancelModelLogin = useCallback(async (
    provider: DesktopModelLoginProvider,
    authRequestId: string
  ): Promise<void> => {
    const projectId = projectIdRef.current;
    const cancelLogin = window.biny.cancelModelLogin;
    if (!projectId || typeof cancelLogin !== "function") return;
    await cancelLogin(projectId, provider, authRequestId);
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

  const loadMemoryOverview = useCallback(async (filter?: DesktopMemoryOriginFilter) => {
    const memoryOverview = window.biny.memoryOverview;
    if (typeof memoryOverview !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryOverview(requireProject(projectIdRef.current), filter);
  }, [projectIdRef]);

  const searchMemory = useCallback(async (filter: DesktopMemoryOriginFilter, query: string) => {
    return await window.biny.searchMemory(requireProject(projectIdRef.current), filter, query);
  }, [projectIdRef]);

  const addMemoryEntry = useCallback(async (input: DesktopMemoryEntryInput, expectedRevision: number) => {
    return await window.biny.addMemoryEntry(requireProject(projectIdRef.current), input, expectedRevision);
  }, [projectIdRef]);

  const updateMemoryEntry = useCallback(async (entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number) => {
    return await window.biny.updateMemoryEntry(requireProject(projectIdRef.current), entryId, patch, expectedRevision);
  }, [projectIdRef]);

  const deleteMemoryEntry = useCallback(async (entryId: string, expectedRevision: number) => {
    return await window.biny.deleteMemoryEntry(requireProject(projectIdRef.current), entryId, expectedRevision);
  }, [projectIdRef]);

  const clearMemory = useCallback(async (filter: DesktopMemoryOriginFilter, expectedRevision: number) => {
    return await window.biny.clearMemory(requireProject(projectIdRef.current), filter, expectedRevision);
  }, [projectIdRef]);

  const compactMemory = useCallback(async (filter: DesktopMemoryOriginFilter, expectedRevision: number, topic?: string) => {
    return await window.biny.compactMemory(requireProject(projectIdRef.current), filter, expectedRevision, topic);
  }, [projectIdRef]);

  const loadTelosOverview = useCallback(async () => {
    const load = window.biny.telosOverview;
    if (typeof load !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await load(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const saveTelos = useCallback(async (input: DesktopTelosDocumentInput, expectedRevision: number) => {
    const save = window.biny.saveTelos;
    if (typeof save !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await save(requireProject(projectIdRef.current), input, expectedRevision);
  }, [projectIdRef]);

  const reviewBehaviorPattern = useCallback(async (patternId: string, action: DesktopBehaviorPatternReviewAction, expectedRevision: number) => {
    const review = window.biny.reviewBehaviorPattern;
    if (typeof review !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await review(requireProject(projectIdRef.current), patternId, action, expectedRevision);
  }, [projectIdRef]);

  const resolveTelosDrift = useCallback(async (driftId: string, action: DesktopTelosDriftResolutionAction, expectedRevision: number) => {
    const resolve = window.biny.resolveTelosDrift;
    if (typeof resolve !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await resolve(requireProject(projectIdRef.current), driftId, action, expectedRevision);
  }, [projectIdRef]);

  const snoozeTelosDrift = useCallback(async (driftId: string, until: string, expectedRevision: number) => {
    const snooze = window.biny.snoozeTelosDrift;
    if (typeof snooze !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await snooze(requireProject(projectIdRef.current), driftId, until, expectedRevision);
  }, [projectIdRef]);

  const loadMemoryEmbeddingStatus = useCallback(async () => {
    const status = window.biny.memoryEmbeddingStatus;
    if (typeof status !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await status(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const downloadMemoryEmbeddingModel = useCallback(async (model: LocalEmbeddingModelId) => {
    const download = window.biny.downloadMemoryEmbeddingModel;
    if (typeof download !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await download(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const cancelMemoryEmbeddingDownload = useCallback(async (model: LocalEmbeddingModelId) => {
    const cancel = window.biny.cancelMemoryEmbeddingDownload;
    if (typeof cancel !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cancel(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const deleteMemoryEmbeddingModel = useCallback(async (model: LocalEmbeddingModelId) => {
    const remove = window.biny.deleteMemoryEmbeddingModel;
    if (typeof remove !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await remove(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const rebuildMemoryEmbeddingIndex = useCallback(async () => {
    const rebuild = window.biny.rebuildMemoryEmbeddingIndex;
    if (typeof rebuild !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await rebuild(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const cancelMemoryEmbeddingRebuild = useCallback(async () => {
    const cancel = window.biny.cancelMemoryEmbeddingRebuild;
    if (typeof cancel !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cancel(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  return {
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
    loadTelosOverview,
    openBrowser,
    rebuildMemoryEmbeddingIndex,
    resolveTelosDrift,
    reviewBehaviorPattern,
    saveTelos,
    searchMemory,
    snoozeTelosDrift,
    startModelLogin,
    switchModel,
    testModelConfiguration,
    updateMemoryEntry
  };
}

function requireProject(projectId: string | undefined): string {
  if (!projectId) throw new Error("请先打开一个项目。");
  return projectId;
}
