/**
 * Activity 工具族共享的依赖注入契约。
 *
 * 所有工具在调用时现取「当前聊天模型 + 最新 activity 设置 + 当前 agent 的记忆/嵌入运行时」，
 * 不沿用装配时的快照。getEmbeddingRuntime 可选：缺省时语义搜索提示改用关键词检索
 */
import type { AgentModel } from "../../agent/core/types.js";
import type { ActivitySettings } from "../../activity/settings.js";
import type { EmbeddingModelRuntime } from "../../llm/embedding/types.js";

export interface ActivityToolsDeps {
  /** 取当前聊天模型；report/digest 补分析时由分析策略决定是否可用。 */
  getModel(): AgentModel | undefined;
  /** 读取最新的 activity 设置（策略与存储目录），避免沿用回合开始时的旧快照。 */
  loadSettings(): Promise<ActivitySettings>;
  /** 语义搜索的本地嵌入运行时；缺省时 activity_search 的 semantic 模式提示不可用。 */
  getEmbeddingRuntime?(): Promise<EmbeddingModelRuntime | undefined>;
  /** 可注入时钟，便于测试固定「今天」。 */
  now?(): Date;
}