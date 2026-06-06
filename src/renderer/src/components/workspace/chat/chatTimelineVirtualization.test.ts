import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot, AiToolActivity, AiTrackedFile } from "@shared/ipc";

import {
    reconcileChatTimelineModel,
    type ChatTimelineRow,
} from "./chatTimelineModel";
import {
    CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
    CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
    CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
    calculateChatTimelineVirtualScrollMarginTop,
    estimateChatTimelineRowHeight,
    getChatTimelineEffectiveContentWidth,
    getChatTimelineRowIdentityKey,
    getChatTimelineRowMeasurementKey,
    getChatTimelineRowKey,
    getChatTimelineVirtualMeasurementWidth,
    getChatTimelineVirtualRowGapPx,
    isWidthSensitiveChatTimelineRow,
    shouldVirtualizeChatTimeline,
} from "./chatTimelineVirtualization";

function createMessage(
    overrides: Partial<AiSessionSnapshot["messages"][number]> = {},
): AiSessionSnapshot["messages"][number] {
    return {
        attachments: [],
        content: "hello",
        createdAt: "2026-04-14T00:00:00.000Z",
        id: "message-1",
        kind: "assistant",
        status: "completed",
        ...overrides,
    };
}

function createActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "edit",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: "session-1",
        status: "completed",
        summary: null,
        terminalOutput: null,
        title: "Edit file",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [],
        identityKey: "tracked-1",
        isText: true,
        kind: "update",
        newText: "next",
        oldText: "prev",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

function createMessageRow(
    overrides: Partial<AiSessionSnapshot["messages"][number]> = {},
): ChatTimelineRow {
    const message = createMessage(overrides);
    return {
        id: `message:${message.id}`,
        kind: "message",
        message,
    };
}

function createToolRow({
    activity,
    trackedFiles = [],
}: {
    readonly activity?: AiToolActivity;
    readonly trackedFiles?: readonly AiTrackedFile[];
} = {}): ChatTimelineRow {
    const nextActivity = activity ?? createActivity();
    return {
        id: `tool:${nextActivity.id}`,
        kind: "tool",
        reviewEntry: {
            activity: nextActivity,
            hasPendingTrackedFiles: trackedFiles.some(
                (trackedFile) => trackedFile.reviewState === "pending",
            ),
            pendingTrackedFiles: trackedFiles.filter(
                (trackedFile) => trackedFile.reviewState === "pending",
            ),
            trackedFiles,
        },
    };
}

function createElementRect(top: number): HTMLElement {
    return {
        getBoundingClientRect: () => ({ top }) as DOMRect,
    } as HTMLElement;
}

describe("chatTimelineVirtualization", () => {
    it("uses a high threshold and respects the escape hatch", () => {
        expect(
            shouldVirtualizeChatTimeline(
                CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1,
            ),
        ).toBe(false);
        expect(
            shouldVirtualizeChatTimeline(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD),
        ).toBe(true);
        expect(
            shouldVirtualizeChatTimeline(
                CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
                { enabled: false },
            ),
        ).toBe(false);
        expect(
            shouldVirtualizeChatTimeline(20, {
                enabled: true,
                threshold: 20,
            }),
        ).toBe(true);
    });

    it("preserves row ids as virtual keys", () => {
        const row = createMessageRow({ id: "message-42" });

        expect(getChatTimelineRowKey(row)).toBe("message:message-42");
    });

    it("calculates measured row gaps without duplicating the parent gap", () => {
        expect(
            getChatTimelineVirtualRowGapPx({
                index: 0,
                rowCount: 2,
            }),
        ).toBe(CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX);
        expect(
            getChatTimelineVirtualRowGapPx({
                index: 1,
                rowCount: 2,
            }),
        ).toBe(0);
        expect(
            getChatTimelineVirtualRowGapPx({
                index: 1,
                rowCount: 2,
            }),
        ).toBe(0);
    });

    it("returns positive estimates and accounts for content, gap, and expansion mode", () => {
        const shortMessage = createMessageRow({ content: "short" });
        const richMessage = createMessageRow({
            attachments: [
                {
                    dataBase64: "",
                    id: "image-1",
                    mimeType: "image/png",
                    name: "image.png",
                    sizeBytes: 1200,
                },
            ],
            content: [
                "Here is code:",
                "```ts",
                "const answer = 42;",
                "```",
                "and a lot more prose ".repeat(40),
            ].join("\n"),
        });
        const collapsedTool = createToolRow({
            activity: createActivity({
                diffs: [
                    {
                        hunks: [],
                        isText: true,
                        kind: "update",
                        newText: "next",
                        oldText: "prev",
                        path: "src/app.ts",
                        previousPath: null,
                        reversible: true,
                    },
                ],
                summary: "Updated src/app.ts",
            }),
            trackedFiles: [createTrackedFile()],
        });

        const messageHeight = estimateChatTimelineRowHeight(shortMessage, {
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
        });
        const richMessageHeight = estimateChatTimelineRowHeight(richMessage, {
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
        });
        const collapsedToolHeight = estimateChatTimelineRowHeight(
            collapsedTool,
            {
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                toolCardExpansionMode: "collapsed",
            },
        );
        const expandedToolHeight = estimateChatTimelineRowHeight(
            collapsedTool,
            {
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                toolCardExpansionMode: "expanded",
            },
        );

        expect(messageHeight).toBeGreaterThan(CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX);
        expect(richMessageHeight).toBeGreaterThan(messageHeight);
        expect(collapsedToolHeight).toBeGreaterThan(
            CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
        );
        expect(expandedToolHeight).toBeGreaterThan(collapsedToolHeight);
    });

    it("uses the available width when estimating message wrapping", () => {
        const longMessage = createMessageRow({
            content: "A measured timeline should keep long text stable. ".repeat(
                24,
            ),
        });

        const narrowHeight = estimateChatTimelineRowHeight(longMessage, {
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
            width: 320,
        });
        const wideHeight = estimateChatTimelineRowHeight(longMessage, {
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
            width: 960,
        });

        expect(narrowHeight).toBeGreaterThan(wideHeight);
    });

    it("estimates collapsed thinking rows from their header, not hidden content", () => {
        const content = "Reasoning content is hidden until expanded. ".repeat(40);
        const thinkingRow = createMessageRow({
            content,
            kind: "thinking",
        });
        const assistantRow = createMessageRow({ content });

        const thinkingHeight = estimateChatTimelineRowHeight(thinkingRow, {
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
            width: 520,
        });
        const assistantHeight = estimateChatTimelineRowHeight(assistantRow, {
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
            width: 520,
        });

        expect(thinkingHeight).toBeLessThan(assistantHeight);
        expect(thinkingHeight).toBeLessThan(64);
    });

    it("estimates non-failed generic tools as collapsed even when raw JSON exists", () => {
        const collapsedGenericTool = createToolRow({
            activity: createActivity({
                kind: "web_search",
                rawInputJson: "{\"query\":\"Dota 2\"}",
                rawOutputJson: "{\"ok\":true}",
                title: "Web search",
            }),
        });
        const failedGenericTool = createToolRow({
            activity: createActivity({
                kind: "web_search",
                rawInputJson: "{\"query\":\"Dota 2\"}",
                rawOutputJson: "{\"error\":\"network\"}",
                status: "failed",
                title: "Web search",
            }),
        });

        const collapsedHeight = estimateChatTimelineRowHeight(
            collapsedGenericTool,
            {
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                toolCardExpansionMode: "collapsed",
            },
        );
        const failedHeight = estimateChatTimelineRowHeight(failedGenericTool, {
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            toolCardExpansionMode: "collapsed",
        });

        expect(collapsedHeight).toBeLessThan(64);
        expect(failedHeight).toBeGreaterThan(collapsedHeight);
    });

    it("calculates scroll margin from the history offset inside the scroller", () => {
        const scrollContainer = {
            getBoundingClientRect: () => ({ top: 20 }) as DOMRect,
            scrollTop: 75,
        } as HTMLElement;

        expect(
            calculateChatTimelineVirtualScrollMarginTop({
                historyElement: createElementRect(45),
                scrollContainer,
            }),
        ).toBe(100);
        expect(
            calculateChatTimelineVirtualScrollMarginTop({
                historyElement: createElementRect(5),
                scrollContainer: {
                    ...scrollContainer,
                    scrollTop: 0,
                },
            }),
        ).toBe(0);
        expect(
            calculateChatTimelineVirtualScrollMarginTop({
                historyElement: null,
                scrollContainer,
            }),
        ).toBe(0);
    });

    it("changes row measurement keys when layout or row content changes", () => {
        const row = createMessageRow({ content: "hello" });
        const base = getChatTimelineRowMeasurementKey(row, {
            chatFontFamily: "Inter",
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            isLatestStreamingTool: false,
            toolCardExpansionMode: "collapsed",
            width: 640,
        });

        expect(
            getChatTimelineRowMeasurementKey(row, {
                chatFontFamily: "Inter",
                chatFontSize: 14,
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                isLatestStreamingTool: false,
                toolCardExpansionMode: "collapsed",
                width: 640,
            }),
        ).not.toBe(base);
        expect(
            getChatTimelineRowMeasurementKey(row, {
                chatFontFamily: "Inter",
                chatFontSize: 13,
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                isLatestStreamingTool: false,
                toolCardExpansionMode: "expanded",
                width: 640,
            }),
        ).not.toBe(base);
        expect(
            getChatTimelineRowMeasurementKey(row, {
                chatFontFamily: "Inter",
                chatFontSize: 13,
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                isLatestStreamingTool: false,
                toolCardExpansionMode: "collapsed",
                width: 672,
            }),
        ).not.toBe(base);
        expect(
            getChatTimelineRowMeasurementKey(row, {
                chatFontFamily: "Inter",
                chatFontSize: 13,
                gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                isLatestStreamingTool: false,
                toolCardExpansionMode: "collapsed",
                width: 641,
            }),
        ).toBe(base);
        expect(
            getChatTimelineRowMeasurementKey(
                createMessageRow({ content: "hello, changed" }),
                {
                    chatFontFamily: "Inter",
                    chatFontSize: 13,
                    gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
                    isLatestStreamingTool: false,
                    toolCardExpansionMode: "collapsed",
                    width: 640,
                },
            ),
        ).not.toBe(base);
    });

    it("keys tool rows independent of width but messages by width bucket", () => {
        const baseContext = {
            chatFontFamily: "Inter",
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            isLatestStreamingTool: false,
            toolCardExpansionMode: "collapsed" as const,
        };
        const toolRow = createToolRow();
        const messageRow = createMessageRow({ content: "hello" });

        expect(isWidthSensitiveChatTimelineRow(toolRow)).toBe(false);
        expect(isWidthSensitiveChatTimelineRow(messageRow)).toBe(true);

        // A tool card lays out at a width-invariant height, so crossing a width
        // bucket must NOT churn its measurement key — that is what kept the whole
        // cache from collapsing to estimates mid-resize.
        expect(
            getChatTimelineRowMeasurementKey(toolRow, {
                ...baseContext,
                width: 640,
            }),
        ).toBe(
            getChatTimelineRowMeasurementKey(toolRow, {
                ...baseContext,
                width: 960,
            }),
        );

        // A message reflows with width, so a bucket change still invalidates it.
        expect(
            getChatTimelineRowMeasurementKey(messageRow, {
                ...baseContext,
                width: 640,
            }),
        ).not.toBe(
            getChatTimelineRowMeasurementKey(messageRow, {
                ...baseContext,
                width: 960,
            }),
        );
    });

    it("keeps the identity key stable across width changes for one revision", () => {
        const baseContext = {
            chatFontFamily: "Inter",
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            isLatestStreamingTool: false,
            toolCardExpansionMode: "collapsed" as const,
        };
        const messageRow = createMessageRow({ content: "hello" });

        // The identity key carries a measured height over a resize, so it must
        // ignore the width even for a width-sensitive row...
        expect(
            getChatTimelineRowIdentityKey(messageRow, {
                ...baseContext,
                width: 640,
            }),
        ).toBe(
            getChatTimelineRowIdentityKey(messageRow, {
                ...baseContext,
                width: 960,
            }),
        );

        // ...but still react to a real layout change like the expansion mode.
        expect(
            getChatTimelineRowIdentityKey(messageRow, {
                ...baseContext,
                toolCardExpansionMode: "expanded",
                width: 640,
            }),
        ).not.toBe(
            getChatTimelineRowIdentityKey(messageRow, {
                ...baseContext,
                width: 640,
            }),
        );
    });

    it("buckets virtual measurement widths to reduce resize churn", () => {
        expect(getChatTimelineVirtualMeasurementWidth(0)).toBe(0);
        expect(getChatTimelineVirtualMeasurementWidth(Number.NaN)).toBe(0);
        expect(getChatTimelineVirtualMeasurementWidth(640)).toBe(648);
        expect(getChatTimelineVirtualMeasurementWidth(641)).toBe(648);
        expect(getChatTimelineVirtualMeasurementWidth(672)).toBe(672);
    });

    it("caps effective timeline content width at the timeline max", () => {
        expect(getChatTimelineEffectiveContentWidth(0)).toBe(0);
        expect(getChatTimelineEffectiveContentWidth(Number.NaN)).toBe(0);
        expect(getChatTimelineEffectiveContentWidth(320)).toBe(320);
        expect(
            getChatTimelineEffectiveContentWidth(
                CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
            ),
        ).toBe(CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX);
        expect(getChatTimelineEffectiveContentWidth(1200)).toBe(
            CHAT_TIMELINE_CONTENT_MAX_WIDTH_PX,
        );
    });

    it("keys measurement by row identity, not by content", () => {
        const context = {
            chatFontFamily: "Inter",
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            isLatestStreamingTool: false,
            toolCardExpansionMode: "collapsed" as const,
            width: 640,
        };
        const row = createMessageRow({ content: "original" });
        if (row.kind !== "message") {
            throw new Error("expected a message row");
        }

        const initialKey = getChatTimelineRowMeasurementKey(row, context);

        // The key is derived from the row's identity, so mutating the same
        // reference in place must NOT change it. Production rows are immutable
        // (the model swaps references on change), and the same reference is
        // never re-rendered, so its height cannot change either.
        (row.message as { content: string }).content = "mutated in place";
        expect(getChatTimelineRowMeasurementKey(row, context)).toBe(initialKey);

        // A fresh row object is a new identity, so its measurement is keyed
        // separately — changed content is reflected once the model allocates a
        // new reference.
        const replacedRow = createMessageRow({ content: "mutated in place" });
        expect(getChatTimelineRowMeasurementKey(replacedRow, context)).not.toBe(
            initialKey,
        );
    });

    it("invalidates the measurement key exactly when the model reconciles a new row reference", () => {
        const context = {
            chatFontFamily: "Inter",
            chatFontSize: 13,
            gapPx: CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
            isLatestStreamingTool: false,
            toolCardExpansionMode: "collapsed" as const,
            width: 640,
        };
        const reconcile = (summary: string, updatedAt: string) =>
            (previous: Parameters<typeof reconcileChatTimelineModel>[0]) =>
                reconcileChatTimelineModel(previous, {
                    messages: [],
                    status: "idle",
                    toolActivity: [
                        createActivity({ id: "tool-1", summary, updatedAt }),
                    ],
                    trackedFiles: [],
                });

        const model1 = reconcile("first", "2026-04-14T00:00:00.000Z")(null);
        const row1 = model1.historyRows[0];
        const key1 = row1 && getChatTimelineRowMeasurementKey(row1, context);

        // A real content change (the model sees a new updatedAt) allocates a
        // fresh row reference, so the measurement key must change.
        const model2 = reconcile("second", "2026-04-14T00:00:05.000Z")(model1);
        const row2 = model2.historyRows[0];
        expect(row2).not.toBe(row1);
        expect(row2 && getChatTimelineRowMeasurementKey(row2, context)).not.toBe(
            key1,
        );

        // An identical snapshot reuses the same reference, so the key is reused
        // and the measured height is kept.
        const model3 = reconcile("second", "2026-04-14T00:00:05.000Z")(model2);
        const row3 = model3.historyRows[0];
        expect(row3).toBe(row2);
        expect(row3 && getChatTimelineRowMeasurementKey(row3, context)).toBe(
            row2 && getChatTimelineRowMeasurementKey(row2, context),
        );
    });
});
