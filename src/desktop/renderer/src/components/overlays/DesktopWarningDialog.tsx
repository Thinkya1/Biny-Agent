/** 全局警告弹窗：错误和需要用户注意的一次性提示都必须由用户确认。 */
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useEffect, useState } from "react";
import { Icon } from "../Icon.js";

export function DesktopWarningDialog({ message, onClose }: { message?: string; onClose(): void }): React.JSX.Element | null {
  // Dialog 退场时保留内容，避免关闭动画期间文本先消失。
  const [lastMessage, setLastMessage] = useState<string>();
  useEffect(() => {
    if (message) setLastMessage(message);
  }, [message]);

  const shownMessage = message ?? lastMessage;
  if (!shownMessage) return null;

  return (
    <Dialog
      aria-label="警告"
      isOpen={Boolean(message)}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      padding={0}
      purpose="form"
      role="alertdialog"
      width="min(480px, calc(100vw - 32px))"
    >
      <section className="desktop-warning-dialog">
        <DialogHeader hasDivider onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title="警告" />
        <div className="desktop-warning-dialog-body">
          <Icon className="desktop-warning-dialog-icon" name="warning" size={20} />
          <p>{shownMessage}</p>
        </div>
        <div className="desktop-dialog-actions desktop-warning-dialog-actions">
          <Button label="知道了" onClick={onClose} variant="primary" />
        </div>
      </section>
    </Dialog>
  );
}
