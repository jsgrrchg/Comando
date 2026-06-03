import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot, AiToolActivity, AiTrackedFile } from "@shared/ipc";

import type { ChatTimelineRow } from "./chatTimelineModel";
import {
    CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
    CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX,
    calculateChatTimelineVirtualScrollMarginTop,
    estimateChatTimelineRowHeight,
    getChatTimelineRowKey,
    getChatTimelineVirtualMeasurementKey,
    getChatTimelineVirtualRowGapPx,
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

        expect(getChatTimelineRowKey(row, 0)).toBe("message:message-42");
    });

    it("calculates measured row gaps without duplicating the parent gap", () => {
        expect(
            getChatTimelineVirtualRowGapPx({
                hasFollowingTimelineContent: false,
                index: 0,
                rowCount: 2,
            }),
        ).toBe(CHAT_TIMELINE_VIRTUAL_ROW_GAP_PX);
        expect(
            getChatTimelineVirtualRowGapPx({
                hasFollowingTimelineContent: false,
                index: 1,
                rowCount: 2,
            }),
        ).toBe(0);
        expect(
            getChatTimelineVirtualRowGapPx({
                hasFollowingTimelineContent: true,
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
                } as HTMLElement,
            }),
        ).toBe(0);
        expect(
            calculateChatTimelineVirtualScrollMarginTop({
                historyElement: null,
                scrollContainer,
            }),
        ).toBe(0);
    });

    it("changes the measurement key when layout-affecting inputs change", () => {
        const base = getChatTimelineVirtualMeasurementKey({
            chatFontFamily: "Inter",
            chatFontSize: 13,
            hasFollowingTimelineContent: false,
            latestStreamingEditedFileToolRowId: null,
            toolCardExpansionMode: "collapsed",
            width: 640,
        });

        expect(
            getChatTimelineVirtualMeasurementKey({
                chatFontFamily: "Inter",
                chatFontSize: 14,
                hasFollowingTimelineContent: false,
                latestStreamingEditedFileToolRowId: null,
                toolCardExpansionMode: "collapsed",
                width: 640,
            }),
        ).not.toBe(base);
        expect(
            getChatTimelineVirtualMeasurementKey({
                chatFontFamily: "Inter",
                chatFontSize: 13,
                hasFollowingTimelineContent: false,
                latestStreamingEditedFileToolRowId: null,
                toolCardExpansionMode: "expanded",
                width: 640,
            }),
        ).not.toBe(base);
        expect(
            getChatTimelineVirtualMeasurementKey({
                chatFontFamily: "Inter",
                chatFontSize: 13,
                hasFollowingTimelineContent: false,
                latestStreamingEditedFileToolRowId: null,
                toolCardExpansionMode: "collapsed",
                width: 641,
            }),
        ).not.toBe(base);
    });
});
