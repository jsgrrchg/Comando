import { describe, expect, it } from "vitest";

import {
    CHAT_INTERACTION_BUDGETS,
    CHAT_PERFORMANCE_FIXTURES,
    createChatPerformanceFixture,
    createChatPerformanceFixtureById,
    createChatPerformanceWorkspaceFixture,
    passesChatPerformanceGate,
} from "./chatPerformanceFixtures";

describe("chatPerformanceFixtures", () => {
    it("declares the long-chat datasets used by the performance plan", () => {
        expect(CHAT_PERFORMANCE_FIXTURES).toEqual([
            {
                id: "chat-short",
                messageCount: 30,
                toolActivityCount: 10,
                trackedFileCount: 2,
            },
            {
                id: "chat-long-10k",
                messageCount: 10_000,
                toolActivityCount: 0,
                trackedFileCount: 0,
            },
            {
                id: "chat-extreme-100k",
                messageCount: 100_000,
                toolActivityCount: 0,
                trackedFileCount: 0,
            },
            {
                id: "chat-tool-heavy",
                messageCount: 1_000,
                toolActivityCount: 20_000,
                trackedFileCount: 2_000,
            },
        ]);
    });

    it("creates deterministic snapshots with stable ids and review relationships", () => {
        const fixture = createChatPerformanceFixture({
            id: "deterministic",
            messageCount: 4,
            toolActivityCount: 3,
            trackedFileCount: 5,
        });
        const repeatedFixture = createChatPerformanceFixture({
            id: "deterministic",
            messageCount: 4,
            toolActivityCount: 3,
            trackedFileCount: 5,
        });

        expect(fixture).toEqual(repeatedFixture);
        expect(fixture.snapshot.messages.map((message) => message.id)).toEqual([
            "message-1",
            "message-2",
            "message-3",
            "message-4",
        ]);
        expect(fixture.snapshot.toolActivity.map((activity) => activity.id)).toEqual([
            "tool-1",
            "tool-2",
            "tool-3",
        ]);
        expect(
            fixture.snapshot.trackedFiles.map((file) => file.toolCallId),
        ).toEqual(["tool-1", "tool-2", "tool-3", "tool-1", "tool-2"]);
    });

    it("creates the configured stress fixtures only when explicitly requested", () => {
        const fixture = createChatPerformanceFixtureById("chat-long-10k");

        expect(fixture.snapshot.messages).toHaveLength(10_000);
        expect(fixture.snapshot.toolActivity).toHaveLength(0);
        expect(fixture.snapshot.trackedFiles).toHaveLength(0);
    });

    it("models the retained chats and concurrent streams of a multipane workspace", () => {
        const fixture = createChatPerformanceWorkspaceFixture();

        expect(fixture.panes).toHaveLength(4);
        expect(
            fixture.panes.every((pane) =>
                pane.retainedSessionIds.includes(pane.activeSessionId),
            ),
        ).toBe(true);
        expect(fixture.panes.flatMap((pane) => pane.retainedSessionIds)).toHaveLength(
            20,
        );
        expect(fixture.activeStreamingSessionIds).toEqual([
            "workspace-pane-1-session-1",
            "workspace-pane-2-session-1",
        ]);
    });

    it("defines deterministic structural budgets for extreme chats", () => {
        expect(CHAT_INTERACTION_BUDGETS).toEqual({
            activityInitialItems: 20,
            maxFullRebuildsDuringStreaming: 0,
            maxMountedRows: 80,
            transcriptBlockEntries: 256,
        });
    });

    it("closes the rollout gate only for bounded production metrics", () => {
        expect(
            passesChatPerformanceGate({
                fullRebuildsDuringStreaming: 0,
                mountedRows: 80,
                residentEntries: 256 * 3,
                residentPayloadBytes: 16 * 1024 * 1024,
            }),
        ).toBe(true);
        expect(
            passesChatPerformanceGate({
                fullRebuildsDuringStreaming: 1,
                mountedRows: 81,
                residentEntries: 100_000,
                residentPayloadBytes: 16 * 1024 * 1024 + 1,
            }),
        ).toBe(false);
    });
});
