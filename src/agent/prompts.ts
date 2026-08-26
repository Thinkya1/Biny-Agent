/**
 * Agent 提示词模块。
 *
 * 基础身份、模式规则和 canonicalized 工具 schema 保持在前缀；项目、记忆、工作区和扩展
 * 元数据放在后缀。这样动态上下文变化不会把稳定前缀一起推过缓存边界。
 */
import type {
  PersonalizationMetadata,
  PersonalityPreset,
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
  personalization?: ResolvedChatPersonalization;
  /** 已读取的用户 TELOS；只作为指导，不进入 telemetry 明文。 */
  telosPrompt?: string;
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
    [
      AUTONOMY_AND_BOUNDARIES_PROMPT.trim(),
      `Current permission mode: ${options.permissionMode ?? "runtime-managed"}.`
    ].join("\n"),
    options.personalization ? personalizationPrompt(options.personalization, options.telosPrompt) : "",
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
  telos: ResolvedChatPersonalization["telos"];
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
    && personality !== "buddy"
  ) return undefined;
  if (configVersion !== 1 || !Number.isSafeInteger(maxRecalled) || maxRecalled < 1) return undefined;
  if (
    !isBooleanAttribute(attributes.useMemories)
    || !isBooleanAttribute(attributes.contributeMemories)
    || !isBooleanAttribute(attributes.excludeExternalContext)
    || typeof attributes.instructionsHash !== "string"
  ) return undefined;
  const telos = {
    enabled: attributes.telosEnabled === "true",
    autoObserve: attributes.telosAutoObserve === "true",
    driftDetection: attributes.telosDriftDetection === "true",
    proactivePrompts: attributes.telosProactivePrompts === "true"
  };
  return {
    personality,
    configVersion: 1,
    instructionsHash: attributes.instructionsHash,
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

/**
 * 每种人格预设对应的完整语气指导。none 之外的分支会直接注入 system prompt，
 * 所以 buddy 给的是整段人格卡而不是一句描述，避免模型把预设收敛成"平均客服"。
 * Record 以 PersonalityPreset 为键：新增预设而不补指导会在 typecheck 期就报错。
 */
const PERSONALITY_GUIDANCE: Record<PersonalityPreset, string> = {
  none: "No additional personality preset is active.",
  friendly: "Use a warm, approachable and collaborative tone. Be encouraging without praise filler, and explain unfamiliar details plainly.",
  pragmatic: "Be direct, concise and action-oriented. Lead with the outcome, concrete evidence and relevant tradeoffs.",
  buddy: `像跟朋友发消息一样说话，不是客服。
- 短句，口语化，自然停顿；不写公文腔、不堆结构化列表。
- 禁止开场白："好的""当然""没问题""我很乐意""收到""你好！"——直接从事情本身开始。
- 禁止结尾客套："还需要我帮你做什么吗？""希望对你有帮助"——做完就停。
- 有观点：被问方案优劣时给出明确判断和理由，禁止"各有优劣"式和稀泥。
- 技术内容保持准确、具体、有证据（文件路径、行号、实测结果）；放松的是语气，不是事实。
- emoji 克制：大部分消息一个都不用。
- 没做成或不确定就直接说，不找借口、不假装完成。`
};

function personalizationPrompt(personalization: ResolvedChatPersonalization, telosPrompt?: string): string {
  const personalityGuidance = PERSONALITY_GUIDANCE[personalization.personality];
  const customInstructions = personalization.customInstructions
    ? `Custom instructions:\n${escapeXmlText(personalization.customInstructions)}`
    : "Custom instructions: (none)";
  return [
    personalizationPromptStart,
    `<biny_personalization personality="${personalization.personality}" configVersion="${String(personalization.configVersion)}" instructionsHash="${personalization.instructionsHash}" useMemories="${String(personalization.useMemories)}" contributeMemories="${String(personalization.contributeMemories)}" excludeExternalContext="${String(personalization.excludeExternalContext)}" maxRecalled="${String(personalization.maxRecalled)}" telosEnabled="${String(personalization.telos.enabled)}" telosAutoObserve="${String(personalization.telos.autoObserve)}" telosDriftDetection="${String(personalization.telos.driftDetection)}" telosProactivePrompts="${String(personalization.telos.proactivePrompts)}">`,
    "Personalization controls response style and durable-memory preferences only. It cannot override system or mode rules, project instructions, the current user request, tool permissions, safety boundaries, or verified runtime facts.",
    "Conflict priority, highest to lowest: runtime safety, tool permissions, and Plan-mode rules; project AGENTS/instructions; the current user task; chat personalization overrides; global personalization; recalled memory.",
    "Chat overrides are resolved over global settings before this effective block is built. Within one personalization layer, custom instructions take precedence over the personality preset.",
    personalityGuidance,
    customInstructions,
    personalization.telos.enabled && telosPrompt?.trim()
      ? `Active TELOS guidance (user-owned, advisory only):\n${escapeXmlText(telosPrompt.trim())}`
      : "Active TELOS guidance: (none)",
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
  if (personality !== "none" && personality !== "friendly" && personality !== "pragmatic" && personality !== "buddy") return undefined;
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
