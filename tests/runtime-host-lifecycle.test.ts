import assert from "node:assert/strict";
import path from "node:path";
import {
  runtimeHostEntryPath,
  runtimeHostPaths
} from "../src/runtime/host/lifecycle.js";

const first = runtimeHostPaths("/workspace/one");
const equivalent = runtimeHostPaths(path.join("/workspace", "one"));
const second = runtimeHostPaths("/workspace/two");

assert.deepEqual(first, equivalent);
assert.notEqual(first.rootHash, second.rootHash);
assert.match(first.endpoint, /\.sock$/u);
assert.equal(first.registrationPath, `${first.endpoint}.json`);
assert.equal(first.lockPath, `${first.endpoint}.lock`);
assert.match(path.basename(runtimeHostEntryPath()), /^hostProcess\.(ts|js)$/u);

console.log("runtime-host lifecycle tests passed");
