/**
 * 轮次级失败/未完成卡片：blocked / incomplete / cancelled / aborted / failed 的统一出口。
 *
 * 卡片结构：图标 + 标题（区分「任务被阻塞 / 本轮运行失败 / 已取消」等语义）+ 人话错误信息
 * （UND_ERR_* 这类原始错误码经 `humanizeRunError` 映射成可操作提示，完整原文放 hover tooltip）
 * + 操作按钮（resumable 时「继续运行」，否则「重试」）。颜色全部走 biny 主题 token。
 */
import { memo, useCallback, useRef, useState } from "react";
import { humanizeRunError, runErrorPresentation } from "../../chatModel.js";
import type { TimelineRunStatus } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

export const RunErrorCard = memo(function RunErrorCard({
  status,
  message,
  resumable,
  onResume,
  onRetry,
  onDismiss,
}: {
  /** 轮次终态；驱动标题与语义色。 */
  status: TimelineRunStatus;
  /** 原始错误文本（可能是错误码）；卡片显示精简后的人话，完整原文放 tooltip。 */
  message: string;
  /** 可从断点继续时展示「继续运行」。 */
  resumable?: boolean;
  onResume(): void;
  /** 非 resumable 时展示「重试」；没有可重试的用户输入时缺省。 */
  onRetry?(): Promise<void>;
  /** 关闭卡片（仅隐藏展示，不改变轮次状态）。 */
  onDismiss?(): void;
}): React.JSX.Element {
  const { title, variant } = runErrorPresentation(status);
  const summary = humanizeRunError(message);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const handleRetry = useCallback(async (): Promise<void> => {
    if (!onRetry || retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, [onRetry]);
  return (
    <div className="run-error-card" data-variant={variant} role="alert">
      <span className="run-error-card-icon"><Icon name="warning" size={16} /></span>
      <div className="run-error-card-body">
        <span className="run-error-card-title">{title}</span>
        {summary ? <span className="run-error-card-message" title={message}>{summary}</span> : null}
        {resumable || onRetry ? (
          <div className="run-error-card-actions">
            {resumable ? (
              <button className="run-error-card-action is-primary" onClick={onResume} type="button">继续运行</button>
            ) : onRetry ? (
              <button className="run-error-card-action" disabled={retrying} onClick={() => { void handleRetry(); }} type="button">{retrying ? "重试中…" : "重试"}</button>
          ) : null}
        </div>
      ) : null}
      </div>
      {onDismiss ? (
        <button
          aria-label="关闭提示"
          className="run-error-card-dismiss"
          onClick={onDismiss}
          title="关闭提示"
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
});
