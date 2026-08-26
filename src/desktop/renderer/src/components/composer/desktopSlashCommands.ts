/**
 * Desktop Composer 的命令展示数据。
 *
 * TUI 与 Desktop 共用执行协议，但两端的入口职责不同。这里保留一组适合桌面聊天的
 * 高频动作，并把当前有效 Skill 作为同一份补全数据源，避免把 TUI 的内部管理命令全部
 * 暴露给桌面用户。
 */
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { DesktopSkillCatalogEntry, DesktopSlashCommand } from "../../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../../protocol.js";
import type { IconName } from "../Icon.js";

export const DESKTOP_COMPOSER_COMMAND_NAMES = [
  "/usage",
  "/status",
  "/compact",
  "/mcp",
  "/skills",
  "/plugins",
  "/subagent",
  "/review",
  "/undo"
] as const;

interface CommandPresentation {
  group: string;
  title: string;
  description: string;
  usage: string;
  icon: IconName;
}

const COMMAND_PRESENTATIONS: Record<typeof DESKTOP_COMPOSER_COMMAND_NAMES[number], CommandPresentation> = {
  "/usage": {
    group: "对话状态",
    title: "用量",
    description: "查看当前模型的 token 用量和费用",
    usage: "/usage",
    icon: "timer"
  },
  "/status": {
    group: "对话状态",
    title: "运行状态",
    description: "查看模型、上下文、权限和扩展状态",
    usage: "/status",
    icon: "activity"
  },
  "/compact": {
    group: "对话状态",
    title: "压缩对话",
    description: "压缩较早的对话历史，为当前任务释放上下文空间",
    usage: "/compact [提示]",
    icon: "archive"
  },
  "/mcp": {
    group: "扩展能力",
    title: "MCP 服务器",
    description: "查看服务器和工具，或重连指定服务器",
    usage: "/mcp reconnect <server>",
    icon: "network"
  },
  "/skills": {
    group: "扩展能力",
    title: "Skills",
    description: "查看当前项目与全局 Skill；下方可直接选择一个 Skill",
    usage: "/skills",
    icon: "wand"
  },
  "/plugins": {
    group: "扩展能力",
    title: "Plugins",
    description: "查看当前项目已安装的 Plugin",
    usage: "/plugins",
    icon: "puzzle"
  },
  "/subagent": {
    group: "扩展能力",
    title: "子代理",
    description: "启动、查看、取消或列出子代理任务",
    usage: "/subagent start|status|cancel|agents",
    icon: "person"
  },
  "/review": {
    group: "扩展能力",
    title: "只读审查",
    description: "让子代理审查当前工作区的变更和风险",
    usage: "/review [重点]",
    icon: "search"
  },
  "/undo": {
    group: "工作区",
    title: "恢复检查点",
    description: "从 Biny 检查点恢复工作区文件",
    usage: "/undo [checkpoint]",
    icon: "arrow-left"
  }
};

export type DesktopComposerItemData =
  | {
    kind: "command";
    group: string;
    title: string;
    description: string;
    usage: string;
    icon: IconName;
    keywords: string[];
    commandName: string;
    acceptsArgs: boolean;
    skill: undefined;
  }
  | {
    kind: "skill";
    group: string;
    title: string;
    description: string;
    usage: string;
    icon: IconName;
    keywords: string[];
    commandName: undefined;
    acceptsArgs: false;
    skill: DesktopSkillCatalogEntry;
  };

export type DesktopComposerItem = SearchableItem<DesktopComposerItemData>;

const desktopComposerCommandNames = new Set<string>(DESKTOP_COMPOSER_COMMAND_NAMES);

export function buildDesktopComposerItems(skills: readonly DesktopSkillCatalogEntry[]): DesktopComposerItem[] {
  const commandItems = DESKTOP_SLASH_COMMANDS
    .filter((command) => desktopComposerCommandNames.has(command.name))
    .flatMap((command) => {
      const presentation = COMMAND_PRESENTATIONS[command.name as typeof DESKTOP_COMPOSER_COMMAND_NAMES[number]];
      if (!presentation) return [];
      return [{
        id: command.name,
        label: command.name,
        auxiliaryData: {
          kind: "command" as const,
          group: presentation.group,
          title: presentation.title,
          description: presentation.description,
          usage: presentation.usage,
          icon: presentation.icon,
          keywords: [command.name, presentation.title, presentation.description],
          commandName: command.name,
          acceptsArgs: command.acceptsArgs === true,
          skill: undefined
        }
      } satisfies DesktopComposerItem];
    });

  const uniqueSkills = new Map<string, DesktopSkillCatalogEntry>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!uniqueSkills.has(key)) uniqueSkills.set(key, skill);
  }
  const skillItems = [...uniqueSkills.values()]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((skill) => ({
      id: `/skills:${skill.name}`,
      label: `/skills:${skill.name}`,
      auxiliaryData: {
        kind: "skill" as const,
        group: "Skills",
        title: skill.name,
        description: skill.description || "调用此 Skill 处理当前任务",
        usage: "Enter 选择并插入 Skill",
        icon: "wand" as const,
        keywords: [skill.name, skill.description],
        commandName: undefined,
        acceptsArgs: false as const,
        skill
      }
    } satisfies DesktopComposerItem));

  return [...commandItems, ...skillItems];
}

export function isSkillSlashCommand(value: string): boolean {
  const normalized = normalizeSkillSlashCommand(value);
  return /^\/skills?:[^\s]+(?:\s|$)/u.test(normalized);
}

export function normalizeSkillSlashCommand(value: string): string {
  return value.trim().replace(/\u00a0/g, " ");
}

export function desktopCommandForName(name: string): DesktopSlashCommand | undefined {
  return DESKTOP_SLASH_COMMANDS.find((command) => command.name === name);
}
