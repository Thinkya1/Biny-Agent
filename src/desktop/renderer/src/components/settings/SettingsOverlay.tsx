/**
 * Desktop 设置中心。
 *
 * 设置壳只负责导航与页面装配；跨页草稿和补偿事务由 SettingsDraftProvider 统一管理。
 * 记忆 CRUD、连接测试、Cookie 与模型下载等一次性动作仍通过明确回调即时执行。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import type { ModelChoice, ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type { DesktopBehaviorPatternReviewAction, DesktopCookieJarStatus, DesktopFontPreference, DesktopMemoryCompactionResult, DesktopMemoryEmbeddingCancellationResult, DesktopMemoryEmbeddingDeleteResult, DesktopMemoryEmbeddingStatus, DesktopMemoryEntryInput, DesktopMemoryEntryPatch, DesktopMemoryOriginFilter, DesktopMemoryOverview, DesktopMemorySearchMatch, DesktopModelCatalogResult, DesktopModelConfigurationInput, DesktopModelConnection, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopSettingsCloseRequest, DesktopSettingsCloseResponse, DesktopSettingsSnapshot, DesktopTelosDocumentInput, DesktopTelosDriftResolutionAction, DesktopTelosOverview, DesktopThemePreference, DesktopWebSearchProvider, DesktopWorkspaceSnapshot } from "../../../../protocol.js";
import {
  apiFormatForConnection,
  apiFormatOption,
  apiFormatOptions,
  catalogForConnection,
  customCatalogEntry,
  modelAliasFor,
  providerAliasFor,
  providerCatalog,
  providerCatalogOrder,
  type ApiFormatId,
  type CatalogModel,
  type ProviderCatalogItem,
  type ProviderCategory
} from "../../providerCatalog.js";
import { Icon, type IconName } from "../Icon.js";
import { McpServersView } from "../McpServersView.js";
import { TopToast } from "../overlays/TopToast.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { SettingsAbout } from "./SettingsAbout.js";
import { SettingsAppearance } from "./SettingsAppearance.js";
import { SettingsChatParams } from "./SettingsChatParams.js";
import { SettingsCompaction } from "./SettingsCompaction.js";
import { SettingsActivity } from "./SettingsActivity.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { SettingsCloseGuard } from "./SettingsCloseGuard.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsDraftProvider } from "./SettingsDraftProvider.js";
import { SettingsMemory } from "./SettingsMemory.js";
import { SettingsPageFooter } from "./SettingsPageFooter.js";
import { SettingsPersonalizationDraft } from "./SettingsPersonalizationDraft.js";
import { SettingsExtensionsView } from "./SettingsExtensionsView.js";
import { searchSettings } from "./settingsSearch.js";

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
  onSettingsCommitted(snapshot: DesktopSettingsSnapshot): void;
  onNotify(message: string): void;
  closeRequest?: DesktopSettingsCloseRequest;
  onResolveCloseRequest(requestId: string, response: DesktopSettingsCloseResponse): Promise<void>;
  onClose(): void;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onFetchModelCatalog(providerAlias: string): Promise<DesktopModelCatalogResult>;
  onFetchModelCatalogCandidate(configuration: DesktopModelConfigurationInput): Promise<DesktopModelCatalogResult>;
  sessionId?: string;
  sessionRunning: boolean;
  onLoadMemoryOverview(filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview>;
  onSearchMemory(filter: DesktopMemoryOriginFilter, query: string): Promise<DesktopMemorySearchMatch[]>;
  onAddMemoryEntry(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onUpdateMemoryEntry(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onDeleteMemoryEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onClearMemory(filter: DesktopMemoryOriginFilter, expectedRevision: number): Promise<DesktopMemoryOverview>;
  onCompactMemory(filter: DesktopMemoryOriginFilter, expectedRevision: number, topic?: string): Promise<DesktopMemoryCompactionResult>;
  onLoadTelosOverview(): Promise<DesktopTelosOverview>;
  onSaveTelos(input: DesktopTelosDocumentInput, expectedRevision: number): Promise<DesktopTelosOverview>;
  onReviewBehaviorPattern(patternId: string, action: DesktopBehaviorPatternReviewAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onResolveTelosDrift(driftId: string, action: DesktopTelosDriftResolutionAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  onSnoozeTelosDrift(driftId: string, until: string, expectedRevision: number): Promise<DesktopTelosOverview>;
  onOpenChatDraft(input: string): void;
  onLoadMemoryEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onDeleteMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  onRebuildMemoryEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  onStartModelLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCancelModelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}

export type SettingsTab = "外观" | "个性化" | "聊天" | "模型" | "MCP 服务器" | "技能" | "插件" | "活动记录" | "记忆" | "联网搜索" | "关于";

const settingsNav: Array<{ badge?: string; icon: IconName; tab: SettingsTab; label: string }> = [
  { icon: "sun", tab: "外观", label: "外观" },
  { icon: "spark", tab: "个性化", label: "个性化" },
  { icon: "message", tab: "聊天", label: "聊天" },
  { icon: "network", tab: "模型", label: "模型供应商" },
  { icon: "plug", tab: "MCP 服务器", label: "MCP 服务器" },
  { icon: "wand", tab: "技能", label: "技能" },
  { icon: "puzzle", tab: "插件", label: "插件" },
  { badge: "Beta", icon: "activity", tab: "活动记录", label: "活动记录" },
  { badge: "Beta", icon: "brain", tab: "记忆", label: "记忆" },
  { badge: "Beta", icon: "search", tab: "联网搜索", label: "联网搜索" },
  { icon: "help", tab: "关于", label: "关于" }
];

const settingsTitles: Record<SettingsTab, string> = {
  外观: "外观",
  个性化: "个性化",
  聊天: "聊天",
  模型: "模型供应商",
  "MCP 服务器": "MCP 服务器",
  技能: "技能",
  插件: "插件",
  活动记录: "活动记录器",
  记忆: "记忆",
  联网搜索: "联网搜索",
  关于: "关于"
};

const settingsSubtitles: Record<SettingsTab, string> = {
  模型: "模型连接、API key 与默认模型管理。",
  外观: "显示模式、界面字体和字号。",
  个性化: "设置 Biny 的表达方式、长期偏好与当前聊天覆盖。",
  "MCP 服务器": "管理可供 Agent 使用的 MCP 扩展服务。",
  技能: "管理本机可用的 Agent Skills，并按需查看技能内容。",
  插件: "管理当前项目的 Plugin，并从官方市场安装。",
  活动记录: "记录事件与 AX 语义，必要时使用本地视觉 fallback，并控制隐私边界。",
  记忆: "记忆检索、自动生成、长期策略与条目管理。",
  联网搜索: "配置联网搜索与数据来源。",
  聊天: "温度、输出额度与自动压缩策略。",
  关于: "版本与产品信息。"
};

export function SettingsOverlay(props: SettingsOverlayProps): React.JSX.Element | null {
  const {
    fontPreference,
    onFontPreference,
    onNotify,
    onSettingsCommitted,
    onThemePreference,
    open,
    sessionId,
    sessionRunning,
    themePreference,
    workspace
  } = props;
  if (!open) return null;
  return (
    <SettingsDraftProvider
      active={open}
      onCommitted={onSettingsCommitted}
      onFontPreview={onFontPreference}
      onNotify={onNotify}
      onThemePreview={onThemePreference}
      projectId={workspace?.project.id}
      sessionId={sessionId}
      sessionRunning={sessionRunning}
    >
      <SettingsOverlayContent {...props} fontPreference={fontPreference} themePreference={themePreference} />
    </SettingsDraftProvider>
  );
}

function SettingsOverlayContent({
  open,
  version,
  workspace,
  modelSetupRequired,
  targetTab,
  themePreference,
  fontPreference,
  onNotify: _onNotify,
  onClose,
  onTestModelConfiguration,
  onFetchModelCatalog,
  onFetchModelCatalogCandidate,
  sessionRunning,
  onLoadMemoryOverview,
  onSearchMemory,
  onAddMemoryEntry,
  onUpdateMemoryEntry,
  onDeleteMemoryEntry,
  onClearMemory,
  onCompactMemory,
  onLoadTelosOverview,
  onSaveTelos,
  onReviewBehaviorPattern,
  onResolveTelosDrift,
  onSnoozeTelosDrift,
  onOpenChatDraft,
  onLoadMemoryEmbeddingStatus,
  onDownloadMemoryEmbeddingModel,
  onCancelMemoryEmbeddingDownload,
  onDeleteMemoryEmbeddingModel,
  onRebuildMemoryEmbeddingIndex,
  onCancelMemoryEmbeddingRebuild,
  onOpenExternal,
  onLoadCookieJarStatus,
  onOpenBrowser,
  onExportCookies,
  onImportCookies,
  onClearCookies,
  onStartModelLogin,
  onCancelModelLogin,
  closeRequest,
  onResolveCloseRequest
}: SettingsOverlayProps): React.JSX.Element | null {
  const settingsDraft = useSettingsDraft();
  const runtimeBusy = sessionRunning || settingsDraft.snapshot?.hasRunningTasks === true;
  const [tab, setTab] = useState<SettingsTab>("外观");
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [message, setMessage] = useState<string>();
  const [dismissedLoadError, setDismissedLoadError] = useState<string>();
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const activeTabRef = useRef<SettingsTab>(tab);
  const notifyForTab = (sourceTab: SettingsTab, nextMessage: string | undefined): void => {
    if (activeTabRef.current === sourceTab) setMessage(nextMessage);
  };
  useEffect(() => {
    if (open && modelSetupRequired) {
      _onNotify("当前没有可用于运行任务的模型。连接可用模型后，聊天与模型相关功能会自动恢复。");
    }
  }, [_onNotify, modelSetupRequired, open]);
  useEffect(() => {
    if (closeRequest) setCloseGuardOpen(true);
  }, [closeRequest]);
  // 由 Composer 直达模型设置时，在浏览器绘制前同步分页，避免先闪过上次打开的内容。
  useLayoutEffect(() => {
    if (!open) return;
    setMessage(undefined);
    if (targetTab) {
      activeTabRef.current = targetTab;
      setTab(targetTab);
      if (targetTab === "记忆") setMemoryVisited(true);
    }
  }, [open, targetTab]);
  const settingsModels = stagedModelChoices(settingsDraft.snapshot?.models.configured ?? workspace?.models ?? [], settingsDraft.draft?.models.upserts ?? [], settingsDraft.draft?.models.removeAliases ?? []);
  const defaultModelAlias = settingsDraft.draft?.models.defaultModel?.alias
    ?? settingsDraft.snapshot?.models.defaultModel;
  const searchResults = searchSettings(searchQuery);
  const selectTab = (nextTab: SettingsTab): void => {
    if (nextTab === tab) return;
    activeTabRef.current = nextTab;
    setTab(nextTab);
    setMessage(undefined);
    if (nextTab === "记忆") setMemoryVisited(true);
  };
  const selectSearchResult = (nextTab: SettingsTab, sectionId: string): void => {
    selectTab(nextTab);
    window.requestAnimationFrame(() => {
      const section = document.getElementById(sectionId);
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      section?.focus({ preventScroll: true });
    });
  };
  const discardAndClose = async (): Promise<void> => {
    await settingsDraft.discard();
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "discarded");
    else onClose();
  };
  const requestCancel = (): void => {
    if (settingsDraft.dirtyCount > 0) setCloseGuardOpen(true);
    else void discardAndClose();
  };
  const cancelClose = async (): Promise<void> => {
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "cancelled");
  };
  const extensionSettings = tab === "MCP 服务器" || tab === "技能" || tab === "插件";
  // 设置页提示统一走顶部药丸 toast：loadError 带警告图标优先展示，其余为纯文字提示。
  const visibleLoadError = settingsDraft.loadError && settingsDraft.loadError !== dismissedLoadError ? settingsDraft.loadError : undefined;
  const settingsToast = visibleLoadError ?? message;
  return (
    <Dialog
      aria-label="Biny 设置"
      className="desktop-settings-dialog"
      isOpen={open}
      onOpenChange={(isOpen) => { if (!isOpen) requestCancel(); }}
      padding={0}
      purpose="info"
      variant="fullscreen"
    >
      <section className={`settings-modal is-full-page${extensionSettings ? " is-extension-settings" : ""}`}>
        <div className="settings-modal-body">
          <aside className="settings-tabs">
          <button aria-label="返回应用" className="settings-back-button" onClick={requestCancel} type="button">
            <Icon name="arrow-left" size={16} />
            <strong>设置</strong>
          </button>
          <label className="settings-search-box">
            <Icon name="search" size={14} />
            <input aria-label="搜索设置" onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索设置" type="search" value={searchQuery} />
          </label>
          {searchQuery.trim() ? (
            <nav aria-label="设置搜索结果" className="settings-search-results">
              {searchResults.map((result) => (
                <button key={`${result.tab}:${result.sectionId}`} onClick={() => selectSearchResult(result.tab, result.sectionId)} type="button">
                  <strong>{result.title}</strong>
                  <small>{result.tab} · {result.description}</small>
                </button>
              ))}
              {!searchResults.length ? <p>没有匹配的设置</p> : null}
            </nav>
          ) : (
            <nav aria-label="设置分类" className="settings-nav-list">
              {settingsNav.map((item) => (
                <button aria-current={tab === item.tab ? "page" : undefined} className={tab === item.tab ? "is-selected" : ""} key={item.tab} onClick={() => selectTab(item.tab)} type="button">
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.badge ? <em className="settings-nav-badge">{item.badge}</em> : null}
                </button>
              ))}
            </nav>
          )}
          </aside>
          <main className={`settings-content${extensionSettings ? " is-extension-settings" : ""}`}>
          <header>
            <div className="settings-heading">
              <h2>{settingsTitles[tab]}</h2>
              <p>{settingsSubtitles[tab]}</p>
            </div>
            {settingsDraft.dirtyCount > 0 ? <span aria-live="polite" className="settings-header-unsaved" role="status">
              <span>未保存的更改</span>
              <span aria-hidden="true" className="settings-unsaved-dot" />
            </span> : null}
          </header>
          {tab === "模型" ? <SettingsModels
            active={open}
            models={settingsModels}
            connections={settingsDraft.snapshot?.models.connections ?? workspace?.connections ?? []}
            defaultModelAlias={defaultModelAlias}
            onFetchCatalog={onFetchModelCatalog}
            onFetchCatalogCandidate={onFetchModelCatalogCandidate}
            onOpenExternal={onOpenExternal}
            onStartLogin={onStartModelLogin}
            onCompleteLogin={async (provider, authRequestId, pastedAuthorization) => {
              const result = await window.biny.completeModelLoginForSettings(
                workspace?.project.id ?? "",
                provider,
                authRequestId,
                pastedAuthorization
              );
              settingsDraft.addOauthCredentialHandle(result.handle);
              const catalog = providerCatalog.find((item) => item.loginProvider === provider);
              if (!catalog) throw new Error("登录完成，但未找到对应的模型连接定义。");
              for (const [index, model] of result.models.entries()) {
                settingsDraft.upsertModel({
                  alias: modelAliasFor(providerAliasFor(catalog, catalog.baseUrl), model.id),
                  displayName: model.displayName,
                  providerAlias: providerAliasFor(catalog, catalog.baseUrl),
                  providerType: catalog.value,
                  protocol: catalog.protocol,
                  model: model.id,
                  baseUrl: catalog.baseUrl || undefined,
                  apiKey: undefined,
                  apiKeyHandle: undefined,
                  apiKeyEnv: undefined,
                  requiresApiKey: catalog.requiresApiKey,
                  supportsTools: true,
                  supportsThinking: model.supportsThinking,
                  makeDefault: index === 0
                });
              }
            }}
            onCancelLogin={onCancelModelLogin}
            onChange={(alias, thinking) => {
              settingsDraft.setDefaultModel(alias, thinking);
              notifyForTab("模型", "默认模型已加入草稿");
            }}
            onNotify={(nextMessage) => notifyForTab("模型", nextMessage)}
            onSave={async (configuration) => {
              notifyForTab("模型", undefined);
              try {
                const previous = settingsDraft.draft?.models.upserts.find((item) => item.alias === configuration.alias)?.apiKeyHandle;
                if (previous) await settingsDraft.releaseCredential(previous);
                const currentProjectId = workspace?.project.id;
                if (configuration.apiKey && currentProjectId === undefined) throw new Error("暂存模型密钥前必须先选择项目。");
                const staged = configuration.apiKey && currentProjectId !== undefined
                  ? await settingsDraft.stageCredential(configuration.apiKey, {
                      projectId: currentProjectId,
                      purpose: "model",
                      providerAlias: configuration.providerAlias
                    })
                  : undefined;
                settingsDraft.upsertModel({
                  ...configuration,
                  apiKey: undefined,
                  apiKeyHandle: staged?.handle ?? configuration.apiKeyHandle
                });
                notifyForTab("模型", "模型配置已加入草稿");
              } catch (error) {
                notifyForTab("模型", error instanceof Error ? error.message : String(error));
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
              notifyForTab("模型", undefined);
              try {
                const previous = settingsDraft.draft?.models.upserts.find((item) => item.alias === alias)?.apiKeyHandle;
                if (previous) await settingsDraft.releaseCredential(previous);
                settingsDraft.removeModel(alias);
                notifyForTab("模型", "模型变更已加入草稿");
              } catch (error) {
                notifyForTab("模型", error instanceof Error ? error.message : String(error));
                throw error;
              }
            }}
          /> : null}
          {tab === "外观" ? <SettingsAppearance
            theme={settingsDraft.draft?.themePreference ?? themePreference}
            onThemeChange={settingsDraft.setThemePreference}
            font={settingsDraft.draft?.fontPreference ?? fontPreference}
            onFontChange={settingsDraft.setFontPreference}
          /> : null}
          {tab === "活动记录" ? <SettingsActivity /> : null}
          {tab === "聊天" ? (<><SettingsChatParams /><SettingsCompaction /></>) : null}
          {tab === "个性化" ? <SettingsPersonalizationDraft sessionRunning={runtimeBusy} /> : null}
          {memoryVisited ? <SettingsMemory
            models={settingsModels}
            projectId={workspace?.project.id}
            hidden={tab !== "记忆"}
            workspaceAvailable={workspace !== undefined}
            onLoad={onLoadMemoryOverview}
            onSearch={onSearchMemory}
            onAdd={onAddMemoryEntry}
            onUpdate={onUpdateMemoryEntry}
            onDeleteEntry={onDeleteMemoryEntry}
            onClear={onClearMemory}
            onCompact={onCompactMemory}
            onLoadTelosOverview={onLoadTelosOverview}
            onSaveTelos={onSaveTelos}
            onReviewBehaviorPattern={onReviewBehaviorPattern}
            onResolveTelosDrift={onResolveTelosDrift}
            onSnoozeTelosDrift={onSnoozeTelosDrift}
            onOpenChatDraft={onOpenChatDraft}
            embeddingModels={settingsDraft.snapshot?.models.embeddingModels ?? []}
            onLoadEmbeddingStatus={onLoadMemoryEmbeddingStatus}
            onDownloadEmbeddingModel={onDownloadMemoryEmbeddingModel}
            onCancelEmbeddingDownload={onCancelMemoryEmbeddingDownload}
            onDeleteEmbeddingModel={onDeleteMemoryEmbeddingModel}
            onRebuildEmbeddingIndex={onRebuildMemoryEmbeddingIndex}
            onCancelEmbeddingRebuild={onCancelMemoryEmbeddingRebuild}
            onTestModelConfiguration={onTestModelConfiguration}
            onNotify={(nextMessage) => notifyForTab("记忆", nextMessage)}
            sessionRunning={runtimeBusy}
          /> : null}
          {tab === "MCP 服务器" ? <McpServersView onError={_onNotify} onSuccess={(nextMessage) => notifyForTab("MCP 服务器", nextMessage)} projectId={workspace?.project.id} /> : null}
          {tab === "技能" ? <SettingsExtensionsView kind="skills" onError={_onNotify} projectId={workspace?.project.id} /> : null}
          {tab === "插件" ? <SettingsExtensionsView kind="plugins" onError={_onNotify} projectId={workspace?.project.id} /> : null}
          {tab === "关于" ? <SettingsAbout version={version} /> : null}
          {tab === "联网搜索" ? <SettingsWebSearch
            onNotify={(nextMessage) => notifyForTab("联网搜索", nextMessage)}
            onOpenExternal={onOpenExternal}
            onLoadCookieJarStatus={onLoadCookieJarStatus}
            onOpenBrowser={onOpenBrowser}
            onExportCookies={onExportCookies}
            onImportCookies={onImportCookies}
            onClearCookies={onClearCookies}
            sessionRunning={runtimeBusy}
          /> : null}
          {settingsToast ? (
            <TopToast
              icon={visibleLoadError ? "warning" : undefined}
              key={settingsToast}
              message={settingsToast}
              onDismiss={() => (visibleLoadError ? setDismissedLoadError(visibleLoadError) : setMessage(undefined))}
            />
          ) : null}
          </main>
        </div>
        <SettingsPageFooter
          dirtyCount={settingsDraft.dirtyCount}
          disabled={settingsDraft.invalid || settingsDraft.draft === undefined || runtimeBusy}
          onCancel={requestCancel}
          onSave={() => { void settingsDraft.saveAll(); }}
          state={settingsDraft.saveState}
        />
      </section>
      {closeGuardOpen ? (
        <SettingsCloseGuard
          busy={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back"}
          onCancel={() => { void cancelClose(); }}
          onDiscard={() => { void discardAndClose(); }}
        />
      ) : null}
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
 * 把尚未提交的模型变更投影到设置页列表。这里不重新运行 ProviderRuntime，也不猜测模型
 * 能力；已存在的条目保留后端返回的能力，新条目只使用表单里明确声明的字段。
 */
function stagedModelChoices(
  saved: ModelChoice[],
  upserts: DesktopModelConfigurationInput[],
  removeAliases: string[]
): ModelChoice[] {
  const choices = new Map(saved.map((model) => [model.alias, model] as const));
  for (const alias of removeAliases) choices.delete(alias);
  for (const input of upserts) {
    const existing = choices.get(input.alias);
    choices.set(input.alias, {
      alias: input.alias,
      displayName: input.displayName,
      provider: input.providerAlias,
      providerType: input.providerType,
      model: input.model,
      modelKey: `${input.providerAlias}\u0000${input.model}`,
      supportsTools: input.supportsTools,
      capabilities: existing?.capabilities ?? {
        tools: input.supportsTools,
        parallelToolCalls: input.parallelToolCalls ?? false,
        reasoning: input.supportsThinking ?? false,
        reasoningStream: input.reasoningStream ?? false,
        reasoningSummary: input.reasoningSummary ?? false,
        vision: input.supportsVision ?? false,
        audio: input.supportsAudio ?? false,
        streaming: true
      },
      contextWindow: input.contextWindow,
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      limits: input.limits,
      efforts: existing?.efforts ?? (input.supportsThinking ? ["low", "medium", "high"] : []),
      defaultThinking: existing?.defaultThinking ?? (input.supportsThinking ? "high" : "off"),
      thinkingLevelMap: input.thinkingLevelMap ?? existing?.thinkingLevelMap ?? {},
      apiBackend: input.apiBackend,
      baseUrl: input.baseUrl,
      compatibility: input.compatibility,
      showInPicker: true,
      available: true,
      source: "configured"
    });
  }
  return [...choices.values()];
}

/**
 * Candidate list for the "启用模型" editor: models already configured first (so
 * the user can always toggle one off), then the provider's live catalog, or the
 * built-in static fallback when the live catalog is empty. A non-empty live
 * catalog is authoritative for the access path's account inventory.
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
  const remainingModels = liveModels.length ? liveModels : catalogModels;
  for (const model of remainingModels) {
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

type ModelCatalogViewSource = DesktopModelCatalogResult["source"] | "static";

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

/**
 * 新增连接时是否需要手填服务地址与模型 ID。内置目录里没有固定 baseUrl 的卡片
 * （自定义兼容接口、Cloudflare）无法自动拉取目录，仍走手填流程；其余都通过
 * 「填密钥 → 加载模型 → 勾选启用」完成。
 */
function isManualEndpoint(provider: ProviderCatalogItem): boolean {
  return provider.id === "openai-compatible" || !provider.baseUrl.trim();
}

function SettingsModels({ active, models, connections: connectionInfos, defaultModelAlias, onChange, onSave, onTest, onRemove, onNotify, onOpenExternal, onFetchCatalog, onFetchCatalogCandidate, onStartLogin, onCompleteLogin, onCancelLogin }: {
  active: boolean;
  models: ModelChoice[];
  connections: DesktopModelConnection[];
  defaultModelAlias?: string;
  onChange(alias: string, thinking: ThinkingSelection): void;
  onSave(configuration: DesktopModelConfigurationInput): Promise<void>;
  onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onRemove(alias: string): Promise<void>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onFetchCatalog(providerAlias: string, force?: boolean): Promise<DesktopModelCatalogResult>;
  onFetchCatalogCandidate(configuration: DesktopModelConfigurationInput): Promise<DesktopModelCatalogResult>;
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
  // 自定义端点的「API 格式」；内置 provider 的格式由目录预设决定，不占用这个状态。
  const [connectApiFormat, setConnectApiFormat] = useState<ApiFormatId>("chat_completions");
  const [showKey, setShowKey] = useState(false);
  const [detailApiKey, setDetailApiKey] = useState("");
  const [detailBaseUrl, setDetailBaseUrl] = useState("");
  const [detailShowKey, setDetailShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 新增连接时用临时密钥拉到的模型候选，以及用户在勾选列表里的选择。
  const [connectModels, setConnectModels] = useState<CatalogModel[]>([]);
  const [connectSelected, setConnectSelected] = useState<string[]>([]);
  const [connectFetching, setConnectFetching] = useState(false);
  const [connectFetchSource, setConnectFetchSource] = useState<ModelCatalogViewSource>();
  const connectGenerationRef = useRef(0);
  const [loginStage, setLoginStage] = useState<"idle" | "opening" | "waiting" | "submitted">("idle");
  const [loginRequest, setLoginRequest] = useState<DesktopModelLoginStartResult>();
  const [loginError, setLoginError] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [liveCatalog, setLiveCatalog] = useState<Record<string, LiveCatalogState>>({});
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  const loginRequestRef = useRef<DesktopModelLoginStartResult | undefined>(undefined);
  const loginProviderRef = useRef<DesktopModelLoginProvider | undefined>(undefined);
  const loginActionRef = useRef(false);
  const loginGenerationRef = useRef(0);
  const onCancelLoginRef = useRef(onCancelLogin);

  useEffect(() => {
    loginRequestRef.current = loginRequest;
  }, [loginRequest]);
  useEffect(() => {
    onCancelLoginRef.current = onCancelLogin;
  }, [onCancelLogin]);
  useEffect(() => {
    if (active) return;
    const request = loginRequestRef.current;
    const provider = loginProviderRef.current;
    loginGenerationRef.current += 1;
    if (request && provider) void onCancelLoginRef.current(provider, request.authRequestId);
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
    setLoginRequest(undefined);
    setLoginStage("idle");
    setLoginError(undefined);
    setAuthorizationCode("");
    setView({ kind: "list" });
  }, [active]);
  useEffect(() => () => {
    const request = loginRequestRef.current;
    const provider = loginProviderRef.current;
    loginGenerationRef.current += 1;
    if (request && provider) void onCancelLoginRef.current(provider, request.authRequestId);
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
  }, []);

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
    setConnectApiFormat(apiFormatForConnection(provider.protocol));
    setShowKey(false);
    setTestResult(undefined);
    setLoginStage("idle");
    setLoginRequest(undefined);
    setLoginError(undefined);
    setAuthorizationCode("");
    setConnectModels([]);
    setConnectSelected([]);
    setConnectFetching(false);
    setConnectFetchSource(undefined);
    connectGenerationRef.current += 1;
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
    loginGenerationRef.current += 1;
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

  const refreshCatalog = async (providerAlias: string, force = false): Promise<void> => {
    setFetchingCatalog(true);
    try {
      const result = await onFetchCatalog(providerAlias, force);
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
    options: { apiKey?: string; baseUrl?: string; modelId?: string; model?: CatalogModel; requireApiKey?: boolean; makeDefault?: boolean } = {}
  ): DesktopModelConfigurationInput | undefined => {
    // 自定义端点（无固定 baseUrl）由用户填服务地址、从实时目录勾选模型；
    // 其余内置服务商都有固定 baseUrl，模型列表从服务商目录勾选。
    const isCustom = isManualEndpoint(provider);
    // 自定义端点的传输格式由用户在表单里选择；内置服务商沿用目录预设的协议。
    const format = isCustom ? apiFormatOption(connectApiFormat) : undefined;
    const modelId = (options.modelId ?? provider.models[0]?.id ?? "").trim();
    if (!modelId) return undefined;
    const apiKey = (options.apiKey ?? connectApiKey).trim();
    if ((options.requireApiKey ?? provider.requiresApiKey) && !apiKey) return undefined;
    const baseUrl = (options.baseUrl ?? (connectBaseUrl.trim() || provider.baseUrl)).trim();
    if (isCustom && !baseUrl) return undefined;
    const providerAlias = providerAliasFor(provider, baseUrl);
    // `model` 传入时（勾选列表里来自远端目录的候选）优先用它的元数据；
    // 手填模型 ID 走内置目录查找，找不到就只带 ID 本身。
    const catalogModel = options.model ?? provider.models.find((item) => item.id === modelId);
    return {
      alias: modelAliasFor(providerAlias, modelId),
      displayName: catalogModel?.displayName ?? modelId,
      providerAlias,
      providerType: provider.value,
      protocol: format?.protocol ?? provider.protocol,
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
      // 目录条目自带的 adapter 覆盖优先（同连接内个别模型可以走不同协议）；
      // 否则用连接表单选择的格式。
      apiBackend: catalogModel?.apiBackend ?? format?.apiBackend,
      makeDefault: options.makeDefault ?? false
    };
  };

  /** 新增连接时用临时密钥向服务商拉取模型目录；失败时回退到内置种子模型。 */
  const loadConnectModels = useCallback(async (provider: ProviderCatalogItem, apiKey: string, manual: boolean): Promise<void> => {
    const generation = connectGenerationRef.current;
    setConnectFetching(true);
    try {
      const isCustom = isManualEndpoint(provider);
      const baseUrl = (isCustom ? connectBaseUrl.trim() : provider.baseUrl).trim();
      if (isCustom && !baseUrl) {
        if (manual) onNotify("请先填写服务地址再加载模型");
        setConnectModels([]);
        setConnectSelected([]);
        setConnectFetchSource(undefined);
        return;
      }
      const providerAlias = providerAliasFor(provider, baseUrl);
      const seed = provider.models[0];
      const format = isCustom ? apiFormatOption(connectApiFormat) : undefined;
      const result = await onFetchCatalogCandidate({
        alias: modelAliasFor(providerAlias, seed?.id ?? "probe"),
        displayName: seed?.displayName ?? seed?.id ?? "probe",
        providerAlias,
        providerType: provider.value,
        protocol: format?.protocol ?? provider.protocol,
        model: seed?.id ?? "probe",
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        requiresApiKey: provider.requiresApiKey,
        supportsTools: true,
        supportsThinking: seed?.supportsThinking,
        apiBackend: format?.apiBackend ?? seed?.apiBackend
      });
      if (generation !== connectGenerationRef.current) return;
      setConnectFetchSource(result.source);
      const loaded = result.models.map(catalogModelFromEntry);
      setConnectModels(loaded);
      // 默认勾选内置种子模型（目录里没有时退到第一个），其余由用户勾选。
      const seedId = seed?.id;
      setConnectSelected([loaded.find((model) => model.id === seedId)?.id ?? loaded[0]?.id].filter((id): id is string => id !== undefined));
      if (manual) onNotify(`已获取 ${String(loaded.length)} 个模型`);
    } catch (error) {
      if (generation !== connectGenerationRef.current) return;
      setConnectFetchSource("static");
      setConnectModels(provider.models);
      // 静态目录只是候选建议。实时目录失败后不代替用户勾选，避免把账号未开放的模型
      // 自动保存为默认模型。
      setConnectSelected([]);
      if (manual) onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === connectGenerationRef.current) setConnectFetching(false);
    }
  }, [connectApiFormat, onFetchCatalogCandidate, onNotify]);

  // 填完密钥（或服务商无需密钥）后自动加载模型列表；密钥变化时防抖重拉。
  useEffect(() => {
    if (view.kind !== "connect") return;
    const provider = view.provider;
    if (provider.connectionMode === "login" || isManualEndpoint(provider)) return;
    const apiKey = connectApiKey.trim();
    if (provider.requiresApiKey && !apiKey) {
      setConnectModels([]);
      setConnectSelected([]);
      setConnectFetchSource(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void loadConnectModels(provider, apiKey, false);
    }, 600);
    return () => clearTimeout(timer);
  }, [view, connectApiKey, loadConnectModels]);

  /** 换格式后旧目录不可信（不同协议的 /models 形状不同），清空候选让用户重新加载。 */
  const changeConnectApiFormat = (id: ApiFormatId): void => {
    setConnectApiFormat(id);
    setConnectModels([]);
    setConnectSelected([]);
    setConnectFetchSource(undefined);
    setTestResult(undefined);
    connectGenerationRef.current += 1;
  };

  const toggleConnectModel = (modelId: string): void => {
    setConnectSelected((current) => (
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]
    ));
  };

  const toggleAllConnectModels = (): void => {
    setConnectSelected((current) => (
      connectModels.length > 0 && current.length === connectModels.length
        ? []
        : connectModels.map((model) => model.id)
    ));
  };

  const connectProvider = async (provider: ProviderCatalogItem): Promise<void> => {
    if (isManualEndpoint(provider)) {
      const baseUrl = connectBaseUrl.trim() || provider.baseUrl;
      const candidates = connectModels.filter((model) => connectSelected.includes(model.id));
      if (!candidates.length) return;
      let makeDefault = true;
      for (const model of candidates) {
        const configuration = buildProviderConfiguration(provider, {
          apiKey: connectApiKey,
          baseUrl,
          modelId: model.id,
          model,
          requireApiKey: provider.requiresApiKey,
          makeDefault
        });
        if (!configuration) continue;
        await saveConfiguration(configuration);
        makeDefault = false;
      }
      setConnectApiKey("");
      setView({ kind: "list" });
      // Pull the provider's real model list right away, so the connection detail
      // opens on the live catalog instead of the single built-in seed model.
      void refreshCatalogQuietly(providerAliasFor(provider, baseUrl));
      return;
    }
    // 内置服务商：按勾选的模型逐个写入草稿，第一个成为默认模型。
    const candidates = connectModels.filter((model) => connectSelected.includes(model.id));
    if (!candidates.length) return;
    let makeDefault = true;
    for (const model of candidates) {
      const configuration = buildProviderConfiguration(provider, {
        apiKey: connectApiKey,
        baseUrl: provider.baseUrl,
        modelId: model.id,
        model,
        requireApiKey: provider.requiresApiKey,
        makeDefault
      });
      if (!configuration) continue;
      await saveConfiguration(configuration);
      makeDefault = false;
    }
    setConnectApiKey("");
    setView({ kind: "list" });
    void refreshCatalogQuietly(providerAliasFor(provider, provider.baseUrl));
  };

  /** Post-connect catalog warm-up: best effort, never toasts. */
  const refreshCatalogQuietly = async (providerAlias: string): Promise<void> => {
    try {
      const result = await onFetchCatalog(providerAlias);
      setLiveCatalog((current) => ({
        ...current,
        [providerAlias]: { models: result.models.map(catalogModelFromEntry), fetchedAt: result.fetchedAt, source: result.source }
      }));
    } catch {
      // Leave the static catalog in place; the user can retry from 高级设置.
    }
  };

  const completeLoginRequest = async (
    provider: ProviderCatalogItem,
    request: DesktopModelLoginStartResult,
    pastedAuthorization?: string
  ): Promise<void> => {
    if (!provider.loginProvider) return;
    const generation = loginGenerationRef.current;
    setLoginStage("submitted");
    setLoginError(undefined);
    try {
      await onCompleteLogin(
        provider.loginProvider,
        request.authRequestId,
        request.method === "paste-code" ? pastedAuthorization : undefined
      );
      if (generation !== loginGenerationRef.current) return;
      onNotify(`连接成功 · ${provider.label}`);
      loginRequestRef.current = undefined;
      loginProviderRef.current = undefined;
      setLoginRequest(undefined);
      setAuthorizationCode("");
      setView({ kind: "list" });
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      // Codex 回调授权是一次性请求，换 token 或读取模型失败后主进程会清理
      // authRequestId；继续保留旧请求只会让下一次点击稳定得到“授权会话不存在”。
      const message = error instanceof Error ? error.message : String(error);
      const canRetryPaste = request.method === "paste-code"
        && (message.includes("授权码格式不正确") || message.includes("state 校验失败"));
      setLoginStage(canRetryPaste ? "waiting" : "idle");
      if (!canRetryPaste) {
        loginRequestRef.current = undefined;
        loginProviderRef.current = undefined;
        setLoginRequest(undefined);
        setAuthorizationCode("");
      }
      setLoginError(message);
    } finally {
      if (generation === loginGenerationRef.current) loginActionRef.current = false;
    }
  };

  const startLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider) return;
    if (loginActionRef.current) return;
    const generation = loginGenerationRef.current;
    loginActionRef.current = true;
    setLoginStage("opening");
    setLoginError(undefined);
    try {
      const request = await onStartLogin(provider.loginProvider);
      if (generation !== loginGenerationRef.current) {
        void onCancelLoginRef.current(provider.loginProvider, request.authRequestId);
        return;
      }
      loginProviderRef.current = provider.loginProvider;
      loginRequestRef.current = request;
      setLoginRequest(request);
      if (request.method === "browser-callback") {
        // Codex 的本地回调由主进程等待；回调到达后自动换 token 和验证模型，
        // 用户不需要再猜测是否应该点击“完成登录”。
        void completeLoginRequest(provider, request);
      } else {
        setLoginStage("waiting");
      }
    } catch (error) {
      loginActionRef.current = false;
      setLoginStage("idle");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider || !loginRequest) return;
    await completeLoginRequest(provider, loginRequest, authorizationCode);
  };

  const cancelLogin = (provider: ProviderCatalogItem): void => {
    loginGenerationRef.current += 1;
    if (provider.loginProvider && loginRequestRef.current) void onCancelLogin(provider.loginProvider, loginRequestRef.current.authRequestId);
    loginRequestRef.current = undefined;
    loginProviderRef.current = undefined;
    loginActionRef.current = false;
    setLoginRequest(undefined);
    setLoginStage("idle");
    setLoginError(undefined);
    setAuthorizationCode("");
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
  const detailDefaultAlias = defaultModelAlias;
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

  /** 切换连接的 API 格式：协议与适配器写在每个模型上，所以要把整组模型一起改写。 */
  const saveApiFormat = async (id: ApiFormatId): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    const format = apiFormatOption(id);
    setSaving(true);
    try {
      for (const model of detailGroup.models) {
        await saveConfiguration({
          alias: model.alias,
          displayName: model.displayName,
          providerAlias: detailGroup.provider,
          providerType: detailCatalog.value,
          protocol: format.protocol,
          model: model.model,
          baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
          apiKey: undefined,
          apiKeyEnv: undefined,
          supportsTools: model.supportsTools !== false,
          supportsThinking: model.efforts.length > 0,
          parallelToolCalls: model.capabilities?.parallelToolCalls,
          reasoningStream: model.capabilities?.reasoningStream,
          reasoningSummary: model.capabilities?.reasoningSummary,
          supportsVision: model.capabilities?.vision,
          supportsAudio: model.capabilities?.audio,
          contextWindow: model.contextWindow,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens,
          limits: model.limits,
          thinkingLevelMap: model.thinkingLevelMap,
          apiBackend: format.apiBackend
        });
      }
      onNotify(`API 格式已切换为 ${format.label}，保存后生效`);
    } finally {
      setSaving(false);
    }
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
  // 连接级字段优先（新连接两处都写），老配置从当前模型的 apiBackend 折回。
  const detailApiFormat = apiFormatForConnection(
    detailConnection?.protocol ?? detailCatalog?.protocol,
    detailConnection?.apiBackend ?? detailActive?.apiBackend
  );
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
      <section className="connection-section" id="models-connections" tabIndex={-1}>
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
              const isDefault = connection.models.some((model) => model.alias === defaultModelAlias);
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
      {view.kind === "connect" ? (
        <SettingsDetailLayer onClose={() => {
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
              apiFormat={connectApiFormat}
              showKey={showKey}
              saving={saving}
              testing={testing}
              testResult={testResult}
              models={connectModels}
              selected={connectSelected}
              fetching={connectFetching}
              fetchSource={connectFetchSource}
              isCustom={isManualEndpoint(view.provider)}
              onApiKey={(value) => { setConnectApiKey(value); setTestResult(undefined); }}
              onBaseUrl={(value) => { setConnectBaseUrl(value); setTestResult(undefined); }}
              onApiFormat={changeConnectApiFormat}
              onToggleKey={() => setShowKey((value) => !value)}
              onLoadModels={() => void loadConnectModels(view.provider, connectApiKey, true)}
              onSelectAll={toggleAllConnectModels}
              onToggleModel={toggleConnectModel}
              onCancel={() => setView({ kind: "list" })}
              onTest={() => {
                const configuration = isManualEndpoint(view.provider)
                  ? buildProviderConfiguration(view.provider, {
                      apiKey: connectApiKey,
                      baseUrl: connectBaseUrl.trim() || view.provider.baseUrl,
                      modelId: connectSelected[0] ?? view.provider.models[0]?.id,
                      model: connectModels.find((model) => model.id === (connectSelected[0] ?? view.provider.models[0]?.id)),
                      requireApiKey: view.provider.requiresApiKey
                    })
                  : buildProviderConfiguration(view.provider, {
                      apiKey: connectApiKey,
                      baseUrl: view.provider.baseUrl,
                      modelId: connectSelected[0] ?? view.provider.models[0]?.id,
                      model: connectModels.find((model) => model.id === (connectSelected[0] ?? view.provider.models[0]?.id)),
                      requireApiKey: view.provider.requiresApiKey
                    });
                void testProvider(configuration);
              }}
              onSubmit={() => void connectProvider(view.provider)}
              onOpenExternal={onOpenExternal}
            />
          )}
        </SettingsDetailLayer>
      ) : null}
      {detailGroup && detailCatalog ? (
        <SettingsDetailLayer onClose={() => setView({ kind: "list" })}>
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
            apiFormat={detailApiFormat}
            onSaveApiFormat={(id) => void saveApiFormat(id)}
            onEnableModel={(model) => void enableModel(model)}
            onDisableModel={(alias) => void disableModel(alias)}
            onDeleteConnection={() => void deleteConnection()}
            canDeleteConnection={models.length > detailGroup.models.length}
            onRefreshCatalog={() => void refreshCatalog(detailGroup.provider, true)}
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
        </SettingsDetailLayer>
      ) : null}
    </>
  );
}

type ConnectionGroup = ReturnType<typeof connectionLabel>[number];

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
        {!waiting ? <p>使用订阅配额前需要先通过官方 OAuth 登录。</p> : <p>{usesPasteCode ? "请在浏览器完成登录后粘贴授权码。" : isCodex ? (stage === "submitted" ? "已收到浏览器回调，正在自动验证账号。" : "请在弹出的浏览器窗口完成登录，浏览器会自动返回此应用。") : "正在准备登录。"}</p>}
        {!waiting ? (
          <button className="login-primary-button" onClick={onStart} type="button">登录订阅</button>
        ) : !usesPasteCode ? (
          <button className="login-primary-button" disabled type="button">{stage === "submitted" ? "正在验证..." : "等待登录..."}</button>
        ) : (
          <button className="login-primary-button" disabled type="button">登录中...</button>
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
  apiFormat,
  onSaveApiFormat,
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
  apiFormat: ApiFormatId;
  onSaveApiFormat(id: ApiFormatId): void;
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
  // 格式选择是草稿制：select 立刻暂存整组模型的协议改写，但真正生效要等设置保存提交，
  // 所以本地留一份显示值，避免选择后被已保存的旧值弹回。
  const [formatDraft, setFormatDraft] = useState<ApiFormatId>(apiFormat);
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
            <small>{isDefaultConnection ? "默认连接" : "已连接"} · {apiFormatOption(formatDraft).label}</small>
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
                const hint = modelCapabilityHint(catalogModel);
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
                      {hint ? <span className="model-capability-hint">{hint}</span> : null}
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

          {!usesOAuth ? (
            <div className="connection-field">
              <div className="connection-field-label">
                <span>API 格式</span>
                <small>{apiFormatOption(formatDraft).description} · 切换后对该连接全部模型生效，保存后应用</small>
              </div>
              <select
                className="connection-select"
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value as ApiFormatId;
                  setFormatDraft(id);
                  onSaveApiFormat(id);
                }}
                value={formatDraft}
              >
                {apiFormatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
          ) : null}
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
 * `isCustom` 指自建/中转端点：这类没有内置默认值，需要自己填 base URL，
 * 再从实时模型目录勾选启用（不再要求手填模型 ID）。
 */
function ConnectProviderDialog({
  provider,
  apiKey,
  baseUrl,
  apiFormat,
  showKey,
  saving,
  testing,
  testResult,
  models,
  selected,
  fetching,
  fetchSource,
  isCustom,
  onApiKey,
  onBaseUrl,
  onApiFormat,
  onToggleKey,
  onLoadModels,
  onSelectAll,
  onToggleModel,
  onCancel,
  onTest,
  onSubmit,
  onOpenExternal
}: {
  provider: ProviderCatalogItem;
  apiKey: string;
  baseUrl: string;
  apiFormat: ApiFormatId;
  showKey: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  models: CatalogModel[];
  selected: string[];
  fetching: boolean;
  fetchSource?: ModelCatalogViewSource;
  isCustom: boolean;
  onApiKey(value: string): void;
  onBaseUrl(value: string): void;
  onApiFormat(id: ApiFormatId): void;
  onToggleKey(): void;
  onLoadModels(): void;
  onSelectAll(): void;
  onToggleModel(modelId: string): void;
  onCancel(): void;
  onTest(): void;
  onSubmit(): void;
  onOpenExternal(url: string): Promise<void>;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const keyMissing = provider.requiresApiKey && !apiKey.trim();
  const canSubmit = !saving && !testing && !keyMissing && !fetching && selected.length > 0 && (isCustom ? Boolean(baseUrl.trim()) : true);
  const canTest = !saving && !testing && !keyMissing && (isCustom ? (selected.length > 0 || provider.models.length > 0) && Boolean(baseUrl.trim()) : selected.length > 0 || provider.models.length > 0);
  const apiKeyUrl = provider.apiKeyUrl;
  const filteredModels = models.filter((model) => !modelQuery.trim()
    || `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()));
  const allSelected = models.length > 0 && selected.length === models.length;
  const modelHint = fetching
    ? "正在从服务商加载模型…"
    : models.length > 0
      ? `已选 ${String(selected.length)} / ${String(models.length)} · ${fetchSource === "fetched" ? "已从服务商获取" : "内置候选，需手动选择；可点击“加载模型”刷新"}`
      : keyMissing
        ? isCustom
          ? "填写 API Key 和服务地址后，可点击“加载模型”获取支持列表"
          : "填写密钥后自动加载支持列表"
        : "点击“加载模型”从服务商获取支持列表";
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
          <div className="connection-field">
            <div className="connection-field-label"><span>服务地址</span></div>
            <input onChange={(event) => onBaseUrl(event.target.value)} placeholder={apiFormatOption(apiFormat).baseUrlPlaceholder} value={baseUrl} />
          </div>
        ) : null}
        {isCustom ? (
          <div className="connection-field">
            <div className="connection-field-label">
              <span>API 格式</span>
              <small>{apiFormatOption(apiFormat).description}</small>
            </div>
            <select
              className="connection-select"
              onChange={(event) => onApiFormat(event.target.value as ApiFormatId)}
              value={apiFormat}
            >
              {apiFormatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        ) : null}
        <div className="connection-field">
          <div className="connection-field-label">
            <span>启用模型</span>
            <small>{modelHint}</small>
          </div>
            <div className="connect-model-toolbar">
              <label className="model-search-input">
                <Icon name="search" size={13} />
                <input onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" value={modelQuery} />
              </label>
              <button className="ghost-button connect-select-all-button" disabled={fetching || !models.length || saving || testing} onClick={onSelectAll} type="button">
                {allSelected ? "取消全选" : "全选"}
              </button>
              <button className="ghost-button connect-load-button" disabled={fetching || keyMissing} onClick={onLoadModels} type="button">
                <Icon name="refresh" size={13} />
                {fetching ? "加载中…" : "加载模型"}
              </button>
            </div>
            <div className="enabled-model-list" role="group" aria-label="选择要启用的模型">
              {filteredModels.map((model) => {
                const checked = selected.includes(model.id);
                const hint = modelCapabilityHint(model);
                return (
                  <div className={`enabled-model-row${checked ? " is-enabled" : ""}`} key={model.id}>
                    <button
                      aria-checked={checked}
                      className="enabled-model-toggle"
                      disabled={saving || testing}
                      onClick={() => onToggleModel(model.id)}
                      role="checkbox"
                      type="button"
                    >
                      <span className={`check-dot${checked ? " is-on" : ""}`}><Icon name="check" size={11} /></span>
                      <span className="enabled-model-name">{model.displayName}</span>
                      {model.id !== model.displayName ? <span className="enabled-model-id">{model.id}</span> : null}
                      {hint ? <span className="model-capability-hint">{hint}</span> : null}
                    </button>
                  </div>
                );
              })}
              {!filteredModels.length ? <div className="model-list-empty">{models.length ? "没有匹配的模型" : fetching ? "正在加载模型…" : "尚未加载模型列表"}</div> : null}
            </div>
          </div>
        {testResult ? <ConnectionTestResult result={testResult} /> : null}
        <div className="connect-dialog-actions">
          <button onClick={onCancel} type="button">取消</button>
          <button disabled={!canTest} onClick={onTest} type="button">{testing ? "测试中…" : "测试连接"}</button>
          <button
            className="is-primary"
            disabled={!canSubmit}
            onClick={onSubmit}
            type="button"
          >
            连接并使用
          </button>
        </div>
    </div>
  );
}

/** 勾选列表里的一行能力提示：思考深度与上下文窗口。 */
function modelCapabilityHint(model: CatalogModel): string | undefined {
  const parts: string[] = [];
  const thinkingLevels = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([level, native]) => level !== "off" && native !== null)
    .map(([level]) => level);
  if (thinkingLevels.length) parts.push(thinkingLevels.join("/"));
  else if (model.supportsThinking) parts.push("思考");
  if (model.contextWindow) parts.push(formatContextWindow(model.contextWindow));
  return parts.length ? parts.join(" · ") : undefined;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
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
function SettingsWebSearch({ onNotify, onOpenExternal, onLoadCookieJarStatus, onOpenBrowser, onExportCookies, onImportCookies, onClearCookies, sessionRunning }: {
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  sessionRunning: boolean;
}): React.JSX.Element {
  const { draft, setWebSearch, snapshot } = useSettingsDraft();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [cookieJar, setCookieJar] = useState<DesktopCookieJarStatus>();
  const [cookieLoadError, setCookieLoadError] = useState<string>();
  const [cookieBusy, setCookieBusy] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("https://www.google.com/");

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

  const settings = snapshot?.webSearch;
  const webSearch = draft?.webSearch;
  if (!settings || !webSearch) return <div className="settings-sections"><section><p>正在加载设置…</p></section></div>;

  const option = webSearchProviderOptions.find((candidate) => candidate.value === webSearch.provider);
  const requiresKey = webSearch.provider === "tavily" || webSearch.provider === "brave";
  const sameProviderSaved = settings.provider === webSearch.provider;
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

  const refreshCookieJar = async (): Promise<void> => {
    const next = await onLoadCookieJarStatus();
    setCookieJar(next);
    setCookieLoadError(undefined);
  };

  const runCookieOperation = async (operation: () => Promise<DesktopCookieJarStatus>, success: string): Promise<void> => {
    if (cookieBusy || sessionRunning) return;
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
    if (cookieBusy || sessionRunning) return;
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
      <section id="web-search-provider" tabIndex={-1}>
        <h3>联网搜索</h3>
        <SettingsCheckbox checked={webSearch.enabled} detail="关闭后 Agent 将无法搜索公网信息" label="启用 web_search 工具" onChange={(enabled) => setWebSearch({ ...webSearch, enabled })} />
      </section>
      <section>
        <h3>搜索服务</h3>
        <div role="radiogroup" aria-label="搜索服务">
          {webSearchProviderOptions.map((candidate) => (
            <button aria-checked={webSearch.provider === candidate.value} className="permission-setting-row" key={candidate.value} onClick={() => { setWebSearch({ ...webSearch, provider: candidate.value, apiKey: undefined, apiKeyHandle: undefined }); setApiKeyInput(""); setClearKey(false); }} role="radio" type="button">
              <span className={`radio${webSearch.provider === candidate.value ? " is-selected" : ""}`} />
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
              onChange={(event) => { setApiKeyInput(event.target.value); setWebSearch({ ...webSearch, apiKey: event.target.value || undefined, apiKeyHandle: undefined }); }}
              placeholder={requiresKey ? `${option?.title ?? ""} API Key` : "可选，用于提升 AnySearch 额度"}
              spellCheck={false}
              type="password"
              value={clearKey ? "" : apiKeyInput}
            />
            {sameProviderSaved && settings.hasApiKey ? (
              <button className="ghost-button" onClick={() => { const next = !clearKey; setClearKey(next); setApiKeyInput(""); setWebSearch({ ...webSearch, apiKey: next ? "" : undefined, apiKeyHandle: undefined }); }} type="button">{clearKey ? "取消清除" : "清除密钥"}</button>
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
          <select className="web-search-select" onChange={(event) => setWebSearch({ ...webSearch, maxResults: Number(event.target.value) })} value={webSearch.maxResults}>
            {[...new Set([3, 5, 8, 10, webSearch.maxResults])].sort((a, b) => a - b).map((count) => <option key={count} value={count}>{count} 条</option>)}
          </select>
        </div>
        <div className="setting-row">
          <span><strong>请求超时</strong><small>超过该时间未响应则终止本次搜索</small></span>
          <select className="web-search-select" onChange={(event) => setWebSearch({ ...webSearch, timeoutMs: Number(event.target.value) })} value={webSearch.timeoutMs}>
            {[...new Set([5_000, 10_000, 20_000, 30_000, webSearch.timeoutMs])].sort((a, b) => a - b).map((duration) => <option key={duration} value={duration}>{duration / 1_000} 秒</option>)}
          </select>
        </div>
      </section>
      <section id="web-search-cookies" tabIndex={-1}>
        <h3>浏览器与 Cookie</h3>
        <div className="setting-row">
          <span><strong>Google 设置</strong><small>在内嵌浏览器里完成同意、验证或登录，Google 搜索会自动带上对应 Cookie</small></span>
          <button className="ghost-button" disabled={cookieBusy || sessionRunning} onClick={() => void openEmbeddedBrowser("https://www.google.com/")} type="button">打开 Google</button>
        </div>
        <div className="setting-row">
          <span><strong>Cookie 状态</strong><small>{cookieSummary}{cookieUpdatedAt ? ` · ${cookieUpdatedAt}` : ""}</small></span>
          <button className="ghost-button" disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onLoadCookieJarStatus, "Cookie 状态已刷新")} type="button">刷新</button>
        </div>
        {cookieJar?.domains.length ? (
          <div aria-label="已登录站点" className="cookie-domain-list">
            {cookieJar.domains.map(({ domain, count }) => <span className="cookie-domain" key={domain}>{domain}<small>{count}</small></span>)}
          </div>
        ) : null}
        {cookieLoadError ? <p className="web-search-key-status">无法读取 Cookie：{cookieLoadError}</p> : null}
        <div className="settings-button-row">
          <button disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onImportCookies, "Cookie 已导入并同步给 Agent")} type="button">导入 Cookie</button>
          <button disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onExportCookies, "Cookie 已导出")} type="button">导出 Cookie</button>
          <button className="ghost-button is-danger" disabled={cookieBusy || sessionRunning || !cookieJar?.total} onClick={() => void runCookieOperation(onClearCookies, "全部 Cookie 已清除")} type="button">清除全部</button>
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
          <button disabled={cookieBusy || sessionRunning || !browserUrl.trim()} onClick={() => void openEmbeddedBrowser(browserUrl.trim())} type="button">打开浏览器</button>
        </div>
      </section>
      {sessionRunning ? <p className="settings-effective-hint is-blocked">当前任务运行中：可以编辑草稿，Cookie 和浏览器操作将在任务结束后可用。</p> : null}
    </div>
  );
}
