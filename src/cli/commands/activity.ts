/**
 * Activity CLI 与本地 API 入口。
 *
 * 查询、日报和 suggestions 都直接复用 ActivityStore/业务模块；`serve` 只在用户明确
 * 启动时打开 loopback REST，并由同一进程托管 macOS sidecar。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateConfig, createFileConfigStore } from "../../config/store.js";
import { resolveActivityAnalysisModel } from "../../activity/analysisModel.js";
import { ActivityPrivacyPolicy } from "../../activity/privacyPolicy.js";
import { buildActivityDigest } from "../../activity/digest.js";
import { buildActivityReport, formatActivityDailyNote, formatActivityReportResult } from "../../activity/analyzer.js";
import { writeDailyActivityNote } from "../../activity/dailyNotes.js";
import { refreshActivitySummaryWithNarrative } from "../../activity/summary.js";
import { generateActivitySuggestions } from "../../activity/suggestions.js";
import { ActivityStore, resolveActivityDirectory } from "../../activity/store.js";
import { startActivityHttpServer } from "../../activity/httpServer.js";
import type { ActivitySettings } from "../../activity/settings.js";
import { ActivityRecorderService, defaultActivitySidecarPath } from "../../desktop/electron/main/ActivityRecorderService.js";

export interface ActivityOutputOptions {
  json?: boolean;
}

export interface ActivitySearchCommandOptions extends ActivityOutputOptions {
  limit?: number;
}

export interface ActivitySessionsCommandOptions extends ActivityOutputOptions {
  limit?: number;
  since?: string;
}

export interface ActivityDigestCommandOptions extends ActivityOutputOptions {
  lookbackMin?: number;
}

export interface ActivityServeCommandOptions {
  port?: number;
}

const activityPackageRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export async function activityStatusCommand(workspaceRoot: string, options: ActivityOutputOptions = {}): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  try {
    const result = { settings: config.activity, store: store.snapshot() };
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`Activity: ${config.activity.enabled ? "enabled" : "paused"}`);
      console.log(`Directory: ${resolveActivityDirectory(config.activity.outputDirectory)}`);
      console.log(`Sessions: ${String(result.store.sessions)}  Events: ${String(result.store.events)}  Screenshots: ${String(result.store.fallbackCaptures)}`);
      console.log(`Storage: ${formatBytes(result.store.storageBytes)}`);
    }
  } finally {
    await store.close();
  }
}

export async function activityConfigCommand(workspaceRoot: string, options: ActivityOutputOptions = {}): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  if (options.json) console.log(JSON.stringify(config.activity));
  else console.log(JSON.stringify(config.activity, null, 2));
}

export async function activitySearchCommand(
  workspaceRoot: string,
  query: string,
  options: ActivitySearchCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const results = store.search(query, options.limit ?? 20);
    if (options.json) {
      console.log(JSON.stringify(results));
      return;
    }
    if (!results.length) {
      console.log("没有找到 Activity 记录。");
      return;
    }
    for (const result of results) {
      const app = result.application ? ` [${result.application}]` : "";
      console.log(`${result.occurredAt}${app} ${result.summary} (${result.sessionId})`);
    }
  } finally {
    await store.close();
  }
}

export async function activitySessionsCommand(
  workspaceRoot: string,
  options: ActivitySessionsCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const rows = store.listRecentSessionsWithAnalysis(since, options.limit ?? 20);
    if (options.json) {
      console.log(JSON.stringify(rows));
      return;
    }
    if (!rows.length) {
      console.log("还没有 Activity session。");
      return;
    }
    for (const row of rows) {
      const analysis = row.analysis;
      const label = analysis?.title ?? analysis?.summary ?? "未分析";
      console.log(`${row.startedAt} ${row.endedAt ? `→ ${row.endedAt}` : "(进行中)"} ${label} (${row.id})`);
    }
  } finally {
    await store.close();
  }
}

export async function activityDigestCommand(
  workspaceRoot: string,
  options: ActivityDigestCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const result = await buildActivityDigest({ store }, options.lookbackMin);
    if (options.json) console.log(JSON.stringify(result));
    else console.log(result.markdown);
  } finally {
    await store.close();
  }
}

export async function activityReportCommand(
  workspaceRoot: string,
  date = "today",
  options: ActivityOutputOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const policy = new ActivityPrivacyPolicy(config.activity);
    const result = await buildActivityReport({ store, policy, model: resolveActivityAnalysisModel(config) }, date);
    await writeDailyActivityNote(result.date, formatActivityDailyNote(result));
    if (options.json) console.log(JSON.stringify(result));
    else console.log(formatActivityReportResult(result));
  } finally {
    await store.close();
  }
}

export async function activitySummaryCommand(
  workspaceRoot: string,
  dateKey: string,
  options: ActivityOutputOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const result = await refreshActivitySummaryWithNarrative(store, "daily", dateKey, {
      model: resolveActivityAnalysisModel(config),
      policy: new ActivityPrivacyPolicy(config.activity),
      withNarrative: true
    });
    if (options.json) console.log(JSON.stringify(result));
    else console.log(result.summary);
  } finally {
    await store.close();
  }
}

export async function activitySuggestionsCommand(
  workspaceRoot: string,
  options: { force?: boolean; json?: boolean } = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const result = await generateActivitySuggestions({
      store,
      policy: new ActivityPrivacyPolicy(config.activity),
      model: resolveActivityAnalysisModel(config),
      force: options.force
    });
    if (options.json) console.log(JSON.stringify(result));
    else if (!result.suggestions.length) console.log("暂时没有可生成的 Activity 建议。");
    else for (const suggestion of result.suggestions) console.log(`- ${suggestion}`);
  } finally {
    await store.close();
  }
}

export async function activityClearCommand(
  workspaceRoot: string,
  options: { yes?: boolean; json?: boolean } = {}
): Promise<void> {
  if (!options.yes) throw new Error("清空 Activity 会删除本地截图、事件、OCR 和分析；请加 --yes 确认。");
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    await store.clear();
    const result = store.snapshot();
    if (options.json) console.log(JSON.stringify(result));
    else console.log("Activity 数据已清空。");
  } finally {
    await store.close();
  }
}

export async function activityServeCommand(
  workspaceRoot: string,
  options: ActivityServeCommandOptions = {}
): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const recorder = new ActivityRecorderService({
    configStore,
    sidecarPath: defaultActivitySidecarPath({
      packaged: false,
      resourcesPath: activityPackageRoot,
      appPath: activityPackageRoot
    })
  });
  await recorder.initialize();
  const api = await startActivityHttpServer({
    loadSettings: async () => (await configStore.load()).activity,
    getModel: async () => resolveActivityAnalysisModel(await configStore.load()),
    getRuntimeSnapshot: () => recorder.snapshot(),
    start: async () => {
      await updateConfig(configStore, undefined, (config) => ({
        ...config,
        activity: { ...config.activity, enabled: true }
      }));
      await recorder.refresh();
    },
    stop: async () => await recorder.stop(),
    clear: async () => await recorder.clear()
  }, { port: options.port ?? 0 });
  console.log(`Activity API listening on http://${api.host}:${String(api.port)}`);
  try {
    await waitForTermination();
  } finally {
    await api.close().catch(() => undefined);
    await recorder.stop();
  }
}

async function openActivityStore(settings: ActivitySettings): Promise<ActivityStore> {
  const store = new ActivityStore();
  await store.open(settings.outputDirectory);
  return store;
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
