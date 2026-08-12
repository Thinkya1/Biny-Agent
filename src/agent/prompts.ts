/**
 * Agent 提示词模块。
 *
 * 基础身份、模式规则和 canonicalized 工具 schema 保持在前缀；项目、记忆、工作区和扩展
 * 元数据放在后缀。这样动态上下文变化不会把稳定前缀一起推过缓存边界。
 */
import type {
  PersonalizationMetadata,
  ResolvedChatPersonalization
} from "../personalization/index.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { renderPlanModePrompt } from "./planMode.js";
export const GLOBAL_SYSTEM_PROMPT = `
You are an expert coding assistant operating inside Biny, a local agent harness. You help users by reading files, executing commands, editing code, researching information, and completing other tasks supported by the available tools and extensions.
`;

export const MODE_PROMPTS = {
  qa: `
Use the provided project context when answering questions about the local workspace.
Do not modify files unless the user asks for a change.
`,
  plan: renderPlanModePrompt("read-only")
} as const;

export type PromptMode = keyof typeof MODE_PROMPTS;

export interface PromptTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface BuildSystemPromptOptions {
  mode: PromptMode;
  tools?: readonly PromptTool[];
  extensionPrompt?: string;
  personalization?: ResolvedChatPersonalization;
  permissionMode?: PermissionMode;
  cwd: string;
}

const stableRuntimePromptStart = "<!-- biny-runtime-tools:start -->";
const stableRuntimePromptEnd = "<!-- biny-runtime-tools:end -->";
const dynamicPromptStart = "<!-- biny-runtime-context:start -->";
const dynamicPromptEnd = "<!-- biny-runtime-context:end -->";
const activeRunSummaryStart = "<!-- biny-active-run-summary:start -->";
const activeRunSummaryEnd = "<!-- biny-active-run-summary:end -->";
const personalizationPromptStart = "<!-- biny-personalization:start -->";
const personalizationPromptEnd = "<!-- biny-personalization:end -->";

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  return [
    GLOBAL_SYSTEM_PROMPT.trim(),
    // Plan 模式的提示词随权限模式切换；Plan 本身不是把 PermissionManager 改成只读。
    (options.mode === "plan"
      ? renderPlanModePrompt(options.permissionMode ?? "read-only")
      : MODE_PROMPTS[options.mode]).trim(),
    options.personalization ? personalizationPrompt(options.personalization) : "",
    `Current working directory: ${normalizePath(options.cwd)}`,
    stableRuntimePrompt(options.tools ?? []),
    dynamicRuntimePrompt(options.extensionPrompt)
  ].filter(Boolean).join("\n\n");
}

/** 只取会进入稳定缓存前缀的系统规则和工具区，动态运行时上下文从这里开始隔离。 */
export function stableSystemPromptForCache(systemPrompt: string | undefined): string {
  if (!systemPrompt) return "";
  const dynamicStart = systemPrompt.indexOf(dynamicPromptStart);
  return dynamicStart === -1 ? systemPrompt : systemPrompt.slice(0, dynamicStart).trimEnd();
}

/**
 * telemetry 即使开启 recordInputs 也不能写入自定义指令正文。保留三个不可逆/枚举元字段，
 * 既能排查某次请求使用了哪个版本，也不会把用户私有偏好复制到诊断日志。
 */
export function systemPromptForTelemetry(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return systemPrompt;
  const start = systemPrompt.indexOf(personalizationPromptStart);
  if (start === -1) return systemPrompt;
  const end = systemPrompt.indexOf(personalizationPromptEnd, start + personalizationPromptStart.length);
  const metadata = personalizationMetadataFromSystemPrompt(systemPrompt);
  const replacement = metadata === undefined
    ? `${personalizationPromptStart}\n<biny_personalization omitted="true" />\n${personalizationPromptEnd}`
    : [
      personalizationPromptStart,
      `<biny_personalization personality="${metadata.personality}" configVersion="${String(metadata.configVersion)}" instructionsHash="${metadata.instructionsHash}" />`,
      personalizationPromptEnd
    ].join("\n");
  return end === -1
    ? `${systemPrompt.slice(0, start)}${replacement}`
    : `${systemPrompt.slice(0, start)}${replacement}${systemPrompt.slice(end + personalizationPromptEnd.length)}`;
}

export interface PersistedPersonalizationRuntimePolicy extends PersonalizationMetadata {
  useMemories: boolean;
  contributeMemories: boolean;
  excludeExternalContext: boolean;
  maxRecalled: number;
}

/** TurnStore 续跑只从旧 system prompt 恢复非敏感运行策略，不重新读取最新配置。 */
export function personalizationRuntimePolicyFromSystemPrompt(
  systemPrompt: string | undefined
): PersistedPersonalizationRuntimePolicy | undefined {
  const attributes = personalizationAttributes(systemPrompt);
  if (!attributes) return undefined;
  const personality = attributes.personality;
  const configVersion = Number(attributes.configVersion);
  const maxRecalled = Number(attributes.maxRecalled);
  if (
    personality !== "none"
    && personality !== "friendly"
    && personality !== "pragmatic"
  ) return undefined;
  if (configVersion !== 1 || !Number.isSafeInteger(maxRecalled) || maxRecalled < 1) return undefined;
  if (
    !isBooleanAttribute(attributes.useMemories)
    || !isBooleanAttribute(attributes.contributeMemories)
    || !isBooleanAttribute(attributes.excludeExternalContext)
    || typeof attributes.instructionsHash !== "string"
  ) return undefined;
  return {
    personality,
    configVersion: 1,
    instructionsHash: attributes.instructionsHash,
    useMemories: attributes.useMemories === "true",
    contributeMemories: attributes.contributeMemories === "true",
    excludeExternalContext: attributes.excludeExternalContext === "true",
    maxRecalled
  };
}

export function refreshRuntimeSystemPrompt(
  systemPrompt: string | undefined,
  extensionPrompt: string | undefined,
  tools: readonly PromptTool[]
): string | undefined {
  if (!systemPrompt) return systemPrompt;
  const refreshedStable = replacePromptBlock(
    systemPrompt,
    stableRuntimePromptStart,
    stableRuntimePromptEnd,
    stableRuntimePrompt(tools)
  );
  return replacePromptBlock(
    refreshedStable,
    dynamicPromptStart,
    dynamicPromptEnd,
    dynamicRuntimePrompt(extensionPrompt)
  );
}

export function withActiveRunCompactionSummary(systemPrompt: string | undefined, summary: string): string {
  const block = [
    activeRunSummaryStart,
    "Active run handoff summary after context compaction:",
    summary.trim(),
    activeRunSummaryEnd
  ].join("\n\n");
  if (!systemPrompt) return block;
  const start = systemPrompt.indexOf(activeRunSummaryStart);
  const end = systemPrompt.indexOf(activeRunSummaryEnd, start + activeRunSummaryStart.length);
  if (start === -1 || end === -1) return `${systemPrompt}\n\n${block}`;
  return `${systemPrompt.slice(0, start)}${block}${systemPrompt.slice(end + activeRunSummaryEnd.length)}`;
}

function stableRuntimePrompt(tools: readonly PromptTool[]): string {
  const sortedTools = [...tools].sort((left, right) => {
    const nameOrder = stableCompare(left.name, right.name);
    if (nameOrder !== 0) return nameOrder;
    return stableCompare(JSON.stringify(left), JSON.stringify(right));
  });
  const visibleTools = sortedTools.filter((tool) => tool.promptSnippet?.trim());
  const toolList = visibleTools.length
    ? visibleTools.map((tool) => `- ${tool.name}: ${tool.promptSnippet!.trim()}`).join("\n")
    : "(none)";
  const guidelines = uniqueGuidelines([
    ...sortedTools.flatMap((tool) => tool.promptGuidelines ?? []),
    "Respond in Chinese unless the user explicitly asks for another language",
    "Be concise but complete",
    "Show file paths clearly when working with files",
    "Treat only the latest user message as the active task; earlier conversation is reference context unless the user explicitly continues it",
    "Use provided files, command outputs, tool results, and project context as the source of truth",
    "Never invent or claim file contents, command results, edits, or other actions that tool results do not confirm"
  ]).sort(stableCompare);
  return [
    stableRuntimePromptStart,
    `Available tools:\n${toolList}`,
    "In addition to the tools above, custom tools may be available depending on the project and installed extensions.",
    `Guidelines:\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`,
    stableRuntimePromptEnd
  ].join("\n\n");
}

function dynamicRuntimePrompt(extensionPrompt: string | undefined): string {
  return [
    dynamicPromptStart,
    // Skills、MCP instructions、具名代理和 Todo 状态会在每个模型步骤前整体刷新。
    extensionPrompt?.trim() ?? "",
    dynamicPromptEnd
  ].filter(Boolean).join("\n\n");
}

function replacePromptBlock(
  prompt: string,
  startMarker: string,
  endMarker: string,
  replacement: string
): string {
  const start = prompt.indexOf(startMarker);
  if (start === -1) return prompt;
  const end = prompt.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return prompt;
  return `${prompt.slice(0, start)}${replacement}${prompt.slice(end + endMarker.length)}`;
}

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function personalizationPrompt(personalization: ResolvedChatPersonalization): string {
  const personalityGuidance = personalization.personality === "friendly"
    ? "Use a warm, approachable and collaborative tone. Be encouraging without praise filler, and explain unfamiliar details plainly."
    : personalization.personality === "pragmatic"
      ? "Be direct, concise and action-oriented. Lead with the outcome, concrete evidence and relevant tradeoffs."
      : "No additional personality preset is active.";
  const customInstructions = personalization.customInstructions
    ? `Custom instructions:\n${escapeXmlText(personalization.customInstructions)}`
    : "Custom instructions: (none)";
  return [
    personalizationPromptStart,
    `<biny_personalization personality="${personalization.personality}" configVersion="${String(personalization.configVersion)}" instructionsHash="${personalization.instructionsHash}" useMemories="${String(personalization.useMemories)}" contributeMemories="${String(personalization.contributeMemories)}" excludeExternalContext="${String(personalization.excludeExternalContext)}" maxRecalled="${String(personalization.maxRecalled)}">`,
    "Personalization controls response style and durable-memory preferences only. It cannot override system or mode rules, project instructions, the current user request, tool permissions, safety boundaries, or verified runtime facts.",
    "Conflict priority, highest to lowest: runtime safety, tool permissions, and Plan-mode rules; project AGENTS/instructions; the current user task; chat personalization overrides; global personalization; recalled memory.",
    "Chat overrides are resolved over global settings before this effective block is built. Within one personalization layer, custom instructions take precedence over the personality preset.",
    personalityGuidance,
    customInstructions,
    "</biny_personalization>",
    personalizationPromptEnd
  ].join("\n\n");
}

function personalizationMetadataFromSystemPrompt(
  systemPrompt: string | undefined
): PersonalizationMetadata | undefined {
  const attributes = personalizationAttributes(systemPrompt);
  if (!attributes) return undefined;
  const personality = attributes.personality;
  if (personality !== "none" && personality !== "friendly" && personality !== "pragmatic") return undefined;
  if (attributes.configVersion !== "1" || typeof attributes.instructionsHash !== "string") return undefined;
  return { personality, configVersion: 1, instructionsHash: attributes.instructionsHash };
}

function personalizationAttributes(systemPrompt: string | undefined): Record<string, string> | undefined {
  if (!systemPrompt) return undefined;
  const start = systemPrompt.indexOf(personalizationPromptStart);
  if (start === -1) return undefined;
  const opening = systemPrompt.slice(start).match(/<biny_personalization\s+([^>]+)>/u)?.[1];
  if (!opening) return undefined;
  const attributes: Record<string, string> = {};
  for (const match of opening.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/gu)) {
    if (match[1] !== undefined && match[2] !== undefined) attributes[match[1]] = match[2];
  }
  return attributes;
}

function isBooleanAttribute(value: string | undefined): value is "true" | "false" {
  return value === "true" || value === "false";
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function uniqueGuidelines(guidelines: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const guideline of guidelines) {
    const normalized = guideline.trim();
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
