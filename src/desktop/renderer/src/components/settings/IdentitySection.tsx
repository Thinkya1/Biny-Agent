/**
 * Agent 身份资料的审核界面。
 *
 * 身份文档与设置草稿分开：开关走全局 Settings 事务，Markdown 编辑和 Alma 导入只生成
 * 提案，接受前不会改写 SOUL/IDENTITY/STYLE/USER。正文预览保留原文，不做自动脱敏。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DesktopAlmaImportScan,
  DesktopIdentityDocumentKind,
  DesktopIdentityOverview,
  DesktopIdentityProposal,
  DesktopIdentityReviewResult
} from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const documentOptions: Array<{ kind: DesktopIdentityDocumentKind; label: string; description: string }> = [
  { kind: "soul", label: "SOUL.md", description: "Agent 的核心身份与边界" },
  { kind: "identity", label: "IDENTITY.md", description: "名称、形象与表达基调" },
  { kind: "style", label: "STYLE.md", description: "稳定的表达风格" },
  { kind: "user", label: "USER.md", description: "对用户的长期理解" }
];

interface IdentitySectionProps {
  active: boolean;
  projectId?: string;
  hidden?: boolean;
  onLoad(): Promise<DesktopIdentityOverview>;
  onImport(root?: string): Promise<DesktopAlmaImportScan>;
  onSave(document: DesktopIdentityDocumentKind, content: string, expectedRevision: number, reason?: string): Promise<DesktopIdentityOverview>;
  onReview(proposalId: string, action: "accept" | "reject", expectedRevision: number): Promise<DesktopIdentityReviewResult>;
  onNotify(message: string): void;
}

export function IdentitySection({
  active,
  hidden,
  onImport,
  onLoad,
  onNotify,
  onReview,
  onSave,
  projectId
}: IdentitySectionProps): React.JSX.Element {
  const { draft, setIdentity } = useSettingsDraft();
  const [overview, setOverview] = useState<DesktopIdentityOverview>();
  const [documentKind, setDocumentKind] = useState<DesktopIdentityDocumentKind>("soul");
  const [content, setContent] = useState("");
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [editorDirty, setEditorDirty] = useState(false);
  const [sourceRoot, setSourceRoot] = useState("");
  const [importSummary, setImportSummary] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<DesktopIdentityOverview> => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await onLoad();
      setOverview(next);
      return next;
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [onLoad]);

  useEffect(() => {
    if (!active || !projectId) return;
    setEditorDirty(false);
    setEditorMode("edit");
    setImportSummary(undefined);
    void refresh().catch(() => undefined);
  }, [active, projectId, refresh]);

  const currentDocument = overview?.documents[documentKind];
  useEffect(() => {
    if (editorDirty) return;
    setContent(currentDocument?.content ?? defaultDocument(documentKind));
  }, [currentDocument, documentKind, editorDirty]);

  const pendingProposals = useMemo(
    () => (overview?.proposals ?? []).filter((proposal) => proposal.status === "pending"),
    [overview?.proposals]
  );

  if (!draft) return <section className="identity-section" hidden={hidden}><p>正在加载身份设置…</p></section>;

  const run = async (name: string, work: () => Promise<void>, success: string): Promise<void> => {
    if (operation !== undefined) return;
    setOperation(name);
    setError(undefined);
    try {
      await work();
      onNotify(success);
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      onNotify(message);
    } finally {
      setOperation(undefined);
    }
  };

  const importAlma = (): void => {
    void run("import", async () => {
      const scan = await onImport(sourceRoot.trim() || undefined);
      setSourceRoot(scan.source.root);
      const proposalCount = scan.proposals.length;
      const sourceCount = scan.identityFiles.filter((file) => file.exists).length;
      setImportSummary(`${String(sourceCount)} 个身份文件已读取，生成 ${String(proposalCount)} 个待审核提案。每日记忆仅完成扫描，不会直接写入。`);
      await refresh();
    }, "Alma 身份资料已读取，请审核提案");
  };

  const saveDocument = (): void => {
    if (!overview) return;
    void run("save", async () => {
      const next = await onSave(documentKind, content, overview.revision, "手动编辑身份资料");
      setOverview(next);
      setEditorDirty(false);
      setEditorMode("preview");
    }, "身份文档修改已生成提案");
  };

  const reviewProposal = (proposal: DesktopIdentityProposal, action: "accept" | "reject"): void => {
    if (!overview) return;
    void run(`${action}:${proposal.id}`, async () => {
      const result = await onReview(proposal.id, action, overview.revision);
      setOverview(result.overview);
      if (action === "accept" && result.overview.documents[documentKind]) {
        setEditorDirty(false);
      }
    }, action === "accept" ? "身份提案已接受" : "身份提案已拒绝");
  };

  return (
    <section aria-busy={loading || operation !== undefined} className="identity-section" hidden={hidden} id="identity">
      <div className="section-heading-row">
        <div>
          <h3>Agent 灵魂</h3>
          <p>复用 Alma 的身份资料，但所有导入、编辑和演化都先生成提案，由你确认后才生效。</p>
        </div>
        <span className="settings-scope-badge">本机资料</span>
      </div>
      <SettingsCheckbox
        checked={draft.identity.enabled}
        detail="在每个新回合加载 SOUL、IDENTITY、STYLE 和 USER；不会改变工具权限或安全规则。"
        label="启用 Agent 身份"
        onChange={(enabled) => setIdentity({ ...draft.identity, enabled })}
      />
      <div className="memory-mode-nested">
        <SettingsCheckbox
          checked={draft.identity.userEnabled}
          detail="单独控制 USER.md；关闭后仍可加载 Agent 自身的身份与表达风格。"
          disabled={!draft.identity.enabled}
          label="加载 USER.md"
          onChange={(userEnabled) => setIdentity({ ...draft.identity, userEnabled })}
        />
      </div>

      <div className="identity-source-card">
        <div className="section-heading-row">
          <div><strong>从 Alma 导入</strong><small>只读 SOUL.md、IDENTITY.md、USER.md、MEMORY.md 和 memory/YYYY-MM-DD.md，不读取数据库或聊天记录。</small></div>
          <button className="ghost-button" disabled={operation !== undefined || !projectId} onClick={importAlma} type="button">{operation === "import" ? "读取中…" : "读取并生成提案"}</button>
        </div>
        <label className="identity-source-path">
          <span>源目录（留空自动查找）</span>
          <input onChange={(event) => setSourceRoot(event.target.value)} placeholder="~/Library/Application Support/@opensquilla/desktop-electron/opensquilla/workspace" type="text" value={sourceRoot} />
        </label>
        {importSummary ? <p className="settings-effective-hint">{importSummary}</p> : null}
      </div>

      {error ? <p aria-live="polite" className="settings-effective-hint is-blocked" role="alert">{error}</p> : null}
      {overview ? (
        <>
          <div className="identity-document-tabs" role="tablist" aria-label="身份文档">
            {documentOptions.map((option) => (
              <button
                aria-selected={documentKind === option.kind}
                className={documentKind === option.kind ? "is-selected" : ""}
                key={option.kind}
                onClick={() => {
                  if (editorDirty && !window.confirm("当前文档有未提交修改，切换会丢弃这些修改。继续吗？")) return;
                  setDocumentKind(option.kind);
                  setEditorDirty(false);
                  setEditorMode("edit");
                }}
                role="tab"
                type="button"
              >
                <strong>{option.label}</strong><small>{option.description}</small>
              </button>
            ))}
          </div>
          <div className="identity-editor-card">
            <div className="section-heading-row">
              <div><strong>{documentOptions.find((option) => option.kind === documentKind)?.label}</strong><small>{currentDocument ? `当前 revision ${String(currentDocument.revision)}` : "尚未创建"}</small></div>
              <div className="settings-segmented" role="tablist">
                <button aria-selected={editorMode === "edit"} className={editorMode === "edit" ? "is-selected" : ""} onClick={() => setEditorMode("edit")} role="tab" type="button">编辑</button>
                <button aria-selected={editorMode === "preview"} className={editorMode === "preview" ? "is-selected" : ""} onClick={() => setEditorMode("preview")} role="tab" type="button">Markdown 预览</button>
              </div>
            </div>
            {editorMode === "edit" ? (
              <textarea
                aria-label={`${documentKind} Markdown`}
                className="identity-editor"
                onChange={(event) => { setContent(event.target.value); setEditorDirty(true); }}
                spellCheck={false}
                value={content}
              />
            ) : <div className="identity-markdown-preview"><Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown></div>}
            <div className="settings-button-row identity-editor-actions">
              <small>{editorDirty ? "尚未生成提案" : "修改后先保存为提案"}</small>
              <button className="primary-button" disabled={!editorDirty || operation !== undefined} onClick={saveDocument} type="button">{operation === "save" ? "生成中…" : "生成审核提案"}</button>
            </div>
          </div>

          <div className="identity-proposals" id="identity-proposals">
            <div className="section-heading-row"><div><h4>待审核提案</h4><p>{pendingProposals.length ? `共 ${String(pendingProposals.length)} 项；接受后才会写入 canonical Markdown。` : "目前没有待审核提案。"}</p></div><button aria-label="刷新身份提案" className="icon-button" disabled={loading || operation !== undefined} onClick={() => { void refresh().catch(() => undefined); }} title="刷新" type="button"><Icon name="refresh" size={14} /></button></div>
            {pendingProposals.map((proposal) => <ProposalCard current={overview.documents[proposal.document]?.content} key={proposal.id} onReview={(action) => reviewProposal(proposal, action)} operation={operation} proposal={proposal} />)}
          </div>
        </>
      ) : <p className="settings-effective-hint">{loading ? "正在读取身份资料…" : "尚未读取身份资料。"}</p>}
      <p className="settings-effective-hint">身份文档保存在 Biny 的全局 agent 目录；它们是长期资料，不会自动同步回 Alma。Markdown 正文不做盲目脱敏，疑似凭据只会阻止提案直接接受。</p>
    </section>
  );
}

function ProposalCard({ current, onReview, operation, proposal }: {
  current?: string;
  onReview(action: "accept" | "reject"): void;
  operation?: string;
  proposal: DesktopIdentityProposal;
}): React.JSX.Element {
  return (
    <article className="identity-proposal-card">
      <div className="section-heading-row">
        <div><strong>{documentLabel(proposal.document)} · {proposal.kind === "import" ? "Alma 导入" : proposal.kind === "evolution" ? "记忆演化" : "手动编辑"}</strong><small>{proposal.reason} · {formatDate(proposal.createdAt)}</small></div>
        <div className="settings-inline-actions">
          <button className="ghost-button is-danger" disabled={operation !== undefined} onClick={() => onReview("reject")} type="button">{operation === `reject:${proposal.id}` ? "处理中…" : "拒绝"}</button>
          <button className="primary-button" disabled={operation !== undefined || proposal.secretWarning !== undefined} onClick={() => onReview("accept")} title={proposal.secretWarning ?? "接受提案"} type="button">{operation === `accept:${proposal.id}` ? "处理中…" : "接受"}</button>
        </div>
      </div>
      {proposal.secretWarning ? <p className="settings-effective-hint is-blocked">{proposal.secretWarning} 已禁止直接接受；请移除敏感内容后重新编辑。</p> : null}
      <div className="identity-diff-grid">
        <div><span>当前版本</span><pre>{current ?? "（尚未创建）"}</pre></div>
        <div><span>提案版本</span><pre>{proposal.proposedContent}</pre></div>
      </div>
      {proposal.evidence.length ? <small className="identity-evidence">依据：{proposal.evidence.join("；")}</small> : null}
    </article>
  );
}

function defaultDocument(kind: DesktopIdentityDocumentKind): string {
  const heading = documentLabel(kind);
  return `# ${heading}\n\n`;
}

function documentLabel(kind: DesktopIdentityDocumentKind): string {
  return documentOptions.find((option) => option.kind === kind)?.label ?? kind;
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
