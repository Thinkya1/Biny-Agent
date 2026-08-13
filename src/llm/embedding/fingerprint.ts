import { createHash } from "node:crypto";
import type { EmbeddingModelRef } from "./types.js";

export function embeddingModelFingerprint(input: {
  ref: EmbeddingModelRef;
  wire: string;
  endpoint?: string;
  revision?: string;
  dtype?: string;
  dimensions?: number;
}): string {
  const endpoint = input.endpoint === undefined ? undefined : normalizedEndpoint(input.endpoint);
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    ref: input.ref,
    wire: input.wire,
    endpoint,
    revision: input.revision,
    dtype: input.dtype,
    dimensions: input.dimensions
  })).digest("hex");
}

/** 隐私确认只绑定 provider alias 与脱敏后的 endpoint，不随具体模型变化。 */
export function embeddingProviderEndpointHash(provider: string, endpoint: string): string {
  return createHash("sha256").update(`${provider}\0${normalizedEndpoint(endpoint)}`).digest("hex");
}

function normalizedEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
  return endpoint.toString().replace(/\/$/u, "");
}
