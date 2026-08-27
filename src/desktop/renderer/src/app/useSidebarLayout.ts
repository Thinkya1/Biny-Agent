/**
 * 桌面端侧栏状态控制器。
 *
 * Sidebar 只负责展示，宽度预览、rail 提交、收起/peek 定时器和原生 pointer
 * 生命周期都在这里协调。collapsed/peek 是临时表面状态，普通展开宽度和 rail
 * 偏好仍沿用现有持久化边界。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adjustSidebarWithKeyboard,
  commitSidebarResize,
  DEFAULT_SIDEBAR_LAYOUT,
  normalizeSidebarExpandedWidth,
  previewSidebarResize,
  resolveSidebarLayout,
  sidebarResizeStart,
  type SidebarBaseMode,
  type SidebarLayoutSnapshot,
  type SidebarPeekPhase,
  type SidebarResizePreview,
  type SidebarResizeStart
} from "../../../sidebarLayout.js";
import {
  SIDEBAR_PEEK_CLOSE_MS,
  SIDEBAR_PEEK_LEAVE_GRACE_MS,
  SIDEBAR_PEEK_OPEN_DELAY_MS,
  SIDEBAR_PEEK_PINNING_MS
} from "../../../sidebarSizing.js";

const SIDEBAR_RAIL_STORAGE_KEY = "biny.desktop.sidebar-rail";
const SIDEBAR_WIDTH_STORAGE_KEY = "biny.desktop.sidebar-width";
const PEEK_TRIGGER_WIDTH = 12;

export interface SidebarPeekHandlers {
  onPointerEnter: React.PointerEventHandler<HTMLElement>;
  onPointerLeave: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onPointerUp?: React.PointerEventHandler<HTMLElement>;
}

interface ActiveResize {
  target: HTMLDivElement;
  pointerId: number;
  start: SidebarResizeStart;
  preview: SidebarResizePreview;
  move(event: PointerEvent): void;
  stop(event: PointerEvent): void;
  cancel(event: PointerEvent): void;
}

interface UseSidebarLayoutOptions {
  persistWidth(width: number): void;
}

interface UseSidebarLayoutResult {
  layout: SidebarLayoutSnapshot;
  drawerHandlers: SidebarPeekHandlers;
  drawerRef: React.RefObject<HTMLElement | null>;
  triggerHandlers: SidebarPeekHandlers;
  hydrateExpandedWidth(width: number): void;
  toggle(): void;
  onResizeKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onResizePointerDown: React.PointerEventHandler<HTMLDivElement>;
}

function readRailPreference(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeRailPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_RAIL_STORAGE_KEY, String(enabled));
  } catch {
    // Renderer 本地存储不可用时仍保留本次会话的 rail 状态。
  }
}

/**
 * 展开宽度在主进程状态库里，bootstrap 异步返回前首帧只能用默认值。
 * 镜像一份到 localStorage，让首帧直接以上次的宽度渲染，避免启动后可见的跳变；
 * bootstrap hydration 仍会把主进程值写回来保持权威一致。
 */
function readWidthPreference(): number {
  try {
    if (typeof window === "undefined") return DEFAULT_SIDEBAR_LAYOUT.expandedWidth;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_SIDEBAR_LAYOUT.expandedWidth;
    return normalizeSidebarExpandedWidth(Number(raw));
  } catch {
    return DEFAULT_SIDEBAR_LAYOUT.expandedWidth;
  }
}

function writeWidthPreference(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Renderer 本地存储不可用时仍保留本次会话的宽度状态。
  }
}

export function useSidebarLayout({ persistWidth }: UseSidebarLayoutOptions): UseSidebarLayoutResult {
  const [baseMode, setBaseMode] = useState<SidebarBaseMode>(() => readRailPreference() ? "rail" : DEFAULT_SIDEBAR_LAYOUT.baseMode);
  const [expandedWidth, setExpandedWidth] = useState(() => readWidthPreference());
  const [peekPhase, setPeekPhase] = useState<SidebarPeekPhase>("idle");
  const [activeResize, setActiveResize] = useState<ActiveResize | undefined>(undefined);
  const baseModeRef = useRef(baseMode);
  const expandedWidthRef = useRef(expandedWidth);
  const peekPhaseRef = useRef<SidebarPeekPhase>("idle");
  const activeResizeRef = useRef<ActiveResize | undefined>(undefined);
  const drawerRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverLockedRef = useRef(false);

  const setBaseModeValue = useCallback((next: SidebarBaseMode): void => {
    baseModeRef.current = next;
    setBaseMode(next);
    if (next === "rail") writeRailPreference(true);
    else if (next === "expanded") writeRailPreference(false);
  }, []);

  const setExpandedWidthValue = useCallback((next: number): void => {
    const normalized = normalizeSidebarExpandedWidth(next);
    expandedWidthRef.current = normalized;
    setExpandedWidth(normalized);
    writeWidthPreference(normalized);
  }, []);

  const setPeekPhaseValue = useCallback((next: SidebarPeekPhase): void => {
    peekPhaseRef.current = next;
    setPeekPhase(next);
  }, []);

  const clearTimer = useCallback((timerRef: { current: ReturnType<typeof setTimeout> | undefined }): void => {
    if (timerRef.current === undefined) return;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const clearTimers = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    clearTimer(pinTimerRef);
  }, [clearTimer]);

  const setActiveResizeValue = useCallback((next: ActiveResize | undefined): void => {
    activeResizeRef.current = next;
    setActiveResize(next);
  }, []);

  const finishResize = useCallback((cancelled: boolean): void => {
    const current = activeResizeRef.current;
    if (!current) return;
    setActiveResizeValue(undefined);
    window.removeEventListener("pointermove", current.move);
    window.removeEventListener("pointerup", current.stop);
    window.removeEventListener("pointercancel", current.cancel);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    if (cancelled) return;

    const committed = commitSidebarResize(current.preview, current.start.expandedWidth);
    setExpandedWidthValue(committed.expandedWidth);
    setBaseModeValue(committed.mode);
    if (committed.persistWidth !== undefined) persistWidth(committed.persistWidth);
  }, [persistWidth, setActiveResizeValue, setBaseModeValue, setExpandedWidthValue]);

  const closePeek = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "idle" || peekPhaseRef.current === "pinning" || peekPhaseRef.current === "peekExited") return;
    if (peekPhaseRef.current === "peekClosing") return;
    setPeekPhaseValue("peekClosing");
    closeAnimationTimerRef.current = setTimeout(() => {
      closeAnimationTimerRef.current = undefined;
      if (peekPhaseRef.current !== "peekClosing") return;
      setPeekPhaseValue("peekExited");
      closeAnimationTimerRef.current = setTimeout(() => {
        closeAnimationTimerRef.current = undefined;
        if (peekPhaseRef.current === "peekExited") setPeekPhaseValue("idle");
      }, 0);
    }, SIDEBAR_PEEK_CLOSE_MS);
  }, [clearTimer, setPeekPhaseValue]);

  const scheduleClose = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "idle" || peekPhaseRef.current === "pinning") return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      if (!hoverLockedRef.current) closePeek();
    }, SIDEBAR_PEEK_LEAVE_GRACE_MS);
  }, [clearTimer, closePeek]);

  const keepPeekOpen = useCallback((): void => {
    hoverLockedRef.current = true;
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "pinning") return;
    if (peekPhaseRef.current === "peekClosing" || peekPhaseRef.current === "peekExited") setPeekPhaseValue("peeking");
  }, [clearTimer, setPeekPhaseValue]);

  const scheduleOpen = useCallback((): void => {
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "pinning" || peekPhaseRef.current === "peeking") return;
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    if (openTimerRef.current !== undefined) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = undefined;
      if (baseModeRef.current === "collapsed" && hoverLockedRef.current && peekPhaseRef.current === "idle") setPeekPhaseValue("peeking");
    }, SIDEBAR_PEEK_OPEN_DELAY_MS);
  }, [clearTimer, setPeekPhaseValue]);

  const pinPeek = useCallback((): void => {
    if (baseModeRef.current !== "collapsed") {
      setBaseModeValue("expanded");
      return;
    }
    clearTimers();
    hoverLockedRef.current = true;
    setPeekPhaseValue("pinning");
    pinTimerRef.current = setTimeout(() => {
      pinTimerRef.current = undefined;
      if (peekPhaseRef.current !== "pinning") return;
      setBaseModeValue("expanded");
      setPeekPhaseValue("idle");
    }, SIDEBAR_PEEK_PINNING_MS);
  }, [clearTimers, setBaseModeValue, setPeekPhaseValue]);

  const collapse = useCallback((): void => {
    finishResize(true);
    clearTimers();
    hoverLockedRef.current = false;
    setPeekPhaseValue("idle");
    setBaseModeValue("collapsed");
  }, [clearTimers, finishResize, setBaseModeValue, setPeekPhaseValue]);

  const toggle = useCallback((): void => {
    if (baseModeRef.current === "collapsed") pinPeek();
    else collapse();
  }, [collapse, pinPeek]);

  const hydrateExpandedWidth = useCallback((width: number): void => {
    if (activeResizeRef.current) return;
    setExpandedWidthValue(width);
  }, [setExpandedWidthValue]);

  const onResizePointerDown = useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    if (event.button !== 0 || baseModeRef.current === "collapsed") return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const start = sidebarResizeStart({
      baseMode: baseModeRef.current,
      expandedWidth: expandedWidthRef.current,
      startX: event.clientX
    });
    const initialPreview: SidebarResizePreview = {
      mode: baseModeRef.current === "rail" ? "rail" : "expanded",
      width: start.startWidth
    };
    const active: ActiveResize = {
      target,
      pointerId: event.pointerId,
      start,
      preview: initialPreview,
      move: () => undefined,
      stop: () => undefined,
      cancel: () => undefined
    };
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== active.pointerId) return;
      active.preview = previewSidebarResize(active.start, moveEvent.clientX);
      setActiveResizeValue({ ...active });
    };
    const stop = (stopEvent: PointerEvent): void => {
      if (stopEvent.pointerId !== active.pointerId) return;
      finishResize(false);
    };
    const cancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId !== active.pointerId) return;
      finishResize(true);
    };
    active.move = move;
    active.stop = stop;
    active.cancel = cancel;
    target.setPointerCapture(event.pointerId);
    setActiveResizeValue(active);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
  }, [finishResize, setActiveResizeValue]);

  const onResizeKeyDown = useCallback<React.KeyboardEventHandler<HTMLDivElement>>((event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (baseModeRef.current === "collapsed") return;
    const adjustment = adjustSidebarWithKeyboard({
      mode: baseModeRef.current,
      expandedWidth: expandedWidthRef.current,
      direction: event.key === "ArrowLeft" ? "left" : "right"
    });
    setExpandedWidthValue(adjustment.expandedWidth);
    setBaseModeValue(adjustment.mode);
    if (adjustment.persistWidth !== undefined) persistWidth(adjustment.persistWidth);
  }, [persistWidth, setBaseModeValue, setExpandedWidthValue]);

  const onPointerEnter = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
    scheduleOpen();
  }, [keepPeekOpen, scheduleOpen]);

  const onPointerLeave = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    hoverLockedRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    hoverLockedRef.current = true;
    clearTimer(closeTimerRef);
  }, [clearTimer]);

  const onPointerUp = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  useEffect(() => {
    if (baseMode !== "collapsed") {
      clearTimers();
      hoverLockedRef.current = false;
      if (peekPhaseRef.current !== "idle") setPeekPhaseValue("idle");
      return;
    }
    const handlePointerMove = (event: PointerEvent): void => {
      const target = event.target;
      const element = target instanceof Element ? target : undefined;
      const drawer = drawerRef.current;
      const inDrawer = Boolean(drawer && target instanceof Node && drawer.contains(target));
      const inTrigger = Boolean(element?.closest(".biny-sidebar-peek-trigger"));
      const inChrome = Boolean(element?.closest(".biny-sidebar-topbar-floating"));
      if (inDrawer || inTrigger || inChrome || event.clientX <= PEEK_TRIGGER_WIDTH) {
        keepPeekOpen();
        if ((inTrigger || event.clientX <= PEEK_TRIGGER_WIDTH) && peekPhaseRef.current === "idle") scheduleOpen();
        return;
      }
      hoverLockedRef.current = false;
      scheduleClose();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [baseMode, clearTimers, keepPeekOpen, scheduleClose, scheduleOpen, setPeekPhaseValue]);

  useEffect(() => {
    const handleWindowBlur = (): void => {
      finishResize(true);
      hoverLockedRef.current = false;
      clearTimers();
      closePeek();
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [clearTimers, closePeek, finishResize]);

  useEffect(() => () => {
    clearTimers();
    const current = activeResizeRef.current;
    if (!current) return;
    window.removeEventListener("pointermove", current.move);
    window.removeEventListener("pointerup", current.stop);
    window.removeEventListener("pointercancel", current.cancel);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }, [clearTimers]);

  const layout = useMemo(() => resolveSidebarLayout({
    baseMode,
    expandedWidth,
    peekPhase,
    previewWidth: activeResize?.preview.width,
    resizing: activeResize !== undefined
  }), [activeResize, baseMode, expandedWidth, peekPhase]);

  return {
    layout,
    drawerHandlers: { onPointerEnter, onPointerLeave, onPointerMove, onPointerDown, onPointerUp },
    drawerRef,
    triggerHandlers: { onPointerEnter, onPointerLeave, onPointerMove },
    hydrateExpandedWidth,
    toggle,
    onResizeKeyDown,
    onResizePointerDown
  };
}
