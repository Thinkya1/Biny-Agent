/**
 * SkillHub 与 Agent runtime 共用的 Skill 根目录约定。
 *
 * `engines` 只描述目录归属；真正的文件安全校验仍由各自的读取模块负责。
 */
import path from "node:path";

export type SkillRootEngine = "biny" | "codex" | "claude" | "pi";
export type SkillRootSource = "biny" | "agents";

export interface SkillRootConvention {
  relativePath: string;
  engines: readonly SkillRootEngine[];
  source: SkillRootSource;
  /** 全局 `.agents/skills` 是用户显式管理的入口，可保留指向其他 Skill 根的软链。 */
  allowExternalSymlinks?: boolean;
}

export const PROJECT_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  { relativePath: ".biny/skills", engines: ["biny"], source: "biny" },
  { relativePath: ".agents/skills", engines: ["codex", "pi"], source: "agents", allowExternalSymlinks: true }
];

export const GLOBAL_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  ...PROJECT_SKILL_ROOT_CONVENTIONS,
  { relativePath: ".claude/skills", engines: ["claude"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".codex/skills", engines: ["codex"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".pi/agent/skills", engines: ["pi"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".cc-switch/skills", engines: ["claude", "codex", "pi"], source: "agents", allowExternalSymlinks: true }
];

export const DEFAULT_PROJECT_SKILL_PATHS = PROJECT_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => relativePath);

export function defaultGlobalSkillRoots(homeDir: string): string[] {
  return GLOBAL_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => (
    path.isAbsolute(relativePath) ? relativePath : path.join(homeDir, relativePath)
  ));
}
