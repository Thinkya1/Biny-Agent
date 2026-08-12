/**
 * 模型 API 适配器注册表。
 *
 * Provider 表示服务商与鉴权，API Adapter 只负责一种消息协议。模型选择 adapter 后，
 * Agent Loop 只消费统一的 ModelStreamEvent，不需要知道具体服务商或 HTTP 形状。
 */
import type { ModelApiBackend } from "../config/schema.js";
import type { ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../agent/core/types.js";
import type { LocalPromptProjectionCache, PromptCacheCapability } from "./promptCache.js";

export interface ApiAdapterRequest {
  provider: string;
  providerAlias?: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch: typeof globalThis.fetch;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  supportsTools?: boolean;
  anthropicAuthMode?: "api-key" | "bearer";
  reasoningProtocol?: "deepseek" | "openai" | "google" | "anthropic" | "alibaba" | "moonshotai";
  providerOptions?: Record<string, unknown>;
  promptCache?: PromptCacheCapability;
  promptProjectionCache?: LocalPromptProjectionCache;
}

export interface ApiAdapter {
  readonly id: ModelApiBackend;
  stream(
    request: ApiAdapterRequest,
    context: ModelStreamContext,
    options?: ModelStreamOptions
  ): AsyncIterable<ModelStreamEvent>;
}

export class ApiAdapterRegistry {
  private readonly adapters = new Map<ModelApiBackend, ApiAdapter>();

  constructor(adapters: readonly ApiAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ApiAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: ModelApiBackend): void {
    this.adapters.delete(id);
  }

  get(id: ModelApiBackend): ApiAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: ModelApiBackend): ApiAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`No API adapter registered for ${id}.`);
    return adapter;
  }

  list(): ApiAdapter[] {
    return [...this.adapters.values()];
  }
}
