/**
 * Agent 身份资料与演化提案的共享契约。
 *
 * 身份文档是用户可审计的 Markdown canonical state；提案只描述待确认的下一版本，
 * 不会在模型输出后直接改写 SOUL/USER 等长期资料。
 */

export const identityDocumentKinds = ["soul", "identity", "style", "user"] as const;
export type IdentityDocumentKind = (typeof identityDocumentKinds)[number];

export type IdentityProposalKind = "import" | "manual" | "evolution";
export type IdentityProposalStatus = "pending" | "accepted" | "rejected" | "stale";

export interface IdentityDocument {
  kind: IdentityDocumentKind;
  content: string;
  revision: number;
  updatedAt: string;
  contentHash: string;
}

export interface IdentityProposalSource {
  kind: "alma" | "manual" | "memory";
  relativePath?: string;
  contentHash?: string;
  candidateIds?: string[];
}

export interface IdentityProposal {
  id: string;
  kind: IdentityProposalKind;
  document: IdentityDocumentKind;
  /** 该文档创建提案时的 revision；接受前必须仍然匹配。 */
  baseRevision: number;
  /** 防止用户直接编辑 Markdown 后，旧提案覆盖新正文。 */
  baseContentHash: string;
  proposedContent: string;
  reason: string;
  evidence: string[];
  source?: IdentityProposalSource;
  status: IdentityProposalStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedRevision?: number;
  /** 只表示发现了疑似凭据，不保存匹配内容。 */
  secretWarning?: string;
}

export interface IdentityImportFile {
  relativePath: string;
  kind: "soul" | "identity" | "style" | "user" | "memory" | "daily_memory";
  exists: boolean;
  bytes: number;
  modifiedAt?: string;
  contentHash?: string;
  /** 导入预览需要的正文；不会进入 telemetry 或 session event。 */
  content?: string;
  /** 只表示正文中发现了疑似凭据，不保存匹配内容。 */
  secretWarning?: string;
  error?: string;
}

export interface IdentityImportSource {
  provider: "alma";
  root: string;
  fingerprint: string;
  files: IdentityImportFile[];
  importedAt: string;
}

export interface IdentityOverview {
  revision: number;
  documents: Partial<Record<IdentityDocumentKind, IdentityDocument>>;
  proposals: IdentityProposal[];
  importSource?: IdentityImportSource;
}

export interface IdentityDocumentInput {
  document: IdentityDocumentKind;
  content: string;
  reason?: string;
  source?: IdentityProposalSource;
  evidence?: string[];
  secretWarning?: string;
}

export interface IdentityReviewResult {
  proposal: IdentityProposal;
  overview: IdentityOverview;
}

export class IdentityRevisionConflictError extends Error {
  readonly name = "IdentityRevisionConflictError";

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Identity revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
}
