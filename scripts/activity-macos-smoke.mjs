#!/usr/bin/env node
/**
 * Activity 的真实 macOS sidecar smoke。
 *
 * 默认不执行，避免测试套件意外读取用户屏幕；显式设置 BINY_ACTIVITY_MACOS_SMOKE=1
 * 后才会请求一张整屏截图，并检查 JPEG、captureId/OCR 和权限状态。
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("SKIP: Activity macOS smoke 只在 macOS 执行。");
  process.exit(0);
}
if (process.env.BINY_ACTIVITY_MACOS_SMOKE !== "1") {
  console.log("SKIP: 设置 BINY_ACTIVITY_MACOS_SMOKE=1 后才执行真实屏幕截图 smoke。");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarPath = path.join(root, "out/native/activity-recorder");
if (!existsSync(sidecarPath)) {
  console.error(`FAIL: 找不到 ${sidecarPath}，先运行 pnpm build:activity-sidecar。`);
  process.exit(1);
}

const child = spawn(sidecarPath, [], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
const messages = [];
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
lines.on("line", (line) => {
  try { messages.push(JSON.parse(line)); } catch { /* smoke 只消费合法 JSONL 消息。 */ }
});

const settings = {
  enabled: true,
  captureDebounceMs: 3_000,
  heartbeatMs: 60_000,
  idleTimeoutMs: 10_000,
  inputPauseMs: 800,
  visualPollMs: 0,
  browserPollIntervalMs: 0,
  jpegQuality: 55,
  histogramChangeThreshold: 0.05,
  pixelDiffThreshold: 0.02,
  pixelTolerance: 30,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 1,
};

try {
  send({ type: "start", settings });
  const status = await waitFor((message) => message.type === "status", 5_000);
  console.log(JSON.stringify({
    status: "ready",
    screenRecordingGranted: status.screenRecordingGranted,
    accessibilityGranted: status.accessibilityGranted,
    currentApplication: status.currentApplication
  }));
  if (!status.screenRecordingGranted) {
    console.log("SKIP: 当前进程没有 Screen Recording 权限；已验证 sidecar 启停和权限状态回报。");
    process.exitCode = 0;
  } else {
    send({ type: "capture" });
    const capture = await waitFor((message) => message.type === "capture" || message.type === "error", 15_000);
    if (capture.type === "error") throw new Error(capture.message);
    const jpeg = Buffer.from(capture.jpegBase64, "base64");
    if (jpeg.length < 100 || capture.width < 1 || capture.height < 1) throw new Error("capture JPEG or dimensions are invalid");
    console.log(JSON.stringify({
      status: "capture-ok",
      bytes: jpeg.length,
      width: capture.width,
      height: capture.height,
      captureId: capture.captureId ?? null
    }));
    if (capture.captureId) {
      const ocr = await waitFor((message) => message.type === "ocr" && message.captureId === capture.captureId, 20_000);
      console.log(JSON.stringify({ status: "ocr-ok", characters: String(ocr.ocrText ?? "").length }));
    }
  }
} finally {
  send({ type: "stop" });
  if (!child.stdin.destroyed) child.stdin.end();
  await waitForExit(child, 5_000);
  if (stderr.trim()) console.error(stderr.trim());
}

function send(command) {
  if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for sidecar message.`);
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.kill("SIGTERM");
      resolve();
    }, timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
