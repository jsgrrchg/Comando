import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
    Children,
    isValidElement,
    memo,
    type AnchorHTMLAttributes,
    type HTMLAttributes,
    type ImgHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type TableHTMLAttributes,
    type TdHTMLAttributes,
    type ThHTMLAttributes,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { HighlightedCodeText } from "@renderer/app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "@renderer/app/editor/useCodeLanguageSupport";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import { useTextContextMenu } from "@renderer/components/context-menu/useTextContextMenu";
import { MarkdownMermaidDiagram } from "./MarkdownMermaidDiagram";

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

async function writeMarkdownPreviewClipboardText(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        try {
            await window.comando.writeClipboardText(text);
            return;
        } catch {
            // Fall through to the Web Clipboard API when the native bridge is unavailable.
        }
    }

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Copy actions should stay quiet if clipboard access is denied.
        }
    }
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

const markdownCodeLanguageLabels: Record<string, string> = {
    bash: "Bash",
    c: "C",
    "c++": "C++",
    cpp: "C++",
    cs: "C#",
    csharp: "C#",
    css: "CSS",
    diff: "Diff",
    docker: "Dockerfile",
    dockerfile: "Dockerfile",
    gql: "GraphQL",
    graphql: "GraphQL",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsonc: "JSONC",
    jsx: "JSX",
    make: "Makefile",
    makefile: "Makefile",
    markdown: "Markdown",
    md: "Markdown",
    mdx: "MDX",
    php: "PHP",
    powershell: "PowerShell",
    ps1: "PowerShell",
    pwsh: "PowerShell",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    rs: "Rust",
    ruby: "Ruby",
    rust: "Rust",
    scss: "SCSS",
    sh: "Shell",
    shell: "Shell",
    sql: "SQL",
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zsh: "Zsh",
};

function formatMarkdownCodeLanguageLabel(language: string): string {
    const normalizedLanguage = language.trim().toLowerCase();
    const mappedLabel = markdownCodeLanguageLabels[normalizedLanguage];
    if (mappedLabel) {
        return mappedLabel;
    }

    return normalizedLanguage
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
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

function MarkdownPreviewCopyIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            viewBox="0 0 14 14"
            width="12"
        >
            <rect x="5" y="3" width="6" height="8" rx="1.2" />
            <path d="M3.5 9.5H3A1 1 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2H8" />
        </svg>
    );
}

function MarkdownPreviewCheckIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 14 14"
            width="12"
        >
            <path d="M3 7l2.2 2.2L11 3.8" />
        </svg>
    );
}

function MarkdownPreviewCodeCopyButton({
    codeText,
}: {
    readonly codeText: string;
}) {
    const [copied, setCopied] = useState(false);
    const resetTimeoutRef = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (resetTimeoutRef.current) {
                window.clearTimeout(resetTimeoutRef.current);
            }
        },
        [],
    );

    const handleCopy = useCallback(() => {
        void writeMarkdownPreviewClipboardText(codeText).then(() => {
            setCopied(true);
            if (resetTimeoutRef.current) {
                window.clearTimeout(resetTimeoutRef.current);
            }
            resetTimeoutRef.current = window.setTimeout(() => {
                setCopied(false);
                resetTimeoutRef.current = null;
            }, 1200);
        });
    }, [codeText]);

    return (
        <button
            aria-label="Copy code block"
            className="markdown-file-preview__copy-button"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy"}
            type="button"
        >
            {copied ? (
                <MarkdownPreviewCheckIcon />
            ) : (
                <MarkdownPreviewCopyIcon />
            )}
        </button>
    );
}

function MarkdownPreviewPre({
    children,
    className,
    node: _node,
    ...props
}: HTMLAttributes<HTMLPreElement> & { readonly node?: unknown }) {
    void _node;

    const codeBlockClassName = [
        "markdown-file-preview__code-block",
        className,
    ]
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
        return <MarkdownMermaidDiagram source={codeText} />;
    }

    return (
        <div className="markdown-file-preview__code-frame">
            <div className="markdown-file-preview__code-header">
                <span>{formatMarkdownCodeLanguageLabel(language)}</span>
                <MarkdownPreviewCodeCopyButton codeText={codeText} />
            </div>
            {codeBlock}
        </div>
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
                components={markdownPreviewComponents}
                rehypePlugins={markdownRehypePlugins}
                remarkPlugins={markdownRemarkPlugins}
                skipHtml
            >
                {content}
            </ReactMarkdown>
        ),
        [content],
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
