/**
 * 全局配置的跨进程写锁与内容 revision。
 *
 * Runtime Host 可能按项目各自运行，但它们最终共享同一个全局 config.json。这里用
 * 单链接锁文件串行化 read-modify-write，并用不含凭据正文的稳定哈希做 CAS。
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./schema.js";

const configLockFileName = ".config.write.lock";
const configLockTimeoutMs = 5_000;
const configLockPollMs = 25;

export interface VersionedConfigSnapshot {
  config: AgentConfig;
  revision: string;
}

export class ConfigRevisionConflictError extends Error {
  readonly name = "ConfigRevisionConflictError";

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string
  ) {
    super(`Global config revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`);
  }
}

/** revision 覆盖非凭据配置和凭据槽位的非机密版本；Keychain/token 正文既不进入 IPC，也不进入哈希。 */
export function configDocumentRevision(config: AgentConfig): string {
  const publicConfig = structuredClone(config) as AgentConfig;
  // 联网搜索密钥和 provider 凭据都保存在凭据存储中，不属于 config.json 文档内容。
  // 凭据正文仍不参与 revision；只对外持久化随机版本 nonce，避免把密钥正文混入哈希。
  delete publicConfig.web.search.apiKey;
  for (const provider of Object.values(publicConfig.providers)) {
    delete provider.apiKey;
    if (provider.oauth) delete provider.oauth.refreshToken;
  }
  for (const server of Object.values(publicConfig.extensions.mcp)) {
    for (const key of Object.keys(server.credentialRefs?.env ?? {})) delete server.env?.[key];
    for (const key of Object.keys(server.credentialRefs?.headers ?? {})) delete server.headers?.[key];
  }
  return `sha256:${createHash("sha256").update(stableJson(publicConfig)).digest("hex")}`;
}

export function assertConfigRevision(expectedRevision: string, config: AgentConfig): void {
  const actualRevision = configDocumentRevision(config);
  if (actualRevision !== expectedRevision) {
    throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
  }
}

export async function withGlobalConfigWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await ensureRealDirectory(root);
  const lockPath = path.join(await fs.realpath(path.resolve(root)), configLockFileName);
  const deadline = Date.now() + configLockTimeoutMs;
  let handle: FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, writeNewFlags(), 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString("hex") })}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await removeDeadOwnerLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the global config write lock.");
      await new Promise<void>((resolve) => setTimeout(resolve, configLockPollMs));
    }
  }

  const identity = await assertLockBinding(lockPath, handle);
  try {
    return await operation();
  } finally {
    try {
      await assertLockBinding(lockPath, handle, identity);
      await fs.unlink(lockPath);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

async function ensureRealDirectory(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Configuration root must be a real directory.");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Configuration root must be a real directory.");
  }
  await fs.chmod(root, 0o700);
}

async function removeDeadOwnerLock(lockPath: string): Promise<boolean> {
  const initial = await safeLockStat(lockPath);
  if (!initial) return true;
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
  let pid: number | undefined;
  try {
    const value = JSON.parse(raw) as { pid?: unknown };
    if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) pid = Number(value.pid);
  } catch {
    // 不删除无法验证所有者的锁文件；调用方会得到有界超时，而不是越权清理。
  }
  if (pid === undefined || processIsAlive(pid)) return false;
  const current = await safeLockStat(lockPath);
  if (!current || !sameIdentity(initial, current)) return false;
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
  return true;
}

async function safeLockStat(lockPath: string): Promise<Stats | undefined> {
  try {
    const stat = await fs.lstat(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(lockPath) !== lockPath) {
      throw new Error("Global config lock must be a single-link regular file.");
    }
    return stat;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function assertLockBinding(
  lockPath: string,
  handle: FileHandle,
  expected?: Pick<Stats, "dev" | "ino">
): Promise<Pick<Stats, "dev" | "ino">> {
  const descriptor = await handle.stat();
  const target = await safeLockStat(lockPath);
  if (!target || !descriptor.isFile() || descriptor.nlink !== 1 || !sameIdentity(descriptor, target)) {
    throw new Error("Global config lock changed during access.");
  }
  if (expected && !sameIdentity(expected, descriptor)) throw new Error("Global config lock changed during access.");
  return { dev: descriptor.dev, ino: descriptor.ino };
}

function stableJson(value: unknown): string {
  // 与 JSON.stringify 的持久化语义保持一致：对象里的 undefined 键会消失，数组槽位则为
  // null。否则构造候选时显式传入可选 undefined 会产生一个永远无法从磁盘复读的 revision。
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
