import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import { measureChatPerformance } from "@renderer/app/debug/chatPerformanceProbe";

export interface MarkdownBlock {
    readonly content: string;
    readonly id: string;
    readonly info: string;
    readonly isMutable: boolean;
    readonly suppressTerminalEmptyLine: boolean;
    readonly type: "code" | "text";
}

export interface ParsedMarkdownBlocks {
    readonly blocks: readonly MarkdownBlock[];
    readonly content: string;
    readonly stableBlocks: readonly MarkdownBlock[];
    readonly stableContentLength: number;
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

interface ParsedSegmentBlock {
    readonly content: string;
    readonly info: string;
    readonly sourceStart: number;
    readonly type: "code" | "text";
}

const PARSED_BLOCK_CACHE_LIMIT = 250;
const parsedBlockCache = new Map<string, readonly ParsedSegmentBlock[]>();
const listItemPattern = /^\s*(?:[-+*]|\d+[.)])\s+/m;

function rememberParsedBlocks(
    text: string,
    blocks: readonly ParsedSegmentBlock[],
): readonly ParsedSegmentBlock[] {
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

    return { char, info, length: marker.length };
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

function findMarkdownFenceClosing(
    text: string,
    startOffset: number,
    opening: MarkdownFenceOpening,
): TextRange | null {
    let cursor = startOffset;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        if (isMarkdownFenceClosingLine(text.slice(cursor, lineTo), opening)) {
            return { from: cursor, to: lineEnd === -1 ? lineTo : lineEnd + 1 };
        }
        if (lineEnd === -1) {
            break;
        }
        cursor = lineEnd + 1;
    }

    return null;
}

function parseBlocksUnmeasured(text: string): readonly ParsedSegmentBlock[] {
    const cached = parsedBlockCache.get(text);
    if (cached) {
        incrementChatPerformanceCounter("markdown_cache_hits");
        return cached;
    }

    incrementChatPerformanceCounter("markdown_chars_reparsed", text.length);
    const blocks: ParsedSegmentBlock[] = [];
    let cursor = 0;
    let lastIndex = 0;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const opening = parseMarkdownFenceOpening(text.slice(cursor, lineTo));

        if (!opening) {
            cursor = lineEnd === -1 ? text.length : lineEnd + 1;
            continue;
        }

        const before = text.slice(lastIndex, cursor);
        if (before) {
            blocks.push({
                content: before,
                info: "",
                sourceStart: lastIndex,
                type: "text",
            });
        }

        const contentStart = lineEnd === -1 ? lineTo : lineEnd + 1;
        const closing = findMarkdownFenceClosing(text, contentStart, opening);
        const contentEnd = closing?.from ?? text.length;
        blocks.push({
            content: text.slice(contentStart, contentEnd).replace(/\n$/, ""),
            info: opening.info.toLowerCase(),
            sourceStart: cursor,
            type: "code",
        });
        lastIndex = closing?.to ?? text.length;
        cursor = lastIndex;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        blocks.push({
            content: tail,
            info: "",
            sourceStart: lastIndex,
            type: "text",
        });
    }

    return rememberParsedBlocks(text, blocks);
}

function parseBlocks(
    text: string,
    offset: number,
    isMutable: boolean,
    suppressTerminalEmptyLine = false,
): readonly MarkdownBlock[] {
    return measureChatPerformance(
        "markdown_parse_ms",
        { values: { contentChars: text.length } },
        () =>
            parseBlocksUnmeasured(text).map((block) => ({
                ...block,
                id: `${block.type}:${offset + block.sourceStart}`,
                isMutable,
                suppressTerminalEmptyLine:
                    block.type === "text" && suppressTerminalEmptyLine,
            })),
    );
}

function findNextNonEmptyLine(
    text: string,
    start: number,
): { readonly start: number; readonly text: string } | null {
    let cursor = start;
    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const line = text.slice(cursor, lineTo);
        if (line.trim().length > 0) {
            return { start: cursor, text: line };
        }
        if (lineEnd === -1) {
            return null;
        }
        cursor = lineEnd + 1;
    }
    return null;
}

function listCanContinueAcrossBlankLine(
    text: string,
    blankLineStart: number,
    nextLine: string,
): boolean {
    if (!/^\s+/.test(nextLine)) {
        return false;
    }

    // Exclude the separator currently being inspected from the look-behind.
    const previousBoundary = text.lastIndexOf("\n\n", blankLineStart - 2);
    return listItemPattern.test(
        text.slice(previousBoundary === -1 ? 0 : previousBoundary + 2, blankLineStart),
    );
}

/**
 * Returns a conservative cut where the prefix cannot be affected by later
 * append-only Markdown. The remaining suffix owns every open structure.
 */
function findSealablePrefixLength(text: string): number {
    let cursor = 0;
    let openFence: MarkdownFenceOpening | null = null;
    let latestBoundary = 0;

    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const line = text.slice(cursor, lineTo);
        const nextCursor = lineEnd === -1 ? text.length : lineEnd + 1;

        if (openFence) {
            if (isMarkdownFenceClosingLine(line, openFence)) {
                latestBoundary = nextCursor;
                openFence = null;
            }
            cursor = nextCursor;
            continue;
        }

        const opening = parseMarkdownFenceOpening(line);
        if (opening) {
            // Text before a fence is independent from the fence body.
            latestBoundary = Math.max(latestBoundary, cursor);
            openFence = opening;
            cursor = nextCursor;
            continue;
        }

        if (line.trim().length === 0) {
            const nextLine = findNextNonEmptyLine(text, nextCursor);
            if (
                nextLine &&
                !listCanContinueAcrossBlankLine(text, cursor, nextLine.text)
            ) {
                latestBoundary = Math.max(latestBoundary, nextCursor);
            }
        }

        cursor = nextCursor;
    }

    return latestBoundary;
}

function projectInitialContent(
    content: string,
    sealAll: boolean,
): ParsedMarkdownBlocks {
    incrementChatPerformanceCounter("markdown_full_parses");
    const stableContentLength = sealAll
        ? content.length
        : findSealablePrefixLength(content);
    const stableBlocks = parseBlocks(
        content.slice(0, stableContentLength),
        0,
        false,
        !sealAll && stableContentLength < content.length,
    );
    const mutableBlocks = parseBlocks(
        content.slice(stableContentLength),
        stableContentLength,
        !sealAll,
    );

    return {
        blocks: [...stableBlocks, ...mutableBlocks],
        content,
        stableBlocks,
        stableContentLength,
    };
}

export function parseMarkdownBlocksProgressively(
    previous: ParsedMarkdownBlocks | null,
    content: string,
    options: { readonly sealAll?: boolean } = {},
): ParsedMarkdownBlocks {
    const sealAll = options.sealAll ?? false;
    if (!previous || !content.startsWith(previous.content)) {
        return projectInitialContent(content, sealAll);
    }

    incrementChatPerformanceCounter("markdown_suffix_parses");
    const mutableContent = content.slice(previous.stableContentLength);
    const newlyStableLength = sealAll
        ? mutableContent.length
        : findSealablePrefixLength(mutableContent);
    const stableContentLength = previous.stableContentLength + newlyStableLength;
    const newlyStableBlocks = parseBlocks(
        mutableContent.slice(0, newlyStableLength),
        previous.stableContentLength,
        false,
        !sealAll && stableContentLength < content.length,
    );
    const mutableBlocks = parseBlocks(
        mutableContent.slice(newlyStableLength),
        stableContentLength,
        !sealAll,
    );
    const stableBlocks = [...previous.stableBlocks, ...newlyStableBlocks];

    return {
        blocks: [...stableBlocks, ...mutableBlocks],
        content,
        stableBlocks,
        stableContentLength,
    };
}
