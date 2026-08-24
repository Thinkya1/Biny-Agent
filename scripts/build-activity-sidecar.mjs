import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native/activity-recorder/main.swift");
const output = path.join(root, "out/native/activity-recorder");

if (process.platform !== "darwin") {
  console.log("Activity sidecar 仅在 macOS 构建；当前平台跳过。");
  process.exit(0);
}

mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync("swiftc", ["-O", "-swift-version", "5", "-o", output, source], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
