/**
 * 单一来源感知记忆库的设置页。
 *
 * 策略字段写入全局 SettingsDraft；条目 CRUD、整理与索引维护是明确的即时动作。列表筛选
 * 只改变视图，不再映射到物理目录。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import type { EmbeddingModelRef, LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type {
  DesktopEmbeddingModelDescriptor,
  DesktopAlmaImportScan,
  DesktopMemoryCompactionResult,
  DesktopMemoryEmbeddingCancellationResult,
  DesktopMemoryEmbeddingDeleteResult,
  DesktopMemoryEmbeddingStatus,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopMemoryKind,
  DesktopMemoryOriginFilter,
  DesktopMemoryOverview,
  DesktopMemorySearchMatch,
  DesktopIdentityDocumentKind,
  DesktopIdentityOverview,
  DesktopIdentityReviewResult,
  DesktopModelConfigurationInput,
  DesktopModelConnectionTestResult,
  DesktopBehaviorPatternReviewAction,
  DesktopTelosDocumentInput,
  DesktopTelosDriftResolutionAction,
  DesktopTelosOverview
} from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { ModelMenu } from "../composer/ModelMenu.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { MemoryEvolutionSection } from "./MemoryEvolutionSection.js";
import { IdentitySection } from "./IdentitySection.js";

const memoryKindOptions: Array<{ value: DesktopMemoryKind; label: string }> = [
  { value: "preference", label: "偏好" },
  { value: "working_style", label: "工作方式" },
  { value: "fact", label: "事实" },
  { value: "decision", label: "决策" },
  { value: "workflow", label: "流程" },
  { value: "gotcha", label: "踩坑" }
];

const memoryFilters: Array<{ value: DesktopMemoryOriginFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "current_workspace", label: "当前项目" },
  { value: "user", label: "通用偏好" },
  { value: "other_workspaces", label: "其他项目" }
];

// 记忆可能被其他 Host 或 TUI 修改，因此缓存只用于首屏展示，进入页面后仍会后台校验。
// 按项目和筛选条件隔离，避免切换项目时短暂显示另一项目的记忆。
const memoryOverviewCache = new Map<string, DesktopMemoryOverview>();
const maxMemoryOverviewCacheSize = 16;

function memoryOverviewCacheKey(projectId: string | undefined, filter: DesktopMemoryOriginFilter): string | undefined {
  return projectId === undefined ? undefined : `${projectId}:${filter}`;
}

function readMemoryOverviewCache(projectId: string | undefined, filter: DesktopMemoryOriginFilter): DesktopMemoryOverview | undefined {
  const key = memoryOverviewCacheKey(projectId, filter);
  if (key === undefined) return undefined;
  const cached = memoryOverviewCache.get(key);
  if (cached !== undefined) {
    memoryOverviewCache.delete(key);
    memoryOverviewCache.set(key, cached);
  }
  return cached;
}

function writeMemoryOverviewCache(projectId: string | undefined, filter: DesktopMemoryOriginFilter, overview: DesktopMemoryOverview): void {
  const key = memoryOverviewCacheKey(projectId, filter);
  if (key === undefined) return;
  memoryOverviewCache.delete(key);
  memoryOverviewCache.set(key, overview);
  while (memoryOverviewCache.size > maxMemoryOverviewCacheSize) {
    const oldest = memoryOverviewCache.keys().next().value;
    if (oldest === undefined) break;
    memoryOverviewCache.delete(oldest);
  }
}

interface SettingsMemoryProps {
  models: ModelChoice[];
  embeddingModels: DesktopEmbeddingModelDescriptor[];
  projectId?: string;
  hidden?: boolean;
  workspaceAvailable: boolean;
  sessionRunning: boolean;
  onLoad(filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview>;
  onSearch(filter: DesktopMemoryOriginFilter, query: string): Promise<DesktopMemorySearchMatch[]>;
  onAdd(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onUpdate(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onDeleteEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onClear(filter: DesktopMemoryOriginFilter, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onCompact(filter: DesktopMemoryOriginFilter, expectedRevision: number, topic?: string): Promise<DesktopMemoryCompactionResult>;
  onLoadIdentityOverview(): Promise<DesktopIdentityOverview>;
  onImportAlmaIdentity(root?: string): Promise<DesktopAlmaImportScan>;
  onSaveIdentityDocument(document: DesktopIdentityDocumentKind, content: string, expectedRevision: number, reason?: string): Promise<DesktopIdentityOverview>;
  onReviewIdentityProposal(proposalId: string, action: "accept" | "reject", expectedRevision: number): Promise<DesktopIdentityReviewResult>;
  onLoadTelosOverview(): Promise<DesktopTelosOverview>;
  onSaveTelos(input: DesktopTelosDocumentInput, expectedRevision: number): Promise<DesktopTelosOverview>;
  onReviewBehaviorPattern(patternId: string, action: DesktopBehaviorPatternReviewAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onResolveTelosDrift(driftId: string, action: DesktopTelosDriftResolutionAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onSnoozeTelosDrift(driftId: string, until: string, expectedRevision: number): Promise<DesktopTelosOverview>;
  onOpenChatDraft(input: string): void;
  onLoadEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onDeleteEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  onRebuildEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onNotify(message: string): void;
}

export function SettingsMemory({
  models,
  embeddingModels,
  projectId,
  hidden,
  workspaceAvailable,
  sessionRunning,
  onLoad,
  onSearch,
  onAdd,
  onUpdate,
  onDeleteEntry,
  onClear,
  onCompact,
  onLoadIdentityOverview,
  onImportAlmaIdentity,
  onSaveIdentityDocument,
  onReviewIdentityProposal,
  onLoadTelosOverview,
  onSaveTelos,
  onReviewBehaviorPattern,
  onResolveTelosDrift,
  onSnoozeTelosDrift,
  onOpenChatDraft,
  onLoadEmbeddingStatus,
  onDownloadEmbeddingModel,
  onCancelEmbeddingDownload,
  onDeleteEmbeddingModel,
  onRebuildEmbeddingIndex,
  onCancelEmbeddingRebuild,
  onTestModelConfiguration,
  onNotify
}: SettingsMemoryProps): React.JSX.Element {
  const { draft, setMemory, snapshot } = useSettingsDraft();
  const [filter, setFilter] = useState<DesktopMemoryOriginFilter>("current_workspace");
  const [storedOverview, setStoredOverview] = useState<DesktopMemoryOverview | undefined>(() => readMemoryOverviewCache(projectId, "current_workspace"));
  const [storedOverviewKey, setStoredOverviewKey] = useState<string | undefined>(() => memoryOverviewCacheKey(projectId, "current_workspace"));
  const [loadError, setLoadError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopMemorySearchMatch[]>();
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; entry: DesktopMemoryEntry }>();
  const [deleteTarget, setDeleteTarget] = useState<DesktopMemoryEntry>();
  const [clearOpen, setClearOpen] = useState(false);
  const [clearPhrase, setClearPhrase] = useState("");
  const [advancedModels, setAdvancedModels] = useState(false);
  const [compactReport, setCompactReport] = useState<string>();
  const [privacyModel, setPrivacyModel] = useState<DesktopEmbeddingModelDescriptor>();
  const [embeddingStatus, setEmbeddingStatus] = useState<DesktopMemoryEmbeddingStatus>();
  const [embeddingStatusError, setEmbeddingStatusError] = useState<string>();
  const [embeddingMenuOpen, setEmbeddingMenuOpen] = useState(false);
  const [embeddingQuery, setEmbeddingQuery] = useState("");
  const embeddingMenuRef = useRef<HTMLDivElement>(null);
  const memoryLoadRequestRef = useRef(0);

  const currentOverviewKey = memoryOverviewCacheKey(projectId, filter);
  const overview = storedOverviewKey === currentOverviewKey ? storedOverview : undefined;

  const applyOverview = useCallback((nextFilter: DesktopMemoryOriginFilter, next: DesktopMemoryOverview): void => {
    writeMemoryOverviewCache(projectId, nextFilter, next);
    setStoredOverview(next);
    setStoredOverviewKey(memoryOverviewCacheKey(projectId, nextFilter));
  }, [projectId]);

  const load = useCallback(async (nextFilter: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview> => {
    const requestId = memoryLoadRequestRef.current + 1;
    memoryLoadRequestRef.current = requestId;
    setRefreshing(true);
    try {
      const next = await onLoad(nextFilter);
      if (memoryLoadRequestRef.current === requestId && memoryOverviewCacheKey(projectId, nextFilter) === currentOverviewKey) {
        applyOverview(nextFilter, next);
        setLoadError(undefined);
      } else {
        writeMemoryOverviewCache(projectId, nextFilter, next);
      }
      return next;
    } finally {
      if (memoryLoadRequestRef.current === requestId) setRefreshing(false);
    }
  }, [applyOverview, currentOverviewKey, onLoad, projectId]);

  const refreshEmbeddingStatus = useCallback(async (): Promise<void> => {
    try {
      setEmbeddingStatus(await onLoadEmbeddingStatus());
      setEmbeddingStatusError(undefined);
    } catch (error) {
      setEmbeddingStatusError(errorMessage(error));
    }
  }, [onLoadEmbeddingStatus]);

  const refreshMemoryData = useCallback(async (nextFilter: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview> => {
    const [next] = await Promise.all([load(nextFilter), refreshEmbeddingStatus()]);
    return next;
  }, [load, refreshEmbeddingStatus]);

  useEffect(() => {
    let cancelled = false;
    onLoadEmbeddingStatus()
      .then((status) => {
        if (cancelled) return;
        setEmbeddingStatus(status);
        setEmbeddingStatusError(undefined);
      })
      .catch((error: unknown) => { if (!cancelled) setEmbeddingStatusError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [onLoadEmbeddingStatus, snapshot?.configRevision]);

  useEffect(() => {
    if (!embeddingMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !embeddingMenuRef.current?.contains(event.target)) setEmbeddingMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [embeddingMenuOpen]);

  useEffect(() => {
    if (embeddingStatus?.operation?.state !== "running") return;
    const poll = window.setInterval(() => {
      void onLoadEmbeddingStatus().then(setEmbeddingStatus).catch((error: unknown) => {
        setEmbeddingStatusError(errorMessage(error));
      });
    }, 500);
    return () => window.clearInterval(poll);
  }, [embeddingStatus?.operation?.state, onLoadEmbeddingStatus]);

  useEffect(() => {
    let cancelled = false;
    const cached = readMemoryOverviewCache(projectId, filter);
    setStoredOverview(cached);
    setStoredOverviewKey(currentOverviewKey);
    setLoadError(undefined);
    setSearchResults(undefined);
    setQuery("");
    if (!workspaceAvailable || projectId === undefined) return () => { cancelled = true; };
    load(filter)
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [currentOverviewKey, filter, load, projectId, workspaceAvailable]);




  const testModel = useCallback(async (model: ModelChoice): Promise<DesktopModelConnectionTestResult> => {
    try {
      return await onTestModelConfiguration(modelConfigurationForChoice(model));
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }, [onTestModelConfiguration]);

  if (!workspaceAvailable) return <MemoryPageState detail="记忆来源和当前项目筛选需要 workspace 上下文。请先返回应用并添加或选择一个项目。" title="请先选择项目" />;
  if (!draft) return <MemoryPageState title="正在加载记忆设置…" />;
  if (loadError && !overview) return <MemoryPageState detail={loadError} title="无法加载记忆库" />;
  if (!overview) return <MemoryPageState title="正在读取单一记忆库…" />;

  const policy = draft.memory;
  const effectiveMemoryModel = models.find((model) => model.alias === policy.memoryModel)
    ?? models.find((model) => model.alias === snapshot?.models.defaultModel);
  const visibleEmbeddingModels = mergeEmbeddingModels(embeddingModels, embeddingStatus?.models ?? []);
  const activeEmbedding = visibleEmbeddingModels.find((model) => sameEmbeddingRef(model.ref, policy.embeddingModel));
  const activeThresholds = activeEmbedding === undefined
    ? undefined
    : policy.similarityThresholds[activeEmbedding.fingerprint] ?? activeEmbedding.recommendedThresholds;
  const persistedEmbedding = snapshot?.memory.embeddingModel;
  const embeddingDraftChanged = !sameOptionalEmbeddingRef(policy.embeddingModel, persistedEmbedding);
  const embeddingOperation = embeddingStatus?.operation;
  const entriesById = new Map(overview.entries.map((entry) => [entry.id, entry] as const));
  const displayed = searchResults === undefined
    ? overview.entries.map(entryListItem)
    : searchResults.map((match) => ({ ...match, entry: entriesById.get(match.id) }));
  const visibleEntryCount = overview.entries.length;
  const clearEntryCount = filter === "all" ? overview.totalEntries : visibleEntryCount;
  const clearConfirmation = `清空 ${String(clearEntryCount)} 条记忆`;
  const immediateDisabled = sessionRunning || busyAction !== undefined;

  const changePolicy = (patch: Partial<typeof policy>): void => setMemory({ ...policy, ...patch });
  const telos = policy.telos ?? {
    enabled: false,
    autoObserve: false,
    driftDetection: false,
    proactivePrompts: false
  };
  const changeTelos = (patch: Partial<typeof telos>): void => changePolicy({ telos: { ...telos, ...patch } });
  const changeModel = (field: "memoryModel" | "rewriteModel" | "extractModel" | "consolidationModel", value: string): void => {
    changePolicy({ [field]: value || undefined });
  };
  const selectEmbedding = (descriptor: DesktopEmbeddingModelDescriptor): void => {
    setEmbeddingMenuOpen(false);
    setEmbeddingQuery("");
    if (descriptor.source === "provider" && !hasCloudEmbeddingConsent(policy.cloudEmbeddingConsents, descriptor)) {
      setPrivacyModel(descriptor);
      return;
    }
    applyEmbedding(descriptor);
  };
  const applyEmbedding = (descriptor: DesktopEmbeddingModelDescriptor): void => {
    setMemory({
      ...policy,
      embeddingModel: descriptor.ref,
      similarityThresholds: policy.similarityThresholds[descriptor.fingerprint] === undefined
        ? { ...policy.similarityThresholds, [descriptor.fingerprint]: descriptor.recommendedThresholds }
        : policy.similarityThresholds
    });
    setPrivacyModel(undefined);
  };
  const updateThreshold = (field: "currentWorkspace" | "crossWorkspace", value: number): void => {
    if (!activeEmbedding || !activeThresholds) return;
    const currentWorkspace = field === "currentWorkspace" ? value : activeThresholds.currentWorkspace;
    const crossWorkspace = field === "crossWorkspace" ? value : activeThresholds.crossWorkspace;
    changePolicy({
      similarityThresholds: {
        ...policy.similarityThresholds,
        [activeEmbedding.fingerprint]: {
          currentWorkspace: Math.min(currentWorkspace, crossWorkspace),
          crossWorkspace: Math.max(currentWorkspace, crossWorkspace)
        }
      }
    });
  };

  const runMutation = async (
    action: string,
    operation: () => Promise<DesktopMemoryOverview>,
    success: string
  ): Promise<boolean> => {
    if (immediateDisabled) return false;
    setBusyAction(action);
    try {
      const next = await operation();
      applyOverview(filter, next);
      setSearchResults(undefined);
      setQuery("");
      onNotify(success);
      return true;
    } catch (error) {
      onNotify(errorMessage(error));
      await refreshMemoryData(filter).catch(() => undefined);
      return false;
    } finally {
      setBusyAction(undefined);
    }
  };

  const search = async (): Promise<void> => {
    const value = query.trim();
    if (!value) {
      setSearchResults(undefined);
      return;
    }
    if (busyAction) return;
    setBusyAction("search");
    try {
      setSearchResults(await onSearch(filter, value));
    } catch (error) {
      onNotify(errorMessage(error));
    } finally {
      setBusyAction(undefined);
    }
  };

  const compact = async (): Promise<void> => {
    setCompactReport(undefined);
    if (immediateDisabled) return;
    setBusyAction("compact");
    try {
      const result = await onCompact(filter, overview.revision);
      setCompactReport(result.error
        ? `整理部分完成：${result.error}`
        : result.after < result.before
          ? `${String(result.before)} 条 → ${String(result.after)} 条`
          : `${String(result.before)} 条，没有可安全合并的同源同话题记忆`);
      await refreshMemoryData(filter);
      onNotify(result.error ? "记忆整理存在失败分组" : "记忆整理完成");
    } catch (error) {
      onNotify(errorMessage(error));
      await refreshMemoryData(filter).catch(() => undefined);
    } finally {
      setBusyAction(undefined);
    }
  };


  const runEmbeddingOperation = async (
    action: string,
    operation: () => Promise<DesktopMemoryEmbeddingStatus | DesktopMemoryEmbeddingDeleteResult>,
    success: (result: DesktopMemoryEmbeddingStatus | DesktopMemoryEmbeddingDeleteResult) => string
  ): Promise<void> => {
    if (immediateDisabled) return;
    setBusyAction(action);
    setEmbeddingStatusError(undefined);
    const poll = window.setInterval(() => {
      void onLoadEmbeddingStatus().then(setEmbeddingStatus).catch(() => undefined);
    }, 500);
    try {
      const result = await operation();
      const status = "status" in result ? result.status : result;
      setEmbeddingStatus(status);
      onNotify(success(result));
    } catch (error) {
      const status = await onLoadEmbeddingStatus().catch(() => undefined);
      if (status) setEmbeddingStatus(status);
      if (status?.operation?.state !== "cancelled") onNotify(errorMessage(error));
    } finally {
      window.clearInterval(poll);
      setBusyAction(undefined);
    }
  };

  const cancelEmbeddingOperation = async (
    operation: () => Promise<DesktopMemoryEmbeddingCancellationResult>,
    success: string
  ): Promise<void> => {
    try {
      const result = await operation();
      setEmbeddingStatus(result.status);
      onNotify(result.cancelled ? success : "当前没有可取消的 Embedding 操作");
    } catch (error) {
      onNotify(errorMessage(error));
    }
  };

  return (
    <div className="settings-sections memory-settings-v3" hidden={hidden}>
      <IdentitySection
        active={!hidden}
        hidden={hidden}
        onImport={onImportAlmaIdentity}
        onLoad={onLoadIdentityOverview}
        onNotify={onNotify}
        onReview={onReviewIdentityProposal}
        onSave={onSaveIdentityDocument}
        projectId={projectId}
      />
      <section id="memory-overview" tabIndex={-1}>
        <h3>记忆功能</h3>
        <SettingsCheckbox checked={policy.enabled} detail="关闭后保留已有记忆，但暂停检索和自动生成" label="启用记忆" onChange={(enabled) => changePolicy({ enabled })} />
      </section>

<section id="memory-retrieval" tabIndex={-1}>
        <h3>记忆检索</h3>
        <SettingsCheckbox checked={policy.useMemories} detail="每个新回合注入记忆概览并自动语义召回相关条目；回答末尾会标注引用以便统计使用情况" disabled={!policy.enabled} label="启用记忆召回" onChange={(useMemories) => changePolicy({ useMemories })} />
        <SettingsCheckbox checked={policy.queryRewrite} detail="用记忆处理模型生成更适合检索的查询；3 秒失败后使用原问题" disabled={!policy.enabled || !policy.useMemories} label="查询重写" onChange={(queryRewrite) => changePolicy({ queryRewrite })} />
        <label className="memory-slider-field">
          <span><strong>最大召回数：{policy.maxRecalled}</strong><small>去重后仍受 12,000 字符整条注入预算限制</small></span>
          <input aria-label="最大召回记忆数" max={20} min={1} onChange={(event) => changePolicy({ maxRecalled: Number(event.target.value) })} type="range" value={policy.maxRecalled} />
        </label>
        {activeEmbedding && activeThresholds ? (
          <div className="memory-threshold-grid">
            <ThresholdControl label="当前项目阈值" onChange={(value) => updateThreshold("currentWorkspace", value)} value={activeThresholds.currentWorkspace} />
            <ThresholdControl label="跨项目阈值" onChange={(value) => updateThreshold("crossWorkspace", value)} value={activeThresholds.crossWorkspace} />
            <button className="ghost-button" onClick={() => changePolicy({ similarityThresholds: { ...policy.similarityThresholds, [activeEmbedding.fingerprint]: activeEmbedding.recommendedThresholds } })} type="button">恢复该模型推荐值</button>
          </div>
        ) : <p className="memory-empty-hint">未选择可用 Embedding 时使用词法检索，自动召回不会注入其他项目内容。</p>}
      </section>

      <section id="memory-features" tabIndex={-1}>
        <h3>记忆生成</h3>
        <SettingsCheckbox checked={policy.generateMemories} detail="从已完成的回合中提取可复用信息" disabled={!policy.enabled} label="自动生成记忆" onChange={(generateMemories) => changePolicy({ generateMemories })} />
        <div className="memory-mode-nested">
          <SettingsCheckbox checked={policy.excludeExternalContext} detail="网页、附件、MCP、插件和子代理内容不自动沉淀" disabled={!policy.enabled} label="排除外部上下文" onChange={(excludeExternalContext) => changePolicy({ excludeExternalContext })} />
        </div>
        <div className="memory-mode-nested">
          <SettingsCheckbox checked={policy.generateMemories} detail="自动从对话中提取并存储可复用事实（随自动生成一同开关）" disabled={!policy.enabled || !policy.generateMemories} label="自动总结对话" onChange={(value) => changePolicy({ generateMemories: value })} />
        </div>
      </section>

      <section id="memory-sleep" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆睡眠</h3><p>每天按计划整理记忆库，合并重复与过期条目。</p></div>
          <span className="settings-scope-badge">即将推出</span>
        </div>
        <SettingsCheckbox checked={false} detail="定时整理尚在规划中；当前整理通过「立即整理」手动触发" disabled label="启用每日记忆整理" onChange={() => undefined} />
        <div className="memory-mode-nested">
          <SettingsCheckbox checked={false} detail="整理触发时间、保留策略与快照导出将随每日整理一同提供" disabled label="整理触发时间与保留策略" onChange={() => undefined} />
        </div>
      </section>

      <section id="memory-strategy" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆进化</h3><p>这里管理长期目标、原则和行为模式；行为模式始终标记为推断，不能自动改写你的长期策略。</p></div>
        </div>
        <SettingsCheckbox checked={telos.enabled} detail="允许在对话中使用已确认的目标与原则指导；不影响事实记忆开关" label="使用长期策略" onChange={(enabled) => changeTelos({ enabled })} />
        <div className="memory-mode-nested">
          <SettingsCheckbox checked={telos.autoObserve} detail="仅从成功完成且排除外部上下文的回合生成脱敏观察；默认不追溯历史" disabled={!telos.enabled} label="自动观察行为模式" onChange={(autoObserve) => changeTelos({ autoObserve })} />
          <SettingsCheckbox checked={telos.driftDetection} detail="行为模式确认后，满足 3 次观察、7 天跨度和置信度阈值才生成偏差提案" disabled={!telos.enabled} label="检测策略偏差" onChange={(driftDetection) => changeTelos({ driftDetection })} />
          <SettingsCheckbox checked={telos.proactivePrompts} detail="只在 Runtime idle 且任务结束后显示一条待处理偏差；任务运行中不会打断" disabled={!telos.enabled || !telos.driftDetection} label="主动提醒策略偏差" onChange={(proactivePrompts) => changeTelos({ proactivePrompts })} />
        </div>
        <MemoryEvolutionSection
          active={!hidden}
          disabled={sessionRunning}
          onLoad={onLoadTelosOverview}
          onNotify={onNotify}
          onOpenChatDraft={onOpenChatDraft}
          onResolveDrift={onResolveTelosDrift}
          onReviewPattern={onReviewBehaviorPattern}
          onSave={onSaveTelos}
          onSnoozeDrift={onSnoozeTelosDrift}
          projectId={projectId}
        />
      </section>

      <section id="memory-models" tabIndex={-1}>
        <div className="section-heading-row"><div><h3>记忆处理模型</h3><p>默认由一个主模型处理查询重写、提取和整理。</p></div></div>
        <ModelAliasField fallbackModel={effectiveMemoryModel} label="主模型" models={models} onChange={(value) => changeModel("memoryModel", value)} onTest={testModel} sessionRunning={sessionRunning} value={policy.memoryModel} />
        <button aria-expanded={advancedModels} className="ghost-button memory-advanced-toggle" onClick={() => setAdvancedModels((value) => !value)} type="button">{advancedModels ? "收起高级覆盖" : "高级覆盖"}</button>
        {advancedModels ? (
          <div className="memory-model-grid">
            <ModelAliasField fallbackModel={effectiveMemoryModel} label="查询重写模型" models={models} onChange={(value) => changeModel("rewriteModel", value)} onTest={testModel} sessionRunning={sessionRunning} value={policy.rewriteModel} />
            <ModelAliasField fallbackModel={effectiveMemoryModel} label="记忆提取模型" models={models} onChange={(value) => changeModel("extractModel", value)} onTest={testModel} sessionRunning={sessionRunning} value={policy.extractModel} />
            <ModelAliasField fallbackModel={effectiveMemoryModel} label="记忆整理模型" models={models} onChange={(value) => changeModel("consolidationModel", value)} onTest={testModel} sessionRunning={sessionRunning} value={policy.consolidationModel} />
          </div>
        ) : null}
      </section>


      <section id="memory-embedding" tabIndex={-1}>
        <div className="section-heading-row"><div><h3>Embedding 模型</h3><p>Embedding 与聊天模型分开；模型指纹变化后必须重建派生索引。</p></div><span className="settings-scope-badge">派生数据</span></div>
        <EmbeddingSelector
          activeModel={embeddingStatus?.activeModel}
          busy={immediateDisabled}
          cancelDisabled={sessionRunning}
          menuOpen={embeddingMenuOpen}
          models={visibleEmbeddingModels}
          onCancelDownload={async (model) => { await cancelEmbeddingOperation(async () => await onCancelEmbeddingDownload(model), "已请求取消下载"); }}
          onDelete={async (model) => { await runEmbeddingOperation(`delete-model:${model}`, async () => await onDeleteEmbeddingModel(model), (result) => "status" in result ? `已删除模型缓存，释放 ${formatBytes(result.bytesFreed)}` : "模型缓存已删除"); }}
          onDownload={async (model) => { await runEmbeddingOperation(`download:${model}`, async () => await onDownloadEmbeddingModel(model), () => "本地 Embedding 模型已下载"); }}
          onOpen={() => setEmbeddingMenuOpen((value) => !value)}
          onQueryChange={setEmbeddingQuery}
          query={embeddingQuery}
          menuRef={embeddingMenuRef}
          onSelect={selectEmbedding}
          operation={embeddingOperation}
          selected={policy.embeddingModel}
        />
        {policy.embeddingModel && !activeEmbedding ? <p className="settings-effective-hint is-blocked">当前不可用：{embeddingRefLabel(policy.embeddingModel)}。设置不会被自动替换。</p> : null}
        {embeddingStatusError ? <p className="settings-effective-hint is-blocked">无法读取 Embedding 状态：{embeddingStatusError}</p> : null}
        {activeEmbedding ? (
          <div className="memory-index-summary">
            <span><strong>{activeEmbedding.source === "local" ? (activeEmbedding.installed ? "本地模型已下载" : "本地模型需要下载") : "云端 Embedding"}</strong><small>{activeEmbedding.endpoint ? `Endpoint：${activeEmbedding.endpoint}` : activeEmbedding.description}</small></span>
            <span><strong>索引状态</strong><small>{embeddingIndexLabel(embeddingStatus, embeddingDraftChanged)}</small></span>
          </div>
        ) : null}
        <div className="setting-row memory-index-actions">
          <span>
            <strong>向量索引</strong>
            <small>{embeddingStatus?.degradedReason ?? "完整重建使用新 generation，完成后才会原子切换。"}</small>
          </span>
          {embeddingOperation?.kind === "rebuild" && embeddingOperation.state === "running" ? (
            <button className="ghost-button" disabled={sessionRunning} onClick={() => { void cancelEmbeddingOperation(onCancelEmbeddingRebuild, "已请求取消索引重建"); }} type="button">取消重建</button>
          ) : (
            <button className="ghost-button" disabled={immediateDisabled || embeddingDraftChanged || !embeddingStatus?.activeModel} onClick={() => { void runEmbeddingOperation("rebuild", onRebuildEmbeddingIndex, () => "记忆向量索引已重建"); }} type="button">立即重建</button>
          )}
        </div>
        {embeddingDraftChanged ? <p className="settings-effective-hint is-blocked">Embedding 选择尚未保存。请先保存全部，提交成功后 Biny 会后台重建；也可随后手动重建。</p> : null}
        <p className="memory-empty-hint">下载、删除和重建属于立即动作；任务运行期间不可执行。云端会上传全部待索引记忆，并在每次语义检索时上传查询。</p>
      </section>

      <section className="memory-statistics-section" id="memory-statistics" tabIndex={-1}>
        <h3>统计</h3>
        <div className="memory-stat-grid">
          <MemoryStat label="记忆总数" value={overview.memoryStats.total} />
          <MemoryStat label="自动生成" value={overview.memoryStats.autoGenerated} />
          <MemoryStat label="手动添加" value={overview.memoryStats.manualAdded} />
        </div>
      </section>

      <section className="memory-scope-section" id="memory-library" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆库</h3><p>按来源查看、搜索和维护已保存的记忆。</p></div>
          <span aria-live="polite">{refreshing ? "后台同步中…" : null}</span>
          <button className="ghost-button settings-inline-action" disabled={immediateDisabled} onClick={() => { void refreshMemoryData(filter).catch((error: unknown) => setLoadError(errorMessage(error))); }} type="button"><Icon name="refresh" size={13} /> 刷新</button>
        </div>
        <div className="memory-library-toolbar">
          <div aria-label="记忆来源" className="settings-segmented memory-filter-tabs" role="tablist">
            {memoryFilters.map((option) => <button aria-selected={filter === option.value} className={filter === option.value ? "is-selected" : ""} disabled={busyAction !== undefined} key={option.value} onClick={() => setFilter(option.value)} role="tab" type="button">{option.label}</button>)}
          </div>
          <button className="settings-inline-action" disabled={immediateDisabled} onClick={() => setEditor({ mode: "add" })} type="button"><Icon name="add" size={14} /> 添加记忆</button>
        </div>
        <p className="memory-empty-hint">最近维护：{overview.maintenance.lastFinishedAt ? formatMemoryDate(overview.maintenance.lastFinishedAt) : overview.maintenance.lastScanAt ? formatMemoryDate(overview.maintenance.lastScanAt) : "尚未执行"} · 最近重建：{embeddingStatus?.index.active?.completedAt ? formatMemoryDate(embeddingStatus.index.active.completedAt) : "尚未完成"}</p>
        <div className="setting-row">
          <span><strong>整理当前来源</strong><small>只在相同来源、workspace 与 topic 内合并；即时保存</small></span>
          <button className="ghost-button" disabled={immediateDisabled || visibleEntryCount < 2} onClick={() => { void compact(); }} type="button">{busyAction === "compact" ? "整理中…" : "立即整理"}</button>
        </div>
        {compactReport ? <pre className="settings-memory-report">{compactReport}</pre> : null}
      </section>

      <section id="memory-search" tabIndex={-1}>
        <div className="section-heading-row"><div><h3>搜索记忆</h3><p>支持语义、关键词和路径搜索。</p></div></div>
        <div className="memory-search-row">
          <input aria-label="搜索记忆" className="settings-inline-input" onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSearchResults(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="按语义、关键词或路径搜索…" type="search" value={query} />
          {searchResults !== undefined ? <button className="ghost-button" onClick={() => { setQuery(""); setSearchResults(undefined); }} type="button">清除</button> : null}
          <button className="ghost-button" disabled={busyAction !== undefined || !query.trim()} onClick={() => { void search(); }} type="button">{busyAction === "search" ? "搜索中…" : "搜索"}</button>
        </div>
        <div className="section-heading-row memory-list-heading">
          <span>{searchResults === undefined ? `${String(visibleEntryCount)} 条记忆` : `${String(searchResults.length)} 个结果`}</span>
          <button className="ghost-button is-danger" disabled={immediateDisabled || clearEntryCount === 0} onClick={() => { setClearPhrase(""); setClearOpen(true); }} type="button">清空当前来源</button>
        </div>
        {displayed.length ? <div className="memory-entry-list">{displayed.map((item) => (
          <article className="memory-entry" key={item.id}>
            <div className="memory-entry-head">
              <span className="memory-origin-tag">{memoryOriginLabel(item.origin, overview)}</span>
              <span className="memory-topic-tag">{item.topic}</span>
              <span className="memory-kind-tag">{memoryKindLabel(item.kind)}</span>
              <span className="memory-importance">重要度 {item.importance}/5</span>
              <small>{formatMemoryDate(item.updatedAt)} · 召回 {item.recallCount} 次</small>
              <span className="settings-inline-actions">
                {item.entry ? <button aria-label={`编辑记忆：${item.entry.title}`} className="icon-button" disabled={immediateDisabled} onClick={() => setEditor({ mode: "edit", entry: item.entry! })} type="button"><Icon name="edit" size={13} /></button> : null}
                {item.entry ? <button aria-label={`删除记忆：${item.entry.title}`} className="icon-button memory-entry-delete" disabled={immediateDisabled} onClick={() => setDeleteTarget(item.entry)} type="button"><Icon name="trash" size={13} /></button> : null}
              </span>
            </div>
            <strong>{item.entry?.title ?? item.excerpt.slice(0, 120)}</strong>
            <p>{item.entry?.summary ?? item.excerpt}</p>
            <small className="memory-provenance">{memoryLineageLabel(item.lineage)}{item.lastRecalledAt ? ` · 最近召回 ${formatMemoryDate(item.lastRecalledAt)}` : ""}</small>
          </article>
        ))}</div> : <p className="memory-empty-hint">{searchResults === undefined ? "当前来源还没有记忆。" : "没有匹配的记忆。"}</p>}
      </section>

      {sessionRunning ? <p className="settings-effective-hint is-blocked">当前任务运行中：可以编辑记忆策略草稿；条目、整理、下载和索引动作将在任务结束后可用。</p> : <p className="settings-effective-hint">策略通过底部“保存”提交；点击“取消”时会确认未保存草稿。条目与维护动作会立即保存。</p>}

      {editor ? (
        <SettingsDetailLayer onClose={() => setEditor(undefined)}>
          <MemoryEntryEditor
            entry={editor.mode === "edit" ? editor.entry : undefined}
            onCancel={() => setEditor(undefined)}
            onSubmit={async (value) => {
              const ok = editor.mode === "add"
                ? await runMutation("add", async () => await onAdd(value, overview.revision), "记忆已添加")
                : await runMutation("edit", async () => await onUpdate(editor.entry.id, patchFromInput(value), overview.revision), "记忆已更新");
              if (ok) setEditor(undefined);
            }}
            saving={busyAction === "add" || busyAction === "edit"}
          />
        </SettingsDetailLayer>
      ) : null}

      {deleteTarget ? (
        <SettingsDetailLayer onClose={() => setDeleteTarget(undefined)}>
          <section aria-labelledby="memory-delete-title" className="settings-confirm-panel" role="dialog">
            <h3 id="memory-delete-title">删除这条记忆？</h3><p>“{deleteTarget.title}”会立即从 Markdown 记忆库删除。</p>
            <div className="settings-confirm-actions"><button className="ghost-button" onClick={() => setDeleteTarget(undefined)} type="button">取消</button><button className="ghost-button is-danger" disabled={busyAction === "delete"} onClick={() => { void runMutation("delete", async () => await onDeleteEntry(deleteTarget.id, overview.revision), "记忆已删除").then((ok) => { if (ok) setDeleteTarget(undefined); }); }} type="button">删除</button></div>
          </section>
        </SettingsDetailLayer>
      ) : null}

      {clearOpen ? (
        <SettingsDetailLayer onClose={() => setClearOpen(false)}>
          <section aria-labelledby="memory-clear-title" className="settings-confirm-panel memory-clear-panel" role="dialog">
            <h3 id="memory-clear-title">清空当前来源的 {clearEntryCount} 条记忆</h3>
            <p>此操作会立即删除当前筛选范围内的 Markdown 条目。请输入 <strong>{clearConfirmation}</strong> 确认。</p>
            <input aria-label="清空确认短语" data-settings-detail-autofocus onChange={(event) => setClearPhrase(event.target.value)} value={clearPhrase} />
            <div className="settings-confirm-actions"><button className="ghost-button" onClick={() => setClearOpen(false)} type="button">取消</button><button className="ghost-button is-danger" disabled={clearPhrase !== clearConfirmation || busyAction === "clear"} onClick={() => { void runMutation("clear", async () => await onClear(filter, overview.revision), `已清空 ${String(clearEntryCount)} 条记忆`).then((ok) => { if (ok) setClearOpen(false); }); }} type="button">永久清空</button></div>
          </section>
        </SettingsDetailLayer>
      ) : null}

      {privacyModel ? (
        <SettingsDetailLayer onClose={() => setPrivacyModel(undefined)}>
          <section aria-labelledby="memory-privacy-title" className="settings-confirm-panel" role="dialog">
            <h3 id="memory-privacy-title">确认使用云端 Embedding</h3>
            <p>Biny 会向 <strong>{privacyModel.endpoint ?? privacyModel.displayName}</strong> 上传当前记忆库的 {overview.totalEntries} 条记忆内容用于建立索引，并在语义检索时上传查询。确认只针对这个 provider endpoint；同一 endpoint 下的其他 Embedding 模型会复用这次确认。</p>
            <div className="settings-confirm-actions"><button className="ghost-button" onClick={() => setPrivacyModel(undefined)} type="button">取消</button><button data-settings-detail-autofocus onClick={() => {
              setMemory({
                ...policy,
                cloudEmbeddingConsents: {
                  ...policy.cloudEmbeddingConsents,
                  [requirePrivacyEndpointHash(privacyModel)]: {
                    endpointHash: requirePrivacyEndpointHash(privacyModel),
                    confirmedAt: new Date().toISOString()
                  }
                },
                embeddingModel: privacyModel.ref,
                similarityThresholds: policy.similarityThresholds[privacyModel.fingerprint] === undefined
                  ? { ...policy.similarityThresholds, [privacyModel.fingerprint]: privacyModel.recommendedThresholds }
                  : policy.similarityThresholds
              });
              setPrivacyModel(undefined);
            }} type="button">确认并加入草稿</button></div>
          </section>
        </SettingsDetailLayer>
      ) : null}

    </div>
  );
}

function ThresholdControl({ label, onChange, value }: { label: string; onChange(value: number): void; value: number }): React.JSX.Element {
  return <label className="memory-threshold-field"><span><strong>{label}</strong><em>{Math.round(value * 100)}%</em></span><input aria-label={label} max={100} min={0} onChange={(event) => onChange(Number(event.target.value) / 100)} type="range" value={Math.round(value * 100)} /></label>;
}

function EmbeddingSelector({
  activeModel,
  busy,
  cancelDisabled,
  menuOpen,
  menuRef,
  models,
  onCancelDownload,
  onDelete,
  onDownload,
  onOpen,
  onQueryChange,
  onSelect,
  operation,
  query,
  selected
}: {
  activeModel?: EmbeddingModelRef;
  busy: boolean;
  cancelDisabled: boolean;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  models: DesktopEmbeddingModelDescriptor[];
  onCancelDownload(model: LocalEmbeddingModelId): Promise<void>;
  onDelete(model: LocalEmbeddingModelId): Promise<void>;
  onDownload(model: LocalEmbeddingModelId): Promise<void>;
  onOpen(): void;
  onQueryChange(value: string): void;
  onSelect(model: DesktopEmbeddingModelDescriptor): void;
  operation?: DesktopMemoryEmbeddingStatus["operation"];
  query: string;
  selected?: EmbeddingModelRef;
}): React.JSX.Element {
  const groups = [
    { source: "local" as const, label: "本地模型" },
    { source: "provider" as const, label: "云端模型" }
  ];
  const selectedModel = models.find((model) => sameEmbeddingRef(model.ref, selected));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (
    <div className="memory-embedding-select" ref={menuRef}>
      <button aria-expanded={menuOpen} className="memory-embedding-trigger" onClick={onOpen} type="button">
        <span>{selectedModel?.displayName ?? (selected ? embeddingRefLabel(selected) : "选择 Embedding 模型")}</span>
        <small>{selectedModel ? selectedModel.source === "local" ? selectedModel.installed ? "已下载" : "需要下载" : "云端" : ""}</small>
        <Icon name="chevron" size={14} />
      </button>
      {menuOpen ? (
        <div className="memory-embedding-menu" role="dialog">
          <label className="memory-embedding-search">
            <Icon name="search" size={14} />
            <input autoFocus onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索嵌入模型…" type="search" value={query} />
          </label>
          {groups.map((group) => {
            const candidates = models.filter((model) => model.source === group.source && (!normalizedQuery || `${model.displayName} ${model.description ?? ""} ${model.endpoint ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)));
            if (!candidates.length) return null;
            return (
              <div className="memory-embedding-group" key={group.source}>
                <strong>{group.label}</strong>
                {candidates.map((model) => {
                  const selectedItem = sameEmbeddingRef(model.ref, selected);
                  const active = sameEmbeddingRef(model.ref, activeModel);
                  const installed = model.source !== "local" || model.installed === true;
                  const localModel = model.ref.kind === "local" ? model.ref.model : undefined;
                  const downloading = localModel !== undefined && operation?.kind === "download" && operation.state === "running" && operation.model === localModel;
                  return (
                    <div className={`memory-embedding-option${selectedItem ? " is-selected" : ""}`} key={model.fingerprint}>
                      <button disabled={!installed || model.available === false} onClick={() => onSelect(model)} role="radio" aria-checked={selectedItem} type="button">
                        <span><strong>{model.displayName}</strong><small>{model.description}{model.endpoint ? ` · ${model.endpoint}` : ""}</small></span>
                      </button>
                      <span className="memory-embedding-option-action">
                        {localModel === undefined ? <em>{model.available === false ? "当前不可用" : "云端"}</em>
                          : downloading ? <button disabled={cancelDisabled} onClick={() => { void onCancelDownload(localModel); }} type="button">取消</button>
                            : !installed ? <button disabled={busy} onClick={() => { void onDownload(localModel); }} type="button">{formatModelSize(model.modelSizeBytes)}</button>
                              : active ? <em>当前活动</em>
                                : <button aria-label={`删除 ${model.displayName} 缓存`} disabled={busy} onClick={() => { void onDelete(localModel); }} title="删除缓存" type="button"><Icon name="trash" size={13} /></button>}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!models.some((model) => !normalizedQuery || `${model.displayName} ${model.description ?? ""} ${model.endpoint ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)) ? <p className="memory-empty-hint">没有匹配的模型。</p> : null}
        </div>
      ) : null}

    </div>
  );
}

function sameEmbeddingRef(left: EmbeddingModelRef, right?: EmbeddingModelRef): boolean {
  return right !== undefined && (left.kind === "local"
    ? right.kind === "local" && left.model === right.model
    : right.kind === "provider" && left.provider === right.provider && left.model === right.model);
}

function sameOptionalEmbeddingRef(left?: EmbeddingModelRef, right?: EmbeddingModelRef): boolean {
  if (!left || !right) return left === right;
  return sameEmbeddingRef(left, right);
}

function mergeEmbeddingModels(
  configured: DesktopEmbeddingModelDescriptor[],
  runtime: DesktopEmbeddingModelDescriptor[]
): DesktopEmbeddingModelDescriptor[] {
  const merged = new Map<string, DesktopEmbeddingModelDescriptor>();
  for (const descriptor of [...configured, ...runtime]) {
    const key = descriptor.ref.kind === "local"
      ? `local:${descriptor.ref.model}`
      : `provider:${descriptor.ref.provider}:${descriptor.ref.model}`;
    merged.set(key, descriptor);
  }
  return [...merged.values()];
}

function embeddingEndpointHash(descriptor: DesktopEmbeddingModelDescriptor): string {
  return descriptor.privacyEndpointHash ?? "";
}

function requirePrivacyEndpointHash(descriptor: DesktopEmbeddingModelDescriptor): string {
  if (!descriptor.privacyEndpointHash) throw new Error("云端 Embedding endpoint 身份不可用，请刷新模型目录后重试。");
  return descriptor.privacyEndpointHash;
}

function hasCloudEmbeddingConsent(
  consents: Record<string, { endpointHash: string; confirmedAt: string }>,
  descriptor: DesktopEmbeddingModelDescriptor
): boolean {
  const endpointHash = embeddingEndpointHash(descriptor);
  return Boolean(endpointHash) && Object.values(consents).some((consent) => consent.endpointHash === endpointHash);
}

function embeddingIndexLabel(status: DesktopMemoryEmbeddingStatus | undefined, draftChanged: boolean): string {
  if (!status) return "正在读取索引状态…";
  if (draftChanged) return "草稿模型与活动索引不同；保存前不会切换。";
  const operation = status.operation;
  if (operation?.kind === "rebuild" && operation.state === "running") {
    return `正在重建 ${String(operation.processedEntries)} / ${String(operation.totalEntries)} 条`;
  }
  if (!status.index.active) return `未建立索引；${String(status.pendingEntries)} 条待处理`;
  return `${String(status.indexedEntries)} / ${String(status.totalEntries)} 条已索引，${String(status.pendingEntries)} 条待处理`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatModelSize(value?: number): string {
  return value === undefined ? "需下载" : `约 ${Math.round(value / 1024 / 1024)} MB`;
}

function embeddingRefLabel(ref: EmbeddingModelRef): string {
  return ref.kind === "local" ? ref.model : `${ref.provider}/${ref.model}`;
}

function MemoryPageState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</section></div>;
}


function ModelAliasField({ fallbackModel, label, models, onChange, onTest, sessionRunning, value }: {
  fallbackModel?: ModelChoice;
  label: string;
  models: ModelChoice[];
  onChange(value: string): void;
  onTest(model: ModelChoice): Promise<DesktopModelConnectionTestResult>;
  sessionRunning: boolean;
  value?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  const anchorRef = useRef<HTMLDivElement>(null);
  const unavailable = value !== undefined && !models.some((model) => model.alias === value);
  const selected = models.find((model) => model.alias === value);
  const testTarget = unavailable ? undefined : selected ?? fallbackModel;
  const triggerModel = testTarget;
  const catalog = triggerModel ? catalogForConnection({ provider: triggerModel.provider, providerType: triggerModel.providerType }, triggerModel.baseUrl) : undefined;
  const providerLabel = triggerModel ? modelProviderLabel(triggerModel) : undefined;

  useEffect(() => {
    setTestResult(undefined);
  }, [fallbackModel?.alias, value]);

  const runTest = async (): Promise<void> => {
    if (!testTarget || sessionRunning || testing) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      setTestResult(await onTest(testTarget));
    } catch (error) {
      setTestResult({ ok: false, message: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="memory-select-field">
      <span>{label}</span>
      <div className="memory-model-control">
        <div className="memory-model-picker" ref={anchorRef}>
          <button aria-expanded={open} aria-haspopup="menu" className="memory-model-trigger" onClick={() => setOpen((current) => !current)} type="button">
            <span className="model-trigger-brand">{triggerModel ? <ProviderBrandGlyph type={catalog?.iconTone ?? triggerModel.providerType} /> : <Icon name="brain" size={14} />}</span>
            <span className="memory-model-trigger-copy">
              <strong>{unavailable ? `当前不可用：${value}` : triggerModel?.displayName ?? "跟随主模型或当前聊天"}</strong>
              {!unavailable && triggerModel && !selected ? <small>（自动）</small> : null}
              {!unavailable && providerLabel ? <em>{providerLabel}</em> : null}
            </span>
            <Icon name="chevron" size={12} />
          </button>
          <ModelMenu
            anchorRef={anchorRef}
            currentAlias={unavailable ? undefined : value}
            models={models}
            onChange={(alias) => {
              setOpen(false);
              onChange(alias);
            }}
            onClose={() => setOpen(false)}
            open={open}
            unsetLabel="跟随主模型或当前聊天"
          />
        </div>
        <button
          aria-label={`测试${label}`}
          aria-busy={testing}
          className="memory-model-test-button"
          disabled={!testTarget || sessionRunning || testing}
          onClick={() => { void runTest(); }}
          title={sessionRunning ? "当前任务运行中" : `测试${label}`}
          type="button"
        >
          <Icon name="flask" size={16} />
        </button>
      </div>
      {testResult ? <p aria-live="polite" className={`memory-model-test-result${testResult.ok ? " is-success" : " is-error"}`} role="status">{testResult.message}</p> : null}
    </div>
  );
}

function modelConfigurationForChoice(model: ModelChoice): DesktopModelConfigurationInput {
  const catalog = catalogForConnection({ provider: model.provider, providerType: model.providerType }, model.baseUrl);
  return {
    alias: model.alias,
    displayName: model.displayName,
    providerAlias: model.provider,
    providerType: model.providerType as DesktopModelConfigurationInput["providerType"],
    protocol: catalog?.protocol ?? (model.providerType === "anthropic" ? "anthropic" : "openai-compatible"),
    model: model.model,
    baseUrl: model.baseUrl,
    apiKey: undefined,
    apiKeyHandle: undefined,
    apiKeyEnv: undefined,
    requiresApiKey: catalog?.requiresApiKey,
    supportsTools: model.supportsTools !== false,
    supportsThinking: model.efforts.length > 0,
    parallelToolCalls: model.capabilities?.parallelToolCalls,
    reasoningStream: model.capabilities?.reasoningStream,
    reasoningSummary: model.capabilities?.reasoningSummary,
    supportsVision: model.capabilities?.vision,
    supportsAudio: model.capabilities?.audio,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    limits: model.limits,
    apiBackend: model.apiBackend,
    thinkingLevelMap: model.thinkingLevelMap,
    compatibility: model.compatibility,
    makeDefault: false
  };
}

function modelProviderLabel(model: ModelChoice): string {
  const catalog = catalogForConnection({ provider: model.provider, providerType: model.providerType }, model.baseUrl);
  const label = catalog?.label ?? providerLabel(model.provider);
  return label.toLocaleLowerCase() === model.provider.toLocaleLowerCase() ? label : `${label} · ${model.provider}`;
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Google Gemini",
    kimi: "Kimi",
    moonshot: "Moonshot",
    ollama: "Ollama",
    openai: "OpenAI",
    "openai-compatible": "OpenAI Compatible",
    "openai-codex": "OpenAI Codex",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function MemoryStat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div className="memory-stat-card"><strong>{value}</strong><span>{label}</span></div>;
}

type MemoryEditorValue = DesktopMemoryEntryInput;

function MemoryEntryEditor({ entry, onCancel, onSubmit, saving }: {
  entry?: DesktopMemoryEntry;
  onCancel(): void;
  onSubmit(value: MemoryEditorValue): Promise<void>;
  saving: boolean;
}): React.JSX.Element {
  const [audience, setAudience] = useState<DesktopMemoryEntryInput["audience"]>(entry?.origin.kind === "user" ? "universal" : "workspace");
  const [kind, setKind] = useState<DesktopMemoryKind>(entry?.kind ?? "fact");
  const [topic, setTopic] = useState(entry?.topic ?? "project");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [summary, setSummary] = useState(entry?.summary ?? "");
  const [decisions, setDecisions] = useState((entry?.decisions ?? []).join("\n"));
  const [paths, setPaths] = useState((entry?.paths ?? []).join("\n"));
  const [keywords, setKeywords] = useState((entry?.keywords ?? []).join(", "));
  const [importance, setImportance] = useState(entry?.importance ?? 3);
  const [userEvidence, setUserEvidence] = useState(entry?.lineage.find((item) => item.userEvidence)?.userEvidence ?? "");
  const universal = audience === "universal";
  const valid = title.trim().length > 0
    && summary.trim().length >= 20
    && topic.trim().length > 0
    && (!universal || userEvidence.trim().length > 0);
  const setAudienceSafely = (next: DesktopMemoryEntryInput["audience"]): void => {
    setAudience(next);
    if (next === "universal" && kind !== "preference" && kind !== "working_style") setKind("preference");
  };
  return <section aria-labelledby="memory-editor-title" className="model-dialog-panel memory-editor-panel" role="dialog">
    <header className="model-dialog-header"><div><h3 id="memory-editor-title">{entry ? "编辑记忆" : "添加记忆"}</h3><p>{entry ? "ID、创建时间、来源和既有 lineage 会保留。" : "保存后立即写入单一 Markdown 记忆库。"}</p></div><button aria-label="关闭" className="icon-button" onClick={onCancel} type="button"><Icon name="close" size={14} /></button></header>
    <div className="memory-editor-fields">
      <fieldset disabled={entry !== undefined}><legend>来源</legend><div className="settings-segmented"><button aria-pressed={audience === "workspace"} className={audience === "workspace" ? "is-selected" : ""} onClick={() => setAudienceSafely("workspace")} type="button">当前项目</button><button aria-pressed={audience === "universal"} className={audience === "universal" ? "is-selected" : ""} onClick={() => setAudienceSafely("universal")} type="button">通用偏好</button></div></fieldset>
      <div className="memory-editor-grid">
        <label><span>类型</span><select onChange={(event) => setKind(event.target.value as DesktopMemoryKind)} value={kind}>{memoryKindOptions.filter((option) => !universal || option.value === "preference" || option.value === "working_style").map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>话题</span><input onChange={(event) => setTopic(event.target.value)} value={topic} /></label>
        <label><span>重要度</span><input max={5} min={1} onChange={(event) => setImportance(Number(event.target.value))} type="number" value={importance} /></label>
      </div>
      <label><span>标题</span><input data-settings-detail-autofocus maxLength={120} onChange={(event) => setTitle(event.target.value)} value={title} /></label>
      <label><span>完整摘要</span><textarea onChange={(event) => setSummary(event.target.value)} rows={6} value={summary} /></label>
      {!universal ? <><label><span>决策（每行一项）</span><textarea onChange={(event) => setDecisions(event.target.value)} rows={3} value={decisions} /></label><label><span>相关路径（每行一项）</span><textarea onChange={(event) => setPaths(event.target.value)} rows={3} value={paths} /></label></> : null}
      <label><span>关键词（逗号分隔）</span><input onChange={(event) => setKeywords(event.target.value)} value={keywords} /></label>
      {universal ? <label><span>明确用户证据</span><textarea onChange={(event) => setUserEvidence(event.target.value)} placeholder="记录用户明确表达这项偏好或工作方式的原话/摘要" rows={3} value={userEvidence} /></label> : null}
    </div>
    <footer className="model-dialog-footer"><button className="ghost-button" disabled={saving} onClick={onCancel} type="button">取消</button><button disabled={!valid || saving} onClick={() => { void onSubmit({ audience, kind, topic: topic.trim(), title: title.trim(), summary: summary.trim(), decisions: universal ? [] : splitLines(decisions), paths: universal ? [] : splitLines(paths), keywords: splitKeywords(keywords), importance, userEvidence: universal ? userEvidence.trim() : undefined }); }} type="button">{saving ? "保存中…" : entry ? "立即保存编辑" : "立即添加"}</button></footer>
  </section>;
}

function entryListItem(entry: DesktopMemoryEntry) {
  return { ...entry, excerpt: entry.summary, entry };
}

function patchFromInput(input: DesktopMemoryEntryInput): DesktopMemoryEntryPatch {
  return {
    topic: input.topic,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    decisions: input.decisions,
    paths: input.paths,
    keywords: input.keywords,
    importance: input.importance,
    userEvidence: input.userEvidence
  };
}







function memoryOriginLabel(origin: DesktopMemoryEntry["origin"], overview: DesktopMemoryOverview): string {
  if (origin.kind === "user") return "通用偏好";
  const currentOnly = overview.origins.currentWorkspace > 0 && overview.entries.some((entry) => entry.origin.kind === "workspace" && entry.origin.workspaceId === origin.workspaceId);
  return currentOnly && overview.filter === "current_workspace" ? "当前项目" : origin.workspaceName;
}

function memoryKindLabel(kind: DesktopMemoryKind): string {
  return memoryKindOptions.find((option) => option.value === kind)?.label ?? kind;
}

function memoryLineageLabel(lineage: DesktopMemoryEntry["lineage"]): string {
  const sources = [...new Set(lineage.map((item) => item.source))].map((source) => {
    if (source === "explicit") return "手动添加";
    if (source === "explicit_edit") return "手动编辑";
    if (source === "completed_task") return "任务完成";
    if (source === "candidate") return "候选确认";
    if (source === "migration") return "旧版迁移";
    return "记忆整理";
  });
  return `${sources.join(" / ")}${lineage.some((item) => item.externalContext) ? " · 含外部上下文" : ""}`;
}

function formatMemoryDate(value?: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : value;
}

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function splitKeywords(value: string): string[] {
  return value.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean);
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
