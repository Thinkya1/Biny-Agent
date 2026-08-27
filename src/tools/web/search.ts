/**
 * 公网搜索工具模块。
 *
 * `web_search` 只返回搜索结果标题、链接、摘要和可选的站点图标，不打开网页、不执行本地命令，也不修改工作区。
 * 默认使用支持匿名额度的 AnySearch API，也支持无需密钥的 DuckDuckGo HTML 搜索、Tavily、Brave Search，
 * 以及带共享 cookie 的 Google 网页搜索。
 */
import { decodeHtmlEntities } from "./html.js";
import { z } from "zod";
import type { WebCookiesConfig, WebSearchConfig } from "../../config/schema.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";
import { cookieHeaderFor, defaultCookieJarPath, readCookieJar } from "./cookieJar.js";
import { readBounded } from "./fetch.js";

// 搜索响应体必须有上限：结果页 HTML 由远端控制，无界读取会把内存交给对端决定。
const maxSearchResponseBytes = 2 * 1024 * 1024;

const defaultConfig: WebSearchConfig = {
  enabled: true,
  provider: "anysearch",
  apiKey: undefined,
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
};

const defaultCookies: WebCookiesConfig = { enabled: true, path: undefined };

// html.duckduckgo.com 自 2025 年下半年起加强了反爬校验，非浏览器 UA 更容易收到 403。
const browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 需要密钥的 provider 对应的默认环境变量名；Google 和 DuckDuckGo 不用密钥所以不在其中。 */
export const webSearchKeyEnvNames = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  anysearch: "ANYSEARCH_API_KEY"
} as const;

const recencyValues = ["day", "week", "month", "year"] as const;
type SearchRecency = (typeof recencyValues)[number];

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
  domains?: string[];
  recency?: SearchRecency;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  favicon?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchConfig["provider"];
  results: WebSearchResult[];
  fetchedAt: string;
}

export function createWebSearchTool(config?: WebSearchConfig, cookies?: WebCookiesConfig): Tool<WebSearchArgs, WebSearchResponse> {
  const resolvedConfig = config ?? defaultConfig;
  const resolvedCookies = cookies ?? defaultCookies;
  return {
    name: "web_search",
    description: "Search the public web and return relevant result links and snippets. Use this for current information, research, news, weather, or facts outside the workspace.",
    promptSnippet: "Search the public web for current information and external facts",
    promptGuidelines: ["Use web_search for current public information, research, news, weather, or facts outside the workspace"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query written in natural language." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, description: "Maximum number of results to return." },
        domains: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 }, description: "Optional domains to restrict the search to, such as weather.gov." },
        recency: { type: "string", enum: [...recencyValues], description: "Optional freshness filter: day, week, month, or year." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().positive().max(10).optional(),
      domains: z.array(z.string().min(1)).max(5).optional(),
      recency: z.enum(recencyValues).optional()
    }),
    capability: "web.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: args.query, detail: args },
        description: `Search the public web for ${args.query}`,
        approvalRule: `web_search(${args.query})`,
        async execute({ signal, onUpdate }) {
          onUpdate?.({ kind: "status", text: "Searching the web" });
          const result = await searchWeb(resolvedConfig, resolvedCookies, args, signal);
          onUpdate?.({ kind: "status", text: `Found ${String(result.results.length)} result(s)` });
          return result;
        }
      };
    }
  };
}

async function searchWeb(
  config: WebSearchConfig,
  cookies: WebCookiesConfig,
  args: WebSearchArgs,
  signal: AbortSignal | undefined
): Promise<WebSearchResponse> {
  const query = args.query.trim();
  if (!query) throw new Error("web_search requires a non-empty query.");

  const domains = normalizeDomains(args.domains);
  const maxResults = Math.min(args.maxResults ?? config.maxResults, config.maxResults);
  const searchQuery = buildSearchQuery(query, domains);
  const results = config.provider === "anysearch"
    ? await searchWithAnySearch(config, searchQuery, maxResults, signal)
    : config.provider === "tavily"
      ? await searchWithTavily(config, query, domains, maxResults, args.recency, signal)
      : config.provider === "brave"
        ? await searchWithBrave(config, searchQuery, maxResults, args.recency, signal)
        : config.provider === "google"
          ? await searchWithGoogle(config, cookies, searchQuery, maxResults, args.recency, signal)
          : await searchWithDuckDuckGo(config, searchQuery, maxResults, args.recency, signal);

  return {
    query,
    provider: config.provider,
    results,
    fetchedAt: new Date().toISOString()
  };
}

async function searchWithDuckDuckGo(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const freshness = duckDuckGoFreshness(recency);
  url.searchParams.set("df", freshness);
  try {
    const html = await fetchText(url, { "accept": "text/html", "accept-language": "en-US,en;q=0.9", "user-agent": browserUserAgent }, config.timeoutMs, signal);
    return parseDuckDuckGoResults(html, maxResults);
  } catch (error) {
    if (error instanceof Error && /HTTP 40[13]/.test(error.message)) {
      throw new Error("DuckDuckGo blocked this request (anti-bot protection). Retry later, or switch web.search.provider to tavily or brave.");
    }
    throw error;
  }
}

/**
 * Google 网页搜索。
 *
 * 没有官方免费 API，只能解析结果页。Google 对无 cookie 的请求会给同意页（欧盟）或人机验证，
 * 所以这里带上共享 jar 里的 cookie —— 用户在桌面端浏览器窗口里点过一次同意/登录过，
 * 之后 agent 侧就能直接搜。识别到同意页和验证页时给出可操作的提示，而不是返回空结果。
 */
async function searchWithGoogle(
  config: WebSearchConfig,
  cookies: WebCookiesConfig,
  query: string,
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  // TODO: 桌面端可复用本机 Electron/Chromium 的持久浏览器 session，在隐藏的 BrowserWindow 中
  // 打开 Google 结果页并从渲染后的 DOM 提取结果；CLI 等无 Electron 环境继续保留当前 HTTP 路径。
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  // 结果页里混着广告、"People also ask" 等非自然结果，多要一些再截断。
  url.searchParams.set("num", String(Math.min(maxResults * 2 + 5, 30)));
  const freshness = googleFreshness(recency);
  if (freshness !== undefined) url.searchParams.set("tbs", freshness);

  const headers: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": browserUserAgent
  };
  const cookieHeader = await jarCookieHeader(cookies, url);
  if (cookieHeader) headers.cookie = cookieHeader;

  let html: string;
  try {
    html = await fetchText(url, headers, config.timeoutMs, signal);
  } catch (error) {
    if (error instanceof Error && /HTTP 429|HTTP 40[13]/.test(error.message)) {
      throw new Error(googleBlockedMessage);
    }
    throw error;
  }
  if (isGoogleInterstitial(html)) throw new Error(googleBlockedMessage);
  return parseGoogleResults(html, maxResults);
}

const googleBlockedMessage = "Google 拒绝了这次搜索（同意页或人机验证）。在设置 → 网络搜索里打开 Google 设置，在浏览器窗口中完成验证或登录后重试；也可以先切换到其他搜索服务。";

/** 同意页/验证页都是 200 + 正常 HTML，只能按特征串判断。 */
function isGoogleInterstitial(html: string): boolean {
  return /consent\.google\.com|\/sorry\/index|id="captcha-form"|unusual traffic from your computer/i.test(html);
}

/**
 * 解析 Google 结果页。
 *
 * 两种版面都覆盖：结果链接要么是 `/url?q=<目标>` 的跳板，要么是直接的 https 地址，共同点是
 * 标题都包在 `<h3>` 里，所以以「带 h3 的锚点」为锚。摘要没有稳定的类名（Google 会轮换），
 * 取锚点之后到下一个结果之间的文本，够用且不会因为类名变化整个失效。
 */
export function parseGoogleResults(html: string, maxResults: number): WebSearchResult[] {
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const matches: Array<{ url: string; title: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const inner = match[3] ?? "";
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    if (!heading) continue;
    const title = cleanHtmlText(heading[1] ?? "");
    const url = resolveGoogleUrl(match[2] ?? "");
    if (!title || !url) continue;
    matches.push({ url, title, start: match.index, end: anchorPattern.lastIndex });
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const [index, entry] of matches.entries()) {
    if (results.length >= maxResults) break;
    if (seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    const segmentEnd = matches[index + 1]?.start ?? Math.min(entry.end + 2_000, html.length);
    const snippet = cleanHtmlText(html.slice(entry.end, segmentEnd));
    results.push({ title: entry.title, url: entry.url, snippet: snippet || undefined });
  }
  return results;
}

/** 解开 `/url?q=` 跳板，并丢掉 Google 自家的导航链接（登录、设置、缓存快照等）。 */
function resolveGoogleUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded || decoded.startsWith("#")) return undefined;
  let candidate: URL;
  try {
    const parsed = new URL(decoded, "https://www.google.com");
    const redirected = parsed.pathname === "/url" ? parsed.searchParams.get("q") ?? parsed.searchParams.get("url") : undefined;
    candidate = redirected ? new URL(redirected) : parsed;
  } catch {
    return undefined;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return undefined;
  const host = candidate.hostname.toLowerCase();
  if (/(^|\.)google(\.[a-z]{2,3})+$/.test(host) || host.endsWith("googleusercontent.com")) return undefined;
  return candidate.toString();
}

/** 读取共享 jar 并算出发往该地址的 Cookie 头；jar 关闭或没有匹配项时返回 undefined。 */
async function jarCookieHeader(cookies: WebCookiesConfig, url: URL): Promise<string | undefined> {
  if (!cookies.enabled) return undefined;
  const jar = await readCookieJar(cookies.path ?? defaultCookieJarPath());
  return cookieHeaderFor(jar, url);
}

async function searchWithBrave(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const { apiKey, envName } = resolveApiKey(config, webSearchKeyEnvNames.brave);
  if (!apiKey) {
    throw new Error(`Brave web search requires an API key. Set web.search.apiKey or the ${envName} environment variable.`);
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const freshness = braveFreshness(recency);
  if (freshness !== undefined) url.searchParams.set("freshness", freshness);
  const body = await fetchText(url, {
    "accept": "application/json",
    "x-subscription-token": apiKey,
    "user-agent": "Biny web_search"
  }, config.timeoutMs, signal);

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Brave web search returned invalid JSON.");
  }
  return parseBraveResults(payload, maxResults);
}

async function searchWithTavily(
  config: WebSearchConfig,
  query: string,
  domains: string[],
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const { apiKey, envName } = resolveApiKey(config, webSearchKeyEnvNames.tavily);
  if (!apiKey) {
    throw new Error(`Tavily web search requires an API key. Set web.search.apiKey or the ${envName} environment variable.`);
  }

  const url = new URL("https://api.tavily.com/search");
  const body = await fetchText(url, {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
    "user-agent": "Biny web_search"
  }, config.timeoutMs, signal, {
    method: "POST",
    body: JSON.stringify({
      query,
      max_results: maxResults,
      time_range: recency,
      include_favicon: true,
      include_domains: domains.length ? domains : undefined
    })
  });

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Tavily web search returned invalid JSON.");
  }
  return parseTavilyResults(payload, maxResults);
}

async function searchWithAnySearch(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const { apiKey, envName } = resolveApiKey(config, webSearchKeyEnvNames.anysearch);
  if (config.apiKeyEnv && !apiKey) {
    throw new Error(`AnySearch web search requires the ${envName} environment variable.`);
  }

  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "user-agent": "Biny web_search"
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const url = new URL("https://api.anysearch.com/v1/search");
  const body = await fetchText(url, headers, config.timeoutMs, signal, {
    method: "POST",
    body: JSON.stringify({ query, max_results: maxResults })
  });

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("AnySearch web search returned invalid JSON.");
  }
  return parseAnySearchResults(payload, maxResults);
}

export function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const resultLinkPattern = /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while (results.length < maxResults && (match = resultLinkPattern.exec(html)) !== null) {
    const rawUrl = match[2] ?? "";
    const title = cleanHtmlText(match[3] ?? "");
    const url = resolveSearchUrl(rawUrl);
    if (!title || !url || seenUrls.has(url)) continue;

    const nextResultIndex = html.indexOf("result__a", resultLinkPattern.lastIndex);
    const segment = html.slice(resultLinkPattern.lastIndex, nextResultIndex < 0 ? undefined : nextResultIndex);
    const snippetMatch = segment.match(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = cleanHtmlText(snippetMatch?.[1] ?? "");
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined });
  }

  return results;
}

function parseBraveResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results)) return [];
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of payload.web.results) {
    if (results.length >= maxResults || !isRecord(item)) break;
    const title = typeof item.title === "string" ? cleanHtmlText(item.title) : "";
    const url = typeof item.url === "string" ? resolveSearchUrl(item.url) : undefined;
    const snippet = typeof item.description === "string" ? cleanHtmlText(item.description) : "";
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const favicon = isRecord(item.meta_url) ? sanitizeFaviconUrl(item.meta_url.favicon) : undefined;
    results.push({ title, url, snippet: snippet || undefined, favicon });
  }
  return results;
}

export function parseTavilyResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error("Tavily web search returned an invalid response.");
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of payload.results) {
    if (results.length >= maxResults || !isRecord(item)) break;
    const title = typeof item.title === "string" ? cleanHtmlText(item.title) : "";
    const url = typeof item.url === "string" ? resolveSearchUrl(item.url) : undefined;
    const snippet = typeof item.content === "string" ? cleanHtmlText(item.content) : "";
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined, favicon: sanitizeFaviconUrl(item.favicon) });
  }
  return results;
}

export function parseAnySearchResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload)) throw new Error("AnySearch web search returned an invalid response.");
  if (payload.code !== 0) {
    const message = typeof payload.message === "string" ? payload.message : "request failed";
    throw new Error(`AnySearch web search failed: ${message}`);
  }
  if (!isRecord(payload.data) || !Array.isArray(payload.data.results)) {
    throw new Error("AnySearch web search returned an invalid response.");
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of payload.data.results) {
    if (results.length >= maxResults || !isRecord(item)) break;
    const title = typeof item.title === "string" ? cleanHtmlText(item.title) : "";
    const url = typeof item.url === "string" ? resolveSearchUrl(item.url) : undefined;
    const snippet = typeof item.snippet === "string" ? cleanHtmlText(item.snippet) : "";
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined, favicon: sanitizeFaviconUrl(item.favicon) });
  }
  return results;
}

function resolveApiKey(config: WebSearchConfig, defaultEnv: string): { apiKey: string | undefined; envName: string } {
  const envName = config.apiKeyEnv ?? defaultEnv;
  return { apiKey: config.apiKey ?? process.env[envName], envName };
}

function sanitizeFaviconUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    // favicon 会被渲染端直接当 <img src> 加载，明文 http 会泄露请求，只保留 https。
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchText(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  init: Pick<RequestInit, "method" | "body"> | undefined = undefined
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, {
      method: init?.method,
      body: init?.body,
      headers,
      signal: controller.signal
    });
    const { text: body } = await readBounded(response, maxSearchResponseBytes);
    if (!response.ok) {
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 180);
      throw new Error(`Web search provider returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    return body;
  } catch (error) {
    if (timedOut) throw new Error(`Web search timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function buildSearchQuery(query: string, domains: string[]): string {
  return domains.length ? `${query} ${domains.map((domain) => `site:${domain}`).join(" ")}` : query;
}

function normalizeDomains(domains: string[] | undefined): string[] {
  if (domains === undefined) return [];
  return domains.map((domain) => {
    const normalized = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/u, "");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(normalized)) {
      throw new Error(`Invalid web search domain: ${domain}`);
    }
    return normalized.toLowerCase();
  });
}

function duckDuckGoFreshness(recency: SearchRecency | undefined): string {
  if (recency === "day") return "d";
  if (recency === "week") return "w";
  if (recency === "month") return "m";
  if (recency === "year") return "y";
  return "";
}

function googleFreshness(recency: SearchRecency | undefined): string | undefined {
  if (recency === "day") return "qdr:d";
  if (recency === "week") return "qdr:w";
  if (recency === "month") return "qdr:m";
  if (recency === "year") return "qdr:y";
  return undefined;
}

function braveFreshness(recency: SearchRecency | undefined): string | undefined {
  if (recency === "day") return "pd";
  if (recency === "week") return "pw";
  if (recency === "month") return "pm";
  if (recency === "year") return "py";
  return undefined;
}

function resolveSearchUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  try {
    const parsed = new URL(decoded, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    const candidate = redirected ? new URL(redirected) : parsed;
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return undefined;
    return candidate.toString();
  } catch {
    return undefined;
  }
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 800);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
