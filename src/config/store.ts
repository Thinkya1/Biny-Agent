/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI/TUI 与 Electron 都通过全局配置和统一凭据存储
 * 获取模型设置，项目覆盖由 workspaceRoot 决定。
 */
import { loadConfig, saveConfig, type ConfigPathOptions } from "./loader.js";
import {
  applyStoredCredentials,
  createCredentialStore,
  saveStoredCredentials,
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
  const load = async (requestedWorkspaceRoot?: string): Promise<AgentConfig> => await applyStoredCredentials(
    await loadConfig(requestedWorkspaceRoot ?? workspaceRoot, pathOptions),
    credentials
  );
  const saveUnlocked = async (config: AgentConfig, requestedWorkspaceRoot?: string): Promise<void> => {
    const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
    const previous = await load(targetRoot);
    await saveStoredCredentials(config, credentials, previous);
    await saveConfig(targetRoot, config, pathOptions);
    revision += 1;
  };
  return {
    load,
    save: async (config, requestedWorkspaceRoot) => await withGlobalConfigWriteLock(
      configRoot,
      async () => await saveUnlocked(config, requestedWorkspaceRoot)
    ),
    revision: () => revision,
    loadVersioned: async (requestedWorkspaceRoot) => {
      const config = await load(requestedWorkspaceRoot);
      return { config, revision: configDocumentRevision(config) };
    },
    saveVersioned: async (config, expectedRevision, requestedWorkspaceRoot) => await withGlobalConfigWriteLock(
      configRoot,
      async () => {
        assertConfigRevision(expectedRevision, await load(requestedWorkspaceRoot));
        await saveUnlocked(config, requestedWorkspaceRoot);
        const saved = await load(requestedWorkspaceRoot);
        return { config: saved, revision: configDocumentRevision(saved) };
      }
    )
  };
}
