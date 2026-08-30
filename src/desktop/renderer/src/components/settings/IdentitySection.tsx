/**
 * Agent 身份资料的只读界面。
 *
 * 身份资料默认随新回合加载；这里只读展示 Markdown 原文，不做自动脱敏。
 */
import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DesktopIdentityDocumentKind,
  DesktopIdentityOverview
} from "../../../../protocol.js";
import { Icon } from "../Icon.js";

const documentOptions: Array<{ kind: DesktopIdentityDocumentKind; label: string; description: string }> = [
  { kind: "soul", label: "SOUL.md", description: "Agent 的核心身份与边界" },
  { kind: "user", label: "USER.md", description: "对用户的长期理解" }
];

interface IdentitySectionProps {
  active: boolean;
  projectId?: string;
  hidden?: boolean;
  onLoad(): Promise<DesktopIdentityOverview>;
  onNotify(message: string): void;
}

export function IdentitySection({
  active,
  hidden,
  onLoad,
  onNotify,
  projectId
}: IdentitySectionProps): React.JSX.Element {
  const [overview, setOverview] = useState<DesktopIdentityOverview>();
  const [documentKind, setDocumentKind] = useState<DesktopIdentityDocumentKind>("soul");
  const [loading, setLoading] = useState(false);
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
    void refresh().catch(() => undefined);
  }, [active, projectId, refresh]);

  const currentDocument = overview?.documents[documentKind];

  return (
    <section aria-busy={loading} className="identity-section" hidden={hidden} id="identity">
      <div className="section-heading-row">
        <div>
          <h3>Agent 灵魂</h3>
          <p>身份资料默认开启并随每个新回合加载。</p>
        </div>
        <span className="settings-scope-badge">本机资料</span>
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
                  setDocumentKind(option.kind);
                }}
                role="tab"
                type="button"
              >
                <strong>{option.label}</strong><small>{option.description}</small>
              </button>
            ))}
          </div>
          <div className="identity-preview-card">
            <div className="section-heading-row">
              <div><strong>{documentOptions.find((option) => option.kind === documentKind)?.label}</strong><small>{currentDocument ? `当前 revision ${String(currentDocument.revision)}` : "尚未创建"}</small></div>
              <button aria-label="刷新身份资料" className="icon-button" disabled={loading} onClick={() => { void refresh().catch(() => undefined); onNotify(""); }} title="刷新" type="button"><Icon name="refresh" size={14} /></button>
            </div>
            <div aria-label={`${documentKind} Markdown`} className="identity-markdown-preview"><Markdown remarkPlugins={[remarkGfm]}>{currentDocument?.content ?? defaultDocument(documentKind)}</Markdown></div>
          </div>
        </>
      ) : <p className="settings-effective-hint">{loading ? "正在读取身份资料…" : "尚未读取身份资料。"}</p>}
      <p className="settings-effective-hint">身份文档保存在 Biny 的全局 agent 目录；它们是长期资料。</p>
    </section>
  );
}

function defaultDocument(kind: DesktopIdentityDocumentKind): string {
  const heading = documentLabel(kind);
  return `# ${heading}\n\n`;
}

function documentLabel(kind: DesktopIdentityDocumentKind): string {
  return documentOptions.find((option) => option.kind === kind)?.label ?? kind;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
