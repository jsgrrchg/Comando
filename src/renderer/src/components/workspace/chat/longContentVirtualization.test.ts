import { describe, expect, it } from "vitest";
import type { AiSessionSnapshot } from "@shared/ipc";

import type { ChatTimelineMessageRow } from "./chatTimelineModel";
import {
    LONG_CONTENT_CHUNK_MAX_CHARACTERS,
    LONG_CONTENT_MIN_CHARACTERS,
    isLongContentChunkRow,
    splitLongContentRows,
    splitMarkdownIntoPresentationChunks,
} from "./longContentVirtualization";

function createMessage(
    content: string,
    overrides: Partial<AiSessionSnapshot["messages"][number]> = {},
): AiSessionSnapshot["messages"][number] {
    return {
        attachments: [],
        content,
        createdAt: "2026-07-19T12:00:00.000Z",
        id: "assistant-1",
        kind: "assistant",
        status: "completed",
        ...overrides,
    };
}

describe("long content virtualization", () => {
    it("replaces a large completed assistant message with stable chunks", () => {
        const row: ChatTimelineMessageRow = {
            blockId: null,
            id: "message:assistant-1",
            kind: "message",
            message: createMessage("word ".repeat(LONG_CONTENT_MIN_CHARACTERS)),
        };

        const items = splitLongContentRows(
            [row],
            (item): item is ChatTimelineMessageRow => item.kind === "message",
        );

        expect(items).toHaveLength(13);
        expect(items[0]).toMatchObject({
            chunkIndex: 0,
            id: "message:assistant-1:chunk:0",
            kind: "content-chunk",
            sourceRowId: "message:assistant-1",
        });
        expect(items.at(-1)).toMatchObject({ chunkIndex: 12, chunkCount: 13 });
    });

    it("does not split a moving stream or messages with non-text artifacts", () => {
        const streaming: ChatTimelineMessageRow = {
            blockId: null,
            id: "message:streaming",
            kind: "message",
            message: createMessage("word ".repeat(LONG_CONTENT_MIN_CHARACTERS), {
                status: "streaming",
            }),
        };
        const withAttachment: ChatTimelineMessageRow = {
            blockId: null,
            id: "message:attachment",
            kind: "message",
            message: createMessage("word ".repeat(LONG_CONTENT_MIN_CHARACTERS), {
                attachments: [
                    {
                        dataBase64: "",
                        id: "image-1",
                        mimeType: "image/png",
                        name: "image.png",
                        sizeBytes: 1,
                    },
                ],
            }),
        };

        const items = splitLongContentRows(
            [streaming, withAttachment],
            (item): item is ChatTimelineMessageRow => item.kind === "message",
        );

        expect(items).toEqual([streaming, withAttachment]);
    });

    it("keeps every rendered code chunk syntactically fenced", () => {
        const content = [
            "```ts",
            ...Array.from({ length: 1_000 }, (_, index) => `const line${index} = ${index};`),
            "```",
        ].join("\n");

        const chunks = splitMarkdownIntoPresentationChunks(content);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.startsWith("```ts\n"))).toBe(true);
        expect(chunks.every((chunk) => chunk.trimEnd().endsWith("```"))).toBe(true);
        expect(
            chunks.every(
                (chunk) => chunk.length <= LONG_CONTENT_CHUNK_MAX_CHARACTERS + 16,
            ),
        ).toBe(true);
    });

    it("keeps completed Markdown chunks stable and lossless", () => {
        const content = Array.from({ length: 600 }, (_, index) =>
            [
                `Paragraph ${index}: ${"text ".repeat(8)}`,
                "",
                "```ts",
                `const value${index} = ${index};`,
                "```",
                "",
            ].join("\n"),
        ).join("\n");
        const row: ChatTimelineMessageRow = {
            blockId: null,
            id: "message:assistant-1",
            kind: "message",
            message: createMessage(content),
        };

        const first = splitLongContentRows(
            [row],
            (item): item is ChatTimelineMessageRow => item.kind === "message",
        );
        const second = splitLongContentRows(
            [row],
            (item): item is ChatTimelineMessageRow => item.kind === "message",
        );
        const firstChunks = first.filter(isLongContentChunkRow);
        const secondChunks = second.filter(isLongContentChunkRow);

        expect(firstChunks.length).toBeGreaterThan(1);
        expect(firstChunks.map((chunk) => chunk.content).join("")).toBe(content);
        expect(secondChunks.map((chunk) => chunk.id)).toEqual(
            firstChunks.map((chunk) => chunk.id),
        );
        expect(secondChunks.map((chunk) => chunk.content)).toEqual(
            firstChunks.map((chunk) => chunk.content),
        );
    });
});
