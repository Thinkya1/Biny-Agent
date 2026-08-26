/**
 * 消息正文的 Markdown 渲染。
 *
 * 助手回复、思考内容和用户消息共用这一套：链接按本地路径 / 外链分流，代码块带语言标签和高亮，
 * 图片和 `@attachments/` 附件走主进程转 data URL 内联显示。
 *
 * 渲染的是模型输出，一切外部内容都当不可信处理：只有经 highlight.js 转义过的高亮结果会用
 * `dangerouslySetInnerHTML`，其余节点都交给 React 转义。
 */
import React, { isValidElement, memo, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useInlineImage } from "../inlineImage.js";
import { highlightFencedCode } from "../syntaxHighlight.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";

interface MarkdownContentProps {
  content: string;
  projectId: string;
  /** 附加到根节点的修饰类，例如思考内容用的 `is-compact`。 */
  variant?: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  projectId,
  variant,
  onPreviewFile,
  onOpenExternal
}: MarkdownContentProps): React.JSX.Element {
  return (
    <div className={variant ? `markdown-body ${variant}` : "markdown-body"}>
      <Markdown
        components={{
          a({ node: _node, children, ...props }) {
            const href = props.href;
            const path = localPathFromHref(href);
            // 主进程 deny 了所有新窗口导航，外链必须显式走 openExternal；
            // 页内锚点（如脚注）保留默认跳转，不能带 target=_blank 否则点击被吞。
            const externalUrl = !path && href && /^https?:\/\//i.test(href) ? href : undefined;
            const isAnchor = !path && !externalUrl && Boolean(href?.startsWith("#"));
            const onClick = path
              ? (event: React.MouseEvent) => { event.preventDefault(); onPreviewFile(path); }
              : externalUrl
                ? (event: React.MouseEvent) => { event.preventDefault(); onOpenExternal(externalUrl); }
                : undefined;
            return <a {...props} onClick={onClick} rel="noreferrer" target={path || isAnchor ? undefined : "_blank"} title={path ? "在右侧预览" : externalUrl ? "在浏览器中打开" : undefined}>{children}</a>;
          },
          code({ className, children }) {
            // 围栏代码块由下面的 pre 接管，这里只剩行内代码。
            if (className) return <code className={className}>{children}</code>;
            // Codex 风格的行内路径只是灰色代码标记；不根据文本外观暗中添加文件跳转。
            return <code>{children}</code>;
          },
          img({ alt, src, title }) {
            const source = typeof src === "string" ? src : undefined;
            const path = localPathFromHref(source);
            if (path) return <InlineImage alt={alt ?? ""} path={path} projectId={projectId} />;
            if (!source) return null;
            return <img alt={alt ?? ""} className="markdown-image" src={source} title={title} />;
          },
          pre({ children }) {
            const block = fencedCode(children);
            return <MarkdownCodeBlock code={block.code} language={block.language} />;
          },
          table({ children }) {
            // 宽表格自己横向滚动，不能把整条消息撑宽。
            return <div className="markdown-table"><table>{children}</table></div>;
          }
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </Markdown>
    </div>
  );
});

function MarkdownCodeBlock({ code, language }: { code: string; language?: string }): React.JSX.Element {
  const highlighted = useMemo(() => highlightFencedCode(code, language), [code, language]);
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-language">{language ?? "文本"}</span>
        <CopyButton className="markdown-code-copy" label="复制代码" showLabel value={code} />
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </div>
  );
}

/** 图片没读到（不是图片、太大、路径不存在）时退回成一行文件名，不留一块空白。 */
function InlineImage({ alt, path, projectId }: { alt: string; path: string; projectId: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const source = useInlineImage(projectId, path);
  if (!source) return <span className="markdown-image-fallback"><Icon name="file" size={12} /><span>{alt || path}</span></span>;
  return (
    <img
      alt={alt}
      className={expanded ? "markdown-image is-expanded" : "markdown-image"}
      onClick={() => setExpanded(!expanded)}
      src={source}
      title={expanded ? "点击收起" : "点击放大"}
    />
  );
}

/** 从 `pre` 的子节点里取回围栏代码块的原文和语言标注。 */
function fencedCode(children: React.ReactNode): { code: string; language?: string } {
  const element = (Array.isArray(children) ? children : [children])
    .find((child): child is React.ReactElement<{ className?: string; children?: React.ReactNode }> => isValidElement(child));
  const language = /language-([\w+#.-]+)/.exec(element?.props.className ?? "")?.[1];
  return { code: extractText(element ? element.props.children : children).replace(/\n$/, ""), language };
}

function localPathFromHref(href?: string): string | undefined {
  if (!href || href.startsWith("#") || (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href) && !href.startsWith("file://"))) return undefined;
  const isFileUrl = href.startsWith("file://");
  const encoded = isFileUrl ? href.slice("file://".length) : href;
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // Keep malformed local paths usable instead of breaking the whole message.
  }
  // file:// 已明确表达本地路径意图；路径可以含空格，不再套 looksLikePath 启发式。
  if (isFileUrl) return stripLineSuffix(decoded);
  return looksLikePath(decoded) ? stripLineSuffix(decoded) : undefined;
}

function stripLineSuffix(path: string): string {
  return path.replace(/(?::\d+){1,2}$/, "");
}

function looksLikePath(value: string): boolean {
  return !value.includes(" ") && (/^(?:\.\/|\.\.\/|\/|[\w.-]+\/)/.test(value) || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(value));
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}
