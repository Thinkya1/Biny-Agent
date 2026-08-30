/**
 * 前进/后退历史。
 *
 * 语义和浏览器一致：`index` 指向当前位置，从中间位置再跳转会截断后面的前进记录。
 * 所有函数都返回新对象，不改原状态，方便直接作为 React state 使用。
 */
export interface DesktopNavigationTarget {
  projectId: string;
  sessionId?: string;
  /**
   * 草稿（无会话）的呈现变体：项目行「新建任务」直达空白聊天，
   * 缺省为首页欢迎态。随历史记录保存，后退/前进回到草稿时保持原样。
   */
  draftVariant?: "blank";
}

export interface DesktopNavigationState {
  entries: DesktopNavigationTarget[];
  index: number;
}

export function createNavigationState(): DesktopNavigationState {
  return { entries: [], index: -1 };
}

/** 新增一条历史。目标与当前位置相同时原样返回，避免连点产生重复记录。 */
export function pushNavigation(state: DesktopNavigationState, target: DesktopNavigationTarget): DesktopNavigationState {
  if (sameTarget(state.entries[state.index], target)) return state;
  // 从历史中间跳转时，后面的前进记录作废。
  const entries = state.entries.slice(0, state.index + 1);
  entries.push({ projectId: target.projectId, sessionId: target.sessionId, ...(target.draftVariant ? { draftVariant: target.draftVariant } : {}) });
  return { entries, index: entries.length - 1 };
}

/** 原地替换当前记录（如在同一项目内切换会话），不产生新的后退层级。 */
export function replaceNavigation(state: DesktopNavigationState, target: DesktopNavigationTarget): DesktopNavigationState {
  if (state.index < 0) return pushNavigation(state, target);
  const entries = [...state.entries];
  entries[state.index] = { projectId: target.projectId, sessionId: target.sessionId, ...(target.draftVariant ? { draftVariant: target.draftVariant } : {}) };
  return { entries, index: state.index };
}

/** 前进/后退一步；越界时返回原状态且 `target` 为 undefined，由调用方决定不做跳转。 */
export function moveNavigation(state: DesktopNavigationState, direction: -1 | 1): { state: DesktopNavigationState; target?: DesktopNavigationTarget } {
  const nextIndex = state.index + direction;
  if (nextIndex < 0 || nextIndex >= state.entries.length) return { state, target: undefined };
  return {
    state: { ...state, index: nextIndex },
    target: state.entries[nextIndex]
  };
}

export function canNavigateBack(state: DesktopNavigationState): boolean {
  return state.index > 0;
}

export function canNavigateForward(state: DesktopNavigationState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

function sameTarget(left: DesktopNavigationTarget | undefined, right: DesktopNavigationTarget): boolean {
  return left?.projectId === right.projectId && left?.sessionId === right.sessionId;
}
