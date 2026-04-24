import {
    memo,
    useCallback,
    useMemo,
    useRef,
    useState,
    type ReactElement,
} from "react";

import { extractFenceLanguageToken } from "../../app/editor/codeLanguage";
import {
    parseMarkdownListItem,
    type MarkdownListItem,
} from "../../app/editor/markdownLists";
import { HighlightedCodeText } from "../../app/editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "../../app/editor/useCodeLanguageSupport";
import { useTextContextMenu } from "../context-menu/useTextContextMenu";
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
import { type ChatPillVariant } from "./chat/chatPillPalette";
import {
    isLikelyProjectFileReference,
    type ResolvedProjectFileReference,
} from "./projectFileReferences";

interface MarkdownContentProps {
    readonly content: string;
    readonly chatFontSize?: number;
    readonly chatFontFamily?: string;
    readonly onOpenFile?: (reference: ResolvedProjectFileReference) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

interface Block {
    readonly content: string;
    readonly info: string;
    readonly type: "code" | "text";
}

interface MarkdownFenceOpening {
    readonly char: "`" | "~";
    readonly info: string;
    readonly length: number;
}

interface TextRange {
    readonly from: number;
    readonly to: number;
}

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
    let cursor = 0;
    let lastIndex = 0;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const lineText = text.slice(cursor, lineTo);
        const opening = parseMarkdownFenceOpening(lineText);

        if (!opening) {
            cursor = lineEnd === -1 ? text.length : lineEnd + 1;
            continue;
        }

        const before = text.slice(lastIndex, cursor);
        if (before) blocks.push({ content: before, info: "", type: "text" });

        const contentStart = lineEnd === -1 ? lineTo : lineEnd + 1;
        const closing = findMarkdownFenceClosing(text, contentStart, opening);
        const contentEnd = closing?.from ?? text.length;
        const content = text.slice(contentStart, contentEnd).replace(/\n$/, "");

        blocks.push({
            content,
            info: opening.info.toLowerCase(),
            type: "code",
        });
        lastIndex = closing?.to ?? text.length;
        cursor = lastIndex;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        blocks.push({ content: tail, info: "", type: "text" });
    }

    return rememberParsedBlocks(text, blocks);
}

function parseMarkdownFenceOpening(lineText: string): MarkdownFenceOpening | null {
    const match = lineText.match(/^(?: {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return null;
    }

    const marker = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    const char = marker[0];
    if (char !== "`" && char !== "~") {
        return null;
    }
    if (char === "`" && info.includes("`")) {
        return null;
    }

    return {
        char,
        info,
        length: marker.length,
    };
}

function findMarkdownFenceClosing(
    text: string,
    startOffset: number,
    opening: MarkdownFenceOpening,
): TextRange | null {
    let cursor = startOffset;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const lineText = text.slice(cursor, lineTo);

        if (isMarkdownFenceClosingLine(lineText, opening)) {
            return {
                from: cursor,
                to: lineEnd === -1 ? lineTo : lineEnd + 1,
            };
        }

        if (lineEnd === -1) {
            break;
        }
        cursor = lineEnd + 1;
    }

    return null;
}

function isMarkdownFenceClosingLine(
    lineText: string,
    opening: MarkdownFenceOpening,
): boolean {
    let cursor = 0;
    while (cursor < lineText.length && lineText[cursor] === " " && cursor < 3) {
        cursor += 1;
    }

    let markerLength = 0;
    while (lineText[cursor + markerLength] === opening.char) {
        markerLength += 1;
    }
    if (markerLength < opening.length) {
        return false;
    }

    return lineText.slice(cursor + markerLength).trim().length === 0;
}

/* ─── Inline rendering ─── */

interface InlineOptions {
    readonly metrics?: ReturnType<typeof getChatPillMetrics>;
    readonly onOpenFile?: (reference: ResolvedProjectFileReference) => void;
    readonly resolveFileReference?: (
        reference: string,
    ) => ResolvedProjectFileReference | null;
}

interface ParsedList {
    readonly element: ReactElement;
    readonly nextIndex: number;
}

type MarkdownLineBlockKind =
    | "blank"
    | "blockquote"
    | "fence"
    | "heading"
    | "horizontal_rule"
    | "paragraph"
    | "table";

function getPillVariant(label: string): ChatPillVariant {
    if (label === "@fetch") return "success";
    if (label === "/plan") return "neutral";
    if (label.startsWith("@")) {
        return /\.\w+$/.test(label.slice(1)) ? "file" : "folder";
    }
    if (label.startsWith("\u{1F4CE}")) return "file";
    return "accent";
}

function renderInline(
    text: string,
    options?: InlineOptions,
): Array<ReactElement | string> {
    const parts: Array<ReactElement | string> = [];
    const re =
        /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(\u200B\u00AB[^\u00BB]*\u00BB\u200B)/g;
    let lastIndex = 0;
    let key = 0;

    for (const match of text.matchAll(re)) {
        const before = text.slice(lastIndex, match.index);
        if (before) parts.push(before);

        if (match[5]) {
            const pillLabel = match[5].slice(2, -2);
            const variant = getPillVariant(pillLabel);
            const pillMetrics = options?.metrics ?? getChatPillMetrics(14);
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label={pillLabel}
                    metrics={pillMetrics}
                    variant={variant}
                />,
            );
        } else if (match[1]) {
            const codeText = match[1].slice(1, -1);
            const resolvedCodeReference =
                options?.resolveFileReference?.(codeText) ?? null;
            const inlineMetrics = options?.metrics;
            const handleOpenFile = options?.onOpenFile;
            if (
                resolvedCodeReference &&
                inlineMetrics &&
                handleOpenFile &&
                isLikelyProjectFileReference(codeText)
            ) {
                parts.push(
                    <ChatInlinePill
                        key={key++}
                        interactive
                        label={codeText}
                        metrics={inlineMetrics}
                        onClick={() => handleOpenFile(resolvedCodeReference)}
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
                const linkTarget = linkMatch[2];
                const resolvedLinkReference =
                    options?.resolveFileReference?.(linkTarget) ?? null;
                parts.push(
                    <a
                        key={key++}
                        href={linkTarget}
                        onClick={(event) => {
                            if (
                                !resolvedLinkReference ||
                                !options?.onOpenFile ||
                                !isLikelyProjectFileReference(linkTarget)
                            ) {
                                return;
                            }

                            event.preventDefault();
                            options.onOpenFile(resolvedLinkReference);
                        }}
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

function getIndentWidth(indent: string): number {
    let width = 0;

    for (const char of indent) {
        width += char === "\t" ? 4 : 1;
    }

    return width;
}

function getLineIndentWidth(line: string): number {
    let cursor = 0;
    while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
        cursor += 1;
    }

    return getIndentWidth(line.slice(0, cursor));
}

function getMarkdownLineBlockKind(
    lines: readonly string[],
    index: number,
): MarkdownLineBlockKind {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();

    if (trimmed.length === 0) return "blank";
    if (/^(#{1,6})\s+(.+)$/.test(trimmed)) return "heading";
    if (/^---+\s*$/.test(trimmed)) return "horizontal_rule";
    if (/^>\s/.test(trimmed)) return "blockquote";
    if (parseMarkdownFenceOpening(line)) return "fence";
    if (isMarkdownTableStart(lines, index)) return "table";

    return "paragraph";
}

function isMarkdownTableStart(
    lines: readonly string[],
    startIndex: number,
): boolean {
    const tableLines: string[] = [];

    for (let index = startIndex; index < lines.length; index++) {
        const line = lines[index]?.trimStart() ?? "";
        if (!line.includes("|")) break;
        tableLines.push(line);
    }

    return tryParseTable(tableLines) !== null;
}

function shouldBreakListForBlockStart(
    lines: readonly string[],
    index: number,
    baseIndentWidth: number,
): boolean {
    if (getLineIndentWidth(lines[index] ?? "") > baseIndentWidth) {
        return false;
    }

    const blockKind = getMarkdownLineBlockKind(lines, index);
    return (
        blockKind === "blockquote" ||
        blockKind === "fence" ||
        blockKind === "heading" ||
        blockKind === "horizontal_rule" ||
        blockKind === "table"
    );
}

function findNextNonEmptyLineIndex(
    lines: readonly string[],
    startIndex: number,
): number {
    for (let index = startIndex; index < lines.length; index++) {
        if ((lines[index] ?? "").trim().length > 0) {
            return index;
        }
    }

    return -1;
}

function renderParagraphLines(
    lines: readonly string[],
    key: string,
    inlineOptions?: InlineOptions,
): ReactElement {
    return (
        <div
            key={key}
            style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
            }}
        >
            {lines.map((line, index) => (
                <div
                    key={`${key}-${index}`}
                    style={{
                        lineHeight: 1.6,
                        maxWidth: "100%",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {renderInline(line, inlineOptions)}
                </div>
            ))}
        </div>
    );
}

function buildListItemLeadLine(item: MarkdownListItem): string {
    if (!item.isTask) {
        return item.content;
    }

    return `[${item.taskMarker ?? " "}] ${item.content}`;
}

function parseList(
    lines: readonly string[],
    startIndex: number,
    inlineOptions?: InlineOptions,
): ParsedList | null {
    const firstItem = parseMarkdownListItem(lines[startIndex] ?? "");
    if (!firstItem) {
        return null;
    }

    const ordered = firstItem.orderedNumber !== null;
    const baseIndentWidth = getIndentWidth(firstItem.indent);
    const startNumber =
        ordered && firstItem.orderedNumber !== 1
            ? firstItem.orderedNumber
            : undefined;
    const items: ReactElement[] = [];
    let cursor = startIndex;

    while (cursor < lines.length) {
        const currentItem = parseMarkdownListItem(lines[cursor] ?? "");
        if (!currentItem) {
            break;
        }

        const currentIndentWidth = getIndentWidth(currentItem.indent);
        const currentOrdered = currentItem.orderedNumber !== null;
        if (
            currentIndentWidth !== baseIndentWidth ||
            currentOrdered !== ordered
        ) {
            break;
        }

        const childElements: ReactElement[] = [];
        let paragraphLines = [buildListItemLeadLine(currentItem)];
        let paragraphCount = 0;
        cursor += 1;

        const flushParagraph = () => {
            if (paragraphLines.length === 0) {
                return;
            }

            childElements.push(
                renderParagraphLines(
                    paragraphLines,
                    `list-item-${startIndex}-${items.length}-${paragraphCount}`,
                    inlineOptions,
                ),
            );
            paragraphLines = [];
            paragraphCount += 1;
        };

        while (cursor < lines.length) {
            const currentLine = lines[cursor] ?? "";
            const trimmedLine = currentLine.trim();

            if (trimmedLine.length === 0) {
                flushParagraph();
                const nextNonEmptyIndex = findNextNonEmptyLineIndex(
                    lines,
                    cursor + 1,
                );
                if (nextNonEmptyIndex === -1) {
                    cursor = lines.length;
                    break;
                }

                if (
                    shouldBreakListForBlockStart(
                        lines,
                        nextNonEmptyIndex,
                        baseIndentWidth,
                    )
                ) {
                    cursor = nextNonEmptyIndex;
                    break;
                }

                const nextItem = parseMarkdownListItem(
                    lines[nextNonEmptyIndex] ?? "",
                );
                if (nextItem) {
                    const nextIndentWidth = getIndentWidth(nextItem.indent);
                    if (nextIndentWidth <= baseIndentWidth) {
                        cursor = nextNonEmptyIndex;
                        break;
                    }
                }

                cursor = nextNonEmptyIndex;
                continue;
            }

            if (shouldBreakListForBlockStart(lines, cursor, baseIndentWidth)) {
                break;
            }

            const nextItem = parseMarkdownListItem(currentLine);
            if (nextItem) {
                const nextIndentWidth = getIndentWidth(nextItem.indent);
                if (nextIndentWidth > baseIndentWidth) {
                    flushParagraph();
                    const nestedList = parseList(lines, cursor, inlineOptions);
                    if (nestedList) {
                        childElements.push(nestedList.element);
                        cursor = nestedList.nextIndex;
                        continue;
                    }
                }

                if (nextIndentWidth <= baseIndentWidth) {
                    break;
                }
            }

            paragraphLines.push(trimmedLine);
            cursor += 1;
        }

        flushParagraph();
        items.push(
            <li key={`list-item-${startIndex}-${items.length}`}>
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                    }}
                >
                    {childElements}
                </div>
            </li>,
        );
    }

    if (items.length === 0) {
        return null;
    }

    return {
        element: ordered ? (
            <ol
                key={`ol-${startIndex}`}
                start={startNumber}
                style={{
                    listStyleType: "decimal",
                    margin: "4px 0",
                    paddingLeft: "1.25rem",
                }}
            >
                {items}
            </ol>
        ) : (
            <ul
                key={`ul-${startIndex}`}
                style={{
                    listStyleType: "disc",
                    margin: "4px 0",
                    paddingLeft: "1.25rem",
                }}
            >
                {items}
            </ul>
        ),
        nextIndex: cursor,
    };
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
            viewBox="0 0 14 14"
            width="11"
        >
            <rect x="5" y="3" width="6" height="8" rx="1.2" />
            <path d="M3.5 9.5H3A1 1 0 012 8.5v-5A1.5 1.5 0 013.5 2H8" />
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
            strokeWidth="1.5"
            viewBox="0 0 14 14"
            width="11"
        >
            <path d="M3 7l2.2 2.2L11 3.8" />
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
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.9";
            }}
            title={copied ? "Copied" : "Copy"}
            style={{
                alignItems: "center",
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
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
                    className="flex items-center justify-between px-3 py-2 pr-9"
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
            elements.push(<div key={i} style={{ height: 8 }} />);
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
                        marginBottom: 4,
                        marginTop: i === 0 ? 0 : 10,
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

        /* ─ Lists ─ */
        if (parseMarkdownListItem(lines[i] ?? "")) {
            const parsedList = parseList(lines, i, inlineOptions);
            if (parsedList) {
                elements.push(parsedList.element);
                i = parsedList.nextIndex;
                continue;
            }
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
    resolveFileReference,
}: MarkdownContentProps) {
    const blocks = useMemo(() => parseBlocks(content), [content]);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const { contextMenu, handleContextMenu } =
        useTextContextMenu<HTMLDivElement>({
            containerRef: contentRef,
            getFallbackCopyText: () => content,
        });

    const inlineOptions: InlineOptions | undefined = useMemo(() => {
        if (!onOpenFile || !resolveFileReference) return undefined;
        return {
            metrics: getChatPillMetrics(chatFontSize),
            onOpenFile,
            resolveFileReference,
        };
    }, [chatFontSize, onOpenFile, resolveFileReference]);

    return (
        <div
            className="chat-assistant-content min-w-0 max-w-full"
            onContextMenu={handleContextMenu}
            ref={contentRef}
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
            {contextMenu}
        </div>
    );
});
