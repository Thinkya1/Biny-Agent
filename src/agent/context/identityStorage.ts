/**
 * Agent 身份资料的本地 Markdown 存储。
 *
 * 文档正文是 canonical state，revision 元数据放在同一个受保护目录中。所有写操作都经过
 * 文件锁和 revision CAS，避免 Desktop、TUI 和运行中的 Runtime 互相覆盖长期身份。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { globalAgentDir } from "../../config/paths.js";
import {
  identityDocument,
  identityDocumentFileNames,
  normalizeIdentityContent,
  renderIdentityPrompt
} from "./identityFormat.js";
import {
  identityDocumentKinds,
  type IdentityDocument,
  type IdentityDocumentKind
} from "./identityTypes.js";

const identityVersion = 1;
const stateFileName = ".identity-state.json";
const lockDirectoryName = ".identity.lock";
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
}

interface IdentityStorageOptions {
  agentDir?: string;
  now?: () => Date;
}

export interface IdentityOverview {
  revision: number;
  documents: Partial<Record<IdentityDocumentKind, IdentityDocument>>;
}

export class IdentityRevisionConflictError extends Error {
  readonly name = "IdentityRevisionConflictError";

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Identity revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}.`);
  }
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
    if (!await this.hasRoot()) {
      return { revision: 0, documents: {} };
    }
    const state = await this.readState();
    return await this.overviewFromState(state);
  }

  async promptText(includeUser = true): Promise<string | undefined> {
    const snapshot = await this.overview();
    return renderIdentityPrompt({ documents: snapshot.documents, includeUser });
  }

  /** 直接写入文档正文；expectedRevision 是乐观锁，不匹配时抛冲突让调用方重读。 */
  async saveDocument(
    document: IdentityDocumentKind,
    content: string,
    expectedRevision: number,
    _reason?: string
  ): Promise<IdentityOverview> {
    return await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRevision(expectedRevision, state.revision);
      const normalized = normalizeIdentityContent(content, document);
      if (!normalized) throw new Error("身份资料不能为空。");
      const timestamp = this.now().toISOString();
      const nextRevision = state.revision + 1;
      const next = identityDocument(document, normalized, nextRevision, timestamp);
      await this.writeDocument(next);
      await this.writeHistory(next);
      state.documents[document] = {
        revision: next.revision,
        updatedAt: next.updatedAt,
        contentHash: next.contentHash
      };
      state.revision = nextRevision;
      state.updatedAt = timestamp;
      await this.writeState(state);
      return await this.overviewFromState(state);
    });
  }

  private async overviewFromState(state: IdentityState): Promise<IdentityOverview> {
    const documents: Partial<Record<IdentityDocumentKind, IdentityDocument>> = {};
    for (const kind of identityDocumentKinds) {
      const document = await this.readDocument(kind, state);
      if (document) documents[kind] = document;
    }
    return {
      revision: state.revision,
      documents
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
        documents
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

  private async hasRoot(): Promise<boolean> {
    try {
      const stat = await fs.lstat(this.root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Identity storage root must be a real directory.");
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
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
