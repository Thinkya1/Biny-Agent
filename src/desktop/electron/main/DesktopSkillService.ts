/**
 * 桌面端扩展目录服务。
 *
 * Renderer 只拿 catalog 和文件内容，不直接接触绝对路径；每次读写前重新扫描并按 id
 * 解析真实目录，避免把页面初始快照当成长期授权。插件这里只展示 Biny 配置中已声明的
 * 工作区模块，不会为了展示而 import 或执行插件代码。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfigStore } from "../../../config/store.js";
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
import type {
  DesktopManagedSkillSource,
  DesktopPluginSummary,
  DesktopSkillCatalogSnapshot,
  DesktopSkillFilePreview
} from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

const maxPluginEntries = 64;

export class DesktopSkillService {
  constructor(
    private readonly state: DesktopStateStore,
    private readonly configStore: AgentConfigStore
  ) {}

  async snapshot(): Promise<DesktopSkillCatalogSnapshot> {
    const projectRoots = this.state.projects().filter((project) => !project.missing).map((project) => project.path);
    const [skills, plugins, managedSources] = await Promise.all([
      scanSkillCatalog({ projectRoots }),
      this.listPlugins(),
      listManagedSkillSources()
    ]);
    return {
      skills: skills.skills,
      inventory: skills.inventory,
      plugins: plugins.plugins,
      managedSources: managedSources.sources.map(toDesktopManagedSkillSource),
      warnings: [...skills.warnings, ...managedSources.warnings, ...plugins.warnings],
      diagnostics: skills.diagnostics
    };
  }

  async importSource(sourceFile: string): Promise<DesktopManagedSkillSource> {
    return toDesktopManagedSkillSource(await importManagedSkillSource({ sourceFile }));
  }

  async installSource(sourceId: string): Promise<void> {
    await installManagedSkillSource({ sourceId });
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

  private async requireSkill(skillId: string): Promise<SkillCatalogEntry> {
    if (!skillId.trim()) throw new Error("Skill id 不能为空。");
    const projectRoots = this.state.projects().filter((project) => !project.missing).map((project) => project.path);
    const snapshot = await scanSkillCatalog({ projectRoots });
    const entry = snapshot.skills.find((skill) => skill.id === skillId);
    if (!entry) throw new Error("Skill 不存在，可能已经被移动或删除。");
    return entry;
  }

  private async listPlugins(): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    const projects = this.state.projects().filter((project) => !project.missing);
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
    return {
      plugins: results.flatMap((result) => result.plugin === undefined ? [] : [result.plugin]),
      warnings: results.flatMap((result) => result.warning === undefined ? [] : [result.warning])
    };
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
