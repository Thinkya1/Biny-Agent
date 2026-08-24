/** Skill 开关的纯解析逻辑，供配置、catalog 和 runtime 共用。 */
import type { SkillRef } from "./skillTypes.js";

export type SkillActivationSource = "default" | "global" | "project";

export interface SkillActivationInput {
  ref: SkillRef;
  globalDefaults?: Readonly<Record<string, boolean>>;
  projectOverrides?: Readonly<Record<string, boolean>>;
}

export interface SkillActivationState {
  enabled: boolean;
  globalEnabled: boolean;
  projectOverride: boolean | undefined;
  source: SkillActivationSource;
}

export function resolveSkillActivation(input: SkillActivationInput): SkillActivationState {
  const globalValue = input.globalDefaults?.[input.ref];
  const projectValue = input.projectOverrides?.[input.ref];
  return {
    enabled: projectValue ?? globalValue ?? true,
    globalEnabled: globalValue ?? true,
    projectOverride: projectValue,
    source: projectValue !== undefined ? "project" : globalValue !== undefined ? "global" : "default"
  };
}

export function setSkillActivation(
  values: Readonly<Record<string, boolean>>,
  ref: SkillRef,
  enabled: boolean | undefined
): Record<string, boolean> {
  const next = { ...values };
  if (enabled === undefined) delete next[ref];
  else next[ref] = enabled;
  return next;
}

export function effectiveSkillRefs(
  refs: readonly SkillRef[],
  globalDefaults?: Readonly<Record<string, boolean>>,
  projectOverrides?: Readonly<Record<string, boolean>>
): SkillRef[] {
  return refs.filter((ref) => resolveSkillActivation({ ref, globalDefaults, projectOverrides }).enabled);
}
