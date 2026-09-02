/** 设置草稿 Provider 与各分页共享的纯上下文契约。 */
import { createContext, useContext } from "react";
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { ModelProfile } from "../../../../../config/schema.js";
import type {
  DesktopChatParamsSettings,
  DesktopChatPersonalizationOverride,
  DesktopCompactionSettings,
  DesktopActivitySettingsInput,
  DesktopActivitySettingsPatch,
  DesktopFontPreference,
  DesktopIdentitySettings,
  DesktopMemorySettings,
  DesktopModelConfigurationInput,
  DesktopPermissionSettings,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopSettingsCredentialScope,
  DesktopSkillSettingsInput,
  DesktopStagedSettingsCredential,
  DesktopThemePreference,
  DesktopWebSearchSettingsInput
} from "../../../../protocol.js";

export type SettingsSaveState = "clean" | "dirty" | "invalid" | "saving" | "rolling_back" | "recovery_required";

export interface SettingsModelDraft {
  upserts: DesktopModelConfigurationInput[];
  removeAliases: string[];
  defaultModel?: { alias: string; thinking: ThinkingSelection };
  oauthCredentialHandles: string[];
  modelProfiles: Record<string, Record<string, ModelProfile>>;
}

export interface DesktopSettingsDraft {
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  activity: DesktopActivitySettingsInput;
  identity: DesktopIdentitySettings;
  memory: DesktopMemorySettings;
  compaction: DesktopCompactionSettings;
  chatParams: DesktopChatParamsSettings;
  permission: DesktopPermissionSettings;
  webSearch: DesktopWebSearchSettingsInput;
  chat?: DesktopChatPersonalizationOverride;
  models: SettingsModelDraft;
  skills: DesktopSkillSettingsInput;
}

export interface SettingsDraftContextValue {
  snapshot?: DesktopSettingsSnapshot;
  draft?: DesktopSettingsDraft;
  loadError?: string;
  dirtyCount: number;
  preferencesOnly: boolean;
  invalid: boolean;
  saveState: SettingsSaveState;
  setThemePreference(value: DesktopThemePreference): void;
  setFontPreference(value: DesktopFontPreference): void;
  updateActivityImmediately(patch: DesktopActivitySettingsPatch): Promise<void>;
  setIdentity(value: DesktopIdentitySettings): void;
  setMemory(value: DesktopMemorySettings): void;
  setCompaction(value: DesktopCompactionSettings): void;
  setChatParams(value: DesktopChatParamsSettings): void;
  setPermission(value: DesktopPermissionSettings): void;
  setWebSearch(value: DesktopWebSearchSettingsInput): void;
  setChat(value: DesktopChatPersonalizationOverride): void;
  setSkills(value: DesktopSkillSettingsInput): void;
  upsertModel(value: DesktopModelConfigurationInput): void;
  removeModel(alias: string): void;
  setDefaultModel(alias: string, thinking: ThinkingSelection): void;
  setModelProfile(providerAlias: string, modelId: string, profile: ModelProfile | undefined): void;
  stageCredential(secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential>;
  addOauthCredentialHandle(handle: string): void;
  releaseCredential(handle: string): Promise<void>;
  discard(): Promise<void>;
  saveAll(): Promise<DesktopSettingsSaveResult | undefined>;
  /** 即时动作（如设为默认）落盘后，用权威快照推进基线但保留其它未保存草稿。 */
  adoptExternalSnapshot(snapshot: DesktopSettingsSnapshot): void;
}

export const SettingsDraftContext = createContext<SettingsDraftContextValue | undefined>(undefined);

export function useSettingsDraft(): SettingsDraftContextValue {
  const value = useContext(SettingsDraftContext);
  if (!value) throw new Error("useSettingsDraft must be used inside SettingsDraftProvider.");
  return value;
}
