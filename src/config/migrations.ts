/**
 * 配置文档的一次性、纯数据迁移。
 *
 * 这里只转换 JSON shape，不读写文件。loader/projectSettings 在严格 schema 校验通过后再用
 * 各自的安全原子写入路径替换旧文档，避免运行时长期保留字段别名。
 */

export const GLOBAL_CONFIG_FORMAT = "biny-config" as const;
export const GLOBAL_CONFIG_VERSION = 1 as const;
export const PROJECT_SETTINGS_FORMAT = "biny-project-settings" as const;
export const PROJECT_SETTINGS_VERSION = 1 as const;

export interface ConfigMigrationResult {
  document: unknown;
  migrated: boolean;
}

export function migrateGlobalConfigDocument(value: unknown): ConfigMigrationResult {
  if (!isRecord(value)) return { document: value, migrated: false };
  if (value.format !== undefined || value.configVersion !== undefined) {
    return { document: value, migrated: false };
  }
  const document = structuredClone(value);
  document.format = GLOBAL_CONFIG_FORMAT;
  document.configVersion = GLOBAL_CONFIG_VERSION;
  migrateMemoryPolicy(document);
  return { document, migrated: true };
}

export function migrateProjectSettingsDocument(value: unknown): ConfigMigrationResult {
  if (!isRecord(value)) return { document: value, migrated: false };
  if (value.format !== undefined || value.configVersion !== undefined) {
    return { document: value, migrated: false };
  }
  const document = structuredClone(value);
  document.format = PROJECT_SETTINGS_FORMAT;
  document.configVersion = PROJECT_SETTINGS_VERSION;
  // 个性化与记忆策略只有 global + chat 两层。旧项目 memory override 不能迁成隐形第三层；
  // 升级后明确回到 global policy，同时保留 context 下的其他项目运行覆盖。
  const context = isRecord(document.context) ? document.context : undefined;
  if (context) {
    delete context.memory;
    if (Object.keys(context).length === 0) delete document.context;
  }
  return { document, migrated: true };
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
