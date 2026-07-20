import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
    Children,
    isValidElement,
    memo,
    type AnchorHTMLAttributes,
    type CSSProperties,
    type HTMLAttributes,
    type ImgHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type TableHTMLAttributes,
    type TdHTMLAttributes,
    type ThHTMLAttributes,
    useMemo,
    useRef,
} from "react";

import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import { useTextContextMenu } from "@renderer/components/context-menu/useTextContextMenu";
import {
    MarkdownMermaidDiagram,
    type MermaidViewportStateSnapshot,
} from "./MarkdownMermaidDiagram";

import { MarkdownCodeFrame } from "./MarkdownCodeFrame";

interface MarkdownFilePreviewProps {
    readonly content: string;
    readonly filePath: string;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly mermaidViewportStateCache?: Map<
        string,
        MermaidViewportStateSnapshot
    >;
    readonly tabId?: string;
}

function getSafeExternalHref(href: string | null | undefined): string | null {
    const normalizedHref = href?.trim();
    if (!normalizedHref) {
        return null;
    }

    let parsedHref: URL;
    try {
        parsedHref = new URL(normalizedHref);
    } catch {
        return null;
    }

    if (
        (parsedHref.protocol === "http:" || parsedHref.protocol === "https:") &&
        parsedHref.hostname
    ) {
        return normalizedHref;
    }

    return null;
}

function extractMarkdownCodeLanguage(
    className: string | null | undefined,
): string | null {
    const languageClass = className
        ?.split(/\s+/)
        .find((entry) => entry.startsWith("language-"));
    const language = languageClass?.slice("language-".length).trim();
    return language || null;
}

function getMarkdownCodeLanguageFromNode(node: ReactNode): string | null {
    if (Array.isArray(node)) {
        for (const child of Children.toArray(node)) {
            const language = getMarkdownCodeLanguageFromNode(child);
            if (language) {
                return language;
            }
        }
        return null;
    }

    if (!isValidElement(node)) {
        return null;
    }

    const props = node.props as {
        readonly className?: unknown;
        readonly "data-language"?: unknown;
    };

    if (typeof props["data-language"] === "string") {
        return props["data-language"];
    }
    if (typeof props.className === "string") {
        return extractMarkdownCodeLanguage(props.className);
    }

    return null;
}

function getMarkdownCodeTextFromNode(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }

    if (Array.isArray(node)) {
        const children = Children.toArray(node);
        const codeChild = children.find(
            (child) => isValidElement(child) && child.type === "code",
        );
        if (codeChild) {
            return getMarkdownCodeTextFromNode(codeChild);
        }

        return children.map(getMarkdownCodeTextFromNode).join("");
    }

    if (!isValidElement(node)) {
        return "";
    }

    const props = node.props as {
        readonly children?: ReactNode;
        readonly text?: unknown;
    };

    if (typeof props.text === "string") {
        return props.text;
    }

    return getMarkdownCodeTextFromNode(props.children);
}

function reactNodeToText(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }

    if (Array.isArray(node)) {
        return node.map(reactNodeToText).join("");
    }

    return "";
}

interface MarkdownAstNode {
    children?: MarkdownAstNode[];
    tagName?: string;
    type?: string;
}

function removeRawHtmlNodes(node: MarkdownAstNode): void {
    if (!node.children) {
        return;
    }

    node.children = node.children.filter((child) => child.type !== "html");
    for (const child of node.children) {
        removeRawHtmlNodes(child);
    }
}

function remarkStripRawHtml() {
    return (tree: MarkdownAstNode) => {
        removeRawHtmlNodes(tree);
    };
}

const markdownPreviewComponents: Components = {
    a: MarkdownPreviewLink,
    code: MarkdownPreviewCode,
    img: BlockedMarkdownPreviewImage,
    input: MarkdownPreviewInput,
    pre: MarkdownPreviewPre,
    table: MarkdownPreviewTable,
    td: MarkdownPreviewTableCell,
    th: MarkdownPreviewTableHeader,
};

const markdownPreviewTextContextMenuLabels = {
    copyFallback: "Copy Markdown",
} as const;

const markdownRemarkPlugins = [remarkGfm, remarkStripRawHtml];
const markdownRehypePlugins = [rehypeSanitize];

function MarkdownPreviewLink({
    children,
    href,
    node: _node,
    ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly node?: unknown }) {
    void _node;

    const safeHref = getSafeExternalHref(href);

    return (
        <a
            {...props}
            href={safeHref ?? undefined}
            onClick={(event) => {
                event.preventDefault();
                if (safeHref) {
                    openExternalUrl(safeHref);
                }
            }}
            rel="noreferrer noopener"
            target="_blank"
        >
            {children}
        </a>
    );
}

function MarkdownPreviewCode({
    children,
    className,
    node: _node,
    ...props
}: {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly node?: unknown;
}) {
    void _node;

    const language = extractMarkdownCodeLanguage(className);
    const languageSupport = useMarkdownCodeLanguageSupport(language);
    const text = reactNodeToText(children).replace(/\n$/, "");

    return (
        <code
            className={className}
            data-language={language ?? undefined}
            {...props}
        >
            {language ? (
                <HighlightedCodeText
                    language={languageSupport}
                    segmentKeyPrefix={`markdown-file-preview:${language}`}
                    text={text}
                />
            ) : (
                children
            )}
        </code>
    );
}

function BlockedMarkdownPreviewImage({
    alt,
    node: _node,
}: ImgHTMLAttributes<HTMLImageElement> & { readonly node?: unknown }) {
    void _node;

    return (
        <span
            aria-label={alt || "Image blocked in Markdown preview"}
            className="markdown-file-preview__blocked-image"
            role="img"
        />
    );
}

function MarkdownPreviewInput({
    className,
    node: _node,
    ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly node?: unknown }) {
    void _node;

    return (
        <input
            {...props}
            className={["markdown-file-preview__checkbox", className]
                .filter(Boolean)
                .join(" ")}
            readOnly
        />
    );
}

function createMermaidViewportStateKey({
    source,
    startOffset,
    tabId,
}: {
    readonly source: string;
    readonly startOffset: number | null;
    readonly tabId: string;
}): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < source.length; index += 1) {
        hash = Math.imul(hash ^ source.charCodeAt(index), 16_777_619);
    }

    return `${tabId}:${startOffset ?? "unknown"}:${(hash >>> 0).toString(36)}`;
}

function getMarkdownNodeStartOffset(node: unknown): number | null {
    if (!node || typeof node !== "object") {
        return null;
    }

    const position = (node as {
        readonly position?: { readonly start?: { readonly offset?: unknown } };
    }).position;
    const offset = position?.start?.offset;

    return typeof offset === "number" ? offset : null;
}

function MarkdownPreviewPre({
    children,
    className,
    mermaidViewportStateCache,
    node,
    tabId,
    ...props
}: HTMLAttributes<HTMLPreElement> & {
    readonly mermaidViewportStateCache?: Map<
        string,
        MermaidViewportStateSnapshot
    >;
    readonly node?: unknown;
    readonly tabId?: string;
}) {

    const codeBlockClassName = ["markdown-code-block", className]
        .filter(Boolean)
        .join(" ");
    const language = getMarkdownCodeLanguageFromNode(children);
    const codeText = getMarkdownCodeTextFromNode(children).replace(/\n\s*$/, "");
    const codeBlock = (
        <pre className={codeBlockClassName} {...props}>
            {children}
        </pre>
    );

    if (!language) {
        return codeBlock;
    }

    if (language.toLowerCase() === "mermaid") {
        const viewportStateKey = tabId
            ? createMermaidViewportStateKey({
                  source: codeText,
                  startOffset: getMarkdownNodeStartOffset(node),
                  tabId,
              })
            : null;

        return (
            <MarkdownMermaidDiagram
                onViewportStateChange={
                    viewportStateKey && mermaidViewportStateCache
                        ? (state) => {
                              mermaidViewportStateCache.set(viewportStateKey, state);
                          }
                        : undefined
                }
                source={codeText}
                viewportState={
                    viewportStateKey
                        ? mermaidViewportStateCache?.get(viewportStateKey)
                        : undefined
                }
            />
        );
    }

    return (
        <MarkdownCodeFrame codeText={codeText} language={language}>
            {codeBlock}
        </MarkdownCodeFrame>
    );
}

function createMarkdownPreviewComponents({
    mermaidViewportStateCache,
    tabId,
}: {
    readonly mermaidViewportStateCache?: Map<
        string,
        MermaidViewportStateSnapshot
    >;
    readonly tabId?: string;
}): Components {
    return {
        ...markdownPreviewComponents,
        pre: (props) => (
            <MarkdownPreviewPre
                {...props}
                mermaidViewportStateCache={mermaidViewportStateCache}
                tabId={tabId}
            />
        ),
    };
}

const MARKDOWN_TABLE_FIT_COLUMN_LIMIT = 8;

function getMarkdownTableColumnCount(node: unknown): number {
    if (!node || typeof node !== "object") {
        return 0;
    }

    const tableNode = node as MarkdownAstNode;
    const header = tableNode.children?.find(
        (child) => child.tagName === "thead",
    );
    const headerRow = header?.children?.find(
        (child) => child.tagName === "tr",
    );

    return (
        headerRow?.children?.filter((child) => child.tagName === "th")
            .length ?? 0
    );
}

function MarkdownPreviewTable({
    children,
    node,
    ...props
}: TableHTMLAttributes<HTMLTableElement> & { readonly node?: unknown }) {
    const columnCount = getMarkdownTableColumnCount(node);
    const shouldEnableWideTableScroll =
        columnCount > MARKDOWN_TABLE_FIT_COLUMN_LIMIT;
    const tableWrapClassName = [
        "markdown-file-preview__table-wrap",
        shouldEnableWideTableScroll &&
            "markdown-file-preview__table-wrap--wide",
    ]
        .filter(Boolean)
        .join(" ");
    const tableWrapStyle = shouldEnableWideTableScroll
        ? ({
              // Reserve a readable width per column before falling back to scroll.
              "--markdown-file-preview-table-columns": columnCount,
          } as CSSProperties)
        : undefined;

    return (
        <div className={tableWrapClassName} style={tableWrapStyle}>
            <table {...props}>{children}</table>
        </div>
    );
}

function MarkdownPreviewTableHeader({
    children,
    node: _node,
    ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { readonly node?: unknown }) {
    void _node;

    return <th {...props}>{children}</th>;
}

function MarkdownPreviewTableCell({
    children,
    node: _node,
    ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { readonly node?: unknown }) {
    void _node;

    return <td {...props}>{children}</td>;
}

export const MarkdownFilePreview = memo(function MarkdownFilePreview({
    content,
    filePath,
    fontFamily,
    fontSize,
    mermaidViewportStateCache,
    tabId,
}: MarkdownFilePreviewProps) {
    const previewRef = useRef<HTMLDivElement | null>(null);
    const { contextMenu, handleContextMenu } =
        useTextContextMenu<HTMLDivElement>({
            containerRef: previewRef,
            getFallbackCopyText: () => content,
            labels: markdownPreviewTextContextMenuLabels,
        });
    const renderedMarkdown = useMemo(
        () => (
            <ReactMarkdown
                components={createMarkdownPreviewComponents({
                    mermaidViewportStateCache,
                    tabId,
                })}
                rehypePlugins={markdownRehypePlugins}
                remarkPlugins={markdownRemarkPlugins}
                skipHtml
            >
                {content}
            </ReactMarkdown>
        ),
        [content, mermaidViewportStateCache, tabId],
    );

    return (
        <div
            className="markdown-file-preview"
            data-file-path={filePath}
            onContextMenu={handleContextMenu}
            ref={previewRef}
            style={{ fontFamily, fontSize }}
        >
            {renderedMarkdown}
            {contextMenu}
        </div>
    );
});
