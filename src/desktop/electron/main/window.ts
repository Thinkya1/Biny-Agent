/**
 * 主窗口创建。
 *
 * 负责窗口尺寸的恢复与持久化、主题背景色同步、关闭前确认以及导航限制。
 *
 * 安全相关的三项配置是刻意的：contextIsolation + sandbox 打开、nodeIntegration 关闭，渲染
 * 进程只能通过 preload 暴露的接口访问系统能力；同时禁止开新窗口、禁止导航到本地页面之外的
 * 地址，避免页面被引导到外部站点。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, nativeTheme, screen } from "electron";
import type { DesktopThemePreference } from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

export type WindowCloseDecision = "close" | "cancel";

/** 窗口底色要和渲染层主题一致，否则加载过程中会闪一下白底。 */
function themeBackgroundColor(preference: DesktopThemePreference = "system"): string {
  const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#181818" : "#ffffff";
}

export function createDesktopWindow(
  state: DesktopStateStore,
  decideClose: () => Promise<WindowCloseDecision>
): BrowserWindow {
  const preference = state.themePreference();
  nativeTheme.themeSource = preference;
  const savedBounds = visibleBounds(state.windowBounds());
  const window = new BrowserWindow({
    width: savedBounds?.width ?? 1480,
    height: savedBounds?.height ?? 920,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    // macOS 用透明底色让 CSS 液态玻璃效果透出桌面背景；
    // 其他平台保持跟随主题的不透明底色，避免加载期闪白。
    backgroundColor: process.platform === "darwin" ? "#00000000" : themeBackgroundColor(preference),
    title: "Biny",
    titleBarStyle: "hidden",
    // macOS 不再使用系统 vibrancy（themeSource 切换时不更新），改为 CSS
    // backdrop-filter 液态玻璃，light/dark 效果一致且随主题变量自动刷新。
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    titleBarOverlay: process.platform === "darwin" ? true : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(fileURLToPath(new URL(".", import.meta.url)), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  const syncBackgroundColor = (): void => {
    if (process.platform === "darwin") {
      // macOS 玻璃侧栏需要透明窗口底色，CSS backdrop-filter 负责毛玻璃效果。
      if (!window.isDestroyed()) window.setBackgroundColor("#00000000");
      return;
    }
    if (!window.isDestroyed()) window.setBackgroundColor(themeBackgroundColor(state.themePreference()));
  };
  nativeTheme.on("updated", syncBackgroundColor);
  window.on("closed", () => {
    nativeTheme.off("updated", syncBackgroundColor);
  });

  let allowClose = false;
  let closePromptOpen = false;
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;
  const saveBounds = (): void => {
    // 最大化/全屏时的尺寸不能存：还原后会变成占满屏幕的「普通窗口」。
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    // 拖动和缩放会高频触发，防抖后再落盘。
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!window.isDestroyed()) void state.setWindowBounds(window.getBounds());
    }, 180);
  };
  window.on("move", saveBounds);
  window.on("resize", saveBounds);
  // 关闭要先问过上层（可能有任务在跑）：默认拦住，等决策回来再真正关闭或取消。
  // `allowClose` 用来放行决策后自己调的那次 close，`closePromptOpen` 防止反复弹询问。
  window.on("close", (event) => {
    if (allowClose) return;
    if (closePromptOpen) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closePromptOpen = true;
    void decideClose().then((decision) => {
      closePromptOpen = false;
      if (window.isDestroyed()) return;
      if (decision === "close") {
        allowClose = true;
        window.close();
      }
    }, () => {
      // 决策异常不能卡住关闭流程：重置状态并放行关闭，否则窗口永远关不掉。
      closePromptOpen = false;
      if (window.isDestroyed()) return;
      allowClose = true;
      window.close();
    });
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (developmentUrl && url.startsWith(developmentUrl))) return;
    event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"));
  return window;
}

/**
 * 校验保存的窗口位置在当前显示器布局下仍然可见：外接屏拔掉后，旧坐标可能整块落在屏幕外，
 * 窗口就再也找不回来了。要求与某个显示器至少有 120x80 的交集，否则丢弃坐标改用默认居中。
 */
function visibleBounds(bounds: ReturnType<DesktopStateStore["windowBounds"]>): ReturnType<DesktopStateStore["windowBounds"]> {
  if (!bounds) return undefined;
  const intersects = screen.getAllDisplays().some((display) => {
    const left = Math.max(bounds.x ?? 0, display.bounds.x);
    const top = Math.max(bounds.y ?? 0, display.bounds.y);
    const right = Math.min((bounds.x ?? 0) + bounds.width, display.bounds.x + display.bounds.width);
    const bottom = Math.min((bounds.y ?? 0) + bounds.height, display.bounds.y + display.bounds.height);
    return right - left >= 120 && bottom - top >= 80;
  });
  return intersects ? bounds : undefined;
}
