/**
 * 单个工具调用的展示卡片：折叠行（状态图标芯片 + 标题 + 摘要 + 用时），
 * 展开体保留权限询问、命令日志、文件变更、diff、网页搜索等卡片。
 *
 * 展开状态是「自动 + 手动覆盖」的组合：等待权限、失败、被拒时默认展开，其余（包括运行中）
 * 保持折叠，运行状态由图标芯片的呼吸光环表达；用户手动切换后 `override` 记住该选择，
 * 直到工具状态发生变化再回到自动策略。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isFullYesConfirmation } from "../../../../permission/confirmation.js";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { tokenizeCommand } from "../commandHighlight.js";
import { classifyTool, firstLine, toolRowState, VARIANT_TITLES } from "../chatModel.js";
import type { TimelineCommand, TimelineTool } from "../sessionTimeline.js";
import { projectWebSearchView, type WebSearchResultView, type WebSearchView } from "../webSearchPresentation.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { CodeView } from "./chat/CodeView.js";
import { ToolCallBlock } from "./chat/ToolCallBlock.js";
import { IoCard } from "./chat/IoCard.js";

interface ToolActivityProps {
  projectId: string;
  tool: TimelineTool;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}

export const ToolActivity = memo(function ToolActivity({ projectId, tool, onPreviewFile, onOpenExternal, onResolvePermission }: ToolActivityProps): React.JSX.Element {
  const permissionPending = Boolean(tool.permission && !tool.permission.resolved);
  const auto = permissionPending || tool.status === "failed" || tool.status === "denied" || tool.status === "unknown" || tool.status === "cancelled";
  // override 连同当时的状态一起记：状态一变（比如从 running 变 success）就作废，回到自动策略。
  const [override, setOverride] = useState<{ status: TimelineTool["status"]; expanded: boolean }>();
  const expanded = override?.status === tool.status ? override.expanded : auto;
  const [resolving, setResolving] = useState(false);
  const command = useMemo(() => commandDetails(tool), [tool]);
  const diff = useMemo(() => tool.diff ? analyzeDiff(tool.diff) : undefined, [tool.diff]);
  const fileChange = useMemo(() => fileChangeDetails(tool), [tool]);
  const webSearch = useMemo(() => tool.tool === "web_search" ? projectWebSearchView(tool.args, tool.result) : undefined, [tool.args, tool.result, tool.tool]);
  const variant = classifyTool(tool.tool);
  const rowState = toolRowState(tool);
  const summary = toolSummary(tool, command, diff, webSearch);
  const durationMs = useLiveDuration(tool);
  const errorText = meaningfulError(tool, command);
  const pathSummary = tool.display?.kind === "file_io"
    && (tool.display.operation === "read" || tool.display.operation === "write" || tool.display.operation === "edit");

  const resolve = async (result: PermissionResult): Promise<void> => {
    if (!tool.permission || resolving) return;
    setResolving(true);
    try {
      await onResolvePermission(tool.permission.requestId, result);
    } finally {
      setResolving(false);
    }
  };

  return (
    <article className={`execution-step tool-activity is-${tool.status}`} data-project-id={projectId}>
      <ToolCallBlock
        durationLabel={durationMs !== undefined ? formatDuration(durationMs) : undefined}
        errorSummary={errorText ? firstLine(errorText) : null}
        expandable
        expanded={expanded}
        highlightSummary={pathSummary}
        onToggle={() => setOverride({ status: tool.status, expanded: !expanded })}
        state={rowState}
        summary={summary}
        title={VARIANT_TITLES[variant]}
        variant={variant}
      >
        <div className="tool-details">
          {tool.permission ? (
            <PermissionCard disabled={resolving} permission={tool.permission} onResolve={resolve} />
          ) : null}
          {command ? <CommandLog command={command} running={tool.status === "running"} /> : null}
          {fileChange ? <FileChangeView change={fileChange} onPreviewFile={onPreviewFile} /> : null}
          {diff && tool.diff ? <DiffView diff={tool.diff} info={diff} onPreviewFile={onPreviewFile} /> : null}
          {webSearch ? <WebSearchLog onOpenExternal={onOpenExternal} tool={tool} view={webSearch} /> : null}
          {!command && !diff && !webSearch && !fileChange ? <ToolPayload onPreviewFile={onPreviewFile} tool={tool} /> : null}
          {errorText ? (
            <section className="tool-section">
              <h4 className="tool-section-label">错误</h4>
              <div className="copyable-code-block is-error">
                <CopyButton className="copy-button" label="复制错误" value={errorText} />
                <pre className="tool-error-output"><code>{errorText}</code></pre>
              </div>
            </section>
          ) : null}
        </div>
      </ToolCallBlock>
    </article>
  );
});

// 「Command exited with code N.」只是退出码徽标的复读，不单独成段。
function meaningfulError(tool: TimelineTool, command: TimelineCommand | undefined): string | undefined {
  if (!tool.error) return undefined;
  if (command?.exitCode !== undefined && /^Command exited with code \d+\.$/.test(tool.error)) return undefined;
  return tool.error;
}

function PermissionCard({
  permission,
  disabled,
  onResolve
}: {
  permission: NonNullable<TimelineTool["permission"]>;
  disabled: boolean;
  onResolve(result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const request = permission.request;
  const alwaysScope = request.command ? "command" : request.targetPath ? "path" : "tool";
  const [confirmationState, setConfirmationState] = useState({ requestId: permission.requestId, value: "" });
  const confirmation = confirmationState.requestId === permission.requestId ? confirmationState.value : "";
  const fullYesProvided = isFullYesConfirmation(confirmation);

  if (permission.resolved) {
    return (
      <div className={`permission-card is-resolved${permission.approved ? " is-approved" : " is-denied"}`}>
        <Icon name={permission.approved ? "check" : "close"} size={15} />
        <span>{permission.approved ? "已允许" : "已拒绝"}{permission.message ? `：${permission.message}` : ""}</span>
      </div>
    );
  }
  return (
    <section className="permission-card">
      <header className="permission-strip">
        <span aria-hidden="true" className="permission-strip-dot" />
        <span className="permission-strip-title">需要授权</span>
        <span className={`risk-badge is-${request.riskLevel}`}>{riskLabel(request.riskLevel)}</span>
      </header>
      <div className="permission-body">
        <h4 className="permission-headline">{request.title}</h4>
        <p>{request.details}</p>
        {request.command ? <pre className="permission-preview command-text"><code><CommandText command={request.command} /></code></pre> : null}
        {request.targetPath ? <div className="permission-target"><Icon name="file" size={13} /><span>{request.targetPath}</span></div> : null}
        {request.preview && !request.command ? <pre className="permission-preview"><code>{request.preview}</code></pre> : null}
        {request.reason ? <p className="permission-reason">{request.reason}</p> : null}
        {request.requireFullYes ? (
          <label className="permission-confirmation">
            <span>高风险操作：输入完整的 <strong>yes</strong> 后才能允许</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => setConfirmationState({ requestId: permission.requestId, value: event.target.value.slice(0, 16) })}
              spellCheck={false}
              type="text"
              value={confirmation}
            />
          </label>
        ) : null}
        <div className="permission-actions">
          <button disabled={disabled} onClick={() => void onResolve({ approved: false, scope: "once", message: "Denied in Biny desktop." })} type="button">拒绝</button>
          <button disabled={disabled || (request.requireFullYes && !fullYesProvided)} onClick={() => void onResolve({ approved: true, scope: alwaysScope, confirmation: request.requireFullYes ? confirmation : undefined })} type="button">始终允许同类操作</button>
          <button className="is-primary" disabled={disabled || (request.requireFullYes && !fullYesProvided)} onClick={() => void onResolve({ approved: true, scope: "once", confirmation: request.requireFullYes ? confirmation : undefined })} type="button">允许一次</button>
        </div>
      </div>
    </section>
  );
}

/** 命令按语义分段着色；配色规则见 styles.css 里的 `.command-text`。 */
function CommandText({ command }: { command: string }): React.JSX.Element {
  const tokens = useMemo(() => tokenizeCommand(command), [command]);
  return <>{tokens.map((token, position) => <span className={`cmd-${token.kind}`} key={position}>{token.text}</span>)}</>;
}

function CommandLog({ command, running }: { command: TimelineCommand; running: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const [expandedHeight, setExpandedHeight] = useState<number>();
  const output = [command.stdout, command.stderr].filter(Boolean).join(command.stdout && command.stderr ? "\n" : "");
  const copyPayload = [command.command, output].filter(Boolean).join("\n");
  const longOutput = output.length > 3_000 || output.split("\n").length > 18;
  useEffect(() => {
    if (!running || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output, running]);
  useEffect(() => {
    const outputElement = outputRef.current;
    if (!outputElement) return;
    const updateExpandedHeight = (): void => {
      const nextHeight = outputElement.scrollHeight;
      setExpandedHeight((current) => current === nextHeight ? current : nextHeight);
    };
    updateExpandedHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateExpandedHeight);
    observer.observe(outputElement);
    return () => observer.disconnect();
  }, [output]);
  const outputStyle = expandedHeight === undefined
    ? undefined
    : { "--terminal-output-expanded-height": `${String(expandedHeight)}px` } as React.CSSProperties;
  return (
    <section className={`tool-output-surface${command.exitCode !== undefined && command.exitCode !== 0 ? " is-error" : ""}`}>
      <header className="tool-output-header">
        <code className="tool-output-command"><CommandText command={command.command} /></code>
        <CopyButton className="copy-button" label="复制命令和输出" value={copyPayload} />
      </header>
      {output || running ? (
        output ? (
          <div className="tool-output-body-wrap">
            <pre className={`tool-output-body${expanded ? " is-expanded" : ""}`} ref={outputRef} style={outputStyle}><code>{command.stdout}{command.stdout && command.stderr && !command.stdout.endsWith("\n") ? "\n" : null}{command.stderr ? <span className="stderr-output">{command.stderr}</span> : null}</code></pre>
            <CopyButton className="tool-output-copy" label="复制输出" value={output} />
          </div>
        ) : <div className="tool-output-empty"><span className="mini-spinner" />等待输出…</div>
      ) : null}
      {command.exitCode !== undefined && command.exitCode !== 0 ? <p className="tool-output-error-meta">退出码 {command.exitCode}</p> : null}
      {longOutput ? <button className="expand-output" onClick={() => setExpanded(!expanded)} type="button">{expanded ? "收起输出" : "展开全部输出"}</button> : null}
    </section>
  );
}

interface FileChangeDetails {
  operation: "write" | "edit";
  path?: string;
  content?: string;
  before?: string;
  after?: string;
}

function fileChangeDetails(tool: TimelineTool): FileChangeDetails | undefined {
  const display = tool.display?.kind === "file_io" ? tool.display : undefined;
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const path = display?.path ?? tool.path ?? stringField(args, "path");
  if (tool.tool === "write_file" || display?.operation === "write") {
    const content = display?.content ?? stringField(args, "content");
    if (content === undefined) return undefined;
    return { operation: "write", path, content };
  }
  if (tool.tool === "edit_file" || display?.operation === "edit") {
    const before = display?.before ?? stringField(args, "oldText");
    const after = display?.after ?? stringField(args, "newText");
    if (before === undefined || after === undefined) return undefined;
    return { operation: "edit", path, before, after };
  }
  return undefined;
}

interface FileChangeLine {
  kind: "add" | "del";
  number?: number;
  text: string;
}

function fileChangeLines(change: FileChangeDetails): FileChangeLine[] {
  const split = (value: string): string[] => {
    const lines = value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  if (change.operation === "write") {
    return split(change.content ?? "").map((text, index) => ({ kind: "add", number: index + 1, text }));
  }
  return [
    ...split(change.before ?? "").map((text): FileChangeLine => ({ kind: "del", text })),
    ...split(change.after ?? "").map((text): FileChangeLine => ({ kind: "add", text }))
  ];
}

const fileChangeVisibleLines = 24;

function FileChangeView({ change, onPreviewFile }: { change: FileChangeDetails; onPreviewFile(path: string): void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => fileChangeLines(change), [change]);
  const visible = showAll ? lines : lines.slice(0, fileChangeVisibleLines);
  const fileName = change.path?.replaceAll("\\", "/").split("/").at(-1);
  // 写入是整段新内容：直接走高亮代码卡片（行号 + 语言标签），比满屏绿色 add 行更清爽。
  if (change.operation === "write") {
    return (
      <section className="tool-section">
        <h4 className="tool-section-label">内容<span className="tool-section-meta">+{lines.length} 行</span></h4>
        <CodeView code={change.content ?? ""} filePath={change.path} onPreviewFile={change.path ? onPreviewFile : undefined} />
      </section>
    );
  }
  return (
    <section className="tool-section">
      <h4 className="tool-section-label">变更</h4>
      <div className="code-card">
        {change.path ? (
          <button className="code-card-header" onClick={() => onPreviewFile(change.path ?? "")} title={`在右侧预览 ${change.path}`} type="button">
            <Icon name="file" size={12} />
            <span className="code-card-filename">{fileName}</span>
          </button>
        ) : null}
        <div className="code-card-body">
          <CopyButton className="copy-button" label="复制新内容" value={change.after ?? ""} />
          <pre className="code-lines"><code>
            {visible.map((line, index) => (
              <span className={`code-line is-${line.kind}`} key={`${String(index)}-${line.text.slice(0, 20)}`}>
                <span className="code-line-number">{line.number ?? ""}</span>
                <span className="code-line-sign">{line.kind === "add" ? "+" : "-"}</span>
                <span className="code-line-text">{line.text}</span>{"\n"}
              </span>
            ))}
          </code></pre>
        </div>
        {lines.length > visible.length ? <button className="expand-output" onClick={() => setShowAll(true)} type="button">展开全部 {lines.length} 行</button> : null}
      </div>
    </section>
  );
}

function WebSearchLog({ view, tool, onOpenExternal }: { view: WebSearchView; tool: TimelineTool; onOpenExternal(url: string): void }): React.JSX.Element {
  const running = tool.status === "running" || tool.status === "waiting";
  const statusText = [...tool.updates].reverse().find((update) => update.text)?.text;
  return (
    <section className="web-search-log">
      <header className="web-search-meta">
        <span className="web-search-query" title={view.query}><Icon name="search" size={12} /><span>{view.query}</span></span>
        {view.providerLabel ? <span className="web-search-provider">{view.providerLabel}</span> : null}
        {running ? (
          <span className="running-label"><span className="mini-spinner" />{statusText ?? "正在搜索网页…"}</span>
        ) : tool.status === "success" ? (
          <span className="web-search-count">{String(view.results.length)} 条结果</span>
        ) : null}
      </header>
      {view.results.length ? (
        <ol className="web-search-results">
          {view.results.map((result) => (
            <li key={result.url}>
              <button className="web-search-result" onClick={() => onOpenExternal(result.url)} title={`在浏览器中打开 ${result.url}`} type="button">
                <ResultFavicon key={result.url} result={result} />
                <span className="web-search-result-main">
                  <span className="web-search-result-heading">
                    <span className="web-search-result-title">{result.title}</span>
                    <span className="web-search-result-domain">{result.domain}</span>
                  </span>
                  {result.snippet ? <span className="web-search-result-snippet">{result.snippet}</span> : null}
                </span>
                <span className="web-search-result-open"><Icon name="external" size={13} /></span>
              </button>
            </li>
          ))}
        </ol>
      ) : tool.status === "success" ? (
        <div className="empty-output">没有找到搜索结果</div>
      ) : null}
    </section>
  );
}

function ResultFavicon({ result }: { result: WebSearchResultView }): React.JSX.Element {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const src = result.faviconCandidates[candidateIndex];
  if (!src) return <span aria-hidden="true" className="web-search-favicon is-fallback">{result.fallbackLetter}</span>;
  return <img alt="" className="web-search-favicon" loading="lazy" onError={() => setCandidateIndex(candidateIndex + 1)} src={src} />;
}

interface DiffInfo {
  files: Array<{ path: string; status: "added" | "deleted" | "modified" | "renamed" }>;
  additions: number;
  deletions: number;
}

function DiffView({ diff, info, onPreviewFile }: { diff: string; info: DiffInfo; onPreviewFile(path: string): void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = diffLines(diff);
  const visibleLines = showAll ? lines : lines.slice(0, 500);
  return (
    <section className="tool-output-surface diff-surface">
      <header className="tool-output-header diff-header">
        <div className="diff-paths" title={info.files.map((file) => file.path).join(", ")}>
          {info.files.length ? info.files.map((file, index) => (
            <span className="diff-path" key={`${file.status}-${file.path}`}>
              <button onClick={() => onPreviewFile(file.path)} title="在右侧预览" type="button">{file.path}</button>
              {index < info.files.length - 1 ? "," : null}
            </span>
          )) : <span>Diff</span>}
        </div>
        <span className="diff-stats"><span className="diff-add">+{info.additions}</span><span className="diff-delete">-{info.deletions}</span></span>
        <CopyButton label="复制 Diff" value={diff} />
      </header>
      <pre className="diff-code"><code>{visibleLines.map((line, index) => <DiffLine key={`${String(index)}-${line.text.slice(0, 20)}`} line={line} />)}</code></pre>
      {lines.length > visibleLines.length ? <button className="expand-output" onClick={() => setShowAll(true)} type="button">展开全部 {lines.length} 行</button> : null}
    </section>
  );
}

interface DiffLineData {
  text: string;
}

function DiffLine({ line }: { line: DiffLineData }): React.JSX.Element {
  return <span className="diff-line" data-line={diffLineKind(line.text)}>{line.text}{"\n"}</span>;
}

function ToolPayload({ tool, onPreviewFile }: { tool: TimelineTool; onPreviewFile(path: string): void }): React.JSX.Element {
  const progress = tool.updates.filter((update) => update.text).map((update) => update.text).join("\n");
  const display = tool.display;
  if (display?.kind === "file_io") {
    // 操作和路径在折叠行的名称与摘要里已经表达过，这里只补充结果本身；
    // 读文件的内容按扩展名做语法高亮（带行号），和 Alma 的 Read 展示对齐。
    const resultPreview = fileToolResult(tool.result);
    if (!resultPreview?.text && resultPreview?.count === undefined) return <></>;
    const path = display.path ?? tool.path;
    return (
      <section className="tool-section">
        {resultPreview.count !== undefined ? (
          <h4 className="tool-section-label">结果<span className="tool-section-meta">{resultPreview.count}</span></h4>
        ) : null}
        {resultPreview.text ? (
          <CodeView code={resultPreview.text} filePath={path} onPreviewFile={path ? onPreviewFile : undefined} />
        ) : null}
      </section>
    );
  }
  // 通用工具按 DSH 的 IN/OUT 卡片展示：IN = pretty 参数、OUT = 结果（或运行中的进度）。
  const input = friendlyResult(tool.args);
  const output = friendlyResult(tool.result) ?? (progress || undefined);
  if (input === undefined && output === undefined) return <></>;
  return (
    <IoCard
      input={input ?? null}
      output={output ?? null}
      outputError={tool.status === "failed" || tool.status === "denied" || tool.status === "unknown" || tool.status === "cancelled"}
    />
  );
}

function CopyableCodeBlock({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="copyable-code-block">
      <CopyButton className="copy-button" label={label} value={value} />
      <pre className="tool-payload"><code>{value}</code></pre>
    </div>
  );
}

// 运行中的工具没有 durationMs，用事件时间戳实时递增，结束后回落到权威时长（Alma 同款交互）。
function useLiveDuration(tool: TimelineTool): number | undefined {
  const running = tool.durationMs === undefined && (tool.status === "running" || tool.status === "waiting");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  if (tool.durationMs !== undefined) return tool.durationMs;
  if (!running || !tool.timestamp) return undefined;
  const startedAt = Date.parse(tool.timestamp);
  return Number.isNaN(startedAt) ? undefined : Math.max(0, now - startedAt);
}

// 行首状态由工具行的图标芯片与呼吸光环表达，这里只保留摘要派生。

function toolSummary(tool: TimelineTool, command: TimelineCommand | undefined, diff: DiffInfo | undefined, webSearch: WebSearchView | undefined): string {
  if (command?.command) return command.command;
  if (diff) return `${String(diff.files.length)} 个文件，+${String(diff.additions)} -${String(diff.deletions)}`;
  if (webSearch?.query) return tool.status === "success" ? `${webSearch.query} · ${String(webSearch.results.length)} 条结果` : webSearch.query;
  if (tool.path) return tool.path;
  if (tool.display?.kind === "file_io") return tool.display.path ?? tool.display.detail ?? tool.display.operation;
  if (tool.display?.kind === "generic") return tool.display.summary;
  if (tool.description) return tool.description;
  const args = tool.args as Record<string, unknown> | undefined;
  const candidate = args && [args.path, args.query, args.pattern, args.command].find((value) => typeof value === "string");
  return typeof candidate === "string" ? candidate : "";
}

function commandDetails(tool: TimelineTool): TimelineCommand | undefined {
  if (tool.command) return tool.command;
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const inferredCommand = tool.tool === "run_command" ? stringField(args, "command") : undefined;
  if (tool.display?.kind !== "command" && !inferredCommand) return undefined;
  const result = typeof tool.result === "object" && tool.result !== null ? tool.result as Record<string, unknown> : undefined;
  return {
    command: tool.display?.kind === "command" ? tool.display.command : inferredCommand ?? "",
    cwd: tool.display?.kind === "command" ? tool.display.cwd : stringField(args, "cwd"),
    stdout: stringField(result, "stdout") ?? stringField(result, "output") ?? "",
    stderr: stringField(result, "stderr") ?? "",
    exitCode: numberField(result, "exitCode")
  };
}

function analyzeDiff(diff: string): DiffInfo {
  const files: DiffInfo["files"] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match?.[2]) continue;
    const renamed = match[1] !== match[2];
    files.push({ path: match[2], status: renamed ? "renamed" : "modified" });
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const blockStart = diff.indexOf(`diff --git a/${file.path}`);
    const nextStart = diff.indexOf("diff --git ", blockStart + 1);
    const block = diff.slice(blockStart, nextStart < 0 ? undefined : nextStart);
    if (block.includes("new file mode")) file.status = "added";
    if (block.includes("deleted file mode")) file.status = "deleted";
  }
  return { files, additions, deletions };
}

function diffLines(diff: string): DiffLineData[] {
  return diff.split("\n").map((text) => ({ text }));
}

function diffLineKind(text: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (text.startsWith("+") && !text.startsWith("+++")) return "add";
  if (text.startsWith("-") && !text.startsWith("---")) return "del";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("---") || text.startsWith("+++")) return "meta";
  return "ctx";
}

function fileToolResult(value: unknown): { count?: string; text?: string } | undefined {
  if (typeof value !== "object" || value === null) return typeof value === "string" ? { text: value } : undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.matches)) {
    const matches = record.matches;
    const text = matches.slice(0, 200).map((match) => {
      if (typeof match !== "object" || match === null) return String(match);
      const item = match as Record<string, unknown>;
      return [item.path, item.line].filter((part) => typeof part === "string" || typeof part === "number").join(":") + (typeof item.text === "string" ? `  ${item.text}` : "");
    }).join("\n");
    return { count: `${String(matches.length)} 个命中`, text };
  }
  if (Array.isArray(record.files)) {
    return { count: `${String(record.files.length)} 个文件`, text: record.files.slice(0, 300).map(String).join("\n") };
  }
  for (const key of ["content", "output", "message", "summary"]) {
    if (typeof record[key] === "string") return { text: record[key] };
  }
  return undefined;
}

function friendlyResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["output", "content", "message", "summary", "results"]) {
    const field = record[key];
    if (typeof field === "string") return field;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法展示工具结果";
  }
}

function riskLabel(risk: string): string {
  if (risk === "critical") return "关键风险";
  if (risk === "high") return "高风险";
  if (risk === "medium") return "中风险";
  if (risk === "low") return "低风险";
  return "需确认";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${String(Math.floor(durationMs / 60_000))}m${String(Math.round((durationMs % 60_000) / 1_000))}s`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}
