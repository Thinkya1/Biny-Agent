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
}

export const PROJECT_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  { relativePath: ".biny/skills", engines: ["biny"], source: "biny" },
  { relativePath: ".agents/skills", engines: ["codex", "pi"], source: "agents" }
];

export const GLOBAL_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  ...PROJECT_SKILL_ROOT_CONVENTIONS
];

export const DEFAULT_PROJECT_SKILL_PATHS = PROJECT_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => relativePath);

export function defaultGlobalSkillRoots(homeDir: string): string[] {
  return GLOBAL_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => (
    path.isAbsolute(relativePath) ? relativePath : path.join(homeDir, relativePath)
  ));
}
