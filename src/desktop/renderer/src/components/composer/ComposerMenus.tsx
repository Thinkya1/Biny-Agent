/** Composer 的加号菜单与权限模式弹出菜单。 */
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { RefObject } from "react";
import { useClosingPresence } from "../../useClosingPresence.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { Icon } from "../Icon.js";
import { permissionOptions } from "./composerLabels.js";

/** 加号菜单：添加附件 + 规划模式勾选（参考 Maka Agent 的模式勾选形态）。 */
export function AddMenu({ anchorRef, open, planActive, onPickFiles, onPlanModeChange }: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  planActive: boolean;
  onPickFiles(): void;
  onPlanModeChange(active: boolean): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover cindy-composer-popover add-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div role="menu">
        <div className="popover-heading">添加</div>
        <button className="menu-option" onClick={onPickFiles} role="menuitem" type="button">
          <span className="menu-check"><Icon name="paperclip" size={14} /></span>
          <span className="menu-option-copy"><strong>添加文件或目录</strong><small>附加到这条消息</small></span>
        </button>
        <button aria-checked={planActive} className={`menu-option${planActive ? " is-selected" : ""}`} onClick={() => onPlanModeChange(!planActive)} role="menuitemcheckbox" type="button">
          <span className="menu-check">{planActive ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>规划模式</strong><small>先分析任务并制定计划，不执行修改</small></span>
        </button>
      </div>
    </ComposerPopover>
  );
}

export function PermissionMenu({ anchorRef, mode, open, onChange }: {
  anchorRef: RefObject<HTMLElement | null>;
  mode: PermissionMode;
  open: boolean;
  onChange(mode: PermissionMode): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover cindy-composer-popover permission-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div role="menu">
        <div className="popover-heading">权限模式</div>
        {permissionOptions.map((option) => (
          <button aria-checked={option.mode === mode} className={`menu-option permission-option permission-option-${option.mode}${option.mode === mode ? " is-selected" : ""}`} key={option.mode} onClick={() => onChange(option.mode)} role="menuitemradio" type="button">
            <span className={`permission-option-icon is-${option.mode}`}><Icon name={option.icon} size={18} /></span>
            <span className="menu-option-copy permission-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
            <span className="permission-option-trailing">
              {option.risk ? <span className="risk-label">{option.risk}</span> : null}
              <span className="permission-option-check"><Icon name="check" size={16} /></span>
            </span>
          </button>
        ))}
      </div>
    </ComposerPopover>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
