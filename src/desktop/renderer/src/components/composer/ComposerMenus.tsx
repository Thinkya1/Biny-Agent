/** Composer 的权限模式弹出菜单。思考级别随模型选择器一起展示。 */
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { RefObject } from "react";
import { useClosingPresence } from "../../useClosingPresence.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { Icon } from "../Icon.js";
import { permissionOptions, thinkingLabel } from "./composerLabels.js";

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
          <button className={`menu-option${option.mode === mode ? " is-selected" : ""}`} key={option.mode} onClick={() => onChange(option.mode)} role="menuitemradio" type="button">
            <span className="menu-check">{option.mode === mode ? <Icon name="check" size={14} /> : null}</span>
            <span className="menu-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
            {option.risk ? <span className="risk-label">{option.risk}</span> : null}
          </button>
        ))}
      </div>
    </ComposerPopover>
  );
}

/** 当前模型的思考级别菜单；模型选择器和它保持相邻但互不嵌套。 */
export function ThinkingMenu({ anchorRef, current, levels, open, onChange }: {
  anchorRef: RefObject<HTMLElement | null>;
  current: ThinkingSelection;
  levels: ThinkingSelection[];
  open: boolean;
  onChange(level: ThinkingSelection): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover cindy-composer-popover thinking-level-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div role="menu">
        <div className="popover-heading">Thinking Level</div>
        {levels.map((level) => (
          <button aria-checked={level === current} className={`menu-option${level === current ? " is-selected" : ""}`} key={level} onClick={() => onChange(level)} role="menuitemradio" type="button">
            <span className="menu-check">{level === current ? <Icon name="check" size={14} /> : null}</span>
            <span className="menu-option-copy"><strong>{thinkingLabel(level)}</strong></span>
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
