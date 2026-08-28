/**
 * 桌面端 IPC 协议。
 *
 * 主进程和渲染进程之间唯一的契约：`desktopIpc` 是通道名常量表，`DesktopApi` 是渲染层可调用
 * 的方法集合，其余是两端共享的数据形状。三处必须同步改动——这里加方法、preload 里加转发、
 * ipc.ts 里加 handler，少一处就是运行时报错。
 *
 * 通道名统一用 `desktop:<领域>:<动作>` 的形式，便于排查。
 */
import type { InteractiveAgentRunMode } from "../agent/AgentSession.js";
import type { ActivitySettings, ActivitySettingsInput } from "../activity/settings.js";
import type { ActivityRuntimeSnapshot } from "../activity/types.js";
import type { ActivityReportResult } from "../activity/analyzer.js";
import type { ActivitySearchResult } from "../activity/store.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import type { ChatParamsConfig, CompactionConfig, ModelApiBackend, ModelCompatibility, ModelLimits, ModelProvider, ThinkingLevelMap, WebSearchConfig } from "../config/schema.js";
import type { EmbeddingModelDescriptor } from "../llm/embedding/types.js";
import type { LocalEmbeddingModelId } from "../llm/embedding/types.js";
import type { MemoryEmbeddingRuntimeStatus } from "../agent/context/MemoryEmbeddingService.js";
import type { MemoryMaintenanceStatus } from "../agent/context/memoryTypes.js";
import type {
  IdentityDocumentKind,
  IdentityOverview,
  IdentityProposal,
  IdentityReviewResult
} from "../agent/context/identityTypes.js";
import type { AlmaImportScanResult } from "../agent/context/almaImport.js";
import type { IdentityPolicy } from "../config/schema.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { MemoryPolicy } from "../personalization/index.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../runtime/agentEvents.js";
import { slashCommandsForSurface, type SlashCommandDefinition } from "../runtime/commandRegistry.js";
import type { SessionBranchPoint } from "../session/catalog.js";
import type { SessionEvent } from "../session/recorder.js";
import type { SessionRunStatus } from "../session/runLedger.js";
import type {
  BehaviorPattern,
  BehaviorPatternReviewAction,
  TelosEvidence,
  TelosDocument,
  TelosDocumentInput,
  TelosDrift,
  TelosDriftResolutionAction,
  TelosOverview,
  TelosScope
} from "../agent/context/telosTypes.js";

export type DesktopActivitySettings = ActivitySettings;
export type DesktopActivitySettingsInput = ActivitySettingsInput;
export type DesktopIdentitySettings = IdentityPolicy;
export type DesktopIdentityDocumentKind = IdentityDocumentKind;
export type DesktopIdentityOverview = IdentityOverview;
export type DesktopAlmaImportScan = AlmaImportScanResult;
export type DesktopIdentityProposal = IdentityProposal;
export type DesktopIdentityReviewResult = IdentityReviewResult;

/** 指定日期的 Activity 打工日记；markdown 可直接渲染，blocked/message 说明补分析为何被跳过。 */
export type DesktopActivityReport = ActivityReportResult;

export const desktopIpc = {
  bootstrap: "desktop:bootstrap",
  openProject: "desktop:project:open",
  createEmptyProject: "desktop:project:create-empty",
  selectProject: "desktop:project:select",
  commitSelection: "desktop:selection:commit",
  setActiveView: "desktop:ui:active-view",
  setProjectPinned: "desktop:project:pin",
  reorderProjects: "desktop:project:reorder",
  renameProject: "desktop:project:rename",
  removeProject: "desktop:project:remove",
  refreshProject: "desktop:project:refresh",
  listProjectBranches: "desktop:project:branches",
  switchProjectBranch: "desktop:project:branch:switch",
  createProjectBranch: "desktop:project:branch:create",
  revealProject: "desktop:project:reveal",
  openProjectTerminal: "desktop:project:terminal",
  startDraft: "desktop:session:draft",
  openSession: "desktop:session:open",
  sessionHandoff: "desktop:session:handoff",
  listSessionTreePage: "desktop:session:tree-page",
  renameSession: "desktop:session:rename",
  pinSession: "desktop:session:pin",
  archiveSession: "desktop:session:archive",
  markSessionRead: "desktop:session:mark-read",
  duplicateSession: "desktop:session:duplicate",
  deleteSession: "desktop:session:delete",
  exportSession: "desktop:session:export",
  importSession: "desktop:session:import",
  sessionMenu: "desktop:session:menu",
  sendPrompt: "desktop:agent:send",
  resumeInterruptedTurn: "desktop:agent:resume-interrupted",
  editPrompt: "desktop:agent:edit",
  cancelRun: "desktop:agent:cancel",
  runSlashCommand: "desktop:agent:slash",
  resolvePermission: "desktop:permission:resolve",
  setPermissionMode: "desktop:permission:mode",
  switchModel: "desktop:model:switch",
  testModelConfiguration: "desktop:model:test-configuration",
  fetchModelCatalog: "desktop:model:fetch-catalog",
  fetchModelCatalogCandidate: "desktop:model:fetch-catalog-candidate",
  startModelLogin: "desktop:model:login:start",
  cancelModelLogin: "desktop:model:login:cancel",
  compact: "desktop:agent:compact",
  runtimeProjection: "desktop:runtime:projection",
  runtimeMutation: "desktop:runtime:mutation",
  runtimeEvents: "desktop:runtime:events",
  openBrowser: "desktop:browser:open",
  cookieJarStatus: "desktop:browser:cookies:status",
  exportCookies: "desktop:browser:cookies:export",
  importCookies: "desktop:browser:cookies:import",
  clearCookies: "desktop:browser:cookies:clear",
  personalizationOverview: "desktop:personalization:overview",
  savePersonalizationSettings: "desktop:personalization:save",
  saveChatPersonalization: "desktop:personalization:save-chat",
  memoryOverview: "desktop:memory:overview",
  memoryStats: "desktop:memory:stats",
  memoryEntries: "desktop:memory:entries",
  saveMemorySettings: "desktop:memory:save-settings",
  identityOverview: "desktop:identity:overview",
  importAlmaIdentity: "desktop:identity:import-alma",
  saveIdentityDocument: "desktop:identity:save-document",
  reviewIdentityProposal: "desktop:identity:review-proposal",
  settingsSnapshot: "desktop:settings:snapshot",
  saveSettings: "desktop:settings:save",
  stageSettingsCredential: "desktop:settings:credential:stage",
  completeModelLoginForSettings: "desktop:settings:model-login:complete",
  releaseSettingsCredentials: "desktop:settings:credential:release",
  settingsDraftState: "desktop:settings:draft-state",
  settingsCloseRequest: "desktop:settings:close-request",
  settingsCloseResponse: "desktop:settings:close-response",
  activitySnapshot: "desktop:activity:snapshot",
  activityRequestPermission: "desktop:activity:request-permission",
  activitySearch: "desktop:activity:search",
  activityReport: "desktop:activity:report",
  activityClear: "desktop:activity:clear",
  activityEvent: "desktop:activity:event",
  searchMemory: "desktop:memory:search",
  addMemoryEntry: "desktop:memory:add",
  updateMemoryEntry: "desktop:memory:update",
  deleteMemoryEntry: "desktop:memory:delete-entry",
  clearMemory: "desktop:memory:clear",
  compactMemory: "desktop:memory:compact",
  memoryEmbeddingStatus: "desktop:memory:embedding-status",
  downloadMemoryEmbeddingModel: "desktop:memory:embedding-download",
  cancelMemoryEmbeddingDownload: "desktop:memory:embedding-cancel-download",
  deleteMemoryEmbeddingModel: "desktop:memory:embedding-delete",
  rebuildMemoryEmbeddingIndex: "desktop:memory:embedding-rebuild",
  cancelMemoryEmbeddingRebuild: "desktop:memory:embedding-cancel-rebuild",
  telosOverview: "desktop:telos:overview",
  saveTelos: "desktop:telos:save",
  reviewBehaviorPattern: "desktop:telos:review-pattern",
  resolveTelosDrift: "desktop:telos:resolve-drift",
  snoozeTelosDrift: "desktop:telos:snooze-drift",
  saveAttachment: "desktop:attachment:save",
  resolveDroppedFile: "desktop:attachment:resolve-path",
  listWorkspaceDirectory: "desktop:file:list-directory",
  readWorkspaceFile: "desktop:file:read",
  readInlineImage: "desktop:file:read-image",
  openWorkspaceFile: "desktop:file:open",
  openExternal: "desktop:external:open",
  openSystemSettings: "desktop:system-settings:open",
  setSidebarWidth: "desktop:ui:sidebar-width",
  setFilePanelWidth: "desktop:ui:file-panel-width",
  setThemePreference: "desktop:ui:theme",
  setFontPreference: "desktop:ui:font",
  createTerminal: "desktop:terminal:create",
  writeTerminal: "desktop:terminal:write",
  resizeTerminal: "desktop:terminal:resize",
  disposeTerminal: "desktop:terminal:dispose",
  terminalEvent: "desktop:terminal:event",
  event: "desktop:agent:event",
  menuAction: "desktop:menu:action",
  skillCatalog: "desktop:skill:catalog",
  skillExpand: "desktop:skill:expand",
  skillSourceImport: "desktop:skill:source-import",
  skillSourceInstall: "desktop:skill:source-install",
  skillImportExisting: "desktop:skill:import-existing",
  skillDiscoverySnapshot: "desktop:skill:discovery",
  skillDiscoverySearch: "desktop:skill:discovery-search",
  skillDiscoveryInstall: "desktop:skill:discovery-install",
  skillRepositoryAdd: "desktop:skill:repository-add",
  skillRepositoryRemove: "desktop:skill:repository-remove",
  skillFileRead: "desktop:skill:file-read",
  skillFileWrite: "desktop:skill:file-write",
  skillOpenDirectory: "desktop:skill:open-directory",
  skillSettings: "desktop:skill:settings",
  skillDrafts: "desktop:skill:drafts",
  skillDraftApprove: "desktop:skill:draft-approve",
  skillDraftReject: "desktop:skill:draft-reject",
  skillDraftRetry: "desktop:skill:draft-retry",
  skillDraftEdit: "desktop:skill:draft-edit",
  pluginRegistry: "desktop:plugin:registry",
  pluginRegistryRefresh: "desktop:plugin:registry-refresh",
  pluginInstall: "desktop:plugin:install",
  pluginSetEnabled: "desktop:plugin:set-enabled",
  pluginUninstall: "desktop:plugin:uninstall",
  pluginOpenDirectory: "desktop:plugin:open-directory",
  mcpSnapshot: "desktop:mcp:snapshot",
  mcpCatalog: "desktop:mcp:catalog",
  mcpRefreshCatalog: "desktop:mcp:catalog-refresh",
  mcpUpsertServer: "desktop:mcp:server-upsert",
  mcpSetEnabled: "desktop:mcp:server-enabled",
  mcpDeleteServer: "desktop:mcp:server-delete",
  mcpTestServer: "desktop:mcp:server-test",
  mcpReconnect: "desktop:mcp:server-reconnect",
  mcpDetails: "desktop:mcp:server-details"
} as const;

export type DesktopThemePreference = "system" | "light" | "dark";
export type DesktopSystemSettingsPane = "screen-recording" | "accessibility" | "input-monitoring";
export type DesktopActiveView = "chat" | "runtime" | "extensions";

/** 界面字体偏好。`family` 为 CSS 字体族名，"system" 表示跟随操作系统；`size` 为基准字号（px）。 */
export interface DesktopFontPreference {
  family: string;
  size: number;
}
export type DesktopSessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "completed"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "aborted"
  | "failed";

/** 侧栏里的一个项目。`missing` 表示目录已不存在但记录仍保留，界面上标灰而不是直接消失。 */
export interface DesktopProject {
  id: string;
  path: string;
  name: string;
  branch?: string;
  dirty: boolean;
  missing: boolean;
  pinned: boolean;
  addedAt: string;
  lastOpenedAt: string;
}

/** 项目目录中实际存在的本地 refs/heads 分支；不包含远程跟踪分支。 */
export interface DesktopGitBranch {
  name: string;
  current: boolean;
}

export interface DesktopSessionSummary {
  id: string;
  projectId: string;
  fileName: string;
  title: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  status: DesktopSessionStatus;
  resumable?: boolean;
  /** 分支关系来自 session catalog；旧会话没有 parent 时视为根会话。 */
  rootSessionId?: string;
  parentSessionId?: string;
  branchPoint?: SessionBranchPoint;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  metadataRevision?: string;
  personalization?: DesktopChatPersonalizationOverride;
  hasChildren?: boolean;
  /** 最近一次运行来自 run ledger；live runtime 仍优先于这个历史投影。 */
  latestRun?: DesktopSessionRunSummary;
}

export interface DesktopSessionRunSummary {
  runId: string;
  status: SessionRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  durationMs?: number;
  stopReason?: string;
  resumable?: boolean;
}

/**
 * 打开一个会话时返回的完整内容。
 * `events` 是已落盘的历史事件，`liveEvents` 是当前这轮还在进行中的实时事件，
 * 渲染层需要把两段拼起来展示（历史在前、实时在后）。
 */
export interface DesktopSessionDocument {
  session: DesktopSessionSummary;
  events: SessionEvent[];
  liveEvents: AgentHostEvent[];
  /** 会话体量接近持久化上限时给出预警信息；未接近时缺省。 */
  limits?: DesktopSessionLimits;
  /** session 仍可读，但当前 Desktop 没有 writer ownership 时的只读冲突。 */
  writerConflict?: DesktopSessionWriterConflict;
}

/** 会话文件体量与事件数接近上限时的预警投影。 */
export interface DesktopSessionLimits {
  nearSizeLimit: boolean;
  sizeBytes: number;
  eventCount: number;
  maxSizeBytes: number;
  maxEvents: number;
}

export interface DesktopSessionWriterConflict {
  sessionId: string;
  ownerSurface?: "desktop" | "tui" | "cli";
}

/** TUI 通过 `/app` 显式交给 Desktop 打开的项目会话。 */
export interface DesktopSessionHandoff {
  projectId: string;
  sessionId: string;
}

export interface DesktopSessionTreePageOptions {
  parentSessionId?: string;
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface DesktopSessionTreePage {
  projectId: string;
  parentSessionId?: string;
  revision: string;
  sessions: DesktopSessionSummary[];
  nextCursor?: string;
  revisionChanged?: boolean;
}

export interface DesktopWorkspaceSnapshot {
  project: DesktopProject;
  sessions: DesktopSessionSummary[];
  /** 侧栏首屏只包含根节点；子节点通过 listSessionTreePage 按需加载。 */
  sessionPage?: DesktopSessionTreePage;
  selectedSessionId?: string;
  runtime?: InteractiveRuntimeSnapshot;
  /** 并行会话的运行时快照（sessionId → snapshot，含主 runtime 绑定的 session）；多 session 并行时渲染层按 session 取运行态。 */
  sessionRuntimes?: Record<string, InteractiveRuntimeSnapshot>;
  runtimeError?: string;
  /** 跨 Desktop/TUI 共享的已保存权限模式；Runtime 启动时会先与这个持久化值对齐。 */
  permissionMode: PermissionMode;
  requiresModelConfiguration: boolean;
  /** 普通 Composer 选择器使用的已启用且当前可用模型；设置页的 `models` 仍表示已保存模型。 */
  pickerModels: ModelChoice[];
  models: ModelChoice[];
  connections: DesktopModelConnection[];
  runtimeProjection?: DesktopRuntimeProjection;
}

/** 渲染进程启动时一次性取回的初始状态，之后的变化都通过事件推送。 */
export interface DesktopBootstrap {
  version: string;
  platform: NodeJS.Platform;
  projects: DesktopProject[];
  /** 所有项目的任务摘要，供侧栏和全局搜索按项目分组展示。 */
  sidebarSessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
  activeView: DesktopActiveView;
  workspace?: DesktopWorkspaceSnapshot;
  sidebarWidth: number;
  filePanelWidth: number;
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
}

/** 发送提示或排队运行中消息后的回执。 */
export interface DesktopRunReceipt {
  sessionId: string;
  runId: string;
  messageId: string;
}

/** 事件推送信封。带上 projectId 是因为所有项目共用同一条事件通道，渲染层要自己过滤。 */
export interface DesktopAgentEventEnvelope extends AgentRuntimeUpdate {
  projectId: string;
  /** 产生事件的 runtime 当前绑定的 session；一个项目可能有多个并行 runtime。 */
  sessionId?: string;
  /** 主 runtime 发出的事件为 true；会话池里的并行 runtime 为 false。 */
  primary?: boolean;
}

export interface DesktopAttachment {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface DesktopWorkspaceFilePreview {
  path: string;
  content?: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}

export interface DesktopWorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface DesktopWorkspaceDirectory {
  path: string;
  entries: DesktopWorkspaceDirectoryEntry[];
}

export type DesktopSkillScope = "global" | "project";
export type DesktopSkillEngine = "biny" | "codex" | "claude" | "pi";
export type DesktopSkillSource = "biny" | "agents";

export interface DesktopSkillDiagnostic {
  kind: "unsupported_root" | "unsupported_symlink" | "scan_failed" | "invalid_metadata" | "duplicate_id";
  message: string;
  path?: string;
  ref?: string;
  shadowedBy?: string;
}

export interface DesktopManagedSkillSource {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface DesktopSkillImportCandidate {
  id: string;
  name: string;
  description: string;
  foundIn: DesktopSkillEngine[];
  path: string;
}

export interface DesktopSkillImportResult {
  id: string;
  name: string;
  installedPath: string;
  alreadyInstalled: boolean;
}

export interface DesktopSkillRepository {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface DesktopDiscoverableSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl?: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installed: boolean;
}

export interface DesktopSkillsShDiscoverableSkill {
  key: string;
  name: string;
  directory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installs: number;
  readmeUrl?: string;
  installed: boolean;
}

export interface DesktopSkillsShSearchResult {
  skills: DesktopSkillsShDiscoverableSkill[];
  totalCount: number;
  query: string;
}

export interface DesktopSkillDiscoverySnapshot {
  repositories: DesktopSkillRepository[];
  skills: DesktopDiscoverableSkill[];
  warnings: string[];
}

export interface DesktopSkillFile {
  path: string;
  name: string;
  kind: "file";
  size: number;
}

export interface DesktopSkillCatalogEntry {
  id: string;
  ref: string;
  name: string;
  description: string;
  scope: DesktopSkillScope;
  source: DesktopSkillSource;
  precedence: number;
  engine: DesktopSkillEngine;
  linkedEngines: DesktopSkillEngine[];
  absolutePath: string;
  mdPath: string;
  projectRoot?: string;
  files: DesktopSkillFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
  shadowedBy?: string;
}

export type DesktopSkillActivationSource = "default" | "global" | "project";

export interface DesktopSkillActivation {
  ref: string;
  id: string;
  enabled: boolean;
  globalEnabled: boolean;
  projectOverride?: boolean;
  source: DesktopSkillActivationSource;
}

export interface DesktopSkillExtractionSettings {
  enabled: boolean;
  minToolCalls: number;
}

export interface DesktopSkillSettings {
  projectId: string;
  projectKey: string;
  globalDefaults: Record<string, boolean>;
  projectOverrides: Record<string, boolean>;
  extraction: DesktopSkillExtractionSettings;
  activations: DesktopSkillActivation[];
}

export type DesktopSkillDraftStatus = "pending" | "approved" | "rejected" | "failed";

export interface DesktopSkillDraft {
  id: string;
  name: string;
  description: string;
  content: string;
  status: DesktopSkillDraftStatus;
  toolCalls: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  installedPath?: string;
}

export interface DesktopPluginSummary {
  id: string;
  name: string;
  path: string;
  scope: "project";
  projectId: string;
  projectName: string;
  status: "configured" | "missing" | "disabled" | "failed";
  moduleCount: number;
  version?: string;
  category?: string;
  description?: string;
  enabled?: boolean;
  managed?: boolean;
  error?: string;
}

export interface DesktopPluginMarketEntry {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  details: string;
  author?: { name: string; email?: string };
  tags: string[];
  repository: string;
  path: string;
  files?: string[];
  branch?: string;
  entry?: string;
  homepage?: string;
  featured: boolean;
}

export interface DesktopPluginRegistrySnapshot {
  registryUrl: string;
  fetchedAt?: string;
  stale: boolean;
  loadingError?: string;
  plugins: DesktopPluginMarketEntry[];
}

export interface DesktopSkillCatalogSnapshot {
  skills: DesktopSkillCatalogEntry[];
  inventory: DesktopSkillCatalogEntry[];
  unmanagedSkills: DesktopSkillImportCandidate[];
  plugins: DesktopPluginSummary[];
  managedSources: DesktopManagedSkillSource[];
  warnings: string[];
  diagnostics: DesktopSkillDiagnostic[];
}

export type DesktopMcpTransport = "stdio" | "remote";
export type DesktopMcpRemoteProtocol = "streamable-http" | "sse";
export type DesktopMcpServerState = "connected" | "disconnected" | "not-started" | "disabled";

export interface DesktopMcpServerSummary {
  name: string;
  id?: string;
  description?: string;
  transport: DesktopMcpTransport;
  remoteProtocol?: DesktopMcpRemoteProtocol;
  commandOrUrl: string;
  args: string[];
  cwd?: string;
  stderr?: "ignore" | "inherit" | "pipe";
  timeoutMs?: number;
  enabled: boolean;
  state: DesktopMcpServerState;
  toolNames: string[];
  promptNames: string[];
  hasResources: boolean;
  environmentKeys: string[];
  headerNames: string[];
  lastError?: string;
}

export interface DesktopMcpResourceSummary {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface DesktopMcpServerDetails {
  server: DesktopMcpServerSummary;
  resources: DesktopMcpResourceSummary[];
}

export type DesktopMcpFieldAction = "set" | "keep" | "clear";

/** value 只允许出现在一次性 IPC 入参中；快照永远不返回字段正文。 */
export interface DesktopMcpFieldMutation {
  key: string;
  action: DesktopMcpFieldAction;
  value?: string;
}

export interface DesktopMcpServerDraft {
  name: string;
  description?: string;
  transport: DesktopMcpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  stderr?: "ignore" | "inherit" | "pipe";
  url?: string;
  remoteProtocol?: DesktopMcpRemoteProtocol;
  timeoutMs?: number;
  env: DesktopMcpFieldMutation[];
  headers: DesktopMcpFieldMutation[];
}

export interface DesktopMcpCatalogParameter {
  name: string;
  key: string;
  placeholder?: string;
  required: boolean;
}

export interface DesktopMcpCatalogInstallation {
  name: string;
  transport: DesktopMcpTransport;
  remoteProtocol?: DesktopMcpRemoteProtocol;
  command?: string;
  args: string[];
  url?: string;
  parameters: DesktopMcpCatalogParameter[];
  tags: string[];
}

export interface DesktopMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  author?: string;
  category?: string;
  tags: string[];
  verified: boolean;
  featured: boolean;
  repositoryUrl?: string;
  websiteUrl?: string;
  installations: DesktopMcpCatalogInstallation[];
}

export type DesktopMcpCatalogStatus = "idle" | "loading" | "ready" | "stale" | "error";

export interface DesktopMcpCatalogState {
  status: DesktopMcpCatalogStatus;
  source: string;
  fetchedAt?: string;
  entries: DesktopMcpCatalogEntry[];
  categories: string[];
  error?: string;
}

export interface DesktopMcpTestResult {
  success: boolean;
  state: "connected" | "failed";
  toolNames: string[];
  promptNames: string[];
  hasResources: boolean;
  message?: string;
  error?: string;
}

export interface DesktopMcpSnapshot {
  configRevision: string;
  servers: DesktopMcpServerSummary[];
  catalog: DesktopMcpCatalogState;
}

export interface DesktopSkillFilePreview {
  path: string;
  content?: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}

export interface DesktopModelConfigurationInput {
  alias: string;
  displayName: string;
  providerAlias: string;
  providerType: ModelProvider;
  protocol?: "anthropic" | "openai-compatible";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** 主进程暂存的 API Key 句柄；与 apiKey 二选一，句柄正文不会进入 IPC 返回值或 journal。 */
  apiKeyHandle?: string;
  apiKeyEnv?: string;
  requiresApiKey?: boolean;
  supportsTools: boolean;
  supportsThinking?: boolean;
  parallelToolCalls?: boolean;
  reasoningStream?: boolean;
  reasoningSummary?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limits?: ModelLimits;
  apiBackend?: ModelApiBackend;
  thinkingLevelMap?: ThinkingLevelMap;
  compatibility?: ModelCompatibility;
  /**
   * Whether this configuration should also become the active default model.
   * Connecting a provider opts in; enabling an extra model, rotating a key or
   * editing a base URL must leave the current default alone.
   */
  makeDefault?: boolean;
}

/**
 * Credential and endpoint state for one configured provider alias. The renderer
 * needs this to prefill the real saved base URL, to tell "key set" from "key
 * missing", and to decide whether a connection is OAuth-backed (and expired).
 * Secrets themselves are never sent across the bridge — only their presence.
 */
export interface DesktopModelConnection {
  providerAlias: string;
  providerType: ModelProvider;
  protocol?: "anthropic" | "openai-compatible";
  /** 连接级适配器（新建连接时与模型级一致写入）；渲染层用它回显「API 格式」。 */
  apiBackend?: ModelApiBackend;
  baseUrl?: string;
  requiresApiKey: boolean;
  hasCredential: boolean;
  credentialSource?: "keychain" | "config" | "env";
  apiKeyEnv?: string;
  authMode?: "api-key" | "oauth-bearer";
  oauthProvider?: string;
  /** Epoch millis; present only for OAuth-backed connections. */
  oauthExpiresAt?: number;
}

export interface DesktopModelCatalogResult {
  providerAlias: string;
  /** 只有服务商成功返回并通过校验的非空目录才会产生结果。 */
  source: "fetched";
  fetchedAt: string;
  models: ModelCatalogEntry[];
}

export type DesktopModelLoginProvider = "claude-code" | "openai-codex";
export type DesktopModelLoginMethod = "paste-code" | "browser-callback";

export interface DesktopModelLoginStartResult {
  authRequestId: string;
  stateHint: string;
  method: DesktopModelLoginMethod;
}

export interface DesktopModelConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export type DesktopWebSearchProvider = WebSearchConfig["provider"];

/**
 * 联网搜索设置的渲染端视图。密钥本身不过桥：`hasApiKey` 只表示 config 中
 * 是否已保存密钥，`envKeyDetected` 表示生效的环境变量当前是否可用。
 */
export interface DesktopWebSearchSettings {
  enabled: boolean;
  provider: DesktopWebSearchProvider;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
  hasApiKey: boolean;
  envKeyName?: string;
  envKeyDetected: boolean;
}

export interface DesktopWebSearchSettingsInput {
  enabled: boolean;
  provider: DesktopWebSearchProvider;
  /** undefined 保留已存密钥；空字符串表示清除。 */
  apiKey?: string;
  /** 统一事务可使用主进程暂存句柄，避免明文进入 journal。 */
  apiKeyHandle?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
}

export type DesktopSettingsCredentialPurpose = "model" | "web-search";

/** 临时凭据句柄的受众；句柄不能跨项目、用途或 provider 重放。 */
export interface DesktopSettingsCredentialScope {
  projectId: string;
  purpose: DesktopSettingsCredentialPurpose;
  providerAlias: string;
}

export interface DesktopStagedSettingsCredential {
  handle: string;
  kind: "api-key" | "oauth-login";
  expiresAt: string;
  provider?: DesktopModelLoginProvider;
}

export interface DesktopStagedModelLoginResult extends DesktopStagedSettingsCredential {
  kind: "oauth-login";
  provider: DesktopModelLoginProvider;
  models: Array<{
    id: string;
    displayName: string;
    supportsThinking: boolean;
  }>;
}

/**
 * 内嵌浏览器 cookie 的概览。cookie 值本身不过桥，只报数量和域名 —— 它们等同于登录凭据，
 * 渲染层也没有需要读到明文的场景。
 */
export interface DesktopCookieJarStatus {
  total: number;
  /** 按 cookie 数量排序的前几个域名，用于展示「当前登录了哪些站点」。 */
  domains: Array<{ domain: string; count: number }>;
  /** 共享 jar 文件的最后写入时间；从未同步过时为 undefined。 */
  updatedAt?: string;
}

export type DesktopPersonality = "none" | "friendly" | "pragmatic" | "buddy";

/** 全局个性化设置；Desktop 只接触无凭据的运行时投影。 */
export interface DesktopPersonalizationSettings {
  enabled: boolean;
  personality: DesktopPersonality;
  customInstructions: string;
}

export type DesktopChatInheritance = "inherit";

export interface DesktopChatPersonalizationOverride {
  personality: DesktopChatInheritance | DesktopPersonality;
  customInstructions: {
    mode: "inherit" | "replace" | "disabled";
    value?: string;
  };
  useMemories: DesktopChatInheritance | boolean;
  contributeMemories: DesktopChatInheritance | boolean;
}

export interface DesktopResolvedPersonalization {
  enabled: boolean;
  personality: DesktopPersonality;
  customInstructions: string;
  useMemories: boolean;
  contributeMemories: boolean;
}

export interface DesktopPersonalizationOverview {
  /** 全局 config 的 CAS revision；保存时必须原样带回。 */
  configRevision: string;
  settings: DesktopPersonalizationSettings;
  /** UI 只直接编辑 use/generate，但保存时带回完整策略，避免覆盖其它记忆字段。 */
  memory: DesktopMemorySettings;
  chat?: {
    sessionId: string;
    override: DesktopChatPersonalizationOverride;
    effective: DesktopResolvedPersonalization;
    metadataRevision: string;
  };
}

export interface DesktopPersonalizationSettingsInput {
  expectedRevision: string;
  settings: DesktopPersonalizationSettings;
  memory: DesktopMemorySettings;
}

export type DesktopMemoryAudience = "workspace" | "universal";
export type DesktopMemoryOriginFilter = "all" | "current_workspace" | "user" | "other_workspaces";
export type DesktopMemoryOrigin =
  | { kind: "user" }
  | { kind: "workspace"; workspaceId: string; workspaceName: string };
export type DesktopMemoryKind = "preference" | "working_style" | "fact" | "decision" | "workflow" | "gotcha";
export type DesktopMemorySource = "explicit" | "explicit_edit" | "completed_task" | "candidate" | "migration" | "consolidation";

export interface DesktopMemoryLineage {
  source: DesktopMemorySource;
  externalContext: boolean;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  candidateId?: string;
  sourceEntryIds?: string[];
  legacyPath?: string;
  userEvidence?: string;
}

/** 记忆策略的渲染端视图；与 `context.memory` 的当前字段一一对应。 */
export type DesktopMemorySettings = MemoryPolicy;

/** 自动压缩策略的渲染端视图；与 `context.compaction` 的当前字段一一对应。 */
export type DesktopCompactionSettings = CompactionConfig;

/** 聊天采样参数的渲染端视图；与 `chat` 的当前字段一一对应。 */
export type DesktopChatParamsSettings = ChatParamsConfig;

export interface DesktopMemoryEntry {
  id: string;
  origin: DesktopMemoryOrigin;
  revision: number;
  topic: string;
  kind: DesktopMemoryKind;
  importance: number;
  title: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  lineage: DesktopMemoryLineage[];
  recallCount: number;
  lastRecalledAt?: string;
}

export interface DesktopMemoryOverview {
  filter: DesktopMemoryOriginFilter;
  /** 全局记忆策略使用的 config CAS revision。 */
  configRevision: string;
  /** 单一 Markdown 记忆库的 CAS revision。 */
  revision: number;
  settings: DesktopMemorySettings;
  /** 单一库总条目数；当前 filter 的数量用 entries.length。 */
  totalEntries: number;
  memoryStats: {
    total: number;
    autoGenerated: number;
    manualAdded: number;
  };
  candidateCount: number;
  origins: {
    user: number;
    currentWorkspace: number;
    otherWorkspaces: number;
  };
  /** 候选维护是即时后台动作；时间来自持久化投影，不参与条目 CAS revision。 */
  maintenance: MemoryMaintenanceStatus;
  topics: Array<{ topic: string; entries: number }>;
  entries: DesktopMemoryEntry[];
}

/** 记忆库统计：不含条目内容，随条目增删变化，供设置页头部与翻页控件。 */
export interface DesktopMemoryStats {
  filter: DesktopMemoryOriginFilter;
  /** 全局记忆策略使用的 config CAS revision。 */
  configRevision: string;
  /** 单一 Markdown 记忆库的 CAS revision；条目写入时递增。 */
  revision: number;
  settings: DesktopMemorySettings;
  /** 单一库总条目数（不分 filter）。 */
  totalEntries: number;
  memoryStats: {
    total: number;
    autoGenerated: number;
    manualAdded: number;
  };
  candidateCount: number;
  origins: {
    user: number;
    currentWorkspace: number;
    otherWorkspaces: number;
  };
  maintenance: MemoryMaintenanceStatus;
  topics: Array<{ topic: string; entries: number }>;
}

/** 记忆条目的一页；offset 分页，revision 供翻页期间的一致性判断。 */
export interface DesktopMemoryEntriesPage {
  filter: DesktopMemoryOriginFilter;
  /** 读取时的单库 revision；翻页间若变化，调用方应回到第 0 页重读。 */
  revision: number;
  entries: DesktopMemoryEntry[];
  /** 应用 filter 后、分页前的条目总数。 */
  total: number;
  offset: number;
  limit: number;
}

export interface DesktopMemorySettingsSnapshot {
  configRevision: string;
  settings: DesktopMemorySettings;
}

export interface DesktopMemorySearchMatch {
  id: string;
  origin: DesktopMemoryOrigin;
  topic: string;
  kind: DesktopMemoryKind;
  lineage: DesktopMemoryLineage[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  path: string;
  excerpt: string;
  score: number;
  recallCount: number;
  lastRecalledAt?: string;
}

export interface DesktopMemoryCompactionResult {
  filter: DesktopMemoryOriginFilter;
  before: number;
  after: number;
  revision: number;
  error?: string;
}

export type DesktopTelosScope = TelosScope;
export type DesktopTelosDocument = TelosDocument;
export type DesktopTelosDocumentInput = TelosDocumentInput;
export type DesktopBehaviorPattern = BehaviorPattern;
export type DesktopBehaviorPatternReviewAction = BehaviorPatternReviewAction;
export type DesktopTelosEvidence = TelosEvidence;
export type DesktopTelosDrift = TelosDrift;
export type DesktopTelosDriftResolutionAction = TelosDriftResolutionAction;
export type DesktopTelosOverview = TelosOverview;

/** Renderer 只接收主进程计算好的 endpoint 摘要，不能为了 SHA-256 引入 Node-only agent 模块。 */
export interface DesktopEmbeddingModelDescriptor extends EmbeddingModelDescriptor {
  privacyEndpointHash?: string;
}

export type DesktopMemoryEmbeddingStatus = Omit<MemoryEmbeddingRuntimeStatus, "models"> & {
  models: DesktopEmbeddingModelDescriptor[];
};

export interface DesktopMemoryEmbeddingCancellationResult {
  cancelled: boolean;
  status: DesktopMemoryEmbeddingStatus;
}

export interface DesktopMemoryEmbeddingDeleteResult {
  filesDeleted: number;
  bytesFreed: number;
  status: DesktopMemoryEmbeddingStatus;
}


export interface DesktopMemorySettingsInput {
  expectedRevision: string;
  settings: DesktopMemorySettings;
}

export interface DesktopSettingsModelsSnapshot {
  configured: ModelChoice[];
  connections: DesktopModelConnection[];
  /** 脱敏的独立 embedding 目录；不含 provider headers 或凭据。 */
  embeddingModels: DesktopEmbeddingModelDescriptor[];
  defaultModel: string;
  thinking: ThinkingSelection;
}

export interface DesktopSettingsChatSnapshot {
  sessionId: string;
  metadataRevision: string;
  personalization: DesktopChatPersonalizationOverride;
}

export interface DesktopSettingsPendingRecovery {
  journalId: string;
  message: string;
}

/** Renderer 只同步关闭判断需要的布尔状态，不把草稿内容复制到主进程。 */
export interface DesktopSettingsDraftState {
  dirty: boolean;
  canSave: boolean;
  open: boolean;
}

export type DesktopSettingsCloseIntent = "window" | "quit";

export interface DesktopSettingsCloseRequest {
  requestId: string;
  intent: DesktopSettingsCloseIntent;
  canSave: boolean;
}

export type DesktopSettingsCloseResponse = "saved" | "discarded" | "cancelled";

/** 设置页一次读取的脱敏快照；两个 revision 分别保护 Desktop 偏好和全局 config。 */
export interface DesktopSettingsSnapshot {
  projectId: string;
  /** 任一驻留项目存在运行中任务时，全局设置和即时共享动作都只读。 */
  hasRunningTasks: boolean;
  preferenceRevision: number;
  configRevision: string;
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
  personalization: DesktopPersonalizationSettings;
  activity: ActivitySettings;
  identity: DesktopIdentitySettings;
  memory: DesktopMemorySettings;
  compaction: DesktopCompactionSettings;
  chatParams: DesktopChatParamsSettings;
  webSearch: DesktopWebSearchSettings;
  models: DesktopSettingsModelsSnapshot;
  skills: DesktopSkillSettings;
  chat?: DesktopSettingsChatSnapshot;
  pendingRecovery?: DesktopSettingsPendingRecovery;
}

export interface DesktopSettingsModelsInput {
  upserts: DesktopModelConfigurationInput[];
  removeAliases: string[];
  defaultModel?: {
    alias: string;
    thinking: ThinkingSelection;
  };
  oauthCredentialHandles?: string[];
}

export interface DesktopSettingsChatInput {
  sessionId: string;
  expectedMetadataRevision: string;
  personalization: DesktopChatPersonalizationOverride;
}

/** 设置草稿的统一提交输入。明文凭据只允许出现在本次 IPC 入参，绝不进入返回值或 journal。 */
export interface DesktopSettingsSaveInput {
  expectedPreferenceRevision: number;
  expectedConfigRevision: string;
  themePreference?: DesktopThemePreference;
  fontPreference?: DesktopFontPreference;
  personalization?: DesktopPersonalizationSettings;
  /** 外发策略不属于 renderer 可写入的输入；主进程会保留当前策略并仅更新采集参数。 */
  activity?: ActivitySettingsInput;
  identity?: DesktopIdentitySettings;
  memory?: DesktopMemorySettings;
  compaction?: DesktopCompactionSettings;
  chatParams?: DesktopChatParamsSettings;
  webSearch?: DesktopWebSearchSettingsInput;
  models?: DesktopSettingsModelsInput;
  skills?: DesktopSkillSettingsInput;
  chat?: DesktopSettingsChatInput;
}

export interface DesktopSkillSettingsInput {
  globalDefaults: Record<string, boolean>;
  projectOverrides: Record<string, boolean>;
  extraction: DesktopSkillExtractionSettings;
}

export type DesktopSettingsSegment = "preferences" | "config" | "chat_metadata";

export interface DesktopSettingsConflict {
  segment: DesktopSettingsSegment;
  expectedRevision: string;
  actualRevision: string;
}

export type DesktopSettingsSaveResult =
  | {
      status: "committed";
      journalId: string;
      appliedFields: string[];
      snapshot: DesktopSettingsSnapshot;
    }
  | {
      status: "rolled_back";
      journalId?: string;
      conflicts?: DesktopSettingsConflict[];
      message?: string;
      draftRetained: true;
      snapshot: DesktopSettingsSnapshot;
    }
  | {
      status: "recovery_required";
      journalId: string;
      message: string;
      snapshot?: DesktopSettingsSnapshot;
    };

export interface DesktopMemoryEntryInput {
  audience: DesktopMemoryAudience;
  topic: string;
  kind: DesktopMemoryKind;
  title: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
  importance: number;
  /** 通用偏好必须保留用户明确表达的证据；工作区记忆可省略。 */
  userEvidence?: string;
}

export interface DesktopMemoryEntryPatch {
  topic?: string;
  kind?: DesktopMemoryKind;
  title?: string;
  summary?: string;
  decisions?: string[];
  paths?: string[];
  keywords?: string[];
  importance?: number;
  userEvidence?: string;
}

export type DesktopSlashCommand = SlashCommandDefinition;

/** 桌面端输入框支持的斜杠命令；执行走 runSlashCommand IPC。 */
export const DESKTOP_SLASH_COMMANDS: DesktopSlashCommand[] = slashCommandsForSurface("desktop");

export interface DesktopSlashResult {
  command: string;
  title: string;
  content: string;
}

/** Desktop 后台面板使用的 authority 投影；渲染层不接触 SQLite 或 Host socket。 */
export interface DesktopRuntimeProjection {
  tasks: unknown;
  automations: unknown;
  pendingFires: unknown;
  goals: unknown;
  graphs: unknown;
  capabilities: unknown;
}

export type DesktopRuntimeMutation =
  | "task.create"
  | "task.start"
  | "task.cancel"
  | "task.approve"
  | "task.resume"
  | "task.retry"
  | "automation.create"
  | "automation.pause"
  | "automation.resume"
  | "automation.run"
  | "automation.delete"
  | "goal.create"
  | "goal.pause"
  | "goal.resume"
  | "goal.cancel"
  | "graph.create"
  | "graph.start"
  | "graph.pause"
  | "graph.resume"
  | "graph.cancel"
  | "capability.register"
  | "capability.replace"
  | "capability.admit"
  | "capability.reject"
  | "capability.release"
  | "capability.invoke"
  | "capability.accept"
  | "capability.start"
  | "capability.result"
  | "capability.chunk"
  | "capability.fail"
  | "capability.cancel";

export type DesktopMenuAction = "new-task" | "open-project" | "search" | "settings" | "toggle-sidebar" | "focus-composer";
export type DesktopSessionMenuAction = "rename" | "pin" | "unpin" | "archive" | "unarchive" | "duplicate" | "export-bundle" | "export-claude" | "delete";

/** 内嵌终端创建结果。`replay` 是复用已有终端时回放的最近输出。 */
export interface DesktopTerminalHandle {
  terminalId: string;
  replay: string;
}

export type DesktopTerminalEvent =
  | { terminalId: string; type: "data"; data: string }
  | { terminalId: string; type: "exit"; exitCode: number };

/**
 * 渲染进程可用的全部主进程能力，运行时挂在 `window.biny` 上。
 *
 * 大部分方法返回更新后的 `DesktopWorkspaceSnapshot`，渲染层直接整体替换状态即可，
 * 不需要自己推算改动结果。`on*` 系列返回取消订阅函数。
 */
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  openProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  createEmptyProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  selectProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  commitSelection(projectId: string, sessionId: string | undefined, activeView: DesktopActiveView): Promise<void>;
  setActiveView(activeView: DesktopActiveView): Promise<void>;
  setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot>;
  reorderProjects(projectIds: string[]): Promise<DesktopProject[]>;
  renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot>;
  removeProject(projectId: string): Promise<DesktopBootstrap>;
  refreshProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  listProjectBranches(projectId: string): Promise<DesktopGitBranch[]>;
  switchProjectBranch(projectId: string, branchName: string): Promise<DesktopWorkspaceSnapshot>;
  createProjectBranch(projectId: string, branchName: string): Promise<DesktopWorkspaceSnapshot>;
  revealProject(projectId: string): Promise<void>;
  openProjectTerminal(projectId: string): Promise<void>;
  startDraft(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  openSession(projectId: string, sessionId: string): Promise<DesktopSessionDocument>;
  listSessionTreePage(projectId: string, options?: DesktopSessionTreePageOptions): Promise<DesktopSessionTreePage>;
  renameSession(projectId: string, sessionId: string, title: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot>;
  pinSession(projectId: string, sessionId: string, pinned: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot>;
  archiveSession(projectId: string, sessionId: string, archived: boolean, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot>;
  markSessionRead(projectId: string, sessionId: string, expectedRevision?: string): Promise<DesktopWorkspaceSnapshot>;
  duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot>;
  deleteSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot>;
  /** 导出为 Biny bundle（无损 JSON）或 Claude Code JSONL；用户在保存对话框里选位置。 */
  exportSession(projectId: string, sessionId: string, format: "biny" | "claude"): Promise<DesktopWorkspaceSnapshot>;
  /** 从 Biny bundle / Claude Code / Codex rollout 文件导入一条新会话并选中它。 */
  importSession(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  showSessionMenu(projectId: string, sessionId: string, pinned: boolean, archived?: boolean): Promise<DesktopSessionMenuAction | undefined>;
  sendPrompt(
    projectId: string,
    sessionId: string | undefined,
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[],
    delivery?: "steer" | "followUp",
    personalization?: DesktopChatPersonalizationOverride,
    idempotencyKey?: string
  ): Promise<DesktopRunReceipt>;
  resumeInterruptedTurn(projectId: string, sessionId: string): Promise<DesktopRunReceipt | undefined>;
  editPrompt(projectId: string, sessionId: string, userMessageIndex: number, input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], idempotencyKey?: string): Promise<DesktopRunReceipt>;
  cancelRun(projectId: string, runId: string): Promise<void>;
  runSlashCommand(projectId: string, sessionId: string | undefined, command: string): Promise<DesktopSlashResult>;
  expandSkillCommand(projectId: string, input: string): Promise<string>;
  resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void>;
  setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot>;
  switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo>;
  testModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  fetchModelCatalog(projectId: string, providerAlias: string, force?: boolean): Promise<DesktopModelCatalogResult>;
  /**
   * 用尚未保存的候选配置（临时密钥 + 目录地址）直接向服务商拉取模型目录，
   * 供“新增连接”流程在提交前加载可勾选的模型列表。
  */
  fetchModelCatalogCandidate(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopModelCatalogResult>;
  startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  compact(projectId: string, hint?: string): Promise<string>;
  runtimeProjection(projectId: string): Promise<DesktopRuntimeProjection>;
  runtimeMutation(projectId: string, operation: DesktopRuntimeMutation, payload?: Record<string, unknown>): Promise<unknown>;
  runtimeEvents(projectId: string, afterSequence?: number, limit?: number): Promise<unknown>;
  /** 打开内嵌浏览器窗口；`url` 省略时打开首页。登录态由浏览器 partition 保存并同步给 agent 工具。 */
  openBrowser(url?: string): Promise<void>;
  cookieJarStatus(): Promise<DesktopCookieJarStatus>;
  exportCookies(): Promise<DesktopCookieJarStatus>;
  importCookies(): Promise<DesktopCookieJarStatus>;
  clearCookies(): Promise<DesktopCookieJarStatus>;
  personalizationOverview(projectId: string, sessionId?: string): Promise<DesktopPersonalizationOverview>;
  savePersonalizationSettings(projectId: string, input: DesktopPersonalizationSettingsInput): Promise<DesktopPersonalizationOverview>;
  saveChatPersonalization(projectId: string, sessionId: string, input: DesktopChatPersonalizationOverride, expectedRevision: string): Promise<DesktopWorkspaceSnapshot>;
  memoryOverview(projectId: string, filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryOverview>;
  /** 记忆库统计（不含条目内容）；条目增删后用于刷新头部与翻页控件。 */
  memoryStats(projectId: string, filter?: DesktopMemoryOriginFilter): Promise<DesktopMemoryStats>;
  /** 记忆条目分页读取；offset 分页，revision 变化时调用方应回第 0 页。 */
  memoryEntries(projectId: string, filter: DesktopMemoryOriginFilter, offset: number, limit: number): Promise<DesktopMemoryEntriesPage>;
  saveMemorySettings(projectId: string, input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot>;
  identityOverview(projectId: string): Promise<DesktopIdentityOverview>;
  importAlmaIdentity(projectId: string, root?: string): Promise<DesktopAlmaImportScan>;
  saveIdentityDocument(projectId: string, document: DesktopIdentityDocumentKind, content: string, expectedRevision: number, reason?: string): Promise<DesktopIdentityOverview>;
  reviewIdentityProposal(projectId: string, proposalId: string, action: "accept" | "reject", expectedRevision: number): Promise<DesktopIdentityReviewResult>;
  settingsSnapshot(projectId: string, sessionId?: string): Promise<DesktopSettingsSnapshot>;
  saveSettings(projectId: string, input: DesktopSettingsSaveInput): Promise<DesktopSettingsSaveResult>;
  activitySnapshot(): Promise<ActivityRuntimeSnapshot>;
  requestActivityPermission(pane: DesktopSystemSettingsPane): Promise<void>;
  searchActivity(query: string, limit?: number): Promise<ActivitySearchResult[]>;
  /** 生成指定日期（today/yesterday/YYYY-MM-DD，默认 today）的 Activity 打工日记。 */
  activityReport(date?: string): Promise<DesktopActivityReport>;
  clearActivity(): Promise<ActivityRuntimeSnapshot>;
  stageSettingsCredential(secret: string, scope: DesktopSettingsCredentialScope): Promise<DesktopStagedSettingsCredential>;
  completeModelLoginForSettings(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopStagedModelLoginResult>;
  releaseSettingsCredentials(handles: string[]): Promise<void>;
  updateSettingsDraftState(state: DesktopSettingsDraftState): Promise<void>;
  respondSettingsCloseRequest(requestId: string, response: DesktopSettingsCloseResponse): Promise<boolean>;
  searchMemory(projectId: string, filter: DesktopMemoryOriginFilter, query: string): Promise<DesktopMemorySearchMatch[]>;
  addMemoryEntry(projectId: string, input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  updateMemoryEntry(projectId: string, entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryOverview>;
  deleteMemoryEntry(projectId: string, entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  clearMemory(projectId: string, filter: DesktopMemoryOriginFilter, expectedRevision: number): Promise<DesktopMemoryOverview>;
  compactMemory(projectId: string, filter: DesktopMemoryOriginFilter, expectedRevision: number, topic?: string): Promise<DesktopMemoryCompactionResult>;
  memoryEmbeddingStatus(projectId: string): Promise<DesktopMemoryEmbeddingStatus>;
  downloadMemoryEmbeddingModel(projectId: string, model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  cancelMemoryEmbeddingDownload(projectId: string, model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  deleteMemoryEmbeddingModel(projectId: string, model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  rebuildMemoryEmbeddingIndex(projectId: string): Promise<DesktopMemoryEmbeddingStatus>;
  cancelMemoryEmbeddingRebuild(projectId: string): Promise<DesktopMemoryEmbeddingCancellationResult>;
  telosOverview(projectId: string): Promise<DesktopTelosOverview>;
  saveTelos(projectId: string, input: DesktopTelosDocumentInput, expectedRevision: number): Promise<DesktopTelosOverview>;
  reviewBehaviorPattern(projectId: string, patternId: string, action: DesktopBehaviorPatternReviewAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  resolveTelosDrift(projectId: string, driftId: string, action: DesktopTelosDriftResolutionAction, expectedRevision: number): Promise<DesktopTelosOverview>;
  snoozeTelosDrift(projectId: string, driftId: string, until: string, expectedRevision: number): Promise<DesktopTelosOverview>;  saveAttachment(projectId: string, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment>;
  resolveDroppedFile(file: File): string;
  listWorkspaceDirectory(projectId: string, relativePath: string): Promise<DesktopWorkspaceDirectory>;
  readWorkspaceFile(projectId: string, relativePath: string): Promise<DesktopWorkspaceFilePreview>;
  /** 读取消息里引用的本地图片，返回 data URL；不是图片、太大或读不到时返回 undefined。 */
  readInlineImage(projectId: string, relativePath: string): Promise<string | undefined>;
  openWorkspaceFile(projectId: string, relativePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openSystemSettings(pane: DesktopSystemSettingsPane): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
  setFilePanelWidth(width: number): Promise<void>;
  setThemePreference(theme: DesktopThemePreference): Promise<DesktopThemePreference>;
  setFontPreference(font: DesktopFontPreference): Promise<DesktopFontPreference>;
  createTerminal(projectId: string, cols: number, rows: number): Promise<DesktopTerminalHandle>;
  writeTerminal(terminalId: string, data: string): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  disposeTerminal(terminalId: string): Promise<void>;
  skillCatalog(projectId?: string): Promise<DesktopSkillCatalogSnapshot>;
  skillSettings(projectId: string): Promise<DesktopSkillSettings>;
  skillDrafts(projectId: string): Promise<DesktopSkillDraft[]>;
  approveSkillDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft>;
  rejectSkillDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft>;
  retrySkillDraft(projectId: string, draftId: string): Promise<DesktopSkillDraft>;
  editSkillDraft(projectId: string, draftId: string, content: string): Promise<DesktopSkillDraft>;
  importSkillSource(): Promise<DesktopManagedSkillSource | undefined>;
  installSkillSource(sourceId: string): Promise<void>;
  importExistingSkills(skillIds: string[]): Promise<DesktopSkillImportResult[]>;
  skillDiscovery(): Promise<DesktopSkillDiscoverySnapshot>;
  searchSkills(query: string, limit?: number, offset?: number): Promise<DesktopSkillsShSearchResult>;
  installDiscoveredSkill(skill: DesktopDiscoverableSkill): Promise<void>;
  addSkillRepository(repository: DesktopSkillRepository): Promise<DesktopSkillRepository[]>;
  removeSkillRepository(owner: string, name: string): Promise<DesktopSkillRepository[]>;
  readSkillFile(skillId: string, relativePath: string): Promise<DesktopSkillFilePreview>;
  writeSkillFile(skillId: string, relativePath: string, content: string): Promise<void>;
  openSkillDirectory(skillId: string): Promise<void>;
  pluginRegistry(projectId: string): Promise<DesktopPluginRegistrySnapshot>;
  refreshPluginRegistry(projectId: string): Promise<DesktopPluginRegistrySnapshot>;
  installPlugin(projectId: string, pluginId: string): Promise<DesktopPluginSummary>;
  setPluginEnabled(projectId: string, pluginId: string, enabled: boolean): Promise<DesktopPluginSummary>;
  uninstallPlugin(projectId: string, pluginId: string): Promise<void>;
  openPluginDirectory(projectId: string): Promise<void>;
  mcpSnapshot(projectId?: string): Promise<DesktopMcpSnapshot>;
  mcpCatalog(): Promise<DesktopMcpCatalogState>;
  mcpRefreshCatalog(): Promise<DesktopMcpCatalogState>;
  mcpUpsertServer(
    projectId: string | undefined,
    originalName: string | undefined,
    draft: DesktopMcpServerDraft,
    expectedConfigRevision: string
  ): Promise<DesktopMcpSnapshot>;
  mcpSetEnabled(projectId: string | undefined, name: string, enabled: boolean, expectedConfigRevision: string): Promise<DesktopMcpSnapshot>;
  mcpDeleteServer(projectId: string | undefined, name: string, expectedConfigRevision: string): Promise<DesktopMcpSnapshot>;
  mcpTestServer(projectId: string | undefined, draft: DesktopMcpServerDraft): Promise<DesktopMcpTestResult>;
  mcpReconnect(projectId: string, name: string): Promise<DesktopMcpServerSummary>;
  mcpDetails(projectId: string, name: string): Promise<DesktopMcpServerDetails>;
  onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): () => void;
  onAgentEvent(listener: (envelope: DesktopAgentEventEnvelope) => void): () => void;
  onSessionHandoff(listener: (target: DesktopSessionHandoff) => void): () => void;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
  onSettingsCloseRequest(listener: (request: DesktopSettingsCloseRequest) => void): () => void;
  onActivityEvent(listener: (snapshot: ActivityRuntimeSnapshot) => void): () => void;
}
