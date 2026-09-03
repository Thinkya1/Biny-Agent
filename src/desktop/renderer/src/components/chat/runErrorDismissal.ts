/**
 * 轮次错误提示的已读状态。
 *
 * 错误事实仍然保存在 session 中；这里仅记录用户已经看过/关闭的提示，避免切换会话或重启
 * 应用后同一条错误反复打扰。localStorage 只作为缓存，读写失败不影响聊天功能。
 */

const dismissedRunErrorTurns = new Set<string>();
const DISMISSED_RUN_ERROR_STORAGE_KEY = "biny.desktop.dismissed-run-errors";
const DISMISSED_RUN_ERROR_LIMIT = 500;
let dismissedRunErrorHydrated = false;

function hydrateDismissedRunErrors(): void {
  if (dismissedRunErrorHydrated) return;
  dismissedRunErrorHydrated = true;
  try {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(DISMISSED_RUN_ERROR_STORAGE_KEY);
    if (!raw) return;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return;
    for (const key of stored) {
      if (typeof key === "string" && key) dismissedRunErrorTurns.add(key);
    }
  } catch {
    // 本地存储读失败：退回内存集合，本次运行期内仍然有效。
  }
}

function persistDismissedRunErrors(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      DISMISSED_RUN_ERROR_STORAGE_KEY,
      JSON.stringify([...dismissedRunErrorTurns].slice(-DISMISSED_RUN_ERROR_LIMIT))
    );
  } catch {
    // 本地存储写失败：内存集合已记，本次运行期内仍然有效。
  }
}

export function isRunErrorSeen(key: string): boolean {
  hydrateDismissedRunErrors();
  return dismissedRunErrorTurns.has(key);
}

/** 批量登记已看过的轮次，并把最近使用的项保留在缓存末尾。 */
export function markRunErrorsSeen(keys: readonly string[]): void {
  hydrateDismissedRunErrors();
  for (const key of keys) {
    dismissedRunErrorTurns.delete(key);
    dismissedRunErrorTurns.add(key);
  }
  persistDismissedRunErrors();
}

/** 新一轮开始后清理已经不在当前会话中的旧标记，避免缓存随历史增长。 */
export function pruneRunErrorsSeen(
  projectId: string,
  sessionId: string | undefined,
  validIdentifiers: ReadonlySet<string>
): void {
  hydrateDismissedRunErrors();
  const prefix = `${projectId}:${sessionId ?? "draft"}:`;
  let mutated = false;
  for (const key of dismissedRunErrorTurns) {
    if (!key.startsWith(prefix)) continue;
    if (validIdentifiers.has(key.slice(prefix.length))) continue;
    dismissedRunErrorTurns.delete(key);
    mutated = true;
  }
  if (mutated) persistDismissedRunErrors();
}
