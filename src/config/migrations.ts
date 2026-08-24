/**
 * 配置文档的一次性、纯数据迁移。
 *
 * 这里只转换 JSON shape，不读写文件。读取方在内存中使用当前结构；只有用户明确保存配置时
 * 才通过安全原子写入路径替换磁盘文档。
 */

export const GLOBAL_CONFIG_FORMAT = "biny-config" as const;
export const GLOBAL_CONFIG_VERSION = 1 as const;
export const PROJECT_SETTINGS_FORMAT = "biny-project-settings" as const;
export const PROJECT_SETTINGS_VERSION = 2 as const;

export interface ConfigMigrationResult {
  document: unknown;
}

export function migrateGlobalConfigDocument(value: unknown): ConfigMigrationResult {
  if (!isRecord(value)) return { document: value };
  if (value.format !== undefined || value.configVersion !== undefined) {
    return { document: value };
  }
  const document = structuredClone(value);
  document.format = GLOBAL_CONFIG_FORMAT;
  document.configVersion = GLOBAL_CONFIG_VERSION;
  migrateMemoryPolicy(document);
  return { document };
}

export function migrateProjectSettingsDocument(value: unknown): ConfigMigrationResult {
  if (!isRecord(value)) return { document: value };
  const isUnversioned = value.format === undefined && value.configVersion === undefined;
  const isVersionOne = value.format === PROJECT_SETTINGS_FORMAT && value.configVersion === 1;
  if (!isUnversioned && !isVersionOne) {
    return { document: value };
  }
  const document = structuredClone(value);
  document.format = PROJECT_SETTINGS_FORMAT;
  document.configVersion = PROJECT_SETTINGS_VERSION;
  // 权限模式始终来自跨 Desktop/TUI 共享的全局配置。项目覆盖会在重新打开时遮住
  // 最近保存的模式，因此升级旧项目文件时直接移除该字段。
  delete document.permission;
  // 个性化与记忆策略只有 global + chat 两层。旧项目 memory override 不能迁成隐形第三层；
  // 升级后明确回到 global policy，同时保留 context 下的其他项目运行覆盖。
  const context = isRecord(document.context) ? document.context : undefined;
  if (context) {
    delete context.memory;
    if (Object.keys(context).length === 0) delete document.context;
  }
  return { document };
}

function migrateMemoryPolicy(document: Record<string, unknown>): void {
  const context = isRecord(document.context) ? document.context : undefined;
  const memory = context && isRecord(context.memory) ? context.memory : undefined;
  if (!memory) return;

  if (memory.useMemories === undefined && typeof memory.enabled === "boolean") {
    memory.useMemories = memory.enabled;
  }
  if (memory.generateMemories === undefined && typeof memory.autoRemember === "boolean") {
    memory.generateMemories = memory.autoRemember;
  }
  if (typeof memory.model === "string" && memory.model.length > 0) {
    if (memory.extractModel === undefined) memory.extractModel = memory.model;
    if (memory.consolidationModel === undefined) memory.consolidationModel = memory.model;
  }
  delete memory.enabled;
  delete memory.autoRemember;
  delete memory.model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
