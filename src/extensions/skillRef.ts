/**
 * Skill 的稳定身份。
 *
 * 展示层可以重新扫描目录、合并不同 Agent 的入口并改变显示路径，但运行时开关和
 * 设置草稿不能依赖当次扫描生成的数组下标或绝对路径。这里集中生成 ref/id，catalog
 * 和 runtime 必须使用同一套规则。
 */
import { createHash } from "node:crypto";

export type SkillRefScope = "global" | "project";

export interface SkillRefInput {
  scope: SkillRefScope;
  name: string;
  projectRoot?: string;
  source?: string;
}

export function createSkillRef(input: SkillRefInput): string {
  const normalizedName = normalizeSkillName(input.name);
  const source = input.source === undefined ? "" : `${input.source}:`;
  if (input.scope === "global") return `global:${source}${normalizedName}`;
  const projectKey = createHash("sha256").update(input.projectRoot ?? "").digest("hex").slice(0, 16);
  return `project-${projectKey}:${source}${normalizedName}`;
}

export function createSkillId(ref: string): string {
  return createHash("sha256").update(ref).digest("hex").slice(0, 32);
}

/** 配置里按项目保存 Skill 覆盖时使用的稳定键，不暴露绝对路径。 */
export function createProjectSkillKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
