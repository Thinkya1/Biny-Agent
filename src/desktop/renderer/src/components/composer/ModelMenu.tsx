/**
 * Composer 模型选择菜单。
 *
 * 菜单只负责从可用模型里选择一项，不展示 Provider、上下文、价格或思考深度。
 * 设置中心的记忆模型选择复用这个菜单。
 */
import { useEffect, useRef } from "react";
import type { PointerEventHandler, RefObject } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { ComposerPopover } from "./ComposerPopover.js";

export function ModelMenu({
  anchorRef,
  models,
  currentAlias,
  open,
  onChange,
  onClose,
  onPointerEnter,
  onPointerLeave,
  unsetLabel
}: {
  anchorRef: RefObject<HTMLElement | null>;
  models: ModelChoice[];
  currentAlias?: string;
  open: boolean;
  onChange(alias: string): void;
  onClose?(): void;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  unsetLabel?: string;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !onClose) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      // 菜单挂在设置中心的原生 <dialog> 内部时，dialog 自己的 keydown 监听会在冒泡阶段
      // 处理 Escape 并关闭整个设置中心。这里在捕获阶段消费掉事件，保证一次 Escape 只关菜单。
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

  if (!presence.present) return null;

  return (
    <ComposerPopover
      anchorRef={anchorRef}
      className={`t-dropdown composer-popover cindy-composer-popover model-menu ${presenceClass(presence.phase)}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      phase={presence.phase}
    >
      <div aria-label="选择模型" className="model-menu-main" ref={menuRef} role="menu">
        {unsetLabel ? (
          <button
            aria-checked={currentAlias === undefined}
            className={`menu-option model-option${currentAlias === undefined ? " is-selected" : ""}`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onChange("");
            }}
            role="menuitemradio"
            type="button"
          >
            <span className="model-option-copy"><strong>{unsetLabel}</strong></span>
          </button>
        ) : null}
        {models.map((model) => {
          const selected = model.alias === currentAlias;
          return (
            <button
              aria-checked={selected}
              className={`menu-option model-option${selected ? " is-selected" : ""}`}
              key={model.alias}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(model.alias);
              }}
              role="menuitemradio"
              type="button"
            >
              <span className="model-option-copy"><strong>{model.displayName}</strong></span>
            </button>
          );
        })}
        {!models.length && !unsetLabel ? <div className="menu-empty">没有可用模型</div> : null}
      </div>
    </ComposerPopover>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
