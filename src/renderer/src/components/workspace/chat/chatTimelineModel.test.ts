import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot, AiToolActivity, AiTrackedFile } from "@shared/ipc";
import { buildAiSessionTranscriptModel } from "@renderer/app/ai/transcriptModel";

import {
    reconcileChatTimelineModel,
    reconcileChatTimelineModelFromTranscript,
} from "./chatTimelineModel";

function createMessage(
    overrides: Partial<AiSessionSnapshot["messages"][number]> = {},
): AiSessionSnapshot["messages"][number] {
    return {
        attachments: [],
        content: "",
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

describe("chatTimelineModel", () => {
    it("keeps history rows stable while the streaming tail mutates", () => {
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "hello",
                    id: "message-1",
                    kind: "user",
                }),
                createMessage({
                    content: "draft 1",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "message-2",
                    status: "streaming",
                }),
            ],
            status: "streaming",
            toolActivity: [],
            trackedFiles: [],
        });

        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [
                createMessage({
                    content: "hello",
                    id: "message-1",
                    kind: "user",
                }),
                createMessage({
                    content: "draft 2",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "message-2",
                    status: "streaming",
                }),
            ],
            status: "streaming",
            toolActivity: [],
            trackedFiles: [],
        });

        expect(nextModel.historyRows).toBe(initialModel.historyRows);
        expect(nextModel.historyRows[0]).toBe(initialModel.historyRows[0]);
        expect(nextModel.liveTailRow).not.toBe(initialModel.liveTailRow);
        expect(nextModel.liveTailRow?.id).toBe("message:message-2");
    });

    it("moves the live tail back into history once streaming finishes", () => {
        const streamingModel = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "hello",
                    id: "message-1",
                    kind: "user",
                }),
                createMessage({
                    content: "draft 2",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "message-2",
                    status: "streaming",
                }),
            ],
            status: "streaming",
            toolActivity: [],
            trackedFiles: [],
        });

        const completedModel = reconcileChatTimelineModel(streamingModel, {
            messages: [
                createMessage({
                    content: "hello",
                    id: "message-1",
                    kind: "user",
                }),
                createMessage({
                    content: "done",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "message-2",
                    status: "completed",
                }),
            ],
            status: "idle",
            toolActivity: [],
            trackedFiles: [],
        });

        expect(completedModel.liveTailRow).toBeNull();
        expect(completedModel.historyRows).toHaveLength(2);
        expect(completedModel.historyRows[0]).toBe(streamingModel.historyRows[0]);
        expect(completedModel.historyRows[1]?.id).toBe("message:message-2");
    });

    it("renders context compaction below the latest user message", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Message payload projected by runtime",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "compact-message",
                    kind: "user",
                }),
            ],
            status: "streaming",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "codex-acp:status:turn:turn-1",
                    kind: "status",
                    title: "New turn",
                    updatedAt: "2026-04-14T00:00:00.000Z",
                }),
                createActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "codex-acp:status:item:compact-1",
                    kind: "item_activity",
                    status: "in_progress",
                    title: "Compacting context",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "tool:codex-acp:status:turn:turn-1",
            "tool:codex-acp:status:item:compact-1",
            "message:compact-message",
        ]);
        expect(model.historyRowIds).toEqual([
            "tool:codex-acp:status:turn:turn-1",
            "message:compact-message",
        ]);
        expect(model.liveTailRowId).toBe(
            "tool:codex-acp:status:item:compact-1",
        );
    });

    it("does not revive completed context compaction as the live tail for a later prompt", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Prompt after compacting already finished",
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "message-after-compact",
                    kind: "user",
                }),
            ],
            status: "streaming",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "codex-acp:status:turn:turn-1",
                    kind: "status",
                    title: "New turn",
                    updatedAt: "2026-04-14T00:00:00.000Z",
                }),
                createActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "codex-acp:status:item:compact-1",
                    kind: "item_activity",
                    status: "completed",
                    title: "Compacting context",
                    updatedAt: "2026-04-14T00:00:02.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.liveTailRowId).toBe("message:message-after-compact");
    });

    it("reuses unchanged tool rows when only the latest tool activity changes", () => {
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "tool-1",
                    updatedAt: "2026-04-14T00:00:00.000Z",
                }),
                createActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "tool-2",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
            trackedFiles: [
                createTrackedFile({
                    identityKey: "tracked-1",
                    toolCallId: "tool-1",
                }),
                createTrackedFile({
                    identityKey: "tracked-2",
                    path: "src/secondary.ts",
                    toolCallId: "tool-2",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
        });

        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "idle",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "tool-1",
                    updatedAt: "2026-04-14T00:00:00.000Z",
                }),
                createActivity({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "tool-2",
                    summary: "Updated tail",
                    updatedAt: "2026-04-14T00:00:02.000Z",
                }),
            ],
            trackedFiles: [
                createTrackedFile({
                    identityKey: "tracked-1",
                    toolCallId: "tool-1",
                }),
                createTrackedFile({
                    identityKey: "tracked-2",
                    path: "src/secondary.ts",
                    toolCallId: "tool-2",
                    updatedAt: "2026-04-14T00:00:02.000Z",
                }),
            ],
        });

        expect(nextModel.orderedRows[0]).toBe(initialModel.orderedRows[0]);
        expect(nextModel.orderedRows[1]).not.toBe(initialModel.orderedRows[1]);
    });

    it("does not attach a pending tracked file to older edits with the same path", () => {
        const oldActivity = createActivity({
            createdAt: "2026-04-14T00:00:00.000Z",
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "old activity preview",
                    oldText: "before",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-old",
            title: "Edit src/app.ts",
        });
        const currentActivity = createActivity({
            createdAt: "2026-04-14T00:00:01.000Z",
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "current tracked file",
                    oldText: "before",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-current",
            title: "Edit src/app.ts",
            updatedAt: "2026-04-14T00:00:01.000Z",
        });

        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [oldActivity, currentActivity],
            trackedFiles: [
                createTrackedFile({
                    toolCallId: "tool-current",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
        });

        const oldRow = model.rowById.get("tool:tool-old");
        const currentRow = model.rowById.get("tool:tool-current");

        expect(oldRow?.kind).toBe("tool");
        expect(currentRow?.kind).toBe("tool");
        if (oldRow?.kind !== "tool" || currentRow?.kind !== "tool") {
            throw new Error("Expected tool rows.");
        }

        expect(oldRow.reviewEntry.trackedFiles).toHaveLength(0);
        expect(currentRow.reviewEntry.trackedFiles).toHaveLength(1);
    });

    it("builds live timeline rows from the normalized transcript", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "hello from transcript",
                    id: "message-transcript",
                    kind: "user",
                }),
            ],
            toolActivity: [
                createActivity({
                    id: "tool-transcript",
                    summary: "Tool from transcript",
                }),
            ],
        });

        const model = reconcileChatTimelineModelFromTranscript(null, {
            status: "idle",
            trackedFiles: [
                createTrackedFile({
                    identityKey: "tracked-transcript",
                    toolCallId: "tool-transcript",
                }),
            ],
            transcript,
        });

        expect(model.orderedRowIds).toEqual([
            "message:message-transcript",
            "tool:tool-transcript",
        ]);
        const messageRow = model.rowById.get("message:message-transcript");
        expect(messageRow?.kind).toBe("message");
        if (messageRow?.kind !== "message") {
            throw new Error("Expected transcript message row.");
        }
        expect(messageRow.message.content).toBe("hello from transcript");
        const toolRow = model.rowById.get("tool:tool-transcript");
        expect(toolRow?.kind).toBe("tool");
        if (toolRow?.kind !== "tool") {
            throw new Error("Expected transcript tool row.");
        }
        expect(toolRow.reviewEntry.pendingTrackedFiles).toHaveLength(1);
    });
});
