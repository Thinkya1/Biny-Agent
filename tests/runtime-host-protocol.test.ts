import assert from "node:assert/strict";
import {
  decodeHostFrame,
  encodeHostFrame,
  isEventFrame,
  isHelloFrame,
  isRequestFrame,
  isResponseFrame,
  runtimeHostProtocolVersion
} from "../src/runtime/host/protocol.js";

const request = {
  kind: "request" as const,
  requestId: "request-1",
  operation: "runtime.snapshot",
  payload: { sessionId: "session-1" }
};

const hello = {
  kind: "hello" as const,
  requestId: "hello-1",
  protocolVersion: runtimeHostProtocolVersion,
  rootHash: "root-hash",
  token: "host-token",
  configRoot: "/config",
  agentRoot: "/agent",
  clientId: "client-1",
  surface: "cli" as const,
  capabilities: ["runtime.authority"]
};

assert.deepEqual(decodeHostFrame(encodeHostFrame(request).trim()), request);
assert.equal(isRequestFrame(request), true);
assert.equal(isHelloFrame(hello), true);
assert.equal(isResponseFrame({ kind: "response", requestId: "request-1", ok: true }), true);
assert.equal(isEventFrame({ kind: "event", hostEpoch: "epoch", sequence: 1, update: {} }), false);
assert.throws(() => decodeHostFrame("not-json"), /Invalid Runtime Host JSON frame/u);

console.log("runtime-host protocol tests passed");
