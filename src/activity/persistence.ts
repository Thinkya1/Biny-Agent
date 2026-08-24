import { updateConfig, type AgentConfigStore } from "../config/store.js";
import { activitySettingsSchema, type ActivitySettings } from "./settings.js";

/**
 * Activity 设置沿用全局配置的 versioned CAS，只更新 activity 字段，不覆盖其他客户端刚写入的
 * 模型、权限或记忆设置。
 */
export async function updateActivitySettings(
  store: AgentConfigStore,
  workspaceRoot: string | undefined,
  update: (current: ActivitySettings) => ActivitySettings
): Promise<ActivitySettings> {
  const saved = await updateConfig(store, workspaceRoot, (current) => ({
    ...current,
    activity: activitySettingsSchema.parse(update(structuredClone(current.activity)))
  }));
  return saved.activity;
}
