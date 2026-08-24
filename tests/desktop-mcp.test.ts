import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";

const configStore = {
  loadVersioned: async () => ({ config: structuredClone(defaultConfig), revision: "sha256:test" })
} as unknown as AgentConfigStore;

const projects = {
  requireProject: () => ({ id: "project", name: "Project", path: "/tmp/project" })
};

const agents = {
  assertNoRunningTasks: () => undefined,
  refreshMcpRuntimes: async () => undefined,
  mcpStatuses: async () => [],
  mcpReconnect: async () => { throw new Error("not used"); },
  mcpDetails: async () => { throw new Error("not used"); }
};

const service = new DesktopMcpService(
  configStore,
  projects as never,
  agents,
  async () => new Response(JSON.stringify({
    version: "1.0.0",
    servers: [
      {
        id: "filesystem",
        name: "Filesystem",
        description: "Local files",
        category: "files",
        author: "community",
        verified: true,
        featured: true,
        repository: "https://example.com/filesystem",
        tags: ["files", "local"],
        installations: [{
          name: "NPX",
          config: JSON.stringify({ command: "npx", args: ["-y", "filesystem-mcp"] }),
          parameters: [{ name: "Root", key: "ROOT", required: true, placeholder: "/tmp" }],
          transports: ["stdio"]
        }]
      },
      {
        id: "remote",
        name: "Remote service",
        description: "HTTP service",
        installations: [{
          name: "SSE",
          config: { url: "https://example.com/mcp" },
          transports: ["sse"]
        }]
      },
      {
        id: "invalid",
        name: "Invalid",
        installations: [{ name: "broken", config: "not-json" }]
      }
    ]
  }), { status: 200 })
);

const state = await service.refreshCatalog();
assert.equal(state.status, "ready");
assert.deepEqual(state.categories, ["files"]);
assert.equal(state.entries.length, 2);
assert.equal(state.entries[0]?.installations[0]?.transport, "stdio");
assert.equal(state.entries[0]?.installations[0]?.parameters[0]?.key, "ROOT");
assert.equal(state.entries[1]?.installations[0]?.transport, "remote");
assert.equal(state.entries[1]?.installations[0]?.remoteProtocol, "sse");

console.log("desktop MCP service tests passed");
