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
    readonly openFence: OpenMarkdownFence | null;
    readonly stableBlocks: readonly MarkdownBlock[];
    readonly stableContentLength: number;
}

interface MarkdownFenceOpening {
    readonly char: "`" | "~";
    readonly info: string;
    readonly length: number;
}

interface OpenMarkdownFence extends MarkdownFenceOpening {
    readonly contentStart: number;
    readonly rawContent: string;
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

export const STREAMING_MARKDOWN_PARSE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

interface CachedParsedBlocks {
    readonly blocks: readonly ParsedSegmentBlock[];
    readonly estimatedBytes: number;
}

const parsedBlockCache = new Map<string, CachedParsedBlocks>();
let parsedBlockCacheBytes = 0;
const listItemPattern = /^\s*(?:[-+*]|\d+[.)])\s+/m;

function rememberParsedBlocks(
    text: string,
    blocks: readonly ParsedSegmentBlock[],
): readonly ParsedSegmentBlock[] {
    const previous = parsedBlockCache.get(text);
    if (previous) {
        parsedBlockCache.delete(text);
        parsedBlockCacheBytes -= previous.estimatedBytes;
    }
    const estimatedBytes = estimateParsedBlocksBytes(text, blocks);
    if (estimatedBytes > STREAMING_MARKDOWN_PARSE_CACHE_MAX_BYTES) {
        return blocks;
    }

    parsedBlockCache.set(text, { blocks, estimatedBytes });
    parsedBlockCacheBytes += estimatedBytes;
    while (
        parsedBlockCacheBytes > STREAMING_MARKDOWN_PARSE_CACHE_MAX_BYTES
    ) {
        const oldestKey = parsedBlockCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = parsedBlockCache.get(oldestKey);
        parsedBlockCache.delete(oldestKey);
        parsedBlockCacheBytes -= oldest?.estimatedBytes ?? 0;
    }
    return blocks;
}

function estimateParsedBlocksBytes(
    text: string,
    blocks: readonly ParsedSegmentBlock[],
): number {
    // Parsed blocks retain text slices in addition to the lookup key.
    return (
        text.length +
        blocks.reduce(
            (total, block) => total + block.content.length + block.info.length,
            0,
        )
    ) * 2;
}

export function getStreamingMarkdownParseCacheDiagnostics(): {
    readonly entries: number;
    readonly residentBytes: number;
} {
    return {
        entries: parsedBlockCache.size,
        residentBytes: parsedBlockCacheBytes,
    };
}

export function resetStreamingMarkdownParseCacheForTests(): void {
    // Tests need isolation because this module-level LRU intentionally survives renders.
    parsedBlockCache.clear();
    parsedBlockCacheBytes = 0;
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

function findOpenMarkdownFence(
    text: string,
    startOffset: number,
): OpenMarkdownFence | null {
    let cursor = startOffset;
    while (cursor < text.length) {
        const lineEnd = text.indexOf("\n", cursor);
        const lineTo = lineEnd === -1 ? text.length : lineEnd;
        const opening = parseMarkdownFenceOpening(text.slice(cursor, lineTo));
        if (!opening) {
            cursor = lineEnd === -1 ? text.length : lineEnd + 1;
            continue;
        }
        const contentStart = lineEnd === -1 ? lineTo : lineEnd + 1;
        const closing = findMarkdownFenceClosing(text, contentStart, opening);
        if (!closing) {
            return {
                ...opening,
                contentStart,
                rawContent: text.slice(contentStart),
            };
        }
        cursor = closing.to;
    }
    return null;
}

function parseBlocksUnmeasured(text: string): readonly ParsedSegmentBlock[] {
    const cached = parsedBlockCache.get(text);
    if (cached) {
        incrementChatPerformanceCounter("markdown_cache_hits");
        // Refresh the LRU position without changing the cached byte total.
        parsedBlockCache.delete(text);
        parsedBlockCache.set(text, cached);
        return cached.blocks;
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
        openFence: sealAll
            ? null
            : findOpenMarkdownFence(content, stableContentLength),
        stableBlocks,
        stableContentLength,
    };
}

function patchOpenFence(
    previous: ParsedMarkdownBlocks,
    content: string,
): ParsedMarkdownBlocks | null {
    const openFence = previous.openFence;
    const previousMutableBlock = previous.blocks.at(-1);
    if (
        !openFence ||
        !previousMutableBlock ||
        previousMutableBlock.type !== "code" ||
        !previousMutableBlock.isMutable
    ) {
        return null;
    }

    const delta = content.slice(previous.content.length);
    const boundaryStart = openFence.rawContent.lastIndexOf("\n") + 1;
    if (
        findMarkdownFenceClosing(
            `${openFence.rawContent.slice(boundaryStart)}${delta}`,
            0,
            openFence,
        )
    ) {
        return null;
    }

    // The fence body itself stays mutable, but only the new suffix is inspected
    // for a closing delimiter. Its already-known structure is retained.
    incrementChatPerformanceCounter("markdown_chars_reparsed", delta.length);
    const rawContent = `${openFence.rawContent}${delta}`;
    const mutableBlock: MarkdownBlock = {
        ...previousMutableBlock,
        content: rawContent.replace(/\n$/, ""),
    };
    return {
        blocks: [...previous.stableBlocks, mutableBlock],
        content,
        openFence: { ...openFence, rawContent },
        stableBlocks: previous.stableBlocks,
        stableContentLength: previous.stableContentLength,
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
    if (!sealAll) {
        const patched = patchOpenFence(previous, content);
        if (patched) {
            return patched;
        }
    }
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
        openFence: sealAll
            ? null
            : findOpenMarkdownFence(content, stableContentLength),
        stableBlocks,
        stableContentLength,
    };
}
