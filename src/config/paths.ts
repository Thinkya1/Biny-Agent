/**
 * Biny 配置与全局 agent 数据的路径解析。
 *
 * 模型配置、项目会话和项目记忆都脱离工作区存放。默认配置文件在 `~/.biny/config.json`，
 * session/memory 等 Agent 运行数据在 `~/.biny/agent/`；BINY_AGENT_DIR 会把两者统一
 * 重定向到指定目录，便于测试隔离和便携部署。
 * 项目 `.biny` 只承载设置、扩展覆盖与尚未迁出的运行产物。
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BINY_AGENT_DIR_ENV = "BINY_AGENT_DIR";
export const DEFAULT_AGENT_DIR = path.join(".biny", "agent");
export const GLOBAL_CONFIG_FILE = "config.json";
export const PROJECT_SETTINGS_FILE = "settings.json";
export const MODELS_STORE_FILE = "models-store.json";

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function globalAgentDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.resolve(options.homeDir ?? os.homedir(), DEFAULT_AGENT_DIR);
}

export function globalConfigPath(options: PathEnvironment = {}): string {
  return path.join(globalConfigDir(options), GLOBAL_CONFIG_FILE);
}

export function globalConfigDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.dirname(globalAgentDir(options));
}

/** 动态 Provider 模型目录属于全局模型配置，不按工作区重复保存。 */
export function globalModelsStorePath(options: PathEnvironment = {}): string {
  return path.join(globalAgentDir(options), MODELS_STORE_FILE);
}

/** 项目会话按规范化绝对路径隔离，避免不同工作区的 latest、id 前缀和锁互相干扰。 */
export function projectSessionsDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  return projectStateDir("sessions", workspaceRoot, options);
}

/** 旧 v2 项目 Memory 目录仅用于首次迁移读取；v3 单库位于全局 agent 目录。 */
export function projectMemoryDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  return projectStateDir("memory", workspaceRoot, options);
}

function projectStateDir(kind: "sessions" | "memory", workspaceRoot: string, options: PathEnvironment): string {
  const projectId = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 24);
  const configuredRoot = globalAgentDir(options);
  const canonicalRoot = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
  return path.join(canonicalRoot, kind, projectId);
}

export function projectBinyDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".biny");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), PROJECT_SETTINGS_FILE);
}
