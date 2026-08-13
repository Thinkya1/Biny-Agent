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
  DesktopMemorySearchMatch
} from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { ModelMenu } from "../composer/ModelMenu.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

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

interface SettingsMemoryProps {
  models: ModelChoice[];
  embeddingModels: DesktopEmbeddingModelDescriptor[];
  workspaceAvailable: boolean;
  sessionRunning: boolean;
  onLoad(filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview>;
  onSearch(filter: DesktopMemoryOriginFilter, query: string): Promise<DesktopMemorySearchMatch[]>;
  onAdd(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onUpdate(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onDeleteEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onClear(filter: DesktopMemoryOriginFilter, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onCompact(filter: DesktopMemoryOriginFilter, expectedRevision: number, topic?: string): Promise<DesktopMemoryCompactionResult>;
  onLoadEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onDeleteEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  onRebuildEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onNotify(message: string): void;
}

export function SettingsMemory({
  models,
  embeddingModels,
  workspaceAvailable,
  sessionRunning,
  onLoad,
  onSearch,
  onAdd,
  onUpdate,
  onDeleteEntry,
  onClear,
  onCompact,
  onLoadEmbeddingStatus,
  onDownloadEmbeddingModel,
  onCancelEmbeddingDownload,
  onDeleteEmbeddingModel,
  onRebuildEmbeddingIndex,
  onCancelEmbeddingRebuild,
  onNotify
}: SettingsMemoryProps): React.JSX.Element {
  const { draft, setMemory, snapshot } = useSettingsDraft();
  const [filter, setFilter] = useState<DesktopMemoryOriginFilter>("current_workspace");
  const [overview, setOverview] = useState<DesktopMemoryOverview>();
  const [loadError, setLoadError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopMemorySearchMatch[]>();
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; entry: DesktopMemoryEntry }>();
  const [deleteTarget, setDeleteTarget] = useState<DesktopMemoryEntry>();
  const [clearOpen, setClearOpen] = useState(false);
  const [clearPhrase, setClearPhrase] = useState("");
  const [advancedModels, setAdvancedModels] = useState(false);
  const [privacyModel, setPrivacyModel] = useState<DesktopEmbeddingModelDescriptor>();
  const [compactReport, setCompactReport] = useState<string>();
  const [embeddingStatus, setEmbeddingStatus] = useState<DesktopMemoryEmbeddingStatus>();
  const [embeddingStatusError, setEmbeddingStatusError] = useState<string>();
  const [embeddingMenuOpen, setEmbeddingMenuOpen] = useState(false);
  const [embeddingQuery, setEmbeddingQuery] = useState("");
  const embeddingMenuRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (nextFilter: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview> => {
    const next = await onLoad(nextFilter);
    setOverview(next);
    setLoadError(undefined);
    return next;
  }, [onLoad]);

  const refreshEmbeddingStatus = useCallback(async (): Promise<void> => {
    try {
      setEmbeddingStatus(await onLoadEmbeddingStatus());
      setEmbeddingStatusError(undefined);
    } catch (error) {
      setEmbeddingStatusError(errorMessage(error));
    }
  }, [onLoadEmbeddingStatus]);

  const refreshMemoryData = useCallback(async (nextFilter: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview> => {
    const [next] = await Promise.all([
      load(nextFilter),
      refreshEmbeddingStatus()
    ]);
    return next;
  }, [load, refreshEmbeddingStatus]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setSearchResults(undefined);
    setQuery("");
    onLoad(filter)
      .then((next) => { if (!cancelled) setOverview(next); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [filter, onLoad]);

  useEffect(() => {
    let cancelled = false;
    onLoadEmbeddingStatus()
      .then((status) => {
        if (cancelled) return;
        setEmbeddingStatus(status);
        setEmbeddingStatusError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setEmbeddingStatusError(errorMessage(error));
      });
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

  if (!workspaceAvailable) return <MemoryPageState detail="记忆来源和当前项目筛选需要 workspace 上下文。请先返回应用并添加或选择一个项目。" title="请先选择项目" />;
  if (!draft) return <MemoryPageState title="正在加载记忆设置…" />;
  if (loadError && !overview) return <MemoryPageState detail={loadError} title="无法加载记忆库" />;
  if (!overview) return <MemoryPageState title="正在读取单一记忆库…" />;

  const policy = draft.memory;
  const visibleEmbeddingModels = mergeEmbeddingModels(embeddingModels, embeddingStatus?.models ?? []);
  const activeEmbedding = visibleEmbeddingModels.find((model) => sameEmbeddingRef(model.ref, policy.embeddingModel));
  const activeThresholds = activeEmbedding === undefined
    ? undefined
    : policy.similarityThresholds[activeEmbedding.fingerprint] ?? activeEmbedding.recommendedThresholds;
  const entriesById = new Map(overview.entries.map((entry) => [entry.id, entry] as const));
  const displayed = searchResults === undefined
    ? overview.entries.map(entryListItem)
    : searchResults.map((match) => ({ ...match, entry: entriesById.get(match.id) }));
  const visibleEntryCount = overview.entries.length;
  const clearEntryCount = filter === "all" ? overview.totalEntries : visibleEntryCount;
  const clearConfirmation = `清空 ${String(clearEntryCount)} 条记忆`;
  const immediateDisabled = sessionRunning || busyAction !== undefined;
  const persistedEmbedding = snapshot?.memory.embeddingModel;
  const embeddingDraftChanged = !sameOptionalEmbeddingRef(policy.embeddingModel, persistedEmbedding);
  const embeddingOperation = embeddingStatus?.operation;

  const changePolicy = (patch: Partial<typeof policy>): void => setMemory({ ...policy, ...patch });
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
    operation: () => Promise<unknown>,
    success: string
  ): Promise<boolean> => {
    if (immediateDisabled) return false;
    setBusyAction(action);
    try {
      await operation();
      await refreshMemoryData(filter);
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
    <div className="settings-sections memory-settings-v3">
      <section id="memory-features" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆功能</h3><p>总开关是硬门禁；聊天级覆盖不能绕过它。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <MemorySwitch checked={policy.enabled} detail="关闭后不检索、不生成，但不会删除已有记忆" label="启用记忆" onChange={(enabled) => changePolicy({ enabled })} />
        <MemorySwitch checked={policy.useMemories} detail="每个新根回合自动检索并注入相关记忆" disabled={!policy.enabled} label="自动检索" onChange={(useMemories) => changePolicy({ useMemories })} />
        <MemorySwitch checked={policy.generateMemories} detail="成功回合进入候选队列，再由维护流程提取" disabled={!policy.enabled} label="自动生成" onChange={(generateMemories) => changePolicy({ generateMemories })} />
        <MemorySwitch checked={policy.excludeExternalContext} detail="网页、附件、MCP、插件和子代理内容不自动沉淀" disabled={!policy.enabled} label="排除外部上下文" onChange={(excludeExternalContext) => changePolicy({ excludeExternalContext })} />
      </section>

      <section id="memory-retrieval" tabIndex={-1}>
        <h3>记忆检索</h3>
        <MemorySwitch checked={policy.queryRewrite} detail="用记忆处理模型生成更适合检索的查询；3 秒失败后使用原问题" disabled={!policy.enabled || !policy.useMemories} label="查询重写" onChange={(queryRewrite) => changePolicy({ queryRewrite })} />
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

      <section id="memory-models" tabIndex={-1}>
        <div className="section-heading-row"><div><h3>记忆处理模型</h3><p>默认由一个主模型处理查询重写、提取和整理。</p></div></div>
        <ModelAliasField label="主模型" models={models} onChange={(value) => changeModel("memoryModel", value)} value={policy.memoryModel} />
        <button aria-expanded={advancedModels} className="ghost-button memory-advanced-toggle" onClick={() => setAdvancedModels((value) => !value)} type="button">{advancedModels ? "收起高级覆盖" : "高级覆盖"}</button>
        {advancedModels ? (
          <div className="memory-model-grid">
            <ModelAliasField label="查询重写模型" models={models} onChange={(value) => changeModel("rewriteModel", value)} value={policy.rewriteModel} />
            <ModelAliasField label="记忆提取模型" models={models} onChange={(value) => changeModel("extractModel", value)} value={policy.extractModel} />
            <ModelAliasField label="记忆整理模型" models={models} onChange={(value) => changeModel("consolidationModel", value)} value={policy.consolidationModel} />
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
        {loadError ? <p className="settings-effective-hint is-blocked">刷新记忆列表失败：{loadError}</p> : null}
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
        {embeddingDraftChanged ? <p className="settings-effective-hint is-blocked">Embedding 选择尚未保存。请先“保存全部”，提交成功后 Biny 会后台重建；也可随后手动重建。</p> : null}
        <p className="memory-empty-hint">下载、删除和重建属于立即动作；任务运行期间不可执行。云端会上传全部待索引记忆，并在每次语义检索时上传查询。</p>
      </section>

      <section className="memory-scope-section" id="memory-library" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>统计与维护</h3><p>所有来源共享一个 Markdown revision；来源切换只是列表过滤。</p></div>
          <button className="ghost-button" disabled={immediateDisabled} onClick={() => { void refreshMemoryData(filter).catch((error: unknown) => setLoadError(errorMessage(error))); }} type="button"><Icon name="refresh" size={13} /> 刷新</button>
        </div>
        <div className="memory-stat-grid">
          <MemoryStat label="记忆总数" value={overview.memoryStats.total} />
          <MemoryStat label="自动生成" value={overview.memoryStats.autoGenerated} />
          <MemoryStat label="手动添加" value={overview.memoryStats.manualAdded} />
        </div>
        <p className="memory-empty-hint">最近维护：{overview.maintenance.lastFinishedAt ? formatMemoryDate(overview.maintenance.lastFinishedAt) : overview.maintenance.lastScanAt ? formatMemoryDate(overview.maintenance.lastScanAt) : "尚未执行"} · 最近重建：{embeddingStatus?.index.active?.completedAt ? formatMemoryDate(embeddingStatus.index.active.completedAt) : "尚未完成"}</p>
        <div className="setting-row">
          <span><strong>整理当前来源</strong><small>只在相同来源、workspace 与 topic 内合并；即时保存</small></span>
          <button className="ghost-button" disabled={immediateDisabled || visibleEntryCount < 2} onClick={() => { void compact(); }} type="button">{busyAction === "compact" ? "整理中…" : "立即整理"}</button>
        </div>
        {compactReport ? <pre className="settings-memory-report">{compactReport}</pre> : null}
      </section>

      <section>
        <div className="section-heading-row"><div><h3>添加记忆</h3><p>完整结构化内容会立即写入 Markdown；通用偏好需要明确用户证据。</p></div><button disabled={immediateDisabled} onClick={() => setEditor({ mode: "add" })} type="button"><Icon name="add" size={14} /> 添加记忆</button></div>
      </section>

      <section>
        <div className="section-heading-row"><div><h3>搜索与列表</h3><p>搜索结果直接替换列表；清空搜索恢复当前来源的完整列表。</p></div></div>
        <div aria-label="记忆来源" className="settings-segmented memory-filter-tabs" role="tablist">
          {memoryFilters.map((option) => <button aria-selected={filter === option.value} className={filter === option.value ? "is-selected" : ""} disabled={busyAction !== undefined} key={option.value} onClick={() => setFilter(option.value)} role="tab" type="button">{option.label}</button>)}
        </div>
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

      {sessionRunning ? <p className="settings-effective-hint is-blocked">当前任务运行中：可以编辑记忆策略草稿；条目、整理、下载和索引动作将在任务结束后可用。</p> : <p className="settings-effective-hint">策略随“保存全部”提交；条目与维护动作会立即保存。</p>}

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

function MemoryPageState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</section></div>;
}

function MemorySwitch({ checked, detail, disabled = false, label, onChange }: {
  checked: boolean;
  detail: string;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}): React.JSX.Element {
  return <div className="setting-row"><span><strong>{label}</strong><small>{detail}</small></span><button aria-label={label} aria-checked={checked} className={`setting-switch${checked ? " is-on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button"><span className="setting-switch-knob" /></button></div>;
}

function ThresholdControl({ label, onChange, value }: { label: string; onChange(value: number): void; value: number }): React.JSX.Element {
  return <label className="memory-threshold-field"><span><strong>{label}</strong><em>{Math.round(value * 100)}%</em></span><input aria-label={label} max={100} min={0} onChange={(event) => onChange(Number(event.target.value) / 100)} type="range" value={Math.round(value * 100)} /></label>;
}

function ModelAliasField({ label, models, onChange, value }: { label: string; models: ModelChoice[]; onChange(value: string): void; value?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const unavailable = value !== undefined && !models.some((model) => model.alias === value);
  const selected = models.find((model) => model.alias === value);
  const catalog = selected ? catalogForConnection({ provider: selected.provider, providerType: selected.providerType }, selected.baseUrl) : undefined;
  return (
    <div className="memory-select-field">
      <span>{label}</span>
      <div className="memory-model-picker" ref={anchorRef}>
        <button aria-expanded={open} aria-haspopup="menu" className="memory-model-trigger" onClick={() => setOpen((current) => !current)} type="button">
          <span className="model-trigger-brand">{selected ? <ProviderBrandGlyph type={catalog?.iconTone ?? selected.providerType} /> : <Icon name="brain" size={14} />}</span>
          <span>{unavailable ? `当前不可用：${value}` : selected?.displayName ?? "跟随主模型或当前聊天"}</span>
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
    </div>
  );
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

function embeddingRefLabel(ref: EmbeddingModelRef): string {
  return ref.kind === "local" ? ref.model : `${ref.provider}/${ref.model}`;
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
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN", { hour12: false }) : value;
}

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function splitKeywords(value: string): string[] {
  return value.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean);
}

function formatModelSize(value?: number): string {
  return value === undefined ? "需下载" : `约 ${Math.round(value / 1024 / 1024)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
