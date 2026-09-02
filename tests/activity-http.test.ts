import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest, startActivityHttpServer } from "../src/activity/httpServer.js";
import { ActivityStore } from "../src/activity/store.js";

await testActivityHttpServerExposesLoopbackQueries();

async function testActivityHttpServerExposesLoopbackQueries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Editor",
      windowTitle: "中文检索 API"
    });
    const direct = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/search", searchParams: new URLSearchParams("query=中文") },
      { loadSettings: async () => settings }
    );
    assert.equal(direct.status, 200);
    assert.equal((direct.body as Array<unknown>).length, 1);
  } finally {
    await store.close();
  }

  const api = await startActivityHttpServer({ loadSettings: async () => settings });
  try {
    const response = await fetch("http://" + api.host + ":" + String(api.port) + "/api/activity-recorder/status");
    assert.equal(response.status, 200);
    const status = await response.json() as { state: string; sessions: number };
    assert.equal(status.state, "unavailable");
    assert.equal(status.sessions, 1);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}
