/**
 * QuickChat 悬浮窗。
 *
 * 一个全局快捷键唤醒的极简对话小窗：frameless、置顶、不占任务栏、默认隐藏。它和主窗口
 * 完全解耦——主窗口关掉（macOS 上只剩它）时进程照常退出，所以它绝不能触发任何退出逻辑，
 * 「关闭」永远翻译成「隐藏」。
 *
 * 三种用户可控行为（设置见 SettingsQuickChat）：
 * - 失焦自动隐藏：blur 时收起，保持后台常驻；
 * - 点击穿透：窗口可见但忽略鼠标事件，悬浮在工作上方不抢焦点，按快捷键临时接管交互；
 * - 屏幕上下文注入：发消息时附带最新屏幕文本片段（由 ActivityRecorderService 提供）。
 *
 * 安全约束与主窗口一致：contextIsolation + sandbox 开、nodeIntegration 关、禁用新窗口、
 * 禁止导航到本地页面之外的地址。preload 复用同一份 index.cjs。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, nativeTheme, screen } from "electron";
import type { DesktopQuickChatSettings } from "../../protocol.js";

const QUICKCHAT_WIDTH = 400;
const QUICKCHAT_HEIGHT = 560;
/** 顶部留约 20% 屏高，靠近视线又不顶到菜单栏/Dock。 */
const QUICKCHAT_TOP_RATIO = 0.2;

export interface QuickChatWindowController {
  /** 当前悬浮窗是否可见。 */
  isVisible(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** 向 QuickChat 渲染层推一个事件通道消息；窗口已销毁时为空操作。 */
  send(channel: string, payload: unknown): void;
  /** 应用最新设置（失焦隐藏 / 点击穿透），立即对现存窗口生效。 */
  applySettings(settings: DesktopQuickChatSettings): void;
  /** 真正销毁窗口（仅在 before-quit 清理链里调用）。 */
  destroy(): void;
}

export function createQuickChatWindow(
  getSettings: () => DesktopQuickChatSettings
): QuickChatWindowController {
  const settings = getSettings();
  nativeTheme.themeSource = "dark";
  const window = new BrowserWindow({
    width: QUICKCHAT_WIDTH,
    height: QUICKCHAT_HEIGHT,
    minWidth: 320,
    minHeight: 360,
    resizable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 悬浮小窗不应进入全屏/最大化语义，也不该被窗口管理器当作主窗口。
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    // 置顶层级选 floating + 相对层 1，盖住普通窗口但不压过系统级弹层。
    backgroundColor: "#00000000",
    title: "Biny 快速对话",
    // macOS 透明 + 圆角交给渲染层 CSS（body 圆角 + 背景），窗口本体透明。
    transparent: process.platform === "darwin",
    hasShadow: true,
    webPreferences: {
      preload: path.join(fileURLToPath(new URL(".", import.meta.url)), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  window.setAlwaysOnTop(true, "floating", 1);

  /** 点击穿透当前态：跟随设置，但按快捷键唤醒期间会临时关闭让用户交互。 */
  let clickThroughActive = settings.clickThrough;
  let settingsSnapshot = settings;
  let destroyed = false;

  const applyClickThrough = (active: boolean): void => {
    if (destroyed || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(active, { forward: true });
  };

  const positionTopCenter = (): void => {
    // 用「指针所在屏」而不是主屏居中：多屏用户在大副屏上按快捷键，窗口应出现在眼前那块屏。
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    const targetX = Math.round(x + (width - QUICKCHAT_WIDTH) / 2);
    const targetY = Math.round(y + height * QUICKCHAT_TOP_RATIO);
    if (!destroyed && !window.isDestroyed()) window.setPosition(targetX, targetY);
  };

  const show = (): void => {
    if (destroyed || window.isDestroyed()) return;
    positionTopCenter();
    // 唤醒时临时接管鼠标：点击穿透模式下用户需要能点到输入框。
    if (settingsSnapshot.clickThrough) {
      clickThroughActive = false;
      applyClickThrough(false);
    }
    window.show();
    window.focus();
  };

  const hide = (): void => {
    if (destroyed || window.isDestroyed()) return;
    // 收起时恢复穿透态，让窗口即便残留显示也不挡鼠标。
    if (settingsSnapshot.clickThrough) {
      clickThroughActive = true;
      applyClickThrough(true);
    }
    window.hide();
  };

  const toggle = (): void => {
    if (window.isDestroyed() || destroyed) return;
    if (window.isVisible() && window.isFocused()) hide();
    else show();
  };

  // 点击穿透开启但窗口仍可见时，鼠标会穿过它点到下面的应用——这正是该模式想要的行为；
  // 一旦用户按快捷键 show()，穿透被临时关闭，blur 又可能触发自动隐藏，二者不冲突：
  // show 期间窗口有焦点，blur（点开别处）才会收起。
  window.on("blur", () => {
    if (destroyed || window.isDestroyed()) return;
    if (settingsSnapshot.autoHideOnBlur && window.isVisible() && !window.webContents.isDevToolsOpened()) hide();
  });

  // 关键：拦截 close 转 hide。macOS 上若让悬浮窗真正关闭，且它是最后一个窗口，进程会随之退出。
  window.on("close", (event) => {
    if (destroyed) return;
    event.preventDefault();
    hide();
  });

  window.on("closed", () => {
    destroyed = true;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (developmentUrl && url.startsWith(developmentUrl))) return;
    event.preventDefault();
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    void window.loadURL(`${developmentUrl}/quickchat.html`);
  } else {
    void window.loadFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/quickchat.html"));
  }

  // 初始穿透态（窗口此刻隐藏，但状态要先就位，首次 show/hide 才不跳变）。
  if (clickThroughActive) applyClickThrough(true);

  return {
    isVisible: () => !destroyed && !window.isDestroyed() && window.isVisible(),
    show,
    hide,
    toggle,
    send: (channel, payload) => {
      if (destroyed || window.isDestroyed()) return;
      window.webContents.send(channel, payload);
    },
    applySettings: (next) => {
      settingsSnapshot = next;
      // 穿透只对可见窗口立刻生效；自动隐藏等下次 blur 自然生效，不主动收起用户正在用的窗口。
      if (next.clickThrough && !window.isVisible()) {
        clickThroughActive = true;
      } else if (next.clickThrough && window.isVisible() && !window.isFocused()) {
        clickThroughActive = true;
        applyClickThrough(true);
      } else if (!next.clickThrough) {
        clickThroughActive = false;
        applyClickThrough(false);
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (!window.isDestroyed()) window.destroy();
    }
  };
}
