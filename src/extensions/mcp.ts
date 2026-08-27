/**
 * MCP 扩展模块。
 *
 * 启动时连接配置的 MCP 服务器并把远端工具注册进统一 ToolRegistry。对齐主流 agent 的
 * 客户端能力：stdio 与 streamable HTTP（回退 SSE）传输、单服务器失败隔离、断线懒重连、
 * tools/list_changed 动态刷新、resources 读取工具、服务器 instructions 采集、
 * 每服务器请求超时与配置中的 ${ENV} 展开。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentConfig, McpServerConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { JsonObjectSchema } from "../tools/schema.js";
import type { Tool, ToolRisk } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";
import { z } from "zod";

export type McpTransportKind = "stdio" | "http";

const defaultRequestTimeoutMs = 60_000;
const maxToolListPages = 16;
const maxResourceListPages = 4;
const maxResourceTextBytes = 64 * 1024;
const maxInstructionBytes = 4 * 1024;
const maxInstructionsTotalBytes = 16 * 1024;
const maxPromptNames = 32;

export interface McpServerStatus {
  name: string;
  /** stdio 显示 command，http 显示 url。 */
  command: string;
  transport: McpTransportKind;
  enabled: boolean;
  connected: boolean;
  toolNames: string[];
  promptNames: string[];
  hasResources: boolean;
  instructions?: string;
  lastError?: string;
}

export interface McpServerDetails {
  status: McpServerStatus;
  resources: Array<Record<string, unknown>>;
}

interface ListedMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

interface ManagedMcpServer {
  name: string;
  /** 未展开的原始配置；每次连接时重新展开，避免遗留过期或字面量 ${ENV}。 */
  rawConfig: McpServerConfig;
  config: McpServerConfig;
  transport: McpTransportKind;
  status: McpServerStatus;
  client?: Client;
  connecting?: Promise<void>;
  refreshing?: Promise<void>;
  /** 刷新期间又收到 tools/list_changed 时，完成当前轮后补刷一次。 */
  refreshDirty?: boolean;
}

export class McpToolHost {
  private readonly servers = new Map<string, ManagedMcpServer>();
  private registry?: ToolRegistry;
  private workspaceRoot = "";
  private closing = false;

  async connectConfiguredServers(workspaceRoot: string, config: AgentConfig, registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    this.workspaceRoot = workspaceRoot;
    for (const [serverName, rawConfig] of Object.entries(config.extensions.mcp)) {
      const transport = transportKind(rawConfig);
      const status: McpServerStatus = {
        name: serverName,
        command: transport === "http" ? rawConfig.url ?? "" : rawConfig.command ?? "",
        transport,
        enabled: rawConfig.enabled,
        connected: false,
        toolNames: [],
        promptNames: [],
        hasResources: false
      };
      const managed: ManagedMcpServer = { name: serverName, rawConfig, config: rawConfig, transport, status };
      this.servers.set(serverName, managed);
      if (!rawConfig.enabled) continue;
      try {
        await this.startServer(managed);
      } catch (error) {
        // 单个服务器失败只影响自己：记录原因，其他服务器与 runtime 照常启动。
        status.lastError = errorText(error);
      }
    }
  }

  listServers(): McpServerStatus[] {
    return [...this.servers.values()].map((server) => ({
      ...server.status,
      toolNames: [...server.status.toolNames],
      promptNames: [...server.status.promptNames]
    }));
  }

  hasEnabledServers(): boolean {
    return [...this.servers.values()].some((server) => server.status.enabled);
  }

  /** 收集各服务器 initialize 返回的 instructions，供 system prompt 注入。 */
  instructionsPrompt(): string {
    const sections: string[] = [];
    let usedBytes = 0;
    for (const server of this.servers.values()) {
      const instructions = server.status.instructions?.trim();
      if (!instructions) continue;
      const section = `Instructions from MCP server ${server.name}:\n${truncateUtf8(instructions, maxInstructionBytes)}`;
      if (usedBytes + Buffer.byteLength(section, "utf8") > maxInstructionsTotalBytes) break;
      usedBytes += Buffer.byteLength(section, "utf8");
      sections.push(section);
    }
    return sections.join("\n\n");
  }

  /** 手动重连（/mcp reconnect）。失败不抛出，结果反映在状态里。 */
  async reconnectServer(serverName: string): Promise<McpServerStatus> {
    const managed = this.servers.get(serverName);
    if (!managed) throw new Error(`Unknown MCP server: ${serverName}`);
    if (!managed.status.enabled) throw new Error(`MCP server ${serverName} is disabled in config.json.`);
    try {
      await this.reconnect(managed);
    } catch (error) {
      managed.status.lastError = errorText(error);
    }
    return { ...managed.status, toolNames: [...managed.status.toolNames], promptNames: [...managed.status.promptNames] };
  }

  /** 工具执行入口：断线时先重连；调用因连接关闭失败时重连并重试一次。 */
  async callServerTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const managed = this.requireServer(serverName);
    if (!managed.client || !managed.status.connected) await this.reconnect(managed);
    const client = managed.client;
    if (!client) throw new Error(`MCP server ${serverName} is not connected: ${managed.status.lastError ?? "unknown error"}`);
    try {
      return normalizeMcpResult(await client.callTool({ name: toolName, arguments: args }, undefined, this.requestOptions(managed, signal)));
    } catch (error) {
      if (signal?.aborted || !isConnectionError(error)) throw error;
      markDisconnected(managed, error);
      await this.reconnect(managed);
      const reconnected = managed.client;
      if (!reconnected) throw error;
      return normalizeMcpResult(await reconnected.callTool({ name: toolName, arguments: args }, undefined, this.requestOptions(managed, signal)));
    }
  }

  async listServerResources(serverName?: string): Promise<Array<Record<string, unknown>>> {
    const targets = serverName
      ? [this.requireServer(serverName)]
      : [...this.servers.values()].filter((server) => server.status.enabled && server.status.hasResources);
    const resources: Array<Record<string, unknown>> = [];
    for (const managed of targets) {
      if (!managed.client || !managed.status.connected) {
        try {
          await this.reconnect(managed);
        } catch {
          continue;
        }
      }
      const client = managed.client;
      if (!client) continue;
      try {
        let cursor: string | undefined;
        for (let page = 0; page < maxResourceListPages; page += 1) {
          const listed = await client.listResources(cursor === undefined ? undefined : { cursor }, this.requestOptions(managed));
          for (const resource of listed.resources) {
            resources.push({
              server: managed.name,
              uri: resource.uri,
              name: resource.name,
              description: resource.description,
              mimeType: resource.mimeType
            });
          }
          cursor = listed.nextCursor;
          if (!cursor) break;
        }
      } catch (error) {
        resources.push({ server: managed.name, error: errorText(error) });
      }
    }
    return resources;
  }

  async readServerResource(serverName: string, uri: string, signal?: AbortSignal): Promise<unknown> {
    const managed = this.requireServer(serverName);
    if (!managed.client || !managed.status.connected) await this.reconnect(managed);
    const client = managed.client;
    if (!client) throw new Error(`MCP server ${serverName} is not connected: ${managed.status.lastError ?? "unknown error"}`);
    const result = await client.readResource({ uri }, this.requestOptions(managed, signal));
    return {
      server: serverName,
      uri,
      contents: result.contents.map((content) => {
        if ("text" in content && typeof content.text === "string") {
          return { uri: content.uri, mimeType: content.mimeType, text: truncateUtf8(content.text, maxResourceTextBytes) };
        }
        const bytes = "blob" in content && typeof content.blob === "string" ? Math.floor(content.blob.length * 3 / 4) : 0;
        return { uri: content.uri, mimeType: content.mimeType, bytes, note: "binary content omitted" };
      })
    };
  }

  async describeServer(serverName: string): Promise<McpServerDetails> {
    const managed = this.requireServer(serverName);
    if (!managed.client || !managed.status.connected) await this.reconnect(managed);
    return {
      status: { ...managed.status, toolNames: [...managed.status.toolNames], promptNames: [...managed.status.promptNames] },
      resources: await this.listServerResources(serverName)
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    const clients = [...this.servers.values()].map((server) => server.client).filter((client): client is Client => Boolean(client));
    await Promise.all(clients.map(async (client) => {
      try {
        await client.close();
      } catch {
        // Closing an already exited MCP process is best effort.
      }
    }));
    for (const server of this.servers.values()) {
      server.client = undefined;
      server.status.connected = false;
    }
  }

  private requireServer(serverName: string): ManagedMcpServer {
    const managed = this.servers.get(serverName);
    if (!managed) throw new Error(`Unknown MCP server: ${serverName}`);
    if (!managed.status.enabled) throw new Error(`MCP server ${serverName} is disabled in config.json.`);
    return managed;
  }

  private requestOptions(managed: ManagedMcpServer, signal?: AbortSignal): RequestOptions {
    // SDK 只会在提供 onprogress 时附加 progressToken；没有它，服务端不会发送进度
    // 通知，resetTimeoutOnProgress 也不会生效。
    return { timeout: managed.config.timeoutMs ?? defaultRequestTimeoutMs, resetTimeoutOnProgress: true, onprogress: () => {}, signal };
  }

  /** 串行化的重连：并发调用共享同一次连接尝试。 */
  private async reconnect(managed: ManagedMcpServer): Promise<void> {
    if (this.closing) throw new Error(`MCP host is closing; cannot reconnect ${managed.name}.`);
    if (!managed.status.enabled) throw new Error(`MCP server ${managed.name} is disabled in config.json.`);
    if (managed.connecting) {
      await managed.connecting;
      return;
    }
    const attempt = (async () => {
      const previous = managed.client;
      managed.client = undefined;
      // 旧 client 一旦摘除就不再处于连接态；若后续 startServer 失败，状态不会滞留「已连接」。
      managed.status.connected = false;
      if (previous) {
        try {
          await previous.close();
        } catch {
          // 旧连接可能早已断开。
        }
      }
      if (this.closing) throw new Error(`MCP host is closing; cannot reconnect ${managed.name}.`);
      await this.startServer(managed);
    })();
    managed.connecting = attempt;
    try {
      await attempt;
    } catch (error) {
      managed.status.lastError = errorText(error);
      throw error;
    } finally {
      managed.connecting = undefined;
    }
  }

  private async startServer(managed: ManagedMcpServer): Promise<void> {
    // 每次连接都从原始配置展开：启动时变量缺失后重连会重新验证，环境变更也能生效。
    managed.config = expandServerConfig(managed.rawConfig);
    managed.status.command = managed.transport === "http" ? managed.config.url ?? "" : managed.config.command ?? "";
    const { client, tools } = await this.openClient(managed);
    // close() 可能在 connect() 等待期间开始；不要把刚建立的连接遗留到关闭后的 host。
    if (this.closing) {
      await client.close().catch(() => undefined);
      throw new Error(`MCP host is closing; cannot start ${managed.name}.`);
    }
    client.onclose = () => {
      // 主动 close() 之外的断开：标记状态，等下次调用触发懒重连。
      if (this.closing || managed.client !== client) return;
      markDisconnected(managed, new Error("connection closed"));
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshServerTools(managed);
    });
    managed.client = client;
    this.registerServerTools(managed, client, tools);
    const capabilities = client.getServerCapabilities();
    managed.status.hasResources = Boolean(capabilities?.resources);
    managed.status.instructions = client.getInstructions();
    managed.status.promptNames = capabilities?.prompts ? await this.listPromptNames(managed, client) : [];
    managed.status.connected = true;
  }

  /** tools/list_changed 到达后重新拉取工具并原子替换注册。 */
  private async refreshServerTools(managed: ManagedMcpServer): Promise<void> {
    if (this.closing) return;
    if (managed.refreshing) {
      managed.refreshDirty = true;
      await managed.refreshing;
      return;
    }
    managed.refreshing = (async () => {
      try {
        do {
          managed.refreshDirty = false;
          const client = managed.client;
          if (!client || this.closing) return;
          try {
            const tools = await this.listAllTools(managed, client);
            if (managed.client !== client) return;
            this.registerServerTools(managed, client, tools);
          } catch (error) {
            managed.status.lastError = `tool refresh failed: ${errorText(error)}`;
          }
        } while (managed.refreshDirty && !this.closing);
      } finally {
        managed.refreshing = undefined;
      }
    })();
    await managed.refreshing;
  }

  private registerServerTools(managed: ManagedMcpServer, client: Client, tools: ListedMcpTool[]): void {
    const registry = this.registry;
    if (!registry) throw new Error("MCP host is not attached to a tool registry.");
    for (const toolName of managed.status.toolNames) registry.unregister(toolName);
    const toolNames: string[] = [];
    const warnings: string[] = [];
    for (const mcpTool of tools) {
      try {
        registry.registerMcpTool(createMcpTool(this, managed.name, mcpTool));
        toolNames.push(`mcp_${normalizeName(managed.name)}_${normalizeName(mcpTool.name)}`);
      } catch (error) {
        // 归一化后重名（同名工具或跨服务器冲突）的工具跳过注册并记录警告，
        // 避免留下半注册状态，也不因单个冲突拖垮整台服务器。
        warnings.push(`skipped tool ${mcpTool.name}: ${errorText(error)}`);
      }
    }
    managed.status.toolNames = toolNames;
    managed.status.lastError = warnings.length ? warnings.join("; ") : undefined;
  }

  private async listPromptNames(managed: ManagedMcpServer, client: Client): Promise<string[]> {
    try {
      const listed = await client.listPrompts(undefined, this.requestOptions(managed));
      return listed.prompts.slice(0, maxPromptNames).map((prompt) => prompt.name);
    } catch {
      return [];
    }
  }

  private async listAllTools(managed: ManagedMcpServer, client: Client): Promise<ListedMcpTool[]> {
    // tools/list 是分页协议，逐页取完，页数设防御上限。
    const tools: ListedMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxToolListPages; page += 1) {
      const listed = await client.listTools(cursor === undefined ? undefined : { cursor }, this.requestOptions(managed));
      tools.push(...(listed.tools as ListedMcpTool[]));
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  private async openClient(managed: ManagedMcpServer): Promise<{ client: Client; tools: ListedMcpTool[] }> {
    const serverConfig = managed.config;
    if (managed.transport === "http") {
      const url = new URL(serverConfig.url ?? "");
      const requestInit = serverConfig.headers ? { headers: serverConfig.headers } : undefined;
      if (serverConfig.transportProtocol === "sse") {
        return await this.tryConnect(managed, new SSEClientTransport(url, { requestInit }));
      }
      if (serverConfig.transportProtocol === "streamable-http") {
        return await this.tryConnect(managed, new StreamableHTTPClientTransport(url, { requestInit }));
      }
      try {
        return await this.tryConnect(managed, new StreamableHTTPClientTransport(url, { requestInit }));
      } catch (streamableError) {
        // 参考主流客户端：先尝试 streamable HTTP，旧服务器再回退 SSE。
        try {
          return await this.tryConnect(managed, new SSEClientTransport(url, { requestInit }));
        } catch (sseError) {
          throw new Error(
            `Failed to connect MCP server ${managed.name} over streamable HTTP (${errorText(streamableError)}) and SSE (${errorText(sseError)})`
          );
        }
      }
    }
    try {
      return await this.tryConnect(managed, new StdioClientTransport({
        command: serverConfig.command ?? "",
        args: serverConfig.args,
        env: serverConfig.env,
        cwd: await resolveWorkingDirectory(this.workspaceRoot, serverConfig.cwd),
        stderr: serverConfig.stderr
      } as StdioServerParameters));
    } catch (error) {
      throw new Error(`Failed to connect MCP server ${managed.name}: ${errorText(error)}`);
    }
  }

  private async tryConnect(managed: ManagedMcpServer, transport: Transport): Promise<{ client: Client; tools: ListedMcpTool[] }> {
    const client = new Client({ name: "biny", version: "0.1.0" });
    try {
      await client.connect(transport);
      return { client, tools: await this.listAllTools(managed, client) };
    } catch (error) {
      try {
        await client.close();
      } catch {
        // The original connection error is more useful than a close error.
      }
      throw error;
    }
  }
}

/** 通用 resources 工具：列出并读取任意已连接 MCP 服务器暴露的资源。 */
export function createMcpResourceTools(host: McpToolHost): Tool[] {
  const listArgsSchema = z.object({ server: z.string().trim().min(1).optional() });
  const readArgsSchema = z.object({ server: z.string().trim().min(1), uri: z.string().trim().min(1) });
  return [
    {
      name: "mcp_list_resources",
      description: "List resources exposed by connected MCP servers. Optionally filter by server name.",
      promptSnippet: "List resources exposed by connected MCP servers",
      parameters: {
        type: "object",
        properties: { server: { type: "string", description: "Only list resources from this MCP server." } },
        additionalProperties: false
      },
      schema: listArgsSchema,
      source: "mcp",
      capability: "mcp:resources",
      risk: "read",
      resolveExecution(args: unknown) {
        const parsed = listArgsSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return { isError: true as const, result: "Invalid arguments for mcp_list_resources.", errorMessage: "Invalid arguments for mcp_list_resources." };
        }
        return {
          accesses: ToolAccesses.none(),
          display: { kind: "generic" as const, summary: parsed.data.server ? `MCP resources of ${parsed.data.server}` : "MCP resources" },
          approvalRule: "mcp:resources:list",
          async execute(): Promise<unknown> {
            return await host.listServerResources(parsed.data.server);
          }
        };
      }
    },
    {
      name: "mcp_read_resource",
      description: "Read one resource from a connected MCP server by uri (use mcp_list_resources to discover uris).",
      promptSnippet: "Read one resource from a connected MCP server",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name." },
          uri: { type: "string", description: "Resource uri as returned by mcp_list_resources." }
        },
        required: ["server", "uri"],
        additionalProperties: false
      },
      schema: readArgsSchema,
      source: "mcp",
      capability: "mcp:resources",
      risk: "read",
      resolveExecution(args: unknown) {
        const parsed = readArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { isError: true as const, result: "mcp_read_resource requires server and uri.", errorMessage: "mcp_read_resource requires server and uri." };
        }
        return {
          accesses: ToolAccesses.none(),
          display: { kind: "generic" as const, summary: `MCP resource ${parsed.data.uri}`, detail: { server: parsed.data.server } },
          approvalRule: `mcp:resources:read:${parsed.data.server}`,
          async execute(context: { signal?: AbortSignal }): Promise<unknown> {
            return await host.readServerResource(parsed.data.server, parsed.data.uri, context.signal);
          }
        };
      }
    }
  ];
}

function transportKind(serverConfig: McpServerConfig): McpTransportKind {
  return serverConfig.type ?? (serverConfig.url ? "http" : "stdio");
}

function markDisconnected(managed: ManagedMcpServer, error: unknown): void {
  managed.status.connected = false;
  managed.status.lastError = errorText(error);
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|connection closed|transport (was )?closed/i.test(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 展开配置值里的 ${VAR} / ${VAR:-default} 环境变量引用。 */
export function expandEnvTemplate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const resolved = process.env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(`Environment variable ${name} is not set (referenced in MCP config)`);
  });
}

function expandServerConfig(serverConfig: McpServerConfig): McpServerConfig {
  const expandRecord = (record: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!record) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnvTemplate(value)]));
  };
  return {
    ...serverConfig,
    command: serverConfig.command === undefined ? undefined : expandEnvTemplate(serverConfig.command),
    args: serverConfig.args.map((arg) => expandEnvTemplate(arg)),
    env: expandRecord(serverConfig.env),
    cwd: serverConfig.cwd === undefined ? undefined : expandEnvTemplate(serverConfig.cwd),
    url: serverConfig.url === undefined ? undefined : expandEnvTemplate(serverConfig.url),
    headers: expandRecord(serverConfig.headers)
  };
}

function createMcpTool(host: McpToolHost, serverName: string, definition: ListedMcpTool): Tool {
  const name = `mcp_${normalizeName(serverName)}_${normalizeName(definition.name)}`;
  // 注意：annotations 由服务器自报，属未验证提示（与主流客户端一致）。它只影响
  // 风险分级与 plan/read-only 模式筛选，ask 模式下 MCP 工具仍会走审批询问。
  const risk: ToolRisk = definition.annotations?.readOnlyHint ? "read" : definition.annotations?.destructiveHint ? "write" : "execute";
  return {
    name,
    description: `[MCP ${serverName}] ${definition.description ?? definition.name}`,
    parameters: definition.inputSchema as unknown as JsonObjectSchema,
    schema: z.unknown(),
    source: "mcp",
    capability: `mcp:${serverName}`,
    risk,
    resolveExecution(args: unknown) {
      return {
        accesses: ToolAccesses.all(),
        display: { kind: "generic", summary: `MCP ${serverName}/${definition.name}`, detail: args },
        description: definition.description ?? `Call MCP tool ${definition.name}`,
        approvalRule: `mcp:${serverName}:${definition.name}`,
        async execute(context: { signal?: AbortSignal }): Promise<unknown> {
          return await host.callServerTool(serverName, definition.name, asArguments(args), context.signal);
        }
      };
    }
  };
}

function normalizeMcpResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent !== undefined) {
    return result.isError ? { error: true, structuredContent: result.structuredContent } : result.structuredContent;
  }
  if (Array.isArray(result.content)) {
    const parts = result.content.filter(isRecord);
    const textParts = parts.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    if (textParts.length === parts.length) {
      const text = textParts.map((part) => part.text).join("\n");
      if (text) return result.isError ? { error: text } : text;
      return result;
    }
    // 非纯文本结果：保留各 part 的结构信息，二进制内容不进上下文。
    const normalizedParts = parts.map((part) => {
      if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (part.type === "image" || part.type === "audio") {
        const data = typeof part.data === "string" ? part.data : "";
        return { type: part.type, mimeType: part.mimeType, bytes: Math.floor(data.length * 3 / 4), note: "binary content omitted" };
      }
      if (part.type === "resource_link") return { type: "resource_link", uri: part.uri, name: part.name, description: part.description };
      if (part.type === "resource" && isRecord(part.resource)) {
        const text = typeof part.resource.text === "string" ? truncateUtf8(part.resource.text, maxResourceTextBytes) : undefined;
        return { type: "resource", uri: part.resource.uri, mimeType: part.resource.mimeType, text };
      }
      return { type: typeof part.type === "string" ? part.type : "unknown" };
    });
    return result.isError ? { error: true, parts: normalizedParts } : { parts: normalizedParts };
  }
  return result;
}

function asArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 42) || "tool";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function resolveWorkingDirectory(workspaceRoot: string, configuredPath: string | undefined): Promise<string> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  if (!configuredPath) return canonicalWorkspace;

  const absolute = path.resolve(canonicalWorkspace, configuredPath);
  const relative = path.relative(canonicalWorkspace, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`MCP cwd must stay inside workspace: ${configuredPath}`);
  }

  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`MCP cwd cannot be a symbolic link: ${configuredPath}`);
  if (!stat.isDirectory()) throw new Error(`MCP cwd must be a directory: ${configuredPath}`);
  const canonical = await fs.realpath(absolute);
  const canonicalRelative = path.relative(canonicalWorkspace, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`MCP cwd must stay inside workspace: ${configuredPath}`);
  }
  if (canonical !== absolute) throw new Error(`MCP cwd cannot contain symbolic links: ${configuredPath}`);
  return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
