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

type MemoryEvolutionView = "overview" | "review" | "strategy" | "history";

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
  { id: "review", label: "待审核" },
  { id: "strategy", label: "长期策略" },
  { id: "history", label: "历史" }
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
    void refresh();
  }, [active, projectId, refresh]);

  const currentDocument = scope === "universal" ? overview?.universal : overview?.workspace;

  useEffect(() => {
    if (dirty) return;
    setDraft(telosDraftFromDocument(scope, currentDocument));
  }, [currentDocument, dirty, scope]);

  const patterns = useMemo(() => filterRecords(overview?.patterns ?? [], query, (pattern) => `${pattern.title} ${pattern.statement}`), [overview?.patterns, query]);
  const drifts = useMemo(() => filterRecords(overview?.drifts ?? [], query, (drift) => `${drift.title} ${drift.summary}`), [overview?.drifts, query]);

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
    }, message);
  }, [onReviewPattern, overview, run]);

  const resolveDrift = useCallback(async (drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): Promise<void> => {
    if (!overview) return;
    const message = action === "dismiss" ? "已忽略此类策略偏差" : action === "resolve" ? "策略偏差已处理" : "已记录你的调整方向";
    await run(`drift-${action}`, async () => {
      setOverview(await onResolveDrift(drift.id, action, overview.revision));
      if (action === "adjust_telos") setView("strategy");      if (action === "adjust_behavior") {
        onOpenChatDraft(`我想检查最近的行为是否偏离了长期策略。\n\n观察到：${drift.summary}\n\n请先帮我列出可能的行为调整方案，不要自动执行。`);
      }
    }, message);
  }, [onOpenChatDraft, onResolveDrift, overview, run]);

  const snoozeDrift = useCallback(async (drift: DesktopTelosDrift): Promise<void> => {
    if (!overview) return;
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    await run("drift-snooze", async () => {
      setOverview(await onSnoozeDrift(drift.id, until, overview.revision));
    }, "策略偏差已暂缓 7 天");
  }, [onSnoozeDrift, overview, run]);

  const changeScope = (nextScope: DesktopTelosScope): void => {
    if (nextScope === scope) return;
    if (dirty && !window.confirm("当前长期策略有未保存修改，切换范围会丢弃这些修改。继续吗？")) return;
    setScope(nextScope);
    setDirty(false);
  };

  const pendingReviewCount = (overview?.counts.candidatePatterns ?? 0) + (overview?.counts.openDrifts ?? 0);
  const healthText = overview
    ? pendingReviewCount > 0
      ? `${String(pendingReviewCount)} 项待审核 · ${String(overview.counts.openDrifts)} 条偏差待处理`
      : "状态健康 · 无待办"
    : "等待数据";

  return (
    <section aria-busy={loading || operation !== undefined} aria-labelledby="memory-evolution-title" className="memory-evolution-section" id="memory-evolution">
      <div className="section-heading-row memory-evolution-heading">
        <div>
          <h3 id="memory-evolution-title">记忆进化</h3>
          <p>长期策略由你确认保存；行为模式和策略偏差只作为可审核的推断。</p>
        </div>
        <div className="memory-evolution-status" aria-live="polite">
          <span className={`memory-evolution-health${pendingReviewCount > 0 ? " has-pending" : ""}`}>
            <span className="memory-evolution-health-dot" />
            {loading ? "同步中…" : error ? "同步失败" : healthText}
          </span>
          {overview ? <span className="memory-evolution-rev">revision {String(overview.revision)}</span> : null}
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
                {item.id === "review" && pendingReviewCount > 0 ? <span className="memory-evolution-tab-badge">{pendingReviewCount}</span> : null}
              </button>
            ))}
          </nav>
          {view === "overview" ? <EvolutionOverview overview={overview} onView={setView} /> : null}
          {view === "review" ? (
            <ReviewInbox
              drifts={drifts}
              onResolve={(drift, action) => { void resolveDrift(drift, action); }}
              onReview={(pattern, action) => { void reviewPattern(pattern, action); }}
              onSnooze={(drift) => { void snoozeDrift(drift); }}
              operation={operation}
              overview={overview}
              patterns={patterns}
              query={query}
              onQueryChange={setQuery}
            />
          ) : null}
          {view === "strategy" ? <StrategyEditor currentDocument={currentDocument} disabled={disabled} dirty={dirty} draft={draft} operation={operation} scope={scope} onChange={(next) => { setDraft(next); setDirty(true); }} onSave={() => { void saveStrategy(); }} onScopeChange={changeScope} /> : null}
          {view === "history" ? <EvolutionHistory overview={overview} /> : null}
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
      <div className="memory-evolution-metrics">
        <div className="memory-evolution-metric"><strong>{overview.counts.observations}</strong><span>脱敏观察</span><small>用于形成行为模式</small></div>
        <button className="memory-evolution-metric is-clickable" onClick={() => onView("review")} type="button"><strong>{overview.counts.candidatePatterns}</strong><span>待确认模式</span><small>等待你的审核 →</small></button>
        <div className="memory-evolution-metric"><strong>{overview.counts.confirmedPatterns}</strong><span>已确认模式</span><small>低优先级指导</small></div>
        <button className="memory-evolution-metric is-clickable" onClick={() => onView("review")} type="button"><strong>{overview.counts.openDrifts}</strong><span>待处理偏差</span><small>只提出选择 →</small></button>
      </div>
      <div className="memory-evolution-summary-card">
        <div className="memory-evolution-summary-head">
          <span className="memory-evolution-summary-meta">当前策略 · {document ? (document.scope === "workspace" ? "当前项目" : "通用") : "未设置"} · {document ? `rev ${String(document.revision)}` : "尚未保存"}</span>
          <button className="memory-evolution-link" onClick={() => onView("strategy")} type="button">编辑 →</button>
        </div>
        <div className="memory-evolution-summary-mission">{document?.mission || "还没有明确使命"}</div>
        <div className="memory-evolution-summary-meta">进行中目标 {String(activeGoals.length)} 项 · 约束 {String(document?.constraints.length ?? 0)} 条 · 反目标 {String(document?.antiGoals.length ?? 0)} 条</div>
      </div>
    </div>
  );
}


function ReviewInbox({ drifts, onResolve, onReview, onSnooze, operation, overview, patterns, query, onQueryChange }: {
  drifts: DesktopTelosDrift[];
  onResolve(drift: DesktopTelosDrift, action: DesktopTelosDriftResolutionAction): void;
  onReview(pattern: DesktopBehaviorPattern, action: DesktopBehaviorPatternReviewAction): void;
  onSnooze(drift: DesktopTelosDrift): void;
  operation?: string;
  overview: DesktopTelosOverview;
  patterns: DesktopBehaviorPattern[];
  query: string;
  onQueryChange(value: string): void;
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string>();
  const [kindFilter, setKindFilter] = useState<"all" | "patterns" | "drifts">("all");
  const candidates = patterns.filter((pattern) => pattern.status === "candidate");
  const openDrifts = drifts.filter((drift) => drift.status === "open");
  const items: Array<{ kind: "pattern" | "drift"; id: string; title: string; summary: string; time: string; evidence: DesktopTelosEvidence[]; pattern?: DesktopBehaviorPattern; drift?: DesktopTelosDrift }> = [
    ...candidates.map((pattern) => ({
      kind: "pattern" as const,
      id: `pattern:${pattern.id}`,
      title: pattern.title,
      summary: pattern.statement,
      time: pattern.updatedAt,
      evidence: pattern.evidence,
      pattern
    })),
    ...openDrifts.map((drift) => ({
      kind: "drift" as const,
      id: `drift:${drift.id}`,
      title: drift.title,
      summary: drift.summary,
      time: drift.updatedAt,
      evidence: drift.evidence,
      drift
    }))
  ];
  const filtered = items
    .filter((item) => kindFilter === "all" || (kindFilter === "patterns" ? item.kind === "pattern" : item.kind === "drift"))
    .filter((item) => {
      const needle = query.trim().toLocaleLowerCase();
      return !needle || `${item.title} ${item.summary}`.toLocaleLowerCase().includes(needle);
    })
    .sort((left, right) => right.time.localeCompare(left.time));
  void overview;

  return (
    <div className="memory-review-inbox">
      <div className="memory-review-inbox-head">
        <h4>待审核</h4>
        <div className="memory-review-inbox-filters">
          <select aria-label="筛选审核类型" onChange={(event) => setKindFilter(event.target.value as "all" | "patterns" | "drifts")} value={kindFilter}>
            <option value="all">全部</option>
            <option value="patterns">待确认模式</option>
            <option value="drifts">策略偏差</option>
          </select>
          <label className="memory-review-inbox-search"><Icon name="search" size={14} /><input aria-label="搜索待审核" onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索…" type="search" value={query} /></label>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="memory-review-empty"><span className="memory-review-empty-tick">✓</span>没有待审核的推断。系统状态健康。</div>
      ) : filtered.map((item) => {
        const isOpen = openId === item.id;
        const busy = operation !== undefined;
        return (
          <article className={`memory-review-item${isOpen ? " is-open" : ""}`} key={item.id}>
            <button className="memory-review-item-main" onClick={() => setOpenId(isOpen ? undefined : item.id)} type="button">
              <span className="memory-review-item-top">
                <span className={`memory-review-kind is-${item.kind}`}>{item.kind === "pattern" ? <><Icon name="brain" size={13} /> 待确认模式</> : <><Icon name="warning" size={13} /> 策略偏差</>}</span>
                <span className="memory-review-time">{formatDate(item.time)}</span>
              </span>
              <span className="memory-review-title">{item.title}</span>
              <span className="memory-review-summary">{item.summary}</span>
            </button>
            <div className="memory-review-actions">
              {item.kind === "pattern" && item.pattern ? (
                <>
                  <button className="ghost-button" disabled={busy} onClick={() => onReview(item.pattern!, "reject")} type="button">拒绝</button>
                  <button className="ghost-button" disabled={busy} onClick={() => onReview(item.pattern!, "expire")} type="button">标记过期</button>
                  <button className="primary-button" disabled={busy} onClick={() => onReview(item.pattern!, "confirm")} type="button">确认采用</button>
                </>
              ) : null}
              {item.kind === "drift" && item.drift ? (
                <>
                  <button className="ghost-button" disabled={busy} onClick={() => onSnooze(item.drift!)} type="button">稍后 7 天</button>
                  <button className="ghost-button" disabled={busy} onClick={() => onResolve(item.drift!, "dismiss")} type="button">忽略</button>
                  <button className="primary-button" disabled={busy} onClick={() => onResolve(item.drift!, item.drift!.suggestedAction === "adjust_telos" ? "adjust_telos" : "adjust_behavior")} type="button">{item.drift.suggestedAction === "adjust_telos" ? "调整目标" : "调整行为"}</button>
                </>
              ) : null}
            </div>
            {isOpen ? <div className="memory-review-evidence"><EvidenceTimeline items={item.evidence} /></div> : null}
          </article>
        );
      })}
    </div>
  );
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

function EvolutionHistory({ overview }: { overview: DesktopTelosOverview }): React.JSX.Element {
  const items = [...overview.patterns, ...overview.drifts]
    .flatMap((record) => record.evidence.map((evidence) => ({ evidence, source: record.title })))
    .sort((left, right) => right.evidence.observedAt.localeCompare(left.evidence.observedAt));
  return (
    <div className="memory-evolution-history">
      {items.length === 0
        ? <MemoryEvolutionState detail="确认模式或处理偏差后，相关证据会出现在这里。" title="暂无证据" />
        : (
          <div className="memory-evolution-history-list">
            {items.map(({ evidence, source }) => (
              <div className="memory-evolution-history-row" key={evidence.id}>
                <span className="memory-evolution-history-dot" />
                <div>
                  <p>{evidence.summary}</p>
                  <small>{formatDate(evidence.observedAt)} · 关联「{source}」 · {evidence.externalContext ? "含外部上下文" : "本地协作"}</small>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}







function EvidenceTimeline({ items }: { items: DesktopTelosEvidence[] }): React.JSX.Element {
  return <section aria-label="来源证据" className="memory-telos-evidence"><div className="memory-telos-evidence-heading"><span>来源与证据</span><small>{items.length} 条</small></div>{items.length ? <ol>{items.map((item) => <li key={item.id}><span className="memory-telos-evidence-dot" /><div><p>{item.summary}</p><small>{formatDate(item.observedAt)} · {item.externalContext ? "含外部上下文" : "本地协作"}{item.sessionId ? ` · session ${item.sessionId.slice(0, 8)}` : ""}{item.turnId ? ` · turn ${item.turnId.slice(0, 8)}` : ""}{item.runId ? ` · run ${item.runId.slice(0, 8)}` : ""}</small></div></li>)}</ol> : <p className="memory-telos-empty">没有可展示的证据。</p>}</section>;
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


function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function makeId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
