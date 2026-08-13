/** 外观设置：主题、字体与字号。 */
import { useEffect, useState } from "react";
import type { DesktopFontPreference, DesktopThemePreference } from "../../../../protocol.js";
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE, SYSTEM_FONT_FAMILY } from "../../../../fontPreference.js";
import { Icon, type IconName } from "../Icon.js";

const fontFamilyOptions: Array<{ value: string; title: string }> = [
  { value: SYSTEM_FONT_FAMILY, title: "系统默认" },
  { value: "PingFang SC", title: "苹方" },
  { value: "Hiragino Sans GB", title: "冬青黑体" },
  { value: "Noto Sans SC", title: "思源黑体" },
  { value: "Songti SC", title: "宋体" },
  { value: "Kaiti SC", title: "楷体" },
  { value: "Yuanti SC", title: "圆体" }
];

export function SettingsAppearance({ theme, onThemeChange, font, onFontChange }: {
  theme: DesktopThemePreference;
  onThemeChange(theme: DesktopThemePreference): void;
  font: DesktopFontPreference;
  onFontChange(font: DesktopFontPreference): void;
}): React.JSX.Element {
  const options: Array<{ value: DesktopThemePreference; title: string; icon: IconName }> = [
    { value: "light", title: "浅色", icon: "sun" },
    { value: "dark", title: "深色", icon: "moon" },
    { value: "system", title: "跟随系统", icon: "display" }
  ];
  // 字号输入允许中间态（比如清空后再输入），失焦或回车时才夹取并提交。
  const [sizeText, setSizeText] = useState(String(font.size));
  useEffect(() => {
    setSizeText(String(font.size));
  }, [font.size]);
  const commitSize = (): void => {
    const parsed = Number(sizeText);
    const next = Number.isFinite(parsed) && sizeText.trim() !== "" ? clampFontSize(parsed) : font.size;
    setSizeText(String(next));
    if (next !== font.size) onFontChange({ ...font, size: next });
  };
  const changeSize = (value: string): void => {
    setSizeText(value);
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE && parsed !== font.size) {
      onFontChange({ ...font, size: parsed });
    }
  };
  const familyOptions = fontFamilyOptions.some((option) => option.value === font.family)
    ? fontFamilyOptions
    : [...fontFamilyOptions, { value: font.family, title: font.family }];
  return (
    <div className="settings-sections appearance-settings">
      <div className="appearance-section-group" id="appearance-theme" tabIndex={-1}>
        <h3>外观</h3>
        <section className="appearance-card">
          <div className="appearance-control-label">显示模式</div>
          <div className="theme-option-grid" role="radiogroup" aria-label="主题">
            {options.map((option) => (
              <button
                aria-checked={theme === option.value}
                className={`theme-option${theme === option.value ? " is-selected" : ""}`}
                data-theme-option={option.value}
                key={option.value}
                onClick={() => onThemeChange(option.value)}
                role="radio"
                type="button"
              >
                <span className="theme-option-preview"><Icon name={option.icon} size={24} /></span>
                <span className="theme-option-caption">
                  <span>{option.title}</span>
                  {theme === option.value ? <i aria-hidden="true" /> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="appearance-card appearance-font-card" id="appearance-font" tabIndex={-1}>
        <div className="font-field">
          <div className="appearance-card-heading">
            <label className="font-field-label" htmlFor="appearance-font-family">界面字体</label>
            <small className="font-field-hint">用于菜单、设置、对话正文等界面文字。</small>
          </div>
          <select
            className="font-select"
            id="appearance-font-family"
            onChange={(event) => onFontChange({ ...font, family: event.target.value })}
            value={font.family}
          >
            {familyOptions.map((option) => <option key={option.value} value={option.value}>{option.title}</option>)}
          </select>
        </div>
        <div className="appearance-card-divider" />
        <div className="font-field">
          <div className="appearance-card-heading">
            <label className="font-field-label" htmlFor="appearance-font-size">字体大小</label>
            <small className="font-field-hint">在 {MIN_FONT_SIZE} – {MAX_FONT_SIZE} px 之间调整整个应用的字号。</small>
          </div>
          <div className="font-size-row">
            <input
              className="font-size-input"
              id="appearance-font-size"
              max={MAX_FONT_SIZE}
              min={MIN_FONT_SIZE}
              onBlur={commitSize}
              onChange={(event) => changeSize(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSize();
              }}
              step={1}
              type="number"
              value={sizeText}
            />
            <span className="font-size-unit">px</span>
          </div>
        </div>
      </section>
    </div>
  );
}
