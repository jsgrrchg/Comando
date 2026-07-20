import type { AiSessionSnapshot } from "@shared/ipc";

import type { ChatTimelineMessageRow } from "./chatTimelineModel";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";

// Keep every virtual item comfortably smaller than an entire agent transcript.
// Both limits apply because minified output can have few newlines, while prose
// can be tall long before it reaches the character budget.
export const LONG_CONTENT_CHUNK_MAX_CHARACTERS = 7_000;
export const LONG_CONTENT_CHUNK_MAX_LINES = 160;
export const LONG_CONTENT_MIN_CHARACTERS = 18_000;
export const LONG_CONTENT_MIN_LINES = 400;

export interface LongContentChunkRow {
    readonly chunkIndex: number;
    readonly chunkCount: number;
    readonly content: string;
    readonly id: string;
    readonly kind: "content-chunk";
    readonly message: AiSessionSnapshot["messages"][number];
    readonly sourceRowId: string;
}

/**
 * Replaces an exceptionally long, completed assistant message with stable
 * presentation rows. The original message remains the source of truth in the
 * transcript, so persistence, full-copy and search never depend on mounted DOM.
 */
export function splitLongContentRows<T>(
    rows: readonly T[],
    isMessageRow: (row: T) => row is T & ChatTimelineMessageRow,
): readonly (T | LongContentChunkRow)[] {
    incrementChatPerformanceCounter(
        "presentation_items_visited",
        rows.length,
    );
    const result: (T | LongContentChunkRow)[] = [];

    for (const row of rows) {
        if (!isMessageRow(row) || !shouldSplitMessage(row.message)) {
            result.push(row);
            continue;
        }

        const chunks = splitMarkdownIntoPresentationChunks(row.message.content);
        if (chunks.length < 2) {
            result.push(row);
            continue;
        }

        chunks.forEach((content, chunkIndex) => {
            result.push({
                chunkIndex,
                chunkCount: chunks.length,
                content,
                // The source row ID and ordinal make this stable across remounts.
                id: `${row.id}:chunk:${chunkIndex}`,
                kind: "content-chunk",
                message: row.message,
                sourceRowId: row.id,
            });
        });
    }

    return result;
}

export function isLongContentChunkRow(
    row: unknown,
): row is LongContentChunkRow {
    return (
        typeof row === "object" &&
        row !== null &&
        (row as { readonly kind?: unknown }).kind === "content-chunk"
    );
}

export function shouldSplitMessage(
    message: AiSessionSnapshot["messages"][number],
): boolean {
    // Streaming text is intentionally kept as one row. Its final revision is
    // split once complete, avoiding a moving set of chunk keys on every token.
    if (
        message.kind !== "assistant" ||
        message.status === "streaming" ||
        message.attachments.length > 0 ||
        message.generatedImage
    ) {
        return false;
    }

    const lineCount = countLines(message.content);
    return (
        message.content.length >= LONG_CONTENT_MIN_CHARACTERS ||
        lineCount >= LONG_CONTENT_MIN_LINES
    );
}

export function splitMarkdownIntoPresentationChunks(
    content: string,
): readonly string[] {
    if (!content) return [content];

    const chunks: string[] = [];
    let current = "";
    let currentLineCount = 0;
    let fence: Fence | null = null;

    const flush = () => {
        if (!current) return;
        chunks.push(current);
        current = "";
        currentLineCount = 0;
    };

    const lines = content.split(/(?<=\n)/);
    for (const line of lines) {
        const opening: Fence | null = fence ? null : parseFence(line);
        const closesFence = fence ? isFenceClose(line, fence) : false;
        const lineCount = 1;

        if (!fence && !opening && line.length > LONG_CONTENT_CHUNK_MAX_CHARACTERS) {
            flush();
            chunks.push(...splitPlainTextChunk(line));
            continue;
        }
        const exceedsLimit =
            current.length + line.length > LONG_CONTENT_CHUNK_MAX_CHARACTERS ||
            currentLineCount + lineCount > LONG_CONTENT_CHUNK_MAX_LINES;

        if (opening && current) {
            // Keep a fenced block isolated so an oversized code block can be
            // rebalanced below without treating surrounding prose as code.
            flush();
        }

        // Only split regular Markdown at a line boundary. Fenced code remains
        // syntactically whole, so each rendered chunk has valid Markdown.
        if (current && exceedsLimit && !fence) {
            flush();
        }

        current += line;
        currentLineCount += lineCount;

        if (opening) {
            fence = opening;
        } else if (closesFence) {
            fence = null;
            flush();
            continue;
        }

        // Prefer paragraph boundaries when available; the hard limit above
        // prevents a very large paragraph from becoming an unbounded row.
        if (!fence && /^\s*\n$/.test(line) && current.length >= LONG_CONTENT_CHUNK_MAX_CHARACTERS / 2) {
            flush();
        }
    }
    flush();

    // A giant fenced block cannot be split at its closing delimiter. Rechunk it
    // with a balanced fence around every slice, preserving code presentation.
    return chunks.flatMap(splitOversizedFencedChunk);
}

interface Fence {
    readonly character: "`" | "~";
    readonly length: number;
}

function parseFence(line: string): Fence | null {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match?.[1]) return null;
    return {
        character: match[1][0] as Fence["character"],
        length: match[1].length,
    };
}

function isFenceClose(line: string, fence: Fence): boolean {
    const pattern = new RegExp(
        `^ {0,3}${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
    );
    return pattern.test(line);
}

function splitOversizedFencedChunk(chunk: string): readonly string[] {
    if (
        chunk.length <= LONG_CONTENT_CHUNK_MAX_CHARACTERS &&
        countLines(chunk) <= LONG_CONTENT_CHUNK_MAX_LINES
    ) {
        return [chunk];
    }

    const firstLineEnd = chunk.indexOf("\n");
    const openingLine = chunk.slice(0, firstLineEnd + 1);
    const fence = parseFence(openingLine);
    if (!fence) return splitPlainTextChunk(chunk);

    const closingPattern = new RegExp(
        `\\n? {0,3}${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
    );
    const body = chunk.slice(firstLineEnd + 1).replace(closingPattern, "");
    const closingLine = `${fence.character.repeat(fence.length)}\n`;
    return splitPlainTextChunk(body).map(
        (slice) => `${openingLine}${slice}${slice.endsWith("\n") ? "" : "\n"}${closingLine}`,
    );
}

function splitPlainTextChunk(content: string): readonly string[] {
    const chunks: string[] = [];
    let current = "";
    let lineCount = 0;
    for (const line of content.split(/(?<=\n)/)) {
        if (line.length > LONG_CONTENT_CHUNK_MAX_CHARACTERS) {
            if (current) {
                chunks.push(current);
                current = "";
                lineCount = 0;
            }
            for (
                let start = 0;
                start < line.length;
                start += LONG_CONTENT_CHUNK_MAX_CHARACTERS
            ) {
                chunks.push(
                    line.slice(
                        start,
                        start + LONG_CONTENT_CHUNK_MAX_CHARACTERS,
                    ),
                );
            }
            continue;
        }
        if (
            current &&
            (current.length + line.length > LONG_CONTENT_CHUNK_MAX_CHARACTERS ||
                lineCount + 1 > LONG_CONTENT_CHUNK_MAX_LINES)
        ) {
            chunks.push(current);
            current = "";
            lineCount = 0;
        }
        current += line;
        lineCount += 1;
    }
    if (current) chunks.push(current);
    return chunks;
}

function countLines(content: string): number {
    return content ? content.split("\n").length : 0;
}
