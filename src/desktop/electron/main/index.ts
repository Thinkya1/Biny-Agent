/**
 * Electron 主进程入口。
 *
 * 按依赖顺序装配各服务（用户数据 → 状态 → 配置 → 项目 → agent 管理器），注册 IPC 和菜单，
 * 最后创建窗口。只负责装配和生命周期，业务逻辑都在各自的服务里。
 *
 * 单实例锁：第二个实例直接退出，因为多个进程同时读写同一份桌面状态和 session 会互相覆盖。
 */
import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, net, Notification, shell } from "electron";
import type { DesktopBootstrap, DesktopSessionHandoff } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";
import { DesktopAgentManager } from "./DesktopAgentManager.js";
import { ActivityRecorderService, defaultActivitySidecarPath } from "./ActivityRecorderService.js";
import { DesktopBrowserService } from "./DesktopBrowserService.js";
import { DesktopConfigStore } from "./DesktopConfigStore.js";
import { DesktopMcpService } from "./DesktopMcpService.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopSkillService } from "./DesktopSkillService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopSettingsCloseCoordinator } from "./DesktopSettingsCloseCoordinator.js";
import { DesktopSettingsTransaction } from "./DesktopSettingsTransaction.js";
import { DesktopTerminalManager } from "./DesktopTerminalManager.js";
import { DesktopUserDataStore } from "./DesktopUserDataStore.js";
import { globalConfigDir } from "../../../config/paths.js";
import { registerDesktopIpc } from "./ipc.js";
import { installApplicationMenu } from "./menu.js";
import { createDesktopWindow, type WindowCloseDecision } from "./window.js";

app.setName("Biny");
app.setAboutPanelOptions({
  applicationName: "Biny",
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: "Biny local agent"
});

const initialHandoff = parseDesktopLaunchHandoff(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void startDesktopApplication().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    dialog.showErrorBox("Biny 无法启动", message);
    app.quit();
  });
}

async function startDesktopApplication(): Promise<void> {
  await app.whenReady();
  // Electron 主进程不是 Runtime owner；给可独立启动的 Node Host 一个稳定入口。
  process.env.BINY_RUNTIME_HOST_ENTRY ??= path.join(
    app.getAppPath(),
    app.isPackaged ? "dist/runtime/hostProcess.js" : "src/runtime/hostProcess.ts"
  );
  setDesktopIcon();
  const userDataRoot = app.getPath("userData");
  const desktopRoot = path.join(userDataRoot, "workspaces", "default");
  const storage = new DesktopUserDataStore(desktopRoot);
  await storage.initialize();
  await storage.ensureGlobalData();
  const state = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
  await state.load();
  // 模型配置与 CLI/TUI 共用全局目录；凭据由 config/credentials.ts 统一接入 macOS Keychain。
  const configStore = new DesktopConfigStore(globalConfigDir());
  const projects = new DesktopProjectService(state, storage, configStore);
  const skills = new DesktopSkillService(state, configStore, net.fetch.bind(net) as unknown as typeof globalThis.fetch);
  let mainWindow: BrowserWindow | undefined;
  let preparingQuit = false;
  const activity = new ActivityRecorderService({
    configStore,
    sidecarPath: defaultActivitySidecarPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    emit: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopIpc.activityEvent, snapshot);
    }
  });
  const settingsClose = new DesktopSettingsCloseCoordinator();
  const agents = new DesktopAgentManager(state, projects, configStore, (projectId, update, meta) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(desktopIpc.event, { projectId, ...update, ...meta });
    }
    const event = update.event;
    // 只有窗口不在前台时才发系统通知：界面上已经能看到权限询问就不用再打扰一次。
    if (event?.type === "permission.requested" && (!mainWindow || !mainWindow.isFocused() || !mainWindow.isVisible()) && Notification.isSupported()) {
      new Notification({
        title: "Biny 等待权限",
        body: event.request.changeSummary ?? event.request.title,
        silent: true
      }).show();
    }
  }, async (url) => await shell.openExternal(url), undefined, net.fetch.bind(net) as unknown as typeof globalThis.fetch);
  const mcp = new DesktopMcpService(
    configStore,
    projects,
    agents,
    net.fetch.bind(net) as unknown as typeof globalThis.fetch
  );
  const settings = new DesktopSettingsTransaction(state, agents);
  // 恢复检查必须早于 IPC 注册和窗口开放；无法自动恢复时保留应用可用来展示设置错误，
  // 但同一个 transaction 实例会阻止所有新工作入口。
  await settings.recoverAtStartup();
  await activity.initialize();
  const prepareHandoff = async (handoff: DesktopLaunchHandoff): Promise<DesktopSessionHandoff> => {
    const project = await projects.createProject(handoff.workspaceRoot);
    await state.commitSelection(project.id, handoff.sessionId, "chat");
    return { projectId: project.id, sessionId: handoff.sessionId };
  };
  const initialTarget = initialHandoff === undefined ? undefined : await prepareHandoff(initialHandoff);
  const terminals = new DesktopTerminalManager((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(desktopIpc.terminalEvent, event);
  });
  // 内嵌浏览器把 cookie 同步到这份共享 jar，agent 的 web 工具默认读同一个位置。
  const defaultCookieJarPath = path.join(desktopRoot, "cookies.json");
  const browser = new DesktopBrowserService(
    async () => (await configStore.load()).web.cookies.path ?? defaultCookieJarPath,
    () => agents.assertNoRunningTasks("任务运行期间不能修改 Cookie。")
  );

  /** 渲染进程启动时拉取的一次性初始状态：项目列表、当前项目、布局尺寸等。 */
  const bootstrap = async (): Promise<DesktopBootstrap> => {
    const allProjects = await projects.refreshAllProjects();
    let activeProjectId = state.activeProjectId();
    // 上次打开的项目可能已被删除或移走，此时回退到第一个可用项目。
    if (activeProjectId && !allProjects.some((project) => project.id === activeProjectId)) activeProjectId = undefined;
    activeProjectId ??= allProjects.at(0)?.id;
    if (activeProjectId !== state.activeProjectId()) await state.setActiveProject(activeProjectId);
    const workspace = activeProjectId ? await agents.workspaceSnapshot(activeProjectId) : undefined;
    const explicitSessionId = initialTarget !== undefined && initialTarget.projectId === activeProjectId
      ? initialTarget.sessionId
      : undefined;
    const activeView = explicitSessionId === undefined ? state.activeView() : "chat";
    const storedSessionId = activeProjectId === undefined ? undefined : state.selectedSessionId(activeProjectId);
    const restorableSessionId = storedSessionId && workspace?.sessions.some((session) => session.id === storedSessionId)
      ? storedSessionId
      : undefined;
    if (storedSessionId && restorableSessionId === undefined && activeProjectId) {
      await state.setSelectedSession(activeProjectId, undefined);
    }
    const selectedSessionId = explicitSessionId ?? (activeView === "extensions" ? undefined : restorableSessionId);
    const visibleWorkspace = workspace ? { ...workspace, selectedSessionId } : undefined;
    const sidebarSessions = await agents.sidebarSessions(workspace);
    return {
      version: app.getVersion(),
      platform: process.platform,
      projects: state.projects(),
      sidebarSessions,
      activeProjectId,
      selectedSessionId,
      activeView,
      workspace: visibleWorkspace,
      sidebarWidth: state.sidebarWidth(),
      filePanelWidth: state.filePanelWidth(),
      themePreference: state.themePreference(),
      fontPreference: state.fontPreference()
    };
  };

  const decideWindowClose = async (): Promise<WindowCloseDecision> => {
    // 先处理未保存的设置草稿：取消必须发生在中止任务之前，否则用户取消时任务已被停掉。
    const settingsDecision = await settingsClose.request(mainWindow?.webContents, "window");
    if (settingsDecision === "cancel") return "cancel";
    if (!agents.hasRunningTasks()) return "close";
    const response = await showMessage(mainWindow, {
      type: "question",
      title: "任务仍在运行",
      message: "Biny 仍有正在运行或等待权限的任务。",
      detail: "关闭 Biny 会中止当前任务；如果暂时不关闭，请取消此操作。",
      buttons: ["中止并关闭", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response.response === 0) {
      await agents.stopAllForExit();
      return "close";
    }
    return "cancel";
  };

  const createWindow = (): BrowserWindow => {
    settingsClose.reset();
    mainWindow = createDesktopWindow(state, decideWindowClose);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
      // macOS 关闭最后一个窗口默认不会退出进程；这里显式退出，避免下次打开继续复用本次
      // Desktop 进程和 Runtime Host 的运行态。菜单里的“隐藏 Biny”仍保留为显式后台操作。
      if (process.platform === "darwin" && !preparingQuit) app.quit();
    });
    return mainWindow;
  };

  const handleHandoff = async (handoff: DesktopLaunchHandoff): Promise<void> => {
    try {
      const target = await prepareHandoff(handoff);
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(desktopIpc.sessionHandoff, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("无法打开会话", message);
    }
  };

  registerDesktopIpc({
    state,
    projects,
    agents,
    settings,
    activity,
    terminals,
    browser,
    skills,
    mcp,
    getWindow: () => mainWindow,
    bootstrap,
    updateSettingsDraftState: (draftState) => settingsClose.updateState(draftState),
    resolveSettingsCloseRequest: (requestId, response) => settingsClose.resolve(requestId, response)
  });
  installApplicationMenu(() => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
  app.on("second-instance", (_event, commandLine) => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
    const handoff = parseDesktopLaunchHandoff(commandLine);
    if (handoff) void handleHandoff(handoff);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    void (async () => {
      // 确认阶段（设置草稿、运行中任务）允许取消并还原 preparingQuit；一旦确认退出，
      // 清理链的任何异常都不能让 app.exit 落空，否则应用会永远退不掉。
      let confirmed = false;
      try {
        const settingsDecision = await settingsClose.request(mainWindow?.webContents, "quit");
        if (settingsDecision === "cancel") return;
        const hadRunningTasks = agents.hasRunningTasks();
        if (hadRunningTasks) {
          const response = await showMessage(mainWindow, {
            type: "warning",
            title: "退出 Biny",
            message: "退出会中止所有正在运行的任务。",
            buttons: ["中止并退出", "取消"],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          });
          if (response.response !== 0) return;
        }
        confirmed = true;
        if (hadRunningTasks) await agents.stopAllForExit();
        terminals.disposeAll();
        await activity.stop();
        await browser.dispose();
        mainWindow?.destroy();
        await Promise.race([
          agents.closeAll({ terminateOwnedHosts: true }),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000))
        ]);
      } finally {
        if (confirmed) app.exit(0);
        else preparingQuit = false;
      }
    })().catch(() => undefined);
  });
}

interface DesktopLaunchHandoff {
  workspaceRoot: string;
  sessionId: string;
}

function parseDesktopLaunchHandoff(argv: readonly string[]): DesktopLaunchHandoff | undefined {
  const workspaceIndex = argv.indexOf("--biny-workspace");
  const sessionIndex = argv.indexOf("--biny-session");
  const workspaceRoot = workspaceIndex >= 0 ? argv[workspaceIndex + 1] : undefined;
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  if (!workspaceRoot || !sessionId || sessionId.includes("\0") || sessionId.length > 240) return undefined;
  return { workspaceRoot: path.resolve(workspaceRoot), sessionId };
}

function setDesktopIcon(): void {
  if (process.platform !== "darwin") return;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.icns")
    : path.join(app.getAppPath(), "build/icon-master.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

async function showMessage(
  window: BrowserWindow | undefined,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  return window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
}
