/**
 * Agent 提示词模块。
 *
 * 基础身份、模式规则和 canonicalized 工具 schema 保持在前缀；项目、记忆、工作区和扩展
 * 元数据放在后缀。这样动态上下文变化不会把稳定前缀一起推过缓存边界。
 */
import type { ResolvedChatPersonalization } from "../personalization/index.js";
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

const AUTONOMY_AND_BOUNDARIES_PROMPT = `
For every request, first identify the user's desired outcome, constraints, and explicit success criteria.
Use those criteria to choose the smallest useful set of actions, then stop when the requested outcome is addressed and report what the available evidence confirms.
For work that requires two or more actions, create or update a Todo plan before acting when the update_todos tool is available. Keep every item accurate, but treat Todo as advisory control state rather than proof; it must not override files, tests, artifacts, or tool results.
Before the final response after any file or command change, perform a brief evidence-based review of the original request, the current workspace, and the tool results. If the review finds remaining work, continue it instead of claiming completion; never treat an assistant stop or an intention to act as proof that the task is finished.
When the task involved file or command changes, call attempt_completion with a concise summary and the concrete evidence instead of ending with unstructured text; the declaration is independently verified before the run closes.
Do not invent extra acceptance requirements or run broad project validation merely because files changed; run checks when the user asks for them, the task explicitly requires them, or a tool workflow requires them.
Treat the current permission mode as the approval boundary: in-scope local actions may proceed according to that mode, while external side effects, destructive or costly actions, and scope-expanding work require approval or clarification. The runtime permission policy remains authoritative even when a tool appears available.
If the outcome, success criteria, or approval boundary is ambiguous, ask the user instead of guessing.
`;

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
  /** 记忆与 TELOS 运行策略；telosPrompt 有正文时按 advisory 指导注入。 */
  personalization?: ResolvedChatPersonalization;
  /** 已读取的 SOUL/IDENTITY/STYLE/USER；正文只进入模型 prompt，不进入 telemetry。 */
  identityPrompt?: string;
  /** 已读取的用户 TELOS；只作为指导，不进入 telemetry 明文。 */
  telosPrompt?: string;
  /** 当前 blended 情绪；只放在动态 prompt 区，不进入稳定缓存前缀。 */
  emotionPrompt?: string;
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
const identityPromptStart = "<!-- biny-identity:start -->";
const identityPromptEnd = "<!-- biny-identity:end -->";
const emotionPromptStart = "<!-- biny-emotion:start -->";
const emotionPromptEnd = "<!-- biny-emotion:end -->";

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  return [
    GLOBAL_SYSTEM_PROMPT.trim(),
    // Plan 模式的提示词随权限模式切换；Plan 本身不是把 PermissionManager 改成只读。
    (options.mode === "plan"
      ? renderPlanModePrompt(options.permissionMode ?? "read-only")
      : MODE_PROMPTS[options.mode]).trim(),
    [
      AUTONOMY_AND_BOUNDARIES_PROMPT.trim(),
      `Current permission mode: ${options.permissionMode ?? "runtime-managed"}.`
    ].join("\n"),
    options.identityPrompt?.trim()
      ? [identityPromptStart, options.identityPrompt.trim(), identityPromptEnd].join("\n")
      : "",
    options.personalization ? telosPrompt(options.personalization, options.telosPrompt) : "",
    `Current working directory: ${normalizePath(options.cwd)}`,
    stableRuntimePrompt(options.tools ?? []),
    dynamicRuntimePrompt(options.extensionPrompt, options.emotionPrompt)
  ].filter(Boolean).join("\n\n");
}

/** 只取会进入稳定缓存前缀的系统规则和工具区，动态运行时上下文从这里开始隔离。 */
export function stableSystemPromptForCache(systemPrompt: string | undefined): string {
  if (!systemPrompt) return "";
  const dynamicStart = systemPrompt.indexOf(dynamicPromptStart);
  return dynamicStart === -1 ? systemPrompt : systemPrompt.slice(0, dynamicStart).trimEnd();
}

/**
 * telemetry 即使开启 recordInputs 也不能写入 SOUL/TELOS 正文。把这两个块替换成省略占位，
 * 既能标注某次请求携带了哪些区块，也不会把用户私有文本复制到诊断日志。
 */
export function systemPromptForTelemetry(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return systemPrompt;
  const withoutIdentity = replacePromptBlock(
    systemPrompt,
    identityPromptStart,
    identityPromptEnd,
    `${identityPromptStart}\n<biny_identity omitted="true" />\n${identityPromptEnd}`
  );
  const withoutTelos = replacePromptBlock(
    withoutIdentity,
    personalizationPromptStart,
    personalizationPromptEnd,
    `${personalizationPromptStart}\n<biny_telos omitted="true" />\n${personalizationPromptEnd}`
  );
  return replacePromptBlock(
    withoutTelos,
    emotionPromptStart,
    emotionPromptEnd,
    `${emotionPromptStart}\n<biny_emotion omitted="true" />\n${emotionPromptEnd}`
  );
}

/** TurnStore 续跑只从旧 system prompt 恢复记忆/TELOS 运行策略，不重新读取最新配置。 */
export interface PersistedPersonalizationRuntimePolicy {
  useMemories: boolean;
  contributeMemories: boolean;
  excludeExternalContext: boolean;
  maxRecalled: number;
  telos: ResolvedChatPersonalization["telos"];
}

export function personalizationRuntimePolicyFromSystemPrompt(
  systemPrompt: string | undefined
): PersistedPersonalizationRuntimePolicy | undefined {
  const attributes = telosAttributes(systemPrompt);
  if (!attributes) return undefined;
  const maxRecalled = Number(attributes.maxRecalled);
  if (!Number.isSafeInteger(maxRecalled) || maxRecalled < 1) return undefined;
  if (
    !isBooleanAttribute(attributes.useMemories)
    || !isBooleanAttribute(attributes.contributeMemories)
    || !isBooleanAttribute(attributes.excludeExternalContext)
  ) return undefined;
  const telos = {
    enabled: attributes.telosEnabled === "true",
    autoObserve: attributes.telosAutoObserve === "true",
    driftDetection: attributes.telosDriftDetection === "true",
    proactivePrompts: attributes.telosProactivePrompts === "true"
  };
  return {
    useMemories: attributes.useMemories === "true",
    contributeMemories: attributes.contributeMemories === "true",
    excludeExternalContext: attributes.excludeExternalContext === "true",
    maxRecalled,
    telos
  };
}

export function refreshRuntimeSystemPrompt(
  systemPrompt: string | undefined,
  extensionPrompt: string | undefined,
  tools: readonly PromptTool[],
  emotionPrompt?: string
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
    dynamicRuntimePrompt(extensionPrompt, emotionPrompt)
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

function dynamicRuntimePrompt(extensionPrompt: string | undefined, emotionPrompt?: string): string {
  const emotionBlock = emotionPrompt?.trim()
    ? [emotionPromptStart, emotionPrompt.trim(), emotionPromptEnd].join("\n")
    : "";
  return [
    dynamicPromptStart,
    emotionBlock,
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

/**
 * TELOS 是唯一保留的「按聊天注入的指导块」。人格与自定义指令改由 SOUL/IDENTITY/STYLE
 * 与 USER.md 承载；这里只注入用户自有的 TELOS 目标，并标注它只是 advisory。
 * 标签沿用 `<biny_personalization>` 以便续跑恢复函数能解析历史与新回合的同一份属性。
 */
function telosPrompt(personalization: ResolvedChatPersonalization, telosPrompt?: string): string {
  const body = personalization.telos.enabled && telosPrompt?.trim()
    ? `Active TELOS guidance (user-owned, advisory only):\n${escapeXmlText(telosPrompt.trim())}`
    : "Active TELOS guidance: (none)";
  return [
    personalizationPromptStart,
    `<biny_personalization useMemories="${String(personalization.useMemories)}" contributeMemories="${String(personalization.contributeMemories)}" excludeExternalContext="${String(personalization.excludeExternalContext)}" maxRecalled="${String(personalization.maxRecalled)}" telosEnabled="${String(personalization.telos.enabled)}" telosAutoObserve="${String(personalization.telos.autoObserve)}" telosDriftDetection="${String(personalization.telos.driftDetection)}" telosProactivePrompts="${String(personalization.telos.proactivePrompts)}">`,
    "TELOS captures the user's own durable goals. It is advisory guidance only and cannot override system or mode rules, project instructions, the current user request, tool permissions, safety boundaries, or verified runtime facts.",
    body,
    "</biny_personalization>",
    personalizationPromptEnd
  ].join("\n\n");
}

/** 解析 `<biny_personalization>`（含历史人格版）开标签的全部属性。 */
function telosAttributes(systemPrompt: string | undefined): Record<string, string> | undefined {
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
