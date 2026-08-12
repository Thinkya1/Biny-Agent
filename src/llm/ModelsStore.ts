/**
 * Provider 模型目录存储。
 *
 * 文件只保存可公开的模型元数据和 HTTP 校验信息，不保存 API key、OAuth token、Cookie 或
 * Authorization header。写入使用进程内串行、跨进程锁和同目录原子替换。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelCatalogEntry } from "../ai/types.js";
import { globalModelsStorePath } from "../config/paths.js";

export interface ModelsStoreEntry {
  models: ModelCatalogEntry[];
  checkedAt?: number;
  lastModified?: number;
  etag?: string;
}

export interface ModelsStore {
  read(providerId: string): Promise<ModelsStoreEntry | undefined>;
  write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
}

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string(),
  showInPicker: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  limits: z.object({
    maxInputTokens: z.number().int().positive().optional(),
    reasoningReserveTokens: z.number().int().nonnegative().optional(),
    toolSchemaReserveTokens: z.number().int().nonnegative().optional(),
    systemPromptReserveTokens: z.number().int().nonnegative().optional(),
    protocolSafetyMarginTokens: z.number().int().nonnegative().optional()
  }).optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    reasoningStream: z.boolean().optional(),
    reasoningSummary: z.boolean().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    streaming: z.boolean().optional()
  }),
  reasoningEfforts: z.array(z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  apiBackend: z.string().optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: z.object({
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
  }).optional()
});

const entrySchema = z.object({
  models: z.array(modelSchema),
  checkedAt: z.number().int().nonnegative().optional(),
  lastModified: z.number().int().nonnegative().optional(),
  etag: z.string().max(1_024).optional()
});

const fileSchema = z.object({
  version: z.literal(1),
  providers: z.record(entrySchema)
});

type ModelsStoreFile = z.infer<typeof fileSchema>;

export class InMemoryModelsStore implements ModelsStore {
  private readonly entries = new Map<string, ModelsStoreEntry>();

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = this.entries.get(providerId);
    return entry ? structuredClone(entry) : undefined;
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.entries.set(providerId, sanitizeEntry(entry));
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
}

export class FileModelsStore implements ModelsStore {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(filePath = globalModelsStorePath()) {
    this.filePath = path.resolve(filePath);
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const data = await readStoreFile(this.filePath);
    const entry = data.providers[providerId];
    return entry ? structuredClone(entry) as ModelsStoreEntry : undefined;
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.serialize(async () => {
      await withStoreLock(this.filePath, async () => {
        const data = await readStoreFile(this.filePath);
        data.providers[providerId] = sanitizeEntry(entry);
        await writeStoreFile(this.filePath, data);
      });
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.serialize(async () => {
      await withStoreLock(this.filePath, async () => {
        const data = await readStoreFile(this.filePath);
        delete data.providers[providerId];
        await writeStoreFile(this.filePath, data);
      });
    });
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const running = this.pending.then(operation, operation);
    this.pending = running.catch(() => undefined);
    await running;
  }
}

export async function restoreProviderCatalogs(
  providerIds: readonly string[],
  store: ModelsStore
): Promise<Array<[string, ModelCatalogEntry[]]>> {
  const restored = await Promise.all(providerIds.map(async (providerId) => {
    const entry = await store.read(providerId).catch(() => undefined);
    return entry?.models.length ? [providerId, entry.models] as [string, ModelCatalogEntry[]] : undefined;
  }));
  return restored.filter((item): item is [string, ModelCatalogEntry[]] => item !== undefined);
}

function sanitizeEntry(entry: ModelsStoreEntry): ModelsStoreEntry {
  return {
    models: entry.models.map((model) => ({
      ...model,
      headers: sanitizeHeaders(model.headers)
    })),
    checkedAt: entry.checkedAt,
    lastModified: entry.lastModified,
    etag: entry.etag
  };
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const safe = Object.fromEntries(Object.entries(headers).filter(([name]) => (
    !/authorization|api[-_]?key|token|cookie|secret|credential/iu.test(name)
  )));
  return Object.keys(safe).length ? safe : undefined;
}

async function readStoreFile(filePath: string): Promise<ModelsStoreFile> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await fs.readFile(filePath, "utf8")));
    return parsed.success ? parsed.data : emptyStore();
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return emptyStore();
    throw error;
  }
}

async function writeStoreFile(filePath: string, data: ModelsStoreFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withStoreLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.unlink(lockPath).catch(() => undefined);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for model store lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function emptyStore(): ModelsStoreFile {
  return { version: 1, providers: {} };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
