/**
 * 聊天内的技能草稿审核卡片。
 *
 * 自动技能提取在回合成功后产出待审核草稿；这张卡片是聊天流里的审核入口，
 * 让草稿不必只能去设置页处理。批准/拒绝直接调主进程；批准后短暂展示「已安装」
 * 再收起消失，拒绝后立即收起。全部动画走 CSS（grid-rows 0fr↔1fr + keyframes），
 * 并带 prefers-reduced-motion 降级。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../app/desktopApi.js";
import type { SkillDraftNotice } from "../app/useDesktopEventBridge.js";
import { Icon } from "./Icon.js";

/** 批准后展示「已安装到技能目录」的停留时长，之后卡片收起消失。 */
const APPROVED_LINGER_MS = 2_500;
/** 收起动画时长（与 CSS 的 grid-rows/opacity 过渡一致），结束后才从列表移除。 */
const COLLAPSE_MS = 320;

type NoticeCardProps = {
  notice: SkillDraftNotice;
  projectId: string;
  /** 动画收起完成后由父组件把卡片从列表移除。 */
  onDismiss(id: string): void;
  onError(message: string): void;
  /** 打开设置 → 技能 tab，便于在设置里审阅/编辑完整草稿。 */
  onOpenSkillSettings(): void;
};

export function SkillDraftNoticeCard({ notice, projectId, onDismiss, onError, onOpenSkillSettings }: NoticeCardProps): React.JSX.Element {
  const [installed, setInstalled] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = useCallback((): void => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  /** 先播收起动画，动画结束再真正从列表移除。 */
  const dismiss = useCallback((): void => {
    setCollapsing(true);
    const timer = setTimeout(() => onDismiss(notice.id), COLLAPSE_MS);
    timersRef.current.push(timer);
  }, [notice.id, onDismiss]);

  const approve = useCallback(async (): Promise<void> => {
    if (busy || installed) return;
    setBusy(true);
    try {
      await window.biny.approveSkillDraft(projectId, notice.id);
      setInstalled(true);
      const linger = setTimeout(dismiss, APPROVED_LINGER_MS);
      timersRef.current.push(linger);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [busy, dismiss, installed, notice.id, onError, projectId]);

  const reject = useCallback(async (): Promise<void> => {
    if (busy || installed) return;
    setBusy(true);
    try {
      await window.biny.rejectSkillDraft(projectId, notice.id);
      dismiss();
    } catch (error) {
      onError(errorMessage(error));
      setBusy(false);
    }
  }, [busy, dismiss, installed, notice.id, onError, projectId]);

  return (
    <div className={`biny-skill-draft-notice${collapsing ? " is-collapsing" : ""}`}>
      <div className="biny-skill-draft-notice-inner">
        <article className={`biny-skill-draft-notice-card${installed ? " is-installed" : ""}`} aria-live="polite">
          <span className={`biny-skill-draft-notice-icon${installed ? " is-installed" : ""}`}>
            <span className="biny-skill-draft-notice-icon-glyph">
              {installed ? <Icon name="check" size={14} /> : <Icon name="wand" size={14} />}
            </span>
          </span>
          <div className="biny-skill-draft-notice-body">
            <span className="biny-skill-draft-notice-title">{installed ? "已安装到技能目录" : "技能草稿待审核"}</span>
            <span className="biny-skill-draft-notice-name">{notice.name}</span>
            {notice.description ? <span className="biny-skill-draft-notice-description">{notice.description}</span> : null}
            {installed ? null : (
              <div className="biny-skill-draft-notice-actions">
                <button className="is-primary" disabled={busy} onClick={() => void approve()} type="button">批准并安装</button>
                <button disabled={busy} onClick={() => void reject()} type="button">拒绝</button>
                <button className="is-link" disabled={busy} onClick={onOpenSkillSettings} type="button">在设置中查看</button>
              </div>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
