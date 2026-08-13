/** 设置草稿 Provider 与各分页共享的纯上下文契约。 */
import { createContext, useContext } from "react";
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type {
  DesktopChatPersonalizationOverride,
  DesktopFontPreference,
  DesktopMemorySettings,
  DesktopModelConfigurationInput,
  DesktopPersonalizationSettings,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopStagedSettingsCredential,
  DesktopThemePreference,
  DesktopWebSearchSettingsInput
} from "../../../../protocol.js";
import type { SettingsSaveState } from "./SettingsPageFooter.js";

export interface SettingsModelDraft {
  upserts: DesktopModelConfigurationInput[];
  removeAliases: string[];
  defaultModel?: { alias: string; thinking: ThinkingSelection };
  oauthCredentialHandles: string[];
}

export interface DesktopSettingsDraft {
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  personalization: DesktopPersonalizationSettings;
  memory: DesktopMemorySettings;
  webSearch: DesktopWebSearchSettingsInput;
  chat?: DesktopChatPersonalizationOverride;
  models: SettingsModelDraft;
}

export interface SettingsDraftContextValue {
  snapshot?: DesktopSettingsSnapshot;
  draft?: DesktopSettingsDraft;
  loadError?: string;
  dirtyCount: number;
  invalid: boolean;
  saveState: SettingsSaveState;
  setThemePreference(value: DesktopThemePreference): void;
  setFontPreference(value: DesktopFontPreference): void;
  setPersonalization(value: DesktopPersonalizationSettings): void;
  setMemory(value: DesktopMemorySettings): void;
  setWebSearch(value: DesktopWebSearchSettingsInput): void;
  setChat(value: DesktopChatPersonalizationOverride): void;
  upsertModel(value: DesktopModelConfigurationInput): void;
  removeModel(alias: string): void;
  setDefaultModel(alias: string, thinking: ThinkingSelection): void;
  stageCredential(secret: string): Promise<DesktopStagedSettingsCredential>;
  addOauthCredentialHandle(handle: string): void;
  releaseCredential(handle: string): Promise<void>;
  discard(): Promise<void>;
  saveAll(): Promise<DesktopSettingsSaveResult | undefined>;
}

export const SettingsDraftContext = createContext<SettingsDraftContextValue | undefined>(undefined);

export function useSettingsDraft(): SettingsDraftContextValue {
  const value = useContext(SettingsDraftContext);
  if (!value) throw new Error("useSettingsDraft must be used inside SettingsDraftProvider.");
  return value;
}
