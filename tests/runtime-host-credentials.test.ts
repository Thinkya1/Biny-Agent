import assert from "node:assert/strict";
import {
  authenticateRuntimeHostHello,
  issueRuntimeHostAccessCredential,
  matchesRuntimeHostCredential
} from "../src/runtime/host/credentials.js";
import type { HostHelloFrame } from "../src/runtime/host/protocol.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import type { HostRegistration } from "../src/runtime/host/types.js";

const credential = issueRuntimeHostAccessCredential();
const registration: HostRegistration = {
  protocolVersion: runtimeHostProtocolVersion,
  endpoint: "/tmp/biny.sock",
  registrationPath: "/tmp/biny.sock.json",
  lockPath: "/tmp/biny.sock.lock",
  rootHash: "root-hash",
  persistenceRoot: "/workspace",
  configRoot: "/config",
  agentRoot: "/agent",
  hostEpoch: "epoch",
  token: credential.secret,
  pid: process.pid,
  createdAt: new Date().toISOString()
};
const hello: HostHelloFrame = {
  kind: "hello",
  requestId: "hello-1",
  protocolVersion: runtimeHostProtocolVersion,
  rootHash: registration.rootHash,
  token: credential.secret,
  configRoot: registration.configRoot!,
  agentRoot: registration.agentRoot!,
  clientId: "client-1",
  surface: "cli",
  capabilities: []
};

assert.notEqual(issueRuntimeHostAccessCredential().secret, credential.secret);
assert.equal(matchesRuntimeHostCredential(credential.secret, credential), true);
assert.equal(matchesRuntimeHostCredential("wrong-token", credential), false);
assert.equal(authenticateRuntimeHostHello(hello, registration, runtimeHostProtocolVersion), true);
assert.equal(authenticateRuntimeHostHello({ ...hello, token: "wrong-token" }, registration, runtimeHostProtocolVersion), false);
assert.equal(authenticateRuntimeHostHello({ ...hello, rootHash: "wrong-root" }, registration, runtimeHostProtocolVersion), false);
assert.equal(authenticateRuntimeHostHello({ ...hello, protocolVersion: runtimeHostProtocolVersion + 1 }, registration, runtimeHostProtocolVersion), false);

console.log("runtime-host credentials tests passed");
