/**
 * 会话时间线的增量投影 hook。
 *
 * 直接 `useMemo(() => buildSessionTimeline(...), [document])` 会在流式期间随 document 每帧变化而对
 * 全部历史 + 实时事件重算，长会话因此变卡。这里改用 `createSessionTimelineProjector` 持有缓存：
 * 历史段按事件数组引用记忆、实时段只增量折叠新增的 liveEvents，未变化的轮次保持对象引用稳定，
 * MessageTimeline 里 `Turn = memo(...)` 因而能跳过没有变化的整棵子树。
 */
import { useRef } from "react";
import type { DesktopSessionDocument } from "../../../protocol.js";
import { createSessionTimelineProjector, type SessionTimelineProjector, type TimelineTurn } from "../sessionTimeline.js";

const EMPTY_TURNS: TimelineTurn[] = [];

export function useSessionTimeline(document: DesktopSessionDocument | undefined): TimelineTurn[] {
  const projectorRef = useRef<SessionTimelineProjector | undefined>(undefined);
  // 惰性创建一次；projector 内部按内容引用/长度判断增量还是重置，对同一 document 幂等，
  // 所以渲染期调用（含 StrictMode 双渲染）是安全的。
  const projector = (projectorRef.current ??= createSessionTimelineProjector());
  if (!document) return EMPTY_TURNS;
  return projector.update({
    sessionId: document.session.id,
    events: document.events,
    liveEvents: document.liveEvents
  });
}
