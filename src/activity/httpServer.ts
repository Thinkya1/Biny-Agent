/**
 * Activity 的本地 REST 投影。
 *
 * Desktop 主流程继续使用 Electron IPC；这里为 CLI/本地集成提供 loopback API。
 * 服务默认只绑定 127.0.0.1，所有文本仍从 ActivityStore 的脱敏查询层读取。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import type { AgentModel } from "../agent/core/types.js";
import { ActivityPrivacyPolicy } from "./privacyPolicy.js";
import type { ActivitySettings } from "./settings.js";
import { ActivityStore } from "./store.js";
import { buildActivityDigest } from "./digest.js";
import { buildActivityReport, resolveActivityReportRange } from "./analyzer.js";
import { refreshActivitySummaryWithNarrative } from "./summary.js";
import { generateActivitySuggestions } from "./suggestions.js";
import type { ActivityRuntimeSnapshot } from "./types.js";

export interface ActivityHttpApiDependencies {
  loadSettings(): Promise<ActivitySettings>;
  getModel?(): AgentModel | undefined | Promise<AgentModel | undefined>;
  getRuntimeSnapshot?(): ActivityRuntimeSnapshot | Promise<ActivityRuntimeSnapshot>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  clear?(): Promise<unknown>;
}

export interface ActivityHttpRequest {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
}

export interface ActivityHttpResponse {
  status: number;
  body: unknown;
}

export interface ActivityHttpServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function handleActivityHttpRequest(
  request: ActivityHttpRequest,
  deps: ActivityHttpApiDependencies
): Promise<ActivityHttpResponse> {
  const method = request.method.toUpperCase();
  const pathname = normalizePath(request.pathname);
  const searchParams = request.searchParams ?? new URLSearchParams();
  if (pathname !== "/api/activity-recorder" && !pathname.startsWith("/api/activity-recorder/")) {
    return notFound();
  }
  if (method === "OPTIONS") return { status: 204, body: undefined };

  try {
    if (pathname === "/api/activity-recorder" && method === "GET") {
      return {
        status: 200,
        body: {
          endpoints: [
            "config", "status", "start", "stop", "clear", "search", "sessions", "digest",
            "report/:date", "summary/:date", "suggestions", "snapshots/:id/preview"
          ]
        }
      };
    }
    if (pathname === "/api/activity-recorder/config" && method === "GET") {
      return { status: 200, body: await deps.loadSettings() };
    }
    if (pathname === "/api/activity-recorder/status" && method === "GET") {
      return { status: 200, body: await activityStatus(deps) };
    }
    if (pathname === "/api/activity-recorder/start" && method === "POST") return await control(deps.start, "start");
    if (pathname === "/api/activity-recorder/stop" && method === "POST") return await control(deps.stop, "stop");
    if (pathname === "/api/activity-recorder/clear" && method === "POST") return await control(deps.clear, "clear");

    const settings = await deps.loadSettings();
    const store = new ActivityStore();
    await store.open(settings.outputDirectory);
    try {
      if (pathname === "/api/activity-recorder/search" && method === "GET") {
        const query = searchParams.get("query")?.trim() ?? "";
        if (!query) return badRequest("query 不能为空。");
        return { status: 200, body: store.search(query, boundedLimit(searchParams.get("limit"), 20, 100)) };
      }
      if (pathname.startsWith("/api/activity-recorder/search/") && method === "GET") {
        const query = decodePathPart(pathname.slice("/api/activity-recorder/search/".length));
        if (!query) return badRequest("search query 不能为空。");
        return { status: 200, body: store.search(query, boundedLimit(searchParams.get("limit"), 20, 100)) };
      }
      if (pathname === "/api/activity-recorder/sessions" && method === "GET") {
        const since = searchParams.get("since") ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
        return { status: 200, body: store.listRecentSessionsWithAnalysis(since, boundedLimit(searchParams.get("limit"), 50, 200)) };
      }
      if (pathname.startsWith("/api/activity-recorder/sessions/") && method === "GET") {
        const sessionId = decodePathPart(pathname.slice("/api/activity-recorder/sessions/".length));
        if (!sessionId) return badRequest("session id 不能为空。");
        const detail = store.getSessionDetail(sessionId);
        if (!detail) return notFound("没有找到 Activity session。");
        return {
          status: 200,
          body: {
            ...detail,
            events: detail.events.map(({ snapshotPath: _snapshotPath, ...event }) => event)
          }
        };
      }
      if (pathname === "/api/activity-recorder/digest" && method === "GET") {
        const lookbackMin = boundedLimit(searchParams.get("lookbackMin"), 120, 1_440);
        const result = await buildActivityDigest({ store, lookbackMin });
        return { status: 200, body: result };
      }
      if (pathname.startsWith("/api/activity-recorder/report/") && method === "GET") {
        const date = decodePathPart(pathname.slice("/api/activity-recorder/report/".length));
        const range = resolveActivityReportRange(date, new Date());
        const model = await deps.getModel?.();
        const policy = new ActivityPrivacyPolicy(settings);
        return { status: 200, body: await buildActivityReport({ store, policy, model }, range.label) };
      }
      if (pathname.startsWith("/api/activity-recorder/summary/") && method === "GET") {
        const dateKey = decodePathPart(pathname.slice("/api/activity-recorder/summary/".length));
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) return badRequest("summary date 必须是 YYYY-MM-DD。");
        const model = await deps.getModel?.();
        const policy = new ActivityPrivacyPolicy(settings);
        return {
          status: 200,
          body: await refreshActivitySummaryWithNarrative(store, "daily", dateKey, {
            model,
            policy,
            withNarrative: true
          })
        };
      }
      if (pathname === "/api/activity-recorder/suggestions" && method === "GET") {
        const model = await deps.getModel?.();
        const result = await generateActivitySuggestions({
          store,
          policy: new ActivityPrivacyPolicy(settings),
          model,
          force: searchParams.get("force") === "true"
        });
        return { status: 200, body: result };
      }
      if (pathname.startsWith("/api/activity-recorder/snapshots/") && pathname.endsWith("/preview") && method === "GET") {
        const idText = pathname.slice("/api/activity-recorder/snapshots/".length, -"/preview".length);
        const snapshotId = Number(idText);
        if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) return badRequest("snapshot id 无效。");
        const snapshotPath = store.getSnapshotPath(snapshotId);
        if (!snapshotPath) return notFound("没有找到可预览的截图。");
        const bytes = await readFile(snapshotPath);
        if (bytes.byteLength > 20 * 1024 * 1024) return { status: 413, body: { error: "snapshot too large" } };
        return { status: 200, body: { dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` } };
      }
      return notFound();
    } finally {
      await store.close();
    }
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function startActivityHttpServer(
  deps: ActivityHttpApiDependencies,
  options: { host?: string; port?: number } = {}
): Promise<ActivityHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void respond(request, response, deps);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, host);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
  return {
    server,
    host,
    port,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ActivityHttpApiDependencies
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const result = await handleActivityHttpRequest({
    method: request.method ?? "GET",
    pathname: url.pathname,
    searchParams: url.searchParams
  }, deps);
  response.statusCode = result.status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (result.status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(result.body));
}

async function activityStatus(deps: ActivityHttpApiDependencies): Promise<unknown> {
  const runtime = await deps.getRuntimeSnapshot?.();
  if (runtime) return runtime;
  const settings = await deps.loadSettings();
  const store = new ActivityStore();
  await store.open(settings.outputDirectory);
  try {
    return {
      state: settings.enabled ? "unavailable" : "paused",
      collectorAvailable: false,
      ...store.snapshot()
    };
  } finally {
    await store.close();
  }
}

async function control(
  action: (() => Promise<unknown>) | undefined,
  name: string
): Promise<ActivityHttpResponse> {
  if (!action) return { status: 501, body: { error: `${name} 不在当前 Activity 宿主中可用。` } };
  return { status: 200, body: await action() };
}

function normalizePath(value: string): string {
  if (value.length > 1) return value.replace(/\/+$/u, "");
  return value;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

function badRequest(message: string): ActivityHttpResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message = "Activity endpoint 不存在。"): ActivityHttpResponse {
  return { status: 404, body: { error: message } };
}
