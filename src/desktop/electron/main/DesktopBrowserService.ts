/**
 * 桌面端内嵌浏览器与 cookie 管理。
 *
 * 浏览器窗口跑在独立的持久 partition 上，用户在里面登录网站（Google、小红书……），登录态
 * 由 Electron 自己保存；同时这里把 cookie 同步写进共享 jar，`web_search` 的 Google provider
 * 和 `web_fetch` 就能读到同一份登录态 —— 登录一次，agent 侧直接可用。
 *
 * 几个刻意的选择：
 * - 用独立 partition 而不是默认 session：浏览的是任意站点，不能和应用自身的 session 混在一起；
 * - 浏览器窗口不挂应用 preload：那座桥是给渲染层用的，网页拿到就等于拿到主进程能力；
 * - cookie 变化后延迟合并再落盘：一次登录会连着触发几十次 changed 事件，逐次写盘没有意义。
 *
 * 导入导出用 Cookie-Editor 的 JSON 格式，用户可以和浏览器扩展互相搬运登录态。
 */
import { promises as fs } from "node:fs";
import { BrowserWindow, dialog, session, type Cookie, type CookiesSetDetails } from "electron";
import type { DesktopCookieJarStatus } from "../../protocol.js";
import {
  parseCookieJar,
  serializeCookieJar,
  summarizeCookieJar,
  writeCookieJar,
  type StoredCookie
} from "../../../tools/web/cookieJar.js";

/** 独立的持久 partition：登录态跨重启保留，且与应用自身 session 完全隔离。 */
const browserPartition = "persist:biny-browser";
const homeUrl = "https://www.google.com";
/** 一次登录会连续触发大量 cookie 变化，攒一下再落盘。 */
const syncDebounceMs = 800;

export class DesktopBrowserService {
  private window: BrowserWindow | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTail = Promise.resolve();
  private cookieListenerAttached = false;
  /** 仅在本进程真的使用过这个 session 后才在退出时覆盖 jar，避免覆盖 CLI 新导入的内容。 */
  private browserSessionManaged = false;

  constructor(
    private readonly getJarPath: () => Promise<string>,
    private readonly assertCookieMutationAllowed: () => void = () => undefined
  ) {}

  /**
   * 打开浏览器窗口并导航到目标地址；窗口已存在则复用（再开一个只会让登录态看起来分裂）。
   * `url` 省略时打开首页。
   */
  async open(url?: string): Promise<void> {
    const target = url ?? homeUrl;
    this.attachCookieListener();
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      await this.window.loadURL(target);
      this.browserSessionManaged = true;
      return;
    }
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 480,
      minHeight: 400,
      title: "Biny 浏览器",
      show: false,
      webPreferences: {
        partition: browserPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window = window;
    // 站内弹窗（OAuth 登录常用）留在同一个 partition 里开新窗口，否则登录流程会走不完。
    window.webContents.setWindowOpenHandler(({ url: requested }) => {
      if (!isHttpUrl(requested)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 620,
          height: 760,
          webPreferences: { partition: browserPartition, contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      };
    });
    window.on("closed", () => {
      this.window = undefined;
      // 关窗时兜底同步一次：期间的 changed 事件可能还压在防抖窗口里没落盘。
      if (this.browserSessionManaged) void this.syncToJar();
    });
    window.once("ready-to-show", () => window.show());
    await window.loadURL(target);
    this.browserSessionManaged = true;
  }

  /** 把浏览器 session 里的 cookie 写进用户选定的文件（Cookie-Editor 可直接导入）。 */
  async exportToFile(parent: BrowserWindow | undefined): Promise<DesktopCookieJarStatus> {
    const cookies = await this.readSessionCookies();
    if (!cookies.length) throw new Error("浏览器里还没有可导出的 cookie。请先打开浏览器窗口登录网站。");
    const options: Electron.SaveDialogOptions = {
      title: "导出 Cookie",
      defaultPath: "biny-cookies.json",
      filters: [{ name: "Cookie JSON", extensions: ["json"] }]
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return await this.status();
    this.assertCookieMutationAllowed();
    // 导出文件由用户自己保管，同样按 0600 落盘：里面是等同于登录凭据的东西。
    await fs.writeFile(result.filePath, serializeCookieJar(cookies), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(result.filePath, 0o600);
    return await this.status();
  }

  /** 从 Cookie-Editor 导出的 JSON 导入登录态，写进浏览器 session 并同步到共享 jar。 */
  async importFromFile(parent: BrowserWindow | undefined): Promise<DesktopCookieJarStatus> {
    const options: Electron.OpenDialogOptions = {
      title: "导入 Cookie",
      filters: [{ name: "Cookie JSON", extensions: ["json"] }],
      properties: ["openFile"]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return await this.status();
    const cookies = parseCookieJar(await fs.readFile(filePath, "utf8"));
    this.assertCookieMutationAllowed();
    const browserSession = session.fromPartition(browserPartition);
    let imported = 0;
    const failures: string[] = [];
    for (const cookie of cookies) {
      try {
        await browserSession.cookies.set(toCookiesSetDetails(cookie));
        imported += 1;
      } catch (error) {
        failures.push(`${cookie.domain}${cookie.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!imported) {
      throw new Error(`没有导入任何 cookie。${failures[0] ?? ""}`);
    }
    this.browserSessionManaged = true;
    await this.syncToJar();
    return await this.status();
  }

  /** 清除浏览器 session 与共享 jar 里的全部 cookie（等同于在所有站点登出）。 */
  async clear(): Promise<DesktopCookieJarStatus> {
    this.assertCookieMutationAllowed();
    this.browserSessionManaged = true;
    await session.fromPartition(browserPartition).clearStorageData({ storages: ["cookies"] });
    await writeCookieJar(await this.getJarPath(), []);
    return await this.status();
  }

  async status(): Promise<DesktopCookieJarStatus> {
    const cookies = await this.readSessionCookies();
    let updatedAt: string | undefined;
    try {
      updatedAt = (await fs.stat(await this.getJarPath())).mtime.toISOString();
    } catch {
      updatedAt = undefined;
    }
    const summary = summarizeCookieJar(cookies, updatedAt);
    return { total: summary.total, domains: summary.domains.slice(0, 8), updatedAt: summary.updatedAt };
  }

  /** 退出前先把内存里的最新登录态落盘，再销毁浏览器窗口。 */
  async dispose(): Promise<void> {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    if (this.browserSessionManaged) await this.syncToJar();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private async readSessionCookies(): Promise<StoredCookie[]> {
    const cookies = await session.fromPartition(browserPartition).cookies.get({});
    return cookies.map(toStoredCookie);
  }

  /**
   * 监听 cookie 变化，防抖后把整份 session cookie 覆盖写进 jar。
   * 只在首次打开浏览器时挂载，避免重复注册监听器。
   */
  private attachCookieListener(): void {
    if (this.cookieListenerAttached) return;
    this.cookieListenerAttached = true;
    session.fromPartition(browserPartition).cookies.on("changed", () => {
      this.browserSessionManaged = true;
      this.scheduleSyncToJar();
    });
  }

  private scheduleSyncToJar(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncToJar();
    }, syncDebounceMs);
  }

  /** 覆盖写 jar。串行化是因为防抖兜底和关窗兜底可能同时触发，并发写会互相截断。 */
  private async syncToJar(): Promise<void> {
    const run = this.syncTail.then(async () => {
      try {
        this.assertCookieMutationAllowed();
      } catch {
        // 浏览器 session 可以继续登录，但共享 jar 必须保持本次 Agent 回合开始时的版本；
        // 等所有项目空闲后再同步最新整份 cookie，避免落下部分登录态。
        this.scheduleSyncToJar();
        return;
      }
      await writeCookieJar(await this.getJarPath(), await this.readSessionCookies());
    });
    this.syncTail = run.catch(() => undefined);
    await run.catch(() => undefined);
  }
}

function toStoredCookie(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: toStoredSameSite(cookie.sameSite),
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    session: cookie.session ?? cookie.expirationDate === undefined
  };
}

/**
 * 还原成 `cookies.set` 需要的形状。它要的是 URL 而不是 domain，所以按 domain 反推一个：
 * 前导点表示包含子域名，去掉点即可；secure 决定用 https 还是 http。
 */
function toCookiesSetDetails(cookie: StoredCookie): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    // hostOnly 的 cookie 不能带 domain，否则 Electron 会把它变成包含子域名的形式。
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: toElectronSameSite(cookie.sameSite)
  };
}

function toStoredSameSite(value: Cookie["sameSite"]): StoredCookie["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function toElectronSameSite(value: StoredCookie["sameSite"]): CookiesSetDetails["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
