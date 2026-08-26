/**
 * 桌面端左侧栏宽度约束。
 *
 * 渲染进程拖拽、主进程持久化和重启恢复必须使用同一组边界，否则拖到边界后的宽度会在
 * 保存或重新打开窗口时跳回另一组值。
 */
export const DEFAULT_SIDEBAR_WIDTH = 260;
/** Biny rail 需要容纳 macOS 红绿灯和顶部按钮簇，视觉宽度固定为 78px。 */
export const SIDEBAR_RAIL_WIDTH = 78;
/** 原始拖拽宽度低于 120px 时进入 rail；达到 120px 才退出 rail。 */
export const SIDEBAR_RAIL_THRESHOLD = 120;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;
export const SIDEBAR_TRANSITION_MS = 250;
export const SIDEBAR_CONTENT_FADE_MS = 200;
export const SIDEBAR_PEEK_OPEN_DELAY_MS = 120;
export const SIDEBAR_PEEK_LEAVE_GRACE_MS = 160;
export const SIDEBAR_PEEK_CLOSE_MS = 200;
export const SIDEBAR_PEEK_PINNING_MS = 300;

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

/** 旧版把 rail 宽度直接写进了状态；恢复时丢弃这类值，回到默认展开宽度。 */
export function normalizeSidebarWidth(width: number): number {
  return Number.isFinite(width) && width >= MIN_SIDEBAR_WIDTH ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

/** 拖拽中的宽度允许进入 rail 下限，但普通持久化宽度仍必须落在 180–480px。 */
export function clampSidebarResizeWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(SIDEBAR_RAIL_WIDTH, Math.round(width)));
}

export function isCompactSidebarWidth(width: number): boolean {
  return clampSidebarResizeWidth(width) < SIDEBAR_RAIL_THRESHOLD;
}
