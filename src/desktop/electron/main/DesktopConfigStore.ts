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
  createCredentialStore,
  saveStoredCredentials,
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
    return await applyStoredCredentials(await loadConfig(workspaceRoot, { globalDir: this.root }), this.credentials);
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
      assertConfigRevision(expectedRevision, await this.load(workspaceRoot));
      await this.saveUnlocked(config, workspaceRoot);
      return await this.loadVersioned(workspaceRoot);
    }));
    this.writeTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  configPath(): string {
    return path.join(this.root, "config.json");
  }

  revision(): number {
    return this.currentRevision;
  }

  private async saveUnlocked(config: AgentConfig, workspaceRoot: string): Promise<void> {
    const previous = await this.load(workspaceRoot);
    await saveStoredCredentials(config, this.credentials, previous);
    await saveConfig(workspaceRoot, config, { globalDir: this.root });
    this.currentRevision += 1;
  }
}
