import { useCallback, useEffect, useState } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import type {
  DesktopMemoryEntriesPage,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopMemoryOriginFilter,
  DesktopMemorySearchMatch,
  DesktopMemoryStats,
  DesktopMemorySleepPreview
} from "../../../../protocol.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import { Icon } from "../Icon.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

interface SettingsMemoryProps {
  models: ModelChoice[];
  hidden?: boolean;
  workspaceAvailable: boolean;
  sessionRunning: boolean;
  onLoadStats(filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryStats>;
  onLoadEntries(filter: DesktopMemoryOriginFilter, offset: number, limit: number, includeArchived?: boolean): Promise<DesktopMemoryEntriesPage>;
  onSearch(filter: DesktopMemoryOriginFilter, query: string, includeArchived?: boolean): Promise<DesktopMemorySearchMatch[]>;
  onAdd(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryStats>;
  onUpdate(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryStats>;
  onDeleteEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryStats>;
  onArchiveEntry(entryId: string, archived: boolean, expectedRevision: number): Promise<DesktopMemoryStats>;
  onLoadArchived(): Promise<DesktopMemoryEntry[]>;
  onRunSleep(): Promise<DesktopMemoryStats>;
  onSleepStatus(): Promise<DesktopMemoryStats["maintenance"]>;
  onSleepRuns(): Promise<MemorySleepRun[]>;
  onPreviewSleep(): Promise<DesktopMemorySleepPreview>;
  onCancelSleep(): Promise<{ cancelled: boolean }>;
  onNotify(message: string): void;
}

const PAGE_SIZE = 100;
type MemoryFilter = "all";

export function SettingsMemory({
  models,
  hidden,
  workspaceAvailable,
  sessionRunning,
  onLoadStats,
  onLoadEntries,
  onSearch,
  onAdd,
  onUpdate,
  onDeleteEntry,
  onArchiveEntry,
  onLoadArchived,
  onRunSleep,
  onSleepStatus,
  onSleepRuns,
  onPreviewSleep,
  onCancelSleep,
  onNotify
}: SettingsMemoryProps): React.JSX.Element {
  const { draft, setMemory } = useSettingsDraft();
  const filter: MemoryFilter = "all";
  const [includeArchived, setIncludeArchived] = useState(false);
  const [stats, setStats] = useState<DesktopMemoryStats>();
  const [entries, setEntries] = useState<DesktopMemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; value: string }>();
  const [error, setError] = useState<string>();
  const [sleepRuns, setSleepRuns] = useState<MemorySleepRun[]>([]);
  const [sleepPreview, setSleepPreview] = useState<DesktopMemorySleepPreview>();
  const [sleepStatus, setSleepStatus] = useState<DesktopMemoryStats["maintenance"]>();
  const [archivedEntries, setArchivedEntries] = useState<DesktopMemoryEntry[]>([]);

  const reload = useCallback(async (nextFilter: MemoryFilter = filter, nextIncludeArchived = includeArchived): Promise<void> => {
    if (!workspaceAvailable) return;
    setLoading(true);
    try {
      const [nextStats, nextPage, status, runs, archived] = await Promise.all([
        onLoadStats(nextFilter),
        onLoadEntries(nextFilter, 0, PAGE_SIZE, nextIncludeArchived),
        onSleepStatus(),
        onSleepRuns(),
        onLoadArchived()
      ]);
      setStats(nextStats);
      setEntries(nextPage.entries);
      setSleepStatus(status);
      setSleepRuns(runs);
      setArchivedEntries(archived);
      setError(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [filter, includeArchived, onLoadArchived, onLoadEntries, onLoadStats, onSleepRuns, onSleepStatus, workspaceAvailable]);

  useEffect(() => { void reload(); }, [reload]);

  const search = async (): Promise<void> => {
    const value = query.trim();
    if (!value) return reload();
    setLoading(true);
    try {
      const matches = await onSearch(filter, value, includeArchived);
      setEntries(matches.map((match) => ({
        id: match.id,
        origin: match.origin,
        revision: stats?.revision ?? 0,
        topic: match.topic,
        kind: match.kind,
        importance: match.importance,
        title: match.excerpt.split("\n", 1)[0]?.slice(0, 120) || "记忆",
        summary: match.excerpt,
        decisions: [],
        paths: [],
        keywords: [],
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        lineage: match.lineage,
        recallCount: match.recallCount,
        lastRecalledAt: match.lastRecalledAt,
        archivedAt: match.archivedAt,
        archivedReason: match.archivedReason
      })));
      setError(undefined);
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const saveText = async (): Promise<void> => {
    const value = editor?.value.trim() ?? "";
    if (value.length < 20 || !stats || saving) return;
    setSaving(true);
    try {
      const editId = editor?.id;
      const next = editId
        ? await onUpdate(editId, { title: value.slice(0, 120), summary: value }, stats.revision)
        : await onAdd({
            audience: "universal",
            kind: "preference",
            topic: "memory",
            title: value.slice(0, 120),
            summary: value,
            decisions: [],
            paths: [],
            keywords: [],
            importance: 3,
            userEvidence: value
          }, stats.revision);
      setStats(next);
      setEditor(undefined);
      await reload();
      onNotify(editId ? "记忆已更新" : "记忆已添加");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    const archived = entry.archivedAt === undefined;
    setSaving(true);
    try {
      const next = await onArchiveEntry(entry.id, archived, stats.revision);
      setStats(next);
      await reload();
      onNotify(archived ? "记忆已归档" : "记忆已恢复");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const previewSleep = async (): Promise<void> => {
    try {
      const result = await onPreviewSleep();
      if (result.available) {
        setSleepPreview(result);
        onNotify(`本次整理将检查 ${result.candidates} 条候选，${result.temporaryToArchive} 条临时记忆待归档，${result.archivedToDelete} 条归档待删除`);
      } else {
        onNotify("当前无法预览整理");
      }
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const cancelSleep = async (): Promise<void> => {
    try {
      const result = await onCancelSleep();
      onNotify(result.cancelled ? "已取消记忆整理" : "当前没有正在进行的整理");
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const runSleep = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await onRunSleep();
      setStats(next);
      await reload();
      onNotify("记忆整理已完成");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    if (!window.confirm(`删除这条记忆？\n\n${entry.summary}`)) return;
    setSaving(true);
    try {
      const next = await onDeleteEntry(entry.id, stats.revision);
      setStats(next);
      await reload();
      onNotify("记忆已删除");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!workspaceAvailable) return <MemoryState title="请先选择项目" detail="打开项目后即可查看和管理记忆。" />;
  if (!draft) return <MemoryState title="正在加载记忆…" />;
  const policy = draft.memory;

  return (
    <div className="settings-sections activity-memory-settings" hidden={hidden}>
      <section className="activity-memory-header" id="memory-overview" tabIndex={-1}>
        <div>
          <h3>记忆</h3>
          <p>AI 记忆条目和上下文</p>
        </div>
        <SettingsCheckbox
          checked={policy.enabled}
          detail="关闭后暂停记忆读取和自动保存，已有记忆不会删除"
          label="启用记忆"
          onChange={(enabled) => setMemory({ ...policy, enabled })}
        />
      </section>

      {policy.enabled ? (
        <section className="activity-memory-config" id="memory-config" tabIndex={-1}>
          <SettingsCheckbox
            checked={policy.useMemories}
            detail="在对话上下文中自动检索相关记忆"
            label="使用记忆"
            onChange={(useMemories) => setMemory({ ...policy, useMemories })}
          />
          <SettingsCheckbox
            checked={policy.generateMemories}
            detail="从对话中自动提取重要信息并保存为新的记忆"
            label="自动创建记忆"
            onChange={(generateMemories) => setMemory({ ...policy, generateMemories })}
          />
          <SettingsCheckbox
            checked={policy.queryRewrite}
            detail="在搜索记忆前，用记忆工具模型优化对话式查询；失败时使用原问题。"
            label="查询改写"
            onChange={(queryRewrite) => setMemory({ ...policy, queryRewrite })}
          />
          <label className="activity-memory-limit">
            <span><strong>最大检索记忆数：{policy.maxRecalled}</strong><small>注入当前对话上下文的相关记忆数量（1–20）</small></span>
            <input aria-label="最大检索记忆数" type="range" min={1} max={20} value={policy.maxRecalled} onChange={(event) => setMemory({ ...policy, maxRecalled: Number(event.target.value) })} />
          </label>
          <label className="activity-memory-limit">
            <span><strong>相似度阈值</strong><small>越高越严格；只有足够相似的记忆才会被检索。</small></span>
            <input aria-label="相似度阈值" type="range" min={0} max={100} value={Math.round(policy.similarityThreshold * 100)} onChange={(event) => setMemory({ ...policy, similarityThreshold: Number(event.target.value) / 100 })} />
          </label>
          <label className="activity-memory-model">
            <span><strong>记忆工具模型</strong><small>为空时使用通用工具模型。</small></span>
            <select aria-label="记忆工具模型" value={policy.memoryModel ?? ""} onChange={(event) => setMemory({ ...policy, memoryModel: event.target.value || undefined })}>
              <option value="">跟随通用工具模型</option>
              {models.map((model) => <option key={model.alias} value={model.alias}>{model.displayName}</option>)}
            </select>
          </label>
          <label className="activity-memory-model"><span><strong>记忆睡眠</strong><small>每天在设定时间整理重复和相似的记忆。</small></span><input type="time" value={policy.sleepTime} onChange={(event) => setMemory({ ...policy, sleepTime: event.target.value })} /></label>
          <label className="activity-memory-limit"><span><strong>归档保留天数：{policy.archiveRetentionDays}</strong><small>归档记忆保留时间，之后仍可手动清理。</small></span><input aria-label="归档保留天数" type="range" min={1} max={3650} value={policy.archiveRetentionDays} onChange={(event) => setMemory({ ...policy, archiveRetentionDays: Number(event.target.value) })} /></label>
          <label className="activity-memory-limit"><span><strong>临时记忆 TTL：{policy.temporaryTtl} 天</strong><small>超过这段时间没有访问的临时记忆会进入归档。</small></span><input aria-label="临时记忆 TTL" type="range" min={1} max={3650} value={policy.temporaryTtl} onChange={(event) => setMemory({ ...policy, temporaryTtl: Number(event.target.value) })} /></label>
          <SettingsCheckbox checked={policy.useLlm} detail="让记忆工具模型判断模糊的相似记忆是否合并。" label="使用 LLM 合并相似记忆" onChange={(useLlm) => setMemory({ ...policy, useLlm })} />
          <label className="activity-memory-limit"><span><strong>LLM 批量大小：{policy.llmBatchSize}</strong><small>每次整理最多发送给模型的记忆数量。</small></span><input aria-label="LLM 批量大小" type="range" min={1} max={100} value={policy.llmBatchSize} onChange={(event) => setMemory({ ...policy, llmBatchSize: Number(event.target.value) })} /></label>
          <SettingsCheckbox checked={policy.sleepEnabled} detail="机器离线时，下一次启动后会安静地补做整理。" label="启用每日记忆整理" onChange={(sleepEnabled) => setMemory({ ...policy, sleepEnabled })} />
        </section>
      ) : null}

      <section className="activity-memory-add" id="memory-add" tabIndex={-1}>
        <h3>添加记忆</h3>
        <div className="activity-memory-add-box">
          <textarea
            aria-label="输入您希望 AI 记住的内容"
            disabled={!policy.enabled || sessionRunning || saving}
            onChange={(event) => setEditor({ value: event.target.value })}
            placeholder="输入您希望 AI 记住的内容..."
            rows={3}
            value={editor?.value ?? ""}
          />
          <div className="activity-memory-add-footer">
            <span>{editor?.id ? "正在编辑一条记忆" : "记忆会在后台整理"}</span>
            <button className="primary-button" disabled={!policy.enabled || saving || (editor?.value.trim().length ?? 0) < 20} onClick={() => { void saveText(); }} type="button">
              {saving ? "保存中…" : editor?.id ? "保存编辑" : "添加记忆"}
            </button>
          </div>
        </div>
      </section>

      <section className="activity-memory-list" id="memory-library" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>记忆列表</h3><p>{stats ? `${stats.totalEntries} 条记忆` : ""}</p></div>
          <label className="activity-memory-archived-toggle"><input checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); void reload(filter, event.target.checked); }} type="checkbox" /> 显示已归档</label>
          <button aria-label="刷新记忆" className="icon-button" disabled={loading || saving} onClick={() => { void reload(); }} type="button"><Icon name="refresh" size={14} /></button>
        </div>
        <div className="activity-memory-search">
          <Icon name="search" size={14} />
          <input aria-label="搜索记忆" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="搜索记忆" type="search" value={query} />
          {query ? <button aria-label="清除搜索" className="icon-button" onClick={() => { setQuery(""); void reload(); }} type="button"><Icon name="close" size={13} /></button> : null}
        </div>
        {error ? <p className="settings-effective-hint is-blocked">{error}</p> : null}
        {loading ? <p className="activity-memory-empty-hint">正在读取记忆…</p> : null}
        {!loading && !entries.length ? <p className="activity-memory-empty">暂无记忆。记忆会从您的对话中自动创建，或者您可以手动添加。</p> : null}
        <div className="activity-memory-entries">
          {entries.map((entry) => (
            <article className="activity-memory-entry" key={entry.id}>
              <div className="activity-memory-entry-content">
                <div className="activity-memory-entry-meta">
                  <span className={entry.lineage.some((lineage) => lineage.source === "explicit") ? "is-manual" : "is-auto"}>
                    {entry.lineage.some((lineage) => lineage.source === "explicit") ? "手动" : "自动"}
                  </span>
                  <span>{entry.kind === "preference" || entry.kind === "working_style" ? "永久" : "临时"}</span>
                  {entry.lineage.some((lineage) => lineage.sessionId) ? <span>来自聊天</span> : null}
                  {entry.archivedAt ? <span>已归档</span> : null}
                </div>
                <p>{entry.summary}</p>
                <small>{entry.recallCount} 次访问 · {formatDate(entry.updatedAt)}</small>
              </div>
              <div className="activity-memory-entry-actions">
                <button aria-label="编辑记忆" className="icon-button" disabled={saving || entry.archivedAt !== undefined} onClick={() => setEditor({ id: entry.id, value: entry.summary })} type="button"><Icon name="edit" size={13} /></button>
                <button aria-label={entry.archivedAt ? "恢复记忆" : "归档记忆"} className="icon-button" disabled={saving} onClick={() => { void archive(entry); }} type="button"><Icon name={entry.archivedAt ? "refresh" : "archive"} size={13} /></button>
                <button aria-label="删除记忆" className="icon-button" disabled={saving} onClick={() => { void remove(entry); }} type="button"><Icon name="trash" size={13} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="activity-memory-archive" id="memory-archive" tabIndex={-1}>
        <h3>已归档的记忆（{archivedEntries.length}）</h3>
        {archivedEntries.length === 0 ? <p>没有已归档的记忆。</p> : archivedEntries.slice(0, 20).map((entry) => (
          <article className="activity-memory-entry" key={entry.id}>
            <div className="activity-memory-entry-content"><p>{entry.summary}</p><small>{entry.archivedReason ?? "手动归档"} · {entry.archivedAt ? formatDate(entry.archivedAt) : ""}</small></div>
            <button aria-label="恢复记忆" className="ghost-button" disabled={saving} onClick={() => { void archive(entry); }} type="button">恢复</button>
          </article>
        ))}
      </section>

      <section className="activity-memory-sleep" id="memory-sleep" tabIndex={-1}>
        <div>
          <h3>记忆睡眠</h3>
          <p>每天整理重复、过期和相似的记忆；删除的条目可以从归档中恢复。</p>
          {stats?.maintenance.lastRun ? (
            <small className="activity-memory-sleep-detail">
              上次整理：{stats.maintenance.lastRun.examined} 条检查 · {stats.maintenance.lastRun.exact} 条完全重复 · {stats.maintenance.lastRun.expired} 条期限 · {stats.maintenance.lastRun.similarity} 条近似 · {stats.maintenance.lastRun.llm} 条 LLM 合并 · {stats.maintenance.lastRun.failed} 条失败
            </small>
          ) : null}
          {sleepPreview ? <small className="activity-memory-sleep-preview">预览：{sleepPreview.candidates} 条候选，{sleepPreview.temporaryToArchive} 条临时记忆待归档，{sleepPreview.archivedToDelete} 条归档待删除。</small> : null}
          {sleepRuns.length > 0 ? (
            <small className="activity-memory-sleep-history">最近周期：{sleepRuns.slice(-3).reverse().map((run) => `${run.examined} 检查 · ${run.exact} 完全重复 · ${run.expired} 期限 · ${run.similarity} 近似 · ${run.llm} LLM`).join("；")}</small>
          ) : null}
          {sleepStatus?.state === "running" ? <small className="activity-memory-sleep-history">整理正在运行…</small> : null}
        </div>
        <div className="activity-memory-sleep-actions">
          <small>{stats?.maintenance.lastRun?.finishedAt ? `上次整理：${formatDate(stats.maintenance.lastRun.finishedAt)}` : "后台自动运行"}</small>
          <div className="activity-memory-sleep-buttons">
            <button className="ghost-button" disabled={saving || sessionRunning} onClick={() => { void previewSleep(); }} type="button">预览</button>
            <button className="ghost-button" disabled={saving || sessionRunning} onClick={() => { void runSleep(); }} type="button">{saving ? "整理中…" : "立即运行"}</button>
            {saving ? <button className="ghost-button is-danger" onClick={() => { void cancelSleep(); }} type="button">取消</button> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function MemoryState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</section></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
