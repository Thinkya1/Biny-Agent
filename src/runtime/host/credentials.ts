/**
 * Runtime Host 的访问凭据边界。
 *
 * 该凭据只保护本地 Host socket 的连接，不负责读取 Electron safeStorage，也不承载 Provider
 * API key。Provider 凭据仍由各自 ConfigStore 负责，避免把两类权限混成一个 token。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { HostHelloFrame } from "./protocol.js";
import type { HostRegistration } from "./types.js";

export interface RuntimeHostAccessCredential {
  readonly secret: string;
}

export function issueRuntimeHostAccessCredential(): RuntimeHostAccessCredential {
  return { secret: randomBytes(32).toString("base64url") };
}

export function credentialFromRegistration(registration: HostRegistration): RuntimeHostAccessCredential {
  return { secret: registration.token };
}

export function matchesRuntimeHostCredential(
  candidate: string,
  expected: RuntimeHostAccessCredential
): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected.secret, "utf8");
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

export function authenticateRuntimeHostHello(
  hello: HostHelloFrame,
  registration: HostRegistration,
  expectedProtocolVersion: number
): boolean {
  return hello.protocolVersion === expectedProtocolVersion
    && hello.rootHash === registration.rootHash
    && hello.configRoot === registration.configRoot
    && hello.agentRoot === registration.agentRoot
    && matchesRuntimeHostCredential(hello.token, credentialFromRegistration(registration));
}
