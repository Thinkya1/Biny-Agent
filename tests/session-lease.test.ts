import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLeaseError, SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { agentDir } from "../src/session/store.js";

async function main(): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-lease-"));
  let first: SessionLeaseStore | undefined;
  let second: SessionLeaseStore | undefined;
  try {
    first = await SessionLeaseStore.open(workspaceRoot);
    second = await SessionLeaseStore.open(workspaceRoot);
    const lease = first.acquire("session-1");
    assert.throws(() => first!.acquire("session-1"), /already leased/u);
    assert.throws(() => second!.acquire("session-1"), SessionLeaseError);
    lease.close();

    const replacement = second.acquire("session-1");
    replacement.close();
    assert.throws(() => second!.acquire("../escape"), /Invalid session id/u);

    // 崩溃窗口残留的 0 字节/半截 JSON 锁不是有效归属证明，必须按 stale 回收而不是永久锁死。
    const leaseDirectory = path.join(agentDir(await fs.realpath(workspaceRoot)), "runs");
    for (const garbage of ["", "{\"version\":1,\"pid\":"]) {
      const garbagePath = path.join(leaseDirectory, "session-stale.lock");
      await fs.writeFile(garbagePath, garbage, { mode: 0o600 });
      const recovered = first.acquire("stale");
      assert.throws(() => second!.acquire("stale"), SessionLeaseError);
      recovered.close();
    }
  } finally {
    first?.close();
    second?.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
