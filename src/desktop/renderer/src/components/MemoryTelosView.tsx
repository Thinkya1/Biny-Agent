/**
 * 记忆主界面；长期目标与原则作为其中一个可确认、可编辑的分区。
 *
 * 事实、推断和用户确认的策略分别呈现；渲染层只通过 DesktopApi 读写，所有 CAS、脱敏和
 * 文件锁都留在主进程/runtime。列表与详情采用双栏，窄窗口由 CSS 自动折叠为单栏。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopBehaviorPattern,
  DesktopBehaviorPatternReviewAction,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,
  DesktopMemoryOverview,
  DesktopMemorySearchMatch,
  DesktopTelosDocument,
  DesktopTelosDocumentInput,
  DesktopTelosDrift,
  DesktopTelosDriftResolutionAction,
  DesktopTelosOverview,
  DesktopTelosScope
} from "../../../protocol.js";
import { Icon } from "./Icon.js";

type MemoryTelosSection = "overview" | "facts" | "patterns" | "telos" | "drifts";

interface MemoryTelosViewProps {
  projectId?: string;
  projectName?: string;
  sessionRunning: boolean;
  onOpenSettings(): void;
  onOpenChatDraft(input: string): void;
  onNotify(message: string): void;
  onError(message: string): void;
}

interface TelosDraft {
  scope: DesktopTelosScope;
  mission: string;
  goals: DesktopTelosDocument["goals"];
  principles: DesktopTelosDocument["principles"];
  constraints: DesktopTelosDocument["constraints"];
  antiGoals: DesktopTelosDocument["antiGoals"];
}

interface FactDraft {
  audience: DesktopMemoryEntryInput["audience"];
  topic: string;
  kind: DesktopMemoryEntryInput["kind"];
  title: string;
  summary: string;
  importance: number;
}

const sectionItems: ReadonlyArray<{ id: MemoryTelosSection; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "facts", label: "事实记忆" },
  { id: "patterns", label: "行为模式" },
  { id: "telos", label: "目标与原则" },
  { id: "drifts", label: "策略偏差" }
];

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

export function MemoryTelosView({
  projectId,
  projectName,
  sessionRunning,
  onOpenSettings,
  onOpenChatDraft,
  onNotify,
  onError
}: MemoryTelosViewProps): React.JSX.Element {
  const [section, setSection] = useState<MemoryTelosSection>("overview");
  const [scope, setScope] = useState<DesktopTelosScope>("workspace");
  const [overview, setOverview] = useState<DesktopTelosOverview>();
  const [memory, setMemory] = useState<DesktopMemoryOverview>();
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [query, setQuery] = useState("");
  const [factSearchResults, setFactSearchResults] = useState<DesktopMemorySearchMatch[]>();
  const [selectedFactId, setSelectedFactId] = useState<string>();
  const [selectedPatternId, setSelectedPatternId] = useState<string>();
  const [selectedDriftId, setSelectedDriftId] = useState<string>();
  const [factDraft, setFactDraft] = useState<FactDraft>();
  const [telosDraft, setTelosDraft] = useState<TelosDraft>(() => blankTelosDraft("workspace"));
  const [telosDirty, setTelosDirty] = useState(false);
  const [promptHidden, setPromptHidden] = useState(false);
  const [error, setError] = useState<string>();
  const [nowMs] = useState(() => Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setLoading(true);
    setError(undefined);
    try {
      const [nextTelos, nextMemory] = await Promise.all([
        window.biny.telosOverview(projectId),
        window.biny.memoryOverview(projectId, "all")
      ]);
      setOverview(nextTelos);
      setMemory(nextMemory);
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  }, [onError, projectId]);

  useEffect(() => {
    setOverview(undefined);
    setMemory(undefined);
    setSelectedFactId(undefined);
    setSelectedPatternId(undefined);
    setSelectedDriftId(undefined);
    setFactSearchResults(undefined);
    setTelosDirty(false);
    setPromptHidden(false);
    void refresh();
  }, [projectId, refresh]);

  const currentDocument = useMemo(
    () => scope === "universal" ? overview?.universal : overview?.workspace,
    [overview?.universal, overview?.workspace, scope]
  );

  useEffect(() => {
    if (telosDirty) return;
    setTelosDraft(telosDraftFromDocument(scope, currentDocument));
    setTelosDirty(false);
  }, [currentDocument, scope, telosDirty]);

  const allFacts = useMemo(() => memory?.entries ?? [], [memory?.entries]);
  const facts = useMemo(() => {
    if (!factSearchResults) return allFacts;
    const entriesById = new Map(allFacts.map((entry) => [entry.id, entry] as const));
    return factSearchResults
      .map((match) => entriesById.get(match.id))
      .filter((entry): entry is DesktopMemoryEntry => entry !== undefined);
  }, [allFacts, factSearchResults]);

  const filteredPatterns = useMemo(() => filterRecords(overview?.patterns ?? [], query, (pattern) => `${pattern.title} ${pattern.statement}`), [overview?.patterns, query]);
  const filteredDrifts = useMemo(() => filterRecords(overview?.drifts ?? [], query, (drift) => `${drift.title} ${drift.summary}`), [overview?.drifts, query]);
  const selectedFact = allFacts.find((entry) => entry.id === selectedFactId);
  const selectedPattern = overview?.patterns.find((pattern) => pattern.id === selectedPatternId);
  const selectedDrift = overview?.drifts.find((drift) => drift.id === selectedDriftId);
  const openDrift = overview?.drifts.find((drift) => {
    if (drift.status === "open") return true;
    return drift.status === "snoozed" && drift.snoozedUntil !== undefined && Date.parse(drift.snoozedUntil) <= nowMs;
  });
  const proactivePrompts = memory?.settings.telos?.proactivePrompts === true;
  const promptDrift = proactivePrompts && !sessionRunning && !promptHidden ? openDrift : undefined;

  const run = useCallback(async (name: string, work: () => Promise<void>, success?: string): Promise<void> => {
    if (operation) return;
    setOperation(name);
    setError(undefined);
    try {
      await work();
      if (success) onNotify(success);
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      onError(message);
    } finally {
      setOperation(undefined);
    }
  }, [onError, onNotify, operation]);

  const searchFacts = useCallback(async (): Promise<void> => {
    if (!projectId || !query.trim()) {
      setFactSearchResults(undefined);
      return;
    }
    await run("fact-search", async () => {
      setFactSearchResults(await window.biny.searchMemory(projectId, "all", query.trim()));
    });
  }, [projectId, query, run]);

  const saveFact = useCallback(async (): Promise<void> => {
    if (!projectId || !memory || !factDraft) return;
    await run("fact-save", async () => {
      const next = selectedFact
        ? await window.biny.updateMemoryEntry(projectId, selectedFact.id, {
            topic: factDraft.topic,
            kind: factDraft.kind,
            title: factDraft.title,
            summary: factDraft.summary,
            importance: factDraft.importance
          }, memory.revision)
        : await window.biny.addMemoryEntry(projectId, {
            ...factDraft,
            decisions: [],
            paths: [],
            keywords: [],
            userEvidence: factDraft.audience === "universal" ? factDraft.summary : undefined
          }, memory.revision);
      setMemory(next);
      setFactDraft(undefined);
      setSelectedFactId(next.entries[0]?.id);
    }, selectedFact ? "事实记忆已更新" : "事实记忆已添加");
  }, [factDraft, memory, projectId, run, selectedFact]);

  const deleteFact = useCallback(async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!projectId || !memory) return;
    if (!window.confirm(`删除事实记忆“${entry.title}”？此操作不可撤销。`)) return;
    await run("fact-delete", async () => {
      const next = await window.biny.deleteMemoryEntry(projectId, entry.id, memory.revision);
      setMemory(next);
      setSelectedFactId(undefined);
    }, "事实记忆已删除");
  }, [memory, projectId, run]);

  const saveTelos = useCallback(async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!projectId || !overview) return;
    await run("telos-save", async () => {
      const input: DesktopTelosDocumentInput = {
        scope: telosDraft.scope,
        mission: telosDraft.mission,
        goals: telosDraft.goals,
        principles: telosDraft.principles,
        constraints: telosDraft.constraints,
        antiGoals: telosDraft.antiGoals
      };
      const next = await window.biny.saveTelos(projectId, input, overview.revision);
      setOverview(next);
      setTelosDirty(false);
      const pending = selectedDrift;
      if (pending?.status === "open") {
        const resolved = await window.biny.resolveTelosDrift(projectId, pending.id, "adjust_telos", next.revision);
        setOverview(resolved);
        setSelectedDriftId(pending.id);
      }
    }, "目标与原则已保存，已生成新的版本");
  }, [overview, projectId, run, selectedDrift, telosDraft]);

  const reviewPattern = useCallback(async (pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): Promise<void> => {
    if (!projectId || !overview) return;
    await run(`pattern-${action}`, async () => {
      const next = await window.biny.reviewBehaviorPattern(projectId, pattern.id, action, overview.revision);
      setOverview(next);
      setSelectedPatternId(pattern.id);
    }, action === "confirm" ? "行为模式已确认" : action === "reject" ? "行为模式已拒绝" : "行为模式已过期");
  }, [overview, projectId, run]);

  const resolveDrift = useCallback(async (drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): Promise<void> => {
    if (!projectId || !overview) return;
    await run(`drift-${action}`, async () => {
      const next = await window.biny.resolveTelosDrift(projectId, drift.id, action, overview.revision);
      setOverview(next);
      setSelectedDriftId(drift.id);
      setPromptHidden(true);
      if (action === "adjust_telos") setSection("telos");
      if (action === "adjust_behavior") {
        onOpenChatDraft(`我想检查最近的行为是否偏离了长期策略。\n\n观察到：${drift.summary}\n\n请先帮我列出可能的行为调整方案，不要自动执行。`);
      }
    }, action === "dismiss" ? "已忽略此类策略偏差" : action === "resolve" ? "策略偏差已处理" : "已记录你的调整方向");
  }, [onOpenChatDraft, overview, projectId, run]);

  const snoozeDrift = useCallback(async (drift: DesktopTelosDrift): Promise<void> => {
    if (!projectId || !overview) return;
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    await run("drift-snooze", async () => {
      const next = await window.biny.snoozeTelosDrift(projectId, drift.id, until, overview.revision);
      setOverview(next);
      setPromptHidden(true);
    }, "已暂缓 7 天");
  }, [overview, projectId, run]);

  if (!projectId) return <EmptyState title="请先选择项目" detail="记忆按项目隔离，请先打开一个 workspace。" />;

  return (
    <main aria-busy={loading || operation !== undefined} className="memory-telos-page">
      <header className="memory-telos-header">
        <div className="memory-telos-title">
          <span aria-hidden="true" className="memory-telos-title-icon"><Icon name="brain" size={20} /></span>
          <div><h1>记忆</h1><p>{projectName ?? "当前项目"} · 事实、行为模式与长期策略</p></div>
        </div>
        <div className="memory-telos-header-actions">
          <span aria-live="polite" className="memory-telos-status">{loading ? "同步中…" : error ? "同步失败" : overview ? `revision ${String(overview.revision)}` : "等待数据"}</span>
          <button aria-label="刷新记忆" className="icon-button" disabled={loading || operation !== undefined} onClick={() => { void refresh(); }} title="刷新" type="button"><Icon name="refresh" size={15} /></button>
          <button className="ghost-button" onClick={onOpenSettings} type="button"><Icon name="settings" size={14} /> 设置</button>
        </div>
      </header>

      <nav aria-label="记忆分区" className="memory-telos-tabs" role="tablist">
        {sectionItems.map((item) => (
          <button
            aria-selected={section === item.id}
            className={section === item.id ? "is-selected" : ""}
            key={item.id}
            onClick={() => setSection(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
            {item.id === "facts" && memory ? <small>{memory.totalEntries}</small> : null}
            {item.id === "patterns" && overview ? <small>{overview.counts.candidatePatterns}</small> : null}
            {item.id === "drifts" && overview ? <small>{overview.counts.openDrifts}</small> : null}
          </button>
        ))}
      </nav>

      {promptDrift ? (
        <DriftPrompt
          drift={promptDrift}
          disabled={operation !== undefined}
          onAdjustBehavior={() => { void resolveDrift(promptDrift, "adjust_behavior"); }}
          onAdjustTelos={() => { void resolveDrift(promptDrift, "adjust_telos"); }}
          onDismiss={() => { void resolveDrift(promptDrift, "dismiss"); }}
          onSnooze={() => { void snoozeDrift(promptDrift); }}
        />
      ) : null}

      {error && !overview ? <EmptyState title="无法加载记忆" detail={error} action={<button className="ghost-button" onClick={() => { void refresh(); }} type="button">重试</button>} /> : null}
      {overview && memory ? (
        <div aria-live="polite" className="memory-telos-content">
          {section === "overview" ? <OverviewPanel memory={memory} overview={overview} onSection={setSection} /> : null}
          {section === "facts" ? <FactsPanel
            entries={facts}
            query={query}
            selected={selectedFact}
            draft={factDraft}
            operation={operation}
            onQueryChange={(value) => { setQuery(value); if (!value) setFactSearchResults(undefined); }}
            onSearch={() => { void searchFacts(); }}
            onSelect={(entry) => { setSelectedFactId(entry.id); setFactDraft(undefined); }}
            onAdd={() => { setSelectedFactId(undefined); setFactDraft(blankFactDraft()); }}
            onEdit={(entry) => { setSelectedFactId(entry.id); setFactDraft(factDraftFromEntry(entry)); }}
            onDelete={(entry) => { void deleteFact(entry); }}
            onDraftChange={setFactDraft}
            onSave={() => { void saveFact(); }}
            onCancel={() => setFactDraft(undefined)}
          /> : null}
          {section === "patterns" ? <PatternsPanel
            patterns={filteredPatterns}
            query={query}
            selected={selectedPattern}
            operation={operation}
            onQueryChange={setQuery}
            onSelect={(pattern) => setSelectedPatternId(pattern.id)}
            onReview={(pattern, action) => { void reviewPattern(pattern, action); }}
          /> : null}
          {section === "telos" ? <TelosPanel
            scope={scope}
            draft={telosDraft}
            currentDocument={currentDocument}
            dirty={telosDirty}
            operation={operation}
            onScopeChange={(nextScope) => {
              if (telosDirty && !window.confirm("当前长期策略有未保存修改，切换范围会丢弃这些修改。继续吗？")) return;
              setTelosDirty(false);
              setScope(nextScope);
            }}
            onChange={(next) => { setTelosDraft(next); setTelosDirty(true); }}
            onSave={(event) => { void saveTelos(event); }}
          /> : null}
          {section === "drifts" ? <DriftsPanel
            drifts={filteredDrifts}
            query={query}
            selected={selectedDrift}
            operation={operation}
            onQueryChange={setQuery}
            onSelect={(drift) => setSelectedDriftId(drift.id)}
            onResolve={(drift, action) => { void resolveDrift(drift, action); }}
            onSnooze={(drift) => { void snoozeDrift(drift); }}
          /> : null}
        </div>
      ) : null}
    </main>
  );
}

function OverviewPanel({ memory, overview, onSection }: { memory: DesktopMemoryOverview; overview: DesktopTelosOverview; onSection(section: MemoryTelosSection): void }): React.JSX.Element {
  const document = overview.workspace ?? overview.universal;
  const activeGoals = document?.goals.filter((goal) => goal.status === "active") ?? [];
  return (
    <section className="memory-telos-overview" aria-labelledby="memory-telos-overview-title">
      <div className="memory-telos-intro"><div><span className="memory-telos-eyebrow">自动进化的记忆</span><h2 id="memory-telos-overview-title">AI 记住事实，也尊重你的方向</h2><p>事实可以自动产生；行为模式是可审核的推断；长期策略只有在你保存后才会改变。</p></div><button className="primary-button" onClick={() => onSection("telos")} type="button">编辑目标与原则</button></div>
      <div className="memory-telos-metrics">
        <Metric label="事实记忆" value={memory.totalEntries} detail={`${String(memory.memoryStats.autoGenerated)} 条自动 · ${String(memory.memoryStats.manualAdded)} 条手动`} onClick={() => onSection("facts")} />
        <Metric label="待确认模式" value={overview.counts.candidatePatterns} detail={`${String(overview.counts.observations)} 条脱敏观察`} onClick={() => onSection("patterns")} />
        <Metric label="已确认模式" value={overview.counts.confirmedPatterns} detail="只作为低优先级指导参与判断" onClick={() => onSection("patterns")} />
        <Metric label="待处理偏差" value={overview.counts.openDrifts} detail="任务结束且 Runtime idle 后提醒" onClick={() => onSection("drifts")} />
      </div>
      <div className="memory-telos-overview-grid">
        <article className="memory-telos-card"><span className="memory-telos-card-label">当前使命</span><strong>{document?.mission || "还没有明确使命"}</strong><small>{document ? `${document.scope === "workspace" ? "当前项目" : "通用"} · revision ${String(document.revision)}` : "在目标与原则中添加"}</small></article>
        <article className="memory-telos-card"><span className="memory-telos-card-label">当前目标</span>{activeGoals.length ? <ul>{activeGoals.slice(0, 3).map((goal) => <li key={goal.id}>{goal.text}</li>)}</ul> : <strong className="is-muted">还没有进行中的目标</strong>}</article>
        <article className="memory-telos-card"><span className="memory-telos-card-label">边界</span><p>{document?.constraints[0]?.text ?? "尚未设置约束"}</p><small>{document?.antiGoals.length ? `反目标 ${String(document.antiGoals.length)} 条` : "可在编辑器中维护反目标"}</small></article>
      </div>
    </section>
  );
}

function Metric({ label, value, detail, onClick }: { label: string; value: number; detail: string; onClick(): void }): React.JSX.Element {
  return <button className="memory-telos-metric" onClick={onClick} type="button"><span>{label}</span><strong>{value}</strong><small>{detail}</small></button>;
}

interface FactsPanelProps {
  entries: DesktopMemoryEntry[];
  query: string;
  selected?: DesktopMemoryEntry;
  draft?: FactDraft;
  operation?: string;
  onQueryChange(value: string): void;
  onSearch(): void;
  onSelect(entry: DesktopMemoryEntry): void;
  onAdd(): void;
  onEdit(entry: DesktopMemoryEntry): void;
  onDelete(entry: DesktopMemoryEntry): void;
  onDraftChange(draft: FactDraft): void;
  onSave(): void;
  onCancel(): void;
}

function FactsPanel({ entries, query, selected, draft, operation, onQueryChange, onSearch, onSelect, onAdd, onEdit, onDelete, onDraftChange, onSave, onCancel }: FactsPanelProps): React.JSX.Element {
  return <SplitPanel
    count={entries.length}
    empty="还没有符合条件的事实记忆。"
    heading="事实记忆"
    list={(
      <>
        <div className="memory-telos-list-tools"><label className="memory-telos-search"><Icon name="search" size={14} /><input aria-label="搜索事实记忆" onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="搜索事实、偏好或路径" type="search" value={query} /></label><button aria-label="添加事实记忆" className="icon-button" onClick={onAdd} title="添加事实记忆" type="button"><Icon name="add" size={15} /></button></div>
        {entries.map((entry) => <button className={`memory-telos-list-item${selected?.id === entry.id ? " is-selected" : ""}`} key={entry.id} onClick={() => onSelect(entry)} type="button"><span className="memory-telos-list-item-top"><strong>{entry.title}</strong><small>{entry.origin.kind === "user" ? "通用" : "项目范围"}</small></span><span>{entry.summary}</span><small>{entry.topic} · {formatDate(entry.updatedAt)}</small></button>)}
      </>
    )}
    detail={draft ? <FactEditor draft={draft} operation={operation} onChange={onDraftChange} onSave={onSave} onCancel={onCancel} /> : selected ? <FactDetail entry={selected} onEdit={() => onEdit(selected)} onDelete={() => onDelete(selected)} /> : <DetailPlaceholder title="选择一条事实记忆" detail="来源、更新时间和 lineage 会在这里展示。" />}
  />;
}

function FactDetail({ entry, onEdit, onDelete }: { entry: DesktopMemoryEntry; onEdit(): void; onDelete(): void }): React.JSX.Element {
  return <DetailArticle eyebrow={entry.origin.kind === "user" ? "通用事实" : "项目范围事实"} title={entry.title} actions={<><button className="ghost-button" onClick={onEdit} type="button"><Icon name="edit" size={13} /> 编辑</button><button className="ghost-button is-danger" onClick={onDelete} type="button"><Icon name="trash" size={13} /> 删除</button></>}>
    <p className="memory-telos-detail-summary">{entry.summary}</p><MetaGrid items={[["主题", entry.topic], ["类型", entry.kind], ["重要度", `${String(entry.importance)}/5`], ["召回", `${String(entry.recallCount)} 次`], ["更新时间", formatDate(entry.updatedAt)]]} /><EvidenceTimeline items={entry.lineage.map((lineage, index) => ({ id: `${entry.id}-${String(index)}`, summary: `${lineageLabel(lineage.source)}${lineage.userEvidence ? `：${lineage.userEvidence}` : ""}`, observedAt: entry.updatedAt, externalContext: lineage.externalContext, sessionId: lineage.sessionId, turnId: lineage.turnId, runId: lineage.runId }))} />
  </DetailArticle>;
}

function FactEditor({ draft, operation, onChange, onSave, onCancel }: { draft: FactDraft; operation?: string; onChange(draft: FactDraft): void; onSave(): void; onCancel(): void }): React.JSX.Element {
  return <DetailArticle eyebrow="事实记忆" title="编辑事实记忆" actions={<><button className="ghost-button" onClick={onCancel} type="button">取消</button><button className="primary-button" disabled={operation !== undefined || !draft.title.trim() || !draft.summary.trim()} onClick={onSave} type="button">{operation === "fact-save" ? "保存中…" : "保存"}</button></>}>
    <div className="memory-telos-form"><label>标题<input onChange={(event) => onChange({ ...draft, title: event.target.value })} value={draft.title} /></label><label>主题<input onChange={(event) => onChange({ ...draft, topic: event.target.value })} value={draft.topic} /></label><label>范围<select onChange={(event) => onChange({ ...draft, audience: event.target.value as FactDraft["audience"] })} value={draft.audience}><option value="workspace">当前项目</option><option value="universal">通用</option></select></label><label>类型<select onChange={(event) => onChange({ ...draft, kind: event.target.value as FactDraft["kind"] })} value={draft.kind}><option value="fact">事实</option><option value="preference">偏好</option><option value="working_style">工作方式</option><option value="decision">决策</option><option value="workflow">工作流</option><option value="gotcha">注意事项</option></select></label><label className="memory-telos-form-wide">内容<textarea onChange={(event) => onChange({ ...draft, summary: event.target.value })} rows={6} value={draft.summary} /></label><label>重要度<input max={5} min={1} onChange={(event) => onChange({ ...draft, importance: Number(event.target.value) })} type="number" value={draft.importance} /></label></div>
  </DetailArticle>;
}

function PatternsPanel({ patterns, query, selected, operation, onQueryChange, onSelect, onReview }: { patterns: DesktopBehaviorPattern[]; query: string; selected?: DesktopBehaviorPattern; operation?: string; onQueryChange(value: string): void; onSelect(pattern: DesktopBehaviorPattern): void; onReview(pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): void }): React.JSX.Element {
  return <SplitPanel count={patterns.length} empty="还没有行为模式观察。开启设置中的自动观察后，成功完成的协作会形成候选。" heading="行为模式" list={<><ListSearch label="搜索行为模式" placeholder="搜索模式描述" value={query} onChange={onQueryChange} />{patterns.map((pattern) => <button className={`memory-telos-list-item${selected?.id === pattern.id ? " is-selected" : ""}`} key={pattern.id} onClick={() => onSelect(pattern)} type="button"><span className="memory-telos-list-item-top"><strong>{pattern.title}</strong><StatusPill status={pattern.status} /></span><span>{pattern.statement}</span><small>{pattern.evidenceCount} 次观察 · 置信度 {Math.round(pattern.confidence * 100)}% · {formatDate(pattern.updatedAt)}</small></button>)}</>} detail={selected ? <PatternDetail operation={operation} pattern={selected} onReview={onReview} /> : <DetailPlaceholder title="选择一个行为模式" detail="行为模式是 AI 的推断，不等同于事实，也不能自动改变你的长期策略。" />} />;
}

function PatternDetail({ pattern, operation, onReview }: { pattern: DesktopBehaviorPattern; operation?: string; onReview(pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): void }): React.JSX.Element {
  return <DetailArticle eyebrow="推断 · 行为模式" title={pattern.title} actions={pattern.status === "candidate" ? <><button className="ghost-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "reject")} type="button">拒绝</button><button className="primary-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "confirm")} type="button">确认模式</button></> : <button className="ghost-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "expire")} type="button">标记过期</button>}>
    <p className="memory-telos-detail-summary">{pattern.statement}</p><MetaGrid items={[["状态", pattern.status], ["置信度", `${String(Math.round(pattern.confidence * 100))}%`], ["观察次数", String(pattern.evidenceCount)], ["时间范围", `${formatDate(pattern.firstObservedAt)} — ${formatDate(pattern.lastObservedAt)}`], ["范围", pattern.scope === "workspace" ? "当前项目" : "通用"]]} /><EvidenceTimeline items={pattern.evidence} />
  </DetailArticle>;
}

function TelosPanel({ scope, draft, currentDocument, dirty, operation, onScopeChange, onChange, onSave }: { scope: DesktopTelosScope; draft: TelosDraft; currentDocument?: DesktopTelosDocument; dirty: boolean; operation?: string; onScopeChange(scope: DesktopTelosScope): void; onChange(draft: TelosDraft): void; onSave(event: React.FormEvent<HTMLFormElement>): void }): React.JSX.Element {
  const updateRules = (key: "principles" | "constraints" | "antiGoals", index: number, text: string): void => onChange({ ...draft, [key]: draft[key].map((item, itemIndex) => itemIndex === index ? { ...item, text } : item) });
  const addRule = (key: "principles" | "constraints" | "antiGoals"): void => onChange({ ...draft, [key]: [...draft[key], { id: makeId(), text: "" }] });
  const removeRule = (key: "principles" | "constraints" | "antiGoals", index: number): void => onChange({ ...draft, [key]: draft[key].filter((_, itemIndex) => itemIndex !== index) });
  return <section aria-labelledby="memory-telos-editor-title" className="memory-telos-editor"><div className="memory-telos-editor-sidebar"><span className="memory-telos-eyebrow">用户确认层</span><h2 id="memory-telos-editor-title">目标与原则</h2><p>这里写你希望长期遵循的方向。AI 可以提出草稿，但不会代替你保存。</p><div className="memory-telos-scope-switch" role="tablist"><button aria-selected={scope === "universal"} className={scope === "universal" ? "is-selected" : ""} onClick={() => onScopeChange("universal")} role="tab" type="button">通用策略</button><button aria-selected={scope === "workspace"} className={scope === "workspace" ? "is-selected" : ""} onClick={() => onScopeChange("workspace")} role="tab" type="button">当前项目</button></div><div className="memory-telos-revision-note">{currentDocument ? `已保存 revision ${String(currentDocument.revision)} · ${formatDate(currentDocument.updatedAt)}` : "此范围还没有长期策略"}{dirty ? <strong>有未保存修改</strong> : null}</div></div><form className="memory-telos-editor-form" onSubmit={onSave}><div className="memory-telos-form-heading"><div><span className="memory-telos-eyebrow">结构化编辑</span><h3>{scope === "universal" ? "通用长期策略" : "当前项目长期策略"}</h3></div><button className="primary-button" disabled={!dirty || operation !== undefined} type="submit">{operation === "telos-save" ? "保存中…" : "保存 revision"}</button></div><label className="memory-telos-form-wide">使命<textarea onChange={(event) => onChange({ ...draft, mission: event.target.value })} placeholder="你长期想推动什么？" rows={4} value={draft.mission} /></label><TelosGoals goals={draft.goals} onChange={(goals) => onChange({ ...draft, goals })} /><RuleEditor label="原则" items={draft.principles} onAdd={() => addRule("principles")} onChange={(index, text) => updateRules("principles", index, text)} onRemove={(index) => removeRule("principles", index)} /><RuleEditor label="约束" items={draft.constraints} onAdd={() => addRule("constraints")} onChange={(index, text) => updateRules("constraints", index, text)} onRemove={(index) => removeRule("constraints", index)} /><RuleEditor label="反目标" items={draft.antiGoals} onAdd={() => addRule("antiGoals")} onChange={(index, text) => updateRules("antiGoals", index, text)} onRemove={(index) => removeRule("antiGoals", index)} /></form></section>;
}

function TelosGoals({ goals, onChange }: { goals: DesktopTelosDocument["goals"]; onChange(goals: DesktopTelosDocument["goals"]): void }): React.JSX.Element {
  return <fieldset className="memory-telos-fieldset"><legend>当前目标</legend>{goals.map((goal, index) => <div className="memory-telos-goal-row" key={goal.id}><input aria-label={`目标 ${String(index + 1)}`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} placeholder="目标内容" value={goal.text} /><select aria-label={`目标 ${String(index + 1)} 状态`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, status: event.target.value as DesktopTelosDocument["goals"][number]["status"] } : item))} value={goal.status}><option value="active">进行中</option><option value="paused">暂停</option><option value="completed">完成</option></select><input aria-label={`目标 ${String(index + 1)} 时间范围`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, horizon: event.target.value } : item))} placeholder="时间范围（可选）" value={goal.horizon ?? ""} /><button aria-label={`删除目标 ${String(index + 1)}`} className="icon-button" onClick={() => onChange(goals.filter((_, itemIndex) => itemIndex !== index))} type="button"><Icon name="trash" size={13} /></button></div>)}<button className="ghost-button" onClick={() => onChange([...goals, { id: makeId(), text: "", status: "active" }])} type="button"><Icon name="add" size={13} /> 添加目标</button></fieldset>;
}

function RuleEditor({ label, items, onAdd, onChange, onRemove }: { label: string; items: DesktopTelosDocument["principles"]; onAdd(): void; onChange(index: number, text: string): void; onRemove(index: number): void }): React.JSX.Element {
  return <fieldset className="memory-telos-fieldset"><legend>{label}</legend>{items.map((item, index) => <div className="memory-telos-rule-row" key={item.id}><textarea aria-label={`${label} ${String(index + 1)}`} onChange={(event) => onChange(index, event.target.value)} placeholder={`添加一条${label}`} rows={2} value={item.text} /><button aria-label={`删除${label} ${String(index + 1)}`} className="icon-button" onClick={() => onRemove(index)} type="button"><Icon name="trash" size={13} /></button></div>)}<button className="ghost-button" onClick={onAdd} type="button"><Icon name="add" size={13} /> 添加{label}</button></fieldset>;
}

function DriftsPanel({ drifts, query, selected, operation, onQueryChange, onSelect, onResolve, onSnooze }: { drifts: DesktopTelosDrift[]; query: string; selected?: DesktopTelosDrift; operation?: string; onQueryChange(value: string): void; onSelect(drift: DesktopTelosDrift): void; onResolve(drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): void; onSnooze(drift: DesktopTelosDrift): void }): React.JSX.Element {
  return <SplitPanel count={drifts.length} empty="还没有策略偏差提案。已确认的行为模式达到阈值后才会生成。" heading="策略偏差" list={<><ListSearch label="搜索策略偏差" placeholder="搜索偏差或建议" value={query} onChange={onQueryChange} />{drifts.map((drift) => <button className={`memory-telos-list-item${selected?.id === drift.id ? " is-selected" : ""}`} key={drift.id} onClick={() => onSelect(drift)} type="button"><span className="memory-telos-list-item-top"><strong>{drift.title}</strong><StatusPill status={drift.status} /></span><span>{drift.summary}</span><small>策略版本 {String(drift.telosRevision)} · {formatDate(drift.updatedAt)}</small></button>)}</>} detail={selected ? <DriftDetail drift={selected} operation={operation} onResolve={onResolve} onSnooze={onSnooze} /> : <DetailPlaceholder title="选择一条策略偏差" detail="偏差只提出选择，不会自动调整目标或执行行为。" />} />;
}

function DriftDetail({ drift, operation, onResolve, onSnooze }: { drift: DesktopTelosDrift; operation?: string; onResolve(drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): void; onSnooze(drift: DesktopTelosDrift): void }): React.JSX.Element {
  const closed = drift.status === "dismissed" || drift.status === "resolved";
  return <DetailArticle eyebrow="策略偏差提案" title={drift.title} actions={closed ? <StatusPill status={drift.status} /> : <><button className="ghost-button" disabled={operation !== undefined} onClick={() => onSnooze(drift)} type="button">稍后 7 天</button><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "dismiss")} type="button">忽略</button><button className="primary-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "adjust_telos")} type="button">调整目标</button></>}><p className="memory-telos-detail-summary">{drift.summary}</p><MetaGrid items={[["状态", drift.status], ["关联策略", `版本 ${String(drift.telosRevision)}`], ["建议方向", drift.suggestedAction === "adjust_telos" ? "检查目标或原则" : "检查行为"], ["创建时间", formatDate(drift.createdAt)]]} /><EvidenceTimeline items={drift.evidence} />{!closed ? <div className="memory-telos-detail-actions"><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "adjust_behavior")} type="button">调整行为（打开聊天草稿）</button><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "resolve")} type="button">标记已处理</button></div> : null}</DetailArticle>;
}

function DriftPrompt({ drift, disabled, onAdjustTelos, onAdjustBehavior, onSnooze, onDismiss }: { drift: DesktopTelosDrift; disabled: boolean; onAdjustTelos(): void; onAdjustBehavior(): void; onSnooze(): void; onDismiss(): void }): React.JSX.Element {
  return <aside aria-label="策略偏差提醒" className="memory-telos-drift-prompt" role="dialog"><div><span className="memory-telos-eyebrow">任务结束后的提醒</span><h2>{drift.title}</h2><p>{drift.summary}</p></div><div className="memory-telos-drift-prompt-actions"><button className="primary-button" disabled={disabled} onClick={onAdjustTelos} type="button">调整目标与原则</button><button className="ghost-button" disabled={disabled} onClick={onAdjustBehavior} type="button">调整行为</button><button className="ghost-button" disabled={disabled} onClick={onSnooze} type="button">稍后处理</button><button aria-label="忽略此偏差" className="icon-button" disabled={disabled} onClick={onDismiss} title="忽略此类偏差" type="button"><Icon name="close" size={14} /></button></div></aside>;
}

function SplitPanel({ heading, count, list, detail, empty }: { heading: string; count: number; list: React.ReactNode; detail: React.ReactNode; empty: string }): React.JSX.Element {
  return <section className="memory-telos-split" aria-label={heading}><aside className="memory-telos-list-pane"><div className="memory-telos-list-heading"><div><span className="memory-telos-eyebrow">浏览器</span><h2>{heading}</h2></div><span>{count}</span></div>{count ? list : <p className="memory-telos-empty">{empty}</p>}</aside><article className="memory-telos-detail-pane">{detail}</article></section>;
}

function ListSearch({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange(value: string): void }): React.JSX.Element {
  return <label className="memory-telos-search"><Icon name="search" size={14} /><input aria-label={label} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type="search" value={value} /></label>;
}

function DetailArticle({ eyebrow, title, actions, children }: { eyebrow: string; title: string; actions?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <div className="memory-telos-detail"><div className="memory-telos-detail-heading"><div><span className="memory-telos-eyebrow">{eyebrow}</span><h2>{title}</h2></div>{actions ? <div className="memory-telos-detail-buttons">{actions}</div> : null}</div>{children}</div>;
}

function MetaGrid({ items }: { items: Array<[string, string]> }): React.JSX.Element {
  return <dl className="memory-telos-meta">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function EvidenceTimeline({ items }: { items: Array<{ id: string; summary: string; observedAt: string; externalContext: boolean; sessionId?: string; turnId?: string; runId?: string }> }): React.JSX.Element {
  return <section className="memory-telos-evidence" aria-label="来源证据"><div className="memory-telos-evidence-heading"><span>来源与证据</span><small>{items.length} 条</small></div>{items.length ? <ol>{items.map((item) => <li key={item.id}><span className="memory-telos-evidence-dot" /><div><p>{item.summary}</p><small>{formatDate(item.observedAt)} · {item.externalContext ? "含外部上下文" : "本地协作"}{item.sessionId ? ` · session ${item.sessionId.slice(0, 8)}` : ""}{item.turnId ? ` · turn ${item.turnId.slice(0, 8)}` : ""}{item.runId ? ` · run ${item.runId.slice(0, 8)}` : ""}</small></div></li>)}</ol> : <p className="memory-telos-empty">没有可展示的证据。</p>}</section>;
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const labels: Record<string, string> = { candidate: "待确认", confirmed: "已确认", rejected: "已拒绝", expired: "已过期", open: "开放", snoozed: "已暂缓", dismissed: "已忽略", resolved: "已处理" };
  return <span className={`memory-telos-status-pill is-${status}`}>{labels[status] ?? status}</span>;
}

function DetailPlaceholder({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return <div className="memory-telos-placeholder"><Icon name="brain" size={22} /><h2>{title}</h2><p>{detail}</p></div>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }): React.JSX.Element {
  return <section className="memory-telos-empty-state"><Icon name="brain" size={24} /><h1>{title}</h1><p>{detail}</p>{action}</section>;
}

function blankTelosDraft(scope: DesktopTelosScope): TelosDraft {
  return { scope, mission: "", goals: [], principles: [], constraints: [], antiGoals: [] };
}

function telosDraftFromDocument(scope: DesktopTelosScope, document?: DesktopTelosDocument): TelosDraft {
  if (!document) return blankTelosDraft(scope);
  return { scope, mission: document.mission, goals: document.goals, principles: document.principles, constraints: document.constraints, antiGoals: document.antiGoals };
}

function blankFactDraft(): FactDraft {
  return { audience: "workspace", topic: "general", kind: "fact", title: "", summary: "", importance: 3 };
}

function factDraftFromEntry(entry: DesktopMemoryEntry): FactDraft {
  return { audience: entry.origin.kind === "user" ? "universal" : "workspace", topic: entry.topic, kind: entry.kind, title: entry.title, summary: entry.summary, importance: entry.importance };
}

function filterRecords<T>(records: T[], query: string, text: (record: T) => string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return records;
  return records.filter((record) => text(record).toLocaleLowerCase().includes(needle));
}

function lineageLabel(source: string): string {
  const labels: Record<string, string> = { explicit: "用户明确添加", explicit_edit: "用户编辑", completed_task: "成功任务", candidate: "候选整理", migration: "迁移", consolidation: "整理合并" };
  return labels[source] ?? source;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function makeId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `telos-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
