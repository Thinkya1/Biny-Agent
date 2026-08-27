/**
 * 同文件连续编辑的合并行。
 *
 * 执行组里相邻的、同路径的多次 edit 不再平铺成 N 行重复路径，
 * 收成一行：文件名（加粗）+ 目录 + 「N 次编辑」chip + 累计 +x -y。
 * 行内 hover 浮出「预览文件 / 复制合并 diff」，展开体按编辑顺序分 hunk：
 * 每段带「第 N 次编辑 · L58 / L112 · +a -b」标签 + 带行号的 diff 行；
 * 默认只展开第 1 段，其余收成折叠条，点击一次展开全部剩余。
 *
 * 合并条件（isMergeableEdit）：file_io 的 edit、带 diff、路径可考、无未决权限卡。
 * 权限询问和失败工具的完整卡片仍归单工具 ToolActivity 表达，不吞进合并行。
 */
import { memo, useMemo, useState } from "react";
import type { TimelineTool } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { CopyButton } from "../CopyButton.js";
import { BreathingDot } from "./BreathingDot.js";
import { Collapse } from "./Collapse.js";

/** 工具是否可进合并行：edit + 有 diff + 有路径 + 无权限卡。 */
export function isMergeableEdit(tool: TimelineTool): boolean {
  return tool.display?.kind === "file_io"
    && tool.display.operation === "edit"
    && typeof tool.diff === "string"
    && tool.diff.length > 0
    && editToolPath(tool) !== undefined
    && tool.permission === undefined;
}

export function editToolPath(tool: TimelineTool): string | undefined {
  if (tool.display?.kind === "file_io" && tool.display.path) return tool.display.path;
  return tool.path;
}

export const MergedFileEdits = memo(function MergedFileEdits({
  tools,
  projectId,
  onPreviewFile,
}: {
  /** 同路径的连续编辑（≥2，按时间序）。 */
  tools: TimelineTool[];
  projectId: string;
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const path = editToolPath(tools[0]!) ?? "";
  const { name, dir } = splitPath(path);
  const stats = useMemo(() => tools.reduce(
    (sum, tool) => {
      const s = countDiffStats(tool.diff ?? "");
      return { add: sum.add + s.add, del: sum.del + s.del };
    },
    { add: 0, del: 0 }
  ), [tools]);
  const running = tools.some((tool) => tool.status === "running" || tool.status === "waiting");
  const failed = tools.some((tool) => tool.status === "failed" || tool.status === "denied" || tool.status === "unknown" || tool.status === "cancelled");
  const state = running ? "running" : failed ? "error" : "ok";
  const combinedDiff = useMemo(() => tools.map((tool) => tool.diff).filter(Boolean).join("\n"), [tools]);

  const [open, setOpen] = useState(false);
  /** 展开体里已揭示的段数；默认只露第 1 段，折叠条一次揭示全部剩余。 */
  const [revealed, setRevealed] = useState(1);
  const hiddenTools = tools.slice(revealed);
  const hiddenStarts = hiddenTools.map((tool) => firstHunkStart(tool.diff ?? "")).filter(Boolean).join(" / ");

  return (
    <section className={`chat-tool merged-edits${open ? " is-open" : ""}`} data-project-id={projectId} data-state={state} data-variant="edit">
      <div className="merged-edits-row">
        <button
          aria-expanded={open}
          className="chat-row-header merged-edits-main"
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <span className="chat-tool-icon">
            {running ? <BreathingDot breathing tone="accent" /> : <Icon name="edit" size={14} />}
          </span>
          <span className="merged-edits-name" title={path}>{name}</span>
          {dir !== "" ? <span className="merged-edits-dir">{dir}</span> : null}
          <span className="merged-edits-chip">{tools.length} 次编辑</span>
        </button>
        <span className="merged-edits-ops">
          <button
            aria-label="在右侧预览文件"
            className="merged-edits-op"
            onClick={() => onPreviewFile(path)}
            title="在右侧预览文件"
            type="button"
          >
            <Icon name="eye" size={13} />
          </button>
          <CopyButton className="merged-edits-op" label="复制合并 diff" size={13} value={combinedDiff} />
        </span>
        <span className="diff-stats merged-edits-stats">
          <span className="diff-add">+{stats.add}</span>
          <span className="diff-delete">-{stats.del}</span>
        </span>
      </div>
      <Collapse open={open}>
        <div className="merged-edits-body">
          {tools.slice(0, revealed).map((tool, index) => (
            <EditSegment index={index} key={tool.id} tool={tool} />
          ))}
          {hiddenTools.length > 0 ? (
            <button className="merged-edit-more" onClick={() => setRevealed(tools.length)} type="button">
              <Icon name="more" size={12} />
              <span>还有 {hiddenTools.length} 次编辑{hiddenStarts !== "" ? ` · ${hiddenStarts}` : ""}</span>
            </button>
          ) : null}
        </div>
      </Collapse>
    </section>
  );
});

/** 单次编辑段：标签行 + 带行号的 hunk 流；失败段补错误首行。 */
function EditSegment({ tool, index }: { tool: TimelineTool; index: number }): React.JSX.Element {
  const hunks = useMemo(() => parseDiffHunks(tool.diff ?? ""), [tool.diff]);
  const stats = useMemo(() => countDiffStats(tool.diff ?? ""), [tool.diff]);
  const failed = tool.status === "failed" || tool.status === "denied" || tool.status === "unknown" || tool.status === "cancelled";
  const starts = hunks.map((hunk) => `L${String(hunk.newStart)}`).join(" / ");
  return (
    <div className="merged-edit-segment">
      <div className="merged-edit-segment-label">
        <span>第 {index + 1} 次编辑</span>
        {starts !== "" ? <span className="merged-edit-segment-lines">{starts}</span> : null}
        <span className="diff-add">+{stats.add}</span>
        <span className="diff-delete">-{stats.del}</span>
        {failed ? <span className="merged-edit-segment-failed">失败</span> : null}
      </div>
      {hunks.length > 0 ? (
        <pre className="merged-edit-diff"><code>
          {hunks.map((hunk, hunkIndex) => (
            <span key={hunkIndex}>
              {hunkIndex > 0 ? <span className="merged-diff-line merged-diff-gap"><span className="merged-diff-ln">⋮</span><span className="merged-diff-sign" /><span className="merged-diff-text" />{"\n"}</span> : null}
              {hunk.lines.map((line, lineIndex) => (
                <span className="merged-diff-line" data-line={line.kind} key={lineIndex}>
                  <span className="merged-diff-ln">{line.lineNo ?? ""}</span>
                  <span className="merged-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
                  <span className="merged-diff-text">{line.text}</span>{"\n"}
                </span>
              ))}
            </span>
          ))}
        </code></pre>
      ) : null}
      {failed && tool.error ? <div className="merged-edit-error">{firstLine(tool.error)}</div> : null}
    </div>
  );
}

interface DiffHunkLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** 展示行号：add/ctx 用新行号，del 用旧行号。 */
  lineNo?: number;
}

interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

/** 把 unified diff 拆成 hunk；meta 行（diff --git/index/---/+++）不渲染，路径已在合并行表达。 */
function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.lines.push({ kind: "add", text: raw.slice(1), lineNo: newLine });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.lines.push({ kind: "del", text: raw.slice(1), lineNo: oldLine });
      oldLine += 1;
    } else if (raw.startsWith("\\")) {
      // 「\ No newline at end of file」不占行号。
    } else {
      current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, lineNo: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

function countDiffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  return { add, del };
}

function firstHunkStart(diff: string): string | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(diff);
  return match?.[1] ? `L${match[1]}` : undefined;
}

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { name: path, dir: "" };
  return { name: path.slice(index + 1), dir: path.slice(0, index) };
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index < 0 ? text : text.slice(0, index);
}
