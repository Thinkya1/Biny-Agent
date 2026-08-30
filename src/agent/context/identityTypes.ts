/**
 * Agent 身份资料的共享契约。
 *
 * 身份文档是用户可审计的 Markdown canonical state，直接由用户维护 SOUL/USER 等长期资料。
 */

export const identityDocumentKinds = ["soul", "user"] as const;
export type IdentityDocumentKind = (typeof identityDocumentKinds)[number];

export interface IdentityDocument {
  kind: IdentityDocumentKind;
  content: string;
  revision: number;
  updatedAt: string;
  contentHash: string;
}
