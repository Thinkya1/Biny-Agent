/**
 * Provider Runtime 的兼容入口。
 *
 * 调用方仍通过这里创建 AgentModel，具体鉴权、目录和请求准备已经归属 ProviderRuntime。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig } from "../config/schema.js";
import { ProviderRegistry, type NativeModelSettings } from "./ProviderRuntime.js";

export type { NativeModelSettings } from "./ProviderRuntime.js";

export function createNativeModelForConfig(config: AgentConfig, alias = config.defaultModel): AgentModel {
  return createNativeModelSettings(config, alias).model;
}

export function createNativeModelSettings(
  config: AgentConfig,
  alias = config.defaultModel,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): NativeModelSettings {
  return new ProviderRegistry(config, [], undefined, undefined, fetcher).createModelSettings(alias);
}

export function validateModelConfiguration(config: AgentConfig, alias = config.defaultModel): void {
  new ProviderRegistry(config).validate(alias);
}
