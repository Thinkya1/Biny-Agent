/**
 * 设置页中的记忆进化管理。
 *
 * 这里统一承载长期策略、行为模式和策略偏差，不新增主界面路由。长期策略是用户
 * 明确保存的内容；行为模式和偏差始终展示来源与状态，避免把模型推断伪装成事实。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopBehaviorPattern,
  DesktopBehaviorPatternReviewAction,
  DesktopTelosDocument,
  DesktopTelosDocumentInput,
  DesktopTelosDrift,
  DesktopTelosDriftResolutionAction,
  DesktopTelosEvidence,
  DesktopTelosOverview,
  DesktopTelosScope
} from "../../../../protocol.js";
import { Icon } from "../Icon.js";

type MemoryEvolutionView = "overview" | "patterns" | "strategy" | "drifts";

interface TelosDraft {
  scope: DesktopTelosScope;
  mission: string;
  goals: DesktopTelosDocument["goals"];
  principles: DesktopTelosDocument["principles"];
  constraints: DesktopTelosDocument["constraints"];
  antiGoals: DesktopTelosDocument["antiGoals"];
}

interface MemoryEvolutionSectionProps {
  active: boolean;
  disabled: boolean;
  projectId?: string;
  onLoad(): Promise<DesktopTelosOverview>;
  onSave(input: DesktopTelosDocumentInput, expectedRevision: number): Promise<DesktopTelosOverview>;
  onReviewPattern(patternId: string, action: DesktopBehaviorPatternReviewAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onResolveDrift(driftId: string, action: DesktopTelosDriftResolutionAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onSnoozeDrift(driftId: string, until: string, expectedRevision: number): Promise<DesktopTelosOverview>;
  onOpenChatDraft(input: string): void;
  onNotify(message: string): void;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

const viewItems: ReadonlyArray<{ id: MemoryEvolutionView; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "patterns", label: "行为模式" },
  { id: "strategy", label: "长期策略" },
  { id: "drifts", label: "策略偏差" }
];

export function MemoryEvolutionSection({
  active,
  disabled,
  projectId,
  onLoad,
  onSave,
  onReviewPattern,
  onResolveDrift,
  onSnoozeDrift,
  onOpenChatDraft,
  onNotify
}: MemoryEvolutionSectionProps): React.JSX.Element {
  const [view, setView] = useState<MemoryEvolutionView>("overview");
  const [scope, setScope] = useState<DesktopTelosScope>("workspace");
  const [overview, setOverview] = useState<DesktopTelosOverview>();
  const [draft, setDraft] = useState<TelosDraft>(() => blankDraft("workspace"));
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPatternId, setSelectedPatternId] = useState<string>();
  const [selectedDriftId, setSelectedDriftId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState<string>();
  const requestGenerationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    if (!projectId) {
      setOverview(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = await onLoad();
      if (requestGenerationRef.current === generation) setOverview(next);
    } catch (cause) {
      if (requestGenerationRef.current === generation) setError(errorText(cause));
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [onLoad, projectId]);

  useEffect(() => {
    if (!active) return;
    setView("overview");
    setScope("workspace");
    setDraft(blankDraft("workspace"));
    setDirty(false);
    setQuery("");
    setSelectedPatternId(undefined);
    setSelectedDriftId(undefined);
    void refresh();
  }, [active, projectId, refresh]);

  const currentDocument = scope === "universal" ? overview?.universal : overview?.workspace;

  useEffect(() => {
    if (dirty) return;
    setDraft(telosDraftFromDocument(scope, currentDocument));
  }, [currentDocument, dirty, scope]);

  const patterns = useMemo(() => filterRecords(overview?.patterns ?? [], query, (pattern) => `${pattern.title} ${pattern.statement}`), [overview?.patterns, query]);
  const drifts = useMemo(() => filterRecords(overview?.drifts ?? [], query, (drift) => `${drift.title} ${drift.summary}`), [overview?.drifts, query]);
  const selectedPattern = overview?.patterns.find((pattern) => pattern.id === selectedPatternId);
  const selectedDrift = overview?.drifts.find((drift) => drift.id === selectedDriftId);

  const run = useCallback(async (name: string, work: () => Promise<void>, success: string): Promise<void> => {
    if (disabled || operation !== undefined) return;
    setOperation(name);
    setError(undefined);
    try {
      await work();
      onNotify(success);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOperation(undefined);
    }
  }, [disabled, onNotify, operation]);

  const saveStrategy = useCallback(async (): Promise<void> => {
    if (!overview) return;
    const input: DesktopTelosDocumentInput = {
      scope: draft.scope,
      mission: draft.mission,
      goals: draft.goals,
      principles: draft.principles,
      constraints: draft.constraints,
      antiGoals: draft.antiGoals
    };
    await run("telos-save", async () => {
      setOverview(await onSave(input, overview.revision));
      setDirty(false);
    }, "长期策略已保存，已生成新的版本");
  }, [draft, onSave, overview, run]);

  const reviewPattern = useCallback(async (pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): Promise<void> => {
    if (!overview) return;
    const message = action === "confirm" ? "行为模式已确认" : action === "reject" ? "行为模式已拒绝" : "行为模式已标记过期";
    await run(`pattern-${action}`, async () => {
      setOverview(await onReviewPattern(pattern.id, action, overview.revision));
      setSelectedPatternId(pattern.id);
    }, message);
  }, [onReviewPattern, overview, run]);

  const resolveDrift = useCallback(async (drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): Promise<void> => {
    if (!overview) return;
    const message = action === "dismiss" ? "已忽略此类策略偏差" : action === "resolve" ? "策略偏差已处理" : "已记录你的调整方向";
    await run(`drift-${action}`, async () => {
      setOverview(await onResolveDrift(drift.id, action, overview.revision));
      setSelectedDriftId(drift.id);
      if (action === "adjust_telos") setView("strategy");
      if (action === "adjust_behavior") {
        onOpenChatDraft(`我想检查最近的行为是否偏离了长期策略。\n\n观察到：${drift.summary}\n\n请先帮我列出可能的行为调整方案，不要自动执行。`);
      }
    }, message);
  }, [onOpenChatDraft, onResolveDrift, overview, run]);

  const snoozeDrift = useCallback(async (drift: DesktopTelosDrift): Promise<void> => {
    if (!overview) return;
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    await run("drift-snooze", async () => {
      setOverview(await onSnoozeDrift(drift.id, until, overview.revision));
      setSelectedDriftId(drift.id);
    }, "策略偏差已暂缓 7 天");
  }, [onSnoozeDrift, overview, run]);

  const changeScope = (nextScope: DesktopTelosScope): void => {
    if (nextScope === scope) return;
    if (dirty && !window.confirm("当前长期策略有未保存修改，切换范围会丢弃这些修改。继续吗？")) return;
    setScope(nextScope);
    setDirty(false);
  };

  return (
    <section aria-busy={loading || operation !== undefined} aria-labelledby="memory-evolution-title" className="memory-evolution-section" id="memory-evolution">
      <div className="section-heading-row memory-evolution-heading">
        <div>
          <h3 id="memory-evolution-title">记忆进化</h3>
          <p>长期策略由你确认保存；行为模式和策略偏差只作为可审核的推断。</p>
        </div>
        <div className="memory-evolution-status" aria-live="polite">
          {loading ? "同步中…" : error ? "同步失败" : overview ? `revision ${String(overview.revision)}` : "等待数据"}
          <button aria-label="刷新记忆进化" className="icon-button" disabled={loading || operation !== undefined || disabled} onClick={() => { void refresh(); }} title="刷新" type="button"><Icon name="refresh" size={14} /></button>
        </div>
      </div>
      {!projectId ? <MemoryEvolutionState detail="记忆进化需要当前项目上下文。" title="请先选择项目" /> : null}
      {projectId && error && !overview ? <div aria-live="polite" role="alert"><MemoryEvolutionState detail={error} title="无法加载记忆进化" action={<button className="ghost-button" onClick={() => { void refresh(); }} type="button">重试</button>} /></div> : null}
      {projectId && !overview && !error ? <MemoryEvolutionState detail="正在读取长期策略、行为模式和偏差。" title="正在加载…" /> : null}
      {overview ? (
        <>
          <nav aria-label="记忆进化分区" className="memory-telos-tabs memory-evolution-tabs" role="tablist">
            {viewItems.map((item) => (
              <button aria-selected={view === item.id} className={view === item.id ? "is-selected" : ""} key={item.id} onClick={() => setView(item.id)} role="tab" type="button">
                {item.label}
                {item.id === "patterns" ? <small>{overview.counts.candidatePatterns}</small> : null}
                {item.id === "drifts" ? <small>{overview.counts.openDrifts}</small> : null}
              </button>
            ))}
          </nav>
          {view === "overview" ? <EvolutionOverview overview={overview} onView={setView} /> : null}
          {view === "patterns" ? <PatternBrowser patterns={patterns} query={query} selected={selectedPattern} operation={operation} onQueryChange={setQuery} onSelect={(pattern) => setSelectedPatternId(pattern.id)} onReview={(pattern, action) => { void reviewPattern(pattern, action); }} /> : null}
          {view === "strategy" ? <StrategyEditor currentDocument={currentDocument} disabled={disabled} dirty={dirty} draft={draft} operation={operation} scope={scope} onChange={(next) => { setDraft(next); setDirty(true); }} onSave={() => { void saveStrategy(); }} onScopeChange={changeScope} /> : null}
          {view === "drifts" ? <DriftBrowser drifts={drifts} query={query} selected={selectedDrift} operation={operation} onQueryChange={setQuery} onSelect={(drift) => setSelectedDriftId(drift.id)} onResolve={(drift, action) => { void resolveDrift(drift, action); }} onSnooze={(drift) => { void snoozeDrift(drift); }} /> : null}
        </>
      ) : null}
    </section>
  );
}

function EvolutionOverview({ overview, onView }: { overview: DesktopTelosOverview; onView(view: MemoryEvolutionView): void }): React.JSX.Element {
  const document = overview.workspace ?? overview.universal;
  const activeGoals = document?.goals.filter((goal) => goal.status === "active") ?? [];
  return (
    <div className="memory-evolution-overview">
      <div className="memory-telos-intro"><div><span className="memory-telos-eyebrow">可确认的长期方向</span><h4>AI 记住事实，也尊重你的方向</h4><p>事实可以自动产生；行为模式是推断；长期策略只有在你点击保存后才会改变。</p></div><button className="primary-button" onClick={() => onView("strategy")} type="button">编辑长期策略</button></div>
      <div className="memory-telos-metrics">
        <Metric label="脱敏观察" value={overview.counts.observations} detail="用于形成行为模式" />
        <Metric label="待确认模式" value={overview.counts.candidatePatterns} detail="等待你的审核" onClick={() => onView("patterns")} />
        <Metric label="已确认模式" value={overview.counts.confirmedPatterns} detail="低优先级指导" onClick={() => onView("patterns")} />
        <Metric label="待处理偏差" value={overview.counts.openDrifts} detail="只提出选择" onClick={() => onView("drifts")} />
      </div>
      <div className="memory-telos-overview-grid">
        <article className="memory-telos-card"><span className="memory-telos-card-label">当前使命</span><strong>{document?.mission || "还没有明确使命"}</strong><small>{document ? `${document.scope === "workspace" ? "当前项目" : "通用"} · revision ${String(document.revision)}` : "在长期策略中添加"}</small></article>
        <article className="memory-telos-card"><span className="memory-telos-card-label">当前目标</span>{activeGoals.length ? <ul>{activeGoals.slice(0, 3).map((goal) => <li key={goal.id}>{goal.text}</li>)}</ul> : <strong className="is-muted">还没有进行中的目标</strong>}</article>
        <article className="memory-telos-card"><span className="memory-telos-card-label">边界</span><p>{document?.constraints[0]?.text ?? "尚未设置约束"}</p><small>{document?.antiGoals.length ? `反目标 ${String(document.antiGoals.length)} 条` : "可在编辑器中维护反目标"}</small></article>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, onClick }: { label: string; value: number; detail: string; onClick?: () => void }): React.JSX.Element {
  const content = <><span>{label}</span><strong>{value}</strong><small>{detail}</small></>;
  return onClick ? <button className="memory-telos-metric" onClick={onClick} type="button">{content}</button> : <div className="memory-telos-metric is-static">{content}</div>;
}

function PatternBrowser({ patterns, query, selected, operation, onQueryChange, onSelect, onReview }: { patterns: DesktopBehaviorPattern[]; query: string; selected?: DesktopBehaviorPattern; operation?: string; onQueryChange(value: string): void; onSelect(pattern: DesktopBehaviorPattern): void; onReview(pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): void }): React.JSX.Element {
  return <EvolutionSplitPanel count={patterns.length} empty="还没有行为模式观察。开启“自动观察行为模式”后，成功完成的协作会形成候选。" heading="行为模式" list={<><EvolutionSearch label="搜索行为模式" placeholder="搜索模式描述" value={query} onChange={onQueryChange} />{patterns.map((pattern) => <button className={`memory-telos-list-item${selected?.id === pattern.id ? " is-selected" : ""}`} key={pattern.id} onClick={() => onSelect(pattern)} type="button"><span className="memory-telos-list-item-top"><strong>{pattern.title}</strong><StatusPill status={pattern.status} /></span><span>{pattern.statement}</span><small>{pattern.evidenceCount} 次观察 · 置信度 {Math.round(pattern.confidence * 100)}% · {formatDate(pattern.updatedAt)}</small></button>)}</>} detail={selected ? <PatternDetail operation={operation} pattern={selected} onReview={onReview} /> : <EvolutionPlaceholder title="选择一个行为模式" detail="行为模式是 AI 的推断，不等同于事实，也不能自动改变你的长期策略。" />} />;
}

function PatternDetail({ pattern, operation, onReview }: { pattern: DesktopBehaviorPattern; operation?: string; onReview(pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): void }): React.JSX.Element {
  return <EvolutionArticle eyebrow="推断 · 行为模式" title={pattern.title} actions={pattern.status === "candidate" ? <><button className="ghost-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "reject")} type="button">拒绝</button><button className="primary-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "confirm")} type="button">确认模式</button></> : <button className="ghost-button" disabled={operation !== undefined} onClick={() => onReview(pattern, "expire")} type="button">标记过期</button>}><p className="memory-telos-detail-summary">{pattern.statement}</p><EvolutionMeta items={[["状态", statusLabel(pattern.status)], ["置信度", `${String(Math.round(pattern.confidence * 100))}%`], ["观察次数", String(pattern.evidenceCount)], ["时间范围", `${formatDate(pattern.firstObservedAt)} — ${formatDate(pattern.lastObservedAt)}`], ["范围", pattern.scope === "workspace" ? "当前项目" : "通用"]]} /><EvidenceTimeline items={pattern.evidence} /></EvolutionArticle>;
}

function StrategyEditor({ currentDocument, disabled, dirty, draft, operation, scope, onChange, onSave, onScopeChange }: { currentDocument?: DesktopTelosDocument; disabled: boolean; dirty: boolean; draft: TelosDraft; operation?: string; scope: DesktopTelosScope; onChange(draft: TelosDraft): void; onSave(): void; onScopeChange(scope: DesktopTelosScope): void }): React.JSX.Element {
  const updateRules = (key: "principles" | "constraints" | "antiGoals", index: number, text: string): void => onChange({ ...draft, [key]: draft[key].map((item, itemIndex) => itemIndex === index ? { ...item, text } : item) });
  const addRule = (key: "principles" | "constraints" | "antiGoals"): void => onChange({ ...draft, [key]: [...draft[key], { id: makeId(), text: "" }] });
  const removeRule = (key: "principles" | "constraints" | "antiGoals", index: number): void => onChange({ ...draft, [key]: draft[key].filter((_, itemIndex) => itemIndex !== index) });
  return <section aria-labelledby="memory-strategy-editor-title" className="memory-telos-editor memory-evolution-editor"><div className="memory-telos-editor-sidebar"><span className="memory-telos-eyebrow">用户确认层</span><h4 id="memory-strategy-editor-title">长期策略</h4><p>这里写你希望长期遵循的方向。AI 可以提出草稿，但不会代替你保存。</p><div aria-label="策略范围" className="memory-telos-scope-switch" role="tablist"><button aria-selected={scope === "universal"} className={scope === "universal" ? "is-selected" : ""} onClick={() => onScopeChange("universal")} role="tab" type="button">通用策略</button><button aria-selected={scope === "workspace"} className={scope === "workspace" ? "is-selected" : ""} onClick={() => onScopeChange("workspace")} role="tab" type="button">当前项目</button></div><div className="memory-telos-revision-note">{currentDocument ? `已保存 revision ${String(currentDocument.revision)} · ${formatDate(currentDocument.updatedAt)}` : "此范围还没有长期策略"}{dirty ? <strong>有未保存修改</strong> : null}</div></div><form className="memory-telos-editor-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="memory-telos-form-heading"><div><span className="memory-telos-eyebrow">结构化编辑</span><h5>{scope === "universal" ? "通用长期策略" : "当前项目长期策略"}</h5></div><button className="primary-button" disabled={!dirty || disabled || operation !== undefined} type="submit">{operation === "telos-save" ? "保存中…" : "保存 revision"}</button></div><label className="memory-telos-form-wide">使命<textarea autoComplete="off" disabled={disabled} name="telos-mission" onChange={(event) => onChange({ ...draft, mission: event.target.value })} placeholder="例如：构建一个可持续的长期产品…" rows={4} value={draft.mission} /></label><TelosGoals disabled={disabled} goals={draft.goals} onChange={(goals) => onChange({ ...draft, goals })} /><RuleEditor disabled={disabled} label="原则" items={draft.principles} onAdd={() => addRule("principles")} onChange={(index, text) => updateRules("principles", index, text)} onRemove={(index) => removeRule("principles", index)} /><RuleEditor disabled={disabled} label="约束" items={draft.constraints} onAdd={() => addRule("constraints")} onChange={(index, text) => updateRules("constraints", index, text)} onRemove={(index) => removeRule("constraints", index)} /><RuleEditor disabled={disabled} label="反目标" items={draft.antiGoals} onAdd={() => addRule("antiGoals")} onChange={(index, text) => updateRules("antiGoals", index, text)} onRemove={(index) => removeRule("antiGoals", index)} /></form></section>;
}

function TelosGoals({ disabled, goals, onChange }: { disabled: boolean; goals: DesktopTelosDocument["goals"]; onChange(goals: DesktopTelosDocument["goals"]): void }): React.JSX.Element {
  return <fieldset className="memory-telos-fieldset" disabled={disabled}><legend>当前目标</legend>{goals.map((goal, index) => <div className="memory-telos-goal-row" key={goal.id}><input aria-label={`目标 ${String(index + 1)}`} autoComplete="off" name={`telos-goal-${String(index + 1)}`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} placeholder="目标内容…" value={goal.text} /><select aria-label={`目标 ${String(index + 1)} 状态`} name={`telos-goal-status-${String(index + 1)}`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, status: event.target.value as DesktopTelosDocument["goals"][number]["status"] } : item))} value={goal.status}><option value="active">进行中</option><option value="paused">暂停</option><option value="completed">完成</option></select><input aria-label={`目标 ${String(index + 1)} 时间范围`} autoComplete="off" name={`telos-goal-horizon-${String(index + 1)}`} onChange={(event) => onChange(goals.map((item, itemIndex) => itemIndex === index ? { ...item, horizon: event.target.value } : item))} placeholder="时间范围（可选）…" value={goal.horizon ?? ""} /><button aria-label={`删除目标 ${String(index + 1)}`} className="icon-button" onClick={() => onChange(goals.filter((_, itemIndex) => itemIndex !== index))} type="button"><Icon name="trash" size={13} /></button></div>)}<button className="ghost-button" onClick={() => onChange([...goals, { id: makeId(), text: "", status: "active" }])} type="button"><Icon name="add" size={13} /> 添加目标</button></fieldset>;
}

function RuleEditor({ disabled, label, items, onAdd, onChange, onRemove }: { disabled: boolean; label: string; items: DesktopTelosDocument["principles"]; onAdd(): void; onChange(index: number, text: string): void; onRemove(index: number): void }): React.JSX.Element {
  return <fieldset className="memory-telos-fieldset" disabled={disabled}><legend>{label}</legend>{items.map((item, index) => <div className="memory-telos-rule-row" key={item.id}><textarea aria-label={`${label} ${String(index + 1)}`} autoComplete="off" name={`telos-${label}-${String(index + 1)}`} onChange={(event) => onChange(index, event.target.value)} placeholder={`添加一条${label}…`} rows={2} value={item.text} /><button aria-label={`删除${label} ${String(index + 1)}`} className="icon-button" onClick={() => onRemove(index)} type="button"><Icon name="trash" size={13} /></button></div>)}<button className="ghost-button" onClick={onAdd} type="button"><Icon name="add" size={13} /> 添加{label}</button></fieldset>;
}

function DriftBrowser({ drifts, query, selected, operation, onQueryChange, onSelect, onResolve, onSnooze }: { drifts: DesktopTelosDrift[]; query: string; selected?: DesktopTelosDrift; operation?: string; onQueryChange(value: string): void; onSelect(drift: DesktopTelosDrift): void; onResolve(drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): void; onSnooze(drift: DesktopTelosDrift): void }): React.JSX.Element {
  return <EvolutionSplitPanel count={drifts.length} empty="还没有策略偏差提案。已确认的行为模式达到阈值后才会生成。" heading="策略偏差" list={<><EvolutionSearch label="搜索策略偏差" placeholder="搜索偏差或建议" value={query} onChange={onQueryChange} />{drifts.map((drift) => <button className={`memory-telos-list-item${selected?.id === drift.id ? " is-selected" : ""}`} key={drift.id} onClick={() => onSelect(drift)} type="button"><span className="memory-telos-list-item-top"><strong>{drift.title}</strong><StatusPill status={drift.status} /></span><span>{drift.summary}</span><small>策略版本 {String(drift.telosRevision)} · {formatDate(drift.updatedAt)}</small></button>)}</>} detail={selected ? <DriftDetail drift={selected} operation={operation} onResolve={onResolve} onSnooze={onSnooze} /> : <EvolutionPlaceholder title="选择一条策略偏差" detail="偏差只提出选择，不会自动调整目标或执行行为。" />} />;
}

function DriftDetail({ drift, operation, onResolve, onSnooze }: { drift: DesktopTelosDrift; operation?: string; onResolve(drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): void; onSnooze(drift: DesktopTelosDrift): void }): React.JSX.Element {
  const closed = drift.status === "dismissed" || drift.status === "resolved";
  return <EvolutionArticle eyebrow="策略偏差提案" title={drift.title} actions={closed ? <StatusPill status={drift.status} /> : <><button className="ghost-button" disabled={operation !== undefined} onClick={() => onSnooze(drift)} type="button">稍后 7 天</button><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "dismiss")} type="button">忽略</button><button className="primary-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "adjust_telos")} type="button">调整目标</button></>}><p className="memory-telos-detail-summary">{drift.summary}</p><EvolutionMeta items={[["状态", statusLabel(drift.status)], ["关联策略", `版本 ${String(drift.telosRevision)}`], ["建议方向", drift.suggestedAction === "adjust_telos" ? "检查目标或原则" : "检查行为"], ["创建时间", formatDate(drift.createdAt)]]} /><EvidenceTimeline items={drift.evidence} />{!closed ? <div className="memory-telos-detail-actions"><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "adjust_behavior")} type="button">调整行为（打开聊天草稿）</button><button className="ghost-button" disabled={operation !== undefined} onClick={() => onResolve(drift, "resolve")} type="button">标记已处理</button></div> : null}</EvolutionArticle>;
}

function EvolutionSplitPanel({ heading, count, list, detail, empty }: { heading: string; count: number; list: React.ReactNode; detail: React.ReactNode; empty: string }): React.JSX.Element {
  return <section aria-label={heading} className="memory-telos-split memory-evolution-split"><aside className="memory-telos-list-pane"><div className="memory-telos-list-heading"><div><span className="memory-telos-eyebrow">浏览器</span><h4>{heading}</h4></div><span>{count}</span></div>{count ? list : <p className="memory-telos-empty">{empty}</p>}</aside><article className="memory-telos-detail-pane">{detail}</article></section>;
}

function EvolutionSearch({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange(value: string): void }): React.JSX.Element {
  return <label className="memory-telos-search"><Icon name="search" size={14} /><input aria-label={label} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type="search" value={value} /></label>;
}

function EvolutionArticle({ eyebrow, title, actions, children }: { eyebrow: string; title: string; actions?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <div className="memory-telos-detail"><div className="memory-telos-detail-heading"><div><span className="memory-telos-eyebrow">{eyebrow}</span><h4>{title}</h4></div>{actions ? <div className="memory-telos-detail-buttons">{actions}</div> : null}</div>{children}</div>;
}

function EvolutionMeta({ items }: { items: Array<[string, string]> }): React.JSX.Element {
  return <dl className="memory-telos-meta">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function EvidenceTimeline({ items }: { items: DesktopTelosEvidence[] }): React.JSX.Element {
  return <section aria-label="来源证据" className="memory-telos-evidence"><div className="memory-telos-evidence-heading"><span>来源与证据</span><small>{items.length} 条</small></div>{items.length ? <ol>{items.map((item) => <li key={item.id}><span className="memory-telos-evidence-dot" /><div><p>{item.summary}</p><small>{formatDate(item.observedAt)} · {item.externalContext ? "含外部上下文" : "本地协作"}{item.sessionId ? ` · session ${item.sessionId.slice(0, 8)}` : ""}{item.turnId ? ` · turn ${item.turnId.slice(0, 8)}` : ""}{item.runId ? ` · run ${item.runId.slice(0, 8)}` : ""}</small></div></li>)}</ol> : <p className="memory-telos-empty">没有可展示的证据。</p>}</section>;
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  return <span className={`memory-telos-status-pill is-${status}`}>{statusLabel(status)}</span>;
}

function EvolutionPlaceholder({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return <div className="memory-telos-placeholder"><Icon name="brain" size={22} /><h4>{title}</h4><p>{detail}</p></div>;
}

function MemoryEvolutionState({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }): React.JSX.Element {
  return <div className="memory-evolution-state"><Icon name="brain" size={20} /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{action}</div>;
}

function blankDraft(scope: DesktopTelosScope): TelosDraft {
  return { scope, mission: "", goals: [], principles: [], constraints: [], antiGoals: [] };
}

function telosDraftFromDocument(scope: DesktopTelosScope, document?: DesktopTelosDocument): TelosDraft {
  if (!document) return blankDraft(scope);
  return {
    scope,
    mission: document.mission,
    goals: document.goals.map((goal) => ({ ...goal })),
    principles: document.principles.map((rule) => ({ ...rule })),
    constraints: document.constraints.map((rule) => ({ ...rule })),
    antiGoals: document.antiGoals.map((rule) => ({ ...rule }))
  };
}

function filterRecords<T>(records: T[], query: string, text: (record: T) => string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return records;
  return records.filter((record) => text(record).toLocaleLowerCase().includes(needle));
}

function statusLabel(status: string): string {
  return {
    candidate: "待确认",
    confirmed: "已确认",
    rejected: "已拒绝",
    expired: "已过期",
    open: "开放",
    snoozed: "已暂缓",
    dismissed: "已忽略",
    resolved: "已处理"
  }[status] ?? status;
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function makeId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
