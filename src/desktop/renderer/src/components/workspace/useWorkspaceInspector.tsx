/* eslint-disable react-refresh/only-export-components -- Inspector 请求状态与私有视图必须共享同一生命周期。 */
/**
 * Workspace 右侧检查器的状态与视图。
 *
 * 文件树、文件预览、终端切换和面板尺寸都属于 Inspector 自己的交互状态；会话区只拿到
 * 一个 dock 节点与 `previewFile` 命令，不再理解目录请求或终端布局。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import type {
  DesktopWorkspaceDirectory,
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceFilePreview,
  DesktopSlashResult
} from "../../../../protocol.js";
import {
  clampFilePanelWidth,
  MAX_FILE_PANEL_WIDTH,
  MIN_FILE_PANEL_WIDTH
} from "../../../../filePanelSizing.js";
import { highlightWorkspaceFile } from "../../syntaxHighlight.js";
import { workspaceFileMarker } from "../../workspaceFileMarker.js";
import { CopyButton } from "../CopyButton.js";
import { Icon } from "../Icon.js";
import { TerminalView } from "../TerminalView.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import {
  InspectorReview,
  InspectorSideChat,
  InspectorToolLauncher,
  type InspectorCommandState,
  type InspectorToolAction
} from "./InspectorToolLauncher.js";

interface UseWorkspaceInspectorOptions {
  filePanelResizing: boolean;
  filePanelWidth: number;
  projectId?: string;
  source: string;
  onFilePanelResizeEnd(width: number): void;
  onFilePanelResizeStart(): void;
  onFilePanelWidthChange(width: number): void;
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onOpenFile(path: string): void;
  onOpenBrowser(): Promise<void>;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
  onRunCommand(command: string): Promise<DesktopSlashResult>;
}

interface FilePreviewState {
  source: string;
  path: string;
  status: "loading" | "ready" | "error";
  file?: DesktopWorkspaceFilePreview;
  error?: string;
}

interface FileDirectoryState {
  status: "loading" | "ready" | "error";
  entries?: DesktopWorkspaceDirectoryEntry[];
  error?: string;
}

type InspectorView = "launcher" | "files" | "terminal" | "review" | "side-chat";

const inspectorToolMetadata: Record<Exclude<InspectorView, "launcher">, { icon: "folder" | "message" | "shield" | "terminal"; label: string }> = {
  files: { icon: "folder", label: "文件" },
  terminal: { icon: "terminal", label: "终端" },
  review: { icon: "shield", label: "审阅" },
  "side-chat": { icon: "message", label: "侧边聊天" }
};

export function useWorkspaceInspector({
  filePanelResizing,
  filePanelWidth,
  projectId,
  source,
  onFilePanelResizeEnd,
  onFilePanelResizeStart,
  onFilePanelWidthChange,
  onListDirectory,
  onOpenFile,
  onOpenBrowser,
  onRunCommand,
  onReadFile
}: UseWorkspaceInspectorOptions): {
  dock?: React.JSX.Element;
  layout: {
    open: boolean;
    resizing: boolean;
    width: number;
  };
  open: boolean;
  filesOpen: boolean;
  terminalOpen: boolean;
  openFiles(): void;
  previewFile(path: string): void;
  toggleInspector(): void;
  toggleTerminal(): void;
} {
  const previewRequestRef = useRef(0);
  const directoryRequestIdRef = useRef(0);
  const directoryRequestRef = useRef(new Map<string, number>());
  const reviewRequestRef = useRef(0);
  const reviewRunningRef = useRef(false);
  const sideChatRequestRef = useRef(0);
  const sideChatRunningRef = useRef(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("launcher");
  const [preview, setPreview] = useState<FilePreviewState>();
  const [directoryStates, setDirectoryStates] = useState<Map<string, FileDirectoryState>>(new Map());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [reviewState, setReviewState] = useState<InspectorCommandState>({ status: "idle" });
  const [sideChatState, setSideChatState] = useState<InspectorCommandState>({ status: "idle" });
  const [launcherError, setLauncherError] = useState<string>();
  // 和左侧侧栏共用 250ms 的几何过渡，关闭时要等宽度动画结束后再卸载。
  const inspectorPresence = useClosingPresence(inspectorOpen && Boolean(projectId), 250);
  const activePreview = preview?.source === source ? preview : undefined;

  useLayoutEffect(() => {
    previewRequestRef.current += 1;
    directoryRequestIdRef.current += 1;
    directoryRequestRef.current.clear();
    setPreview(undefined);
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
    reviewRequestRef.current += 1;
    reviewRunningRef.current = false;
    sideChatRequestRef.current += 1;
    sideChatRunningRef.current = false;
    setReviewState({ status: "idle" });
    setSideChatState({ status: "idle" });
    setLauncherError(undefined);
  }, [source]);

  const loadDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const requestId = directoryRequestIdRef.current + 1;
    directoryRequestIdRef.current = requestId;
    directoryRequestRef.current.set(normalizedPath, requestId);
    setDirectoryStates((current) => {
      const next = new Map(current);
      next.set(normalizedPath, { status: "loading" });
      return next;
    });
    void onListDirectory(normalizedPath).then((directory) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizeWorkspacePath(directory.path), { status: "ready", entries: directory.entries });
        return next;
      });
    }).catch((error: unknown) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizedPath, { status: "error", error: errorMessage(error) });
        return next;
      });
    });
  }, [onListDirectory]);

  const openInspector = useCallback((view: InspectorView): void => {
    if (!projectId) return;
    setInspectorView(view);
    setInspectorOpen(true);
    if (view === "files" && !directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, projectId]);

  const toggleInspector = useCallback((): void => {
    if (inspectorOpen) {
      setInspectorOpen(false);
      return;
    }
    openInspector("launcher");
  }, [inspectorOpen, openInspector]);

  const openFiles = useCallback((): void => {
    openInspector("files");
  }, [openInspector]);

  const toggleTerminal = useCallback((): void => {
    if (inspectorOpen && inspectorView === "terminal") {
      setInspectorOpen(false);
      return;
    }
    openInspector("terminal");
  }, [inspectorOpen, inspectorView, openInspector]);

  const previewFile = useCallback((path: string): void => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setInspectorView("files");
    setInspectorOpen(true);
    setPreview({ source, path, status: "loading", file: undefined, error: undefined });
    void onReadFile(path).then((file) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path: file.path, status: "ready", file, error: undefined });
    }).catch((error: unknown) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path, status: "error", file: undefined, error: errorMessage(error) });
    });
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, onReadFile, source]);

  const showFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory]);

  const toggleDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const willExpand = !expandedDirectories.has(normalizedPath);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (willExpand) next.add(normalizedPath);
      else next.delete(normalizedPath);
      return next;
    });
    const state = directoryStates.get(normalizedPath);
    if (willExpand && (!state || state.status === "error")) loadDirectory(normalizedPath);
  }, [directoryStates, expandedDirectories, loadDirectory]);

  const runReview = useCallback((): void => {
    if (reviewRunningRef.current) return;
    reviewRunningRef.current = true;
    const request = reviewRequestRef.current + 1;
    reviewRequestRef.current = request;
    setReviewState({ status: "loading" });
    void onRunCommand("/review").then((result) => {
      if (reviewRequestRef.current !== request) return;
      setReviewState({ status: "ready", result });
    }).catch((error: unknown) => {
      if (reviewRequestRef.current !== request) return;
      setReviewState({ status: "error", error: errorMessage(error) });
    }).finally(() => {
      if (reviewRequestRef.current === request) reviewRunningRef.current = false;
    });
  }, [onRunCommand]);

  const runSideChat = useCallback((input: string): void => {
    if (sideChatRunningRef.current) return;
    sideChatRunningRef.current = true;
    const request = sideChatRequestRef.current + 1;
    sideChatRequestRef.current = request;
    setSideChatState({ status: "loading" });
    // `--` 明确要求走前台问答，避免问题恰好以 status/start/cancel/agents 开头时触发控制命令。
    void onRunCommand(`/subagent -- ${input}`).then((result) => {
      if (sideChatRequestRef.current !== request) return;
      setSideChatState({ status: "ready", result });
    }).catch((error: unknown) => {
      if (sideChatRequestRef.current !== request) return;
      setSideChatState({ status: "error", error: errorMessage(error) });
    }).finally(() => {
      if (sideChatRequestRef.current === request) sideChatRunningRef.current = false;
    });
  }, [onRunCommand]);

  const openBrowser = useCallback((): void => {
    setLauncherError(undefined);
    void onOpenBrowser().catch((error: unknown) => setLauncherError(errorMessage(error)));
  }, [onOpenBrowser]);

  const openLauncherAction = useCallback((action: InspectorToolAction): void => {
    if (action === "browser") {
      openBrowser();
      return;
    }
    if (action === "review") {
      openInspector("review");
      runReview();
      return;
    }
    openInspector(action);
  }, [openBrowser, openInspector, runReview]);

  useEffect(() => {
    if (!inspectorOpen || !projectId) return;
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isTextEntryTarget(event.target) || !event.metaKey) return;
      if (event.shiftKey && !event.altKey && event.code === "KeyG") {
        event.preventDefault();
        openLauncherAction("review");
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyT") {
        event.preventDefault();
        openLauncherAction("browser");
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyP") {
        event.preventDefault();
        openLauncherAction("files");
        return;
      }
      if (!event.shiftKey && event.altKey && event.code === "KeyS") {
        event.preventDefault();
        openLauncherAction("side-chat");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [inspectorOpen, openLauncherAction, projectId]);

  const activeTool = inspectorView === "launcher" ? undefined : inspectorToolMetadata[inspectorView];
  const toolContent = !projectId ? null : inspectorView === "terminal" ? <TerminalView projectId={projectId} />
    : inspectorView === "files" ? (
      <FilePreviewPanel
        directoryStates={directoryStates}
        expandedDirectories={expandedDirectories}
        onOpenFile={onOpenFile}
        onPreviewFile={previewFile}
        onShowFiles={showFileBrowser}
        onToggleDirectory={toggleDirectory}
        preview={activePreview}
      />
    ) : inspectorView === "review" ? <InspectorReview onRetry={runReview} state={reviewState} />
      : inspectorView === "side-chat" ? <InspectorSideChat onSend={runSideChat} state={sideChatState} />
        : null;

  const inspector = inspectorPresence.present && projectId ? (
    <div
      className={`desktop-inspector-wrap is-${inspectorPresence.phase}${filePanelResizing ? " is-resizing" : ""}`}
    >
      <FilePanelResizer
        onResizeEnd={onFilePanelResizeEnd}
        onResizeStart={onFilePanelResizeStart}
        onWidthChange={onFilePanelWidthChange}
        width={filePanelWidth}
      />
      <aside aria-label="工作区检查器" className="desktop-inspector" role="complementary">
        <header className={`desktop-inspector-header${activeTool ? " is-tool" : ""}`}>
          {activeTool ? (
            <button aria-label="返回工作区工具" className="cindy-inspector-back" onClick={() => openInspector("launcher")} title="返回工作区工具" type="button">
              <Icon name="arrow-left" size={15} />
              <Icon name={activeTool.icon} size={14} />
              <span>{activeTool.label}</span>
            </button>
          ) : <span aria-hidden="true" className="cindy-inspector-header-spacer" />}
          <button aria-label="收起工作区工具" className="desktop-inspector-close" onClick={() => setInspectorOpen(false)} title="收起工作区工具" type="button">
            <Icon name="panel-right" size={15} />
          </button>
        </header>
        <div className="desktop-inspector-body" id="desktop-inspector-panel">
          <div className="t-page-slide cindy-inspector-pages" data-page={inspectorView === "launcher" ? "1" : "2"}>
            <section aria-hidden={inspectorView === "launcher" ? undefined : true} className="t-page cindy-inspector-launcher-page" data-page-id="1" inert={inspectorView === "launcher" ? undefined : true}>
              <InspectorToolLauncher error={launcherError} onAction={openLauncherAction} />
            </section>
            <section aria-hidden={inspectorView === "launcher" ? true : undefined} className="t-page cindy-inspector-tool-page" data-page-id="2" inert={inspectorView === "launcher" ? true : undefined}>
              <div className="cindy-inspector-view-content" key={inspectorView}>{toolContent}</div>
            </section>
          </div>
        </div>
      </aside>
    </div>
  ) : undefined;

  return {
    dock: inspector,
    layout: {
      open: inspectorOpen && Boolean(projectId),
      resizing: filePanelResizing,
      width: filePanelWidth
    },
    open: inspectorOpen && Boolean(projectId),
    filesOpen: inspectorOpen && inspectorView === "files",
    terminalOpen: inspectorOpen && inspectorView === "terminal",
    openFiles,
    previewFile,
    toggleInspector,
    toggleTerminal
  };
}

function FilePanelResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: {
  width: number;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(width: number): void;
}): React.JSX.Element {
  const resizeWithKeyboard = (direction: -1 | 1, resizer: HTMLDivElement): void => {
    const layoutRoot = resizer.closest<HTMLElement>(".cindy-app-shell");
    const currentWidth = resizer.parentElement?.getBoundingClientRect().width ?? width;
    const next = clampFilePanelWidthForLayout(currentWidth + direction * 16, layoutRoot);
    onWidthChange(next);
    onResizeEnd(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizeStart();
    const layoutRoot = event.currentTarget.closest<HTMLElement>(".cindy-app-shell");
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    let currentWidth = startWidth;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      currentWidth = clampFilePanelWidthForLayout(startWidth + startX - moveEvent.clientX, layoutRoot);
      onWidthChange(currentWidth);
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      onResizeEnd(currentWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      aria-label="调整检查器宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_FILE_PANEL_WIDTH}
      aria-valuemin={MIN_FILE_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      className="desktop-inspector-resizer"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(1, event.currentTarget); }
        if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(-1, event.currentTarget); }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    />
  );
}

function clampFilePanelWidthForLayout(width: number, layoutRoot: HTMLElement | null): number {
  const appWidth = layoutRoot?.clientWidth ?? document.documentElement.clientWidth;
  const sidebar = layoutRoot?.querySelector<HTMLElement>(":scope > .cindy-sidebar-block");
  const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0;
  return clampFilePanelWidth(width, appWidth, sidebarWidth);
}

function FilePreviewPanel({ preview, directoryStates, expandedDirectories, onOpenFile, onPreviewFile, onShowFiles, onToggleDirectory }: {
  preview?: FilePreviewState;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onOpenFile(path: string): void;
  onPreviewFile(path: string): void;
  onShowFiles(): void;
  onToggleDirectory(path: string): void;
}): React.JSX.Element {
  const file = preview?.file;
  const path = file?.path ?? preview?.path;
  const [query, setQuery] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const browserOnly = !preview;
  const treeVisible = browserOnly || fileTreeOpen;
  return (
    <aside aria-label={preview ? "文件预览" : "文件浏览器"} className="file-preview-panel file-browser-panel">
      <header className="file-browser-path">
        <span className="file-browser-current-path">{path ? `/${path}` : "/"}</span>
        <div className="file-browser-path-actions">
          {preview?.status === "ready" && path ? <IconButton icon={<Icon name="external" size={14} />} label="使用系统应用打开" onClick={() => onOpenFile(path)} size="sm" tooltip="使用系统应用打开" variant="ghost" /> : null}
          {preview ? <IconButton icon={<Icon name="close" size={14} />} label="关闭当前文件" onClick={onShowFiles} size="sm" tooltip="返回文件列表" variant="ghost" /> : null}
          {preview ? (
            <IconButton
              aria-pressed={fileTreeOpen}
              icon={<Icon name="folder-panel" size={15} />}
              label={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
              onClick={() => setFileTreeOpen((current) => !current)}
              size="sm"
              tooltip={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
              variant={fileTreeOpen ? "secondary" : "ghost"}
            />
          ) : null}
        </div>
      </header>
      <div className={`file-browser-body${treeVisible ? "" : " is-tree-hidden"}${browserOnly ? " is-browser-only" : ""}`}>
        {preview ? <div className="file-browser-content"><FilePreviewContent preview={preview} /></div> : null}
        <div aria-hidden={treeVisible ? undefined : true} className="file-browser-tree" inert={treeVisible ? undefined : true}>
          <TextInput hasClear isLabelHidden label="筛选文件" onChange={setQuery} placeholder="筛选文件…" size="sm" startIcon={<Icon name="search" size={13} />} value={query} width="100%" />
          <FileTree
            directoryStates={directoryStates}
            expandedDirectories={expandedDirectories}
            onPreviewFile={onPreviewFile}
            onToggleDirectory={onToggleDirectory}
            path="."
            query={query}
          />
        </div>
      </div>
    </aside>
  );
}

function FilePreviewContent({ preview }: { preview: FilePreviewState }): React.JSX.Element {
  const file = preview.file;
  if (preview.status === "loading") return <div className="file-preview-state"><span className="large-spinner" /><span>正在读取文件…</span></div>;
  if (preview.status === "error") return <div className="file-preview-state is-error"><Icon name="warning" size={18} /><span>{preview.error}</span></div>;
  if (file?.binary) return <div className="file-preview-state"><Icon name="file" size={18} /><span>这是二进制文件，请使用系统应用打开。</span></div>;
  if (!file) return <div className="file-preview-state"><span>无法读取文件</span></div>;
  if (!file.content) return <div className="file-preview-state"><span>空文件</span></div>;
  const highlighted = highlightWorkspaceFile(file.path, file.content);
  return (
    <>
      <div className="file-preview-meta">
        <span>{highlighted.language ?? "纯文本"}</span>
        <div className="file-preview-meta-actions">
          <span>{formatBytes(file.bytes)}{file.truncated ? " · 仅显示前 512 KB" : ""}</span>
          <CopyButton className="copy-button" label="复制文件内容" value={file.content} />
        </div>
      </div>
      <pre className="file-preview-code"><code className={highlighted.language ? `hljs language-${highlighted.language}` : "hljs"} dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </>
  );
}

function FileTree({ path, query, directoryStates, expandedDirectories, onToggleDirectory, onPreviewFile, depth = 0 }: {
  path: string;
  query: string;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onToggleDirectory(path: string): void;
  onPreviewFile(path: string): void;
  depth?: number;
}): React.JSX.Element {
  const state = directoryStates.get(path);
  if (!state || state.status === "loading") return <div className="file-tree-state"><span className="mini-spinner" /><span>正在读取目录…</span></div>;
  if (state.status === "error") return <div className="file-tree-state is-error"><Icon name="warning" size={14} /><span>{state.error}</span></div>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (state.entries ?? []).filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery));
  if (!entries.length) return <div className="file-tree-state">{normalizedQuery ? "没有匹配文件" : "目录为空"}</div>;
  return (
    <div className="file-tree-level">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expandedDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button className={`file-tree-row${isDirectory ? " is-directory" : ""}`} onClick={() => isDirectory ? onToggleDirectory(entry.path) : onPreviewFile(entry.path)} style={{ paddingLeft: `${8 + depth * 16}px` }} title={entry.path} type="button">
              {isDirectory ? <span className={`file-tree-disclosure${isExpanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span> : <span aria-hidden="true" className="file-tree-disclosure is-file-slot" />}
              {isDirectory ? <Icon className="file-tree-folder-icon" name="folder" size={14} /> : <FileTreeMarker name={entry.name} />}
              <span>{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? <FileTree directoryStates={directoryStates} depth={depth + 1} expandedDirectories={expandedDirectories} onPreviewFile={onPreviewFile} onToggleDirectory={onToggleDirectory} path={entry.path} query={query} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function FileTreeMarker({ name }: { name: string }): React.JSX.Element {
  const marker = workspaceFileMarker(name);
  return <span aria-hidden="true" className={`file-type-marker is-${marker.tone}${marker.label.length > 2 ? " is-wide" : ""}`}>{marker.label}</span>;
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}
