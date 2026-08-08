/** Composer 的发送/停止状态切换。 */
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";

export function SendOrStopButton({
  disabled,
  disabledReason,
  onSend,
  onStop,
  running,
  stopPending
}: {
  disabled: boolean;
  disabledReason?: string;
  onSend(): void;
  onStop(): void;
  running: boolean;
  stopPending: boolean;
}): React.JSX.Element {
  // 停止请求发出后运行态可能还要等待 provider/tool 收尾；这段时间仍要允许用户重试取消。
  const isDisabled = running ? false : disabled;
  const label = running ? stopPending ? "正在停止" : "停止生成" : "发送消息";
  const tooltip = running
    ? stopPending ? "正在停止当前运行，点击可重试" : "停止当前运行"
    : disabledReason ?? (disabled ? "输入内容或附件后发送消息" : "发送消息");

  return (
    <span className={`cindy-send-button-anchor${stopPending ? " is-pending" : ""}`} aria-busy={stopPending || undefined}>
      <ComposerActionButton
        active={running}
        className={`cindy-send-button${running ? " is-stop" : ""}`}
        disabled={isDisabled}
        disabledReason={!running && disabled ? disabledReason ?? "输入内容或附件后发送消息" : undefined}
        label={label}
        loading={stopPending}
        onClick={running ? onStop : onSend}
        tooltip={tooltip}
      >
        <Icon name={running ? "stop" : "arrow-up"} size={15} />
      </ComposerActionButton>
    </span>
  );
}
