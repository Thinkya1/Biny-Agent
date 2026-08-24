import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "../src/activity/store.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-"));
  const store = new ActivityStore();
  try {
    await store.open(root);
    const sessionId = store.startSession("2026-08-24T00:00:00.000Z");
    const stored = await store.recordCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:01.000Z",
      application: "Test App",
      rawOcrText: "token=secret user@example.com /Users/think/private.txt",
      jpeg: Buffer.from("jpeg"),
      inputEventCount: 3
    }, 10);
    assert.equal(stored.application, "Test App");
    assert.match(stored.summary, /\[redacted\]/u);
    assert.doesNotMatch(stored.summary, /secret|user@example\.com|\/Users\/think/iu);
    assert.equal(store.search("Test App").length, 1);
    const snapshot = store.snapshot();
    assert.equal(snapshot.sessions, 1);
    assert.equal(snapshot.captures, 1);
    assert.equal(snapshot.storageBytes, 4);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "snapshots"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "activity.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, stored.snapshotPath))).mode & 0o777, 0o600);
    await store.clear();
    assert.deepEqual(store.snapshot(), { sessions: 0, captures: 0, storageBytes: 0, recentSessions: [] });
    console.log("activity recorder tests passed");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
