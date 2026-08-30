/**
 * Agent 情绪状态的共享类型与纯计算规则。
 *
 * 情绪只影响表达层。状态本身由 Markdown 存储，blendEmotion 负责在注入 prompt 前处理
 * 衰减、上下文情绪的锚定和疲劳带来的能量上限。
 */

export interface EmotionState {
  mood: string;
  valence: number;
  energy: number;
  updatedAt: string;
  trigger?: string;
}

export type EmotionScope = "base" | "context";

export interface BlendedEmotion extends EmotionState {
  fatigue: number;
  source: "base" | "context" | "blended";
}

export const BASE_DECAY_MS = 6 * 60 * 60 * 1_000;
export const CONTEXT_DECAY_MS = 2 * 60 * 60 * 1_000;
export const CONTEXT_VALENCE_MAX_DELTA = 3;
export const FATIGUE_ENERGY_CAP_THRESHOLD = 60;
export const FATIGUE_ENERGY_CAP = 4;

export const DEFAULT_EMOTION_STATE: EmotionState = {
  mood: "cheerful",
  valence: 7,
  energy: 7,
  updatedAt: new Date(0).toISOString(),
  trigger: undefined
};

/**
 * 计算当前真正注入模型的情绪。
 *
 * 过期层完全失效；如果两层都没有有效记录，使用 cheerful 默认人格。context 存在时只
 * 覆盖当前 mood，并把 valence 限制在 base 的上下三点以内，避免一次对话把全局情绪拉走。
 */
export function blendEmotion(
  base: EmotionState | undefined,
  context: EmotionState | undefined,
  fatigue: number,
  now: Date = new Date()
): BlendedEmotion {
  const freshBase = freshState(base, BASE_DECAY_MS, now);
  const freshContext = freshState(context, CONTEXT_DECAY_MS, now);
  const normalizedFatigue = clamp(fatigue, 0, 100);

  let state: EmotionState;
  let source: BlendedEmotion["source"];
  if (freshBase && freshContext) {
    state = {
      mood: freshContext.mood,
      valence: clamp(
        freshContext.valence,
        freshBase.valence - CONTEXT_VALENCE_MAX_DELTA,
        freshBase.valence + CONTEXT_VALENCE_MAX_DELTA
      ),
      energy: freshContext.energy,
      updatedAt: freshContext.updatedAt,
      trigger: freshContext.trigger ?? freshBase.trigger
    };
    source = "blended";
  } else if (freshContext) {
    state = freshContext;
    source = "context";
  } else if (freshBase) {
    state = freshBase;
    source = "base";
  } else {
    state = DEFAULT_EMOTION_STATE;
    source = "base";
  }

  return {
    ...state,
    energy: normalizedFatigue > FATIGUE_ENERGY_CAP_THRESHOLD
      ? Math.min(state.energy, FATIGUE_ENERGY_CAP)
      : state.energy,
    fatigue: normalizedFatigue,
    source
  };
}

function freshState(
  state: EmotionState | undefined,
  decayMs: number,
  now: Date
): EmotionState | undefined {
  if (!state) return undefined;
  const updatedAt = Date.parse(state.updatedAt);
  const currentTime = now.getTime();
  if (!Number.isFinite(updatedAt) || !Number.isFinite(currentTime) || currentTime - updatedAt > decayMs) {
    return undefined;
  }
  return {
    mood: state.mood.trim() || DEFAULT_EMOTION_STATE.mood,
    valence: clamp(state.valence, 0, 10),
    energy: clamp(state.energy, 0, 10),
    updatedAt: state.updatedAt,
    trigger: state.trigger?.trim() || undefined
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
