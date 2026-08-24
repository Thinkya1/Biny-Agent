/** 全局轻量通知：单行悬浮、自动消失，错误提示保留警告图标。 */
import { Toast, ToastViewport } from "@astryxdesign/core/Toast";
import type { ToastType } from "@astryxdesign/core/Toast";
import { Icon } from "../Icon.js";

interface DesktopToastProps {
  message?: string;
  onClose(): void;
  type?: ToastType;
}

export function DesktopToast({ message, onClose, type = "info" }: DesktopToastProps): React.JSX.Element | null {
  if (!message) return null;

  const displayMessage = compactToastMessage(message);
  return (
    <ToastViewport inset={{ bottom: 16, end: 16 }} maxVisible={1} position="bottomEnd">
      <Toast
        autoHideDuration={type === "error" ? 4_500 : 1_800}
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
