/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI/TUI 与 Electron 都通过全局配置和统一凭据存储
 * 获取模型设置，项目覆盖由 workspaceRoot 决定。
 */
import path from "node:path";
import { loadConfig, saveConfig, type ConfigPathOptions } from "./loader.js";
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
} from "./credentials.js";
import type { AgentConfig } from "./schema.js";
import {
  assertConfigRevision,
  configDocumentRevision,
  withGlobalConfigWriteLock,
  type VersionedConfigSnapshot
} from "./versioned.js";
import { globalConfigDir } from "./paths.js";

/** 运行时面向的配置存储接口。 */
export interface AgentConfigStore {
  load(workspaceRoot?: string): Promise<AgentConfig>;
  save(config: AgentConfig, workspaceRoot?: string): Promise<void>;
  /** 当前进程内成功写入配置的版本号；runtime 用它避免每次 prompt 都重新读盘。 */
  revision?(): number;
  /** 跨进程配置 CAS；个性化和记忆策略的 UI/RPC 写入必须使用这组接口。 */
  loadVersioned?(workspaceRoot?: string): Promise<VersionedConfigSnapshot>;
  saveVersioned?(config: AgentConfig, expectedRevision: string, workspaceRoot?: string): Promise<VersionedConfigSnapshot>;
  /** Desktop 外层设置事务使用：保存后保留 Keychain before/target，直到显式 finalize/rollback。 */
  saveVersionedDeferred?(
    config: AgentConfig,
    expectedRevision: string,
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<VersionedConfigSnapshot>;
  deferredCredentialStatus?(
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<DeferredCredentialTransactionStatus>;
  finalizeDeferredCredentials?(deferredFor: string, workspaceRoot?: string): Promise<void>;
  rollbackVersionedDeferred?(
    before: AgentConfig,
    targetRevision: string,
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<"not_needed" | "completed" | "failed">;
  rollbackDeferredCredentials?(
    deferredFor: string,
    workspaceRoot?: string
  ): Promise<"not_needed" | "completed" | "failed">;
}

export interface FileConfigStoreOptions {
  credentialStore?: CredentialStore;
  globalDir?: string;
}

export function createFileConfigStore(workspaceRoot: string, options: FileConfigStoreOptions = {}): AgentConfigStore {
  const credentials = options.credentialStore ?? createCredentialStore();
  const pathOptions: ConfigPathOptions = { globalDir: options.globalDir };
  const configRoot = options.globalDir ?? globalConfigDir();
  let revision = 0;
  let writeTail = Promise.resolve();
  const journalPath = path.join(configRoot, CREDENTIAL_TRANSACTION_JOURNAL);
  const loadUnlocked = async (requestedWorkspaceRoot?: string): Promise<AgentConfig> => {
    const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
    const loadDocument = async (): Promise<AgentConfig> => await loadConfig(targetRoot, pathOptions);
    await recoverStoredCredentialTransaction(credentials, journalPath, loadDocument);
    return await applyStoredCredentials(await loadDocument(), credentials);
  };
  const load = async (requestedWorkspaceRoot?: string): Promise<AgentConfig> => {
    const run = writeTail.then(async () => await withGlobalConfigWriteLock(
      configRoot,
      async () => await loadUnlocked(requestedWorkspaceRoot)
    ));
    writeTail = run.then(() => undefined, () => undefined);
    return await run;
  };
  const saveUnlocked = async (
    config: AgentConfig,
    requestedWorkspaceRoot?: string,
    deferredFor?: string
  ): Promise<void> => {
    const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
    const previous = await loadUnlocked(targetRoot);
    await saveConfigAndStoredCredentials(
      config,
      previous,
      credentials,
      journalPath,
      async () => await saveConfig(targetRoot, config, pathOptions),
      async () => await loadConfig(targetRoot, pathOptions),
      { deferredFor }
    );
    revision += 1;
  };
  return {
    load,
    save: async (config, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(
        configRoot,
        async () => await saveUnlocked(config, requestedWorkspaceRoot)
      ));
      writeTail = run.then(() => undefined, () => undefined);
      await run;
    },
    revision: () => revision,
    loadVersioned: async (requestedWorkspaceRoot) => {
      const config = await load(requestedWorkspaceRoot);
      return { config, revision: configDocumentRevision(config) };
    },
    saveVersioned: async (config, expectedRevision, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        assertConfigRevision(expectedRevision, await loadUnlocked(requestedWorkspaceRoot));
        await saveUnlocked(config, requestedWorkspaceRoot);
        const saved = await loadUnlocked(requestedWorkspaceRoot);
        return { config: saved, revision: configDocumentRevision(saved) };
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    saveVersionedDeferred: async (config, expectedRevision, deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        assertConfigRevision(expectedRevision, await loadUnlocked(requestedWorkspaceRoot));
        await saveUnlocked(config, requestedWorkspaceRoot, deferredFor);
        const saved = await loadUnlocked(requestedWorkspaceRoot);
        return { config: saved, revision: configDocumentRevision(saved) };
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    deferredCredentialStatus: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        return await deferredCredentialTransactionStatus(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
      }));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    finalizeDeferredCredentials: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        await finalizeDeferredCredentialTransaction(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
      }));
      writeTail = run.then(() => undefined, () => undefined);
      await run;
    },
    rollbackVersionedDeferred: async (before, targetRevision, deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        const loadDocument = async (): Promise<AgentConfig> => await loadConfig(targetRoot, pathOptions);
        await recoverStoredCredentialTransaction(credentials, journalPath, loadDocument);
        const currentRevision = configDocumentRevision(await loadDocument());
        const beforeRevision = configDocumentRevision(before);
        const configNeedsRollback = currentRevision === targetRevision && targetRevision !== beforeRevision;
        if (!configNeedsRollback && currentRevision !== beforeRevision) return "failed" as const;
        const credentialSide = await rollbackDeferredCredentialTransaction(
          credentials,
          journalPath,
          loadDocument,
          deferredFor,
          configNeedsRollback
            ? async () => {
                await saveConfig(targetRoot, before, pathOptions);
                assertConfigRevision(beforeRevision, await loadDocument());
              }
            : undefined
        );
        if (configNeedsRollback) revision += 1;
        return configNeedsRollback || credentialSide === "target" ? "completed" as const : "not_needed" as const;
      }).catch(() => "failed" as const));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    },
    rollbackDeferredCredentials: async (deferredFor, requestedWorkspaceRoot) => {
      const run = writeTail.then(async () => await withGlobalConfigWriteLock(configRoot, async () => {
        const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
        const side = await rollbackDeferredCredentialTransaction(
          credentials,
          journalPath,
          async () => await loadConfig(targetRoot, pathOptions),
          deferredFor
        );
        return side === "target" ? "completed" as const : "not_needed" as const;
      }).catch(() => "failed" as const));
      writeTail = run.then(() => undefined, () => undefined);
      return await run;
    }
  };
}
