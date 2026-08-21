/**
 * Composer 的模型与推理强度选择器。
 *
 * 一级菜单只包含两个稳定的入口；二级菜单通过 portal 独立定位，避免模型列表长度或推理
 * 档位数量改变时撑大一级菜单，进而让锚点发生位移。二级菜单的碰撞处理也只作用于自己。
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import type { ThinkingSelection } from "../../../../../llm/modelThinking.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";

type PickerSection = "model" | "thinking";

interface ModelGroup {
  iconTone: string;
  key: string;
  label: string;
  models: ModelChoice[];
}

interface SubmenuPosition {
  left: number;
  top: number;
}

interface ParentPosition extends SubmenuPosition {
  origin: "bottom-left" | "bottom-right" | "top-left" | "top-right";
}

const VIEWPORT_PADDING = 8;
const SUBMENU_GAP = 6;
const SUBMENU_MAX_HEIGHT = 460;

export function ModelPickerMenu({
  anchorRef,
  currentAlias,
  currentModelName,
  currentThinking,
  models,
  onClose,
  onSelectModel,
  onSelectThinking,
  open,
  thinkingLevels
}: {
  anchorRef: RefObject<HTMLElement | null>;
  currentAlias?: string;
  currentModelName: string;
  currentThinking?: ThinkingSelection;
  models: ModelChoice[];
  onClose(): void;
  onSelectModel(alias: string): void;
  onSelectThinking(thinking: ThinkingSelection): void;
  open: boolean;
  thinkingLevels: ThinkingSelection[];
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [activeSection, setActiveSection] = useState<PickerSection>("model");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [parentPosition, setParentPosition] = useState<ParentPosition>();
  const [submenuPosition, setSubmenuPosition] = useState<SubmenuPosition>();
  const primaryRef = useRef<HTMLDivElement>(null);
  const parentSurfaceRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupModels(models), [models]);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    setPortalTarget(anchorRef.current?.closest("dialog") ?? document.body);
  }, [anchorRef]);

  useEffect(() => {
    if (open) {
      setActiveSection("model");
      return;
    }
    setParentPosition(undefined);
    setSubmenuPosition(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || primaryRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [anchorRef, onClose, open]);

  useLayoutEffect(() => {
    if (!presence.present) {
      setParentPosition(undefined);
      return;
    }

    let frame: number | undefined;
    const measurePosition = (): void => {
      const anchor = anchorRef.current;
      const surface = parentSurfaceRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const surfaceRect = surface?.getBoundingClientRect();
      const gap = 8;
      // 首帧菜单还没有完成布局时使用 CSS 的稳定尺寸，避免因为 width/height 为 0
      // 把菜单永久留在 -10000px；这也是模型目录较长时父面板偶发消失的根因。
      const width = surface?.offsetWidth || surfaceRect?.width || 288;
      const height = surface?.offsetHeight || surfaceRect?.height || 96;
      const roomAbove = anchorRect.top - gap;
      const roomBelow = window.innerHeight - anchorRect.bottom - gap;
      const placeAbove = roomAbove >= height || roomAbove >= roomBelow;
      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
      const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
      const preferredLeft = anchorRect.right - width;
      const preferredTop = placeAbove ? anchorRect.top - height - gap : anchorRect.bottom + gap;
      const next: ParentPosition = {
        left: clamp(preferredLeft, VIEWPORT_PADDING, maxLeft),
        origin: `${placeAbove ? "bottom" : "top"}-left`,
        top: clamp(preferredTop, VIEWPORT_PADDING, maxTop)
      };
      setParentPosition((current) => current?.left === next.left && current.origin === next.origin && current.top === next.top ? current : next);
    };
    const updatePosition = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measurePosition();
      });
    };

    measurePosition();
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    const observedAnchor = anchorRef.current;
    const observedSurface = parentSurfaceRef.current;
    if (observedAnchor) resizeObserver?.observe(observedAnchor);
    if (observedSurface) resizeObserver?.observe(observedSurface);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, portalTarget, presence.present, thinkingLevels.length]);

  useLayoutEffect(() => {
    if (!presence.present || !activeSection) {
      setSubmenuPosition(undefined);
      return;
    }

    let frame: number | undefined;
    const measurePosition = (): void => {
      const primary = primaryRef.current;
      const submenu = submenuRef.current;
      if (!primary || !submenu) return;
      const parentRect = primary.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const width = submenu.offsetWidth || submenuRect.width;
      // Portal 根节点在 fixed + max-height 的首帧可能报告内容总高度，而真正可见区域
      // 已由 CSS 限制为 460px；定位必须使用可见高度，否则 maxTop 会退化成 8px。
      const measuredHeight = submenu.offsetHeight || submenuRect.height || SUBMENU_MAX_HEIGHT;
      const height = Math.min(measuredHeight, SUBMENU_MAX_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2);
      if (!width || !height) return;

      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
      const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
      const rightLeft = parentRect.right + SUBMENU_GAP;
      const leftLeft = parentRect.left - SUBMENU_GAP - width;
      const preferredLeft = rightLeft <= maxLeft || leftLeft < VIEWPORT_PADDING ? rightLeft : leftLeft;
      const roomAbove = parentRect.top - SUBMENU_GAP;
      const roomBelow = window.innerHeight - parentRect.bottom - SUBMENU_GAP;
      const placeAbove = roomAbove >= height || roomAbove >= roomBelow;
      // 子菜单优先贴在父面板上方/下方，而不是垂直居中。长列表放不下时只夹到视口
      // 边界并在自身内部滚动，避免出现截图中“父面板在底部、列表跑到顶部”的断裂。
      const preferredTop = placeAbove
        ? parentRect.top - height - SUBMENU_GAP
        : parentRect.bottom + SUBMENU_GAP;
      setSubmenuPosition((current) => {
        const next = {
          left: clamp(preferredLeft, VIEWPORT_PADDING, maxLeft),
          top: clamp(preferredTop, VIEWPORT_PADDING, maxTop)
        };
        return current?.left === next.left && current.top === next.top ? current : next;
      });
    };
    const updatePosition = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measurePosition();
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    const observedPrimary = primaryRef.current;
    const observedSubmenu = submenuRef.current;
    if (observedPrimary) resizeObserver?.observe(observedPrimary);
    if (observedSubmenu) resizeObserver?.observe(observedSubmenu);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [activeSection, groups, models, parentPosition, portalTarget, presence.present, thinkingLevels]);

  if (typeof document === "undefined" || !presence.present) return null;

  const parentStyle: CSSProperties = {
    bottom: "auto",
    left: parentPosition?.left ?? -10000,
    maxHeight: "calc(100vh - 16px)",
    maxWidth: "calc(100vw - 16px)",
    position: "fixed",
    right: "auto",
    top: parentPosition?.top ?? -10000,
    visibility: parentPosition ? "visible" : "hidden",
    zIndex: 160
  };
  const submenuStyle: CSSProperties = {
    left: submenuPosition?.left ?? -10000,
    position: "fixed",
    top: submenuPosition?.top ?? -10000,
    visibility: submenuPosition ? "visible" : "hidden",
    zIndex: 161
  };

  return (
    <>
      {createPortal(
        <div
          className={`composer-popover cindy-composer-popover model-picker-popover ${presenceClass(presence.phase)}`}
          data-origin={parentPosition?.origin ?? "bottom-left"}
          data-popover-phase={presence.phase}
        ref={parentSurfaceRef}
          style={parentStyle}
        >
          <div aria-label="模型与推理强度" className="model-picker-primary" ref={primaryRef} role="menu">
            <button
              aria-expanded={activeSection === "model"}
              aria-haspopup="menu"
              className={`model-picker-entry${activeSection === "model" ? " is-active" : ""}`}
              onFocus={() => setActiveSection("model")}
              onClick={() => setActiveSection("model")}
              type="button"
            >
              <span className="model-picker-entry-label">模型</span>
              <span className="model-picker-entry-value">{currentModelName}</span>
              <Icon name="chevron" size={12} />
            </button>
            {thinkingLevels.length ? (
              <button
                aria-expanded={activeSection === "thinking"}
                aria-haspopup="menu"
                className={`model-picker-entry${activeSection === "thinking" ? " is-active" : ""}`}
                onFocus={() => setActiveSection("thinking")}
                onClick={() => setActiveSection("thinking")}
                type="button"
              >
                <span className="model-picker-entry-label">推理强度</span>
                <span className="model-picker-entry-value">{currentThinking ?? "默认"}</span>
                <Icon name="chevron" size={12} />
              </button>
            ) : null}
          </div>
        </div>,
        portalTarget ?? document.body
      )}
      {createPortal(
        <div
          aria-label={activeSection === "model" ? "选择模型" : "选择推理强度"}
          className={`composer-popover model-picker-submenu-portal ${presenceClass(presence.phase)}`}
          data-composer-menu="model"
          data-popover-phase={presence.phase}
          ref={submenuRef}
          role="menu"
          style={submenuStyle}
        >
          {activeSection === "model" ? (
            <ModelSubmenu currentAlias={currentAlias} groups={groups} onSelect={onSelectModel} />
          ) : (
            <ThinkingSubmenu current={currentThinking} levels={thinkingLevels} onSelect={onSelectThinking} />
          )}
        </div>,
        portalTarget ?? document.body
      )}
    </>
  );
}

function ModelSubmenu({ currentAlias, groups, onSelect }: { currentAlias?: string; groups: ModelGroup[]; onSelect(alias: string): void }): React.JSX.Element {
  return (
    <div className="model-picker-submenu">
      <div className="model-picker-submenu-heading">模型</div>
      {groups.length ? groups.map((group) => (
        <div className="model-picker-submenu-group" key={group.key}>
          <div className="model-picker-group-heading">{group.label}</div>
          {group.models.map((model) => {
            const selected = model.alias === currentAlias;
            return (
              <button
                aria-checked={selected}
                className={`model-picker-submenu-option${selected ? " is-selected" : ""}`}
                key={model.alias}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(model.alias);
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(model.alias);
                }}
                role="menuitemradio"
                type="button"
              >
                <span className="model-picker-option-copy">
                  <span className="model-picker-option-brand"><ProviderBrandGlyph type={group.iconTone} /></span>
                  <span className="model-picker-option-label">
                    <strong>{model.displayName}</strong>
                    {modelMetadataLabel(model) ? <small>{modelMetadataLabel(model)}</small> : null}
                  </span>
                </span>
                {selected ? <Icon name="check" size={14} /> : null}
              </button>
            );
          })}
        </div>
      )) : <div className="model-picker-submenu-empty">没有可用模型</div>}
    </div>
  );
}

function ThinkingSubmenu({ current, levels, onSelect }: { current?: ThinkingSelection; levels: ThinkingSelection[]; onSelect(thinking: ThinkingSelection): void }): React.JSX.Element {
  return (
    <div className="model-picker-submenu">
      <div className="model-picker-submenu-heading">推理强度</div>
      <div className="model-effort-options">
        {levels.map((level) => (
          <button
            aria-checked={level === current}
            className={level === current ? "is-selected" : undefined}
            key={level}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onSelect(level);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect(level);
            }}
            role="menuitemradio"
            type="button"
          >
            <span>{level}</span>
            {level === current ? <Icon name="check" size={14} /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function groupModels(models: ModelChoice[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const catalog = catalogForConnection(
      { provider: model.provider, providerType: model.providerType },
      model.baseUrl
    );
    const key = `${model.providerType}:${model.provider}:${model.baseUrl ?? ""}`;
    const group = groups.get(key) ?? {
      iconTone: catalog?.iconTone ?? model.providerType,
      key,
      label: catalog?.label ?? providerLabel(model.provider),
      models: []
    };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Google Gemini",
    kimi: "Kimi",
    moonshot: "Moonshot",
    ollama: "Ollama",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    "opencode-ai": "OpenCode",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function modelMetadataLabel(model: ModelChoice): string | undefined {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(formatContextWindow(model.contextWindow));
  if (model.efforts.length) parts.push(model.efforts.join("/"));
  return parts.length ? parts.join(" · ") : undefined;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/u, "")}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
