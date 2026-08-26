/** 全局轻量通知：悬浮在底栏上方、自动消失，错误提示保留警告图标。 */
import { Toast, ToastViewport } from "@astryxdesign/core/Toast";
import type { ToastType } from "@astryxdesign/core/Toast";
import { Icon } from "../Icon.js";

interface DesktopToastProps {
  message?: string;
  onClose(): void;
  type?: ToastType;
}

/**
 * 位置说明：四个角落都有常驻控件（设置页底栏左侧是保存状态、右侧是保存按钮；
 * 聊天页右下角是发送区），toast 放角落会盖住这些信息。因此保持在右下，
 * 但抬升到设置底栏（64px）之上，只短暂覆盖可滚动的内容区，不遮挡任何可操作控件。
 */
const TOAST_VIEWPORT_INSET = { bottom: 88, end: 20 } as const;

export function DesktopToast({ message, onClose, type = "info" }: DesktopToastProps): React.JSX.Element | null {
  if (!message) return null;

  const displayMessage = compactToastMessage(message);
  return (
    <ToastViewport inset={TOAST_VIEWPORT_INSET} maxVisible={1} position="bottomEnd">
      <Toast
        autoHideDuration={type === "error" ? 6_000 : 2_000}
        body={(
          <span className="desktop-toast-body">
            {type === "error" ? <Icon className="desktop-toast-icon" name="warning" size={14} /> : null}
            <span className="desktop-toast-message" title={message}>{displayMessage}</span>
          </span>
        )}
        isAutoHide
        key={`${type}:${message}`}
        onDismiss={onClose}
        type={type}
      />
    </ToastViewport>
  );
}

function compactToastMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const withoutRemoteErrorPrefix = normalized.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "");
  const compact = withoutRemoteErrorPrefix.replace(/^Error:\s*/i, "");
  return compact || normalized;
}
