import { useEffect, useRef, useState } from "react";

/** 逐字打出 */
const TYPE_MS = 55;
/** 打完停留 */
const HOLD_MS = 6000;
/** 快速退格 */
const DELETE_MS = 22;
/** 退格完稍作停顿再开始下一轮 */
const REST_MS = 600;

type Phase = "typing" | "holding" | "deleting" | "resting";

/**
 * 输入框 placeholder 的打字机动画：空输入时把占位文案逐字打出 → 停留 →
 * 快速退格 → 重新打， gentle loop 让空输入框保持「活」的感觉。
 *
 * - 输入框非空（placeholder 不可见）时直接返回全文，不做动画也不产生渲染；
 * - 文案变化（如运行中切换提示语）时重新打一遍；
 * - prefers-reduced-motion 时退化为静态全文。
 */
export function useTypedPlaceholder(text: string, enabled: boolean): string {
  const [len, setLen] = useState(0);
  const phaseRef = useRef<Phase>("typing");
  const timerRef = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!enabled || reduced) {
      phaseRef.current = "typing";
      setLen(text.length);
      return;
    }

    // 文案变化：从头重打
    phaseRef.current = "typing";
    setLen(0);

    const step = () => {
      const phase = phaseRef.current;
      let delay = TYPE_MS;
      if (phase === "typing") {
        setLen((prev) => {
          const next = prev + 1;
          if (next >= text.length) phaseRef.current = "holding";
          return Math.min(next, text.length);
        });
      } else if (phase === "holding") {
        phaseRef.current = "deleting";
        delay = HOLD_MS;
      } else if (phase === "deleting") {
        delay = DELETE_MS;
        setLen((prev) => {
          const next = prev - 1;
          if (next <= 0) phaseRef.current = "resting";
          return Math.max(next, 0);
        });
      } else {
        phaseRef.current = "typing";
        delay = REST_MS;
      }
      timerRef.current = window.setTimeout(step, delay);
    };

    timerRef.current = window.setTimeout(step, TYPE_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [text, enabled]);

  return enabled ? text.slice(0, len) : text;
}
