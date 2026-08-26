/**
 * Session 解析缓存。
 *
 * session 文件是 append-only：只要 (size, mtimeMs) 这组指纹不变，文件内容就不变。这里按真实
 * 路径缓存解析后的 `SessionEvent[]`，指纹一变即整条作废，因此不需要任何显式失效钩子。
 *
 * 缓存的是"读字节 + JSON.parse + zod 校验"这一步的结果；调用方的安全校验（绑定检查、
 * O_NOFOLLOW、repairTailForAppend）仍在缓存之外照常执行。
 *
 * 进程内单机缓存：桌面主进程、RuntimeHost 等各自进程各持一份，不跨进程共享。
 */
import type { SessionEvent } from "./recorder.js";

/** 缓存条数上限：大量小 session 时由它封顶。 */
const maxCachedSessions = 32;
/** 累计源字节上限：少数超大 session 时由它封顶，防止长会话把内存撑爆。 */
const maxCachedSourceBytes = 64 * 1024 * 1024;

/** 命中判断用的文件指纹；append-only 下 (size, mtimeMs) 不变即内容不变。 */
export interface SessionFileFingerprint {
  size: number;
  mtimeMs: number;
}

interface SessionParseCacheEntry {
  fingerprint: SessionFileFingerprint;
  events: SessionEvent[];
  /** 以源字节数计的权重，用于按内存上限淘汰。 */
  weight: number;
}

// Map 的插入顺序即 LRU 顺序：命中时摘除重插到尾部，淘汰从头部开始。
const cache = new Map<string, SessionParseCacheEntry>();
let cachedSourceBytes = 0;

export function sessionFileFingerprint(stat: Pick<SessionFileFingerprint, "size" | "mtimeMs">): SessionFileFingerprint {
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function lookup(filePath: string, fingerprint: SessionFileFingerprint): SessionEvent[] | undefined {
  const entry = cache.get(filePath);
  if (!entry) return undefined;
  if (entry.fingerprint.size !== fingerprint.size || entry.fingerprint.mtimeMs !== fingerprint.mtimeMs) {
    // append-only：指纹一旦过期就永远不会再命中，顺手摘掉，避免陈旧条目白占内存。
    cache.delete(filePath);
    cachedSourceBytes -= entry.weight;
    return undefined;
  }
  // 命中：提到尾部，标记为最近使用。
  cache.delete(filePath);
  cache.set(filePath, entry);
  return entry.events;
}

function store(filePath: string, fingerprint: SessionFileFingerprint, events: SessionEvent[]): void {
  const weight = Math.max(0, fingerprint.size);
  const existing = cache.get(filePath);
  if (existing) {
    cachedSourceBytes -= existing.weight;
    cache.delete(filePath);
  }
  cache.set(filePath, { fingerprint, events, weight });
  cachedSourceBytes += weight;
  while (cache.size > maxCachedSessions || cachedSourceBytes > maxCachedSourceBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    if (evicted) cachedSourceBytes -= evicted.weight;
    cache.delete(oldest.value);
  }
}

/**
 * 命中即返回缓存的事件数组；未命中调用 `load()` 解析并按需缓存。
 *
 * `load` 返回 `complete: false` 表示这次解析没有看全文件（例如超限只读了尾部），结果只供本次
 * 使用、不进缓存——否则"被截断的视角"会被误发给需要完整事件的读取方（如 resume 的严格校验）。
 *
 * 返回的事件数组在多个调用方之间共享，调用方不得修改它（replay/摘要都只读它）。
 */
export function cachedSessionEvents(
  filePath: string,
  fingerprint: SessionFileFingerprint,
  load: () => { events: SessionEvent[]; complete: boolean }
): SessionEvent[] {
  const cached = lookup(filePath, fingerprint);
  if (cached) return cached;
  const { events, complete } = load();
  if (complete) store(filePath, fingerprint, events);
  return events;
}

/** 测试与手动失效用：清空整个缓存。 */
export function clearSessionParseCache(): void {
  cache.clear();
  cachedSourceBytes = 0;
}
