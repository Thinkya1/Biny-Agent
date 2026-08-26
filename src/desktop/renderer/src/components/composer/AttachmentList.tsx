/** Composer 中待发送附件的展示和删除交互。 */
import type { DesktopAttachment } from "../../../../protocol.js";
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";

export interface PendingAttachment {
  error?: string;
  id: string;
  mimeType: string;
  name: string;
  size: number;
  status: "error" | "uploading";
}

export function AttachmentList({ attachments, onRemove, onRemovePending, pending }: {
  attachments: DesktopAttachment[];
  onRemove(index: number): void;
  onRemovePending(id: string): void;
  pending: PendingAttachment[];
}): React.JSX.Element {
  return (
    <div className="biny-composer-attachments" aria-label="待发送附件">
      {attachments.map((attachment, index) => (
        <div className="biny-attachment-chip" key={`${attachment.path}-${String(index)}`}>
          <Icon name={attachment.mimeType.startsWith("image/") ? "spark" : "file"} size={13} />
          <span className="biny-attachment-copy">
            <span>{attachment.name}</span>
            <small>已就绪</small>
          </span>
          <ComposerActionButton
            className="biny-attachment-remove"
            label={`移除 ${attachment.name}`}
            onClick={() => onRemove(index)}
            tooltip={`移除附件 ${attachment.name}`}
          >
            <Icon name="close" size={11} />
          </ComposerActionButton>
        </div>
      ))}
      {pending.map((attachment) => (
        <div className={`biny-attachment-chip is-${attachment.status}`} key={attachment.id}>
          <Icon name={attachment.status === "error" ? "warning" : "file"} size={13} />
          <span className="biny-attachment-copy">
            <span>{attachment.name}</span>
            <small>{attachment.status === "error" ? attachment.error ?? "上传失败" : "上传中…"}</small>
          </span>
          {attachment.status === "uploading" ? <span aria-label="上传中" className="biny-attachment-spinner" /> : null}
          <ComposerActionButton
            className="biny-attachment-remove"
            label={`移除 ${attachment.name}`}
            onClick={() => onRemovePending(attachment.id)}
            tooltip={attachment.status === "error" ? `移除失败附件 ${attachment.name}` : `取消附件 ${attachment.name}`}
          >
            <Icon name="close" size={11} />
          </ComposerActionButton>
        </div>
      ))}
    </div>
  );
}
