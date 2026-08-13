/**
 * 统一模型凭据存储。
 *
 * macOS 上 CLI、TUI 和 Electron 都通过 `security` 访问同一个 Keychain service/account；其他平台
 * 不落盘，模型凭据只从配置声明的环境变量读取。凭据值不会进入 IPC、session 或 config.json。
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "./schema.js";
import { configDocumentRevision } from "./versioned.js";

const execFileAsync = promisify(execFile);

export const BINY_KEYCHAIN_SERVICE = "com.biny.agent";
export const WEB_SEARCH_CREDENTIAL_ACCOUNT = "web-search:apiKey";
export const CREDENTIAL_TRANSACTION_JOURNAL = ".credentials.transaction.json";

export type ProviderCredentialKind = "apiKey" | "refreshToken";

export interface CredentialStore {
  readonly persistent: boolean;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

type CredentialTransactionStage =
  | "prepared"
  | "credentials_applied"
  | "config_applied"
  | "rolling_back"
  | "rolled_back"
  | "finalizing";

interface CredentialTransactionMutation {
  account: string;
  beforeAccount: string;
  beforePresent: boolean;
  targetAccount: string;
  targetPresent: boolean;
}

interface CredentialTransactionJournal {
  version: 1;
  id: string;
  /** Desktop 外层设置事务 id；存在时必须由外层显式 finalize/rollback。 */
  deferredFor?: string;
  stage: CredentialTransactionStage;
  beforeRevision: string;
  targetRevision: string;
  mutations: CredentialTransactionMutation[];
}

export type DeferredCredentialTransactionStatus = "missing" | "before" | "target";

export interface CredentialTransactionOptions {
  deferredFor?: string;
}

export class CredentialRecoveryRequiredError extends Error {
  readonly name = "CredentialRecoveryRequiredError";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export interface KeychainCommandResult {
  stdout: string;
  stderr?: string;
}

export type KeychainCommand = (command: string, args: string[]) => Promise<KeychainCommandResult>;

export class MacKeychainCredentialStore implements CredentialStore {
  readonly persistent = true;

  constructor(
    private readonly run: KeychainCommand = async (command, args) => {
      const result = await execFileAsync(command, args, { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr };
    }
  ) {}

  async get(account: string): Promise<string | undefined> {
    try {
      const result = await this.run("security", ["find-generic-password", "-s", BINY_KEYCHAIN_SERVICE, "-a", account, "-w"]);
      const value = result.stdout.trim();
      return value || undefined;
    } catch (error) {
      if (isKeychainItemMissing(error)) return undefined;
      throw keychainError("读取", account, error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await this.run("security", ["add-generic-password", "-U", "-s", BINY_KEYCHAIN_SERVICE, "-a", account, "-w", value]);
    } catch (error) {
      throw keychainError("保存", account, error);
    }
  }

  async delete(account: string): Promise<void> {
    try {
      await this.run("security", ["delete-generic-password", "-s", BINY_KEYCHAIN_SERVICE, "-a", account]);
    } catch (error) {
      if (isKeychainItemMissing(error)) return;
      throw keychainError("删除", account, error);
    }
  }
}

/** 非 macOS 的显式无持久化实现，避免误把凭据写入一个看似安全但未审计的文件。 */
export class EnvironmentCredentialStore implements CredentialStore {
  readonly persistent = false;

  async get(_account: string): Promise<string | undefined> {
    return undefined;
  }

  async set(_account: string, _value: string): Promise<void> {
    throw new Error("当前平台不支持持久化模型凭据，请改用 providers.<alias>.apiKeyEnv 环境变量。");
  }

  async delete(_account: string): Promise<void> {
    // 环境变量不是由 Biny 管理的，删除操作没有持久化副作用。
  }
}

export function createCredentialStore(platform = process.platform): CredentialStore {
  return platform === "darwin" ? new MacKeychainCredentialStore() : new EnvironmentCredentialStore();
}

export function providerCredentialAccount(providerAlias: string, kind: ProviderCredentialKind): string {
  return `provider:${providerAlias}:${kind}`;
}

export function applyStoredCredentials(config: AgentConfig, store: CredentialStore): Promise<AgentConfig> {
  return loadStoredCredentials(config, store);
}

export async function loadStoredCredentials(config: AgentConfig, store: CredentialStore): Promise<AgentConfig> {
  const next = structuredClone(config);
  for (const [alias, provider] of Object.entries(next.providers)) {
    const apiKey = await store.get(providerCredentialAccount(alias, "apiKey"));
    const refreshToken = await store.get(providerCredentialAccount(alias, "refreshToken"));
    if (apiKey) provider.apiKey = apiKey;
    if (provider.oauth && refreshToken) provider.oauth.refreshToken = refreshToken;
  }
  const webSearchApiKey = await store.get(WEB_SEARCH_CREDENTIAL_ACCOUNT);
  if (webSearchApiKey) next.web.search.apiKey = webSearchApiKey;
  return next;
}

export async function saveStoredCredentials(config: AgentConfig, store: CredentialStore, previous?: AgentConfig): Promise<void> {
  const values: Array<{ account: string; value: string | undefined }> = [
    { account: WEB_SEARCH_CREDENTIAL_ACCOUNT, value: config.web.search.apiKey }
  ];
  for (const [alias, provider] of Object.entries(config.providers)) {
    values.push({ account: providerCredentialAccount(alias, "apiKey"), value: provider.apiKey });
    values.push({ account: providerCredentialAccount(alias, "refreshToken"), value: provider.oauth?.refreshToken });
  }
  for (const { account, value } of values) {
    if (value) await store.set(account, value);
  }
  if (previous) {
    const aliases = new Set([...Object.keys(previous.providers), ...Object.keys(config.providers)]);
    for (const alias of aliases) {
      const current = config.providers[alias];
      const old = previous.providers[alias];
      if (old?.apiKey && !current?.apiKey) await store.delete(providerCredentialAccount(alias, "apiKey"));
      if (old?.oauth?.refreshToken && !current?.oauth?.refreshToken) await store.delete(providerCredentialAccount(alias, "refreshToken"));
    }
    if (previous.web.search.apiKey && !config.web.search.apiKey) await store.delete(WEB_SEARCH_CREDENTIAL_ACCOUNT);
  }
}

/**
 * Keychain 与 config.json 的补偿事务。
 *
 * journal 只保存 account 名和配置 revision；旧值与目标值都写入事务专用临时 Keychain
 * account。进程在任何一步退出后，下一次 load 都能根据 config 文档 revision 完成目标或恢复
 * 旧值，而无需让密钥正文落入文件。
 */
export async function saveConfigAndStoredCredentials(
  config: AgentConfig,
  previous: AgentConfig,
  store: CredentialStore,
  journalPath: string,
  persistConfig: () => Promise<void>,
  loadConfigDocument: () => Promise<AgentConfig>,
  options: CredentialTransactionOptions = {}
): Promise<void> {
  await recoverStoredCredentialTransaction(store, journalPath, loadConfigDocument);
  if (await readCredentialJournal(journalPath)) {
    throw new CredentialRecoveryRequiredError("已有延迟清理的 Keychain 事务，不能开始新的配置保存。");
  }
  const journal = await prepareCredentialTransaction(
    config,
    previous,
    store,
    journalPath,
    options.deferredFor
  );
  if (!journal.mutations.length && journal.deferredFor === undefined) {
    await persistConfig();
    return;
  }
  try {
    if (journal.mutations.length) await applyCredentialMutationSide(journal, store, "target");
    journal.stage = "credentials_applied";
    await writeCredentialJournal(journalPath, journal);
    await persistConfig();
    journal.stage = "config_applied";
    await writeCredentialJournal(journalPath, journal);
    if (journal.deferredFor === undefined) {
      journal.stage = "finalizing";
      await writeCredentialJournal(journalPath, journal);
      await cleanupCredentialTransaction(journal, store, journalPath);
    }
  } catch (error) {
    try {
      await recoverStoredCredentialTransaction(store, journalPath, loadConfigDocument);
    } catch (recoveryError) {
      throw new CredentialRecoveryRequiredError(
        `配置保存失败，且 Keychain 补偿尚未完成：${safeCredentialError(recoveryError)}`,
        error
      );
    }
    throw error;
  }
}

/** load 边界先恢复未完成的凭据事务；无法证明方向时 fail closed，不返回混合状态。 */
export async function recoverStoredCredentialTransaction(
  store: CredentialStore,
  journalPath: string,
  loadConfigDocument: () => Promise<AgentConfig>
): Promise<void> {
  const journal = await readCredentialJournal(journalPath);
  if (!journal) return;
  if (journal.stage === "finalizing" || journal.stage === "rolled_back") {
    await cleanupCredentialTransaction(journal, store, journalPath);
    return;
  }
  const currentRevision = configDocumentRevision(await loadConfigDocument());
  const side = credentialTransactionSide(journal, currentRevision);
  await applyCredentialMutationSide(journal, store, side);
  if (journal.deferredFor === undefined) {
    journal.stage = side === "target" ? "finalizing" : "rolled_back";
    await writeCredentialJournal(journalPath, journal);
    await cleanupCredentialTransaction(journal, store, journalPath);
  }
}

/** 复读并校准延迟事务，但保留临时 Keychain account 供外层最终提交或补偿。 */
export async function deferredCredentialTransactionStatus(
  store: CredentialStore,
  journalPath: string,
  loadConfigDocument: () => Promise<AgentConfig>,
  deferredFor: string
): Promise<DeferredCredentialTransactionStatus> {
  await recoverStoredCredentialTransaction(store, journalPath, loadConfigDocument);
  const journal = await readCredentialJournal(journalPath);
  if (!journal) return "missing";
  assertDeferredTransaction(journal, deferredFor);
  return credentialTransactionSide(journal, configDocumentRevision(await loadConfigDocument()));
}

/** 外层设置事务完成复读后才清理 Keychain 备份。 */
export async function finalizeDeferredCredentialTransaction(
  store: CredentialStore,
  journalPath: string,
  loadConfigDocument: () => Promise<AgentConfig>,
  deferredFor: string
): Promise<void> {
  await recoverStoredCredentialTransaction(store, journalPath, loadConfigDocument);
  const journal = await readCredentialJournal(journalPath);
  if (!journal) return;
  assertDeferredTransaction(journal, deferredFor);
  const side = credentialTransactionSide(journal, configDocumentRevision(await loadConfigDocument()));
  if (side !== "target") {
    throw new CredentialRecoveryRequiredError("Keychain 延迟事务尚未到达 target，不能 finalize。");
  }
  journal.stage = "finalizing";
  await writeCredentialJournal(journalPath, journal);
  await cleanupCredentialTransaction(journal, store, journalPath);
}

/**
 * 外层事务补偿凭据，并可在同一个配置写锁内恢复 config 文档。
 * rolling_back/rolled_back 让 before==target 时也能在崩溃后继续沿补偿方向恢复。
 */
export async function rollbackDeferredCredentialTransaction(
  store: CredentialStore,
  journalPath: string,
  loadConfigDocument: () => Promise<AgentConfig>,
  deferredFor: string,
  persistRollback?: () => Promise<void>
): Promise<DeferredCredentialTransactionStatus> {
  const journal = await readCredentialJournal(journalPath);
  if (!journal) {
    await persistRollback?.();
    return "missing";
  }
  assertDeferredTransaction(journal, deferredFor);
  if (journal.stage === "finalizing") {
    throw new CredentialRecoveryRequiredError("Keychain 延迟事务已经进入 finalize，不能再切换到 rollback。");
  }
  if (journal.stage === "rolled_back") {
    await persistRollback?.();
    await cleanupCredentialTransaction(journal, store, journalPath);
    return "before";
  }
  const side = credentialTransactionSide(journal, configDocumentRevision(await loadConfigDocument()));
  journal.stage = "rolling_back";
  await writeCredentialJournal(journalPath, journal);
  await applyCredentialMutationSide(journal, store, "before");
  await persistRollback?.();
  journal.stage = "rolled_back";
  await writeCredentialJournal(journalPath, journal);
  await cleanupCredentialTransaction(journal, store, journalPath);
  return side;
}

async function prepareCredentialTransaction(
  config: AgentConfig,
  previous: AgentConfig,
  store: CredentialStore,
  journalPath: string,
  deferredFor?: string
): Promise<CredentialTransactionJournal> {
  const id = randomUUID();
  const targets = storedCredentialValues(config, previous);
  const mutations: CredentialTransactionMutation[] = [];
  const stagedAccounts: string[] = [];
  try {
    for (const [account, target] of targets) {
      const before = await store.get(account);
      if (before === target) continue;
      const accountHash = createHash("sha256").update(account).digest("hex").slice(0, 20);
      const beforeAccount = `settings-tx:${id}:${accountHash}:before`;
      const targetAccount = `settings-tx:${id}:${accountHash}:target`;
      if (before !== undefined) {
        await store.set(beforeAccount, before);
        stagedAccounts.push(beforeAccount);
      }
      if (target !== undefined) {
        await store.set(targetAccount, target);
        stagedAccounts.push(targetAccount);
      }
      mutations.push({
        account,
        beforeAccount,
        beforePresent: before !== undefined,
        targetAccount,
        targetPresent: target !== undefined
      });
    }
    const journal: CredentialTransactionJournal = {
      version: 1,
      id,
      deferredFor,
      stage: "prepared",
      beforeRevision: configDocumentRevision(previous),
      targetRevision: configDocumentRevision(config),
      mutations
    };
    if (mutations.length || deferredFor !== undefined) await writeCredentialJournal(journalPath, journal);
    return journal;
  } catch (error) {
    await Promise.allSettled(stagedAccounts.map(async (account) => await store.delete(account)));
    throw error;
  }
}

function storedCredentialValues(config: AgentConfig, previous: AgentConfig): Map<string, string | undefined> {
  const values = new Map<string, string | undefined>();
  values.set(WEB_SEARCH_CREDENTIAL_ACCOUNT, config.web.search.apiKey);
  const aliases = new Set([...Object.keys(previous.providers), ...Object.keys(config.providers)]);
  for (const alias of aliases) {
    const provider = config.providers[alias];
    values.set(providerCredentialAccount(alias, "apiKey"), provider?.apiKey);
    values.set(providerCredentialAccount(alias, "refreshToken"), provider?.oauth?.refreshToken);
  }
  return values;
}

async function applyCredentialMutationSide(
  journal: CredentialTransactionJournal,
  store: CredentialStore,
  side: "before" | "target"
): Promise<void> {
  for (const mutation of journal.mutations) {
    const present = side === "before" ? mutation.beforePresent : mutation.targetPresent;
    const stagedAccount = side === "before" ? mutation.beforeAccount : mutation.targetAccount;
    if (!present) {
      await store.delete(mutation.account);
      continue;
    }
    const value = await store.get(stagedAccount);
    if (value === undefined) throw new CredentialRecoveryRequiredError(`Keychain 临时备份缺失：${stagedAccount}`);
    await store.set(mutation.account, value);
  }
}

async function cleanupCredentialTransaction(
  journal: CredentialTransactionJournal,
  store: CredentialStore,
  journalPath: string
): Promise<void> {
  for (const mutation of journal.mutations) {
    await store.delete(mutation.beforeAccount);
    await store.delete(mutation.targetAccount);
  }
  await fs.unlink(journalPath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

async function writeCredentialJournal(journalPath: string, journal: CredentialTransactionJournal): Promise<void> {
  const temporary = `${journalPath}.tmp`;
  await fs.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, journalPath);
}

async function readCredentialJournal(journalPath: string): Promise<CredentialTransactionJournal | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(journalPath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new CredentialRecoveryRequiredError(`Keychain 事务 journal 无法读取：${safeCredentialError(error)}`);
  }
  if (!isCredentialTransactionJournal(raw)) {
    throw new CredentialRecoveryRequiredError("Keychain 事务 journal 格式无效。");
  }
  return raw;
}

function isCredentialTransactionJournal(value: unknown): value is CredentialTransactionJournal {
  if (typeof value !== "object" || value === null) return false;
  const journal = value as Partial<CredentialTransactionJournal>;
  return journal.version === 1
    && typeof journal.id === "string"
    && (journal.deferredFor === undefined || typeof journal.deferredFor === "string")
    && (journal.stage === "prepared"
      || journal.stage === "credentials_applied"
      || journal.stage === "config_applied"
      || journal.stage === "rolling_back"
      || journal.stage === "rolled_back"
      || journal.stage === "finalizing")
    && typeof journal.beforeRevision === "string"
    && typeof journal.targetRevision === "string"
    && Array.isArray(journal.mutations)
    && journal.mutations.every((mutation) => typeof mutation.account === "string"
      && typeof mutation.beforeAccount === "string"
      && typeof mutation.beforePresent === "boolean"
      && typeof mutation.targetAccount === "string"
      && typeof mutation.targetPresent === "boolean");
}

function credentialTransactionSide(
  journal: CredentialTransactionJournal,
  currentRevision: string
): "before" | "target" {
  const revisionIsBefore = currentRevision === journal.beforeRevision;
  const revisionIsTarget = currentRevision === journal.targetRevision;
  if (!revisionIsBefore && !revisionIsTarget) {
    throw new CredentialRecoveryRequiredError("配置 revision 已离开凭据事务的 before/target 状态，无法安全自动恢复。");
  }
  if (journal.stage === "rolling_back" || journal.stage === "rolled_back") return "before";
  return revisionIsTarget
    && (journal.targetRevision !== journal.beforeRevision || journal.stage === "config_applied" || journal.stage === "finalizing")
    ? "target"
    : "before";
}

function assertDeferredTransaction(journal: CredentialTransactionJournal, deferredFor: string): void {
  if (journal.deferredFor !== deferredFor) {
    throw new CredentialRecoveryRequiredError(
      `Keychain 延迟事务不属于当前设置事务：expected ${deferredFor}, actual ${journal.deferredFor ?? "none"}。`
    );
  }
}

function safeCredentialError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKeychainItemMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return code === 44 || /could not be found|SecKeychainSearchCopyNext|The specified item could not be found/i.test(stderr);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function keychainError(action: string, account: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`无法${action} macOS Keychain 凭据 ${account}：${message}`);
}
