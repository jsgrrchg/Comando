import { beforeEach, describe, expect, it } from "vitest";
import type { AiSessionDomainEvent } from "@shared/ipc";
import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModelFromSnapshot,
} from "@renderer/app/ai/transcriptModel";
import { buildBlockNativeTranscriptProjection } from "@renderer/app/ai/transcriptWindowProjection";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
} from "@renderer/app/debug/chatPerformanceCounters";
import {
    reconcileChatTimelineModelFromProjection,
} from "./chatTimelineModel";

import {
    CHAT_INTERACTION_BUDGETS,
    CHAT_PERFORMANCE_FIXTURES,
    createBlockNativeStreamingPerformanceFixture,
    createChatPerformanceFixture,
    createChatPerformanceFixtureById,
    createChatPerformanceWorkspaceFixture,
    passesChatPerformanceGate,
} from "./chatPerformanceFixtures";

describe("chatPerformanceFixtures", () => {
    beforeEach(resetChatPerformanceCounters);

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
            maxSealedEntriesVisitedDuringStreaming: 0,
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
                sealedEntriesVisitedDuringStreaming: 0,
            }),
        ).toBe(true);
        expect(
            passesChatPerformanceGate({
                fullRebuildsDuringStreaming: 1,
                mountedRows: 81,
                residentEntries: 100_000,
                residentPayloadBytes: 16 * 1024 * 1024 + 1,
                sealedEntriesVisitedDuringStreaming: 1,
            }),
        ).toBe(false);
    });

    it("measures the production block-native path instead of trusting literal gate values", () => {
        const fixture = createBlockNativeStreamingPerformanceFixture();
        expect(fixture.metadata).toHaveLength(3);
        expect(
            [...fixture.blocksById.values()].map(
                (block) => block.entries.length,
            ),
        ).toEqual([256, 256, 256]);

        let liveTranscript = buildAiSessionTranscriptModelFromSnapshot(
            fixture.snapshot,
        );
        let projection = buildBlockNativeTranscriptProjection(
            liveTranscript,
            fixture.blocksById,
            fixture.metadata,
            fixture.payloadsByRef,
        );
        let timeline = reconcileChatTimelineModelFromProjection(null, null, {
            activeTurnStartedAt: fixture.snapshot.activeTurnStartedAt,
            projection,
            status: fixture.snapshot.status,
            trackedFiles: fixture.snapshot.trackedFiles,
            updatedAt: fixture.snapshot.updatedAt,
        });
        resetChatPerformanceCounters();

        let content = "";
        for (let index = 0; index < fixture.deltaCount; index += 1) {
            content += index % 20 === 19 ? "\n" : "x";
            liveTranscript = applyAiSessionDomainEventToTranscript(
                liveTranscript,
                {
                    content,
                    delta: content.at(-1) ?? "",
                    kind: "message-delta",
                    messageId: "streaming-assistant",
                    messageKind: "assistant",
                    origin: "live",
                    parentSessionId: null,
                    runtimeId: fixture.snapshot.runtimeId,
                    runtimeSessionId: fixture.snapshot.runtimeSessionId,
                    sessionId: fixture.snapshot.sessionId,
                    updatedAt: new Date(
                        Date.parse(fixture.snapshot.updatedAt) + index + 1,
                    ).toISOString(),
                } satisfies AiSessionDomainEvent,
            );
            const nextProjection = buildBlockNativeTranscriptProjection(
                liveTranscript,
                fixture.blocksById,
                fixture.metadata,
                fixture.payloadsByRef,
                projection,
            );
            timeline = reconcileChatTimelineModelFromProjection(
                timeline,
                projection,
                {
                    activeTurnStartedAt: fixture.snapshot.activeTurnStartedAt,
                    projection: nextProjection,
                    status: fixture.snapshot.status,
                    trackedFiles: fixture.snapshot.trackedFiles,
                    updatedAt: fixture.snapshot.updatedAt,
                },
            );
            projection = nextProjection;
        }

        const counters = readChatPerformanceCounters();
        const residentEntries = [...fixture.blocksById.values()].reduce(
            (total, block) => total + block.entries.length,
            0,
        );
        expect(counters.timeline_full_rebuilds).toBe(0);
        expect(counters.stable_history_entries_visited).toBe(0);
        expect(
            timeline.atomicLiveTailRow?.kind === "message"
                ? timeline.atomicLiveTailRow.message.content
                : null,
        ).toBe(content);
        expect(
            passesChatPerformanceGate({
                fullRebuildsDuringStreaming:
                    counters.timeline_full_rebuilds,
                mountedRows: 80,
                residentEntries,
                residentPayloadBytes: 0,
                sealedEntriesVisitedDuringStreaming:
                    counters.stable_history_entries_visited,
            }),
        ).toBe(true);
    });
});
