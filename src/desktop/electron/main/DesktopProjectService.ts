/**
 * 桌面端项目与会话服务。
 *
 * 负责项目的增删改查、git 分支/脏状态探测、会话列表与复制/删除/分叉、附件保存，以及工作区
 * 文件浏览。IPC 层只做参数转发，实际的文件系统和 session 操作都在这里。
 *
 * 所有工作区路径都经过 `resolveWorkspacePath` / `resolveWorkspaceDirectory` 收敛，渲染层传来的
 * 相对路径不能逃出项目目录。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentConfigStore } from "../../../config/store.js";
import { listModelChoices, type ModelChoice } from "../../../llm/ModelManager.js";
import {
  activeRun,
  isTerminalRunEvent,
  pendingPermission,
  type AgentHostEvent,
  type InteractiveRuntimeSnapshot
} from "../../../runtime/agentEvents.js";
import { readStoredSessionEvents } from "../../../session/events.js";
import {
  listSessionCatalog,
  querySessionCatalog,
  querySessionCatalogItems,
  readSessionCatalogRecord,
  registerSessionBranch,
  sessionCatalogRecordRevision,
  updateSessionCatalogMetadata,
  type SessionCatalogItem,
  type SessionCatalogMetadataPatch,
  type SessionCatalogQuery,
  type SessionCatalogRecord
} from "../../../session/catalog.js";
import { deleteSessionArtifacts } from "../../../session/cleanup.js";
import { createSessionId, type SessionTurnStatus } from "../../../session/recorder.js";
import { SessionRunLedger, type SessionRunRecord } from "../../../session/runLedger.js";
import { createSessionFile, duplicateSessionFile, ensureAgentDirs } from "../../../session/store.js";
import { gitInspectionEnvironment } from "../../../tools/git/environment.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../../../workspace/resolvePath.js";
import { attachmentFilePath, attachmentPathPrefix, saveAttachment as saveProjectAttachment } from "../../../attachments/store.js";
import type {
  DesktopAttachment,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionTreePage,
  DesktopSessionTreePageOptions,
  DesktopSessionStatus,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceDirectoryEntry,
  DesktopSessionSummary,
  DesktopWorkspaceFilePreview
} from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopUserDataStore } from "./DesktopUserDataStore.js";

const execFileAsync = promisify(execFile);
const filePreviewLimit = 512 * 1024;
/** 内联图片要整张塞进 data URL，超过这个大小就不给了，免得 IPC 和 DOM 里挂着几十兆的 base64。 */
const inlineImageLimit = 8 * 1024 * 1024;
const imageMediaTypes: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp"
};

export class DesktopProjectService {
  constructor(
    private readonly state: DesktopStateStore,
    private readonly storage: DesktopUserDataStore,
    private readonly configStore: AgentConfigStore
  ) {}

  /**
   * 打开（或重新打开）一个项目目录。同一路径已存在时沿用原有 id、名称、置顶状态和加入时间，
   * 只更新最后打开时间，这样重复打开不会变成一个新项目、也不会丢掉用户改过的名字。
   */
  async createProject(projectPath: string): Promise<DesktopProject> {
    const resolvedPath = path.resolve(projectPath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) throw new Error("Selected project path is not a directory.");
    const existing = this.state.projects().find((project) => project.path === resolvedPath);
    const now = new Date().toISOString();
    const project = await this.inspectProject({
      id: existing?.id ?? projectId(resolvedPath),
      path: resolvedPath,
      name: existing?.name ?? path.basename(resolvedPath),
      branch: existing?.branch,
      dirty: existing?.dirty ?? false,
      missing: false,
      pinned: existing?.pinned ?? false,
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now
    });
    await this.storage.ensureProjectData(project);
    await this.state.upsertProject(project);
    return project;
  }

  async createEmptyProject(projectPath: string): Promise<DesktopProject> {
    const resolvedPath = path.resolve(projectPath);
    try {
      await fs.mkdir(resolvedPath);
    } catch (error) {
      if (isAlreadyExists(error)) throw new Error("项目文件夹已存在，请选择其他名称。");
      throw error;
    }
    return await this.createProject(resolvedPath);
  }

  /**
   * 刷新项目的实时信息（分支、是否有未提交改动）。目录已不存在时标记 `missing` 但保留记录，
   * 让用户能在列表里看到并自行移除，而不是悄悄消失。
   */
  async inspectProject(project: DesktopProject): Promise<DesktopProject> {
    const missing = !await directoryExists(project.path);
    if (missing) return { ...project, branch: undefined, dirty: false, missing: true };
    const [branch, status] = await Promise.all([
      gitOutput(project.path, ["branch", "--show-current"]),
      gitOutput(project.path, ["status", "--porcelain", "--ignore-submodules=all"])
    ]);
    return {
      ...project,
      branch: branch?.trim() || undefined,
      dirty: Boolean(status?.trim()),
      missing: false
    };
  }

  async refreshStoredProject(projectIdValue: string): Promise<DesktopProject> {
    const project = this.requireProject(projectIdValue);
    const refreshed = await this.inspectProject(project);
    await this.state.upsertProject(refreshed);
    return refreshed;
  }

  async refreshAllProjects(): Promise<DesktopProject[]> {
    const activeProjectId = this.state.activeProjectId();
    const projects = await Promise.all(this.state.projects().map(async (project) => await this.inspectProject(project)));
    await Promise.all(projects.map(async (project) => await this.state.upsertProject(project)));
    if (activeProjectId) await this.state.setActiveProject(activeProjectId);
    return projects;
  }

  async listModels(project: DesktopProject): Promise<ModelChoice[]> {
    return listModelChoices(await this.configStore.load(project.path));
  }

  async listSessions(
    project: DesktopProject,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>
  ): Promise<DesktopSessionSummary[]> {
    if (project.missing) return [];
    const dataRoot = await this.storage.ensureProjectData(project);
    await ensureAgentDirs(dataRoot);
    const catalog = await listSessionCatalog(dataRoot);
    const runLedger = new SessionRunLedger(dataRoot);
    const latestRunBySession = await runLedger.latestSessionRuns(catalog.map((item) => item.id));
    return await this.buildSessionSummaries(project, catalog, runtime, liveEvents, latestRunBySession, runLedger);
  }

  /** workspace 首屏同时需要完整摘要和分页页，复用同一份 catalog/ledger 读取结果。 */
  async listWorkspaceSessions(
    project: DesktopProject,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>
  ): Promise<{ sessions: DesktopSessionSummary[]; sessionPage: DesktopSessionTreePage }> {
    if (project.missing) {
      return {
        sessions: [],
        sessionPage: {
          projectId: project.id,
          parentSessionId: undefined,
          revision: "sha256:empty",
          sessions: [],
          nextCursor: undefined,
          revisionChanged: false
        }
      };
    }
    const dataRoot = await this.storage.ensureProjectData(project);
    await ensureAgentDirs(dataRoot);
    const catalog = await listSessionCatalog(dataRoot);
    const runLedger = new SessionRunLedger(dataRoot);
    const latestRunBySession = await runLedger.latestSessionRuns(catalog.map((item) => item.id));
    const sessions = await this.buildSessionSummaries(project, catalog, runtime, liveEvents, latestRunBySession, runLedger);
    const page = querySessionCatalogItems(catalog);
    const pageSessions = page.items.map((item) => desktopSessionSummary(
      project.id,
      item,
      runtime,
      liveEvents,
      latestRunBySession.get(item.id)
    ));
    return {
      sessions,
      sessionPage: {
        projectId: project.id,
        parentSessionId: undefined,
        revision: page.revision,
        sessions: pageSessions,
        nextCursor: page.nextCursor,
        revisionChanged: page.revisionChanged
      }
    };
  }

  /** 只读取某一层的一个页面；子节点由 Renderer 在展开父节点时再请求。 */
  async listSessionTreePage(
    project: DesktopProject,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>,
    options: DesktopSessionTreePageOptions = {}
  ): Promise<DesktopSessionTreePage> {
    if (project.missing) {
      return {
        projectId: project.id,
        parentSessionId: options.parentSessionId,
        revision: "sha256:empty",
        sessions: [],
        nextCursor: undefined,
        revisionChanged: false
      };
    }
    const dataRoot = await this.storage.ensureProjectData(project);
    await ensureAgentDirs(dataRoot);
    const page = await querySessionCatalog(dataRoot, options satisfies SessionCatalogQuery);
    const runLedger = new SessionRunLedger(dataRoot);
    const latestRunBySession = await runLedger.latestSessionRuns(page.items.map((item) => item.id));
    const latestRuns = page.items.map((item) => latestRunBySession.get(item.id));
    const sessions = page.items.map((item, index) => desktopSessionSummary(
      project.id,
      item,
      runtime,
      liveEvents,
      latestRuns[index]
    ));
    return {
      projectId: project.id,
      parentSessionId: options.parentSessionId,
      revision: page.revision,
      sessions,
      nextCursor: page.nextCursor,
      revisionChanged: page.revisionChanged
    };
  }

  private async buildSessionSummaries(
    project: DesktopProject,
    catalog: SessionCatalogItem[],
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>,
    latestRunBySession: ReadonlyMap<string, SessionRunRecord>,
    runLedger: SessionRunLedger
  ): Promise<DesktopSessionSummary[]> {
    const sessions = catalog.map((item) => desktopSessionSummary(
      project.id,
      item,
      runtime,
      liveEvents,
      latestRunBySession.get(item.id)
    ));
    const runtimeInfo = runtime?.info;
    const runtimeEvents = runtimeInfo ? liveEvents.get(runtimeInfo.sessionId) : undefined;
    if (runtimeInfo && runtimeEvents?.some((event) => event.type === "message.user") && !sessions.some((session) => session.id === runtimeInfo.sessionId)) {
      const runtimeLatestRun = latestRunBySession.get(runtimeInfo.sessionId) ?? await runLedger.latestSessionRun(runtimeInfo.sessionId);
      const now = new Date().toISOString();
      sessions.push({
        id: runtimeInfo.sessionId,
        projectId: project.id,
        fileName: path.basename(runtimeInfo.sessionFile),
        title: "新任务",
        firstUserMessage: "",
        lastAssistantMessage: "",
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        archived: false,
        unread: false,
        labels: undefined,
        metadataRevision: undefined,
        personalization: undefined,
        hasChildren: false,
        rootSessionId: runtimeInfo.sessionId,
        parentSessionId: undefined,
        branchPoint: undefined,
        latestRun: runtimeLatestRun ? desktopRunSummary(runtimeLatestRun) : undefined,
        status: sessionStatus(runtimeInfo.sessionId, "", undefined, runtime, liveEvents.get(runtimeInfo.sessionId), runtimeLatestRun?.status),
        resumable: undefined
      });
    }
    return [...sessions].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }

  async openSession(
    project: DesktopProject,
    sessionId: string,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>
  ): Promise<DesktopSessionDocument> {
    if (project.missing) throw new Error(`Session not found: ${sessionId}`);
    const dataRoot = await this.storage.ensureProjectData(project);
    await ensureAgentDirs(dataRoot);
    const stored = await readStoredSessionEvents(dataRoot, sessionId).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    const summary = stored?.summary;
    if (!summary) throw new Error(`Session not found: ${sessionId}`);
    const catalogRecord = await readSessionCatalogRecord(dataRoot, sessionId);
    const item: SessionCatalogItem = {
      id: sessionId,
      fileName: summary.fileName,
      summary,
      rootSessionId: catalogRecord?.rootSessionId ?? sessionId,
      parentSessionId: catalogRecord?.parentSessionId,
      branchPoint: catalogRecord?.branchPoint,
      title: catalogRecord?.title,
      pinned: catalogRecord?.pinned,
      archived: catalogRecord?.archived,
      unread: catalogRecord?.unread,
      labels: catalogRecord?.labels,
      personalization: catalogRecord?.personalization,
      metadataRevision: catalogRecord === undefined ? undefined : sessionCatalogRecordRevision(catalogRecord),
      hasChildren: false
    };
    // latestRun 只用于侧栏批量投影；打开正文不再为一个 session 扫描整个 run ledger。
    // 正文状态由 JSONL 的 turn_status 与当前 live events 投影，运行中的实时状态仍优先。
    const session = desktopSessionSummary(
      project.id,
      item,
      runtime,
      liveEvents,
      undefined,
      undefined
    );
    return {
      session,
      events: stored.events,
      liveEvents: [...(liveEvents.get(sessionId) ?? [])]
    };
  }

  async updateSessionMetadata(
    project: DesktopProject,
    sessionId: string,
    patch: SessionCatalogMetadataPatch,
    expectedRevision?: string
  ): Promise<SessionCatalogRecord> {
    const dataRoot = await this.storage.ensureProjectData(project);
    return await updateSessionCatalogMetadata(dataRoot, sessionId, patch, expectedRevision);
  }

  async markSessionRead(project: DesktopProject, sessionId: string, expectedRevision?: string): Promise<SessionCatalogRecord> {
    return await this.updateSessionMetadata(project, sessionId, { unread: false }, expectedRevision);
  }

  async duplicateSession(project: DesktopProject, sessionId: string): Promise<string> {
    const targetSessionId = createSessionId();
    const dataRoot = await this.storage.ensureProjectData(project);
    await duplicateSessionFile(dataRoot, sessionId, targetSessionId);
    const sourceCatalog = (await listSessionCatalog(dataRoot)).find((item) => item.id === sessionId);
    await registerSessionBranch(dataRoot, {
      sessionId: targetSessionId,
      parentSessionId: sessionId,
      branchPoint: { kind: "event", index: sourceCatalog?.summary.eventCount ?? 0 }
    });
    await this.copyCatalogMetadata(dataRoot, sourceCatalog, targetSessionId);
    return targetSessionId;
  }

  /**
   * 在第 N 条用户消息处分叉出一个新会话，用于「编辑并重发」：新会话只保留该消息之前的事件，
   * 原会话保持不变。`userMessageIndex` 是用户消息的序号（不是事件下标），因为界面上只看得到
   * 用户消息。
   */
  async forkSessionAtUserMessage(project: DesktopProject, sessionId: string, userMessageIndex: number): Promise<string> {
    const dataRoot = await this.storage.ensureProjectData(project);
    const events = await readStoredSessionEvents(dataRoot, sessionId).then((result) => result.events);
    const userEventIndices = events.flatMap((event, index) => event.type === "user_message" ? [index] : []);
    const targetEventIndex = userEventIndices[userMessageIndex];
    if (targetEventIndex === undefined) throw new Error("要编辑的消息已不在当前会话中。");
    const targetSessionId = createSessionId();
    const prefix = events.slice(0, targetEventIndex);
    const content = prefix.length ? `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    await createSessionFile(dataRoot, targetSessionId, Buffer.from(content, "utf8"));
    const targetEvent = events[targetEventIndex];
    await registerSessionBranch(dataRoot, {
      sessionId: targetSessionId,
      parentSessionId: sessionId,
      branchPoint: {
        kind: "user_message",
        index: userMessageIndex,
        messageId: targetEvent?.type === "user_message" ? targetEvent.messageId : undefined
      }
    });
    const sourceCatalog = (await listSessionCatalog(dataRoot)).find((item) => item.id === sessionId);
    await this.copyCatalogMetadata(dataRoot, sourceCatalog, targetSessionId);
    return targetSessionId;
  }

  async deleteSession(project: DesktopProject, sessionId: string): Promise<void> {
    const dataRoot = await this.storage.ensureProjectData(project);
    await deleteSessionArtifacts(dataRoot, sessionId);
    if (this.state.selectedSessionId(project.id) === sessionId) {
      await this.state.setSelectedSession(project.id, undefined);
    }
  }

  private async copyCatalogMetadata(
    dataRoot: string,
    source: SessionCatalogItem | undefined,
    targetSessionId: string
  ): Promise<void> {
    await updateSessionCatalogMetadata(dataRoot, targetSessionId, {
      title: source?.title === undefined ? undefined : `${source.title} 副本`,
      pinned: false,
      archived: false,
      unread: false,
      labels: source?.labels === undefined ? undefined : [...source.labels]
    });
  }

  /**
   * 保存附件到项目的附件目录。文件名先做安全化处理，再加时间戳和随机串前缀，
   * 既避免同名覆盖，也避免用户提供的名字里带路径分隔符写到目录之外。
   */
  async saveAttachment(project: DesktopProject, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment> {
    // 先迁移旧版 userData 附件，再使用和 TUI/CLI 相同的项目级存储器写入。
    await this.storage.ensureProjectData(project);
    const attachment = await saveProjectAttachment(project.path, name, mimeType, bytes);
    return { ...attachment, size: attachment.size ?? bytes.byteLength };
  }

  async listWorkspaceDirectory(project: DesktopProject, relativePath: string): Promise<DesktopWorkspaceDirectory> {
    const directoryPath = this.workspaceDirectory(project, relativePath);
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${relativePath}`);
    const directoryRelativePath = toWorkspaceRelative(project.path, directoryPath);
    const dirEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const entries: DesktopWorkspaceDirectoryEntry[] = dirEntries
      .map((entry) => ({
        name: entry.name,
        path: directoryRelativePath === "." ? entry.name : `${directoryRelativePath.split(path.sep).join("/")}/${entry.name}`,
        kind: entry.isDirectory() ? "directory" : "file"
      } satisfies DesktopWorkspaceDirectoryEntry))
      // 目录在前、文件在后，同类按名称排序。
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return {
      path: directoryRelativePath.split(path.sep).join("/"),
      entries
    };
  }

  /**
   * 读取文件预览：最多读 `filePreviewLimit` 字节，`truncated` 告诉界面内容不完整。
   * 内容里出现 0 字节即判为二进制，此时不返回文本（界面改为提示不可预览）。
   */
  async readWorkspaceFile(project: DesktopProject, relativePath: string): Promise<DesktopWorkspaceFilePreview> {
    const filePath = this.workspaceFile(project, relativePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Path is not a file: ${relativePath}`);
    const previewBytes = Math.min(stat.size, filePreviewLimit);
    const buffer = Buffer.alloc(previewBytes);
    let bytesRead = 0;
    if (previewBytes) {
      const handle = await fs.open(filePath, "r");
      try {
        while (bytesRead < previewBytes) {
          const result = await handle.read(buffer, bytesRead, previewBytes - bytesRead, bytesRead);
          if (!result.bytesRead) break;
          bytesRead += result.bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    const content = buffer.subarray(0, bytesRead);
    const binary = content.includes(0);
    return {
      path: toWorkspaceRelative(project.path, filePath),
      content: binary ? undefined : content.toString("utf8"),
      bytes: stat.size,
      binary,
      truncated: stat.size > bytesRead
    };
  }

  /**
   * 读取消息里引用的图片，转成 data URL 交给界面内联显示。
   *
   * 渲染进程的 CSP 只放行 self / data: / https:，本地图片没法直接用 file:// 加载，只能由主进程
   * 读出来转码。附件在项目 `.biny/attachments` 而非工作区可见文件，所以要按 `@attachments/` 前缀分流。
   * 这是展示用的旁路加载，任何失败都返回 undefined 让界面退回文件名，不往上抛错。
   */
  async readInlineImage(project: DesktopProject, relativePath: string): Promise<string | undefined> {
    const mediaType = imageMediaTypes[relativePath.toLowerCase().split(".").at(-1) ?? ""];
    if (!mediaType) return undefined;
    try {
      const filePath = relativePath.startsWith(attachmentPathPrefix)
        ? attachmentFilePath(this.storage.attachmentsRoot(project), relativePath)
        : this.workspaceFile(project, relativePath);
      if (!filePath) return undefined;
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > inlineImageLimit) return undefined;
      return `data:${mediaType};base64,${(await fs.readFile(filePath)).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  // 文件浏览统一屏蔽 node_modules 和 .git：既没有查看价值，也避免误改仓库内部数据。
  workspaceFile(project: DesktopProject, relativePath: string): string {
    return resolveWorkspacePath(project.path, relativePath, ["node_modules", ".git"]);
  }

  workspaceDirectory(project: DesktopProject, relativePath: string): string {
    return resolveWorkspaceDirectory(project.path, relativePath, ["node_modules", ".git"]);
  }

  requireProject(projectIdValue: string): DesktopProject {
    const project = this.state.project(projectIdValue);
    if (!project) throw new Error(`Unknown project: ${projectIdValue}`);
    return project;
  }

  /** 项目运行根；session store 会据此定位全局项目会话目录。 */
  async dataRoot(project: DesktopProject): Promise<string> {
    return await this.storage.ensureProjectData(project);
  }

  /** Global (non-project) persistence root under desktop userData. */
  async globalDataRoot(): Promise<string> {
    return await this.storage.ensureGlobalData();
  }

  attachmentsRoot(project: DesktopProject): string {
    return this.storage.attachmentsRoot(project);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function projectId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 20);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function desktopSessionSummary(
  projectId: string,
  item: SessionCatalogItem,
  runtime: InteractiveRuntimeSnapshot | undefined,
  liveEvents: ReadonlyMap<string, AgentHostEvent[]>,
  latestRun: SessionRunRecord | undefined,
  hasChildren: boolean | undefined = item.hasChildren
): DesktopSessionSummary {
  const summary = item.summary;
  return {
    id: item.id,
    projectId,
    fileName: summary.fileName,
    title: item.title ?? sessionTitle(summary.firstUserMessage),
    firstUserMessage: summary.firstUserMessage,
    lastAssistantMessage: summary.lastAssistantMessage,
    eventCount: summary.eventCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    pinned: item.pinned ?? false,
    archived: item.archived ?? false,
    unread: item.unread ?? false,
    labels: item.labels,
    metadataRevision: item.metadataRevision,
    personalization: item.personalization,
    hasChildren,
    rootSessionId: item.rootSessionId,
    parentSessionId: item.parentSessionId,
    branchPoint: item.branchPoint,
    latestRun: latestRun ? desktopRunSummary(latestRun) : undefined,
    status: sessionStatus(
      item.id,
      summary.lastAssistantMessage,
      summary.lastTurnStatus?.status,
      runtime,
      liveEvents.get(item.id),
      latestRun?.status
    ),
    resumable: sessionResumable(summary.lastTurnStatus?.resumable, liveEvents.get(item.id), latestRun?.resumable)
  } satisfies DesktopSessionSummary;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      ...args
    ], { cwd, env: gitInspectionEnvironment(), timeout: 4_000, maxBuffer: 512 * 1024 })).stdout;
  } catch {
    return undefined;
  }
}

function sessionTitle(firstUserMessage: string): string {
  const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 64) : "新任务";
}

function sessionStatus(
  sessionId: string,
  lastAssistantMessage: string,
  persistedStatus: SessionTurnStatus | undefined,
  runtime: InteractiveRuntimeSnapshot | undefined,
  events: AgentHostEvent[] | undefined,
  latestRunStatus: SessionRunRecord["status"] | undefined
): DesktopSessionStatus {
  if (pendingPermission(runtime)?.sessionId === sessionId) return "waiting_permission";
  if (activeRun(runtime)?.sessionId === sessionId) return "running";
  const finalEvent = events ? [...events].reverse().find(isTerminalRunEvent) : undefined;
  if (finalEvent?.type === "run.failed") return "failed";
  if (finalEvent?.type === "run.blocked") return "blocked";
  if (finalEvent?.type === "run.incomplete") return "incomplete";
  if (finalEvent?.type === "run.cancelled") return "cancelled";
  if (finalEvent?.type === "run.aborted") return "aborted";
  if (finalEvent?.type === "run.completed") return "completed";
  if (persistedStatus) return persistedStatus;
  if (latestRunStatus) return latestRunStatus;
  return lastAssistantMessage ? "completed" : "idle";
}

function sessionResumable(
  persisted: boolean | undefined,
  events: AgentHostEvent[] | undefined,
  ledgerResumable: boolean | undefined
): boolean | undefined {
  const finalEvent = events ? [...events].reverse().find(isTerminalRunEvent) : undefined;
  if (!finalEvent) return persisted ?? ledgerResumable;
  return finalEvent.type === "run.blocked" || finalEvent.type === "run.incomplete"
    ? finalEvent.resumable
    : undefined;
}

function desktopRunSummary(run: SessionRunRecord): NonNullable<DesktopSessionSummary["latestRun"]> {
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    stopReason: run.stopReason,
    resumable: run.resumable
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
