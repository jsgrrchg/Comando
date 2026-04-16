import { describe, expect, it } from "vitest";

import type { AiSessionSnapshot, AiToolActivity, AiTrackedFile } from "@shared/ipc";

import { reconcileChatTimelineModel } from "./chatTimelineModel";

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
});
