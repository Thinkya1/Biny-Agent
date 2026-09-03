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
  const document = structuredClone(value);
  if (value.format === undefined && value.configVersion === undefined) {
    document.format = GLOBAL_CONFIG_FORMAT;
    document.configVersion = GLOBAL_CONFIG_VERSION;
    migrateMemoryPolicy(document);
  }
  // 嵌入字段曾在配置已版本化之后短暂写进 activity.*，版本门内的迁移够不到这批文件；
  // 严格 schema 不认识这两个键，所以这段清理必须对所有版本无条件执行。
  migrateActivityEmbeddingPolicy(document);
  // 已移除的记忆策略仍可能存在于已版本化的配置；严格 schema 解析前必须无条件清理。
  migrateRemovedMemoryPolicyFields(document);
  // 人格预设与自定义指令已下线（改由 SOUL/USER 承载）。顶层 personalization 块不再属于
  // 严格 schema，无条件剥离以兼容任何版本的存量配置文件。
  delete document.personalization;
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

  const legacyEnabled = typeof memory.enabled === "boolean" ? memory.enabled : undefined;
  if (memory.useMemories === undefined && typeof memory.enabled === "boolean") {
    memory.useMemories = memory.enabled;
  }
  if (memory.generateMemories === undefined && typeof memory.autoRemember === "boolean") {
    memory.generateMemories = memory.autoRemember;
  }
  // 旧版本只有一个总开关；没有 autoRemember 时也必须保留“关闭整个功能”的语义，
  // 不能被新 schema 的 generateMemories 默认值重新打开。
  if (legacyEnabled !== undefined) memory.enabled = legacyEnabled;
  if (typeof memory.model === "string" && memory.model.length > 0) {
    if (memory.extractModel === undefined) memory.extractModel = memory.model;
  }
  if (legacyEnabled === undefined) delete memory.enabled;
  delete memory.autoRemember;
  delete memory.model;
}

/**
 * 嵌入模型曾短暂迁到 activity 设置段，语义检索回归记忆层后迁回 memory.*。
 * 与 migrateMemoryPolicy 不同：这段不受版本门限制，且 memory 段缺省时补最小容器承接，
 * 保证任何历史文件里的 activity.embeddingModel/embeddingConsents 都会被清掉。
 */
function migrateActivityEmbeddingPolicy(document: Record<string, unknown>): void {
  const activity = isRecord(document.activity) ? document.activity : undefined;
  if (!activity) return;
  const hasEmbeddingModel = activity.embeddingModel !== undefined;
  const hasEmbeddingConsents = activity.embeddingConsents !== undefined;
  if (!hasEmbeddingModel && !hasEmbeddingConsents) return;

  let context = isRecord(document.context) ? document.context : undefined;
  let memory = context && isRecord(context.memory) ? context.memory : undefined;
  if (!memory) {
    // memory 段缺省时 schema 会套默认；这里只补最小容器来承接迁移值。
    if (!context) {
      context = {};
      document.context = context;
    }
    memory = {};
    context.memory = memory;
  }
  if (hasEmbeddingModel && memory.embeddingModel === undefined) {
    memory.embeddingModel = activity.embeddingModel;
  }
  if (hasEmbeddingConsents && memory.cloudEmbeddingConsents === undefined) {
    memory.cloudEmbeddingConsents = activity.embeddingConsents;
  }
  delete activity.embeddingModel;
  delete activity.embeddingConsents;
}

function migrateRemovedMemoryPolicyFields(document: Record<string, unknown>): void {
  const context = isRecord(document.context) ? document.context : undefined;
  const memory = context && isRecord(context.memory) ? context.memory : undefined;
  if (memory) delete memory.telos;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
