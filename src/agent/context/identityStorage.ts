/**
 * Agent 身份资料的本地 Markdown 存储。
 *
 * 文档正文是 canonical state，提案与 revision 元数据放在同一个受保护目录中。所有接受
 * 操作都经过文件锁和双重 CAS（revision + content hash），避免 Desktop、TUI 和运行中的
 * Runtime 互相覆盖长期身份。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir } from "../../config/paths.js";
import {
  identityContentHash,
  identityDocument,
  identityDocumentFileNames,
  detectIdentitySecretWarning,
  normalizeIdentityContent,
  renderIdentityPrompt
} from "./identityFormat.js";
import {
  identityDocumentKinds,
  type IdentityDocument,
  type IdentityDocumentInput,
  type IdentityDocumentKind,
  type IdentityImportFile,
  type IdentityImportSource,
  type IdentityOverview,
  type IdentityProposal,
  type IdentityProposalSource,
  type IdentityProposalStatus,
  type IdentityReviewResult,
  IdentityRevisionConflictError
} from "./identityTypes.js";

const identityVersion = 1;
const stateFileName = ".identity-state.json";
const lockDirectoryName = ".identity.lock";
const proposalDirectoryName = "proposals";
const historyDirectoryName = "history";
const lockTimeoutMs = 5_000;
const staleLockMs = 120_000;

interface IdentityDocumentState {
  revision: number;
  updatedAt: string;
  contentHash: string;
}

interface IdentityState {
  version: 1;
  revision: number;
  updatedAt: string;
  documents: Partial<Record<IdentityDocumentKind, IdentityDocumentState>>;
  importSource?: IdentityImportSource;
}

interface IdentityStorageOptions {
  agentDir?: string;
  now?: () => Date;
}

const documentStateSchema = {
  parse(value: unknown): IdentityDocumentState {
    if (typeof value !== "object" || value === null) throw new Error("Invalid identity document state.");
    const candidate = value as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0) throw new Error("Invalid identity document revision.");
    if (typeof candidate.updatedAt !== "string" || typeof candidate.contentHash !== "string") throw new Error("Invalid identity document metadata.");
    return {
      revision: Number(candidate.revision),
      updatedAt: candidate.updatedAt,
      contentHash: candidate.contentHash
    };
  }
};

export class IdentityStorage {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(options: IdentityStorageOptions = {}) {
    this.root = path.join(path.resolve(options.agentDir ?? globalAgentDir()), "identity");
    this.now = options.now ?? (() => new Date());
  }

  get directory(): string {
    return this.root;
  }

  async initialize(): Promise<void> {
    await this.ensureRoot();
  }

  async overview(): Promise<IdentityOverview> {
    await this.ensureRoot();
    const state = await this.readState();
    const documents: Partial<Record<IdentityDocumentKind, IdentityDocument>> = {};
    for (const kind of identityDocumentKinds) {
      const document = await this.readDocument(kind, state);
      if (document) documents[kind] = document;
    }
    return {
      revision: state.revision,
      documents,
      proposals: await this.readProposals(),
      importSource: state.importSource
    };
  }

  async promptText(includeUser = true): Promise<string | undefined> {
    const snapshot = await this.overview();
    return renderIdentityPrompt({ documents: snapshot.documents, includeUser });
  }

  async createProposal(input: IdentityDocumentInput): Promise<IdentityProposal> {
    const proposals = await this.createProposals([input]);
    const proposal = proposals[0];
    if (!proposal) throw new Error("Identity proposal was not created.");
    return proposal;
  }

  async createProposals(inputs: readonly IdentityDocumentInput[]): Promise<IdentityProposal[]> {
    if (!inputs.length) return [];
    return await this.withLock(async () => {
      const state = await this.readState();
      const existing = await this.readProposals();
      const created: IdentityProposal[] = [];
      for (const input of inputs) {
        const normalized = normalizeIdentityContent(input.content, input.document);
        if (!normalized) continue;
        const current = await this.readDocument(input.document, state);
        if (current && current.contentHash === identityContentHash(normalized)) continue;
        const baseRevision = current?.revision ?? 0;
        const baseContentHash = current?.contentHash ?? identityContentHash("");
        const duplicate = [...created, ...existing].find((candidate) => (
          candidate.status === "pending"
          && candidate.document === input.document
          && candidate.baseRevision === baseRevision
          && candidate.baseContentHash === baseContentHash
          && identityContentHash(candidate.proposedContent) === identityContentHash(normalized)
        ));
        if (duplicate) {
          created.push(duplicate);
          continue;
        }
        const timestamp = this.now().toISOString();
        const proposal: IdentityProposal = {
          id: randomUUID(),
          kind: input.source?.kind === "alma" ? "import" : input.source?.kind === "memory" ? "evolution" : "manual",
          document: input.document,
          baseRevision,
          baseContentHash,
          proposedContent: normalized,
          reason: cleanText(input.reason ?? "更新身份资料", 1_000),
          evidence: cleanList(input.evidence, 16, 1_000),
          source: input.source,
          status: "pending",
          createdAt: timestamp,
          secretWarning: cleanOptional(input.secretWarning ?? detectIdentitySecretWarning(normalized), 500)
        };
        await this.writeProposal(proposal);
        created.push(proposal);
        state.revision += 1;
        state.updatedAt = timestamp;
      }
      if (created.length) await this.writeState(state);
      return created;
    });
  }

  async reviewProposal(
    proposalId: string,
    action: "accept" | "reject",
    expectedRevision: number
  ): Promise<IdentityReviewResult> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const proposal = await this.readProposal(proposalId);
      if (!proposal) throw new Error("未找到该身份提案。");
      if (proposal.status !== "pending") throw new Error("该身份提案已经处理过了。");
      const timestamp = this.now().toISOString();
      const nextRevision = state.revision + 1;
      if (action === "accept") {
        if (proposal.secretWarning) throw new Error("该提案包含疑似凭据，不能直接写入身份资料。");
        const current = await this.readDocument(proposal.document, state);
        const currentRevision = current?.revision ?? 0;
        const currentHash = current?.contentHash ?? identityContentHash("");
        if (currentRevision !== proposal.baseRevision || currentHash !== proposal.baseContentHash) {
          throw new IdentityRevisionConflictError(proposal.baseRevision, currentRevision);
        }
        const document = identityDocument(proposal.document, proposal.proposedContent, nextRevision, timestamp);
        await this.writeDocument(document);
        await this.writeHistory(document);
        state.documents[proposal.document] = {
          revision: document.revision,
          updatedAt: document.updatedAt,
          contentHash: document.contentHash
        };
      }
      const next: IdentityProposal = {
        ...proposal,
        status: action === "accept" ? "accepted" : "rejected",
        reviewedAt: timestamp,
        reviewedRevision: nextRevision
      };
      await this.writeProposal(next);
      state.revision = nextRevision;
      state.updatedAt = timestamp;
      await this.writeState(state);
      return { proposal: next, overview: await this.overviewUnlocked(state) };
    });
  }

  async recordImportSource(source: IdentityImportSource): Promise<void> {
    return await this.withLock(async () => {
      const state = await this.readState();
      if (state.importSource?.provider === source.provider
        && state.importSource.root === source.root
        && state.importSource.fingerprint === source.fingerprint) return;
      state.importSource = {
        ...source,
        files: source.files.map(stripImportContent)
      };
      state.revision += 1;
      state.updatedAt = this.now().toISOString();
      await this.writeState(state);
    });
  }

  async setDocumentProposal(
    document: IdentityDocumentKind,
    content: string,
    expectedRevision: number,
    reason = "手动编辑身份资料"
  ): Promise<IdentityProposal> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const normalized = normalizeIdentityContent(content, document);
      if (!normalized) throw new Error("身份资料不能为空。");
      const current = await this.readDocument(document, state);
      const timestamp = this.now().toISOString();
      const proposal: IdentityProposal = {
        id: randomUUID(),
        kind: "manual",
        document,
        baseRevision: current?.revision ?? 0,
        baseContentHash: current?.contentHash ?? identityContentHash(""),
        proposedContent: normalized,
        reason: cleanText(reason, 1_000) || "手动编辑身份资料",
        evidence: [],
        source: { kind: "manual" },
        status: "pending",
        createdAt: timestamp,
        secretWarning: detectIdentitySecretWarning(normalized)
      };
      await this.writeProposal(proposal);
      state.revision += 1;
      state.updatedAt = timestamp;
      await this.writeState(state);
      return proposal;
    });
  }

  private async overviewUnlocked(state: IdentityState): Promise<IdentityOverview> {
    const documents: Partial<Record<IdentityDocumentKind, IdentityDocument>> = {};
    for (const kind of identityDocumentKinds) {
      const document = await this.readDocument(kind, state);
      if (document) documents[kind] = document;
    }
    return {
      revision: state.revision,
      documents,
      proposals: await this.readProposals(),
      importSource: state.importSource
    };
  }

  private async readDocument(kind: IdentityDocumentKind, state: IdentityState): Promise<IdentityDocument | undefined> {
    const content = await readOptional(path.join(this.root, identityDocumentFileNames[kind]));
    if (content === undefined) return undefined;
    const metadata = state.documents[kind];
    const normalized = normalizeIdentityContent(content, kind);
    return identityDocument(
      kind,
      normalized,
      metadata?.revision ?? 0,
      metadata?.updatedAt ?? new Date(0).toISOString()
    );
  }

  private async writeDocument(document: IdentityDocument): Promise<void> {
    await this.writeFile(path.join(this.root, identityDocumentFileNames[document.kind]), document.content.endsWith("\n") ? document.content : `${document.content}\n`);
  }

  private async writeHistory(document: IdentityDocument): Promise<void> {
    await this.writeFile(
      path.join(this.root, historyDirectoryName, `${document.kind}-${String(document.revision)}.md`),
      document.content.endsWith("\n") ? document.content : `${document.content}\n`
    );
  }

  private async readProposals(): Promise<IdentityProposal[]> {
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.root, proposalDirectoryName))).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const proposals: IdentityProposal[] = [];
    for (const name of names) {
      const content = await readOptional(path.join(this.root, proposalDirectoryName, name));
      if (!content) continue;
      try {
        const parsed = parseProposal(JSON.parse(content));
        if (parsed) proposals.push(parsed);
      } catch {
        // 单个损坏提案不应阻止身份文档和其它提案加载；Desktop 会看不到该条记录。
      }
    }
    return proposals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async readProposal(id: string): Promise<IdentityProposal | undefined> {
    const content = await readOptional(path.join(this.root, proposalDirectoryName, `${safeFileName(id)}.json`));
    if (!content) return undefined;
    try {
      return parseProposal(JSON.parse(content));
    } catch {
      return undefined;
    }
  }

  private async writeProposal(proposal: IdentityProposal): Promise<void> {
    await this.writeFile(
      path.join(this.root, proposalDirectoryName, `${safeFileName(proposal.id)}.json`),
      `${JSON.stringify(proposal, null, 2)}\n`
    );
  }

  private async readState(): Promise<IdentityState> {
    const content = await readOptional(path.join(this.root, stateFileName));
    if (!content) return emptyState();
    try {
      const parsed = JSON.parse(content) as Partial<IdentityState>;
      if (parsed.version !== identityVersion || !Number.isSafeInteger(parsed.revision) || parsed.revision === undefined || parsed.revision < 0) {
        throw new Error("Invalid identity state.");
      }
      const documents: Partial<Record<IdentityDocumentKind, IdentityDocumentState>> = {};
      for (const kind of identityDocumentKinds) {
        const value = parsed.documents?.[kind];
        if (value !== undefined) documents[kind] = documentStateSchema.parse(value);
      }
      return {
        version: 1,
        revision: parsed.revision,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        documents,
        importSource: parsed.importSource
      };
    } catch (error) {
      throw new Error(`无法读取身份状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeState(state: IdentityState): Promise<void> {
    await this.writeFile(path.join(this.root, stateFileName), `${JSON.stringify(state, null, 2)}\n`);
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    const lockPath = path.join(this.root, lockDirectoryName);
    const startedAt = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) await fs.rm(lockPath, { recursive: true, force: true });
        } catch (statError) {
          if (!isNotFound(statError)) throw statError;
        }
        if (Date.now() - startedAt >= lockTimeoutMs) throw new Error("身份存储锁等待超时，请稍后重试。");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
}

function emptyState(): IdentityState {
  return { version: 1, revision: 0, updatedAt: new Date(0).toISOString(), documents: {} };
}

function assertExpectedRevision(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Identity expected revision is invalid.");
  if (expected !== actual) throw new IdentityRevisionConflictError(expected, actual);
}

function parseProposal(value: unknown): IdentityProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.proposedContent !== "string" || typeof candidate.reason !== "string") return undefined;
  if (!identityDocumentKinds.includes(candidate.document as IdentityDocumentKind)) return undefined;
  if (candidate.kind !== "import" && candidate.kind !== "manual" && candidate.kind !== "evolution") return undefined;
  if (candidate.status !== "pending" && candidate.status !== "accepted" && candidate.status !== "rejected" && candidate.status !== "stale") return undefined;
  if (!Number.isSafeInteger(candidate.baseRevision) || !Number.isSafeInteger(candidate.reviewedRevision ?? 0)) return undefined;
  if (typeof candidate.baseContentHash !== "string" || !Array.isArray(candidate.evidence) || !candidate.evidence.every((item) => typeof item === "string")) return undefined;
  if (typeof candidate.createdAt !== "string") return undefined;
  const document = candidate.document as IdentityDocumentKind;
  const kind = candidate.kind as IdentityProposal["kind"];
  const status = candidate.status as IdentityProposalStatus;
  const baseRevision = candidate.baseRevision as number;
  const baseContentHash = candidate.baseContentHash as string;
  const evidence = candidate.evidence as string[];
  const reviewedRevision = Number.isSafeInteger(candidate.reviewedRevision)
    ? candidate.reviewedRevision as number
    : undefined;
  return {
    id: candidate.id as string,
    kind,
    document,
    baseRevision,
    baseContentHash,
    proposedContent: candidate.proposedContent as string,
    reason: candidate.reason as string,
    evidence,
    source: parseProposalSource(candidate.source),
    status,
    createdAt: candidate.createdAt,
    reviewedAt: typeof candidate.reviewedAt === "string" ? candidate.reviewedAt : undefined,
    reviewedRevision,
    secretWarning: typeof candidate.secretWarning === "string" ? candidate.secretWarning : undefined
  };
}

function parseProposalSource(value: unknown): IdentityProposalSource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "alma" && candidate.kind !== "manual" && candidate.kind !== "memory") return undefined;
  return {
    kind: candidate.kind,
    relativePath: typeof candidate.relativePath === "string" ? candidate.relativePath : undefined,
    contentHash: typeof candidate.contentHash === "string" ? candidate.contentHash : undefined,
    candidateIds: Array.isArray(candidate.candidateIds) && candidate.candidateIds.every((item) => typeof item === "string")
      ? candidate.candidateIds
      : undefined
  };
}

function cleanText(value: string, maxChars: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function cleanOptional(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = cleanText(value, maxChars);
  return cleaned || undefined;
}

function cleanList(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  return (values ?? []).map((value) => cleanText(value, maxChars)).filter(Boolean).slice(0, maxItems);
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 180);
  return safe || randomUUID();
}

function stripImportContent(file: IdentityImportFile): IdentityImportFile {
  const { content: _content, ...metadata } = file;
  return metadata;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
