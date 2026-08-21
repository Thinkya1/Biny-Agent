/**
 * Composer 浮层的统一锚点定位层。
 *
 * 旧菜单依赖 `bottom/left/right` 的绝对定位，窗口缩放或侧栏变化后容易脱离触发按钮。
 * 这里把菜单放到 document.body，并根据触发器和浮层实际尺寸计算 fixed 坐标；滚动、缩放
 * 和内容尺寸变化都会重新定位，且会把坐标限制在窗口边界内。
 */
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEventHandler, ReactNode, RefObject } from "react";
import type { PresencePhase } from "../../useClosingPresence.js";

interface ComposerPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  align?: "start" | "end";
  children: ReactNode;
  className: string;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  phase: PresencePhase;
}

interface PopoverPosition {
  left: number;
  origin: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  top: number;
}

export function ComposerPopover({
  anchorRef,
  align = "start",
  children,
  className,
  onPointerEnter,
  onPointerLeave,
  phase
}: ComposerPopoverProps): React.JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition>();
  // 设置中心用原生 <dialog>.showModal() 打开，dialog 会进入浏览器顶层（top layer），
  // 挂在 document.body 下的 fixed 元素会被它盖住，即使 z-index 更高也显示不出来。
  // 因此菜单要挂进最近的 <dialog> 内部；普通场景（composer）没有 dialog 祖先，仍挂 body。
  // 挂载后再解析目标，避免在渲染期间读取 ref。
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setPortalTarget(anchorRef.current?.closest("dialog") ?? document.body);
  }, [anchorRef]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;

    let frame: number | undefined;
    const measurePosition = (): void => {
      const anchorRect = anchor.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const gap = 8;
      const viewportPadding = 8;
      // getBoundingClientRect 会把 opening/closing 的 scale 也算进去，导致菜单坐标
      // 随动画阶段跳动；offset 尺寸代表未变换的布局盒，适合作为定位依据。
      const width = surface.offsetWidth || surfaceRect.width;
      const height = surface.offsetHeight || surfaceRect.height;
      const roomAbove = anchorRect.top - gap;
      const roomBelow = window.innerHeight - anchorRect.bottom - gap;
      const placeAbove = roomAbove >= height || roomAbove >= roomBelow;
      const preferredLeft = align === "end" ? anchorRect.right - width : anchorRect.left;
      const left = clamp(preferredLeft, viewportPadding, Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
      const preferredTop = placeAbove ? anchorRect.top - height - gap : anchorRect.bottom + gap;
      const top = clamp(preferredTop, viewportPadding, Math.max(viewportPadding, window.innerHeight - height - viewportPadding));
      const origin = `${placeAbove ? "bottom" : "top"}-${align === "end" ? "right" : "left"}` as PopoverPosition["origin"];
      setPosition((current) => current?.left === left && current.top === top && current.origin === origin
        ? current
        : { left, origin, top });
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
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(surface);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
    // portal 目标解析后 surface 会换一个 DOM 节点（重新挂载进 <dialog>），必须重新测量，
    // 否则后续滚动/缩放重算时拿到的还是已脱离文档的旧节点。
  }, [align, anchorRef, portalTarget]);

  if (typeof document === "undefined") return null;

  const style: CSSProperties = {
    bottom: "auto",
    left: position?.left ?? -10000,
    maxHeight: "calc(100vh - 16px)",
    maxWidth: "calc(100vw - 16px)",
    position: "fixed",
    right: "auto",
    top: position?.top ?? -10000,
    visibility: position ? "visible" : "hidden",
    zIndex: 160
  };

  // 设置中心的菜单挂进 <dialog> 内部（顶层渲染顺序）；composer 场景仍在首帧后挂回 body，
  // 效果与之前一致，只是 portal 目标从 document.body 改成解析结果。
  return createPortal(
    <div
      className={className}
      data-origin={position?.origin ?? (align === "end" ? "bottom-right" : "bottom-left")}
      data-popover-phase={phase}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      ref={surfaceRef}
      style={style}
    >
      {children}
    </div>,
    portalTarget ?? document.body
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
