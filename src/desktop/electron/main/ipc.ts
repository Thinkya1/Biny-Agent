/**
 * 桌面端 IPC handler 注册。
 *
 * 每个 `desktopIpc` 通道在这里对应一个 handler。渲染进程虽然是自己的代码，但仍按不可信输入
 * 对待：所有参数先过 zod schema 校验（长度、枚举、URL 协议等），再转交给对应服务。
 *
 * 这一层只做「校验 + 转发 + 系统对话框/菜单」，项目、会话、agent 的实际逻辑都在各服务里。
 */
import { spawn } from "node:child_process";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";
import { z } from "zod";
import { modelApiBackendSchema, modelCompatibilitySchema, modelLimitsSchema, modelProviderSchema, providerProtocolSchema, reasoningEffortSchema } from "../../../config/schema.js";
import { clampFontSize } from "../../fontPreference.js";
import type { DesktopBootstrap, DesktopSessionMenuAction, DesktopThemePreference } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";
import { DesktopAgentManager } from "./DesktopAgentManager.js";
import { DesktopBrowserService } from "./DesktopBrowserService.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopSkillService } from "./DesktopSkillService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopTerminalManager } from "./DesktopTerminalManager.js";

interface IpcContext {
  state: DesktopStateStore;
  projects: DesktopProjectService;
  agents: DesktopAgentManager;
  terminals: DesktopTerminalManager;
  browser: DesktopBrowserService;
  skills: DesktopSkillService;
  getWindow(): BrowserWindow | undefined;
  bootstrap(): Promise<DesktopBootstrap>;
}

// 以下 schema 是渲染层参数的唯一入口校验，上限值都刻意给得比正常用法宽松，
// 只用于挡住异常大的输入，不承担业务规则校验。
const idSchema = z.string().min(1).max(240);
const promptSchema = z.string().min(1).max(1_000_000);
const userMessageIndexSchema = z.number().int().nonnegative();
const titleSchema = z.string().trim().min(1).max(120);
const revisionSchema = z.string().max(200).optional();
const configRevisionSchema = z.string().min(1).max(200);
const sessionTreePageOptionsSchema = z.object({
  parentSessionId: idSchema.optional(),
  cursor: z.string().max(4_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  includeArchived: z.boolean().optional()
}).optional();
const permissionModeSchema = z.enum(["ask", "read-only", "auto", "full-access"]);
const terminalSizeSchema = z.number().int().min(2).max(1_000);
const terminalDataSchema = z.string().max(1_000_000);
const thinkingSchema = z.union([z.literal("off"), reasoningEffortSchema]);
const modelLoginProviderSchema = z.enum(["claude-code", "openai-codex"]);
const modelConfigurationSchema = z.object({
  alias: idSchema,
  displayName: z.string().trim().min(1).max(120),
  providerAlias: idSchema,
  providerType: modelProviderSchema,
  protocol: providerProtocolSchema.optional(),
  model: z.string().trim().min(1).max(240),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).max(4_000).optional(),
  apiKeyEnv: z.string().trim().min(1).max(120).optional(),
  requiresApiKey: z.boolean().optional(),
  supportsTools: z.boolean(),
  supportsThinking: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoningStream: z.boolean().optional(),
  reasoningSummary: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(384_000).optional(),
  limits: modelLimitsSchema.optional(),
  apiBackend: modelApiBackendSchema.optional(),
  thinkingLevelMap: z.record(z.string().min(1), z.string().min(1).nullable()).optional(),
  compatibility: modelCompatibilitySchema.optional(),
  makeDefault: z.boolean().optional()
});
const runModeSchema = z.enum(["chat", "plan"]);
const permissionResultSchema = z.object({
  approved: z.boolean(),
  scope: z.enum(["once", "command", "session", "tool", "path"]).optional(),
  nextMode: permissionModeSchema.optional(),
  message: z.string().max(500).optional(),
  confirmation: z.string().max(16).optional()
});
const attachmentSchema = z.object({
  name: z.string().max(240),
  path: z.string().max(2_000),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative().max(50 * 1024 * 1024)
});
// 搜索结果与正文外链可能仍是 http://，交给系统浏览器打开是安全的；其余协议一律拒绝。
const externalUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Only HTTP(S) links can be opened externally.");
const webSearchSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["duckduckgo", "google", "tavily", "brave", "anysearch"]),
  apiKey: z.string().max(4_000).optional(),
  apiKeyEnv: z.string().trim().min(1).max(120).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000),
  maxResults: z.number().int().min(1).max(10)
});
const personalitySchema = z.enum(["none", "friendly", "pragmatic"]);
const customInstructionsSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= 4_096,
  "Custom instructions must not exceed 4 KiB."
);
const chatPersonalizationSchema = z.object({
  personality: z.union([z.literal("inherit"), personalitySchema]),
  customInstructions: z.object({
    mode: z.enum(["inherit", "replace", "disabled"]),
    value: customInstructionsSchema.optional()
  }).strict(),
  useMemories: z.union([z.literal("inherit"), z.boolean()]),
  contributeMemories: z.union([z.literal("inherit"), z.boolean()])
}).strict();
const memoryScopeSchema = z.enum(["global", "project"]);
const memorySettingsSchema = z.object({
  useMemories: z.boolean(),
  generateMemories: z.boolean(),
  maxRecalled: z.number().int().min(1).max(20),
  extractModel: z.string().trim().min(1).max(240).optional(),
  consolidationModel: z.string().trim().min(1).max(240).optional(),
  excludeExternalContext: z.boolean()
}).strict();
const personalizationSettingsSchema = z.object({
  expectedRevision: configRevisionSchema,
  settings: z.object({
    enabled: z.boolean(),
    personality: personalitySchema,
    customInstructions: customInstructionsSchema
  }).strict(),
  memory: memorySettingsSchema
}).strict();
const memoryTopicSchema = z.string().trim().min(1).max(64);
const memoryNoteSchema = z.string().trim().min(1).max(4_000);
const memoryQuerySchema = z.string().trim().min(1).max(2_000);
const memoryEntryIdSchema = z.string().min(1).max(512);
const memoryRevisionSchema = z.number().int().nonnegative();
const memorySettingsInputSchema = z.object({
  expectedRevision: configRevisionSchema,
  settings: memorySettingsSchema
}).strict();
const memoryEntryInputSchema = z.object({
  topic: memoryTopicSchema,
  note: memoryNoteSchema,
  kind: z.enum(["preference", "working_style", "fact", "decision", "workflow", "gotcha"]),
  importance: z.number().int().min(1).max(5)
}).strict();
const runtimeMutationSchema = z.enum([
  "task.create", "task.start", "task.cancel", "task.approve", "task.resume", "task.retry",
  "automation.create", "automation.pause", "automation.resume", "automation.run", "automation.delete",
  "goal.create", "goal.pause", "goal.resume", "goal.cancel",
  "graph.create", "graph.start", "graph.pause", "graph.resume", "graph.cancel",
  "capability.register", "capability.replace", "capability.admit", "capability.reject", "capability.release",
  "capability.invoke", "capability.accept", "capability.start", "capability.result", "capability.chunk", "capability.fail", "capability.cancel"
]);
const runtimePayloadSchema = z.record(z.unknown()).optional();
const skillIdSchema = z.string().trim().min(1).max(128);
const skillFilePathSchema = z.string().trim().min(1).max(2_000);
const skillFileContentSchema = z.string().max(512 * 1024);

export function registerDesktopIpc(context: IpcContext): void {
  handle(desktopIpc.bootstrap, async () => await context.bootstrap());

  handle(desktopIpc.openProject, async () => {
    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: "打开 Biny 项目",
      buttonLabel: "打开项目",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const projectPath = result.filePaths[0];
    if (result.canceled || !projectPath) return undefined;
    const project = await context.projects.createProject(projectPath);
    return await context.agents.workspaceSnapshot(project.id);
  });

  handle(desktopIpc.createEmptyProject, async () => {
    const window = context.getWindow();
    const options: SaveDialogOptions = {
      title: "新建 Biny 项目",
      buttonLabel: "创建项目",
      defaultPath: "Biny 项目",
      properties: ["createDirectory", "showOverwriteConfirmation"]
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    const project = await context.projects.createEmptyProject(result.filePath);
    return await context.agents.workspaceSnapshot(project.id);
  });

  handle(desktopIpc.selectProject, async (_event, projectId: unknown) => {
    return await context.agents.workspaceSnapshot(idSchema.parse(projectId));
  });

  handle(desktopIpc.commitSelection, async (_event, projectId: unknown, sessionId: unknown) => {
    await context.state.commitSelection(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId)
    );
  });

  handle(desktopIpc.setProjectPinned, async (_event, projectId: unknown, pinned: unknown) => {
    return await context.agents.setProjectPinned(idSchema.parse(projectId), z.boolean().parse(pinned));
  });

  handle(desktopIpc.reorderProjects, async (_event, projectIds: unknown) => {
    const ids = z.array(idSchema).parse(projectIds);
    await context.state.reorderProjects(ids);
    return context.state.projects();
  });

  handle(desktopIpc.renameProject, async (_event, projectId: unknown, name: unknown) => {
    return await context.agents.renameProject(idSchema.parse(projectId), titleSchema.parse(name));
  });

  handle(desktopIpc.removeProject, async (_event, projectId: unknown) => {
    const id = idSchema.parse(projectId);
    if (context.agents.isProjectRunning(id)) throw new Error("Stop the running task before removing this project from the sidebar.");
    await context.agents.disposeProject(id);
    await context.state.removeProject(id);
    return await context.bootstrap();
  });

  handle(desktopIpc.refreshProject, async (_event, projectId: unknown) => {
    return await context.agents.workspaceSnapshot(idSchema.parse(projectId));
  });

  handle(desktopIpc.revealProject, async (_event, projectId: unknown) => {
    shell.showItemInFolder(context.projects.requireProject(idSchema.parse(projectId)).path);
  });

  handle(desktopIpc.openProjectTerminal, async (_event, projectId: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    const child = spawn("/usr/bin/open", ["-a", "Terminal", project.path], { detached: true, stdio: "ignore" });
    child.unref();
  });

  handle(desktopIpc.createTerminal, async (_event, projectId: unknown, cols: unknown, rows: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    if (project.missing) throw new Error("项目目录不可用，无法打开终端。");
    return await context.terminals.create(project.id, project.path, terminalSizeSchema.parse(cols), terminalSizeSchema.parse(rows));
  });

  // 键盘输入和窗口尺寸走 fire-and-forget 的 send 通道，省掉 invoke 往返延迟。
  ipcMain.on(desktopIpc.writeTerminal, (_event, terminalId: unknown, data: unknown) => {
    const parsedId = idSchema.safeParse(terminalId);
    const parsedData = terminalDataSchema.safeParse(data);
    if (parsedId.success && parsedData.success) context.terminals.write(parsedId.data, parsedData.data);
  });

  ipcMain.on(desktopIpc.resizeTerminal, (_event, terminalId: unknown, cols: unknown, rows: unknown) => {
    const parsedId = idSchema.safeParse(terminalId);
    const parsedCols = terminalSizeSchema.safeParse(cols);
    const parsedRows = terminalSizeSchema.safeParse(rows);
    if (parsedId.success && parsedCols.success && parsedRows.success) context.terminals.resize(parsedId.data, parsedCols.data, parsedRows.data);
  });

  handle(desktopIpc.disposeTerminal, async (_event, terminalId: unknown) => {
    context.terminals.dispose(idSchema.parse(terminalId));
  });

  handle(desktopIpc.startDraft, async (_event, projectId: unknown) => {
    return await context.agents.startDraft(idSchema.parse(projectId));
  });

  handle(desktopIpc.openSession, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.openSession(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.listSessionTreePage, async (_event, projectId: unknown, options: unknown) => {
    return await context.agents.listSessionTreePage(idSchema.parse(projectId), sessionTreePageOptionsSchema.parse(options) ?? {});
  });

  handle(desktopIpc.renameSession, async (_event, projectId: unknown, sessionId: unknown, title: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.renameSession(parsedProjectId, idSchema.parse(sessionId), titleSchema.parse(title), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.pinSession, async (_event, projectId: unknown, sessionId: unknown, pinned: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.pinSession(parsedProjectId, idSchema.parse(sessionId), z.boolean().parse(pinned), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.archiveSession, async (_event, projectId: unknown, sessionId: unknown, archived: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.archiveSession(parsedProjectId, idSchema.parse(sessionId), z.boolean().parse(archived), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.markSessionRead, async (_event, projectId: unknown, sessionId: unknown, expectedRevision: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    return await context.agents.markSessionRead(parsedProjectId, idSchema.parse(sessionId), revisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.duplicateSession, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.duplicateSession(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.deleteSession, async (_event, projectId: unknown, sessionId: unknown) => {
    const parsedProjectId = idSchema.parse(projectId);
    const parsedSessionId = idSchema.parse(sessionId);
    const options: MessageBoxOptions = {
      type: "warning",
      title: "删除会话",
      message: "确定要删除这个会话吗？",
      detail: "会删除全局项目会话目录中对应的 JSONL 文件，但不会删除项目文件。此操作无法撤销。",
      buttons: ["删除", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const window = context.getWindow();
    const confirmation = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return await context.agents.workspaceSnapshot(parsedProjectId);
    return await context.agents.deleteSession(parsedProjectId, parsedSessionId);
  });

  handle(desktopIpc.sessionMenu, async (_event, projectId: unknown, sessionId: unknown, pinned: unknown, archived: unknown) => {
    idSchema.parse(projectId);
    idSchema.parse(sessionId);
    return await showSessionMenu(context.getWindow(), z.boolean().parse(pinned), z.boolean().optional().default(false).parse(archived));
  });

  handle(desktopIpc.sendPrompt, async (_event, projectId: unknown, sessionId: unknown, input: unknown, mode: unknown, attachments: unknown, delivery: unknown) => {
    return await context.agents.sendPrompt(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId),
      promptSchema.parse(input),
      runModeSchema.parse(mode),
      z.array(attachmentSchema).max(20).parse(attachments),
      z.enum(["steer", "followUp"]).optional().parse(delivery)
    );
  });

  handle(desktopIpc.resumeInterruptedTurn, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.resumeInterruptedTurn(idSchema.parse(projectId), idSchema.parse(sessionId));
  });

  handle(desktopIpc.editPrompt, async (_event, projectId: unknown, sessionId: unknown, userMessageIndex: unknown, input: unknown, mode: unknown, attachments: unknown) => {
    return await context.agents.editPrompt(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      userMessageIndexSchema.parse(userMessageIndex),
      promptSchema.parse(input),
      runModeSchema.parse(mode),
      z.array(attachmentSchema).max(20).parse(attachments)
    );
  });

  handle(desktopIpc.cancelRun, async (_event, projectId: unknown, runId: unknown) => {
    await context.agents.cancelRun(idSchema.parse(projectId), idSchema.parse(runId));
  });

  handle(desktopIpc.runSlashCommand, async (_event, projectId: unknown, sessionId: unknown, command: unknown) => {
    return await context.agents.runSlashCommand(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId),
      z.string().trim().min(1).max(200).parse(command)
    );
  });

  handle(desktopIpc.resolvePermission, async (_event, projectId: unknown, requestId: unknown, result: unknown) => {
    await context.agents.resolvePermission(idSchema.parse(projectId), idSchema.parse(requestId), permissionResultSchema.parse(result));
  });

  handle(desktopIpc.setPermissionMode, async (_event, projectId: unknown, mode: unknown) => {
    return await context.agents.setPermissionMode(idSchema.parse(projectId), permissionModeSchema.parse(mode));
  });

  handle(desktopIpc.switchModel, async (_event, projectId: unknown, alias: unknown, thinking: unknown) => {
    return await context.agents.switchModel(idSchema.parse(projectId), idSchema.parse(alias), thinkingSchema.parse(thinking));
  });

  handle(desktopIpc.saveModelConfiguration, async (_event, projectId: unknown, configuration: unknown) => {
    return await context.agents.saveModelConfiguration(idSchema.parse(projectId), modelConfigurationSchema.parse(configuration));
  });

  handle(desktopIpc.testModelConfiguration, async (_event, projectId: unknown, configuration: unknown) => {
    return await context.agents.testModelConfiguration(idSchema.parse(projectId), modelConfigurationSchema.parse(configuration));
  });

  handle(desktopIpc.removeModelConfiguration, async (_event, projectId: unknown, alias: unknown) => {
    return await context.agents.removeModelConfiguration(idSchema.parse(projectId), idSchema.parse(alias));
  });

  handle(desktopIpc.fetchModelCatalog, async (_event, projectId: unknown, providerAlias: unknown) => {
    return await context.agents.fetchModelCatalog(idSchema.parse(projectId), idSchema.parse(providerAlias));
  });

  handle(desktopIpc.startModelLogin, async (_event, projectId: unknown, provider: unknown) => {
    return await context.agents.startModelLogin(idSchema.parse(projectId), modelLoginProviderSchema.parse(provider));
  });

  handle(desktopIpc.completeModelLogin, async (_event, projectId: unknown, provider: unknown, authRequestId: unknown, pastedAuthorization: unknown) => {
    return await context.agents.completeModelLogin(
      idSchema.parse(projectId),
      modelLoginProviderSchema.parse(provider),
      idSchema.parse(authRequestId),
      pastedAuthorization === undefined ? undefined : z.string().max(16_000).parse(pastedAuthorization)
    );
  });

  handle(desktopIpc.cancelModelLogin, async (_event, projectId: unknown, provider: unknown, authRequestId: unknown) => {
    await context.agents.cancelModelLogin(idSchema.parse(projectId), modelLoginProviderSchema.parse(provider), idSchema.parse(authRequestId));
  });

  handle(desktopIpc.compact, async (_event, projectId: unknown, hint: unknown) => {
    return await context.agents.compact(idSchema.parse(projectId), hint === undefined ? undefined : z.string().max(2_000).parse(hint));
  });

  handle(desktopIpc.runtimeProjection, async (_event, projectId: unknown) => {
    return await context.agents.runtimeProjection(idSchema.parse(projectId));
  });

  handle(desktopIpc.runtimeMutation, async (_event, projectId: unknown, operation: unknown, payload: unknown) => {
    return await context.agents.runtimeMutation(
      idSchema.parse(projectId),
      runtimeMutationSchema.parse(operation),
      runtimePayloadSchema.parse(payload) ?? {}
    );
  });

  handle(desktopIpc.runtimeEvents, async (_event, projectId: unknown, afterSequence: unknown, limit: unknown) => {
    return await context.agents.runtimeEvents(
      idSchema.parse(projectId),
      afterSequence === undefined ? undefined : z.number().int().nonnegative().parse(afterSequence),
      limit === undefined ? undefined : z.number().int().min(1).max(1_000).parse(limit)
    );
  });

  handle(desktopIpc.webSearchSettings, async (_event, projectId: unknown) => {
    return await context.agents.webSearchSettings(idSchema.parse(projectId));
  });

  handle(desktopIpc.saveWebSearchSettings, async (_event, projectId: unknown, input: unknown) => {
    return await context.agents.saveWebSearchSettings(idSchema.parse(projectId), webSearchSettingsSchema.parse(input));
  });

  handle(desktopIpc.openBrowser, async (_event, url: unknown) => {
    await context.browser.open(url === undefined ? undefined : externalUrlSchema.parse(url));
  });

  handle(desktopIpc.cookieJarStatus, async () => await context.browser.status());

  handle(desktopIpc.exportCookies, async () => await context.browser.exportToFile(context.getWindow()));

  handle(desktopIpc.importCookies, async () => await context.browser.importFromFile(context.getWindow()));

  handle(desktopIpc.clearCookies, async () => {
    const options: MessageBoxOptions = {
      type: "warning",
      title: "清除 Cookie",
      message: "确定要清除全部 Cookie 吗？",
      detail: "浏览器窗口和 agent 工具都会退出所有已登录的网站。此操作无法撤销。",
      buttons: ["清除", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const window = context.getWindow();
    const confirmation = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return await context.browser.status();
    return await context.browser.clear();
  });

  handle(desktopIpc.personalizationOverview, async (_event, projectId: unknown, sessionId: unknown) => {
    return await context.agents.personalizationOverview(
      idSchema.parse(projectId),
      sessionId === undefined ? undefined : idSchema.parse(sessionId)
    );
  });

  handle(desktopIpc.savePersonalizationSettings, async (_event, projectId: unknown, input: unknown) => {
    return await context.agents.savePersonalizationSettings(
      idSchema.parse(projectId),
      personalizationSettingsSchema.parse(input)
    );
  });

  handle(desktopIpc.saveChatPersonalization, async (_event, projectId: unknown, sessionId: unknown, input: unknown, expectedRevision: unknown) => {
    return await context.agents.saveChatPersonalization(
      idSchema.parse(projectId),
      idSchema.parse(sessionId),
      chatPersonalizationSchema.parse(input),
      configRevisionSchema.parse(expectedRevision)
    );
  });

  handle(desktopIpc.memoryOverview, async (_event, projectId: unknown, scope: unknown) => {
    return await context.agents.memoryOverview(idSchema.parse(projectId), memoryScopeSchema.parse(scope));
  });

  handle(desktopIpc.saveMemorySettings, async (_event, projectId: unknown, input: unknown) => {
    return await context.agents.saveMemorySettings(idSchema.parse(projectId), memorySettingsInputSchema.parse(input));
  });

  handle(desktopIpc.searchMemory, async (_event, projectId: unknown, scope: unknown, query: unknown) => {
    return await context.agents.searchMemory(idSchema.parse(projectId), memoryScopeSchema.parse(scope), memoryQuerySchema.parse(query));
  });

  handle(desktopIpc.addMemoryEntry, async (_event, projectId: unknown, scope: unknown, input: unknown, expectedRevision: unknown) => {
    return await context.agents.addMemoryEntry(
      idSchema.parse(projectId),
      memoryScopeSchema.parse(scope),
      memoryEntryInputSchema.parse(input),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handle(desktopIpc.deleteMemoryEntry, async (_event, projectId: unknown, scope: unknown, entryId: unknown, expectedRevision: unknown) => {
    return await context.agents.deleteMemoryEntry(
      idSchema.parse(projectId),
      memoryScopeSchema.parse(scope),
      memoryEntryIdSchema.parse(entryId),
      memoryRevisionSchema.parse(expectedRevision)
    );
  });

  handle(desktopIpc.clearMemory, async (_event, projectId: unknown, scope: unknown, expectedRevision: unknown) => {
    return await context.agents.clearMemory(idSchema.parse(projectId), memoryScopeSchema.parse(scope), memoryRevisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.compactMemory, async (_event, projectId: unknown, scope: unknown, expectedRevision: unknown) => {
    return await context.agents.compactMemory(idSchema.parse(projectId), memoryScopeSchema.parse(scope), memoryRevisionSchema.parse(expectedRevision));
  });

  handle(desktopIpc.saveAttachment, async (_event, projectId: unknown, name: unknown, mimeType: unknown, bytes: unknown) => {
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength > 50 * 1024 * 1024) throw new Error("Attachment is invalid or larger than 50 MB.");
    return await context.projects.saveAttachment(
      context.projects.requireProject(idSchema.parse(projectId)),
      z.string().min(1).max(240).parse(name),
      z.string().max(200).parse(mimeType),
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    );
  });

  handle(desktopIpc.readWorkspaceFile, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.readWorkspaceFile(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.readInlineImage, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.readInlineImage(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.listWorkspaceDirectory, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    return await context.projects.listWorkspaceDirectory(project, z.string().min(1).max(2_000).parse(relativePath));
  });

  handle(desktopIpc.openWorkspaceFile, async (_event, projectId: unknown, relativePath: unknown) => {
    const project = context.projects.requireProject(idSchema.parse(projectId));
    const filePath = context.projects.workspaceFile(project, z.string().min(1).max(2_000).parse(relativePath));
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });

  handle(desktopIpc.skillCatalog, async () => await context.skills.snapshot());

  handle(desktopIpc.skillFileRead, async (_event, skillId: unknown, relativePath: unknown) => {
    return await context.skills.readFile(skillIdSchema.parse(skillId), skillFilePathSchema.parse(relativePath));
  });

  handle(desktopIpc.skillFileWrite, async (_event, skillId: unknown, relativePath: unknown, content: unknown) => {
    await context.skills.writeFile(
      skillIdSchema.parse(skillId),
      skillFilePathSchema.parse(relativePath),
      skillFileContentSchema.parse(content)
    );
  });

  handle(desktopIpc.skillOpenDirectory, async (_event, skillId: unknown) => {
    const error = await shell.openPath(await context.skills.directory(skillIdSchema.parse(skillId)));
    if (error) throw new Error(error);
  });

  handle(desktopIpc.openExternal, async (_event, url: unknown) => {
    await shell.openExternal(externalUrlSchema.parse(url));
  });

  handle(desktopIpc.setSidebarWidth, async (_event, width: unknown) => {
    await context.state.setSidebarWidth(z.number().finite().parse(width));
  });

  handle(desktopIpc.setFilePanelWidth, async (_event, width: unknown) => {
    await context.state.setFilePanelWidth(z.number().finite().parse(width));
  });

  handle(desktopIpc.setThemePreference, async (_event, theme: unknown) => {
    const preference = z.enum(["system", "light", "dark"]).parse(theme);
    await context.state.setThemePreference(preference);
    applyNativeThemePreference(preference);
    const window = context.getWindow();
    if (window && !window.isDestroyed()) {
      window.setBackgroundColor(themeBackgroundColor(preference));
    }
    return preference;
  });

  handle(desktopIpc.setFontPreference, async (_event, font: unknown) => {
    const parsed = z.object({ family: z.string().min(1).max(100), size: z.number().finite() }).parse(font);
    const preference = { family: parsed.family, size: clampFontSize(parsed.size) };
    await context.state.setFontPreference(preference);
    return preference;
  });
}

function applyNativeThemePreference(preference: DesktopThemePreference): void {
  nativeTheme.themeSource = preference;
}

function themeBackgroundColor(preference: DesktopThemePreference): string {
  const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#181818" : "#ffffff";
}

/** 先移除同名 handler 再注册：重复注册会被 Electron 直接拒绝（开发期热重载会遇到）。 */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

/**
 * 弹出会话右键菜单并返回用户选择。
 *
 * Electron 的菜单项 click 与关闭回调是分开的：click 只记下选择，等 popup 的 callback 触发
 * （菜单真正关闭）才 resolve，所以直接点空白处关闭会得到 undefined。
 */
async function showSessionMenu(window: BrowserWindow | undefined, pinned: boolean, archived: boolean): Promise<DesktopSessionMenuAction | undefined> {
  return await new Promise((resolve) => {
    let selected: DesktopSessionMenuAction | undefined;
    const choose = (action: DesktopSessionMenuAction): void => {
      selected = action;
    };
    const template: MenuItemConstructorOptions[] = [
      { label: "重命名", click: () => choose("rename") },
      { label: pinned ? "取消置顶" : "置顶", click: () => choose(pinned ? "unpin" : "pin") },
      { label: archived ? "取消归档" : "归档", click: () => choose(archived ? "unarchive" : "archive") },
      { label: "复制会话", click: () => choose("duplicate") },
      { type: "separator" },
      { label: "删除", click: () => choose("delete") }
    ];
    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => resolve(selected)
    });
  });
}
