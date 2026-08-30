/**
 * 会话消息树的纯数据投影。
 *
 * 这里刻意不依赖文件系统、Node API 或回放实现，renderer 也能复用同一套活动版本规则。
 * 持久化回放负责把它接到模型消息上，时间线只使用消息 ID 和事件归属。
 */
import type { AgentMessage } from "../agent/core/types.js";
import type { SessionEvent } from "./recorder.js";

export interface SessionMessageNode {
  id: string;
  parentId?: string;
  slotId?: string;
  eventIndex: number;
  message: AgentMessage;
}

export interface SessionMessageReference {
  id?: string;
  index: number;
  parentId?: string;
  slotId?: string;
}

/** 新格式保留 canonical 消息的父子关系；旧事件没有 ID 时由时间线继续按扁平事件展示。 */
export function sessionMessageTree(events: SessionEvent[]): SessionMessageNode[] {
  return events.flatMap((event, eventIndex): SessionMessageNode[] => {
    if (event.type === "user_message" && !event.auditOnly) {
      if (!event.messageId) return [];
      return [{
        id: event.messageId,
        parentId: event.parentMessageId,
        slotId: event.slotId ?? event.messageId,
        eventIndex,
        message: { role: "user", content: event.content }
      }];
    }
    if (event.type === "agent_message") {
      if (!event.messageId) return [];
      return [{
        id: event.messageId,
        parentId: event.parentMessageId,
        slotId: event.slotId ?? event.messageId,
        eventIndex,
        message: event.message
      }];
    }
    return [];
  });
}

/** 取得当前消息树的活动路径，版本切换标记优先于事件顺序。 */
export function activeSessionMessageIds(events: readonly SessionEvent[]): ReadonlySet<string> {
  const nodes = sessionMessageTree([...events]);
  if (!nodes.length) return new Set<string>();
  const selectedSlots = new Map<string, string>();
  for (const event of events) {
    if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathFor = (leaf: SessionMessageNode): Set<string> => {
    const path = new Set<string>();
    let current: SessionMessageNode | undefined = leaf;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.add(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    return path;
  };
  const compatible = nodes.filter((node) => {
    const path = pathFor(node);
    for (const messageId of selectedSlots.values()) {
      if (!path.has(messageId)) return false;
    }
    return true;
  });
  const leaf = compatible.at(-1) ?? nodes.at(-1);
  if (!leaf) return new Set<string>();
  return pathFor(leaf);
}

/** 保留活动消息对应的工具、终态和扁平投影，避免旧版本在回放时重新出现。 */
export function activeSessionEventsForPath(events: readonly SessionEvent[]): SessionEvent[] {
  const recordedEvents = [...events];
  const activeIds = activeSessionMessageIds(recordedEvents);
  if (!activeIds.size) return recordedEvents;
  const activeRuns = new Set(
    sessionMessageTree(recordedEvents)
      .filter((node) => activeIds.has(node.id))
      .map((node) => recordedEvents[node.eventIndex]?.runtime?.runId)
      .filter((runId): runId is string => runId !== undefined)
  );
  return recordedEvents.filter((event) => {
    if (event.type === "message_version_selected") return true;
    if (event.type === "user_message" || event.type === "agent_message") {
      return event.messageId === undefined || activeIds.has(event.messageId);
    }
    if (event.type === "assistant_message" && event.messageId !== undefined) {
      return activeIds.has(event.messageId);
    }
    if (event.runtime?.runId !== undefined && activeRuns.size > 0) {
      return activeRuns.has(event.runtime.runId);
    }
    return true;
  });
}
