/**
 * Desktop 设置中心。
 *
 * 每个设置分页持有自己的表单状态，保存动作通过 props 上抛；本模块不直接调用 preload API。
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { createPortal } from "react-dom";
import type { ModelChoice, ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { DesktopChatPersonalizationOverride, DesktopCookieJarStatus, DesktopFontPreference, DesktopMemoryCompactionResult, DesktopMemoryEntryInput, DesktopMemoryKind, DesktopMemoryOverview, DesktopMemoryScope, DesktopMemorySearchMatch, DesktopMemorySettingsInput, DesktopMemorySettingsSnapshot, DesktopModelCatalogResult, DesktopModelConfigurationInput, DesktopModelConnection, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopPersonalizationOverview, DesktopPersonalizationSettingsInput, DesktopThemePreference, DesktopWebSearchProvider, DesktopWebSearchSettings, DesktopWebSearchSettingsInput, DesktopWorkspaceSnapshot } from "../../../../protocol.js";
import {
  catalogForConnection,
  customCatalogEntry,
  modelAliasFor,
  providerAliasFor,
  providerCatalog,
  providerCatalogOrder,
  type CatalogModel,
  type ProviderCatalogItem,
  type ProviderCategory
} from "../../providerCatalog.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { SettingsAbout } from "./SettingsAbout.js";
import { SettingsAppearance } from "./SettingsAppearance.js";
import { SettingsPersonalization } from "./SettingsPersonalization.js";

interface SettingsOverlayProps {
  open: boolean;
  version: string;
  workspace?: DesktopWorkspaceSnapshot;
  modelSetupRequired: boolean;
  targetTab?: SettingsTab;
  themePreference: DesktopThemePreference;
  onThemePreference(theme: DesktopThemePreference): void;
  fontPreference: DesktopFontPreference;
  onFontPreference(font: DesktopFontPreference): void;
  onClose(): void;
  onSkipModelSetup(): void;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<void>;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onRemoveModelConfiguration(alias: string): Promise<void>;
  onFetchModelCatalog(providerAlias: string): Promise<DesktopModelCatalogResult>;
  sessionId?: string;
  sessionRunning: boolean;
  onLoadPersonalizationOverview(sessionId?: string): Promise<DesktopPersonalizationOverview>;
  onSavePersonalizationSettings(input: DesktopPersonalizationSettingsInput, sessionId?: string): Promise<DesktopPersonalizationOverview>;
  onSaveChatPersonalization(sessionId: string, input: DesktopChatPersonalizationOverride, expectedRevision: string): Promise<DesktopPersonalizationOverview>;
  onLoadMemoryOverview(scope: DesktopMemoryScope): Promise<DesktopMemoryOverview>;
  onSaveMemorySettings(input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot>;
  onSearchMemory(scope: DesktopMemoryScope, query: string): Promise<DesktopMemorySearchMatch[]>;
  onAddMemoryEntry(scope: DesktopMemoryScope, input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onDeleteMemoryEntry(scope: DesktopMemoryScope, entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onClearMemory(scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onCompactMemory(scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryCompactionResult>;
  onOpenExternal(url: string): Promise<void>;
  onLoadWebSearchSettings(): Promise<DesktopWebSearchSettings>;
  onSaveWebSearchSettings(input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  onStartModelLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteModelLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<void>;
  onCancelModelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}

export type SettingsTab = "外观" | "个性化" | "模型" | "记忆" | "联网搜索" | "关于";

const settingsNav: Array<{ badge?: string; tab: SettingsTab; label: string }> = [
  { tab: "外观", label: "外观" },
  { tab: "个性化", label: "个性化" },
  { tab: "模型", label: "模型供应商" },
  { tab: "记忆", label: "记忆" },
  { badge: "Beta", tab: "联网搜索", label: "联网搜索" },
  { tab: "关于", label: "关于" }
];

const settingsTitles: Record<SettingsTab, string> = {
  外观: "外观",
  个性化: "个性化",
  模型: "模型供应商",
  记忆: "记忆",
  联网搜索: "联网搜索",
  关于: "关于"
};

const settingsSubtitles: Record<SettingsTab, string> = {
  模型: "模型连接、API key 与默认模型管理。",
  外观: "显示模式、界面字体和字号。",
  个性化: "设置 Biny 的表达方式、长期偏好与当前聊天覆盖。",
  记忆: "记忆检索、自动总结、整理与条目管理。",
  联网搜索: "配置联网搜索与数据来源。",
  关于: "版本与产品信息。"
};

export function SettingsOverlay({
  open,
  version,
  workspace,
  modelSetupRequired,
  targetTab,
  themePreference,
  onThemePreference,
  fontPreference,
  onFontPreference,
  onClose,
  onSkipModelSetup,
  onSwitchModel,
  onSaveModelConfiguration,
  onTestModelConfiguration,
  onRemoveModelConfiguration,
  onFetchModelCatalog,
  sessionId,
  sessionRunning,
  onLoadPersonalizationOverview,
  onSavePersonalizationSettings,
  onSaveChatPersonalization,
  onLoadMemoryOverview,
  onSaveMemorySettings,
  onSearchMemory,
  onAddMemoryEntry,
  onDeleteMemoryEntry,
  onClearMemory,
  onCompactMemory,
  onOpenExternal,
  onLoadWebSearchSettings,
  onSaveWebSearchSettings,
  onLoadCookieJarStatus,
  onOpenBrowser,
  onExportCookies,
  onImportCookies,
  onClearCookies,
  onStartModelLogin,
  onCompleteModelLogin,
  onCancelModelLogin
}: SettingsOverlayProps): React.JSX.Element | null {
  const [tab, setTab] = useState<SettingsTab>("外观");
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(undefined), 1_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  // 由 Composer 直达模型设置时，在浏览器绘制前同步分页，避免先闪过上次打开的内容。
  useLayoutEffect(() => {
    if (!open) return;
    if (modelSetupRequired) setTab("模型");
    else if (targetTab) setTab(targetTab);
  }, [modelSetupRequired, open, targetTab]);
  const runtime = workspace?.runtime;
  const execute = async (operation: () => Promise<void>, success: string): Promise<void> => {
    setMessage(undefined);
    try {
      await operation();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const dismiss = modelSetupRequired ? () => undefined : onClose;
  return (
    <Dialog
      aria-label="Biny 设置"
      className="desktop-settings-dialog"
      isOpen={open}
      onOpenChange={(isOpen) => { if (!isOpen) dismiss(); }}
      padding={0}
      purpose={modelSetupRequired ? "required" : "info"}
      variant="fullscreen"
    >
      <section className="settings-modal is-full-page">
        <aside className="settings-tabs">
          {modelSetupRequired ? (
            <div className="settings-setup-notice">
              <strong>先配置模型</strong>
              <span>连接一个可用模型后才能开始任务。</span>
              <button className="settings-setup-skip" onClick={onSkipModelSetup} type="button">
                先看看，稍后配置
              </button>
            </div>
          ) : (
            <button aria-label="返回应用" className="settings-back-button" onClick={onClose} type="button">
              <Icon name="arrow-left" size={16} />
              <strong>设置</strong>
            </button>
          )}
          <nav aria-label="设置分类" className="settings-nav-list">
            {settingsNav.filter((item) => !modelSetupRequired || item.tab === "模型").map((item) => (
              <button aria-current={tab === item.tab ? "page" : undefined} className={tab === item.tab ? "is-selected" : ""} key={item.tab} onClick={() => setTab(item.tab)} type="button">
                <span>{item.label}</span>
                {item.badge ? <em className="settings-nav-badge">{item.badge}</em> : null}
              </button>
            ))}
          </nav>
        </aside>
        <main className="settings-content">
          <header>
            <div className="settings-heading">
              <h2>{modelSetupRequired ? "配置模型" : settingsTitles[tab]}</h2>
              <p>{modelSetupRequired ? "开始使用前，请先连接一个可用模型。" : settingsSubtitles[tab]}</p>
            </div>
          </header>
          {tab === "模型" ? <SettingsModels
            models={workspace?.models ?? []}
            connections={workspace?.connections ?? []}
            runtime={runtime?.info}
            onFetchCatalog={onFetchModelCatalog}
            onOpenExternal={onOpenExternal}
            onStartLogin={onStartModelLogin}
            onCompleteLogin={onCompleteModelLogin}
            onCancelLogin={onCancelModelLogin}
            onChange={(alias, thinking) => execute(async () => await onSwitchModel(alias, thinking), "默认模型已更新")}
            onNotify={setMessage}
            onSave={async (configuration) => {
              setMessage(undefined);
              try {
                await onSaveModelConfiguration(configuration);
                setMessage("模型配置已保存");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
                throw error;
              }
            }}
            onTest={async (configuration) => {
              try {
                return await onTestModelConfiguration(configuration);
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return { ok: false, message: text };
              }
            }}
            onRemove={async (alias) => {
              setMessage(undefined);
              try {
                await onRemoveModelConfiguration(alias);
                setMessage("已取消启用该模型");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
                throw error;
              }
            }}
          /> : null}
          {tab === "外观" ? <SettingsAppearance theme={themePreference} onThemeChange={onThemePreference} font={fontPreference} onFontChange={onFontPreference} /> : null}
          {tab === "个性化" ? <SettingsPersonalization
            onLoad={onLoadPersonalizationOverview}
            onNotify={setMessage}
            onSaveChat={onSaveChatPersonalization}
            onSaveSettings={onSavePersonalizationSettings}
            sessionId={sessionId}
            sessionRunning={sessionRunning}
          /> : null}
          {tab === "记忆" ? <SettingsMemory
            models={workspace?.models ?? []}
            onLoad={onLoadMemoryOverview}
            onSaveSettings={onSaveMemorySettings}
            onSearch={onSearchMemory}
            onAdd={onAddMemoryEntry}
            onDeleteEntry={onDeleteMemoryEntry}
            onClear={onClearMemory}
            onCompact={onCompactMemory}
            onNotify={setMessage}
          /> : null}
          {tab === "关于" ? <SettingsAbout version={version} /> : null}
          {tab === "联网搜索" ? <SettingsWebSearch
            onLoad={onLoadWebSearchSettings}
            onNotify={setMessage}
            onOpenExternal={onOpenExternal}
            onSave={onSaveWebSearchSettings}
            onLoadCookieJarStatus={onLoadCookieJarStatus}
            onOpenBrowser={onOpenBrowser}
            onExportCookies={onExportCookies}
            onImportCookies={onImportCookies}
            onClearCookies={onClearCookies}
          /> : null}
          {message ? <div className="settings-message">{message}</div> : null}
        </main>
      </section>
    </Dialog>
  );
}

/** 把模型列表按 provider 归组，设置页里按「连接」为单位展示而不是罗列所有模型。 */
function connectionLabel(models: ModelChoice[]): Array<{ provider: string; providerType: string; models: ModelChoice[]; defaultModel?: ModelChoice }> {
  const groups = new Map<string, { provider: string; providerType: string; models: ModelChoice[]; defaultModel?: ModelChoice }>();
  for (const model of models) {
    const key = model.provider;
    const current = groups.get(key) ?? {
      provider: model.provider,
      providerType: model.providerType,
      models: []
    };
    current.models.push(model);
    if (!current.defaultModel) current.defaultModel = model;
    groups.set(key, current);
  }
  return [...groups.values()];
}

/**
 * Candidate list for the "启用模型" editor: models already configured first (so
 * the user can always toggle one off), then whatever the provider's live
 * catalog returned, then the built-in static entries as a floor. Live entries
 * win over static ones on display name / capability metadata.
 */
function mergeAvailableModels(
  catalogModels: CatalogModel[],
  configuredModels: ModelChoice[],
  liveModels: CatalogModel[] = []
): CatalogModel[] {
  const merged: CatalogModel[] = [];
  const seen = new Set<string>();
  const liveById = new Map(liveModels.map((model) => [model.id, model] as const));
  for (const model of configuredModels) {
    if (seen.has(model.model)) continue;
    seen.add(model.model);
    const live = liveById.get(model.model);
    merged.push({
      id: model.model,
      displayName: live?.displayName ?? model.displayName,
      supportsThinking: model.efforts.length > 0 || Boolean(live?.supportsThinking),
      parallelToolCalls: model.capabilities?.parallelToolCalls ?? live?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream ?? live?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary ?? live?.reasoningSummary,
      supportsVision: model.capabilities?.vision ?? live?.supportsVision,
      supportsAudio: model.capabilities?.audio ?? live?.supportsAudio,
      contextWindow: model.contextWindow ?? live?.contextWindow,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens ?? live?.maxOutputTokens,
      limits: model.limits ?? live?.limits,
      thinkingLevelMap: model.thinkingLevelMap ?? live?.thinkingLevelMap,
      apiBackend: model.apiBackend ?? live?.apiBackend
    });
  }
  for (const model of [...liveModels, ...catalogModels]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

/** Maps one live `ModelCatalogEntry` from the provider onto the picker's shape. */
function catalogModelFromEntry(entry: DesktopModelCatalogResult["models"][number]): CatalogModel {
  return {
    id: entry.id,
    displayName: entry.displayName,
    supportsThinking: entry.reasoningEfforts.length > 0 || entry.capabilities.reasoning === true,
    parallelToolCalls: entry.capabilities.parallelToolCalls,
    reasoningStream: entry.capabilities.reasoningStream,
    reasoningSummary: entry.capabilities.reasoningSummary,
    supportsVision: entry.capabilities.vision,
    supportsAudio: entry.capabilities.audio,
    contextWindow: entry.contextWindow,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits,
    thinkingLevelMap: entry.thinkingLevelMap,
    apiBackend: entry.apiBackend
  };
}

interface LiveCatalogState {
  models: CatalogModel[];
  fetchedAt: string;
  source: DesktopModelCatalogResult["source"];
}

/** Short status line for one connection, or null when nothing needs attention. */
function connectionStatus(connection: DesktopModelConnection | undefined): { label: string; tone: "warn" | "error" } | null {
  if (!connection) return null;
  if (connection.authMode === "oauth-bearer") {
    if (!connection.hasCredential) return { label: "需要登录", tone: "error" };
    if (connection.oauthExpiresAt !== undefined && connection.oauthExpiresAt <= Date.now()) {
      return { label: "登录已过期", tone: "warn" };
    }
    return null;
  }
  if (connection.requiresApiKey && !connection.hasCredential) return { label: "缺少密钥", tone: "error" };
  return null;
}

/** One-line credential hint under the API key field. Always rendered, so the dialog height never jumps. */
function credentialHint(connection: DesktopModelConnection | undefined): string {
  if (!connection) return "尚未保存该连接的凭据";
  if (connection.credentialSource === "env") return `使用环境变量 ${connection.apiKeyEnv ?? ""} 中的密钥`;
  if (connection.credentialSource === "keychain") return "已保存在 macOS Keychain，粘贴新值可替换";
  if (connection.hasCredential) return "已设置，粘贴新值可替换";
  return connection.requiresApiKey ? "尚未设置密钥，粘贴后点击“更新密钥”" : "该服务通常无需密钥";
}

/** Arrow/Home/End traversal inside the enabled-model list (roving tabindex). */
function moveModelRowFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-row]")].filter((row) => !row.disabled);
  if (!rows.length) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? rows.length - 1
      : event.key === "ArrowDown"
        ? Math.min(current + 1, rows.length - 1)
        : Math.max(current - 1, 0);
  event.preventDefault();
  rows[next]?.focus();
}

function oauthExpiryHint(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "已通过官方 OAuth 登录，使用订阅配额。";
  const remainingMinutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (remainingMinutes <= 0) return "访问令牌已过期，将在下次发送时自动刷新。";
  if (remainingMinutes < 60) return `已登录，访问令牌 ${String(remainingMinutes)} 分钟后自动刷新。`;
  return `已登录，访问令牌 ${String(Math.round(remainingMinutes / 60))} 小时后自动刷新。`;
}

function formatFetchedAt(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function SettingsModels({ models, connections: connectionInfos, runtime, onChange, onSave, onTest, onRemove, onNotify, onOpenExternal, onFetchCatalog, onStartLogin, onCompleteLogin, onCancelLogin }: {
  models: ModelChoice[];
  connections: DesktopModelConnection[];
  runtime?: { modelAlias: string; thinking: ThinkingSelection };
  onChange(alias: string, thinking: ThinkingSelection): void;
  onSave(configuration: DesktopModelConfigurationInput): Promise<void>;
  onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onRemove(alias: string): Promise<void>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onFetchCatalog(providerAlias: string): Promise<DesktopModelCatalogResult>;
  onStartLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<void>;
  onCancelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}): React.JSX.Element {
  const connections = connectionLabel(models);
  const connectionInfoFor = (providerAlias: string): DesktopModelConnection | undefined =>
    connectionInfos.find((item) => item.providerAlias === providerAlias);
  // 模型设置是三态视图：连接列表 / 新增连接 / 连接详情。用一个 view 变量而不是多个布尔量，
  // 保证三者互斥。
  const [view, setView] = useState<{ kind: "list" } | { kind: "connect"; provider: ProviderCatalogItem } | { kind: "detail"; provider: string }>({ kind: "list" });
  const [category, setCategory] = useState<ProviderCategory>("推荐");
  const [query, setQuery] = useState("");
  const [connectApiKey, setConnectApiKey] = useState("");
  const [connectBaseUrl, setConnectBaseUrl] = useState("");
  const [connectModelId, setConnectModelId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [detailApiKey, setDetailApiKey] = useState("");
  const [detailBaseUrl, setDetailBaseUrl] = useState("");
  const [detailShowKey, setDetailShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loginStage, setLoginStage] = useState<"idle" | "opening" | "waiting" | "submitted">("idle");
  const [loginRequest, setLoginRequest] = useState<DesktopModelLoginStartResult>();
  const [loginError, setLoginError] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [liveCatalog, setLiveCatalog] = useState<Record<string, LiveCatalogState>>({});
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();

  const providerOrder = providerCatalogOrder[category];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProviders = providerCatalog
    .filter((item) => {
      if (!item.categories.includes(category)) return false;
      if (!normalizedQuery) return true;
      const haystack = `${item.label} ${item.description} ${item.badge}`.toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .sort((left, right) => providerOrder.indexOf(left.id) - providerOrder.indexOf(right.id));

  // 打开新增/详情视图时把表单状态全部复位：这些字段（尤其是 API key 和测试结果）不能跨
  // provider 残留。
  const openConnect = (provider: ProviderCatalogItem): void => {
    setConnectApiKey("");
    setConnectBaseUrl(provider.baseUrl);
    setConnectModelId(provider.models[0]?.id ?? "");
    setShowKey(false);
    setTestResult(undefined);
    setLoginStage("idle");
    setLoginRequest(undefined);
    setLoginError(undefined);
    setAuthorizationCode("");
    setView({ kind: "connect", provider });
  };

  const openDetail = (providerAlias: string): void => {
    const group = connections.find((item) => item.provider === providerAlias);
    const savedBaseUrl = connectionInfoFor(providerAlias)?.baseUrl;
    const catalog = group ? catalogForConnection(group, savedBaseUrl) : undefined;
    setDetailApiKey("");
    // 回填这条连接实际保存的地址。若直接退回目录里的默认值，等于悄悄提议把用户自定义的
    // base URL 覆盖成内置地址。
    setDetailBaseUrl(savedBaseUrl ?? catalog?.baseUrl ?? "");
    setDetailShowKey(false);
    setAdvancedOpen(false);
    setTestResult(undefined);
    setView({ kind: "detail", provider: providerAlias });
  };

  const refreshCatalog = async (providerAlias: string): Promise<void> => {
    setFetchingCatalog(true);
    try {
      const result = await onFetchCatalog(providerAlias);
      if (result.source === "fallback") {
        onNotify("无法从服务商获取模型列表，已保留当前列表。请检查密钥与服务地址。");
        return;
      }
      setLiveCatalog((current) => ({
        ...current,
        [providerAlias]: { models: result.models.map(catalogModelFromEntry), fetchedAt: result.fetchedAt, source: result.source }
      }));
      onNotify(`模型目录已更新 · ${String(result.models.length)} 个模型`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setFetchingCatalog(false);
    }
  };

  const saveConfiguration = async (input: DesktopModelConfigurationInput): Promise<void> => {
    setSaving(true);
    try {
      await onSave(input);
    } finally {
      setSaving(false);
    }
  };

  const buildProviderConfiguration = (
    provider: ProviderCatalogItem,
    options: { apiKey?: string; baseUrl?: string; modelId?: string; requireApiKey?: boolean; makeDefault?: boolean } = {}
  ): DesktopModelConfigurationInput | undefined => {
    const isCustom = provider.value === "openai-compatible";
    const modelId = (options.modelId ?? (isCustom ? connectModelId : provider.models[0]?.id ?? connectModelId)).trim();
    if (!modelId) return undefined;
    const apiKey = (options.apiKey ?? connectApiKey).trim();
    if ((options.requireApiKey ?? provider.requiresApiKey) && !apiKey) return undefined;
    const baseUrl = (options.baseUrl ?? (connectBaseUrl.trim() || provider.baseUrl)).trim();
    if (isCustom && !baseUrl) return undefined;
    const providerAlias = providerAliasFor(provider, baseUrl);
    const catalogModel = provider.models.find((item) => item.id === modelId);
    return {
      alias: modelAliasFor(providerAlias, modelId),
      displayName: catalogModel?.displayName ?? modelId,
      providerAlias,
      providerType: provider.value,
      protocol: provider.protocol,
      model: modelId,
      baseUrl,
      apiKey: apiKey || undefined,
      apiKeyEnv: undefined,
      requiresApiKey: provider.requiresApiKey,
      supportsTools: true,
      // 手填模型 ID 没有可靠的能力来源，保持 undefined，由 ProviderRuntime 按 provider
      // 默认值补齐；未知 OpenAI-compatible 模型不会在渲染层猜测 reasoning 参数。
      supportsThinking: catalogModel?.supportsThinking,
      parallelToolCalls: catalogModel?.parallelToolCalls,
      reasoningStream: catalogModel?.reasoningStream,
      reasoningSummary: catalogModel?.reasoningSummary,
      supportsVision: catalogModel?.supportsVision,
      supportsAudio: catalogModel?.supportsAudio,
      contextWindow: catalogModel?.contextWindow,
      maxInputTokens: catalogModel?.maxInputTokens,
      maxOutputTokens: catalogModel?.maxOutputTokens,
      limits: catalogModel?.limits,
      thinkingLevelMap: catalogModel?.thinkingLevelMap,
      apiBackend: catalogModel?.apiBackend,
      makeDefault: options.makeDefault ?? false
    };
  };

  const connectProvider = async (provider: ProviderCatalogItem): Promise<void> => {
    const configuration = buildProviderConfiguration(provider, {
      apiKey: connectApiKey,
      baseUrl: connectBaseUrl.trim() || provider.baseUrl,
      modelId: provider.value === "openai-compatible" ? connectModelId : provider.models[0]?.id,
      requireApiKey: provider.requiresApiKey,
      // Connecting a brand-new provider is the one place the active default
      // should move — the user just picked this model.
      makeDefault: true
    });
    if (!configuration) return;
    await saveConfiguration(configuration);
    setConnectApiKey("");
    setView({ kind: "list" });
    // Pull the provider's real model list right away, so the connection detail
    // opens on the live catalog instead of the single built-in seed model.
    void refreshCatalogQuietly(configuration.providerAlias);
  };

  /** Post-connect catalog warm-up: best effort, never toasts. */
  const refreshCatalogQuietly = async (providerAlias: string): Promise<void> => {
    try {
      const result = await onFetchCatalog(providerAlias);
      if (result.source !== "fetched") return;
      setLiveCatalog((current) => ({
        ...current,
        [providerAlias]: { models: result.models.map(catalogModelFromEntry), fetchedAt: result.fetchedAt, source: result.source }
      }));
    } catch {
      // Leave the static catalog in place; the user can retry from 高级设置.
    }
  };

  const startLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider) return;
    setLoginStage("opening");
    setLoginError(undefined);
    try {
      const request = await onStartLogin(provider.loginProvider);
      setLoginRequest(request);
      setLoginStage("waiting");
    } catch (error) {
      setLoginStage("idle");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider || !loginRequest) return;
    setLoginStage("submitted");
    setLoginError(undefined);
    try {
      await onCompleteLogin(
        provider.loginProvider,
        loginRequest.authRequestId,
        loginRequest.method === "paste-code" ? authorizationCode : undefined
      );
      onNotify(`连接成功 · ${provider.label}`);
      setLoginRequest(undefined);
      setView({ kind: "list" });
    } catch (error) {
      setLoginStage("waiting");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };

  const cancelLogin = (provider: ProviderCatalogItem): void => {
    if (provider.loginProvider && loginRequest) void onCancelLogin(provider.loginProvider, loginRequest.authRequestId);
    setLoginRequest(undefined);
    setLoginError(undefined);
    setView({ kind: "list" });
  };

  const testProvider = async (configuration: DesktopModelConfigurationInput | undefined): Promise<void> => {
    if (!configuration) {
      const missing = { ok: false, message: "请先填写完整连接信息（密钥 / 模型 / 服务地址）" };
      setTestResult(missing);
      onNotify(missing.message);
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await onTest(configuration);
      setTestResult(result);
      onNotify(result.ok
        ? (result.latencyMs !== undefined ? `连接成功 · ${String(result.latencyMs)}ms` : result.message || "连接成功")
        : `连接失败：${result.message}`);
    } finally {
      setTesting(false);
    }
  };

  const detailGroup = view.kind === "detail" ? connections.find((item) => item.provider === view.provider) : undefined;
  const detailDefaultAlias = runtime?.modelAlias;
  const detailConnection = detailGroup ? connectionInfoFor(detailGroup.provider) : undefined;
  const detailCatalog = detailGroup
    ? catalogForConnection(detailGroup, detailConnection?.baseUrl) ?? customCatalogEntry(detailGroup, detailConnection?.baseUrl)
    : undefined;
  const detailLiveCatalog = detailGroup ? liveCatalog[detailGroup.provider] : undefined;
  const detailAvailableModels = detailGroup && detailCatalog
    ? mergeAvailableModels(detailCatalog.models, detailGroup.models, detailLiveCatalog?.models)
    : [];

  const saveKey = async (): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    const active = detailGroup.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup.defaultModel ?? detailGroup.models[0];
    if (!active || !detailApiKey.trim()) return;
    await saveConfiguration({
      alias: active.alias,
      displayName: active.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      protocol: detailConnection?.protocol ?? detailCatalog.protocol,
      model: active.model,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: detailApiKey.trim(),
      apiKeyEnv: undefined,
      supportsTools: active.supportsTools !== false,
      supportsThinking: active.efforts.length > 0,
      parallelToolCalls: active.capabilities?.parallelToolCalls,
      reasoningStream: active.capabilities?.reasoningStream,
      reasoningSummary: active.capabilities?.reasoningSummary,
      supportsVision: active.capabilities?.vision,
      supportsAudio: active.capabilities?.audio,
      contextWindow: active.contextWindow,
      maxInputTokens: active.maxInputTokens,
      maxOutputTokens: active.maxOutputTokens,
      limits: active.limits,
      thinkingLevelMap: active.thinkingLevelMap,
      apiBackend: active.apiBackend
    });
    setDetailApiKey("");
    // A fresh key usually unlocks the provider's real model list.
    void refreshCatalogQuietly(detailGroup.provider);
  };

  const saveBaseUrl = async (): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    const active = detailGroup.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup.defaultModel ?? detailGroup.models[0];
    if (!active) return;
    await saveConfiguration({
      alias: active.alias,
      displayName: active.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      protocol: detailConnection?.protocol ?? detailCatalog.protocol,
      model: active.model,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: undefined,
      apiKeyEnv: undefined,
      supportsTools: active.supportsTools !== false,
      supportsThinking: active.efforts.length > 0,
      parallelToolCalls: active.capabilities?.parallelToolCalls,
      reasoningStream: active.capabilities?.reasoningStream,
      reasoningSummary: active.capabilities?.reasoningSummary,
      supportsVision: active.capabilities?.vision,
      supportsAudio: active.capabilities?.audio,
      contextWindow: active.contextWindow,
      maxInputTokens: active.maxInputTokens,
      maxOutputTokens: active.maxOutputTokens,
      limits: active.limits,
      thinkingLevelMap: active.thinkingLevelMap,
      apiBackend: active.apiBackend
    });
  };

  const enableModel = async (catalogModel: CatalogModel): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    await saveConfiguration({
      alias: modelAliasFor(detailGroup.provider, catalogModel.id),
      displayName: catalogModel.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      protocol: detailConnection?.protocol ?? detailCatalog.protocol,
      model: catalogModel.id,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: undefined,
      apiKeyEnv: undefined,
      supportsTools: true,
      supportsThinking: catalogModel.supportsThinking,
      parallelToolCalls: catalogModel.parallelToolCalls,
      reasoningStream: catalogModel.reasoningStream,
      reasoningSummary: catalogModel.reasoningSummary,
      supportsVision: catalogModel.supportsVision,
      supportsAudio: catalogModel.supportsAudio,
      contextWindow: catalogModel.contextWindow,
      maxInputTokens: catalogModel.maxInputTokens,
      maxOutputTokens: catalogModel.maxOutputTokens,
      limits: catalogModel.limits,
      thinkingLevelMap: catalogModel.thinkingLevelMap,
      apiBackend: catalogModel.apiBackend
    });
  };

  const disableModel = async (alias: string): Promise<void> => {
    setSaving(true);
    try {
      await onRemove(alias);
    } finally {
      setSaving(false);
    }
  };

  const detailActive = detailGroup?.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup?.defaultModel ?? detailGroup?.models[0];
  const detailConfiguration: DesktopModelConfigurationInput | undefined = detailActive && detailGroup && detailCatalog ? {
    alias: detailActive.alias,
    displayName: detailActive.displayName,
    providerAlias: detailGroup.provider,
    providerType: detailCatalog.value,
    protocol: detailConnection?.protocol ?? detailCatalog.protocol,
    model: detailActive.model,
    baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
    apiKey: detailApiKey.trim() || undefined,
    apiKeyEnv: undefined,
    supportsTools: detailActive.supportsTools !== false,
    supportsThinking: detailActive.efforts.length > 0,
    parallelToolCalls: detailActive.capabilities?.parallelToolCalls,
    reasoningStream: detailActive.capabilities?.reasoningStream,
    reasoningSummary: detailActive.capabilities?.reasoningSummary,
    supportsVision: detailActive.capabilities?.vision,
    supportsAudio: detailActive.capabilities?.audio,
    contextWindow: detailActive.contextWindow,
    maxInputTokens: detailActive.maxInputTokens,
    maxOutputTokens: detailActive.maxOutputTokens,
    limits: detailActive.limits,
    thinkingLevelMap: detailActive.thinkingLevelMap,
    apiBackend: detailActive.apiBackend
  } : undefined;

  const deleteConnection = async (): Promise<void> => {
    if (!detailGroup) return;
    if (models.length <= detailGroup.models.length) {
      onNotify("至少需要保留一个模型连接");
      return;
    }
    setSaving(true);
    try {
      for (const model of detailGroup.models) await onRemove(model.alias);
      setView({ kind: "list" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="settings-sections model-settings">
      <section className="connection-section">
        <div className="section-heading-row">
          <div>
            <h3>已连接</h3>
            <p>管理默认模型、凭据与需要处理的连接状态。</p>
          </div>
          {connections.length ? <span className="section-count">{connections.length} 个连接</span> : null}
        </div>
        {connections.length ? (
          <div className="connection-list">
            {connections.map((connection) => {
              const info = connectionInfoFor(connection.provider);
              const catalog = catalogForConnection(connection, info?.baseUrl) ?? customCatalogEntry(connection, info?.baseUrl);
              const isDefault = connection.models.some((model) => model.alias === runtime?.modelAlias);
              const status = connectionStatus(info);
              return (
                <button className={`connection-card${isDefault ? " is-default" : ""}`} key={connection.provider} onClick={() => openDetail(connection.provider)} type="button">
                  <span className={`provider-mark is-${catalog.iconTone}`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
                  <span className="connection-card-copy">
                    <strong>
                      {catalog.label}
                      {isDefault ? <span className="default-pill">默认</span> : null}
                    </strong>
                    <small>已启用 {connection.models.length} 个模型</small>
                  </span>
                  {status ? <span className={`status-pill is-${status.tone}`}>{status.label}</span> : null}
                  <Icon name="chevron" className="connection-chevron" size={14} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="connection-empty">
            <strong>还没有模型连接</strong>
            <span>从下方选择一种连接方式开始。</span>
          </div>
        )}
      </section>

      <section className="connection-section">
        <div className="section-heading-row">
          <div>
            <h3>添加新连接</h3>
            <p>选择账号登录、模型计划、API、聚合服务或本地运行时。</p>
          </div>
        </div>
        <div className="provider-category-tabs">
          {(["推荐", "账号", "模型计划", "API", "聚合服务", "本地"] as ProviderCategory[]).map((name) => (
            <button className={category === name ? "is-selected" : ""} key={name} onClick={() => setCategory(name)} type="button">{name}</button>
          ))}
        </div>
        <label className="provider-search">
          <Icon name="search" size={14} />
          <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商" value={query} />
        </label>
        <div className="provider-catalog-list">
          {filteredProviders.map((provider) => (
            <button className="provider-catalog-row" key={provider.id} onClick={() => openConnect(provider)} type="button">
              <span className={`provider-mark is-${provider.iconTone}`}><ProviderBrandGlyph type={provider.iconTone} /></span>
              <span className="provider-catalog-copy">
                <strong>{provider.label}</strong>
                <small>{provider.description}</small>
              </span>
              <span className="provider-badge">{provider.badge}</span>
              <Icon name="chevron" className="connection-chevron" size={14} />
            </button>
          ))}
          {!filteredProviders.length ? <div className="settings-empty">没有匹配的服务商</div> : null}
        </div>
      </section>
      </div>
      {view.kind === "connect" ? createPortal(
        <ModelDialogBackdrop onClose={() => {
          if (view.provider.connectionMode === "login") cancelLogin(view.provider);
          else setView({ kind: "list" });
        }}>
          {view.provider.connectionMode === "login" ? (
            <LoginProviderDialog
              provider={view.provider}
              stage={loginStage}
              loginRequest={loginRequest}
              error={loginError}
              authorizationCode={authorizationCode}
              onAuthorizationCode={setAuthorizationCode}
              onStart={() => void startLogin(view.provider)}
              onSubmit={() => void submitLogin(view.provider)}
              onCancel={() => cancelLogin(view.provider)}
            />
          ) : (
            <ConnectProviderDialog
              provider={view.provider}
              apiKey={connectApiKey}
              baseUrl={connectBaseUrl}
              modelId={connectModelId}
              showKey={showKey}
              saving={saving}
              testing={testing}
              testResult={testResult}
              isCustom={view.provider.value === "openai-compatible"}
              onApiKey={(value) => { setConnectApiKey(value); setTestResult(undefined); }}
              onBaseUrl={(value) => { setConnectBaseUrl(value); setTestResult(undefined); }}
              onModelId={(value) => { setConnectModelId(value); setTestResult(undefined); }}
              onToggleKey={() => setShowKey((value) => !value)}
              onCancel={() => setView({ kind: "list" })}
              onTest={() => void testProvider(buildProviderConfiguration(view.provider, {
                apiKey: connectApiKey,
                baseUrl: connectBaseUrl.trim() || view.provider.baseUrl,
                modelId: view.provider.value === "openai-compatible" ? connectModelId : view.provider.models[0]?.id,
                requireApiKey: view.provider.requiresApiKey
              }))}
              onSubmit={() => void connectProvider(view.provider)}
              onOpenExternal={onOpenExternal}
            />
          )}
        </ModelDialogBackdrop>,
        document.body
      ) : null}
      {detailGroup && detailCatalog ? createPortal(
        <ModelDialogBackdrop onClose={() => setView({ kind: "list" })}>
          <ConnectionDetailDialog
            group={detailGroup}
            catalog={detailCatalog}
            connection={detailConnection}
            availableModels={detailAvailableModels}
            liveCatalog={detailLiveCatalog}
            defaultAlias={detailDefaultAlias}
            apiKey={detailApiKey}
            baseUrl={detailBaseUrl}
            showKey={detailShowKey}
            advancedOpen={advancedOpen}
            saving={saving}
            testing={testing}
            fetchingCatalog={fetchingCatalog}
            testResult={testResult}
            configuration={detailConfiguration}
            onApiKey={(value) => { setDetailApiKey(value); setTestResult(undefined); }}
            onBaseUrl={(value) => { setDetailBaseUrl(value); setTestResult(undefined); }}
            onToggleKey={() => setDetailShowKey((value) => !value)}
            onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
            onClose={() => setView({ kind: "list" })}
            onTest={() => void testProvider(detailConfiguration)}
            onSaveKey={() => void saveKey()}
            onSaveBaseUrl={() => void saveBaseUrl()}
            onEnableModel={(model) => void enableModel(model)}
            onDisableModel={(alias) => void disableModel(alias)}
            onDeleteConnection={() => void deleteConnection()}
            canDeleteConnection={models.length > detailGroup.models.length}
            onRefreshCatalog={() => void refreshCatalog(detailGroup.provider)}
            onRelogin={() => {
              // The saved config records which OAuth flow minted this token, so
              // re-login reuses the exact same provider card rather than guessing.
              const provider = providerCatalog.find((item) => item.loginProvider === detailConnection?.oauthProvider);
              if (provider) openConnect(provider);
              else onNotify("该连接没有可用的登录方式。");
            }}
            onOpenExternal={onOpenExternal}
            onChange={onChange}
          />
        </ModelDialogBackdrop>,
        document.body
      ) : null}
    </>
  );
}

type ConnectionGroup = ReturnType<typeof connectionLabel>[number];

function ModelDialogBackdrop({ children, onClose }: { children: React.ReactNode; onClose(): void }): React.JSX.Element {
  return (
    <Dialog
      className="desktop-model-dialog"
      isOpen
      maxHeight="min(820px, calc(100vh - 48px))"
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      padding={0}
      purpose="form"
      width="min(560px, calc(100vw - 48px))"
    >
      {children}
    </Dialog>
  );
}

/**
 * 订阅制登录对话框（Claude 订阅 / ChatGPT Codex）。
 *
 * 两家流程不同：`paste-code` 需要用户把授权码粘回来，`browser-callback` 由本地回调服务器
 * 自动接收，界面上只显示等待。`stage` 驱动这几步的展示，`stateHint` 用于让用户确认浏览器里
 * 打开的是同一个授权请求。
 */
function LoginProviderDialog({
  provider,
  stage,
  loginRequest,
  error,
  authorizationCode,
  onAuthorizationCode,
  onStart,
  onSubmit,
  onCancel
}: {
  provider: ProviderCatalogItem;
  stage: "idle" | "opening" | "waiting" | "submitted";
  loginRequest?: DesktopModelLoginStartResult;
  error?: string;
  authorizationCode: string;
  onAuthorizationCode(value: string): void;
  onStart(): void;
  onSubmit(): void;
  onCancel(): void;
}): React.JSX.Element {
  const waiting = stage !== "idle";
  const usesPasteCode = loginRequest?.method === "paste-code";
  const isCodex = provider.id === "openai-codex";
  const loginSubtitle = provider.id === "claude-code"
    ? "登录 Claude Pro / Max 后，验证该账号实际可用模型。"
    : "登录 ChatGPT Plus / Pro 后，验证该账号实际可用 Codex 模型。";
  const subscriptionTitle = provider.id === "claude-code" ? "Claude 订阅 (Pro / Max)" : `${provider.label} 订阅`;
  const authorizationHost = provider.id === "claude-code" ? "Claude.ai" : "ChatGPT";
  return (
    <section className={`connect-dialog login-dialog${waiting ? " is-waiting" : ""}`} role="dialog" aria-label={`连接 ${provider.label}`}>
      <header>
        <div className="connection-detail-title">
          <span className={`provider-mark is-${provider.iconTone}`}><ProviderBrandGlyph type={provider.iconTone} /></span>
          <div>
            <strong>连接 {provider.label}</strong>
            <small>{loginSubtitle}</small>
          </div>
        </div>
        <button aria-label="关闭连接对话框" className="icon-button" onClick={onCancel} type="button"><Icon name="close" /></button>
      </header>
      <div className="login-section-label">订阅</div>
      <div className="login-subscription-card">
        <div className="login-subscription-heading">
          <div>
            <strong>{subscriptionTitle}</strong>
            <small>通过 {provider.label} 官方 OAuth 登录使用订阅配额。</small>
          </div>
          <span className={`login-status${waiting ? " is-waiting" : ""}`}>{stage === "submitted" ? "正在验证..." : stage === "opening" ? "正在打开..." : waiting ? "等待登录..." : "未登录"}</span>
        </div>
        {!waiting ? <p>使用订阅配额前需要先通过官方 OAuth 登录。</p> : <p>{usesPasteCode ? "请在浏览器完成登录后粘贴授权码。" : isCodex ? "请在弹出的浏览器窗口完成登录，浏览器会自动返回此应用。" : "正在准备登录。"}</p>}
        {!waiting ? (
          <button className="login-primary-button" onClick={onStart} type="button">登录订阅</button>
        ) : (
          <button className="login-primary-button" disabled={stage !== "waiting"} onClick={usesPasteCode ? undefined : onSubmit} type="button">{usesPasteCode ? "登录中..." : "完成登录"}</button>
        )}
        {usesPasteCode ? (
          <div className="login-code-panel">
            <p>在 {authorizationHost} 完成登录后，会跳转到控制台显示一段授权码（含 <code>#</code> 分隔符），把它粘贴到下面：</p>
            <small>提示：你的 state 以 <code>{loginRequest?.stateHint}</code> 开头。</small>
            <textarea
              autoFocus
              onChange={(event) => onAuthorizationCode(event.target.value)}
              placeholder="粘贴授权码（格式：xxx#yyy）"
              value={authorizationCode}
            />
            <div className="login-code-actions">
              <button className="login-primary-button" disabled={!authorizationCode.trim() || stage === "submitted"} onClick={onSubmit} type="button">提交授权码</button>
              <button onClick={onCancel} type="button">取消</button>
            </div>
          </div>
        ) : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

/**
 * 已有连接的详情对话框：换 key、改 base URL、启用/停用具体模型、测试连通性、删除连接。
 *
 * 所有状态都由 `SettingsModels` 持有并通过 props 传入（受控组件），这样测试结果、保存中标志
 * 等能在多个子对话框之间共享一致。
 */
function ConnectionDetailDialog({
  group,
  catalog,
  connection,
  availableModels,
  liveCatalog,
  defaultAlias,
  apiKey,
  baseUrl,
  showKey,
  advancedOpen,
  saving,
  testing,
  fetchingCatalog,
  testResult,
  configuration,
  onApiKey,
  onBaseUrl,
  onToggleKey,
  onToggleAdvanced,
  onClose,
  onTest,
  onSaveKey,
  onSaveBaseUrl,
  onEnableModel,
  onDisableModel,
  onDeleteConnection,
  canDeleteConnection,
  onRefreshCatalog,
  onRelogin,
  onOpenExternal,
  onChange
}: {
  group: ConnectionGroup;
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  availableModels: CatalogModel[];
  liveCatalog?: LiveCatalogState;
  defaultAlias?: string;
  apiKey: string;
  baseUrl: string;
  showKey: boolean;
  advancedOpen: boolean;
  saving: boolean;
  testing: boolean;
  fetchingCatalog: boolean;
  testResult?: DesktopModelConnectionTestResult;
  configuration?: DesktopModelConfigurationInput;
  onApiKey(value: string): void;
  onBaseUrl(value: string): void;
  onToggleKey(): void;
  onToggleAdvanced(): void;
  onClose(): void;
  onTest(): void;
  onSaveKey(): void;
  onSaveBaseUrl(): void;
  onEnableModel(model: CatalogModel): void;
  onDisableModel(alias: string): void;
  onDeleteConnection(): void;
  canDeleteConnection: boolean;
  onRefreshCatalog(): void;
  onRelogin(): void;
  onOpenExternal(url: string): Promise<void>;
  onChange(alias: string, thinking: ThinkingSelection): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const filteredModels = availableModels.filter((model) => !modelQuery.trim() || `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()));
  const isDefaultConnection = group.models.some((model) => model.alias === defaultAlias);
  // The list is one Tab stop, carried by the first row that can actually take
  // focus — the default-model row is locked and therefore unfocusable.
  const tabStopModelId = filteredModels.find((model) => group.models.find((configured) => configured.model === model.id)?.alias !== defaultAlias)?.id;
  const apiKeyUrl = catalog.apiKeyUrl;
  // OAuth-backed connections have no user-editable key: showing a password box
  // there just invites pasting something that can never work.
  const usesOAuth = connection?.authMode === "oauth-bearer";
  const status = connectionStatus(connection);
  const busy = saving || testing || fetchingCatalog;
  return (
    <section className={`connect-dialog connection-detail-dialog${advancedOpen ? " is-advanced" : ""}`} role="dialog" aria-label={`${catalog.label} 连接设置`}>
      <header>
        <div className="connection-detail-title">
          <span className={`provider-mark is-${catalog.iconTone}`}><ProviderBrandGlyph type={catalog.iconTone} /></span>
          <div>
            <strong>{catalog.label}</strong>
            <small>{isDefaultConnection ? "默认连接" : "已连接"}</small>
          </div>
        </div>
        <button aria-label="关闭连接设置" className="icon-button" onClick={onClose} type="button"><Icon name="close" /></button>
      </header>

      {usesOAuth ? (
        <div className={`connection-oauth-card${status ? " is-attention" : ""}`}>
          <div className="connection-oauth-heading">
            <strong>订阅登录</strong>
            <span className={`status-pill is-${status?.tone ?? "ok"}`}>{status?.label ?? "已登录"}</span>
          </div>
          <p>
            {status
              ? "该连接的授权已失效，重新登录后即可继续使用订阅配额。"
              : oauthExpiryHint(connection?.oauthExpiresAt)}
          </p>
          <button className="ghost-button" disabled={busy} onClick={onRelogin} type="button">重新登录</button>
        </div>
      ) : (
        <>
          <div className="connection-field">
            <div className="connection-field-label">
              <span>模型密钥</span>
              <small>{credentialHint(connection)}</small>
            </div>
            <div className="secret-input-row">
              <input
                autoComplete="off"
                onChange={(event) => onApiKey(event.target.value)}
                placeholder={connection?.hasCredential ? "••••••••" : "输入或粘贴 API Key"}
                type={showKey ? "text" : "password"}
                value={apiKey}
              />
              {/* The saved key never reaches the renderer (see credentialHint) —
                  this box only ever holds a freshly typed replacement, so there
                  is nothing to reveal until the user starts typing one. Toggling
                  `type` on an empty input looks identical either way, which read
                  as "the button does nothing". */}
              <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" disabled={!apiKey} onClick={onToggleKey} type="button">
                <Icon name={showKey ? "eye-off" : "eye"} size={14} />
              </button>
            </div>
          </div>

          <div className="connection-inline-row">
            {apiKeyUrl ? <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取模型密钥</a> : <span className="settings-link is-disabled">请向服务商获取密钥</span>}
            {/* Kept mounted and disabled instead of conditionally rendered, so the
                row height does not jump the moment the user starts typing a key. */}
            <button className="ghost-button" disabled={busy || !apiKey.trim()} onClick={onSaveKey} type="button">{saving ? "保存中…" : "更新密钥"}</button>
          </div>
        </>
      )}
      {testResult && !advancedOpen ? <ConnectionTestResult result={testResult} /> : null}

      <button className="advanced-toggle" onClick={onToggleAdvanced} type="button">
        <Icon name="chevron" size={12} style={{ transform: advancedOpen ? "rotate(0deg)" : "rotate(-90deg)" }} />
        高级设置
      </button>

      {advancedOpen ? (
        <div className="connection-advanced">
          <div className="connection-field">
            <div className="connection-field-label">
              <span>启用模型 {group.models.length}</span>
              <small>
                {liveCatalog
                  ? `共 ${String(availableModels.length)} 个候选 · 已于 ${formatFetchedAt(liveCatalog.fetchedAt)} 从服务商获取`
                  : `共 ${String(availableModels.length)} 个候选 · 内置列表，可点击“更新模型目录”拉取实时列表`}
              </small>
            </div>
            <label className="model-search-input">
              <Icon name="search" size={13} />
              <input onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" value={modelQuery} />
            </label>
            {/* Roving tabindex: the whole list is one Tab stop, so a provider
                returning hundreds of models doesn't wall off the controls below
                it for keyboard users. */}
            <div className="enabled-model-list" onKeyDown={(event) => moveModelRowFocus(event)} role="group" aria-label="可启用的模型">
              {filteredModels.map((catalogModel) => {
                const configured = group.models.find((model) => model.model === catalogModel.id);
                const isDefault = configured?.alias === defaultAlias;
                const enabled = Boolean(configured);
                return (
                  <div className={`enabled-model-row${enabled ? " is-enabled" : ""}${isDefault ? " is-default" : ""}`} key={catalogModel.id}>
                    <button
                      aria-checked={enabled}
                      aria-label={enabled ? `取消启用 ${catalogModel.displayName}` : `启用 ${catalogModel.displayName}`}
                      className="enabled-model-toggle"
                      data-model-row=""
                      // The default model must stay enabled — removing it would
                      // leave the runtime pointing at a model that is gone.
                      disabled={busy || isDefault}
                      onClick={() => {
                        if (configured) onDisableModel(configured.alias);
                        else onEnableModel(catalogModel);
                      }}
                      role="checkbox"
                      tabIndex={catalogModel.id === tabStopModelId ? 0 : -1}
                      type="button"
                    >
                      <span className={`check-dot${enabled ? " is-on" : ""}`}><Icon name="check" size={11} /></span>
                      <span className="enabled-model-name">{catalogModel.displayName}</span>
                      {catalogModel.id !== catalogModel.displayName ? <span className="enabled-model-id">{catalogModel.id}</span> : null}
                    </button>
                    {enabled && configured ? (
                      isDefault
                        ? <span className="default-pill">默认</span>
                        : <button className="set-default-button" disabled={busy} onClick={() => onChange(configured.alias, configured.defaultThinking)} type="button">设为默认</button>
                    ) : null}
                  </div>
                );
              })}
              {!filteredModels.length ? <div className="model-list-empty">{availableModels.length ? "没有匹配的模型" : "尚未获取到模型列表"}</div> : null}
            </div>
          </div>

          <div className="connection-field">
            <div className="connection-field-label"><span>服务地址</span></div>
            <div className="secret-input-row">
              <input onChange={(event) => onBaseUrl(event.target.value)} placeholder="https://api.example.com" value={baseUrl} />
              <button className="ghost-button" disabled={busy || !baseUrl.trim()} onClick={onSaveBaseUrl} type="button">保存服务地址</button>
            </div>
          </div>
          {testResult ? <ConnectionTestResult result={testResult} /> : null}
          <div className="connection-detail-footer">
            <div>
              <button className="ghost-button" disabled={busy || !configuration} onClick={onTest} type="button">{testing ? "测试中…" : "测试连接"}</button>
              <button className="text-button" disabled={busy} onClick={onRefreshCatalog} type="button">{fetchingCatalog ? "更新中…" : "更新模型目录"}</button>
            </div>
            <button className="danger-text-button" disabled={busy || !canDeleteConnection} onClick={onDeleteConnection} type="button">删除连接</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 新增连接对话框（API key 方式）。
 *
 * `isCustom` 指自建/中转端点：这类没有内置默认值，必须自己填 base URL 和模型 id，
 * 因此提交条件比选内置服务商时更严。
 */
function ConnectProviderDialog({
  provider,
  apiKey,
  baseUrl,
  modelId,
  showKey,
  saving,
  testing,
  testResult,
  isCustom,
  onApiKey,
  onBaseUrl,
  onModelId,
  onToggleKey,
  onCancel,
  onTest,
  onSubmit,
  onOpenExternal
}: {
  provider: ProviderCatalogItem;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  showKey: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  isCustom: boolean;
  onApiKey(value: string): void;
  onBaseUrl(value: string): void;
  onModelId(value: string): void;
  onToggleKey(): void;
  onCancel(): void;
  onTest(): void;
  onSubmit(): void;
  onOpenExternal(url: string): Promise<void>;
}): React.JSX.Element {
  const canSubmit = !(provider.requiresApiKey && !apiKey.trim()) && !(isCustom && (!modelId.trim() || !baseUrl.trim()));
  const apiKeyUrl = provider.apiKeyUrl;
  return (
    <div className="connect-dialog" role="dialog" aria-label={`连接 ${provider.label}`}>
        <header>
          <div className="connection-detail-title">
            <span className={`provider-mark is-${provider.iconTone}`}><ProviderBrandGlyph type={provider.iconTone} /></span>
            <div>
              <strong>连接 {provider.label}</strong>
              <small>完成必要配置后，连接会出现在模型页上方。</small>
            </div>
          </div>
          <button aria-label="关闭连接对话框" className="icon-button" onClick={onCancel} type="button"><Icon name="close" /></button>
        </header>
        <div className="connection-field">
          <div className="connection-field-label"><span>API Key</span></div>
          <div className="secret-input-row">
            <input
              autoComplete="off"
              autoFocus
              onChange={(event) => onApiKey(event.target.value)}
              placeholder={provider.requiresApiKey ? "输入或粘贴 API Key" : "本地服务通常无需填写"}
              type={showKey ? "text" : "password"}
              value={apiKey}
            />
            <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" disabled={!apiKey} onClick={onToggleKey} type="button">
              <Icon name={showKey ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
          {apiKeyUrl ? <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取模型密钥</a> : null}
        </div>
        {isCustom ? (
          <>
            <div className="connection-field">
              <div className="connection-field-label"><span>模型 ID</span></div>
              <input onChange={(event) => onModelId(event.target.value)} placeholder="例如 gpt-5.2" value={modelId} />
            </div>
            <div className="connection-field">
              <div className="connection-field-label"><span>服务地址</span></div>
              <input onChange={(event) => onBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" value={baseUrl} />
            </div>
          </>
        ) : null}
        {testResult ? <ConnectionTestResult result={testResult} /> : null}
        <div className="connect-dialog-actions">
          <button onClick={onCancel} type="button">取消</button>
          <button disabled={saving || testing || !canSubmit} onClick={onTest} type="button">{testing ? "测试中…" : "测试连接"}</button>
          <button
            className="is-primary"
            disabled={saving || testing || !canSubmit}
            onClick={onSubmit}
            type="button"
          >
            连接并使用
          </button>
        </div>
    </div>
  );
}

function ConnectionTestResult({ result }: { result: DesktopModelConnectionTestResult }): React.JSX.Element {
  const text = result.ok
    ? (result.latencyMs !== undefined ? `连接成功 · ${String(result.latencyMs)}ms` : result.message || "连接成功")
    : result.message || "连接失败";
  return (
    <div className={`connection-test-result${result.ok ? " is-ok" : " is-error"}`} role="status">
      <Icon name={result.ok ? "check" : "warning"} size={13} />
      <span>{text}</span>
    </div>
  );
}

const webSearchProviderOptions: Array<{ value: DesktopWebSearchProvider; title: string; detail: string; envKeyName?: string; keyUrl?: string }> = [
  { value: "anysearch", title: "AnySearch", detail: "支持匿名额度的聚合搜索，可选配置密钥提升额度", envKeyName: "ANYSEARCH_API_KEY" },
  { value: "google", title: "Google", detail: "解析 Google 网页搜索结果；用下方浏览器登录后成功率更高" },
  { value: "duckduckgo", title: "DuckDuckGo", detail: "免密钥，直接解析网页版搜索结果；偶尔会被反爬限制" },
  { value: "tavily", title: "Tavily", detail: "面向 AI 应用的搜索 API，免费额度约每月 1000 次", envKeyName: "TAVILY_API_KEY", keyUrl: "https://app.tavily.com/" },
  { value: "brave", title: "Brave Search", detail: "官方 Web Search API，需在控制台创建订阅密钥", envKeyName: "BRAVE_SEARCH_API_KEY", keyUrl: "https://api-dashboard.search.brave.com/" }
];

/**
 * 联网搜索设置。
 *
 * key 从不回填到输入框：主进程只回报「是否已配置」，不返回明文。因此输入框为空意为
 * 「不改动」，要清空已存的 key 需要显式勾选 `clearKey`。
 */
function SettingsWebSearch({ onLoad, onSave, onNotify, onOpenExternal, onLoadCookieJarStatus, onOpenBrowser, onExportCookies, onImportCookies, onClearCookies }: {
  onLoad(): Promise<DesktopWebSearchSettings>;
  onSave(input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
}): React.JSX.Element {
  const [settings, setSettings] = useState<DesktopWebSearchSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState<DesktopWebSearchProvider>("anysearch");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [maxResults, setMaxResults] = useState(5);
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [saving, setSaving] = useState(false);
  const [cookieJar, setCookieJar] = useState<DesktopCookieJarStatus>();
  const [cookieLoadError, setCookieLoadError] = useState<string>();
  const [cookieBusy, setCookieBusy] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("https://www.google.com/");

  const adopt = (next: DesktopWebSearchSettings): void => {
    setSettings(next);
    setEnabled(next.enabled);
    setProvider(next.provider);
    setMaxResults(next.maxResults);
    setTimeoutMs(next.timeoutMs);
    setApiKeyInput("");
    setClearKey(false);
  };

  // 加载期间组件可能被卸载（用户切走分页），用 cancelled 标志避免对已卸载组件 setState。
  useEffect(() => {
    let cancelled = false;
    onLoad()
      .then((next) => { if (!cancelled) adopt(next); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [onLoad]);

  // Cookie 不属于某个项目，但设置页重开时要重新读取：用户可能刚在浏览器窗口完成登录。
  useEffect(() => {
    let cancelled = false;
    onLoadCookieJarStatus()
      .then((next) => {
        if (cancelled) return;
        setCookieJar(next);
        setCookieLoadError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCookieLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [onLoadCookieJarStatus]);

  if (loadError) return <div className="settings-sections"><section><h3>无法加载联网搜索设置</h3><p>{loadError}</p></section></div>;
  if (!settings) return <div className="settings-sections"><section><p>正在加载设置…</p></section></div>;

  const option = webSearchProviderOptions.find((candidate) => candidate.value === provider);
  const requiresKey = provider === "tavily" || provider === "brave";
  const sameProviderSaved = settings.provider === provider;
  const envKeyName = (sameProviderSaved ? settings.envKeyName : undefined) ?? option?.envKeyName;
  const keyStatus = clearKey
    ? "保存后将清除已保存的密钥。"
    : sameProviderSaved && settings.hasApiKey
      ? "已保存密钥，输入新值可替换。"
      : sameProviderSaved && settings.envKeyDetected && envKeyName
        ? `已检测到环境变量 ${envKeyName}，可直接使用。`
        : envKeyName
          ? `粘贴密钥保存到本机钥匙串，或设置环境变量 ${envKeyName}。`
          : undefined;

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await onSave({
        enabled,
        provider,
        apiKey: clearKey ? "" : apiKeyInput.trim() || undefined,
        apiKeyEnv: settings.apiKeyEnv,
        timeoutMs,
        maxResults
      });
      adopt(next);
      onNotify("联网搜索设置已保存");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const refreshCookieJar = async (): Promise<void> => {
    const next = await onLoadCookieJarStatus();
    setCookieJar(next);
    setCookieLoadError(undefined);
  };

  const runCookieOperation = async (operation: () => Promise<DesktopCookieJarStatus>, success: string): Promise<void> => {
    if (cookieBusy) return;
    setCookieBusy(true);
    try {
      const next = await operation();
      setCookieJar(next);
      setCookieLoadError(undefined);
      onNotify(success);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setCookieBusy(false);
    }
  };

  const openEmbeddedBrowser = async (url?: string): Promise<void> => {
    if (cookieBusy) return;
    setCookieBusy(true);
    try {
      await onOpenBrowser(url);
      await refreshCookieJar();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setCookieBusy(false);
    }
  };

  const cookieSummary = cookieJar
    ? cookieJar.total
      ? `已同步 ${String(cookieJar.total)} 个 Cookie`
      : "暂未登录任何网站"
    : "正在读取 Cookie 状态…";
  const cookieUpdatedAt = cookieJar?.updatedAt
    ? `最近同步：${new Date(cookieJar.updatedAt).toLocaleString("zh-CN", { hour12: false })}`
    : undefined;

  return (
    <div className="settings-sections">
      <section>
        <h3>联网搜索</h3>
        <div className="setting-row">
          <span><strong>启用 web_search 工具</strong><small>关闭后 Agent 将无法搜索公网信息</small></span>
          <button aria-checked={enabled} className={`setting-switch${enabled ? " is-on" : ""}`} onClick={() => setEnabled(!enabled)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
      </section>
      <section>
        <h3>搜索服务</h3>
        <div role="radiogroup" aria-label="搜索服务">
          {webSearchProviderOptions.map((candidate) => (
            <button aria-checked={provider === candidate.value} className="permission-setting-row" key={candidate.value} onClick={() => { setProvider(candidate.value); setApiKeyInput(""); setClearKey(false); }} role="radio" type="button">
              <span className={`radio${provider === candidate.value ? " is-selected" : ""}`} />
              <span><strong>{candidate.title}</strong><small>{candidate.detail}</small></span>
              <em className="settings-nav-badge">{candidate.value === "duckduckgo" ? "免密钥" : candidate.value === "anysearch" ? "可匿名" : candidate.value === "google" ? "浏览器登录" : "API Key"}</em>
            </button>
          ))}
        </div>
      </section>
      {option?.envKeyName ? (
        <section>
          <h3>API 密钥</h3>
          <div className="secret-input-row">
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={clearKey}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder={requiresKey ? `${option?.title ?? ""} API Key` : "可选，用于提升 AnySearch 额度"}
              spellCheck={false}
              type="password"
              value={clearKey ? "" : apiKeyInput}
            />
            {sameProviderSaved && settings.hasApiKey ? (
              <button className="ghost-button" onClick={() => { setClearKey(!clearKey); setApiKeyInput(""); }} type="button">{clearKey ? "取消清除" : "清除密钥"}</button>
            ) : null}
          </div>
          {keyStatus ? <p className="web-search-key-status">{keyStatus}</p> : null}
          {option?.keyUrl ? (
            <a className="settings-link" href={option.keyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(option.keyUrl ?? ""); }} rel="noreferrer">获取 {option.title} API Key</a>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3>结果偏好</h3>
        <div className="setting-row">
          <span><strong>返回结果数</strong><small>单次搜索最多返回的链接条数</small></span>
          <select className="web-search-select" onChange={(event) => setMaxResults(Number(event.target.value))} value={maxResults}>
            {[...new Set([3, 5, 8, 10, maxResults])].sort((a, b) => a - b).map((count) => <option key={count} value={count}>{count} 条</option>)}
          </select>
        </div>
        <div className="setting-row">
          <span><strong>请求超时</strong><small>超过该时间未响应则终止本次搜索</small></span>
          <select className="web-search-select" onChange={(event) => setTimeoutMs(Number(event.target.value))} value={timeoutMs}>
            {[...new Set([5_000, 10_000, 20_000, 30_000, timeoutMs])].sort((a, b) => a - b).map((duration) => <option key={duration} value={duration}>{duration / 1_000} 秒</option>)}
          </select>
        </div>
      </section>
      <section>
        <h3>浏览器与 Cookie</h3>
        <div className="setting-row">
          <span><strong>Google 设置</strong><small>在内嵌浏览器里完成同意、验证或登录，Google 搜索会自动带上对应 Cookie</small></span>
          <button className="ghost-button" disabled={cookieBusy} onClick={() => void openEmbeddedBrowser("https://www.google.com/")} type="button">打开 Google</button>
        </div>
        <div className="setting-row">
          <span><strong>Cookie 状态</strong><small>{cookieSummary}{cookieUpdatedAt ? ` · ${cookieUpdatedAt}` : ""}</small></span>
          <button className="ghost-button" disabled={cookieBusy} onClick={() => void runCookieOperation(onLoadCookieJarStatus, "Cookie 状态已刷新")} type="button">刷新</button>
        </div>
        {cookieJar?.domains.length ? (
          <div aria-label="已登录站点" className="cookie-domain-list">
            {cookieJar.domains.map(({ domain, count }) => <span className="cookie-domain" key={domain}>{domain}<small>{count}</small></span>)}
          </div>
        ) : null}
        {cookieLoadError ? <p className="web-search-key-status">无法读取 Cookie：{cookieLoadError}</p> : null}
        <div className="settings-button-row">
          <button disabled={cookieBusy} onClick={() => void runCookieOperation(onImportCookies, "Cookie 已导入并同步给 Agent")} type="button">导入 Cookie</button>
          <button disabled={cookieBusy} onClick={() => void runCookieOperation(onExportCookies, "Cookie 已导出")} type="button">导出 Cookie</button>
          <button className="ghost-button is-danger" disabled={cookieBusy || !cookieJar?.total} onClick={() => void runCookieOperation(onClearCookies, "全部 Cookie 已清除")} type="button">清除全部</button>
        </div>
        <p className="web-search-key-status">支持 Cookie-Editor JSON。Cookie 只会按域名、路径和 HTTPS 规则发送给匹配的网站。</p>
      </section>
      <section>
        <h3>WebFetch 浏览器</h3>
        <p className="web-search-key-status">打开任意网页后登录；该登录态会同步给 <code>web_fetch</code> 和 Google 搜索。</p>
        <div className="web-browser-url-row">
          <input
            autoCapitalize="none"
            autoComplete="off"
            onChange={(event) => setBrowserUrl(event.target.value)}
            placeholder="https://example.com/"
            spellCheck={false}
            type="url"
            value={browserUrl}
          />
          <button disabled={cookieBusy || !browserUrl.trim()} onClick={() => void openEmbeddedBrowser(browserUrl.trim())} type="button">打开浏览器</button>
        </div>
      </section>
      <div className="settings-button-row">
        <button disabled={saving} onClick={() => void save()} type="button">{saving ? "保存中…" : "保存设置"}</button>
      </div>
    </div>
  );
}

const projectMemoryTopicOptions = [
  { value: "project", label: "project · 项目事实" },
  { value: "decisions", label: "decisions · 决策" },
  { value: "debugging", label: "debugging · 调试经验" },
  { value: "workflows", label: "workflows · 工作流" }
];
const globalMemoryTopicOptions = [
  { value: "preferences", label: "preferences · 长期偏好" },
  { value: "working-style", label: "working-style · 工作方式" }
];
const memoryKindOptions: Array<{ value: DesktopMemoryKind; label: string }> = [
  { value: "preference", label: "偏好" },
  { value: "working_style", label: "工作方式" },
  { value: "fact", label: "事实" },
  { value: "decision", label: "决策" },
  { value: "workflow", label: "流程" },
  { value: "gotcha", label: "踩坑" }
];

/**
 * 记忆策略是全局配置；条目库按 global/project 切换，并分别使用自己的 CAS revision。
 */
function SettingsMemory({ models, onLoad, onSaveSettings, onSearch, onAdd, onDeleteEntry, onClear, onCompact, onNotify }: {
  models: ModelChoice[];
  onLoad(scope: DesktopMemoryScope): Promise<DesktopMemoryOverview>;
  onSaveSettings(input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot>;
  onSearch(scope: DesktopMemoryScope, query: string): Promise<DesktopMemorySearchMatch[]>;
  onAdd(scope: DesktopMemoryScope, input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onDeleteEntry(scope: DesktopMemoryScope, entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onClear(scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onCompact(scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryCompactionResult>;
  onNotify(message: string): void;
}): React.JSX.Element {
  const [scope, setScope] = useState<DesktopMemoryScope>("project");
  const [overview, setOverview] = useState<DesktopMemoryOverview>();
  const [loadError, setLoadError] = useState<string>();
  const [useMemories, setUseMemories] = useState(true);
  const [generateMemories, setGenerateMemories] = useState(true);
  const [excludeExternalContext, setExcludeExternalContext] = useState(true);
  const [maxRecalled, setMaxRecalled] = useState(3);
  const [extractModel, setExtractModel] = useState("");
  const [consolidationModel, setConsolidationModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTopic, setNoteTopic] = useState("project");
  const [noteKind, setNoteKind] = useState<DesktopMemoryKind>("fact");
  const [importance, setImportance] = useState(3);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopMemorySearchMatch[]>();
  const [compactReport, setCompactReport] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);

  const adopt = useCallback((next: DesktopMemoryOverview): void => {
    setOverview(next);
    setUseMemories(next.settings.useMemories);
    setGenerateMemories(next.settings.generateMemories);
    setExcludeExternalContext(next.settings.excludeExternalContext);
    setMaxRecalled(next.settings.maxRecalled);
    setExtractModel(next.settings.extractModel ?? "");
    setConsolidationModel(next.settings.consolidationModel ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setOverview(undefined);
    setLoadError(undefined);
    setSearchResults(undefined);
    setCompactReport(undefined);
    setConfirmClear(false);
    onLoad(scope)
      .then((next) => { if (!cancelled) adopt(next); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [adopt, onLoad, scope]);

  const chooseScope = (next: DesktopMemoryScope): void => {
    if (busy || next === scope) return;
    setScope(next);
    setNoteTopic(next === "global" ? "preferences" : "project");
    setNoteKind(next === "global" ? "preference" : "fact");
  };

  if (loadError) return <div className="settings-sections"><section><h3>无法加载记忆设置</h3><p>{loadError}</p></section></div>;
  if (!overview) return <div className="settings-sections"><section><p>正在加载记忆…</p></section></div>;

  const saved = overview.settings;
  const settingsDirty = useMemories !== saved.useMemories
    || generateMemories !== saved.generateMemories
    || excludeExternalContext !== saved.excludeExternalContext
    || maxRecalled !== saved.maxRecalled
    || (extractModel || undefined) !== saved.extractModel
    || (consolidationModel || undefined) !== saved.consolidationModel;
  const topicOptions = scope === "global" ? globalMemoryTopicOptions : projectMemoryTopicOptions;
  const kindOptions = scope === "global" ? memoryKindOptions.slice(0, 2) : memoryKindOptions.slice(2);

  /** 即时操作的统一包装；CAS 冲突后重读当前 scope，避免继续提交旧 revision。 */
  const execute = async (operation: () => Promise<DesktopMemoryOverview>, success?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      adopt(await operation());
      if (success) onNotify(success);
      return true;
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      try {
        adopt(await onLoad(scope));
      } catch {
        // 原始错误更有操作价值；刷新失败留给下一次显式刷新处理。
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await onSaveSettings({
        expectedRevision: overview.configRevision,
        settings: {
          useMemories,
          generateMemories,
          excludeExternalContext,
          maxRecalled,
          extractModel: extractModel || undefined,
          consolidationModel: consolidationModel || undefined
        }
      });
      adopt({ ...overview, configRevision: next.configRevision, settings: next.settings });
      onNotify("记忆设置已保存");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
      try {
        adopt(await onLoad(scope));
      } catch {
        // 保留原始 CAS/配置错误。
      }
    } finally {
      setBusy(false);
    }
  };

  const compact = (): void => {
    setCompactReport(undefined);
    void execute(async () => {
      const result = await onCompact(scope, overview.revision);
      setCompactReport(result.error
        ? `整理失败：${result.error}`
        : result.after < result.before
          ? `${String(result.before)} 条 → ${String(result.after)} 条`
          : `${String(result.before)} 条，无可合并内容`);
      onNotify(result.error ? "记忆整理未完成" : result.after < result.before ? "记忆整理完成" : "暂无可合并的记忆");
      return await onLoad(scope);
    });
  };

  const search = (): void => {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    void (async () => {
      setBusy(true);
      try {
        setSearchResults(await onSearch(scope, trimmed));
      } catch (error) {
        onNotify(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const addNote = (): void => {
    const trimmed = note.trim();
    if (!trimmed) return;
    void execute(async () => await onAdd(scope, {
      topic: noteTopic,
      note: trimmed,
      kind: noteKind,
      importance
    }, overview.revision), "记忆已添加").then((ok) => { if (ok) setNote(""); });
  };

  const clearAll = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void execute(async () => await onClear(scope, overview.revision), `已清空${scope === "global" ? "全局" : "项目"}记忆`);
  };

  return (
    <div className="settings-sections">
      <section className="memory-scope-section">
        <div className="section-heading-row">
          <div><h3>记忆库</h3><p>全局记忆跨项目复用；项目记忆只在当前工作区使用。</p></div>
          <span className="memory-revision">版本 {overview.revision}</span>
        </div>
        <div aria-label="记忆范围" className="settings-segmented" role="tablist">
          <button aria-selected={scope === "project"} className={scope === "project" ? "is-selected" : ""} disabled={busy} onClick={() => chooseScope("project")} role="tab" type="button">当前项目</button>
          <button aria-selected={scope === "global"} className={scope === "global" ? "is-selected" : ""} disabled={busy} onClick={() => chooseScope("global")} role="tab" type="button">全局</button>
        </div>
      </section>

      <section>
        <div className="section-heading-row"><div><h3>记忆策略</h3><p>策略保存在全局配置中，对两个记忆库共同生效。</p></div><span className="settings-scope-badge">全局</span></div>
        <div className="setting-row">
          <span><strong>使用记忆</strong><small>新根回合检索相关的全局与项目记忆</small></span>
          <button aria-checked={useMemories} className={`setting-switch${useMemories ? " is-on" : ""}`} onClick={() => setUseMemories((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
        <div className="setting-row">
          <span><strong>生成记忆</strong><small>任务成功后提取可复用信息；关闭后不影响已有记忆</small></span>
          <button aria-checked={generateMemories} className={`setting-switch${generateMemories ? " is-on" : ""}`} onClick={() => setGenerateMemories((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
        <div className="setting-row">
          <span><strong>排除外部上下文</strong><small>不把网页、附件等外部内容自动沉淀为记忆</small></span>
          <button aria-checked={excludeExternalContext} className={`setting-switch${excludeExternalContext ? " is-on" : ""}`} onClick={() => setExcludeExternalContext((value) => !value)} role="switch" type="button"><span className="setting-switch-knob" /></button>
        </div>
        <div className="setting-row">
          <span><strong>最大检索记忆数</strong><small>每个新根回合自动注入的相关记忆条数（1-20）</small></span>
          <span className="memory-range-control"><input max={20} min={1} onChange={(event) => setMaxRecalled(Number(event.target.value))} type="range" value={maxRecalled} /><em>{maxRecalled}</em></span>
        </div>
        <div className="setting-row">
          <span><strong>提取模型</strong><small>生成候选记忆时使用；留空跟随会话模型</small></span>
          <select className="web-search-select" onChange={(event) => setExtractModel(event.target.value)} value={extractModel}><option value="">跟随会话模型</option>{models.map((model) => <option key={model.alias} value={model.alias}>{model.displayName}</option>)}</select>
        </div>
        <div className="setting-row">
          <span><strong>整理模型</strong><small>合并同类记忆时使用；留空跟随会话模型</small></span>
          <select className="web-search-select" onChange={(event) => setConsolidationModel(event.target.value)} value={consolidationModel}><option value="">跟随会话模型</option>{models.map((model) => <option key={model.alias} value={model.alias}>{model.displayName}</option>)}</select>
        </div>
        <div className="settings-button-row"><button disabled={busy || !settingsDirty} onClick={() => { void saveSettings(); }} type="button">{busy ? "处理中…" : "保存策略"}</button></div>
      </section>

      <section>
        <h3>{scope === "global" ? "全局统计" : "项目统计"}</h3>
        <div className="memory-stat-grid">
          <div className="memory-stat-card"><strong>{overview.totalEntries}</strong><span>记忆总数</span></div>
          <div className="memory-stat-card"><strong>{overview.topics.length}</strong><span>话题数</span></div>
          <div className="memory-stat-card"><strong>{saved.maxRecalled}</strong><span>每轮注入上限</span></div>
        </div>
      </section>

      <section>
        <h3>记忆整理</h3>
        <div className="setting-row">
          <span><strong>整理当前记忆库</strong><small>合并重复与相近条目，同时保留每条来源 lineage</small></span>
          <button className="ghost-button" disabled={busy || !overview.totalEntries} onClick={compact} type="button">{busy ? "处理中…" : "立即整理"}</button>
        </div>
        {compactReport ? <pre className="settings-memory-report">{compactReport}</pre> : null}
      </section>

      <section>
        <h3>添加记忆</h3>
        <textarea className="memory-note-input" onChange={(event) => setNote(event.target.value)} placeholder={scope === "global" ? "输入明确的长期偏好或工作方式…（至少 20 个字符）" : "输入希望 Biny 在当前项目记住的内容…（至少 20 个字符）"} rows={3} value={note} />
        <div className="memory-add-row is-detailed">
          <select className="web-search-select" onChange={(event) => setNoteTopic(event.target.value)} value={noteTopic}>{topicOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <select aria-label="记忆类型" className="web-search-select" onChange={(event) => setNoteKind(event.target.value as DesktopMemoryKind)} value={noteKind}>{kindOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <label className="memory-importance-input"><span>重要度</span><input max={5} min={1} onChange={(event) => setImportance(Number(event.target.value))} type="number" value={importance} /></label>
          <button disabled={busy || note.trim().length < 20} onClick={addNote} type="button">添加记忆</button>
        </div>
      </section>

      <section>
        <h3>搜索记忆</h3>
        <div className="memory-search-row">
          <input className="settings-inline-input" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder={`搜索${scope === "global" ? "全局" : "项目"}记忆…`} value={query} />
          <button className="ghost-button" disabled={busy || !query.trim()} onClick={search} type="button">搜索</button>
        </div>
        {searchResults ? searchResults.length ? (
          <div className="memory-entry-list">
            {searchResults.map((match) => (
              <div className="memory-entry" key={match.id}>
                <div className="memory-entry-head"><span className="memory-topic-tag">{match.topic}</span><span className="memory-kind-tag">{memoryKindLabel(match.kind)}</span><span className="memory-importance">重要度 {match.importance}/5</span><small>{formatMemoryDate(match.updatedAt)} · 匹配度 {match.score}</small></div>
                <p>{match.excerpt}</p>
                <small className="memory-provenance">{memoryLineageLabel(match.lineage)}</small>
              </div>
            ))}
          </div>
        ) : <p className="memory-empty-hint">没有匹配的记忆。</p> : null}
      </section>

      <section>
        <div className="section-heading-row">
          <div><h3>记忆列表</h3><p>来源、类型、时间与重要度均来自可审计存储记录。</p></div>
          <span className="settings-inline-actions">
            <button className="ghost-button" disabled={busy} onClick={() => { setConfirmClear(false); void execute(async () => await onLoad(scope)); }} type="button">刷新</button>
            <button className="ghost-button is-danger" disabled={busy || !overview.totalEntries} onClick={clearAll} type="button">{confirmClear ? "确认清空？" : "清空当前范围"}</button>
          </span>
        </div>
        {overview.entries.length ? (
          <div className="memory-entry-list">
            {overview.entries.map((entry) => (
              <div className="memory-entry" key={entry.id}>
                <div className="memory-entry-head">
                  <span className="memory-topic-tag">{entry.topic}</span>
                  <span className="memory-kind-tag">{memoryKindLabel(entry.kind)}</span>
                  <span className="memory-importance">重要度 {entry.importance}/5</span>
                  <small>{entry.updatedAt === entry.createdAt ? "创建于" : "更新于"} {formatMemoryDate(entry.updatedAt)}</small>
                  <button aria-label={`删除记忆：${entry.title}`} className="icon-button memory-entry-delete" disabled={busy} onClick={() => { void execute(async () => await onDeleteEntry(scope, entry.id, overview.revision), "记忆已删除"); }} type="button"><Icon name="close" size={12} /></button>
                </div>
                <strong>{entry.title}</strong>
                {entry.summary && entry.summary !== entry.title ? <p>{entry.summary}</p> : null}
                <small className="memory-provenance">{memoryLineageLabel(entry.lineage)}</small>
              </div>
            ))}
          </div>
        ) : <p className="memory-empty-hint">当前范围还没有记忆。任务成功后可自动生成，也可在上方手动添加。</p>}
      </section>
    </div>
  );
}

function formatMemoryDate(value?: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function memoryKindLabel(kind: DesktopMemoryKind): string {
  return memoryKindOptions.find((option) => option.value === kind)?.label ?? kind;
}

function memoryLineageLabel(lineage: NonNullable<DesktopMemoryOverview["entries"][number]["lineage"]>): string {
  const sources = [...new Set(lineage.map((item) => memorySourceLabel(item.source)))];
  const sessionIds = [...new Set(lineage.flatMap((item) => item.sessionId ? [item.sessionId] : []))];
  const external = lineage.some((item) => item.externalContext);
  return [
    sources.join(" / "),
    sessionIds.length ? `来源聊天 ${sessionIds.map(shortSessionId).join("、")}` : "",
    external ? "含外部上下文" : ""
  ].filter(Boolean).join(" · ");
}

function memorySourceLabel(source: DesktopMemoryOverview["entries"][number]["lineage"][number]["source"]): string {
  if (source === "explicit") return "手动添加";
  if (source === "completed_task") return "任务完成";
  if (source === "candidate") return "候选确认";
  if (source === "migration") return "旧版迁移";
  return "记忆整理";
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 16 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}
