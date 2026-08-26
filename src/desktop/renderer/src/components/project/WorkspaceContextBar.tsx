/**
 * Composer 上方的项目与 Git 分支上下文栏。
 *
 * 菜单只表达选择意图，项目切换和 Git 操作由 App 通过回调完成。浮层使用和 Composer
 * 模型菜单相同的 Portal 定位；选项在 pointerdown 阶段提交，避免外部点击监听先把菜单卸载。
 */
import { useClosingPresence } from "../../useClosingPresence.js";
import type { DesktopGitBranch, DesktopProject } from "../../../../protocol.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ComposerPopover } from "../composer/ComposerPopover.js";
import { Icon } from "../Icon.js";

type ContextMenu = "project" | "branch" | null;

interface WorkspaceContextBarProps {
  project: DesktopProject;
  projects: DesktopProject[];
  branches: DesktopGitBranch[];
  branchesLoading: boolean;
  onCreateProject(): void;
  onCreateBranch(branchName: string): Promise<void>;
  onOpenBranches(): void;
  onSelectBranch(branchName: string): void;
  onSelectProject(projectId: string): void;
}

export function WorkspaceContextBar({
  project,
  projects,
  branches,
  branchesLoading,
  onCreateProject,
  onCreateBranch,
  onOpenBranches,
  onSelectBranch,
  onSelectProject
}: WorkspaceContextBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<ContextMenu>(null);
  const projectAnchorRef = useRef<HTMLDivElement>(null);
  const branchAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".biny-workspace-context-menu") || projectAnchorRef.current?.contains(target) || branchAnchorRef.current?.contains(target)) return;
      setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setOpenMenu(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const toggleProjectMenu = (): void => setOpenMenu((current) => current === "project" ? null : "project");
  const toggleBranchMenu = (): void => {
    setOpenMenu((current) => current === "branch" ? null : "branch");
    onOpenBranches();
  };

  return (
    <div className="biny-workspace-context-bar">
      <span className="biny-workspace-context-label">工作区</span>
      <div className="biny-workspace-context-selectors">
        <div className="biny-workspace-context-anchor" ref={projectAnchorRef}>
          <button
            aria-expanded={openMenu === "project"}
            aria-haspopup="menu"
            className="biny-workspace-context-trigger"
            onClick={toggleProjectMenu}
            type="button"
          >
            <Icon name="folder" size={14} />
            <span>{project.name}</span>
            <Icon name="chevron" size={11} />
          </button>
          <ProjectMenu
            anchorRef={projectAnchorRef}
            currentProjectId={project.id}
            onCreate={onCreateProject}
            onClose={() => setOpenMenu(null)}
            onSelect={onSelectProject}
            open={openMenu === "project"}
            projects={projects}
          />
        </div>
        <span aria-hidden="true" className="biny-workspace-context-divider">/</span>
        <div className="biny-workspace-context-anchor" ref={branchAnchorRef}>
          <button
            aria-expanded={openMenu === "branch"}
            aria-haspopup="menu"
            className="biny-workspace-context-trigger biny-workspace-branch-trigger"
            disabled={project.missing}
            onClick={toggleBranchMenu}
            type="button"
          >
            <Icon name="branch" size={14} />
            <span>{project.branch ?? "未检出分支"}</span>
            {project.dirty ? <span aria-label="有未提交更改" className="biny-workspace-context-dirty" title="有未提交更改" /> : null}
            <Icon name="chevron" size={11} />
          </button>
          <BranchMenu
            anchorRef={branchAnchorRef}
            branches={branches}
            branchesLoading={branchesLoading}
            currentBranch={project.branch}
            onClose={() => setOpenMenu(null)}
            onCreate={onCreateBranch}
            onSelect={onSelectBranch}
            open={openMenu === "branch"}
          />
        </div>
      </div>
    </div>
  );
}

function ProjectMenu({
  anchorRef,
  currentProjectId,
  onCreate,
  onClose,
  onSelect,
  open,
  projects
}: {
  anchorRef: RefObject<HTMLElement | null>;
  currentProjectId: string;
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

function BranchMenu({
  anchorRef,
  branches,
  branchesLoading,
  currentBranch,
  onClose,
  onCreate,
  onSelect,
  open
}: {
  anchorRef: RefObject<HTMLElement | null>;
  branches: DesktopGitBranch[];
  branchesLoading: boolean;
  currentBranch?: string;
  onClose(): void;
  onCreate(branchName: string): Promise<void>;
  onSelect(branchName: string): void;
  open: boolean;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const filteredBranches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return branches;
    return branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalized));
  }, [branches, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCreating(false);
      setNewBranch("");
      setSubmitting(false);
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (creating) window.requestAnimationFrame(() => createRef.current?.focus());
  }, [creating]);

  const submitCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    const name = newBranch.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(name);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  if (!presence.present) return null;
  return (
    <ComposerPopover
      anchorRef={anchorRef}
      className={`composer-popover biny-composer-popover biny-workspace-context-menu${presenceClass(presence.phase)}`}
      phase={presence.phase}
    >
      <div aria-label="选择 Git 分支" className="biny-workspace-context-menu-surface" role="menu">
        <label className="biny-workspace-context-search">
          <Icon name="search" size={13} />
          <input aria-label="搜索分支" onChange={(event) => setQuery(event.target.value)} placeholder="搜索本地分支…" ref={searchRef} type="search" value={query} />
        </label>
        <div className="biny-workspace-context-options">
          {branchesLoading ? <div className="biny-workspace-context-menu-empty">正在读取本地分支…</div> : null}
          {!branchesLoading ? filteredBranches.map((branch) => {
            const selected = branch.name === currentBranch;
            const choose = (event: React.SyntheticEvent): void => {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              onSelect(branch.name);
            };
            return (
              <button
                aria-checked={selected}
                className={`biny-workspace-context-option${selected ? " is-selected" : ""}`}
                key={branch.name}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  choose(event);
                }}
                onPointerDown={choose}
                role="menuitemradio"
                type="button"
              >
                <span className="biny-workspace-context-option-leading"><Icon name="branch" size={14} /><span><strong>{branch.name}</strong><small>本地分支</small></span></span>
                <span className="biny-workspace-context-option-check">{selected ? <Icon name="check" size={14} /> : null}</span>
              </button>
            );
          }) : null}
          {!branchesLoading && !filteredBranches.length ? <div className="biny-workspace-context-menu-empty">没有匹配的本地分支</div> : null}
        </div>
        <div className="biny-workspace-context-menu-separator" />
        {creating ? (
          <form className="biny-workspace-context-create" onSubmit={(event) => void submitCreate(event)}>
            <label htmlFor="workspace-new-branch">新分支名称</label>
            <input id="workspace-new-branch" onChange={(event) => setNewBranch(event.target.value)} placeholder="feature/short-name" ref={createRef} value={newBranch} />
            <div>
              <button onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setCreating(false); }} type="button">取消</button>
              <button disabled={!newBranch.trim() || submitting} onPointerDown={(event) => { event.stopPropagation(); }} type="submit">{submitting ? "创建中…" : "创建并检出"}</button>
            </div>
          </form>
        ) : (
          <button
            className="biny-workspace-context-menu-action"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setCreating(true);
            }}
            role="menuitem"
            type="button"
          >
            <Icon name="add" size={14} />
            <span>创建并检出新分支…</span>
          </button>
        )}
      </div>
    </ComposerPopover>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return " is-open";
  if (phase === "closing") return " is-closing";
  return "";
}
