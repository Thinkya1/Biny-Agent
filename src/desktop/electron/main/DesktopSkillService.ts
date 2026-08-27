/**
 * 桌面端扩展目录服务。
 *
 * Renderer 只拿 catalog 和文件内容，不直接接触绝对路径；每次读写前重新扫描并按 id
 * 解析真实目录，避免把页面初始快照当成长期授权。插件展示只读取清单和文件统计，不会
 * 为了展示而 import 或执行代码；市场下载、解包和启停仍由受管目录服务负责。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfigStore } from "../../../config/store.js";
import { updateConfig } from "../../../config/store.js";
import { configSchema } from "../../../config/schema.js";
import { createProjectSkillKey, createSkillRef } from "../../../extensions/skillRef.js";
import { resolveSkillActivation } from "../../../extensions/skillActivation.js";
import {
  readSkillCatalogFile,
  scanSkillCatalog,
  writeSkillCatalogFile,
  type SkillCatalogEntry
} from "../../../extensions/skillCatalog.js";
import {
  importManagedSkillSource,
  installManagedSkillSource,
  listManagedSkillSources
} from "../../../extensions/managedSkillSources.js";
import {
  addSkillRepository,
  discoverSkillRepositories,
  installDiscoveredSkill,
  listSkillRepositories,
  removeSkillRepository,
  searchSkillsSh,
  type DiscoverableSkill
} from "../../../extensions/skillDiscovery.js";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../../../extensions/skillImports.js";
import {
  approveSkillDraft,
  editSkillDraft,
  listSkillDrafts,
  rejectSkillDraft,
  retrySkillDraft,
  type SkillDraft
} from "../../../extensions/skillDrafts.js";
import {
  BINY_PLUGIN_REGISTRY_URL,
  installPluginFromRepository,
  parsePluginRegistry,
  projectPluginRoot,
  readPluginRegistryCache,
  readProjectPluginManifest,
  setProjectPluginEnabled,
  uninstallProjectPlugin,
  writePluginRegistryCache,
} from "../../../extensions/pluginRegistry.js";
import { getSharedProxyAwareFetch } from "../../../network/proxyFetch.js";
import type {
  DesktopDiscoverableSkill,
  DesktopManagedSkillSource,
  DesktopPluginSummary,
  DesktopSkillCatalogSnapshot,
  DesktopSkillFilePreview,
  DesktopSkillRepository,
  DesktopSkillsShSearchResult,
  DesktopSkillImportResult,
  DesktopSkillSettings,
  DesktopSkillDraft,
  DesktopPluginRegistrySnapshot
} from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

const maxPluginEntries = 64;

export class DesktopSkillService {
  constructor(
    private readonly state: DesktopStateStore,
    private readonly configStore: AgentConfigStore,
    private readonly fetcher: typeof globalThis.fetch = getSharedProxyAwareFetch()
  ) {}

  async snapshot(projectId?: string): Promise<DesktopSkillCatalogSnapshot> {
    const projectRoots = this.projectsFor(projectId).map((project) => project.path);
    const [skills, plugins, managedSources] = await Promise.all([
      scanSkillCatalog({ projectRoots }),
      this.listPlugins(projectId),
      listManagedSkillSources()
    ]);
    return {
      skills: skills.skills,
      inventory: skills.inventory,
      unmanagedSkills: listUnmanagedSkillCandidates(skills),
      plugins: plugins.plugins,
      managedSources: managedSources.sources.map(toDesktopManagedSkillSource),
      warnings: [...skills.warnings, ...managedSources.warnings, ...plugins.warnings],
      diagnostics: skills.diagnostics
    };
  }

  async settings(projectId: string): Promise<DesktopSkillSettings> {
    const project = this.requireProject(projectId);
    const config = await this.configStore.load(project.path);
    const projectKey = createProjectSkillKey(project.path);
    const catalog = await scanSkillCatalog({ projectRoots: [project.path] });
    const projectOverrides = config.extensions.skillProjectOverrides[projectKey] ?? {};
    return {
      projectId,
      projectKey,
      globalDefaults: { ...config.extensions.skillDefaults },
      projectOverrides: { ...projectOverrides },
      extraction: { ...config.extensions.skillExtraction },
      activations: catalog.skills.map((skill) => {
        const state = resolveSkillActivation({
          ref: skill.ref,
          globalDefaults: config.extensions.skillDefaults,
          projectOverrides
        });
        return {
          ref: skill.ref,
          id: skill.id,
          enabled: state.enabled,
          globalEnabled: state.globalEnabled,
          projectOverride: state.projectOverride,
          source: state.source
        };
      })
    };
  }

  async drafts(projectId: string): Promise<DesktopSkillDraft[]> {
    return (await listSkillDrafts(this.requireProject(projectId).path)).map(toDesktopSkillDraft);
  }

  async approveDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft> {
    const project = this.requireProject(projectId);
    const draft = await approveSkillDraft(project.path, draftId);
    const projectKey = createProjectSkillKey(project.path);
    await updateConfig(this.configStore, project.path, (config) => configSchema.parse({
      ...config,
      extensions: {
        ...config.extensions,
        skillProjectOverrides: {
          ...config.extensions.skillProjectOverrides,
          [projectKey]: {
            ...config.extensions.skillProjectOverrides[projectKey],
            [createSkillRef({ scope: "project", name: draft.name, projectRoot: project.path, source: "biny" })]: false
          }
        }
      }
    }));
    return toDesktopSkillDraft(draft);
  }

  async rejectDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft> {
    return toDesktopSkillDraft(await rejectSkillDraft(this.requireProject(projectId).path, draftId));
  }

  async retryDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft> {
    return toDesktopSkillDraft(await retrySkillDraft(this.requireProject(projectId).path, draftId));
  }

  async editDraft(projectId: string, draftId: string, content: string): Promise<DesktopSkillDraft> {
    return toDesktopSkillDraft(await editSkillDraft(this.requireProject(projectId).path, draftId, content));
  }

  async importSource(sourceFile: string): Promise<DesktopManagedSkillSource> {
    return toDesktopManagedSkillSource(await importManagedSkillSource({ sourceFile }));
  }

  async installSource(sourceId: string): Promise<void> {
    await installManagedSkillSource({ sourceId });
  }

  async importExistingSkills(skillIds: string[]): Promise<DesktopSkillImportResult[]> {
    return await importUnmanagedSkills({ ids: skillIds, projectRoots: this.projectRoots() });
  }

  async skillDiscovery(): Promise<{ repositories: DesktopSkillRepository[]; skills: DesktopDiscoverableSkill[]; warnings: string[] }> {
    const repositories = await listSkillRepositories();
    const catalog = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const installedNames = new Set(catalog.skills.flatMap((skill) => [skill.name.toLocaleLowerCase(), path.basename(skill.absolutePath).toLocaleLowerCase()]));
    const discovered = await discoverSkillRepositories({ repositories: repositories.repositories, fetcher: this.fetcher, installedNames });
    return {
      repositories: repositories.repositories,
      skills: discovered.skills,
      warnings: [...repositories.warnings, ...discovered.warnings]
    };
  }

  async searchSkills(query: string, limit?: number, offset?: number): Promise<DesktopSkillsShSearchResult> {
    const catalog = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const installedNames = new Set(catalog.skills.flatMap((skill) => [skill.name.toLocaleLowerCase(), path.basename(skill.absolutePath).toLocaleLowerCase()]));
    return await searchSkillsSh({ query, limit, offset, fetcher: this.fetcher, installedNames });
  }

  async installDiscoveredSkill(skill: DesktopDiscoverableSkill): Promise<void> {
    const input: DiscoverableSkill = {
      key: skill.key,
      name: skill.name,
      description: skill.description,
      directory: skill.directory,
      readmeUrl: skill.readmeUrl,
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch: skill.repoBranch,
      installed: skill.installed
    };
    await installDiscoveredSkill({ skill: input, fetcher: this.fetcher });
  }

  async addSkillRepository(repository: DesktopSkillRepository): Promise<DesktopSkillRepository[]> {
    return await addSkillRepository(repository);
  }

  async removeSkillRepository(owner: string, name: string): Promise<DesktopSkillRepository[]> {
    return await removeSkillRepository(owner, name);
  }

  async readFile(skillId: string, relativePath: string): Promise<DesktopSkillFilePreview> {
    const entry = await this.requireSkill(skillId);
    const preview = await readSkillCatalogFile(entry, relativePath);
    return { path: preview.path, content: preview.content, bytes: preview.size, binary: preview.binary, truncated: preview.truncated };
  }

  async writeFile(skillId: string, relativePath: string, content: string): Promise<void> {
    const entry = await this.requireSkill(skillId);
    await writeSkillCatalogFile(entry, relativePath, content);
  }

  async directory(skillId: string): Promise<string> {
    return (await this.requireSkill(skillId)).absolutePath;
  }

  async pluginRegistry(projectId: string, refresh = false): Promise<DesktopPluginRegistrySnapshot> {
    const project = this.requireProject(projectId);
    if (!refresh) {
      const cache = await readPluginRegistryCache(project.path).catch(() => undefined);
      if (cache) return { registryUrl: BINY_PLUGIN_REGISTRY_URL, fetchedAt: cache.fetchedAt, stale: false, loadingError: undefined, plugins: cache.document.plugins };
    }
    try {
      const response = await this.fetcher(BINY_PLUGIN_REGISTRY_URL);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      if (response.url && new URL(response.url).origin !== new URL(BINY_PLUGIN_REGISTRY_URL).origin) throw new Error("Registry 重定向到非官方来源。");
      const document = parsePluginRegistry(await response.json());
      const fetchedAt = new Date().toISOString();
      await writePluginRegistryCache(project.path, { fetchedAt, document });
      return { registryUrl: BINY_PLUGIN_REGISTRY_URL, fetchedAt, stale: false, loadingError: undefined, plugins: document.plugins };
    } catch (error) {
      const cache = await readPluginRegistryCache(project.path).catch(() => undefined);
      return {
        registryUrl: BINY_PLUGIN_REGISTRY_URL,
        fetchedAt: cache?.fetchedAt,
        stale: cache !== undefined,
        loadingError: errorMessage(error),
        plugins: cache?.document.plugins ?? []
      };
    }
  }

  async installPlugin(projectId: string, pluginId: string): Promise<DesktopPluginSummary> {
    const project = this.requireProject(projectId);
    const registry = await this.pluginRegistry(projectId);
    const plugin = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`应用市场中不存在 Plugin：${pluginId}`);
    await installPluginFromRepository({ workspaceRoot: project.path, plugin, fetcher: this.fetcher });
    return await this.requireManagedPluginSummary(projectId, pluginId);
  }

  async setPluginEnabled(projectId: string, pluginId: string, enabled: boolean): Promise<DesktopPluginSummary> {
    const project = this.requireProject(projectId);
    await setProjectPluginEnabled(project.path, pluginId, enabled);
    return await this.requireManagedPluginSummary(projectId, pluginId);
  }

  async uninstallPlugin(projectId: string, pluginId: string): Promise<void> {
    await uninstallProjectPlugin(this.requireProject(projectId).path, pluginId);
  }

  async pluginDirectory(projectId: string): Promise<string> {
    return projectPluginRoot(this.requireProject(projectId).path);
  }

  private async requireSkill(skillId: string): Promise<SkillCatalogEntry> {
    if (!skillId.trim()) throw new Error("Skill id 不能为空。");
    const snapshot = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const entry = snapshot.skills.find((skill) => skill.id === skillId);
    if (!entry) throw new Error("Skill 不存在，可能已经被移动或删除。");
    return entry;
  }

  private projectRoots(): string[] {
    return this.state.projects().filter((project) => !project.missing).map((project) => project.path);
  }

  private projectsFor(projectId?: string) {
    if (projectId === undefined) return this.state.projects().filter((project) => !project.missing);
    return [this.requireProject(projectId)];
  }

  private requireProject(projectId: string) {
    const project = this.state.projects().find((candidate) => candidate.id === projectId);
    if (!project || project.missing) throw new Error("项目不存在或目录已不可用。");
    return project;
  }

  private async listPlugins(projectId?: string): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    const projects = this.projectsFor(projectId);
    const results = await Promise.all(projects.map(async (project) => await this.listProjectPlugins(project.id, project.name, project.path)));
    return {
      plugins: results.flatMap((result) => result.plugins),
      warnings: results.flatMap((result) => result.warnings)
    };
  }

  private async listProjectPlugins(projectId: string, projectName: string, projectRoot: string): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    let config;
    try {
      config = await this.configStore.load(projectRoot);
    } catch (error) {
      return { plugins: [], warnings: [`无法读取项目 ${projectName} 的插件配置：${errorMessage(error)}`] };
    }
    const results = await Promise.all(config.extensions.plugins.map(async (configuredPath) => {
      const target = path.resolve(projectRoot, configuredPath);
      const relative = path.relative(projectRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return {
          plugin: undefined,
          warning: `跳过越界插件路径：${configuredPath}`
        };
      }
      let moduleCount: number | undefined;
      let warning: string | undefined;
      try {
        moduleCount = await countPluginModules(target);
      } catch (error) {
        warning = `无法读取插件路径 ${configuredPath}：${errorMessage(error)}`;
      }
      const status: DesktopPluginSummary["status"] = moduleCount === undefined ? "missing" : "configured";
      return {
        plugin: {
          id: createHash("sha256").update(`${projectId}:${target}`).digest("hex").slice(0, 32),
          name: path.basename(target),
          path: relative.split(path.sep).join("/"),
          scope: "project" as const,
          projectId,
          projectName,
          status,
          moduleCount: moduleCount ?? 0
        },
        warning
      };
    }));
    const managed = await readProjectPluginManifest(projectRoot).catch((error: unknown) => ({
      format: 1 as const,
      plugins: [],
      warning: `无法读取项目 ${projectName} 的受管 Plugin 清单：${errorMessage(error)}`
    }));
    const managedResults = await Promise.all(managed.plugins.map(async (plugin) => await this.managedPluginSummary(projectId, projectName, projectRoot, plugin)));
    return {
      plugins: [
        ...results.flatMap((result) => result.plugin === undefined ? [] : [result.plugin]),
        ...managedResults
      ],
      warnings: [
        ...results.flatMap((result) => result.warning === undefined ? [] : [result.warning]),
        ...( "warning" in managed && managed.warning !== undefined ? [managed.warning] : [])
      ]
    };
  }

  private async managedPluginSummary(projectId: string, projectName: string, projectRoot: string, plugin: Awaited<ReturnType<typeof readProjectPluginManifest>>["plugins"][number]): Promise<DesktopPluginSummary> {
    const target = path.join(projectPluginRoot(projectRoot), plugin.directory);
    let moduleCount = 0;
    let status: DesktopPluginSummary["status"] = plugin.error ? "failed" : plugin.enabled ? "configured" : "disabled";
    let error: string | undefined = plugin.error;
    try {
      moduleCount = (await countPluginModules(target)) ?? 0;
      if (moduleCount === 0) status = "missing";
    } catch (caught) {
      status = "missing";
      error = errorMessage(caught);
    }
    return {
      id: createHash("sha256").update(`${projectId}:managed:${plugin.id}`).digest("hex").slice(0, 32),
      name: plugin.name,
      path: path.relative(projectRoot, target).split(path.sep).join("/"),
      scope: "project",
      projectId,
      projectName,
      status,
      moduleCount,
      version: plugin.version,
      category: plugin.category,
      description: plugin.description,
      enabled: plugin.enabled,
      managed: true,
      error
    };
  }

  private async requireManagedPluginSummary(projectId: string, pluginId: string): Promise<DesktopPluginSummary> {
    const project = this.requireProject(projectId);
    const result = await this.listProjectPlugins(project.id, project.name, project.path);
    const entry = result.plugins.find((plugin) => plugin.managed && plugin.path.endsWith(`/${pluginId}`));
    if (!entry) {
      const manifest = await readProjectPluginManifest(project.path);
      const plugin = manifest.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin) throw new Error(`Plugin 不存在：${pluginId}`);
      return await this.managedPluginSummary(project.id, project.name, project.path, plugin);
    }
    return entry;
  }
}

function toDesktopManagedSkillSource(source: {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}): DesktopManagedSkillSource {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    installed: source.installed
  };
}

async function countPluginModules(target: string): Promise<number | undefined> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (stat.isFile()) return isPluginModule(target) ? 1 : 0;
  if (!stat.isDirectory()) return 0;
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    if (count >= maxPluginEntries) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (count >= maxPluginEntries || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && isPluginModule(child)) count += 1;
    }
  };
  await visit(target);
  return count;
}

function isPluginModule(filePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(filePath).toLowerCase());
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDesktopSkillDraft(draft: SkillDraft): DesktopSkillDraft {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    content: draft.content,
    status: draft.status,
    toolCalls: draft.toolCalls,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    error: draft.error,
    installedPath: draft.installedPath
  };
}
