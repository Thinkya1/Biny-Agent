/** 设置内统一的布尔开关：使用勾选状态，而不是滑动开关。 */
import { Icon } from "../Icon.js";

interface SettingsCheckboxProps {
  checked: boolean;
  detail: string;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}

export function SettingsCheckbox({ checked, detail, disabled = false, label, onChange }: SettingsCheckboxProps): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      className={`settings-check-row${checked ? " is-checked" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="checkbox"
      type="button"
    >
      <span aria-hidden="true" className="settings-check-box"><Icon name="check" size={12} /></span>
      <span className="settings-check-copy"><strong>{label}</strong><small>{detail}</small></span>
    </button>
  );
}
