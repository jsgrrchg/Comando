import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
    memo,
    type AnchorHTMLAttributes,
    type ImgHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type TableHTMLAttributes,
    type TdHTMLAttributes,
    type ThHTMLAttributes,
    useMemo,
} from "react";

import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import { openExternalUrl } from "@renderer/app/utils/external-url";

interface MarkdownFilePreviewProps {
    readonly content: string;
    readonly filePath: string;
    readonly fontFamily: string;
    readonly fontSize: number;
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
    type?: string;
}

const rawHtmlTagPattern =
    /<\/?(?:a|abbr|address|article|aside|audio|b|blockquote|br|button|canvas|caption|cite|code|col|colgroup|data|details|dialog|div|dl|dt|dd|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|li|link|main|mark|menu|meta|nav|object|ol|option|p|picture|pre|progress|q|script|section|select|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|u|ul|video)\b[^>]*>/gi;

function stripRawHtmlFromMarkdownSource(source: string): string {
    let isInsideFence = false;
    let fenceMarker: "`" | "~" | null = null;
    let isInsideRawHtmlBlock: "script" | "style" | null = null;

    return source
        .split("\n")
        .map((line) => {
            const fenceMatch = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
            if (fenceMatch) {
                const marker = fenceMatch[1]?.[0];
                if (!isInsideFence && (marker === "`" || marker === "~")) {
                    isInsideFence = true;
                    fenceMarker = marker;
                } else if (isInsideFence && marker === fenceMarker) {
                    isInsideFence = false;
                    fenceMarker = null;
                }
                return line;
            }

            if (isInsideFence) {
                return line;
            }

            let nextLine = line;
            if (isInsideRawHtmlBlock) {
                const closingPattern = new RegExp(
                    `.*?<\\/${isInsideRawHtmlBlock}>`,
                    "i",
                );
                if (!closingPattern.test(nextLine)) {
                    return "";
                }
                nextLine = nextLine.replace(closingPattern, "");
                isInsideRawHtmlBlock = null;
            }

            nextLine = nextLine.replace(
                /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
                "",
            );

            const rawBlockStart = nextLine.match(/<(script|style)\b[^>]*>/i);
            if (rawBlockStart) {
                isInsideRawHtmlBlock =
                    rawBlockStart[1]?.toLowerCase() === "style"
                        ? "style"
                        : "script";
                nextLine = nextLine.slice(0, rawBlockStart.index);
            }

            return nextLine.replace(rawHtmlTagPattern, "");
        })
        .join("\n");
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

function MarkdownPreviewPre({
    children,
    node: _node,
    ...props
}: {
    readonly children?: ReactNode;
    readonly node?: unknown;
}) {
    void _node;

    return (
        <pre className="markdown-file-preview__code-block" {...props}>
            {children}
        </pre>
    );
}

function MarkdownPreviewTable({
    children,
    node: _node,
    ...props
}: TableHTMLAttributes<HTMLTableElement> & { readonly node?: unknown }) {
    void _node;

    return (
        <div className="markdown-file-preview__table-wrap">
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
}: MarkdownFilePreviewProps) {
    const sanitizedContent = useMemo(
        () => stripRawHtmlFromMarkdownSource(content),
        [content],
    );
    const renderedMarkdown = useMemo(
        () => (
            <ReactMarkdown
                components={markdownPreviewComponents}
                rehypePlugins={markdownRehypePlugins}
                remarkPlugins={markdownRemarkPlugins}
                skipHtml
            >
                {sanitizedContent}
            </ReactMarkdown>
        ),
        [sanitizedContent],
    );

    return (
        <div
            className="markdown-file-preview"
            data-file-path={filePath}
            style={{ fontFamily, fontSize }}
        >
            {renderedMarkdown}
        </div>
    );
});
