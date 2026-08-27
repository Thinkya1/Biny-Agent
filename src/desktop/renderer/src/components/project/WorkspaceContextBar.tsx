/**
 * Composer 底栏内联的项目选择器（Alma 式：工具栏左组的文件夹 + 项目名）。
 *
 * 菜单只表达选择意图，项目切换由 App 通过回调完成。浮层使用和 Composer
 * 模型菜单相同的 Portal 定位；选项在 pointerdown 阶段提交，避免外部点击监听先把菜单卸载。
 *
 * 分支在首页不展示，进入对话后展示在聊天顶栏（Workspace.biny-chat-title）。
 */
import { useClosingPresence } from "../../useClosingPresence.js";
import type { DesktopProject } from "../../../../protocol.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ComposerPopover } from "../composer/ComposerPopover.js";
import { Icon } from "../Icon.js";

interface WorkspaceContextBarProps {
  project: DesktopProject;
  projects: DesktopProject[];
  onCreateProject(): void;
  onSelectProject(projectId: string): void;
}

export function WorkspaceContextBar({
  project,
  projects,
  onCreateProject,
  onSelectProject
}: WorkspaceContextBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const projectAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".biny-workspace-context-menu") || projectAnchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="biny-workspace-context-bar">
      <div className="biny-workspace-context-selectors">
        <div className="biny-workspace-context-anchor" ref={projectAnchorRef}>
          <button
            aria-expanded={open}
            aria-haspopup="menu"
            className="biny-workspace-context-trigger"
            onClick={() => setOpen((v) => !v)}
            title="选择项目"
            type="button"
          >
            <Icon name="folder" size={14} />
            <span>{project.name}</span>
            <Icon name="chevron" size={11} />
          </button>
          <ProjectMenu
            anchorRef={projectAnchorRef}
            currentProjectId={project.id}
            missing={project.missing}
            onCreate={onCreateProject}
            onClose={() => setOpen(false)}
            onSelect={onSelectProject}
            open={open}
            projects={projects}
          />
        </div>
      </div>
    </div>
  );
}

function ProjectMenu({
  anchorRef,
  currentProjectId,
  missing,
  onCreate,
  onClose,
  onSelect,
  open,
  projects
}: {
  anchorRef: RefObject<HTMLElement | null>;
  currentProjectId: string;
  missing?: boolean;
  onCreate(): void;
  onClose(): void;
  onSelect(projectId: string): void;
  open: boolean;
  projects: DesktopProject[];
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((candidate) => `${candidate.name} ${candidate.path}`.toLocaleLowerCase().includes(normalized));
  }, [projects, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  if (!presence.present) return null;
  return (
    <ComposerPopover
      anchorRef={anchorRef}
      className={`composer-popover biny-composer-popover biny-workspace-context-menu${presenceClass(presence.phase)}`}
      phase={presence.phase}
    >
      <div aria-label="选择项目" className="biny-workspace-context-menu-surface" role="menu">
        <label className="biny-workspace-context-search">
          <Icon name="search" size={13} />
          <input aria-label="搜索项目" onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" ref={searchRef} type="search" value={query} />
        </label>
        <div className="biny-workspace-context-options">
          {filteredProjects.map((candidate) => {
            const selected = candidate.id === currentProjectId;
            const choose = (event: React.SyntheticEvent): void => {
              event.preventDefault();
              event.stopPropagation();
              if (candidate.missing) return;
              onClose();
              onSelect(candidate.id);
            };
            return (
              <button
                aria-checked={selected}
                className={`biny-workspace-context-option${selected ? " is-selected" : ""}`}
                disabled={candidate.missing}
                key={candidate.id}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  choose(event);
                }}
                onPointerDown={choose}
                role="menuitemradio"
                type="button"
              >
                <span className="biny-workspace-context-option-leading"><Icon name="folder" size={14} /><span><strong>{candidate.name}</strong><small>{candidate.missing ? "路径不可用" : candidate.path}</small></span></span>
                <span className="biny-workspace-context-option-check">{selected ? <Icon name="check" size={14} /> : null}</span>
              </button>
            );
          })}
          {!filteredProjects.length ? <div className="biny-workspace-context-menu-empty">没有匹配的项目</div> : null}
        </div>
        <div className="biny-workspace-context-menu-separator" />
        <button
          className="biny-workspace-context-menu-action"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            onCreate();
          }}
          role="menuitem"
          type="button"
        >
          <Icon name="add" size={14} />
          <span>新建项目…</span>
        </button>
      </div>
    </ComposerPopover>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return " is-open";
  if (phase === "closing") return " is-closing";
  return "";
}
