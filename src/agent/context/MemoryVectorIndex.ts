/**
 * 记忆 Embedding 的可重建 SQLite 投影。
 *
 * SQLite 条目是唯一事实来源；这里用 generation 隔离重建过程，只有完整 generation
 * 会原子成为 active。任何模型指纹或维度不一致都会 fail closed，不混用旧向量。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, normalizeEmbedding } from "../../llm/embedding/vector.js";
import { memoryDatabaseFileName } from "./memoryStorage.js";

const rebuildLockSuffix = ".rebuild.lock";
const sqliteBusyTimeoutMs = 5_000;
const maxSearchLimit = 100;

export type MemoryVectorGenerationStatus = "building" | "active" | "failed";

export interface MemoryVectorInput {
  entryId: string;
  contentHash: string;
  embedding: ArrayLike<number>;
}

export interface MemoryVectorSearchResult {
  entryId: string;
  contentHash: string;
  similarity: number;
}

export type MemoryVectorEntryStatus = "pending" | "failed" | "indexed";

export interface MemoryVectorEntryIdentity {
  entryId: string;
  contentHash: string;
}

export interface MemoryVectorEntryState extends MemoryVectorEntryIdentity {
  modelFingerprint: string;
  status: MemoryVectorEntryStatus;
  error?: string;
  updatedAt: string;
}

export interface MemoryVectorIndexStatus {
  active?: {
    generationId: string;
    modelFingerprint: string;
    dimensions: number;
    vectorCount: number;
    createdAt: string;
    completedAt: string;
  };
  building: number;
  failed: number;
}

interface GenerationRow {
  generation_id: unknown;
  model_fingerprint: unknown;
  dimensions: unknown;
  status: unknown;
  created_at: unknown;
  completed_at: unknown;
  error: unknown;
}

interface VectorRow {
  entry_id: unknown;
  content_hash: unknown;
  embedding: unknown;
}

interface EntryStateRow {
  entry_id: unknown;
  model_fingerprint: unknown;
  content_hash: unknown;
  status: unknown;
  error: unknown;
  updated_at: unknown;
}

interface MemoryVectorIndexOpenOptions {
  readOnly?: boolean;
}

export class MemoryVectorIndex {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private closed = false;

  static openReadOnly(memoryRoot: string): MemoryVectorIndex | undefined {
    const resolvedRoot = path.resolve(memoryRoot);
    const databasePath = path.join(resolvedRoot, memoryDatabaseFileName);
    if (!existsSync(databasePath)) return undefined;
    const index = new MemoryVectorIndex(resolvedRoot, { readOnly: true });
    if (!index.hasSchema()) {
      // Facts may have created memory.sqlite before the first embedding
      // operation. A read path must treat missing vector tables as an absent
      // derived index, not migrate or mutate the shared database.
      index.close();
      return undefined;
    }
    return index;
  }

  constructor(memoryRoot: string, options: MemoryVectorIndexOpenOptions = {}) {
    const resolvedRoot = path.resolve(memoryRoot);
    if (!options.readOnly) mkdirSync(resolvedRoot, { recursive: true });
    this.databasePath = path.join(resolvedRoot, memoryDatabaseFileName);
    assertSafeDatabaseFile(this.databasePath);
    this.database = new DatabaseSync(this.databasePath, {
      timeout: sqliteBusyTimeoutMs,
      enableForeignKeyConstraints: true,
      readOnly: options.readOnly
    });
    try {
      if (!options.readOnly) {
        this.migrate();
        this.recoverAbandonedGenerations();
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /**
   * rebuild 会跨越模型请求，SQLite transaction 不能覆盖这段时间；用同目录的独占锁
   * 保证不同项目的 Runtime Host 不会同时切换同一个全局向量库。进程被杀死时，下一次
   * 获取锁会根据 pid 清理遗留 generation。
   */
  acquireRebuildLock(): () => void {
    this.assertOpen();
    const lockPath = `${this.databasePath}${rebuildLockSuffix}`;
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString()
        }), "utf8");
        closeSync(descriptor);
        descriptor = undefined;
        try {
          this.recoverAbandonedGenerations(token);
        } catch (error) {
          releaseRebuildLock(lockPath, token);
          throw error;
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseRebuildLock(lockPath, token);
        };
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            // 保留最初的锁获取错误。
          }
        }
        if (isAlreadyExistsError(error) && attempt === 0) {
          const lock = readRebuildLock(lockPath);
          if (lock !== undefined && isProcessAlive(lock.pid)) {
            throw new Error("Memory vector rebuild is already running.");
          }
          unlinkRebuildLock(lockPath);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unable to acquire memory vector rebuild lock.");
  }

  beginGeneration(modelFingerprint: string, dimensions: number, generationId = randomUUID()): string {
    this.assertOpen();
    validateFingerprint(modelFingerprint);
    validateDimensions(dimensions);
    validateIdentifier(generationId, "generation");
    const now = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO memory_vector_generations (generation_id, model_fingerprint, dimensions, status, created_at) VALUES (?, ?, ?, 'building', ?)"
    ).run(generationId, modelFingerprint, dimensions, now);
    return generationId;
  }

  putVectors(generationId: string, inputs: readonly MemoryVectorInput[]): void {
    this.assertOpen();
    const generation = this.requireGeneration(generationId);
    if (generation.status !== "building") throw new Error(`Memory vector generation ${generationId} is not building.`);
    this.writeVectors(generation, inputs);
  }

  /** 切换与清理旧 active generation 在同一个 SQLite transaction 内完成。 */
  completeGeneration(generationId: string): void {
    this.assertOpen();
    const generation = this.requireGeneration(generationId);
    if (generation.status === "active") return;
    if (generation.status !== "building") throw new Error(`Memory vector generation ${generationId} cannot be activated.`);
    const now = new Date().toISOString();
    this.transaction(() => {
      const vectors = this.database.prepare(
        "SELECT entry_id, content_hash FROM memory_vectors WHERE generation_id = ?"
      ).all(generationId) as unknown as Array<{ entry_id: unknown; content_hash: unknown }>;
      const identities = vectors.map((row) => ({
        entryId: stringValue(row.entry_id, "entry id"),
        contentHash: stringValue(row.content_hash, "content hash")
      }));
      this.database.prepare("UPDATE memory_vector_generations SET status = 'failed', error = 'superseded', completed_at = ? WHERE status = 'active' AND generation_id <> ?").run(now, generationId);
      this.database.prepare("UPDATE memory_vector_generations SET status = 'active', completed_at = ?, error = NULL WHERE generation_id = ?").run(now, generationId);
      this.database.prepare(
        "INSERT INTO memory_vector_meta (key, value) VALUES ('active_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(generationId);
      // generation 切换会清掉全部旧向量，因此旧 indexed 状态也必须同时失效。
      this.database.prepare(
        "UPDATE memory_vector_entry_states SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'indexed'"
      ).run(now);
      this.writeEntryStatesInTransaction(
        generation.modelFingerprint,
        identities,
        "indexed",
        undefined,
        now
      );
      this.database.prepare(
        "DELETE FROM memory_vectors WHERE generation_id <> ? AND generation_id IN (SELECT generation_id FROM memory_vector_generations WHERE status <> 'building')"
      ).run(generationId);
      this.database.prepare("DELETE FROM memory_vector_generations WHERE generation_id <> ? AND status <> 'building'").run(generationId);
    });
  }

  failGeneration(generationId: string, error: unknown): void {
    this.assertOpen();
    const generation = this.requireGeneration(generationId);
    if (generation.status === "active") throw new Error("The active memory vector generation cannot be failed.");
    if (generation.status === "failed") return;
    const detail = error instanceof Error ? error.message : String(error);
    this.database.prepare(
      "UPDATE memory_vector_generations SET status = 'failed', completed_at = ?, error = ? WHERE generation_id = ?"
    ).run(new Date().toISOString(), detail.slice(0, 2_048), generationId);
  }

  /**
   * 条目增量更新只写入指纹和维度都匹配的 active generation。返回 false 表示调用方应
   * 安排完整重建，不能把新向量塞进旧模型索引。
   */
  upsertActiveVectors(modelFingerprint: string, inputs: readonly MemoryVectorInput[]): boolean {
    this.assertOpen();
    const active = this.activeGeneration();
    if (!active || active.modelFingerprint !== modelFingerprint) return false;
    if (inputs.some((input) => input.embedding.length !== active.dimensions)) return false;
    this.writeVectors({ ...active, status: "active" }, inputs);
    return true;
  }

  markEntriesPending(modelFingerprint: string, inputs: readonly MemoryVectorEntryIdentity[]): void {
    this.writeEntryStates(modelFingerprint, inputs, "pending");
  }

  markEntriesFailed(
    modelFingerprint: string,
    inputs: readonly MemoryVectorEntryIdentity[],
    error: unknown
  ): void {
    this.writeEntryStates(modelFingerprint, inputs, "failed", error);
  }

  /**
   * 只把与当前内容哈希和 active generation 都一致的条目视为 indexed。这样即使进程在
   * 事实提交后崩溃，重启后的统计也不会把旧内容向量误报成已索引。
   *
   * 这是纯读取：缺失或失配状态只在返回值中临时视为 pending，持久化状态由明确的
   * 增量索引和完整重建写路径负责，不能让 status() 暗中修复索引。
   */
  entryStates(
    modelFingerprint: string,
    inputs: readonly MemoryVectorEntryIdentity[]
  ): MemoryVectorEntryState[] {
    this.assertOpen();
    validateFingerprint(modelFingerprint);
    const identities = prepareEntryIdentities(inputs);
    if (!identities.length) return [];
    const requested = new Map(identities.map((input) => [entryStateKey(input.entryId, input.contentHash), input]));
    const rows = this.database.prepare(
      "SELECT entry_id, model_fingerprint, content_hash, status, error, updated_at FROM memory_vector_entry_states WHERE model_fingerprint = ?"
    ).all(modelFingerprint) as unknown as EntryStateRow[];
    const states = new Map(rows.map((row) => {
      const state = toEntryState(row);
      return [entryStateKey(state.entryId, state.contentHash), state];
    }));
    const active = this.activeGeneration();
    const activeVectors = active?.modelFingerprint === modelFingerprint
      ? new Set((this.database.prepare(
        "SELECT entry_id, content_hash FROM memory_vectors WHERE generation_id = ?"
      ).all(active.generationId) as unknown as Array<{ entry_id: unknown; content_hash: unknown }>).map((row) => (
        entryStateKey(stringValue(row.entry_id, "entry id"), stringValue(row.content_hash, "content hash"))
      )))
      : new Set<string>();
    const now = new Date().toISOString();
    return [...requested].map(([key, input]) => {
      const state = states.get(key);
      if (!state) return { ...input, modelFingerprint, status: "pending", updatedAt: now };
      if (state.status === "indexed" && !activeVectors.has(key)) {
        return { ...state, status: "pending", error: undefined, updatedAt: now };
      }
      return state;
    });
  }

  removeEntries(entryIds: readonly string[]): void {
    this.assertOpen();
    const ids = uniqueEntryIds(entryIds);
    if (!ids.length) return;
    this.transaction(() => {
      const removeVector = this.database.prepare("DELETE FROM memory_vectors WHERE entry_id = ?");
      const removeState = this.database.prepare("DELETE FROM memory_vector_entry_states WHERE entry_id = ?");
      for (const id of ids) {
        removeVector.run(id);
        removeState.run(id);
      }
    });
  }

  search(
    query: ArrayLike<number>,
    options: {
      modelFingerprint: string;
      limit?: number;
      minimumSimilarity?: number;
      entryIds?: ReadonlySet<string>;
    }
  ): MemoryVectorSearchResult[] {
    this.assertOpen();
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSearchLimit) {
      throw new Error(`Memory vector search limit must be between 1 and ${String(maxSearchLimit)}.`);
    }
    const minimumSimilarity = options.minimumSimilarity ?? -1;
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < -1 || minimumSimilarity > 1) {
      throw new Error("Memory vector similarity threshold must be between -1 and 1.");
    }
    const active = this.activeGeneration();
    if (!active || active.modelFingerprint !== options.modelFingerprint || active.dimensions !== query.length) return [];
    const normalizedQuery = normalizeEmbedding(query);
    const rows = this.database.prepare(
      `SELECT vectors.entry_id, vectors.content_hash, vectors.embedding
       FROM memory_vectors AS vectors
       INNER JOIN memory_vector_entry_states AS states
         ON states.entry_id = vectors.entry_id
        AND states.model_fingerprint = ?
        AND states.content_hash = vectors.content_hash
        AND states.status = 'indexed'
       WHERE vectors.generation_id = ?`
    ).all(active.modelFingerprint, active.generationId) as unknown as VectorRow[];
    const results: MemoryVectorSearchResult[] = [];
    for (const row of rows) {
      const entryId = stringValue(row.entry_id, "entry id");
      if (options.entryIds && !options.entryIds.has(entryId)) continue;
      try {
        const embedding = decodeEmbedding(row.embedding, active.dimensions);
        const similarity = cosineSimilarity(normalizedQuery, embedding);
        if (similarity >= minimumSimilarity) {
          results.push({ entryId, contentHash: stringValue(row.content_hash, "content hash"), similarity });
        }
      } catch {
        // 索引是派生数据。单条损坏应被跳过并由后续重建修复，不能阻断词法降级。
      }
    }
    return results
      .sort((left, right) => right.similarity - left.similarity || left.entryId.localeCompare(right.entryId))
      .slice(0, limit);
  }

  /** 读取 active generation 的全部可用向量，供 Sleep 做两两相似度聚类。 */
  listActiveEmbeddings(options: {
    modelFingerprint: string;
    entryIds?: ReadonlySet<string>;
  }): Array<{ entryId: string; contentHash: string; embedding: Float32Array }> {
    this.assertOpen();
    validateFingerprint(options.modelFingerprint);
    const active = this.activeGeneration();
    if (!active || active.modelFingerprint !== options.modelFingerprint) return [];
    const rows = this.database.prepare(
      `SELECT vectors.entry_id, vectors.content_hash, vectors.embedding
       FROM memory_vectors AS vectors
       INNER JOIN memory_vector_entry_states AS states
         ON states.entry_id = vectors.entry_id
        AND states.model_fingerprint = ?
        AND states.content_hash = vectors.content_hash
        AND states.status = 'indexed'
       WHERE vectors.generation_id = ?`
    ).all(active.modelFingerprint, active.generationId) as unknown as VectorRow[];
    const embeddings: Array<{ entryId: string; contentHash: string; embedding: Float32Array }> = [];
    for (const row of rows) {
      const entryId = stringValue(row.entry_id, "entry id");
      if (options.entryIds && !options.entryIds.has(entryId)) continue;
      try {
        embeddings.push({
          entryId,
          contentHash: stringValue(row.content_hash, "content hash"),
          embedding: decodeEmbedding(row.embedding, active.dimensions)
        });
      } catch {
        // 索引是派生数据；单条损坏只会让该条暂时无法参与 Sleep。
      }
    }
    return embeddings;
  }

  status(): MemoryVectorIndexStatus {
    this.assertOpen();
    const active = this.activeGeneration();
    const counts = this.database.prepare(
      "SELECT status, COUNT(*) AS count FROM memory_vector_generations GROUP BY status"
    ).all() as unknown as Array<{ status: unknown; count: unknown }>;
    const count = (status: MemoryVectorGenerationStatus): number => {
      const row = counts.find((candidate) => candidate.status === status);
      return row ? nonNegativeInteger(row.count, `${status} generation count`) : 0;
    };
    const vectorCount = active === undefined
      ? 0
      : nonNegativeInteger(
        (this.database.prepare(
          `SELECT COUNT(*) AS count
           FROM memory_vectors AS vectors
           INNER JOIN memory_vector_entry_states AS states
             ON states.entry_id = vectors.entry_id
            AND states.model_fingerprint = ?
            AND states.content_hash = vectors.content_hash
            AND states.status = 'indexed'
           WHERE vectors.generation_id = ?`
        ).get(active.modelFingerprint, active.generationId) as { count?: unknown } | undefined)?.count,
        "vector count"
      );
    return {
      active: active === undefined ? undefined : { ...active, vectorCount },
      building: count("building"),
      failed: count("failed")
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private activeGeneration(): MemoryVectorIndexStatus["active"] | undefined {
    const row = this.database.prepare(
      "SELECT generation_id, model_fingerprint, dimensions, status, created_at, completed_at, error FROM memory_vector_generations WHERE generation_id = (SELECT value FROM memory_vector_meta WHERE key = 'active_generation') AND status = 'active'"
    ).get() as unknown as GenerationRow | undefined;
    if (!row) return undefined;
    const generation = toGeneration(row);
    if (!generation.completedAt) throw new Error("Active memory vector generation has no completion timestamp.");
    return {
      generationId: generation.generationId,
      modelFingerprint: generation.modelFingerprint,
      dimensions: generation.dimensions,
      vectorCount: 0,
      createdAt: generation.createdAt,
      completedAt: generation.completedAt
    };
  }

  private requireGeneration(generationId: string): ReturnType<typeof toGeneration> {
    validateIdentifier(generationId, "generation");
    const row = this.database.prepare(
      "SELECT generation_id, model_fingerprint, dimensions, status, created_at, completed_at, error FROM memory_vector_generations WHERE generation_id = ?"
    ).get(generationId) as unknown as GenerationRow | undefined;
    if (!row) throw new Error(`Unknown memory vector generation: ${generationId}`);
    return toGeneration(row);
  }

  private writeVectors(
    generation: {
      generationId: string;
      modelFingerprint: string;
      dimensions: number;
      status?: MemoryVectorGenerationStatus;
    },
    inputs: readonly MemoryVectorInput[]
  ): void {
    const prepared = inputs.map((input) => {
      validateIdentifier(input.entryId, "memory entry");
      validateContentHash(input.contentHash);
      if (input.embedding.length !== generation.dimensions) {
        throw new Error(`Memory vector for ${input.entryId} has an incompatible dimension.`);
      }
      return { ...input, embedding: encodeEmbedding(normalizeEmbedding(input.embedding)) };
    });
    const now = new Date().toISOString();
    this.transaction(() => {
      const statement = this.database.prepare(
        "INSERT INTO memory_vectors (generation_id, entry_id, content_hash, embedding, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(generation_id, entry_id) DO UPDATE SET content_hash = excluded.content_hash, embedding = excluded.embedding, updated_at = excluded.updated_at"
      );
      for (const input of prepared) {
        statement.run(generation.generationId, input.entryId, input.contentHash, input.embedding, now);
      }
      if (generation.status === "active") {
        this.writeEntryStatesInTransaction(generation.modelFingerprint, prepared, "indexed", undefined, now);
      }
    });
  }

  private writeEntryStates(
    modelFingerprint: string,
    inputs: readonly MemoryVectorEntryIdentity[],
    status: MemoryVectorEntryStatus,
    error?: unknown
  ): void {
    this.assertOpen();
    validateFingerprint(modelFingerprint);
    const identities = prepareEntryIdentities(inputs);
    if (!identities.length) return;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.writeEntryStatesInTransaction(modelFingerprint, identities, status, error, now);
    });
  }

  private writeEntryStatesInTransaction(
    modelFingerprint: string,
    inputs: readonly MemoryVectorEntryIdentity[],
    status: MemoryVectorEntryStatus,
    error: unknown,
    now: string
  ): void {
    const invalidate = this.database.prepare(
      "UPDATE memory_vector_entry_states SET status = 'pending', error = NULL, updated_at = ? WHERE entry_id = ? AND model_fingerprint = ?"
    );
    const upsert = this.database.prepare(
      `INSERT INTO memory_vector_entry_states
         (entry_id, model_fingerprint, content_hash, status, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entry_id, model_fingerprint, content_hash) DO UPDATE SET
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`
    );
    const detail = status === "failed" ? errorMessage(error).slice(0, 2_048) : undefined;
    for (const input of inputs) {
      invalidate.run(now, input.entryId, modelFingerprint);
      upsert.run(input.entryId, modelFingerprint, input.contentHash, status, detail ?? null, now);
    }
  }

  private migrate(): void {
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    // Facts and embeddings deliberately share one physical database. The fact
    // store owns PRAGMA user_version, so vector tables use idempotent DDL here
    // instead of a second schema-version state machine. This also lets a fact
    // database created before the first embedding operation become searchable
    // without changing its existing revision or migration history.
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_vector_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_vector_generations (
          generation_id TEXT PRIMARY KEY,
          model_fingerprint TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          status TEXT NOT NULL CHECK (status IN ('building', 'active', 'failed')),
          created_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS memory_vectors (
          generation_id TEXT NOT NULL REFERENCES memory_vector_generations(generation_id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (generation_id, entry_id)
        );
        CREATE INDEX IF NOT EXISTS memory_vectors_entry_idx ON memory_vectors(entry_id);
        CREATE TABLE IF NOT EXISTS memory_vector_entry_states (
          entry_id TEXT NOT NULL,
          model_fingerprint TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'indexed')),
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (entry_id, model_fingerprint, content_hash)
        );
        CREATE INDEX IF NOT EXISTS memory_vector_entry_states_model_idx
          ON memory_vector_entry_states(model_fingerprint, status);
      `);
    });
  }

  private hasSchema(): boolean {
    const required = [
      "memory_vector_meta",
      "memory_vector_generations",
      "memory_vectors",
      "memory_vector_entry_states"
    ];
    const present = new Set((this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all() as Array<{ name?: unknown }>).map((row) => row.name));
    return required.every((name) => present.has(name));
  }

  private recoverAbandonedGenerations(ownerToken?: string): void {
    const lockPath = `${this.databasePath}${rebuildLockSuffix}`;
    const lock = readRebuildLock(lockPath);
    if (lock !== undefined && lock.token !== ownerToken && isProcessAlive(lock.pid)) return;
    if (lock !== undefined && lock.token !== ownerToken) unlinkRebuildLock(lockPath);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.database.prepare(
        "UPDATE memory_vector_generations SET status = 'failed', completed_at = ?, error = 'interrupted' WHERE status = 'building'"
      ).run(now);
    });
  }

  private transaction<T>(execute: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = execute();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 保留原始失败；SQLite 连接会在下一次操作时给出权威状态。
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory vector index is closed.");
  }
}

export function memoryVectorContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toGeneration(row: GenerationRow): {
  generationId: string;
  modelFingerprint: string;
  dimensions: number;
  status: MemoryVectorGenerationStatus;
  createdAt: string;
  completedAt?: string;
  error?: string;
} {
  const status = stringValue(row.status, "generation status");
  if (status !== "building" && status !== "active" && status !== "failed") {
    throw new Error(`Invalid memory vector generation status: ${status}`);
  }
  return {
    generationId: stringValue(row.generation_id, "generation id"),
    modelFingerprint: stringValue(row.model_fingerprint, "model fingerprint"),
    dimensions: positiveInteger(row.dimensions, "embedding dimensions"),
    status,
    createdAt: stringValue(row.created_at, "created timestamp"),
    completedAt: optionalString(row.completed_at),
    error: optionalString(row.error)
  };
}

function encodeEmbedding(embedding: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let index = 0; index < embedding.length; index += 1) buffer.writeFloatLE(embedding[index]!, index * 4);
  return buffer;
}

function decodeEmbedding(value: unknown, dimensions: number): Float32Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== dimensions * 4) {
    throw new Error("Memory vector BLOB has an invalid size.");
  }
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const embedding = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) embedding[index] = buffer.readFloatLE(index * 4);
  return normalizeEmbedding(embedding);
}

function assertSafeDatabaseFile(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const link = lstatSync(databasePath);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("Memory database must be a regular file.");
  if (statSync(databasePath).nlink !== 1) throw new Error("Memory database must not be hard-linked.");
}

interface RebuildLock {
  pid: number;
  token: string;
}

function readRebuildLock(lockPath: string): RebuildLock | undefined {
  try {
    const link = lstatSync(lockPath);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error("Memory vector rebuild lock must be a regular file.");
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Memory vector rebuild lock is invalid.");
    const record = parsed as { pid?: unknown; token?: unknown };
    const pid = record.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || typeof record.token !== "string" || !record.token) {
      throw new Error("Memory vector rebuild lock is invalid.");
    }
    return { pid, token: record.token };
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function unlinkRebuildLock(lockPath: string): void {
  try {
    const link = lstatSync(lockPath);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error("Memory vector rebuild lock must be a regular file.");
    unlinkSync(lockPath);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
}

function releaseRebuildLock(lockPath: string, token: string): void {
  try {
    if (readRebuildLock(lockPath)?.token === token) unlinkRebuildLock(lockPath);
  } catch {
    // 释放锁不能覆盖已经完成的索引结果；异常锁文件留给下一次获取时诊断。
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isFileMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined
    : undefined;
}

function validateFingerprint(value: string): void {
  if (!value.trim() || value.length > 256) throw new Error("Embedding model fingerprint is invalid.");
}

function validateDimensions(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) throw new Error("Embedding dimensions are invalid.");
}

function validateIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 512 || value.includes("\0")) throw new Error(`Invalid ${label} identifier.`);
}

function validateContentHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Memory vector content hash must be SHA-256 hex.");
}

function prepareEntryIdentities(inputs: readonly MemoryVectorEntryIdentity[]): MemoryVectorEntryIdentity[] {
  const unique = new Map<string, MemoryVectorEntryIdentity>();
  for (const input of inputs) {
    validateIdentifier(input.entryId, "memory entry");
    validateContentHash(input.contentHash);
    unique.set(entryStateKey(input.entryId, input.contentHash), input);
  }
  return [...unique.values()];
}

function entryStateKey(entryId: string, contentHash: string): string {
  return `${entryId}\0${contentHash}`;
}

function toEntryState(row: EntryStateRow): MemoryVectorEntryState {
  const status = stringValue(row.status, "memory vector entry status");
  if (status !== "pending" && status !== "failed" && status !== "indexed") {
    throw new Error(`Invalid memory vector entry status: ${status}`);
  }
  return {
    entryId: stringValue(row.entry_id, "entry id"),
    modelFingerprint: stringValue(row.model_fingerprint, "model fingerprint"),
    contentHash: stringValue(row.content_hash, "content hash"),
    status,
    error: optionalString(row.error),
    updatedAt: stringValue(row.updated_at, "entry state timestamp")
  };
}

function uniqueEntryIds(values: readonly string[]): string[] {
  const ids = [...new Set(values)];
  for (const id of ids) validateIdentifier(id, "memory entry");
  return ids;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
