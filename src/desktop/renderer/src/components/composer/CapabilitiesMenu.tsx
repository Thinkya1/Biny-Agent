/** 本条消息的工具与 Skill 选择器：默认值来自设置，数组只随当前回合传给 Runtime。 */
import { useEffect, useMemo, useState } from "react";
import type { AgentCapabilitySelection, CapabilitySelectionValue } from "../../../../../agent/capabilitySelection.js";
import type { DesktopSkillCatalogEntry, DesktopToolCatalogEntry } from "../../../../protocol.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { Icon } from "../Icon.js";
import { ComposerPopover } from "./ComposerPopover.js";

type CapabilityTab = "tools" | "skills";

const sourceLabels: Record<DesktopToolCatalogEntry["source"], string> = {
  builtin: "内置工具",
  mcp: "MCP",
  plugin: "插件",
  skill: "Skill 工具",
  subagent: "子 Agent"
};

const skillSourceLabels: Record<DesktopSkillCatalogEntry["source"], string> = {
  agents: "外部 Agent Skill",
  biny: "Biny Skill"
};

export function CapabilitiesMenu({ anchorRef, open, onChange, selection, skills, tools, toolsSupported }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onChange(selection: AgentCapabilitySelection): void;
  selection: AgentCapabilitySelection;
  skills: DesktopSkillCatalogEntry[];
  toolsSupported: boolean;
  tools: DesktopToolCatalogEntry[];
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [tab, setTab] = useState<CapabilityTab>("tools");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) return;
    setQuery("");
  }, [open]);

  const filteredTools = useMemo(() => filterTools(tools, query), [query, tools]);
  const filteredSkills = useMemo(() => filterSkills(skills, query), [query, skills]);
  if (!presence.present) return null;

  const activeCount = tab === "tools"
    ? toolsSupported ? selectionCount(selection.tools, tools.map((tool) => tool.name)) : 0
    : selectionCount(selection.skills, skills.map((skill) => skill.ref));
  const activeItems = tab === "tools" ? filteredTools : filteredSkills;
  const hasItems = activeItems.length > 0;

  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover biny-composer-popover capabilities-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div className="capabilities-panel">
        <div className="popover-heading">本条消息使用的能力</div>
        <div aria-label="能力类型" className="capabilities-tabs" role="tablist">
          <button aria-selected={tab === "tools"} className={tab === "tools" ? "is-selected" : ""} onClick={() => setTab("tools")} role="tab" type="button">工具 <span>{String(tools.length)}</span></button>
          <button aria-selected={tab === "skills"} className={tab === "skills" ? "is-selected" : ""} onClick={() => setTab("skills")} role="tab" type="button">Skill <span>{String(skills.length)}</span></button>
        </div>
        <label className="capabilities-search">
          <Icon name="search" size={13} />
          <input aria-label={tab === "tools" ? "搜索工具" : "搜索 Skill"} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "tools" ? "搜索工具" : "搜索 Skill"} type="search" value={query} />
        </label>
        <div aria-label="能力选择模式" className="capability-mode-row" role="radiogroup">
          <ModeButton label="自动" selected={selection[tab] === "auto"} onClick={() => onChange({ ...selection, [tab]: "auto" })} />
          <ModeButton label="全部" selected={selection[tab] === "all"} onClick={() => onChange({ ...selection, [tab]: "all" })} />
          <ModeButton label="清空" selected={Array.isArray(selection[tab]) && selection[tab].length === 0} onClick={() => onChange({ ...selection, [tab]: [] })} />
        </div>
        <div className="capabilities-list" role="listbox" aria-label={tab === "tools" ? "工具列表" : "Skill 列表"} aria-multiselectable="true">
          {tab === "tools" && !toolsSupported ? (
            <p className="capabilities-empty">当前模型的能力声明不支持工具调用，切换支持工具的模型后生效。</p>
          ) : tab === "tools" ? (
            <ToolList items={filteredTools} selection={selection.tools} onToggle={(name) => onChange({ ...selection, tools: toggleSelection(selection.tools, name, tools.map((tool) => tool.name)) })} />
          ) : (
            <SkillList items={filteredSkills} selection={selection.skills} onToggle={(ref) => onChange({ ...selection, skills: toggleSelection(selection.skills, ref, skills.map((skill) => skill.ref)) })} />
          )}
          {!hasItems ? <p className="capabilities-empty">{query.trim() ? "没有匹配的能力" : tab === "tools" ? "当前项目没有可用工具" : "当前项目没有启用的 Skill"}</p> : null}
        </div>
        <div className="capabilities-footer"><Icon name="wand" size={13} /><span>{activeCount ? `已选择 ${String(activeCount)} 项` : "未选择能力"} · 可在设置中修改默认值</span></div>
      </div>
    </ComposerPopover>
  );
}

function ModeButton({ label, onClick, selected }: { label: string; onClick(): void; selected: boolean }): React.JSX.Element {
  return <button aria-checked={selected} className={`capability-mode-button${selected ? " is-selected" : ""}`} onClick={onClick} role="radio" type="button">{label}</button>;
}

function ToolList({ items, onToggle, selection }: { items: DesktopToolCatalogEntry[]; onToggle(name: string): void; selection: CapabilitySelectionValue }): React.JSX.Element {
  return <>{groupBy(items, (item) => sourceLabels[item.source]).map(([group, groupItems]) => <div className="capability-group" key={group}>
    <div className="capability-group-heading">{group}</div>
    {groupItems.map((tool) => <CapabilityItem checked={isSelected(selection, tool.name)} detail={tool.description} key={tool.name} label={tool.name} meta={tool.risk} onClick={() => onToggle(tool.name)} />)}
  </div>)}</>;
}

function SkillList({ items, onToggle, selection }: { items: DesktopSkillCatalogEntry[]; onToggle(ref: string): void; selection: CapabilitySelectionValue }): React.JSX.Element {
  return <>{groupBy(items, (item) => skillSourceLabels[item.source] ?? item.source).map(([group, groupItems]) => <div className="capability-group" key={group}>
    <div className="capability-group-heading">{group}</div>
    {groupItems.map((skill) => <CapabilityItem checked={isSelected(selection, skill.ref)} detail={skill.description} key={skill.ref} label={skill.name} meta={skill.scope} onClick={() => onToggle(skill.ref)} />)}
  </div>)}</>;
}

function CapabilityItem({ checked, detail, label, meta, onClick }: { checked: boolean; detail: string; label: string; meta?: string; onClick(): void }): React.JSX.Element {
  return <button aria-checked={checked} className={`capability-item${checked ? " is-selected" : ""}`} onClick={onClick} role="option" type="button">
    <span className="capability-item-check">{checked ? <Icon name="check" size={12} /> : null}</span>
    <span className="capability-item-copy"><strong>{label}</strong><small>{detail || "无描述"}</small></span>
    {meta ? <span className="capability-item-meta">{meta}</span> : null}
  </button>;
}

function filterTools(tools: DesktopToolCatalogEntry[], query: string): DesktopToolCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return tools;
  return tools.filter((tool) => `${tool.name} ${tool.description} ${tool.source}`.toLocaleLowerCase().includes(normalized));
}

function filterSkills(skills: DesktopSkillCatalogEntry[], query: string): DesktopSkillCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return skills;
  return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.ref}`.toLocaleLowerCase().includes(normalized));
}

function selectionCount(selection: CapabilitySelectionValue, allNames: string[]): number {
  if (selection === "auto" || selection === "all") return allNames.length;
  return selection.length;
}

function isSelected(selection: CapabilitySelectionValue, name: string): boolean {
  return selection === "auto" || selection === "all" ? true : selection.includes(name);
}

function toggleSelection(selection: CapabilitySelectionValue, name: string, allNames: string[]): string[] {
  const current = selection === "auto" || selection === "all" ? new Set(allNames) : new Set(selection);
  if (current.has(name)) current.delete(name);
  else current.add(name);
  return allNames.filter((candidate) => current.has(candidate));
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()];
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
