import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRecorder } from "../src/session/recorder.js";
import { SessionRunLedger } from "../src/session/runLedger.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-run-ledger-"));
try {
  const ledger = new SessionRunLedger(root);
  const started = await ledger.start({
    runId: "run-1",
    sessionId: "session-1",
    messageId: "message-1",
    startedAt: "2026-08-05T10:00:00.000Z"
  });
  assert.equal(started.status, "running");
  assert.equal((await ledger.latestSessionRun("session-1"))?.runId, "run-1");

  const finished = await ledger.finish("run-1", {
    status: "blocked",
    durationMs: 1250,
    stopReason: "blocked",
    steps: 3,
    resumable: true,
    blockedReason: "missing_user_input",
    requiredAction: "Choose a deployment target.",
    endedAt: "2026-08-05T10:00:01.250Z"
  });
  assert.equal(finished?.status, "blocked");
  assert.equal(finished?.durationMs, 1250);
  assert.equal(finished?.resumable, true);
  await assert.rejects(ledger.finish("run-1", { status: "completed" }), /different terminal outcome/u);

  const runs = await ledger.listSessionRuns("session-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.requiredAction, "Choose a deployment target.");

  const canonicalSessionId = "session-canonical";
  const canonicalRunId = "run-canonical";
  const canonicalTurnId = "turn-canonical";
  const recorder = new SessionRecorder(root, canonicalSessionId);
  recorder.setRuntimeContext({ runId: canonicalRunId, turnId: canonicalTurnId });
  const terminalEvent = await recorder.recordAndFlush({
    type: "turn_status",
    status: "completed",
    stopReason: "model_stop",
    finishReason: "stop",
    steps: 2,
    summary: "done"
  });
  await recorder.close();

  await ledger.start({
    runId: canonicalRunId,
    sessionId: canonicalSessionId,
    turnId: canonicalTurnId,
    pid: 999_999,
    startedAt: "2026-08-05T11:00:00.000Z"
  });
  const repaired = await ledger.latestSessionRun(canonicalSessionId);
  assert.equal(repaired?.status, "completed");
  assert.equal(repaired?.turnId, canonicalTurnId);
  assert.equal(repaired?.terminalEventId, terminalEvent.runtime?.eventId);
  assert.equal(repaired?.terminalEventSeq, terminalEvent.runtime?.eventSeq);
  assert.equal(
    (await ledger.finish(canonicalRunId, {
      status: "completed",
      stopReason: "model_stop",
      finishReason: "stop",
      steps: 2,
      terminal: terminalEvent.runtime
    }))?.terminalEventId,
    terminalEvent.runtime?.eventId,
    "repeating the same terminal commit must be idempotent"
  );
  await assert.rejects(
    ledger.finish(canonicalRunId, {
      status: "failed",
      stopReason: "provider_error",
      terminal: { ...terminalEvent.runtime!, eventId: "different-terminal" }
    }),
    /different terminal outcome/u
  );
  console.log("session run ledger tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
