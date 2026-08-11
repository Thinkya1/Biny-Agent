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
import type { ModelCatalogEntry } from "../ai/types.js";
import type { ModelApiBackend, ModelCompatibility, ModelLimits, ModelProvider, ThinkingLevelMap, WebSearchConfig } from "../config/schema.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../runtime/agentEvents.js";
import { slashCommandsForSurface, type SlashCommandDefinition } from "../runtime/commandRegistry.js";
import type { SessionBranchPoint } from "../session/catalog.js";
import type { SessionEvent } from "../session/recorder.js";
import type { SessionRunStatus } from "../session/runLedger.js";

export const desktopIpc = {
  bootstrap: "desktop:bootstrap",
  openProject: "desktop:project:open",
  createEmptyProject: "desktop:project:create-empty",
  selectProject: "desktop:project:select",
  commitSelection: "desktop:selection:commit",
  setProjectPinned: "desktop:project:pin",
  reorderProjects: "desktop:project:reorder",
  renameProject: "desktop:project:rename",
  removeProject: "desktop:project:remove",
  refreshProject: "desktop:project:refresh",
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
  sessionMenu: "desktop:session:menu",
  sendPrompt: "desktop:agent:send",
  resumeInterruptedTurn: "desktop:agent:resume-interrupted",
  editPrompt: "desktop:agent:edit",
  cancelRun: "desktop:agent:cancel",
  runSlashCommand: "desktop:agent:slash",
  resolvePermission: "desktop:permission:resolve",
  setPermissionMode: "desktop:permission:mode",
  switchModel: "desktop:model:switch",
  saveModelConfiguration: "desktop:model:save-configuration",
  testModelConfiguration: "desktop:model:test-configuration",
  removeModelConfiguration: "desktop:model:remove-configuration",
  fetchModelCatalog: "desktop:model:fetch-catalog",
  startModelLogin: "desktop:model:login:start",
  completeModelLogin: "desktop:model:login:complete",
  cancelModelLogin: "desktop:model:login:cancel",
  compact: "desktop:agent:compact",
  runtimeProjection: "desktop:runtime:projection",
  runtimeMutation: "desktop:runtime:mutation",
  runtimeEvents: "desktop:runtime:events",
  webSearchSettings: "desktop:web-search:settings",
  saveWebSearchSettings: "desktop:web-search:save",
  openBrowser: "desktop:browser:open",
  cookieJarStatus: "desktop:browser:cookies:status",
  exportCookies: "desktop:browser:cookies:export",
  importCookies: "desktop:browser:cookies:import",
  clearCookies: "desktop:browser:cookies:clear",
  personalizationOverview: "desktop:personalization:overview",
  savePersonalizationSettings: "desktop:personalization:save",
  saveChatPersonalization: "desktop:personalization:save-chat",
  memoryOverview: "desktop:memory:overview",
  saveMemorySettings: "desktop:memory:save-settings",
  searchMemory: "desktop:memory:search",
  addMemoryEntry: "desktop:memory:add",
  deleteMemoryEntry: "desktop:memory:delete-entry",
  clearMemory: "desktop:memory:clear",
  compactMemory: "desktop:memory:compact",
  saveAttachment: "desktop:attachment:save",
  resolveDroppedFile: "desktop:attachment:resolve-path",
  listWorkspaceDirectory: "desktop:file:list-directory",
  readWorkspaceFile: "desktop:file:read",
  readInlineImage: "desktop:file:read-image",
  openWorkspaceFile: "desktop:file:open",
  openExternal: "desktop:external:open",
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
  skillFileRead: "desktop:skill:file-read",
  skillFileWrite: "desktop:skill:file-write",
  skillOpenDirectory: "desktop:skill:open-directory"
} as const;

export type DesktopThemePreference = "system" | "light" | "dark";

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
  runtimeError?: string;
  requiresModelConfiguration: boolean;
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

export interface DesktopSkillFile {
  path: string;
  name: string;
  kind: "file";
  size: number;
}

export interface DesktopSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  scope: DesktopSkillScope;
  engine: DesktopSkillEngine;
  linkedEngines: DesktopSkillEngine[];
  absolutePath: string;
  mdPath: string;
  projectRoot?: string;
  files: DesktopSkillFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
}

export interface DesktopPluginSummary {
  id: string;
  name: string;
  path: string;
  scope: "project";
  projectId: string;
  projectName: string;
  status: "configured" | "missing";
  moduleCount: number;
}

export interface DesktopSkillCatalogSnapshot {
  skills: DesktopSkillCatalogEntry[];
  plugins: DesktopPluginSummary[];
  warnings: string[];
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
  /** `fetched` means the provider answered; `fallback` means we kept what we had. */
  source: "fetched" | "fallback";
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
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
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

export type DesktopPersonality = "none" | "friendly" | "pragmatic";

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

export type DesktopMemoryScope = "global" | "project";
export type DesktopMemoryKind = "preference" | "working_style" | "fact" | "decision" | "workflow" | "gotcha";
export type DesktopMemorySource = "explicit" | "completed_task" | "candidate" | "migration" | "consolidation";

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
export interface DesktopMemorySettings {
  useMemories: boolean;
  generateMemories: boolean;
  maxRecalled: number;
  /** 提取与整理可以使用不同模型；undefined 表示跟随会话模型。 */
  extractModel?: string;
  consolidationModel?: string;
  excludeExternalContext: boolean;
}

export interface DesktopMemoryEntry {
  id: string;
  scope: DesktopMemoryScope;
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
}

export interface DesktopMemoryOverview {
  scope: DesktopMemoryScope;
  /** 全局记忆策略使用的 config CAS revision。 */
  configRevision: string;
  /** 当前 scope store 的 CAS revision。 */
  revision: number;
  settings: DesktopMemorySettings;
  totalEntries: number;
  topics: Array<{ topic: string; entries: number }>;
  entries: DesktopMemoryEntry[];
}

export interface DesktopMemorySettingsSnapshot {
  configRevision: string;
  settings: DesktopMemorySettings;
}

export interface DesktopMemorySearchMatch {
  id: string;
  scope: DesktopMemoryScope;
  topic: string;
  kind: DesktopMemoryKind;
  lineage: DesktopMemoryLineage[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  path: string;
  excerpt: string;
  score: number;
}

export interface DesktopMemoryCompactionResult {
  scope: DesktopMemoryScope;
  before: number;
  after: number;
  revision: number;
  error?: string;
}

export interface DesktopMemorySettingsInput {
  expectedRevision: string;
  settings: DesktopMemorySettings;
}

export interface DesktopMemoryEntryInput {
  topic: string;
  note: string;
  kind: DesktopMemoryKind;
  importance: number;
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
export type DesktopSessionMenuAction = "rename" | "pin" | "unpin" | "archive" | "unarchive" | "duplicate" | "delete";

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
  commitSelection(projectId: string, sessionId: string | undefined): Promise<void>;
  setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot>;
  reorderProjects(projectIds: string[]): Promise<DesktopProject[]>;
  renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot>;
  removeProject(projectId: string): Promise<DesktopBootstrap>;
  refreshProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
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
  showSessionMenu(projectId: string, sessionId: string, pinned: boolean, archived?: boolean): Promise<DesktopSessionMenuAction | undefined>;
  sendPrompt(projectId: string, sessionId: string | undefined, input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp"): Promise<DesktopRunReceipt>;
  resumeInterruptedTurn(projectId: string, sessionId: string): Promise<DesktopRunReceipt | undefined>;
  editPrompt(projectId: string, sessionId: string, userMessageIndex: number, input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[]): Promise<DesktopRunReceipt>;
  cancelRun(projectId: string, runId: string): Promise<void>;
  runSlashCommand(projectId: string, sessionId: string | undefined, command: string): Promise<DesktopSlashResult>;
  resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void>;
  setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot>;
  switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo>;
  saveModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot>;
  testModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  removeModelConfiguration(projectId: string, alias: string): Promise<DesktopWorkspaceSnapshot>;
  fetchModelCatalog(projectId: string, providerAlias: string): Promise<DesktopModelCatalogResult>;
  startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  completeModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopWorkspaceSnapshot>;
  cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  compact(projectId: string, hint?: string): Promise<string>;
  runtimeProjection(projectId: string): Promise<DesktopRuntimeProjection>;
  runtimeMutation(projectId: string, operation: DesktopRuntimeMutation, payload?: Record<string, unknown>): Promise<unknown>;
  runtimeEvents(projectId: string, afterSequence?: number, limit?: number): Promise<unknown>;
  webSearchSettings(projectId: string): Promise<DesktopWebSearchSettings>;
  saveWebSearchSettings(projectId: string, input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings>;
  /** 打开内嵌浏览器窗口；`url` 省略时打开首页。登录态由浏览器 partition 保存并同步给 agent 工具。 */
  openBrowser(url?: string): Promise<void>;
  cookieJarStatus(): Promise<DesktopCookieJarStatus>;
  exportCookies(): Promise<DesktopCookieJarStatus>;
  importCookies(): Promise<DesktopCookieJarStatus>;
  clearCookies(): Promise<DesktopCookieJarStatus>;
  personalizationOverview(projectId: string, sessionId?: string): Promise<DesktopPersonalizationOverview>;
  savePersonalizationSettings(projectId: string, input: DesktopPersonalizationSettingsInput): Promise<DesktopPersonalizationOverview>;
  saveChatPersonalization(projectId: string, sessionId: string, input: DesktopChatPersonalizationOverride, expectedRevision: string): Promise<DesktopWorkspaceSnapshot>;
  memoryOverview(projectId: string, scope: DesktopMemoryScope): Promise<DesktopMemoryOverview>;
  saveMemorySettings(projectId: string, input: DesktopMemorySettingsInput): Promise<DesktopMemorySettingsSnapshot>;
  searchMemory(projectId: string, scope: DesktopMemoryScope, query: string): Promise<DesktopMemorySearchMatch[]>;
  addMemoryEntry(projectId: string, scope: DesktopMemoryScope, input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryOverview>;
  deleteMemoryEntry(projectId: string, scope: DesktopMemoryScope, entryId: string, expectedRevision: number): Promise<DesktopMemoryOverview>;
  clearMemory(projectId: string, scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryOverview>;
  compactMemory(projectId: string, scope: DesktopMemoryScope, expectedRevision: number): Promise<DesktopMemoryCompactionResult>;
  saveAttachment(projectId: string, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment>;
  resolveDroppedFile(file: File): string;
  listWorkspaceDirectory(projectId: string, relativePath: string): Promise<DesktopWorkspaceDirectory>;
  readWorkspaceFile(projectId: string, relativePath: string): Promise<DesktopWorkspaceFilePreview>;
  /** 读取消息里引用的本地图片，返回 data URL；不是图片、太大或读不到时返回 undefined。 */
  readInlineImage(projectId: string, relativePath: string): Promise<string | undefined>;
  openWorkspaceFile(projectId: string, relativePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
  setFilePanelWidth(width: number): Promise<void>;
  setThemePreference(theme: DesktopThemePreference): Promise<DesktopThemePreference>;
  setFontPreference(font: DesktopFontPreference): Promise<DesktopFontPreference>;
  createTerminal(projectId: string, cols: number, rows: number): Promise<DesktopTerminalHandle>;
  writeTerminal(terminalId: string, data: string): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  disposeTerminal(terminalId: string): Promise<void>;
  skillCatalog(): Promise<DesktopSkillCatalogSnapshot>;
  readSkillFile(skillId: string, relativePath: string): Promise<DesktopSkillFilePreview>;
  writeSkillFile(skillId: string, relativePath: string, content: string): Promise<void>;
  openSkillDirectory(skillId: string): Promise<void>;
  onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): () => void;
  onAgentEvent(listener: (envelope: DesktopAgentEventEnvelope) => void): () => void;
  onSessionHandoff(listener: (target: DesktopSessionHandoff) => void): () => void;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
}
