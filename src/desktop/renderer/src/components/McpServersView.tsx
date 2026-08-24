/**
 * MCP 服务器管理页。
 *
 * 页面只保存当前编辑中的临时表单值；已保存的环境变量和请求头由主进程脱敏投影，
 * 保存时通过一次性 IPC 传入并落到 Keychain，渲染层不会把凭据写入配置或快照。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopMcpCatalogEntry,
  DesktopMcpCatalogInstallation,
  DesktopMcpCatalogState,
  DesktopMcpFieldAction,
  DesktopMcpFieldMutation,
  DesktopMcpRemoteProtocol,
  DesktopMcpResourceSummary,
  DesktopMcpServerDetails,
  DesktopMcpServerDraft,
  DesktopMcpServerSummary,
  DesktopMcpSnapshot,
  DesktopMcpTestResult,
  DesktopMcpTransport
} from "../../../protocol.js";
import { errorMessage } from "../app/desktopApi.js";
import { Icon } from "./Icon.js";

type McpTab = "market" | "installed";

interface McpServersViewProps {
  projectId?: string;
  onError(message: string): void;
  onSuccess(message: string): void;
}

interface FieldRow {
  key: string;
  value: string;
  action: DesktopMcpFieldAction;
  placeholder?: string;
  required?: boolean;
}

interface McpDraftForm {
  name: string;
  description: string;
  transport: DesktopMcpTransport;
  command: string;
  argsText: string;
  cwd: string;
  stderr: "ignore" | "inherit" | "pipe";
  url: string;
  remoteProtocol: DesktopMcpRemoteProtocol;
  timeoutMs: string;
  env: FieldRow[];
  headers: FieldRow[];
}

const EMPTY_DRAFT: McpDraftForm = {
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  argsText: "",
  cwd: "",
  stderr: "ignore",
  url: "",
  remoteProtocol: "streamable-http",
  timeoutMs: "",
  env: [],
  headers: []
};

export function McpServersView({ projectId, onError, onSuccess }: McpServersViewProps): React.JSX.Element {
  const [tab, setTab] = useState<McpTab>("market");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [snapshot, setSnapshot] = useState<DesktopMcpSnapshot>();
  const [catalog, setCatalog] = useState<DesktopMcpCatalogState>({
    status: "idle",
    source: "",
    entries: [],
    categories: []
  });
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingName, setEditingName] = useState<string>();
  const [draft, setDraft] = useState<McpDraftForm>(EMPTY_DRAFT);
  const [testResult, setTestResult] = useState<DesktopMcpTestResult>();
  const [details, setDetails] = useState<DesktopMcpServerDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const requestRef = useRef(0);

  const applySnapshot = useCallback((next: DesktopMcpSnapshot): void => {
    setSnapshot(next);
    setCatalog(next.catalog);
  }, []);

  const load = useCallback(async (refreshCatalog: boolean): Promise<void> => {
    const nextRequestId = requestRef.current + 1;
    requestRef.current = nextRequestId;
    setLoading(true);
    try {
      const [nextSnapshot, nextCatalog] = await Promise.all([
        window.biny.mcpSnapshot(projectId),
        refreshCatalog ? window.biny.mcpRefreshCatalog() : window.biny.mcpCatalog()
      ]);
      if (nextRequestId !== requestRef.current) return;
      applySnapshot(nextSnapshot);
      setCatalog(nextCatalog);
    } catch (error) {
      if (nextRequestId === requestRef.current) onError(errorMessage(error));
    } finally {
      if (nextRequestId === requestRef.current) setLoading(false);
    }
  }, [applySnapshot, onError, projectId]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = useMemo(() => catalog.entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (!normalizedQuery) return true;
    return `${entry.name} ${entry.description} ${entry.author ?? ""} ${entry.tags.join(" ")}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  }), [catalog.entries, category, normalizedQuery]);

  const updateSnapshot = useCallback((next: DesktopMcpSnapshot): void => {
    applySnapshot(next);
    setDetails(undefined);
  }, [applySnapshot]);

  const openNew = useCallback((): void => {
    setEditingName(undefined);
    setDraft(EMPTY_DRAFT);
    setTestResult(undefined);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((server: DesktopMcpServerSummary): void => {
    setEditingName(server.name);
    setDraft({
      name: server.name,
      description: server.description ?? "",
      transport: server.transport,
      command: server.transport === "stdio" ? server.commandOrUrl : "",
      argsText: server.args.join("\n"),
      cwd: server.cwd ?? "",
      stderr: server.stderr ?? "ignore",
      url: server.transport === "remote" ? server.commandOrUrl : "",
      remoteProtocol: server.remoteProtocol ?? "streamable-http",
      timeoutMs: server.timeoutMs === undefined ? "" : String(server.timeoutMs),
      env: server.environmentKeys.map((key) => ({ key, value: "", action: "keep" })),
      headers: server.headerNames.map((key) => ({ key, value: "", action: "keep" }))
    });
    setTestResult(undefined);
    setFormOpen(true);
  }, []);

  const openMarketInstall = useCallback((entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void => {
    setTab("installed");
    setEditingName(undefined);
    setDraft({
      ...EMPTY_DRAFT,
      name: entry.name,
      description: entry.description,
      transport: installation.transport,
      command: installation.command ?? "",
      argsText: installation.args.join("\n"),
      url: installation.url ?? "",
      remoteProtocol: installation.remoteProtocol ?? "streamable-http",
      env: installation.parameters.map((parameter) => ({
        key: parameter.key,
        value: "",
        action: "set",
        placeholder: parameter.placeholder,
        required: parameter.required
      }))
    });
    setTestResult(undefined);
    setFormOpen(true);
  }, []);

  const importClipboard = useCallback(async (): Promise<void> => {
    try {
      const raw = await navigator.clipboard.readText();
      const parsed = JSON.parse(raw) as unknown;
      const imported = parseClipboardConfig(parsed);
      if (!imported) throw new Error("剪贴板中没有可识别的 MCP 配置。");
      setEditingName(undefined);
      setDraft(imported);
      setTestResult(undefined);
      setFormOpen(true);
      onSuccess("已从剪贴板导入 MCP 配置，请检查后保存。");
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError, onSuccess]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!snapshot) return;
    try {
      const nextDraft = toProtocolDraft(draft);
      setBusyName(draft.name.trim());
      const next = await window.biny.mcpUpsertServer(projectId, editingName, nextDraft, snapshot.configRevision);
      updateSnapshot(next);
      setFormOpen(false);
      setTestResult(undefined);
      onSuccess(editingName ? "MCP 服务器已保存。" : "MCP 服务器已添加。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [draft, editingName, onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const testDraft = useCallback(async (): Promise<void> => {
    try {
      setTestResult(undefined);
      const result = await window.biny.mcpTestServer(projectId, toProtocolDraft(draft));
      setTestResult(result);
      if (result.success) onSuccess(result.message ?? "MCP 服务器连接成功。");
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [draft, onError, onSuccess, projectId]);

  const setEnabled = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!snapshot) return;
    try {
      setBusyName(server.name);
      updateSnapshot(await window.biny.mcpSetEnabled(projectId, server.name, !server.enabled, snapshot.configRevision));
      onSuccess(server.enabled ? "MCP 服务器已禁用。" : "MCP 服务器已启用。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const reconnect = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!projectId) {
      onError("请先打开一个项目，再连接 MCP 服务器。");
      return;
    }
    try {
      setBusyName(server.name);
      const next = await window.biny.mcpReconnect(projectId, server.name);
      setSnapshot((current) => current ? { ...current, servers: current.servers.map((item) => item.name === next.name ? next : item) } : current);
      onSuccess(next.state === "connected" ? `${server.name} 已连接。` : `${server.name} 仍未连接。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [onError, onSuccess, projectId]);

  const openDetails = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!projectId) {
      onError("请先打开一个项目，再查看 MCP 运行详情。");
      return;
    }
    try {
      setDetailsLoading(true);
      setDetails(await window.biny.mcpDetails(projectId, server.name));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDetailsLoading(false);
    }
  }, [onError, projectId]);

  const deleteServer = useCallback(async (): Promise<void> => {
    if (!snapshot || !deleteTarget) return;
    try {
      setBusyName(deleteTarget);
      updateSnapshot(await window.biny.mcpDeleteServer(projectId, deleteTarget, snapshot.configRevision));
      onSuccess("MCP 服务器已删除。");
      setDeleteTarget(undefined);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [deleteTarget, onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const updateField = useCallback((location: "env" | "headers", index: number, patch: Partial<FieldRow>): void => {
    setDraft((current) => ({
      ...current,
      [location]: current[location].map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const next = { ...row, ...patch };
        if (patch.value !== undefined && next.action === "keep" && patch.value.length > 0) next.action = "set";
        return next;
      })
    }));
  }, []);

  const addField = useCallback((location: "env" | "headers"): void => {
    setDraft((current) => ({
      ...current,
      [location]: [...current[location], { key: "", value: "", action: "set" }]
    }));
  }, []);

  const removeField = useCallback((location: "env" | "headers", index: number): void => {
    setDraft((current) => ({
      ...current,
      [location]: current[location].filter((_, rowIndex) => rowIndex !== index)
    }));
  }, []);

  return (
    <div className="cindy-mcp-page">
      <header className="cindy-mcp-header">
        <div className="cindy-mcp-title-block">
          <span className="cindy-mcp-title-icon"><Icon name="server" size={22} /></span>
          <div>
            <h1>MCP 服务器</h1>
            <p>管理模型上下文协议（MCP）服务器以扩展 AI 能力</p>
          </div>
        </div>
        <button className="cindy-mcp-add-button" onClick={openNew} type="button"><Icon name="add" size={17} />添加服务器</button>
      </header>

      <div className="cindy-mcp-toolbar">
        <div className="cindy-mcp-tabs" role="tablist" aria-label="MCP 服务器列表">
          <button aria-selected={tab === "market"} className={tab === "market" ? "is-active" : ""} onClick={() => setTab("market")} role="tab" type="button"><Icon name="site" size={15} />应用市场</button>
          <button aria-selected={tab === "installed"} className={tab === "installed" ? "is-active" : ""} onClick={() => setTab("installed")} role="tab" type="button"><Icon name="server" size={15} />已安装 <span>{snapshot?.servers.length ?? 0}</span></button>
        </div>
        <label className="cindy-mcp-search">
          <Icon name="search" size={15} />
          <input aria-label="搜索 MCP 服务器" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 MCP 服务器…" value={query} />
          {query ? <button aria-label="清空搜索" onClick={() => setQuery("")} type="button"><Icon name="close" size={13} /></button> : null}
        </label>
        {tab === "market" ? <label className="cindy-mcp-category"><span className="sr-only">筛选分类</span><select aria-label="筛选分类" onChange={(event) => setCategory(event.target.value)} value={category}><option value="">所有分类</option>{catalog.categories.map((item) => <option key={item} value={item}>{item}</option>)}</select><Icon name="chevron" size={14} /></label> : null}
        <button aria-label="刷新 MCP 列表" className="cindy-mcp-icon-button" disabled={loading} onClick={() => void load(true)} title="刷新" type="button"><Icon name="refresh" size={16} /></button>
      </div>

      {catalog.error ? <div className="cindy-mcp-notice"><Icon name="warning" size={15} /><span>{catalog.error}{catalog.status === "stale" ? " 当前显示上次成功加载的市场内容。" : ""}</span></div> : null}
      <main className="cindy-mcp-body">
        {tab === "market" ? <McpMarketContent entries={visibleEntries} loading={loading} onInstall={openMarketInstall} onOpenExternal={(url) => void window.biny.openExternal(url).catch((error) => onError(errorMessage(error)))} /> : <McpInstalledContent
          details={details}
          detailsLoading={detailsLoading}
          loading={loading}
          servers={filterInstalled(snapshot?.servers ?? [], normalizedQuery)}
          busyName={busyName}
          onDelete={setDeleteTarget}
          onDetails={(server) => void openDetails(server)}
          onEdit={openEdit}
          onReconnect={(server) => void reconnect(server)}
          onSetEnabled={(server) => void setEnabled(server)}
          onCloseDetails={() => setDetails(undefined)}
        />}
      </main>

      {formOpen ? <McpServerDialog
        draft={draft}
        editing={editingName !== undefined}
        onChange={setDraft}
        onClose={() => { setFormOpen(false); setTestResult(undefined); }}
        onImportClipboard={() => void importClipboard()}
        onSave={() => void saveDraft()}
        onTest={() => void testDraft()}
        onAddField={addField}
        onRemoveField={removeField}
        onUpdateField={updateField}
        saving={busyName !== undefined}
        testResult={testResult}
      /> : null}
      {deleteTarget ? <McpDeleteDialog name={deleteTarget} onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void deleteServer()} /> : null}
    </div>
  );
}

const McpMarketContent = memo(function McpMarketContent({ entries, loading, onInstall, onOpenExternal }: { entries: DesktopMcpCatalogEntry[]; loading: boolean; onInstall(entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void; onOpenExternal(url: string): void }): React.JSX.Element {
  if (loading && !entries.length) return <McpEmpty icon="refresh" title="正在加载 MCP 市场" detail="正在读取可用的 MCP 服务器目录…" />;
  if (!entries.length) return <McpEmpty icon="search" title="没有匹配的 MCP 服务器" detail="换一个关键词或清除筛选条件试试。" />;
  return <div className="cindy-mcp-market-grid">{entries.map((entry) => <McpMarketCard entry={entry} key={entry.id} onInstall={onInstall} onOpenExternal={onOpenExternal} />)}</div>;
});

const McpMarketCard = memo(function McpMarketCard({ entry, onInstall, onOpenExternal }: { entry: DesktopMcpCatalogEntry; onInstall(entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void; onOpenExternal(url: string): void }): React.JSX.Element {
  return (
    <article className="cindy-mcp-market-card">
      <div className="cindy-mcp-card-topline">
        <span className="cindy-mcp-card-icon"><Icon name="server" size={20} /></span>
        <div className="cindy-mcp-card-heading"><h2>{entry.name}</h2><span>{entry.author ? `作者 ${entry.author}` : "社区服务器"}{entry.category ? ` · ${entry.category}` : ""}</span></div>
        <div className="cindy-mcp-card-badges">{entry.verified ? <span className="cindy-mcp-badge is-verified"><Icon name="check" size={12} />已验证</span> : null}{entry.featured ? <span className="cindy-mcp-badge is-featured">精选</span> : null}</div>
      </div>
      <p className="cindy-mcp-card-description">{entry.description || "暂无描述"}</p>
      <div className="cindy-mcp-tags">{entry.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div>
      <div className="cindy-mcp-card-footer">
        <div className="cindy-mcp-install-options">{entry.installations.map((installation) => <button className="cindy-mcp-install-button" key={installation.name} onClick={() => onInstall(entry, installation)} type="button"><Icon name="add" size={14} />{installation.name === "默认配置" ? "安装" : `安装 · ${installation.name}`}</button>)}</div>
        {entry.repositoryUrl || entry.websiteUrl ? <button aria-label={`打开 ${entry.name} 页面`} className="cindy-mcp-link-button" onClick={() => onOpenExternal(entry.repositoryUrl ?? entry.websiteUrl ?? "")} title="打开项目页面" type="button"><Icon name="external" size={15} /></button> : null}
      </div>
    </article>
  );
});

const McpInstalledContent = memo(function McpInstalledContent({ servers, loading, busyName, details, detailsLoading, onDelete, onDetails, onEdit, onReconnect, onSetEnabled, onCloseDetails }: { servers: DesktopMcpServerSummary[]; loading: boolean; busyName?: string; details?: DesktopMcpServerDetails; detailsLoading: boolean; onDelete(name: string): void; onDetails(server: DesktopMcpServerSummary): void; onEdit(server: DesktopMcpServerSummary): void; onReconnect(server: DesktopMcpServerSummary): void; onSetEnabled(server: DesktopMcpServerSummary): void; onCloseDetails(): void }): React.JSX.Element {
  if (loading && !servers.length) return <McpEmpty icon="refresh" title="正在读取已安装服务器" detail="正在同步配置和运行状态…" />;
  if (!servers.length) return <McpEmpty icon="server" title="还没有安装 MCP 服务器" detail="可以从应用市场安装，或点击右上角添加自定义 Stdio / Remote 服务器。" />;
  return (
    <div className="cindy-mcp-installed-layout">
      <div className="cindy-mcp-installed-list">{servers.map((server) => <McpInstalledCard busy={busyName === server.name} key={server.name} onDelete={onDelete} onDetails={onDetails} onEdit={onEdit} onReconnect={onReconnect} onSetEnabled={onSetEnabled} server={server} />)}</div>
      {details || detailsLoading ? <McpDetailsPanel details={details} loading={detailsLoading} onClose={onCloseDetails} /> : null}
    </div>
  );
});

const McpInstalledCard = memo(function McpInstalledCard({ server, busy, onSetEnabled, onReconnect, onDetails, onEdit, onDelete }: { server: DesktopMcpServerSummary; busy: boolean; onSetEnabled(server: DesktopMcpServerSummary): void; onReconnect(server: DesktopMcpServerSummary): void; onDetails(server: DesktopMcpServerSummary): void; onEdit(server: DesktopMcpServerSummary): void; onDelete(name: string): void }): React.JSX.Element {
  const statusLabel = server.state === "connected" ? "已连接" : server.state === "disabled" ? "已禁用" : server.state === "not-started" ? "未启动" : "未连接";
  return (
    <article className={`cindy-mcp-installed-card is-${server.state}`}>
      <div className="cindy-mcp-installed-heading">
        <span className="cindy-mcp-card-icon"><Icon name={server.transport === "remote" ? "remote" : "terminal"} size={20} /></span>
        <div className="cindy-mcp-card-heading"><h2>{server.name}</h2><span>{server.transport === "remote" ? `Remote · ${server.remoteProtocol === "sse" ? "SSE" : "Streamable HTTP"}` : "Stdio"}</span></div>
        <span className={`cindy-mcp-status is-${server.state}`}><i />{statusLabel}</span>
      </div>
      <p className="cindy-mcp-endpoint" title={server.commandOrUrl}>{server.commandOrUrl || "未配置启动命令"}{server.transport === "stdio" && server.args.length ? ` ${server.args.join(" ")}` : ""}</p>
      <div className="cindy-mcp-capabilities"><span><strong>{server.toolNames.length}</strong> 工具</span><span><strong>{server.promptNames.length}</strong> 提示</span><span><strong>{server.hasResources ? "有" : "无"}</strong> 资源</span>{server.environmentKeys.length ? <span><strong>{server.environmentKeys.length}</strong> 环境变量</span> : null}</div>
      {server.lastError ? <p className="cindy-mcp-card-error"><Icon name="warning" size={13} />{server.lastError}</p> : null}
      <div className="cindy-mcp-installed-footer">
        <button aria-pressed={server.enabled} className={`cindy-mcp-toggle${server.enabled ? " is-on" : ""}`} disabled={busy} onClick={() => onSetEnabled(server)} role="switch" type="button"><span />{server.enabled ? "已启用" : "已禁用"}</button>
        <div className="cindy-mcp-row-actions"><button disabled={busy || server.state === "disabled"} onClick={() => onReconnect(server)} type="button"><Icon name="refresh" size={14} />重连</button><button disabled={busy} onClick={() => onDetails(server)} type="button"><Icon name="database" size={14} />详情</button><button disabled={busy} onClick={() => onEdit(server)} type="button"><Icon name="edit" size={14} />编辑</button><button aria-label={`删除 ${server.name}`} className="is-danger" disabled={busy} onClick={() => onDelete(server.name)} title="删除" type="button"><Icon name="trash" size={14} /></button></div>
      </div>
    </article>
  );
});

const McpDetailsPanel = memo(function McpDetailsPanel({ details, loading, onClose }: { details?: DesktopMcpServerDetails; loading: boolean; onClose(): void }): React.JSX.Element {
  return <aside aria-label="MCP 服务器详情" className="cindy-mcp-details" role="dialog"><div className="cindy-mcp-details-header"><div><span className="cindy-mcp-eyebrow">运行详情</span><h2>{details?.server.name ?? "MCP 服务器"}</h2></div><button aria-label="关闭详情" className="cindy-mcp-icon-button" onClick={onClose} type="button"><Icon name="close" size={15} /></button></div>{loading ? <p className="cindy-mcp-details-empty">正在读取工具、提示和资源…</p> : details ? <div className="cindy-mcp-details-body"><div className="cindy-mcp-detail-summary"><span className={`cindy-mcp-status is-${details.server.state}`}><i />{details.server.state === "connected" ? "已连接" : "未连接"}</span><span>{details.server.toolNames.length} 个工具</span><span>{details.server.promptNames.length} 个提示</span></div><CapabilityList label="工具" values={details.server.toolNames} /><CapabilityList label="提示" values={details.server.promptNames} /><ResourceList resources={details.resources} /></div> : null}</aside>;
});

const CapabilityList = memo(function CapabilityList({ label, values }: { label: string; values: string[] }): React.JSX.Element {
  return <section className="cindy-mcp-detail-section"><h3>{label} <small>{values.length}</small></h3>{values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>暂无{label}</p>}</section>;
});

const ResourceList = memo(function ResourceList({ resources }: { resources: DesktopMcpResourceSummary[] }): React.JSX.Element {
  return <section className="cindy-mcp-detail-section"><h3>资源 <small>{resources.length}</small></h3>{resources.length ? <ul>{resources.map((resource) => <li key={resource.uri}><strong>{resource.name ?? resource.uri}</strong><span>{resource.uri}</span></li>)}</ul> : <p>暂无资源</p>}</section>;
});

const McpServerDialog = memo(function McpServerDialog({ draft, editing, saving, testResult, onChange, onClose, onImportClipboard, onSave, onTest, onAddField, onRemoveField, onUpdateField }: { draft: McpDraftForm; editing: boolean; saving: boolean; testResult?: DesktopMcpTestResult; onChange(next: McpDraftForm): void; onClose(): void; onImportClipboard(): void; onSave(): void; onTest(): void; onAddField(location: "env" | "headers"): void; onRemoveField(location: "env" | "headers", index: number): void; onUpdateField(location: "env" | "headers", index: number, patch: Partial<FieldRow>): void }): React.JSX.Element {
  const setValue = (key: keyof McpDraftForm, value: string): void => onChange({ ...draft, [key]: value });
  const submit = (event: React.FormEvent<HTMLFormElement>): void => { event.preventDefault(); onSave(); };
  return (
    <div aria-label="添加 MCP 服务器" className="cindy-mcp-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <form aria-labelledby="mcp-dialog-title" className="cindy-mcp-dialog" onSubmit={submit}>
        <header className="cindy-mcp-dialog-header"><span className="cindy-mcp-title-icon"><Icon name="server" size={21} /></span><div><h2 id="mcp-dialog-title">{editing ? "编辑服务器" : "添加服务器"}</h2><p>{editing ? "更新 MCP 服务器配置" : "添加自定义 MCP 服务器配置"}</p></div><button aria-label="关闭" className="cindy-mcp-icon-button" onClick={onClose} type="button"><Icon name="close" size={17} /></button></header>
        <div className="cindy-mcp-dialog-scroll">
          <button className="cindy-mcp-clipboard-button" onClick={onImportClipboard} type="button"><Icon name="copy" size={16} />从剪贴板导入</button>
          <McpFormSection icon="settings" title="Basic Information"><div className="cindy-mcp-form-grid"><McpInput label="服务器名称" required onChange={(value) => setValue("name", value)} placeholder="例如：filesystem" value={draft.name} /><McpInput label="描述" onChange={(value) => setValue("description", value)} placeholder="可选描述" value={draft.description} wide /></div><div className="cindy-mcp-form-label">传输类型</div><div className="cindy-mcp-segmented"><button className={draft.transport === "stdio" ? "is-active" : ""} onClick={() => onChange({ ...draft, transport: "stdio" })} type="button"><Icon name="terminal" size={16} />Stdio</button><button className={draft.transport === "remote" ? "is-active" : ""} onClick={() => onChange({ ...draft, transport: "remote" })} type="button"><Icon name="remote" size={16} />Remote</button></div></McpFormSection>
          {draft.transport === "stdio" ? <McpFormSection icon="terminal" title="Command Configuration"><McpInput label="命令" required onChange={(value) => setValue("command", value)} placeholder="npx -y @modelcontextprotocol/server-filesystem" value={draft.command} /><McpInput label="参数" hint="每行一个参数；也支持空格分隔" multiline onChange={(value) => setValue("argsText", value)} placeholder="/Users/think/Documents" value={draft.argsText} /><div className="cindy-mcp-form-grid"><McpInput label="工作目录" onChange={(value) => setValue("cwd", value)} placeholder="默认使用项目目录" value={draft.cwd} /><label className="cindy-mcp-field"><span>stderr</span><select onChange={(event) => onChange({ ...draft, stderr: event.target.value as McpDraftForm["stderr"] })} value={draft.stderr}><option value="ignore">忽略</option><option value="inherit">继承到终端</option><option value="pipe">捕获</option></select></label></div></McpFormSection> : <McpFormSection icon="remote" title="Remote Configuration"><McpInput label="URL" required onChange={(value) => setValue("url", value)} placeholder="https://api.example.com/mcp/" value={draft.url} /><div className="cindy-mcp-form-label">传输协议</div><div className="cindy-mcp-segmented"><button className={draft.remoteProtocol === "streamable-http" ? "is-active" : ""} onClick={() => onChange({ ...draft, remoteProtocol: "streamable-http" })} type="button">Streamable HTTP</button><button className={draft.remoteProtocol === "sse" ? "is-active" : ""} onClick={() => onChange({ ...draft, remoteProtocol: "sse" })} type="button">SSE</button></div><p className="cindy-mcp-form-hint">推荐使用 Streamable HTTP；对于不支持的服务，请选择 SSE。</p><div className="cindy-mcp-oauth-note"><Icon name="shield" size={16} /><div><strong>需要 OAuth</strong><span>OAuth 2.1 授权流程暂未启用，请使用请求头或环境变量引用。</span></div><button aria-label="需要 OAuth（暂未启用）" disabled type="button"><span /></button></div></McpFormSection>}
          <McpSecretFields label="环境变量" location="env" rows={draft.env} onAdd={onAddField} onRemove={onRemoveField} onUpdate={onUpdateField} />
          {draft.transport === "remote" ? <McpSecretFields label="请求头" location="headers" rows={draft.headers} onAdd={onAddField} onRemove={onRemoveField} onUpdate={onUpdateField} /> : null}
          <McpInput label="连接超时（毫秒）" hint="留空使用默认值" onChange={(value) => setValue("timeoutMs", value)} placeholder="30000" value={draft.timeoutMs} />
          {testResult ? <div className={`cindy-mcp-test-result is-${testResult.success ? "success" : "error"}`}><Icon name={testResult.success ? "check" : "warning"} size={15} /><div><strong>{testResult.success ? "连接测试成功" : "连接测试失败"}</strong><span>{testResult.message ?? testResult.error}</span>{testResult.success ? <small>工具 {testResult.toolNames.length} · 提示 {testResult.promptNames.length} · 资源 {testResult.hasResources ? "有" : "无"}</small> : null}</div></div> : null}
        </div>
        <footer className="cindy-mcp-dialog-footer"><button className="cindy-mcp-secondary-button" onClick={onClose} type="button">取消</button><button className="cindy-mcp-secondary-button" disabled={saving} onClick={onTest} type="button"><Icon name="network" size={15} />测试连接</button><button className="cindy-mcp-primary-button" disabled={saving} type="submit"><Icon name={editing ? "check" : "add"} size={15} />{saving ? "保存中…" : editing ? "保存" : "添加"}</button></footer>
      </form>
    </div>
  );
});

const McpFormSection = memo(function McpFormSection({ icon, title, children }: { icon: "settings" | "terminal" | "remote"; title: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="cindy-mcp-form-section"><h3><Icon name={icon} size={16} />{title}</h3>{children}</section>;
});

const McpInput = memo(function McpInput({ label, value, placeholder, onChange, required = false, wide = false, multiline = false, hint }: { label: string; value: string; placeholder?: string; onChange(value: string): void; required?: boolean; wide?: boolean; multiline?: boolean; hint?: string }): React.JSX.Element {
  return <label className={`cindy-mcp-field${wide ? " is-wide" : ""}`}><span>{label}{required ? <em> *</em> : null}</span>{multiline ? <textarea onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} rows={3} value={value} /> : <input onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} value={value} />}{hint ? <small>{hint}</small> : null}</label>;
});

const McpSecretFields = memo(function McpSecretFields({ label, location, rows, onAdd, onRemove, onUpdate }: { label: string; location: "env" | "headers"; rows: FieldRow[]; onAdd(location: "env" | "headers"): void; onRemove(location: "env" | "headers", index: number): void; onUpdate(location: "env" | "headers", index: number, patch: Partial<FieldRow>): void }): React.JSX.Element {
  return <section className="cindy-mcp-form-section cindy-mcp-secret-section"><div className="cindy-mcp-secret-heading"><div><h3><Icon name="shield" size={16} />{label}</h3><p>{rows.some((row) => row.action === "keep") ? "已保存的值不会显示；填写新值即可替换。" : "macOS 使用 Keychain；其他平台可填写 ${ENV_NAME} 引用。"}</p></div><button className="cindy-mcp-link-action" onClick={() => onAdd(location)} type="button"><Icon name="add" size={14} />添加</button></div>{rows.length ? <div className="cindy-mcp-secret-list">{rows.map((row, index) => <div className="cindy-mcp-secret-row" key={`${location}-${index}-${row.key}`}><input aria-label={`${label}名称`} onChange={(event) => onUpdate(location, index, { key: event.target.value })} placeholder="KEY" value={row.key} /><input aria-label={`${label}值`} onChange={(event) => onUpdate(location, index, { value: event.target.value })} placeholder={row.placeholder ?? (row.action === "keep" ? "已保存，留空保持不变" : "value 或 ${ENV_NAME}")} type="password" value={row.value} /><button aria-label={`删除${label}`} className="cindy-mcp-icon-button" onClick={() => onRemove(location, index)} type="button"><Icon name="trash" size={14} /></button></div>)}</div> : <p className="cindy-mcp-secret-empty">暂无{label}，点击“添加”录入。</p>}</section>;
});

const McpDeleteDialog = memo(function McpDeleteDialog({ name, onCancel, onConfirm }: { name: string; onCancel(): void; onConfirm(): void }): React.JSX.Element {
  return <div className="cindy-mcp-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation"><section aria-label="确认删除 MCP 服务器" className="cindy-mcp-confirm-dialog" role="alertdialog"><span className="cindy-mcp-confirm-icon"><Icon name="warning" size={21} /></span><h2>删除 MCP 服务器？</h2><p>“{name}”的配置和凭据引用将被移除，此操作无法撤销。</p><div className="cindy-mcp-dialog-actions"><button className="cindy-mcp-secondary-button" onClick={onCancel} type="button">取消</button><button className="cindy-mcp-danger-button" onClick={onConfirm} type="button">删除</button></div></section></div>;
});

function McpEmpty({ icon, title, detail }: { icon: "refresh" | "search" | "server"; title: string; detail: string }): React.JSX.Element {
  return <div className="cindy-mcp-empty"><span><Icon name={icon} size={24} /></span><h2>{title}</h2><p>{detail}</p></div>;
}

function filterInstalled(servers: DesktopMcpServerSummary[], query: string): DesktopMcpServerSummary[] {
  if (!query) return servers;
  return servers.filter((server) => `${server.name} ${server.description ?? ""} ${server.commandOrUrl}`.toLocaleLowerCase().includes(query));
}

function toProtocolDraft(draft: McpDraftForm): DesktopMcpServerDraft {
  const name = draft.name.trim();
  if (!name) throw new Error("请输入服务器名称。");
  const timeoutMs = draft.timeoutMs.trim() ? Number(draft.timeoutMs.trim()) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000)) throw new Error("连接超时需要是 100 到 300000 之间的整数。");
  return {
    name,
    description: draft.description.trim() || undefined,
    transport: draft.transport,
    command: draft.transport === "stdio" ? draft.command.trim() || undefined : undefined,
    args: parseArguments(draft.argsText),
    cwd: draft.cwd.trim() || undefined,
    stderr: draft.stderr,
    url: draft.transport === "remote" ? draft.url.trim() || undefined : undefined,
    remoteProtocol: draft.transport === "remote" ? draft.remoteProtocol : undefined,
    timeoutMs,
    env: toFieldMutations(draft.env),
    headers: toFieldMutations(draft.headers)
  };
}

function toFieldMutations(rows: FieldRow[]): DesktopMcpFieldMutation[] {
  const mutations: DesktopMcpFieldMutation[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.action === "keep" && !row.value) {
      mutations.push({ key, action: "keep" });
      continue;
    }
    if (row.action === "set" && !row.value && row.required) throw new Error(`请填写 ${key} 的值。`);
    if (row.action === "set" && !row.value) continue;
    mutations.push({ key, action: row.action, value: row.action === "set" ? row.value : undefined });
  }
  return mutations;
}

function parseArguments(value: string): string[] {
  return value.split(/\r?\n/).flatMap((line) => line.trim() ? [line.trim()] : []).flatMap((line) => line.includes(" ") ? line.split(/\s+/) : [line]);
}

function parseClipboardConfig(value: unknown): McpDraftForm | undefined {
  if (!isRecord(value)) return undefined;
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  const first = Object.entries(servers).find(([, candidate]) => isRecord(candidate));
  if (!first || !isRecord(first[1])) return undefined;
  const config = first[1];
  const transport: DesktopMcpTransport = typeof config.url === "string" ? "remote" : "stdio";
  return {
    ...EMPTY_DRAFT,
    name: first[0],
    description: typeof config.description === "string" ? config.description : "",
    transport,
    command: typeof config.command === "string" ? config.command : "",
    argsText: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === "string").join("\n") : "",
    cwd: typeof config.cwd === "string" ? config.cwd : "",
    stderr: config.stderr === "inherit" || config.stderr === "pipe" ? config.stderr : "ignore",
    url: typeof config.url === "string" ? config.url : "",
    remoteProtocol: config.transportProtocol === "sse" ? "sse" : "streamable-http",
    timeoutMs: typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "",
    env: recordRows(config.env),
    headers: recordRows(config.headers)
  };
}

function recordRows(value: unknown): FieldRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter(([, candidate]) => typeof candidate === "string").map(([key, candidate]) => ({ key, value: String(candidate), action: "set" }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
