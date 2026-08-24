/**
 * 设置中心的跨分页草稿。
 *
 * 打开时只读取一次脱敏快照；各分页只改这里的内存状态。主题和字体通过 preview 回调即时
 * 预览，但只有 saveAll 会进入主进程事务。即时动作不经过本 Provider。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type {
  DesktopActivitySettingsInput,
  DesktopChatPersonalizationOverride,
  DesktopFontPreference,
  DesktopMemorySettings,
  DesktopModelConfigurationInput,
  DesktopPersonalizationSettings,
  DesktopSettingsSaveInput,
  DesktopSettingsSaveResult,
  DesktopSettingsSnapshot,
  DesktopSettingsCredentialScope,
  DesktopStagedSettingsCredential,
  DesktopThemePreference,
  DesktopWebSearchSettings,
  DesktopWebSearchSettingsInput
} from "../../../../protocol.js";
import { SettingsDraftContext, type DesktopSettingsDraft, type SettingsDraftContextValue, type SettingsSaveState } from "./SettingsDraftContext.js";

export function SettingsDraftProvider({
  active,
  children,
  onCommitted,
  onFontPreview,
  onNotify,
  onThemePreview,
  projectId,
  sessionId,
  sessionRunning
}: {
  active: boolean;
  children: React.ReactNode;
  onCommitted(snapshot: DesktopSettingsSnapshot): void;
  onFontPreview(value: DesktopFontPreference): void;
  onNotify(message: string): void;
  onThemePreview(value: DesktopThemePreference): void;
  projectId?: string;
  sessionId?: string;
  sessionRunning: boolean;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot>();
  const [draft, setDraft] = useState<DesktopSettingsDraft>();
  const [loadError, setLoadError] = useState<string>();
  const [saveState, setSaveState] = useState<SettingsSaveState>("clean");
  const credentialHandlesRef = useRef(new Set<string>());

  const adoptSnapshot = useCallback((next: DesktopSettingsSnapshot): void => {
    setSnapshot(next);
    setDraft(draftFromSnapshot(next));
    setSaveState(next.pendingRecovery ? "recovery_required" : "clean");
    onThemePreview(next.themePreference);
    onFontPreview(next.fontPreference);
  }, [onFontPreview, onThemePreview]);

  useEffect(() => {
    if (!active || !projectId) return;
    let cancelled = false;
    setSnapshot(undefined);
    setDraft(undefined);
    setLoadError(undefined);
    setSaveState("clean");
    window.biny.settingsSnapshot(projectId, sessionId)
      .then((next) => { if (!cancelled) adoptSnapshot(next); })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [active, adoptSnapshot, projectId, sessionId]);

  const setThemePreference = useCallback((value: DesktopThemePreference): void => {
    setDraft((current) => current ? { ...current, themePreference: value } : current);
    onThemePreview(value);
  }, [onThemePreview]);

  const setFontPreference = useCallback((value: DesktopFontPreference): void => {
    setDraft((current) => current ? { ...current, fontPreference: value } : current);
    onFontPreview(value);
  }, [onFontPreview]);

  const setPersonalization = useCallback((value: DesktopPersonalizationSettings): void => {
    setDraft((current) => current ? { ...current, personalization: value } : current);
  }, []);

  const setActivity = useCallback((value: DesktopActivitySettingsInput): void => {
    setDraft((current) => current ? { ...current, activity: value } : current);
  }, []);

  const setMemory = useCallback((value: DesktopMemorySettings): void => {
    setDraft((current) => current ? { ...current, memory: value } : current);
  }, []);

  const setWebSearch = useCallback((value: DesktopWebSearchSettingsInput): void => {
    setDraft((current) => current ? { ...current, webSearch: value } : current);
  }, []);

  const setChat = useCallback((value: DesktopChatPersonalizationOverride): void => {
    setDraft((current) => current ? { ...current, chat: value } : current);
  }, []);

  const upsertModel = useCallback((value: DesktopModelConfigurationInput): void => {
    setDraft((current) => {
      if (!current) return current;
      const upserts = [...current.models.upserts.filter((item) => item.alias !== value.alias), value];
      const defaultModel = value.makeDefault
        ? { alias: value.alias, thinking: "off" as const }
        : current.models.defaultModel;
      return {
        ...current,
        models: {
          ...current.models,
          upserts,
          removeAliases: current.models.removeAliases.filter((alias) => alias !== value.alias),
          defaultModel
        }
      };
    });
  }, []);

  const removeModel = useCallback((alias: string): void => {
    setDraft((current) => {
      if (!current) return current;
      const hadPendingUpsert = current.models.upserts.some((item) => item.alias === alias);
      return {
        ...current,
        models: {
          ...current.models,
          upserts: current.models.upserts.filter((item) => item.alias !== alias),
          removeAliases: hadPendingUpsert || current.models.removeAliases.includes(alias)
            ? current.models.removeAliases
            : [...current.models.removeAliases, alias],
          defaultModel: current.models.defaultModel?.alias === alias ? undefined : current.models.defaultModel
        }
      };
    });
  }, []);

  const setDefaultModel = useCallback((alias: string, thinking: ThinkingSelection): void => {
    setDraft((current) => current ? {
      ...current,
      models: { ...current.models, defaultModel: { alias, thinking } }
    } : current);
  }, []);

  const stageCredential = useCallback(async (secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential> => {
    const staged = await window.biny.stageSettingsCredential(secret, scope);
    credentialHandlesRef.current.add(staged.handle);
    return staged;
  }, []);

  const addOauthCredentialHandle = useCallback((handle: string): void => {
    credentialHandlesRef.current.add(handle);
    setDraft((current) => !current || current.models.oauthCredentialHandles.includes(handle) ? current : {
      ...current,
      models: {
        ...current.models,
        oauthCredentialHandles: [...current.models.oauthCredentialHandles, handle]
      }
    });
  }, []);

  const releaseCredential = useCallback(async (handle: string): Promise<void> => {
    credentialHandlesRef.current.delete(handle);
    setDraft((current) => current ? {
      ...current,
      models: {
        ...current.models,
        oauthCredentialHandles: current.models.oauthCredentialHandles.filter((candidate) => candidate !== handle)
      }
    } : current);
    await window.biny.releaseSettingsCredentials([handle]);
  }, []);

  const dirtyCount = snapshot && draft ? countDirtyFields(snapshot, draft) : 0;
  const invalid = draft ? !validDraft(draft) : false;
  const runtimeBusy = sessionRunning || snapshot?.hasRunningTasks === true;
  const canSave = active
    && dirtyCount > 0
    && draft !== undefined
    && !runtimeBusy
    && !invalid
    && saveState !== "saving"
    && saveState !== "rolling_back"
    && saveState !== "recovery_required";

  useLayoutEffect(() => {
    void window.biny.updateSettingsDraftState({
      dirty: dirtyCount > 0,
      canSave,
      open: active
    }).catch(() => undefined);
  }, [active, canSave, dirtyCount]);

  useEffect(() => {
    if (saveState === "saving" || saveState === "rolling_back" || saveState === "recovery_required") return;
    setSaveState(invalid ? "invalid" : dirtyCount > 0 ? "dirty" : "clean");
  }, [dirtyCount, invalid, saveState]);

  const releaseAllCredentials = useCallback(async (): Promise<void> => {
    const handles = [...credentialHandlesRef.current];
    credentialHandlesRef.current.clear();
    if (handles.length) await window.biny.releaseSettingsCredentials(handles);
  }, []);

  useEffect(() => () => {
    // 窗口被系统关闭或渲染进程卸载时也释放尚未提交的安全句柄；已提交句柄会先从集合清除。
    void releaseAllCredentials();
    // Provider 已卸载后草稿已不存在；同步清除主进程的关闭握手投影，避免留下幽灵 dirty 状态。
    void window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: false }).catch(() => undefined);
  }, [releaseAllCredentials]);

  const discard = useCallback(async (): Promise<void> => {
    await releaseAllCredentials();
    if (snapshot) adoptSnapshot(snapshot);
    await window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: active }).catch(() => undefined);
  }, [active, adoptSnapshot, releaseAllCredentials, snapshot]);

  const saveAll = useCallback(async (): Promise<DesktopSettingsSaveResult | undefined> => {
    if (!snapshot || !draft || runtimeBusy || invalid || dirtyCount === 0 || saveState === "recovery_required") return undefined;
    setSaveState("saving");
    try {
      const result = await window.biny.saveSettings(snapshot.projectId, saveInput(snapshot, draft));
      if (result.status === "committed") {
        credentialHandlesRef.current.clear();
        adoptSnapshot(result.snapshot);
        await window.biny.updateSettingsDraftState({ dirty: false, canSave: false, open: active }).catch(() => undefined);
        onCommitted(result.snapshot);
      } else if (result.status === "rolled_back") {
        // 后端已验证补偿完成；只更新 CAS 基线，用户的草稿值继续保留以便处理冲突后重试。
        setSnapshot(result.snapshot);
        // 主题和字体是未落盘的即时预览。补偿完成后 UI 必须先恢复权威值，
        // 但不能丢掉草稿本身，用户仍可修正冲突后再次保存。
        onThemePreview(result.snapshot.themePreference);
        onFontPreview(result.snapshot.fontPreference);
        setSaveState("dirty");
        onNotify(result.message ?? (result.conflicts?.length ? "设置已在其他位置更改，请检查冲突后重试" : "保存失败，已恢复原设置"));
      } else {
        setSaveState("recovery_required");
        onNotify(result.message);
      }
      return result;
    } catch (error) {
      setSaveState("dirty");
      onNotify(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }, [active, adoptSnapshot, dirtyCount, draft, invalid, onCommitted, onFontPreview, onNotify, onThemePreview, runtimeBusy, saveState, snapshot]);

  const value = useMemo<SettingsDraftContextValue>(() => ({
    snapshot,
    draft,
    loadError,
    dirtyCount,
    invalid,
    saveState,
    setThemePreference,
    setFontPreference,
    setPersonalization,
    setActivity,
    setMemory,
    setWebSearch,
    setChat,
    upsertModel,
    removeModel,
    setDefaultModel,
    stageCredential,
    addOauthCredentialHandle,
    releaseCredential,
    discard,
    saveAll
  }), [
    addOauthCredentialHandle,
    dirtyCount,
    discard,
    draft,
    invalid,
    loadError,
    releaseCredential,
    removeModel,
    saveAll,
    saveState,
    setChat,
    setDefaultModel,
    setFontPreference,
    setMemory,
    setPersonalization,
    setActivity,
    setThemePreference,
    setWebSearch,
    snapshot,
    stageCredential,
    upsertModel
  ]);

  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>;
}

function draftFromSnapshot(snapshot: DesktopSettingsSnapshot): DesktopSettingsDraft {
  return {
    themePreference: snapshot.themePreference,
    fontPreference: { ...snapshot.fontPreference },
    personalization: { ...snapshot.personalization },
    activity: activityInputFromSnapshot(snapshot.activity),
    memory: structuredClone(snapshot.memory),
    webSearch: webSearchInput(snapshot.webSearch),
    chat: snapshot.chat ? structuredClone(snapshot.chat.personalization) : undefined,
    models: { upserts: [], removeAliases: [], defaultModel: undefined, oauthCredentialHandles: [] }
  };
}

function webSearchInput(value: DesktopWebSearchSettings): DesktopWebSearchSettingsInput {
  return {
    enabled: value.enabled,
    provider: value.provider,
    apiKey: undefined,
    apiKeyHandle: undefined,
    apiKeyEnv: value.apiKeyEnv,
    timeoutMs: value.timeoutMs,
    maxResults: value.maxResults
  };
}

function countDirtyFields(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): number {
  let count = 0;
  if (draft.themePreference !== snapshot.themePreference) count += 1;
  if (!sameJson(draft.fontPreference, snapshot.fontPreference)) count += 1;
  if (!sameJson(draft.personalization, snapshot.personalization)) count += 1;
  if (!sameJson(draft.activity, activityInputFromSnapshot(snapshot.activity))) count += 1;
  if (!sameJson(draft.memory, snapshot.memory)) count += 1;
  if (!sameWebSearch(draft.webSearch, snapshot.webSearch)) count += 1;
  if (draft.models.upserts.length || draft.models.removeAliases.length || draft.models.defaultModel || draft.models.oauthCredentialHandles.length) count += 1;
  if (snapshot.chat && draft.chat && !sameJson(draft.chat, snapshot.chat.personalization)) count += 1;
  return count;
}

function validDraft(draft: DesktopSettingsDraft): boolean {
  if (new TextEncoder().encode(draft.personalization.customInstructions).byteLength > 4_096) return false;
  const activity = draft.activity;
  if (activity.captureDebounceMs < 250 || activity.heartbeatMs < 1_000 || activity.idleTimeoutMs < 1_000
    || activity.inputPauseMs < 0 || activity.visualPollMs < 0 || activity.jpegQuality < 1 || activity.jpegQuality > 100
    || activity.ocrEveryNFrames < 1 || activity.ocrLanguages.length === 0 || activity.maxStorageMb < 256
    || activity.outputDirectory.trim() === "") return false;
  const thresholds = (draft.memory as DesktopMemorySettings & {
    similarityThresholds?: Record<string, { currentWorkspace: number; crossWorkspace: number }>;
  }).similarityThresholds;
  return !thresholds || Object.values(thresholds).every((value) => (
    value.currentWorkspace >= 0
    && value.currentWorkspace <= 1
    && value.crossWorkspace >= value.currentWorkspace
    && value.crossWorkspace <= 1
  ));
}

function saveInput(snapshot: DesktopSettingsSnapshot, draft: DesktopSettingsDraft): DesktopSettingsSaveInput {
  const modelsDirty = draft.models.upserts.length > 0
    || draft.models.removeAliases.length > 0
    || draft.models.defaultModel !== undefined
    || draft.models.oauthCredentialHandles.length > 0;
  return {
    expectedPreferenceRevision: snapshot.preferenceRevision,
    expectedConfigRevision: snapshot.configRevision,
    themePreference: draft.themePreference === snapshot.themePreference ? undefined : draft.themePreference,
    fontPreference: sameJson(draft.fontPreference, snapshot.fontPreference) ? undefined : draft.fontPreference,
    personalization: sameJson(draft.personalization, snapshot.personalization) ? undefined : draft.personalization,
    activity: sameJson(draft.activity, activityInputFromSnapshot(snapshot.activity)) ? undefined : draft.activity,
    memory: sameJson(draft.memory, snapshot.memory) ? undefined : draft.memory,
    webSearch: sameWebSearch(draft.webSearch, snapshot.webSearch) ? undefined : draft.webSearch,
    models: modelsDirty ? {
      upserts: draft.models.upserts,
      removeAliases: draft.models.removeAliases,
      defaultModel: draft.models.defaultModel,
      oauthCredentialHandles: draft.models.oauthCredentialHandles
    } : undefined,
    chat: snapshot.chat && draft.chat && !sameJson(draft.chat, snapshot.chat.personalization) ? {
      sessionId: snapshot.chat.sessionId,
      expectedMetadataRevision: snapshot.chat.metadataRevision,
      personalization: draft.chat
    } : undefined
  };
}

function activityInputFromSnapshot(value: DesktopSettingsSnapshot["activity"]): DesktopActivitySettingsInput {
  const { externalPolicy: _externalPolicy, ...input } = value;
  return structuredClone(input);
}


function sameWebSearch(draft: DesktopWebSearchSettingsInput, snapshot: DesktopWebSearchSettings): boolean {
  return draft.enabled === snapshot.enabled
    && draft.provider === snapshot.provider
    && draft.apiKey === undefined
    && draft.apiKeyHandle === undefined
    && draft.apiKeyEnv === snapshot.apiKeyEnv
    && draft.timeoutMs === snapshot.timeoutMs
    && draft.maxResults === snapshot.maxResults;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
