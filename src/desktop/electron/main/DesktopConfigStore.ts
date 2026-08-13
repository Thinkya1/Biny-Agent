/**
 * 桌面端全局配置存储。
 *
 * 生产环境直接复用 CLI 的全局配置路径和 macOS Keychain。测试通过标准 CredentialStore 注入
 * 内存实现，不再让生产类携带旧 credentials.json 格式。
 */
import path from "node:path";
import { loadConfig, saveConfig } from "../../../config/loader.js";
import {
  applyStoredCredentials,
  CREDENTIAL_TRANSACTION_JOURNAL,
  createCredentialStore,
  deferredCredentialTransactionStatus,
  finalizeDeferredCredentialTransaction,
  recoverStoredCredentialTransaction,
  rollbackDeferredCredentialTransaction,
  saveConfigAndStoredCredentials,
  type DeferredCredentialTransactionStatus,
  type CredentialStore
} from "../../../config/credentials.js";
import type { AgentConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import {
  assertConfigRevision,
  configDocumentRevision,
  withGlobalConfigWriteLock,
  type VersionedConfigSnapshot
} from "../../../config/versioned.js";

export class DesktopConfigStore implements AgentConfigStore {
  private writeTail = Promise.resolve();
  private currentRevision = 0;

  constructor(
    private readonly root: string,
    private readonly credentials: CredentialStore = createCredentialStore()
  ) {}

  async load(workspaceRoot = this.root): Promise<AgentConfig> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(
      this.root,
      async () => await this.loadUnlocked(workspaceRoot)
    ));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async save(config: AgentConfig, workspaceRoot = this.root): Promise<void> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(
      this.root,
      async () => await this.saveUnlocked(config, workspaceRoot)
    ));
    this.writeTail = run.catch(() => undefined);
    await run;
  }

  async loadVersioned(workspaceRoot = this.root): Promise<VersionedConfigSnapshot> {
    const config = await this.load(workspaceRoot);
    return { config, revision: configDocumentRevision(config) };
  }

  async saveVersioned(
    config: AgentConfig,
    expectedRevision: string,
    workspaceRoot = this.root
  ): Promise<VersionedConfigSnapshot> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      assertConfigRevision(expectedRevision, await this.loadUnlocked(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot);
      const saved = await this.loadUnlocked(workspaceRoot);
      return { config: saved, revision: configDocumentRevision(saved) };
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async saveVersionedDeferred(
    config: AgentConfig,
    expectedRevision: string,
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<VersionedConfigSnapshot> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      assertConfigRevision(expectedRevision, await this.loadUnlocked(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot, deferredFor);
      const saved = await this.loadUnlocked(workspaceRoot);
      return { config: saved, revision: configDocumentRevision(saved) };
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async deferredCredentialStatus(
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<DeferredCredentialTransactionStatus> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => (
      await deferredCredentialTransactionStatus(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      )
    )));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async finalizeDeferredCredentials(deferredFor: string, workspaceRoot = this.root): Promise<void> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      await finalizeDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      );
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    await run;
  }

  async rollbackVersionedDeferred(
    before: AgentConfig,
    targetRevision: string,
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<"not_needed" | "completed" | "failed"> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      const loadDocument = async (): Promise<AgentConfig> => await loadConfig(workspaceRoot, { globalDir: this.root });
      await recoverStoredCredentialTransaction(this.credentials, this.credentialJournalPath(), loadDocument);
      const currentRevision = configDocumentRevision(await loadDocument());
      const beforeRevision = configDocumentRevision(before);
      const configNeedsRollback = currentRevision === targetRevision && targetRevision !== beforeRevision;
      if (!configNeedsRollback && currentRevision !== beforeRevision) return "failed" as const;
      const credentialSide = await rollbackDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        loadDocument,
        deferredFor,
        configNeedsRollback
          ? async () => {
              await saveConfig(workspaceRoot, before, { globalDir: this.root });
              assertConfigRevision(beforeRevision, await loadDocument());
            }
          : undefined
      );
      if (configNeedsRollback) this.currentRevision += 1;
      return configNeedsRollback || credentialSide === "target" ? "completed" as const : "not_needed" as const;
    }).catch(() => "failed" as const));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async rollbackDeferredCredentials(
    deferredFor: string,
    workspaceRoot = this.root
  ): Promise<"not_needed" | "completed" | "failed"> {
    const run = this.writeTail.then(async () => await withGlobalConfigWriteLock(this.root, async () => {
      const side = await rollbackDeferredCredentialTransaction(
        this.credentials,
        this.credentialJournalPath(),
        async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
        deferredFor
      );
      return side === "target" ? "completed" as const : "not_needed" as const;
    }).catch(() => "failed" as const));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  configPath(): string {
    return path.join(this.root, "config.json");
  }

  revision(): number {
    return this.currentRevision;
  }

  private async saveUnlocked(config: AgentConfig, workspaceRoot: string, deferredFor?: string): Promise<void> {
    const previous = await this.loadUnlocked(workspaceRoot);
    await saveConfigAndStoredCredentials(
      config,
      previous,
      this.credentials,
      this.credentialJournalPath(),
      async () => await saveConfig(workspaceRoot, config, { globalDir: this.root }),
      async () => await loadConfig(workspaceRoot, { globalDir: this.root }),
      { deferredFor }
    );
    this.currentRevision += 1;
  }

  private async loadUnlocked(workspaceRoot: string): Promise<AgentConfig> {
    const loadDocument = async (): Promise<AgentConfig> => await loadConfig(workspaceRoot, { globalDir: this.root });
    await recoverStoredCredentialTransaction(
      this.credentials,
      this.credentialJournalPath(),
      loadDocument
    );
    return await applyStoredCredentials(await loadDocument(), this.credentials);
  }

  private credentialJournalPath(): string {
    return path.join(this.root, CREDENTIAL_TRANSACTION_JOURNAL);
  }
}
