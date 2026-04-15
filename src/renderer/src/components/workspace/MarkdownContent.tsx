import { memo, useCallback, useMemo, useState, type ReactElement } from "react";

import { extractFenceLanguageToken } from "../../app/editor/codeLanguage";
import { HighlightedCodeText } from "../../app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "../../app/editor/useCodeLanguageSupport";
import { DiffLineView } from "./review/DiffLineView";
import {
    DIFF_PANEL_MAX_HEIGHT,
    computeUnifiedDiffLines,
} from "./review/reviewDiff";
import {
    getChatCodeBlockFontSize,
    getChatCodeLabelFontSize,
} from "./chat/chatCodeSizing";
import { ChatInlinePill } from "./chat/ChatInlinePill";
import { getChatPillMetrics } from "./chat/chatPillMetrics";

interface MarkdownContentProps {
    readonly content: string;
    readonly chatFontSize?: number;
    readonly chatFontFamily?: string;
    readonly onOpenFile?: (path: string) => void;
}

interface Block {
    readonly content: string;
    readonly info: string;
    readonly type: "code" | "text";
}

const BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/* ─── Table parsing ─── */

interface ParsedTable {
    readonly headers: string[];
    readonly rows: string[][];
}

function tryParseTable(lines: string[]): ParsedTable | null {
    if (lines.length < 2) return null;
    const headerLine = lines[0];
    const separatorLine = lines[1];
    if (!headerLine || !separatorLine) return null;

    if (!headerLine.includes("|") || !/^\|?[\s-:|]+\|?$/.test(separatorLine)) {
        return null;
    }

    const parseRow = (line: string) =>
        line
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());

    const headers = parseRow(headerLine);
    const rows: string[][] = [];

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.includes("|")) break;
        rows.push(parseRow(line));
    }

    if (rows.length === 0) return null;
    return { headers, rows };
}

/* ─── Block parsing ─── */

const PARSED_BLOCK_CACHE_LIMIT = 250;
const parsedBlockCache = new Map<string, Block[]>();

function rememberParsedBlocks(text: string, blocks: Block[]): Block[] {
    if (parsedBlockCache.has(text)) {
        parsedBlockCache.delete(text);
    }
    parsedBlockCache.set(text, blocks);
    if (parsedBlockCache.size > PARSED_BLOCK_CACHE_LIMIT) {
        const oldestKey = parsedBlockCache.keys().next().value;
        if (oldestKey !== undefined) {
            parsedBlockCache.delete(oldestKey);
        }
    }
    return blocks;
}

function parseBlocks(text: string): Block[] {
    const cached = parsedBlockCache.get(text);
    if (cached) return cached;
    const blocks: Block[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(BLOCK_RE)) {
        const before = text.slice(lastIndex, match.index);
        if (before) {
            blocks.push({ content: before, info: "", type: "text" });
        }
        blocks.push({
            content: (match[2] ?? "").replace(/\n$/, ""),
            info: (match[1] ?? "").trim().toLowerCase(),
            type: "code",
        });
        lastIndex = (match.index ?? 0) + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        blocks.push({ content: tail, info: "", type: "text" });
    }

    return rememberParsedBlocks(text, blocks);
}

/* ─── File path detection ─── */

const FILE_PATH_RE =
    /^(?:\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|rb|java|c|cpp|h|css|scss|html|json|yaml|yml|toml|md|txt|sql|sh|zsh|bash|swift|kt|vue|svelte))$/;

function looksLikeFilePath(text: string): boolean {
    return FILE_PATH_RE.test(text);
}

/* ─── Inline rendering ─── */

interface InlineOptions {
    readonly metrics?: ReturnType<typeof getChatPillMetrics>;
    readonly onOpenFile?: (path: string) => void;
}

function renderInline(
    text: string,
    options?: InlineOptions,
): Array<ReactElement | string> {
    const parts: Array<ReactElement | string> = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    let key = 0;

    for (const match of text.matchAll(re)) {
        const before = text.slice(lastIndex, match.index);
        if (before) parts.push(before);

        if (match[1]) {
            const codeText = match[1].slice(1, -1);
            if (
                options?.onOpenFile &&
                options.metrics &&
                looksLikeFilePath(codeText)
            ) {
                parts.push(
                    <ChatInlinePill
                        key={key++}
                        interactive
                        label={codeText}
                        metrics={options.metrics}
                        onClick={() => options.onOpenFile!(codeText)}
                        variant="file"
                    />,
                );
            } else {
                parts.push(
                    <code
                        key={key++}
                        style={{
                            backgroundColor: "var(--color-bg-tertiary)",
                            borderRadius: 4,
                            color: "var(--color-accent)",
                            fontSize: "0.85em",
                            padding: "1px 5px",
                        }}
                    >
                        {codeText}
                    </code>,
                );
            }
        } else if (match[2]) {
            parts.push(
                <strong
                    key={key++}
                    style={{ color: "var(--color-text-primary)" }}
                >
                    {match[2].slice(2, -2)}
                </strong>,
            );
        } else if (match[3]) {
            parts.push(<em key={key++}>{match[3].slice(1, -1)}</em>);
        } else if (match[4]) {
            const linkMatch = match[4].match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (linkMatch) {
                parts.push(
                    <a
                        key={key++}
                        href={linkMatch[2]}
                        rel="noopener noreferrer"
                        style={{ color: "var(--color-accent)" }}
                        target="_blank"
                    >
                        {linkMatch[1]}
                    </a>,
                );
            }
        }
        lastIndex = (match.index ?? 0) + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (tail) parts.push(tail);

    return parts;
}

/* ─── Copy button SVG icons ─── */

function CopyIcon() {
    return (
        <svg
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="11"
        >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="11"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

/* ─── Code block ─── */

function CodeBlock({
    block,
    chatFontSize = 14,
}: {
    readonly block: Block;
    readonly chatFontSize?: number;
}) {
    const [copied, setCopied] = useState(false);
    const languageSupport = useMarkdownCodeLanguageSupport(block.info);
    const languageToken = extractFenceLanguageToken(block.info ?? "");
    const isDiffBlock =
        languageToken?.toLowerCase() === "diff" ||
        languageToken?.toLowerCase() === "patch";
    const diffLines = useMemo(
        () => (isDiffBlock ? computeUnifiedDiffLines(block.content) : []),
        [block.content, isDiffBlock],
    );
    const codeFontSize = getChatCodeBlockFontSize(chatFontSize);
    const languageLabel =
        languageToken?.toLowerCase() === "md"
            ? "Markdown"
            : (languageToken ?? block.info?.trim());

    const handleCopy = useCallback(() => {
        void navigator.clipboard.writeText(block.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    }, [block.content]);

    const copyButton = (
        <button
            aria-label="Copy code block"
            onClick={handleCopy}
            onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.backgroundColor =
                    "var(--color-bg-secondary)";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.9";
                e.currentTarget.style.backgroundColor =
                    "color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)";
            }}
            title={copied ? "Copied" : "Copy"}
            style={{
                alignItems: "center",
                background:
                    "color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                color: copied
                    ? "var(--color-accent)"
                    : "var(--color-text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                height: 22,
                justifyContent: "center",
                opacity: 0.9,
                transition: "opacity 100ms ease, background-color 100ms ease",
                width: 22,
            }}
            type="button"
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
    );

    return (
        <div
            className="group relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
            }}
        >
            {languageLabel ? (
                <div
                    className="flex items-center justify-between px-3 py-2 pr-10"
                    style={{
                        borderBottom: "1px solid var(--color-border)",
                        color: "var(--color-text-secondary)",
                        fontSize: getChatCodeLabelFontSize(chatFontSize),
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                    }}
                >
                    <span>{languageLabel}</span>
                </div>
            ) : null}
            <div
                className="absolute right-2"
                style={{ top: languageLabel ? 5 : 8 }}
            >
                {copyButton}
            </div>
            <pre
                className="overflow-x-auto p-3"
                style={{
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: codeFontSize,
                    lineHeight: 1.6,
                    margin: 0,
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {isDiffBlock && diffLines.length > 0 ? (
                    <div
                        data-testid="markdown-diff-block"
                        style={{
                            color: "var(--color-text-primary)",
                            display: "flex",
                            flexDirection: "column",
                            maxHeight: DIFF_PANEL_MAX_HEIGHT,
                            minWidth: 0,
                            overflow: "auto",
                        }}
                    >
                        {diffLines.map((line, index) => (
                            <DiffLineView
                                compactLineNumbers={false}
                                key={`markdown-diff:${index}:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${line.type}`}
                                line={line}
                                lineWrapping
                            />
                        ))}
                    </div>
                ) : (
                    <code
                        style={{
                            color: "var(--color-text-primary)",
                            whiteSpace: "inherit",
                            overflowWrap: "inherit",
                            wordBreak: "inherit",
                        }}
                    >
                        <HighlightedCodeText
                            text={block.content}
                            language={languageSupport}
                            segmentKeyPrefix={`chat-code:${languageToken ?? "plain"}:${block.content.length}`}
                        />
                    </code>
                )}
            </pre>
        </div>
    );
}

/* ─── Table block ─── */

function TableBlock({ table }: { readonly table: ParsedTable }) {
    return (
        <div className="my-2 max-w-full overflow-x-auto">
            <table
                style={{
                    borderCollapse: "collapse",
                    fontSize: "1em",
                    tableLayout: "fixed",
                    width: "100%",
                }}
            >
                <thead>
                    <tr>
                        {table.headers.map((header, i) => (
                            <th
                                key={i}
                                style={{
                                    background:
                                        "color-mix(in srgb, var(--color-bg-tertiary) 78%, transparent)",
                                    borderBottom:
                                        "1px solid var(--color-border)",
                                    color: "var(--color-text-primary)",
                                    overflowWrap: "anywhere",
                                    padding: "8px 10px",
                                    textAlign: "left",
                                    verticalAlign: "top",
                                    wordBreak: "break-word",
                                }}
                            >
                                {renderInline(header)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row, ri) => (
                        <tr key={ri}>
                            {row.map((cell, ci) => (
                                <td
                                    key={ci}
                                    style={{
                                        borderBottom:
                                            ri < table.rows.length - 1
                                                ? "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)"
                                                : undefined,
                                        color: "var(--color-text-secondary)",
                                        overflowWrap: "anywhere",
                                        padding: "8px 10px",
                                        verticalAlign: "top",
                                        wordBreak: "break-word",
                                    }}
                                >
                                    {renderInline(cell)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/* ─── Text block ─── */

function TextBlock({
    block,
    inlineOptions,
}: {
    readonly block: Block;
    readonly inlineOptions?: InlineOptions;
}) {
    const lines = block.content.split("\n");
    const elements: ReactElement[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i] ?? "";
        const trimmed = line.trimStart();

        if (!trimmed) {
            elements.push(<div key={i} style={{ height: 4 }} />);
            i++;
            continue;
        }

        /* ─ Headers ─ */
        const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const sizes = [
                "1.4em",
                "1.2em",
                "1.05em",
                "1.05em",
                "0.9em",
                "0.9em",
            ];
            const weights = [600, 600, 600, 500, 500, 500];
            elements.push(
                <div
                    key={i}
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: sizes[level - 1],
                        fontWeight: weights[level - 1],
                        marginBottom: 2,
                        marginTop: i === 0 ? 0 : 8,
                    }}
                >
                    {renderInline(headerMatch[2], inlineOptions)}
                </div>,
            );
            i++;
            continue;
        }

        /* ─ Horizontal rule ─ */
        if (/^---+\s*$/.test(trimmed)) {
            elements.push(
                <hr
                    key={i}
                    style={{
                        border: "none",
                        borderTop: "1px solid var(--color-border)",
                        margin: "8px 0",
                    }}
                />,
            );
            i++;
            continue;
        }

        /* ─ Blockquote ─ */
        if (/^>\s/.test(trimmed)) {
            const quoteLines: string[] = [];
            while (
                i < lines.length &&
                /^>\s?/.test(lines[i]?.trimStart() ?? "")
            ) {
                quoteLines.push(
                    (lines[i] ?? "").trimStart().replace(/^>\s?/, ""),
                );
                i++;
            }
            elements.push(
                <blockquote
                    key={`bq-${i}`}
                    className="my-1 pl-3 italic"
                    style={{
                        borderLeft: "2px solid var(--color-accent)",
                        color: "var(--color-text-secondary)",
                    }}
                >
                    {quoteLines.map((ql, qi) => (
                        <div key={qi}>{renderInline(ql, inlineOptions)}</div>
                    ))}
                </blockquote>,
            );
            continue;
        }

        /* ─ Table ─ */
        if (trimmed.includes("|")) {
            const tableLines: string[] = [];
            let ti = i;
            while (ti < lines.length) {
                const tl = lines[ti]?.trimStart() ?? "";
                if (!tl.includes("|")) break;
                tableLines.push(tl);
                ti++;
            }
            const parsed = tryParseTable(tableLines);
            if (parsed) {
                elements.push(<TableBlock key={`table-${i}`} table={parsed} />);
                i = ti;
                continue;
            }
        }

        /* ─ Unordered list ─ */
        if (/^[-*+]\s+/.test(trimmed)) {
            const items: string[] = [];
            while (
                i < lines.length &&
                /^[-*+]\s+/.test(lines[i]?.trimStart() ?? "")
            ) {
                items.push(
                    (lines[i] ?? "").trimStart().replace(/^[-*+]\s+/, ""),
                );
                i++;
            }
            elements.push(
                <ul
                    key={`ul-${i}`}
                    style={{
                        listStyleType: "disc",
                        margin: "4px 0",
                        paddingLeft: "1.25rem",
                    }}
                >
                    {items.map((item, idx) => (
                        <li key={idx} style={{ lineHeight: 1.6 }}>
                            {renderInline(item, inlineOptions)}
                        </li>
                    ))}
                </ul>,
            );
            continue;
        }

        /* ─ Ordered list ─ */
        if (/^\d+[.)]\s+/.test(trimmed)) {
            const items: string[] = [];
            while (
                i < lines.length &&
                /^\d+[.)]\s+/.test(lines[i]?.trimStart() ?? "")
            ) {
                items.push(
                    (lines[i] ?? "").trimStart().replace(/^\d+[.)]\s+/, ""),
                );
                i++;
            }
            elements.push(
                <ol
                    key={`ol-${i}`}
                    style={{
                        listStyleType: "decimal",
                        margin: "4px 0",
                        paddingLeft: "1.25rem",
                    }}
                >
                    {items.map((item, idx) => (
                        <li key={idx} style={{ lineHeight: 1.6 }}>
                            {renderInline(item, inlineOptions)}
                        </li>
                    ))}
                </ol>,
            );
            continue;
        }

        /* ─ Paragraph ─ */
        elements.push(
            <div
                key={i}
                style={{
                    lineHeight: 1.6,
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {renderInline(line, inlineOptions)}
            </div>,
        );
        i++;
    }

    return <>{elements}</>;
}

/* ─── Main component ─── */

export const MarkdownContent = memo(function MarkdownContent({
    content,
    chatFontFamily,
    chatFontSize = 14,
    onOpenFile,
}: MarkdownContentProps) {
    const blocks = useMemo(() => parseBlocks(content), [content]);

    const inlineOptions: InlineOptions | undefined = useMemo(() => {
        if (!onOpenFile) return undefined;
        return {
            metrics: getChatPillMetrics(chatFontSize),
            onOpenFile,
        };
    }, [chatFontSize, onOpenFile]);

    return (
        <div
            className="chat-assistant-content min-w-0 max-w-full"
            style={{
                fontFamily: chatFontFamily,
                fontSize: chatFontSize,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {blocks.map((block, index) =>
                block.type === "code" ? (
                    <CodeBlock
                        block={block}
                        chatFontSize={chatFontSize}
                        key={index}
                    />
                ) : (
                    <TextBlock
                        block={block}
                        inlineOptions={inlineOptions}
                        key={index}
                    />
                ),
            )}
        </div>
    );
});
