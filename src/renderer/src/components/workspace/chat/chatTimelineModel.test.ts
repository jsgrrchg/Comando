import { describe, expect, it } from "vitest";

import type {
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiToolActivity,
    AiTrackedFile,
} from "@shared/ipc";
import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModel,
} from "@renderer/app/ai/transcriptModel";
import {
    readChatPerformanceCounters,
    resetChatPerformanceCounters,
} from "@renderer/app/debug/chatPerformanceCounters";

import {
    getChatTimelineReconciliationDiagnostics,
    reconcileChatTimelineModel,
    reconcileChatTimelineModelIncrementallyFromTranscript,
    reconcileChatTimelineModelFromTranscript,
    resetChatTimelineReconciliationDiagnosticsForTests,
} from "./chatTimelineModel";
import {
    getChatTimelineRowMeasurementKey,
} from "./chatTimelineVirtualization";
import { flattenTranscriptTimelineItems } from "./transcriptBlockVirtualization";

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

function createReadActivity(
    id: string,
    createdAt: string,
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return createActivity({
        createdAt,
        id,
        kind: "read",
        rawInputJson: JSON.stringify({ file_path: `src/${id}.ts` }),
        title: `Read src/${id}.ts`,
        updatedAt: createdAt,
        ...overrides,
    });
}

function createSessionEvent(
    overrides: Partial<AiSessionDomainEvent> & {
        readonly kind: AiSessionDomainEvent["kind"];
    },
): AiSessionDomainEvent {
    const { kind, ...rest } = overrides;
    return {
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...rest,
        kind,
    } as AiSessionDomainEvent;
}

describe("chatTimelineModel", () => {
    it("counts full reconciliation and rebuilt activity segments", () => {
        resetChatPerformanceCounters();

        reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createReadActivity(
                    "read-1",
                    "2026-04-14T00:00:01.000Z",
                ),
            ],
            trackedFiles: [],
        });

        expect(readChatPerformanceCounters()).toMatchObject({
            activity_segments_rebuilt: 1,
            timeline_full_rebuilds: 1,
            timeline_rows_reconciled: 1,
        });
    });

    it("patches an assistant live tail incrementally while preserving earlier rows", () => {
        const trackedFiles: AiTrackedFile[] = [];
        const initialTranscript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Inspect the timeline",
                    id: "user-1",
                    kind: "user",
                }),
                createMessage({
                    content: "Draft",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                    status: "streaming",
                }),
            ],
            toolActivity: [],
        });
        const initialModel = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles,
            transcript: initialTranscript,
        });
        const updatedTranscript = applyAiSessionDomainEventToTranscript(
            initialTranscript,
            createSessionEvent({
                content: "Draft with streamed tail",
                delta: " with streamed tail",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        resetChatTimelineReconciliationDiagnosticsForTests();
        resetChatPerformanceCounters();
        const incrementalModel =
            reconcileChatTimelineModelIncrementallyFromTranscript(
                initialModel,
                initialTranscript,
                {
                    status: "streaming",
                    trackedFiles,
                    transcript: updatedTranscript,
                },
            );
        const incrementalCounters = readChatPerformanceCounters();
        const fullModel = reconcileChatTimelineModelFromTranscript(
            initialModel,
            {
                status: "streaming",
                trackedFiles,
                transcript: updatedTranscript,
            },
        );

        expect(incrementalModel.historyRows[0]).toBe(
            initialModel.historyRows[0],
        );
        expect(incrementalModel.historyRows).toBe(initialModel.historyRows);
        expect(incrementalModel.liveTailRow).toEqual(fullModel.liveTailRow);
        expect(incrementalModel.orderedRowIds).toEqual(fullModel.orderedRowIds);
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 0,
            incrementalCount: 1,
        });
        expect(incrementalCounters).toMatchObject({
            timeline_full_rebuilds: 0,
            timeline_rows_reconciled: 1,
            timeline_tail_patches: 1,
        });
    });

    it("appends a chronological assistant row outside the virtual timeline", () => {
        const trackedFiles: AiTrackedFile[] = [];
        const initialTranscript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Inspect the timeline",
                    id: "user-1",
                    kind: "user",
                }),
            ],
            toolActivity: [],
        });
        const initialModel = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles,
            transcript: initialTranscript,
        });
        const updatedTranscript = applyAiSessionDomainEventToTranscript(
            initialTranscript,
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    content: "",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                    status: "streaming",
                }),
                messageKind: "assistant",
            }),
        );

        resetChatTimelineReconciliationDiagnosticsForTests();
        const incrementalModel =
            reconcileChatTimelineModelIncrementallyFromTranscript(
                initialModel,
                initialTranscript,
                {
                    status: "streaming",
                    trackedFiles,
                    transcript: updatedTranscript,
                },
            );

        expect(incrementalModel.historyRows[0]).toBe(
            initialModel.historyRows[0],
        );
        expect(incrementalModel.historyRows).toBe(initialModel.historyRows);
        expect(incrementalModel.liveTailRow?.id).toBe("message:assistant-1");
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 0,
            incrementalCount: 1,
        });
    });

    it("appends one tool to a 2k active segment without rebuilding prior tools", () => {
        const initialTools = Array.from({ length: 2_000 }, (_, index) =>
            createActivity({
                changeStats: {
                    additions: 1,
                    approximate: false,
                    deletions: 0,
                    fileCount: 1,
                },
                createdAt: `2026-04-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
                id: `tool-${index + 1}`,
                kind: "read",
                title: "Read generated output",
                updatedAt: `2026-04-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
            }),
        );
        const initialTranscript = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: initialTools,
        });
        const initialModel = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles: [],
            transcript: initialTranscript,
        });
        const initialSegment = initialModel.liveTailRow;
        if (initialSegment?.kind !== "activity-segment") {
            throw new Error("Expected the initial tools to form one segment.");
        }
        const initialItems = flattenTranscriptTimelineItems(
            initialModel.orderedRows,
            {
                defaultExpanded: true,
                expansionByGroupId: {
                    [initialSegment.id]: {
                        expanded: true,
                        expandedRangeStarts: [0],
                    },
                },
            },
        );
        const firstInitialEntry = initialItems.find(
            (item) => item.kind === "activity-entry",
        );
        if (!firstInitialEntry) {
            throw new Error("Expected the initial segment to expose tool entries.");
        }
        const measurementContext = { width: 960 };
        const initialMeasurementKey = getChatTimelineRowMeasurementKey(
            firstInitialEntry,
            measurementContext,
        );
        const appendedTool = createActivity({
            changeStats: {
                additions: 7,
                approximate: false,
                deletions: 2,
                fileCount: 1,
            },
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "tool-2001",
            kind: "edit",
            title: "Edit compact payload",
            updatedAt: "2026-04-14T00:01:00.000Z",
        });
        const updatedTranscript = applyAiSessionDomainEventToTranscript(
            initialTranscript,
            createSessionEvent({
                activity: appendedTool,
                kind: "tool-activity",
            }),
        );

        resetChatTimelineReconciliationDiagnosticsForTests();
        resetChatPerformanceCounters();
        const updatedModel = reconcileChatTimelineModelIncrementallyFromTranscript(
            initialModel,
            initialTranscript,
            {
                status: "streaming",
                trackedFiles: [],
                transcript: updatedTranscript,
            },
        );
        const updatedSegment = updatedModel.liveTailRow;
        if (updatedSegment?.kind !== "activity-segment") {
            throw new Error("Expected the appended tool to remain in the active segment.");
        }
        const updatedItems = flattenTranscriptTimelineItems(
            updatedModel.orderedRows,
            {
                defaultExpanded: true,
                expansionByGroupId: {
                    [updatedSegment.id]: {
                        expanded: true,
                        expandedRangeStarts: [0],
                    },
                },
            },
        );
        const firstUpdatedEntry = updatedItems.find(
            (item) => item.kind === "activity-entry",
        );
        if (!firstUpdatedEntry) {
            throw new Error("Expected the updated segment to expose tool entries.");
        }

        expect(updatedSegment.id).toBe(initialSegment.id);
        expect(updatedSegment.entries).toHaveLength(2_001);
        expect(updatedSegment.entries.slice(0, -1)).toEqual(initialSegment.entries);
        expect(updatedSegment.items.slice(0, -1)).toEqual(initialSegment.items);
        expect(updatedSegment.changeStats).toEqual({
            additions: 2_007,
            approximate: true,
            deletions: 2,
        });
        expect(getChatTimelineRowMeasurementKey(firstUpdatedEntry, measurementContext)).toBe(
            initialMeasurementKey,
        );
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 0,
            incrementalCount: 1,
        });
        expect(readChatPerformanceCounters()).toMatchObject({
            activity_segments_rebuilt: 1,
            timeline_full_rebuilds: 0,
            timeline_rows_reconciled: 1,
            timeline_tail_patches: 1,
        });
    });

    it("rebuilds when multiple appends arrive before the previous model commits", () => {
        const trackedFiles: AiTrackedFile[] = [];
        const initialTranscript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Generate two outputs",
                    id: "user-1",
                    kind: "user",
                }),
            ],
            toolActivity: [],
        });
        const initialModel = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles,
            transcript: initialTranscript,
        });
        const transcriptWithAssistant = applyAiSessionDomainEventToTranscript(
            initialTranscript,
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    content: "Preparing image",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                    status: "streaming",
                }),
                messageKind: "assistant",
            }),
        );
        const updatedTranscript = applyAiSessionDomainEventToTranscript(
            transcriptWithAssistant,
            createSessionEvent({
                kind: "image-generation",
                message: createMessage({
                    content: "Generated image",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "image-1",
                    kind: "image",
                    status: "streaming",
                }),
            }),
        );

        resetChatTimelineReconciliationDiagnosticsForTests();
        const reconciled =
            reconcileChatTimelineModelIncrementallyFromTranscript(
                initialModel,
                initialTranscript,
                {
                    status: "streaming",
                    trackedFiles,
                    transcript: updatedTranscript,
                },
            );
        const rebuilt = reconcileChatTimelineModelFromTranscript(initialModel, {
            status: "streaming",
            trackedFiles,
            transcript: updatedTranscript,
        });

        expect(reconciled.orderedRowIds).toEqual(rebuilt.orderedRowIds);
        expect(reconciled.orderedRowIds).toEqual([
            "message:user-1",
            "message:assistant-1",
            "message:image-1",
        ]);
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 1,
            incrementalCount: 0,
        });
    });

    it("keeps preceding rows stable across one thousand live-tail deltas", () => {
        const trackedFiles: AiTrackedFile[] = [];
        let transcript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    content: "Inspect the timeline",
                    id: "user-1",
                    kind: "user",
                }),
                createMessage({
                    content: "",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                    status: "streaming",
                }),
            ],
            toolActivity: [],
        });
        let timeline = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles,
            transcript,
        });
        const initialHistoryRows = timeline.historyRows;

        resetChatTimelineReconciliationDiagnosticsForTests();
        for (let index = 1; index <= 1_000; index += 1) {
            const nextTranscript = applyAiSessionDomainEventToTranscript(
                transcript,
                createSessionEvent({
                    content: `Streamed token ${index}`,
                    delta: ` ${index}`,
                    kind: "message-delta",
                    messageId: "assistant-1",
                    messageKind: "assistant",
                    updatedAt: `2026-04-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
                }),
            );
            timeline = reconcileChatTimelineModelIncrementallyFromTranscript(
                timeline,
                transcript,
                {
                    status: "streaming",
                    trackedFiles,
                    transcript: nextTranscript,
                },
            );
            transcript = nextTranscript;
        }

        expect(timeline.historyRows[0]).toBe(initialHistoryRows[0]);
        expect(timeline.historyRows).toBe(initialHistoryRows);
        expect(timeline.liveTailRow?.id).toBe("message:assistant-1");
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 0,
            incrementalCount: 1_000,
        });
    });

    it("falls back to full reconciliation for an out-of-order transcript entry", () => {
        const trackedFiles: AiTrackedFile[] = [];
        const initialTranscript = buildAiSessionTranscriptModel({
            messages: [
                createMessage({
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-2",
                    status: "streaming",
                }),
            ],
            toolActivity: [],
        });
        const initialModel = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles,
            transcript: initialTranscript,
        });
        const updatedTranscript = applyAiSessionDomainEventToTranscript(
            initialTranscript,
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "assistant-1",
                    status: "completed",
                }),
                messageKind: "assistant",
            }),
        );

        resetChatTimelineReconciliationDiagnosticsForTests();
        const incrementalModel =
            reconcileChatTimelineModelIncrementallyFromTranscript(
                initialModel,
                initialTranscript,
                {
                    status: "streaming",
                    trackedFiles,
                    transcript: updatedTranscript,
                },
            );
        const fullModel = reconcileChatTimelineModelFromTranscript(
            initialModel,
            {
                status: "streaming",
                trackedFiles,
                transcript: updatedTranscript,
            },
        );

        expect(incrementalModel.orderedRowIds).toEqual(fullModel.orderedRowIds);
        expect(getChatTimelineReconciliationDiagnostics()).toEqual({
            fallbackCount: 1,
            incrementalCount: 0,
        });
    });

    it("keeps preceding rows stable while the streaming tail mutates", () => {
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

        expect(nextModel.historyRows[0]).toBe(initialModel.historyRows[0]);
        expect(nextModel.historyRows).toBe(initialModel.historyRows);
        expect(nextModel.liveTailRow).not.toBe(initialModel.liveTailRow);
        expect(nextModel.liveTailRow?.id).toBe("message:message-2");
    });

    it("retains the completed tail outside virtual history until the next turn", () => {
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
        expect(completedModel.historyRows).toHaveLength(1);
        expect(completedModel.historyRows[0]).toBe(streamingModel.historyRows[0]);
        expect(completedModel.retainedTailRow?.id).toBe("message:message-2");

        const nextTurnModel = reconcileChatTimelineModel(completedModel, {
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
                createMessage({
                    content: "continue",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "message-3",
                    kind: "user",
                    status: "streaming",
                }),
            ],
            status: "starting",
            toolActivity: [],
            trackedFiles: [],
        });

        expect(nextTurnModel.retainedTailRow).toBeNull();
        expect(nextTurnModel.historyRowIds).toEqual([
            "message:message-1",
            "message:message-2",
            "message:message-3",
        ]);
    });

    it("keeps the latest user message in history when agent activity starts", () => {
        const userOnlyModel = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Inspect the timeline",
                    id: "message-1",
                    kind: "user",
                }),
            ],
            status: "starting",
            toolActivity: [],
            trackedFiles: [],
        });

        const activityModel = reconcileChatTimelineModel(userOnlyModel, {
            messages: [
                createMessage({
                    content: "Inspect the timeline",
                    id: "message-1",
                    kind: "user",
                }),
            ],
            status: "streaming",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z", {
                    status: "in_progress",
                }),
            ],
            trackedFiles: [],
        });

        expect(userOnlyModel.liveTailRow).toBeNull();
        expect(userOnlyModel.historyRowIds).toEqual(["message:message-1"]);
        expect(activityModel.historyRows[0]).toBe(userOnlyModel.historyRows[0]);
        expect(activityModel.liveTailRowId).toBe(
            "activity-segment:session-1:read-1",
        );
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
            activeTurnStartedAt: "2026-04-14T00:00:00.000Z",
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
            "tool:session-1:codex-acp:status:item:compact-1",
            "message:compact-message",
        ]);
        expect(model.historyRowIds).toEqual([
            "message:compact-message",
        ]);
        expect(model.liveTailRowId).toBe(
            "tool:session-1:codex-acp:status:item:compact-1",
        );
    });

    it("does not show the active turn divider for the first local user message", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Implement the fix",
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "local-prompt-1",
                    kind: "user",
                }),
            ],
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            status: "starting",
            toolActivity: [],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual(["message:local-prompt-1"]);
    });

    it("does not show the first turn divider after the runtime echo completes", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "What do you want to try?",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-greeting",
                    kind: "assistant",
                }),
                createMessage({
                    content: "Implement the fix",
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "local-prompt-1",
                    kind: "user",
                }),
                createMessage({
                    content: "Done",
                    createdAt: "2026-04-14T00:00:04.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                }),
            ],
            activeTurnStartedAt: null,
            status: "idle",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "codex-acp:status:turn:first-turn",
                    kind: "status",
                    title: "New turn",
                    updatedAt: "2026-04-14T00:00:03.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "message:assistant-greeting",
            "message:local-prompt-1",
            "message:assistant-1",
        ]);
    });

    it("keeps the active turn boundary internal for later user messages", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "First prompt",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "first-prompt",
                    kind: "user",
                }),
                createMessage({
                    content: "Previous answer",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                }),
                createMessage({
                    content: "Implement the fix",
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "local-prompt-1",
                    kind: "user",
                }),
            ],
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            status: "starting",
            toolActivity: [],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "message:first-prompt",
            "message:assistant-1",
            "message:local-prompt-1",
        ]);
        expect(
            model.orderedAtomicRowIds,
        ).toContain(
            "tool:local-prompt-1:comando:status:turn:local:2026-04-14T00:00:03.000Z",
        );
    });

    it("deduplicates runtime turn dividers while keeping the local turn anchor", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "First prompt",
                    createdAt: "2026-04-14T00:00:01.000Z",
                    id: "first-prompt",
                    kind: "user",
                }),
                createMessage({
                    content: "Previous answer",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                }),
                createMessage({
                    content: "Implement the fix",
                    createdAt: "2026-04-14T00:00:03.000Z",
                    id: "local-prompt-1",
                    kind: "user",
                }),
            ],
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            status: "streaming",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:04.000Z",
                    id: "codex-acp:status:turn:runtime-turn-1",
                    kind: "status",
                    title: "New turn",
                    updatedAt: "2026-04-14T00:00:04.000Z",
                }),
                createActivity({
                    createdAt: "2026-04-14T00:00:05.000Z",
                    id: "tool-1",
                    kind: "shell",
                    title: "Run tests",
                    updatedAt: "2026-04-14T00:00:05.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "message:first-prompt",
            "message:assistant-1",
            "message:local-prompt-1",
            "activity-segment:session-1:tool-1",
        ]);
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
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
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

        expect(model.liveTailRowId).toBeNull();
        expect(model.historyRowIds).toEqual([
            "tool:session-1:codex-acp:status:item:compact-1",
            "message:message-after-compact",
        ]);
    });

    it("does not revive stale in-progress context compaction from an earlier turn", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Prompt after stale compacting activity",
                    createdAt: "2026-04-14T00:00:04.000Z",
                    id: "message-after-stale-compact",
                    kind: "user",
                }),
            ],
            activeTurnStartedAt: "2026-04-14T00:00:03.000Z",
            status: "streaming",
            toolActivity: [
                createActivity({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "codex-acp:status:item:compact-1",
                    kind: "item_activity",
                    status: "in_progress",
                    title: "Compacting context",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.liveTailRowId).toBeNull();
        expect(model.historyRowIds).toEqual([
            "tool:session-1:codex-acp:status:item:compact-1",
            "message:message-after-stale-compact",
        ]);
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

        expect(nextModel.atomicRowById.get("tool:session-1:tool-1")).toBe(
            initialModel.atomicRowById.get("tool:session-1:tool-1"),
        );
        expect(nextModel.atomicRowById.get("tool:session-1:tool-2")).not.toBe(
            initialModel.atomicRowById.get("tool:session-1:tool-2"),
        );
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

        const oldRow = model.atomicRowById.get(
            "tool:session-1:tool-old",
        );
        const currentRow = model.atomicRowById.get(
            "tool:session-1:tool-current",
        );

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
            "activity-segment:session-1:tool-transcript",
        ]);
        const messageRow = model.presentationRowById.get(
            "message:message-transcript",
        );
        expect(messageRow?.kind).toBe("message");
        if (messageRow?.kind !== "message") {
            throw new Error("Expected transcript message row.");
        }
        expect(messageRow.message.content).toBe("hello from transcript");
        const toolRow = model.atomicRowById.get(
            "tool:session-1:tool-transcript",
        );
        expect(toolRow?.kind).toBe("tool");
        if (toolRow?.kind !== "tool") {
            throw new Error("Expected transcript tool row.");
        }
        expect(toolRow.reviewEntry.pendingTrackedFiles).toHaveLength(1);
    });
});

describe("chatTimelineModel activity segments", () => {
    it("keeps thinking and surrounding tools in one chronological segment", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "I should inspect the implementation.",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "thinking-1",
                    kind: "thinking",
                }),
            ],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:03.000Z"),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRows).toHaveLength(1);
        const segment = model.orderedRows[0];
        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind !== "activity-segment") {
            throw new Error("Expected an activity segment row.");
        }
        expect(segment.items.map((item) => item.kind)).toEqual([
            "tool",
            "thinking",
            "tool",
        ]);
        expect(segment.entries).toHaveLength(2);
        expect(segment.summary.actionCount).toBe(2);
        expect(segment.changeStats).toEqual({
            additions: 0,
            approximate: false,
            deletions: 0,
        });
    });

    it("keeps a thinking-first segment stable when the first tool arrives", () => {
        const thinking = createMessage({
            content: "Inspecting the project.",
            createdAt: "2026-04-14T00:00:01.000Z",
            id: "thinking-1",
            kind: "thinking",
            status: "streaming",
        });
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [thinking],
            status: "streaming",
            toolActivity: [],
            trackedFiles: [],
        });
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [{ ...thinking, status: "completed" }],
            status: "streaming",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:02.000Z"),
            ],
            trackedFiles: [],
        });

        expect(initialModel.orderedRowIds).toEqual([
            "activity-segment:thinking:thinking-1",
        ]);
        expect(nextModel.orderedRowIds).toEqual(initialModel.orderedRowIds);
        expect(nextModel.liveTailRowId).toBe(
            "activity-segment:thinking:thinking-1",
        );
        const segment = nextModel.orderedRows[0];
        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind === "activity-segment") {
            expect(segment.items.map((item) => item.kind)).toEqual([
                "thinking",
                "tool",
            ]);
            expect(segment.summary.actionCount).toBe(1);
        }
    });

    it("still uses assistant messages as activity boundaries", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "I will inspect the next file.",
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-1",
                }),
            ],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:03.000Z"),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
            "message:assistant-1",
            "activity-segment:session-1:read-2",
        ]);
    });

    it("compacts a burst of fifty observations into one presentation row", () => {
        const activities = Array.from({ length: 50 }, (_, index) =>
            createReadActivity(
                `read-${index + 1}`,
                `2026-04-14T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
            ),
        );
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: activities,
            trackedFiles: [],
        });

        expect(model.orderedAtomicRows).toHaveLength(50);
        expect(model.orderedRows).toHaveLength(1);
        expect(model.historyRows).toHaveLength(1);
        const segment = model.orderedRows[0];
        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind === "activity-segment") {
            expect(segment.entries).toHaveLength(50);
            expect(segment.summary.actionCount).toBe(50);
            expect(segment.summary.hiddenActivityCount).toBe(50);
        }
    });

    it("creates a stable single-member segment with a semantic summary", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
            ],
            trackedFiles: [],
        });

        expect(model.orderedAtomicRowIds).toEqual([
            "tool:session-1:read-1",
        ]);
        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const segment = model.orderedRows[0];
        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind !== "activity-segment") {
            throw new Error("Expected an activity segment row.");
        }
        expect(
            segment.entries.map((entry) => entry.reviewEntry.activity.id),
        ).toEqual(["read-1"]);
        expect(segment.summary).toMatchObject({
            actionCount: 1,
            commandCount: 0,
            fileCount: 1,
            latestActivityId: "read-1",
            searchCount: 0,
        });
    });

    it("keeps the segment id stable while appending members", () => {
        const first = createReadActivity(
            "read-1",
            "2026-04-14T00:00:01.000Z",
        );
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "streaming",
            toolActivity: [first],
            trackedFiles: [],
        });
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "streaming",
            toolActivity: [
                first,
                createReadActivity(
                    "read-2",
                    "2026-04-14T00:00:02.000Z",
                ),
            ],
            trackedFiles: [],
        });

        expect(nextModel.orderedRowIds).toEqual(
            initialModel.orderedRowIds,
        );
        expect(nextModel.orderedRows[0]).not.toBe(initialModel.orderedRows[0]);
        expect(nextModel.orderedRows[0]?.kind).toBe("activity-segment");
        if (nextModel.orderedRows[0]?.kind === "activity-segment") {
            expect(nextModel.orderedRows[0].summary.actionCount).toBe(2);
        }
    });

    it("cuts segments at messages, structural rows, and session changes", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    createdAt: "2026-04-14T00:00:02.000Z",
                    id: "assistant-boundary",
                }),
            ],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:03.000Z"),
                createActivity({
                    createdAt: "2026-04-14T00:00:04.000Z",
                    id: "status-1",
                    kind: "status",
                    title: "Status",
                    updatedAt: "2026-04-14T00:00:04.000Z",
                }),
                createReadActivity("read-3", "2026-04-14T00:00:05.000Z"),
                createActivity({
                    createdAt: "2026-04-14T00:00:06.000Z",
                    id: "edit-1",
                    kind: "edit",
                    updatedAt: "2026-04-14T00:00:06.000Z",
                }),
                createReadActivity("read-4", "2026-04-14T00:00:07.000Z"),
                createReadActivity("failed-1", "2026-04-14T00:00:08.000Z", {
                    status: "failed",
                }),
                createReadActivity("read-5", "2026-04-14T00:00:09.000Z"),
                createActivity({
                    createdAt: "2026-04-14T00:00:10.000Z",
                    id: "unknown-1",
                    kind: "other",
                    updatedAt: "2026-04-14T00:00:10.000Z",
                }),
                createReadActivity("read-6", "2026-04-14T00:00:11.000Z", {
                    sessionId: "session-2",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
            "message:assistant-boundary",
            "activity-segment:session-1:read-2",
            "tool:session-1:status-1",
            "activity-segment:session-1:read-3",
            "activity-segment:session-2:read-6",
        ]);
        const mixedSegment = model.orderedRows[4];
        expect(mixedSegment?.kind).toBe("activity-segment");
        if (mixedSegment?.kind === "activity-segment") {
            expect(mixedSegment.entries.map((entry) => entry.policy)).toEqual([
                "groupable",
                "standalone-change",
                "groupable",
                "standalone-attention",
                "groupable",
                "groupable",
            ]);
        }
    });

    it("separates consecutive groupable activity from different sessions", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:02.000Z", {
                    sessionId: "session-2",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
            "activity-segment:session-2:read-2",
        ]);
    });

    it("keeps repeated tool ids distinct across sessions", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "streaming",
            toolActivity: [
                createReadActivity("shared-id", "2026-04-14T00:00:01.000Z"),
                createReadActivity(
                    "shared-id",
                    "2026-04-14T00:00:02.000Z",
                    { sessionId: "session-2", status: "in_progress" },
                ),
            ],
            trackedFiles: [],
        });

        expect(model.orderedAtomicRowIds).toEqual([
            "tool:session-1:shared-id",
            "tool:session-2:shared-id",
        ]);
        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:shared-id",
            "activity-segment:session-2:shared-id",
        ]);
        expect(model.liveTailRowId).toBe(
            "activity-segment:session-2:shared-id",
        );
    });

    it("preserves repeated cross-session tool ids through the transcript", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [
                createReadActivity("shared-id", "2026-04-14T00:00:01.000Z"),
                createReadActivity(
                    "shared-id",
                    "2026-04-14T00:00:02.000Z",
                    { sessionId: "session-2", status: "in_progress" },
                ),
            ],
        });
        const model = reconcileChatTimelineModelFromTranscript(null, {
            status: "streaming",
            trackedFiles: [],
            transcript,
        });

        expect(model.orderedAtomicRowIds).toEqual([
            "tool:session-1:shared-id",
            "tool:session-2:shared-id",
        ]);
        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:shared-id",
            "activity-segment:session-2:shared-id",
        ]);
        expect(model.liveTailRowId).toBe(
            "activity-segment:session-2:shared-id",
        );
    });

    it("keeps a late diff visible inside its original segment", () => {
        const activities = [
            createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
            createReadActivity("read-2", "2026-04-14T00:00:02.000Z"),
            createReadActivity("read-3", "2026-04-14T00:00:03.000Z"),
        ];
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: activities,
            trackedFiles: [],
        });
        const updatedMiddle = createReadActivity(
            "read-2",
            "2026-04-14T00:00:02.000Z",
            {
                diffs: [
                    {
                        hunks: [],
                        isText: true,
                        kind: "update",
                        newText: "next",
                        oldText: "previous",
                        path: "src/read-2.ts",
                        previousPath: null,
                        reversible: true,
                    },
                ],
                updatedAt: "2026-04-14T00:00:04.000Z",
            },
        );
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "idle",
            toolActivity: [activities[0], updatedMiddle, activities[2]],
            trackedFiles: [],
        });

        expect(nextModel.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        expect(
            nextModel.orderedRows.flatMap((row) =>
                row.kind === "activity-segment"
                    ? row.entries.map(
                          (entry) => entry.reviewEntry.activity.id,
                      )
                    : row.kind === "tool"
                      ? [row.reviewEntry.activity.id]
                      : [],
            ),
        ).toEqual(["read-1", "read-2", "read-3"]);
        const segment = nextModel.orderedRows[0];
        if (segment?.kind === "activity-segment") {
            expect(segment.entries[1]?.policy).toBe("standalone-change");
        }
    });

    it("keeps a change visible inside exploration and verification activity", () => {
        const diffActivity = createActivity({
            createdAt: "2026-04-14T00:00:03.000Z",
            diffs: [
                {
                    hunks: [],
                    isText: true,
                    kind: "update",
                    newText: "next",
                    oldText: "previous",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "edit-1",
            kind: "edit",
            title: "Edit src/app.ts",
            updatedAt: "2026-04-14T00:00:03.000Z",
        });
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:02.000Z"),
                diffActivity,
                createActivity({
                    createdAt: "2026-04-14T00:00:04.000Z",
                    exitCode: 0,
                    id: "test-1",
                    kind: "execute",
                    status: "completed",
                    title: "Run tests",
                    updatedAt: "2026-04-14T00:00:04.000Z",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const segment = model.orderedRows[0];
        if (segment?.kind === "activity-segment") {
            expect(segment.entries[2]?.policy).toBe("standalone-change");
            expect(segment.summary.changedFileCount).toBe(1);
        }
    });

    it("counts equivalent absolute and relative change paths once", () => {
        const createChangeActivity = (
            id: string,
            path: string,
            second: number,
        ) =>
            createActivity({
                createdAt: `2026-04-14T00:00:0${second}.000Z`,
                diffs: [
                    {
                        hunks: [],
                        isText: true,
                        kind: "update",
                        newText: "next",
                        oldText: "previous",
                        path,
                        previousPath: null,
                        reversible: true,
                    },
                ],
                id,
                title: `Edit ${path}`,
                updatedAt: `2026-04-14T00:00:0${second}.000Z`,
            });
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createChangeActivity("edit-1", "src/app.ts", 1),
                createChangeActivity("edit-2", "./src/app.ts", 2),
                createChangeActivity(
                    "edit-3",
                    "/workspace/comando/src/app.ts",
                    3,
                ),
            ],
            trackedFiles: [],
        });
        const segment = model.orderedRows[0];

        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind === "activity-segment") {
            expect(segment.summary.actionCount).toBe(3);
            expect(segment.summary.changeCount).toBe(3);
            expect(segment.summary.changedFileCount).toBe(1);
            expect(segment.summary.fileCount).toBe(1);
        }
    });

    it("counts a rename and a later edit of its destination once", () => {
        const createChangeActivity = (
            id: string,
            path: string,
            second: number,
            previousPath: string | null = null,
        ) =>
            createActivity({
                createdAt: `2026-04-14T00:00:0${second}.000Z`,
                diffs: [
                    {
                        hunks: [],
                        isText: true,
                        kind: previousPath ? "move" : "update",
                        newText: "next",
                        oldText: "previous",
                        path,
                        previousPath,
                        reversible: true,
                    },
                ],
                id,
                title: `Edit ${path}`,
                updatedAt: `2026-04-14T00:00:0${second}.000Z`,
            });
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createChangeActivity(
                    "rename-1",
                    "src/new-name.ts",
                    1,
                    "src/old-name.ts",
                ),
                createChangeActivity("edit-2", "src/new-name.ts", 2),
            ],
            trackedFiles: [],
        });
        const segment = model.orderedRows[0];

        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind === "activity-segment") {
            expect(segment.summary.changedFileCount).toBe(1);
            expect(segment.summary.fileCount).toBe(2);
        }
    });

    it("keeps its id when the first member becomes a change", () => {
        const first = createReadActivity(
            "read-1",
            "2026-04-14T00:00:01.000Z",
        );
        const second = createReadActivity(
            "read-2",
            "2026-04-14T00:00:02.000Z",
        );
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [first, second],
            trackedFiles: [],
        });
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "idle",
            toolActivity: [first, second],
            trackedFiles: [
                createTrackedFile({
                    identityKey: "tracked-read-1",
                    path: "src/read-1.ts",
                    toolCallId: "read-1",
                }),
            ],
        });

        expect(nextModel.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const segment = nextModel.orderedRows[0];
        if (segment?.kind === "activity-segment") {
            expect(segment.entries[0]?.policy).toBe("standalone-change");
            expect(segment.entries[1]?.policy).toBe("groupable");
        }
    });

    it("keeps native raw-input tracked-file matches visible in a segment", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z", {
                    locations: [],
                    rawInputJson: JSON.stringify({ file_path: "src/app.ts" }),
                }),
            ],
            trackedFiles: [createTrackedFile({ toolCallId: null })],
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const segment = model.orderedRows[0];
        if (segment?.kind === "activity-segment") {
            expect(segment.entries[0]?.policy).toBe("standalone-change");
        }
    });

    it("reclassifies completed terminals when exit evidence changes", () => {
        const successful = createActivity({
            exitCode: 0,
            id: "command-1",
            kind: "execute",
            status: "completed",
            title: "Run tests",
        });
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [successful],
            trackedFiles: [],
        });
        expect(initialModel.orderedRowIds).toEqual([
            "activity-segment:session-1:command-1",
        ]);

        const unknownModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "idle",
            toolActivity: [{ ...successful, exitCode: null }],
            trackedFiles: [],
        });
        expect(unknownModel.orderedRowIds).toEqual([
            "activity-segment:session-1:command-1",
        ]);

        const failedModel = reconcileChatTimelineModel(unknownModel, {
            messages: [],
            status: "idle",
            toolActivity: [{ ...successful, exitCode: 1 }],
            trackedFiles: [],
        });
        expect(failedModel.orderedRowIds).toEqual([
            "activity-segment:session-1:command-1",
        ]);
        expect(
            failedModel.atomicRowById.get("tool:session-1:command-1"),
        ).not.toBe(
            unknownModel.atomicRowById.get("tool:session-1:command-1"),
        );
    });

    it("keeps an actively requested tool call visible in its segment", () => {
        const activity = createReadActivity(
            "read-1",
            "2026-04-14T00:00:01.000Z",
        );
        const activeModel = reconcileChatTimelineModel(null, {
            attentionToolCallIds: new Set(["read-1"]),
            messages: [],
            status: "streaming",
            toolActivity: [activity],
            trackedFiles: [],
        });
        expect(activeModel.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const activeSegment = activeModel.orderedRows[0];
        if (activeSegment?.kind === "activity-segment") {
            expect(activeSegment.entries[0]?.policy).toBe(
                "standalone-attention",
            );
        }

        const resolvedModel = reconcileChatTimelineModel(activeModel, {
            attentionToolCallIds: new Set(),
            messages: [],
            status: "streaming",
            toolActivity: [activity],
            trackedFiles: [],
        });
        expect(resolvedModel.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
    });

    it("forwards attention ids through transcript reconciliation", () => {
        const transcript = buildAiSessionTranscriptModel({
            messages: [],
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
            ],
        });
        const model = reconcileChatTimelineModelFromTranscript(null, {
            attentionToolCallIds: new Set(["read-1"]),
            status: "streaming",
            trackedFiles: [],
            transcript,
        });

        expect(model.orderedRowIds).toEqual([
            "activity-segment:session-1:read-1",
        ]);
        const segment = model.orderedRows[0];
        if (segment?.kind === "activity-segment") {
            expect(segment.entries[0]?.policy).toBe(
                "standalone-attention",
            );
        }
    });

    it("maps an atomic streaming tail into its activity segment", () => {
        const model = reconcileChatTimelineModel(null, {
            messages: [
                createMessage({
                    content: "Inspect the code",
                    id: "prompt-1",
                    kind: "user",
                }),
            ],
            status: "streaming",
            toolActivity: [
                createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
                createReadActivity("read-2", "2026-04-14T00:00:02.000Z", {
                    status: "in_progress",
                }),
            ],
            trackedFiles: [],
        });

        expect(model.atomicLiveTailRowId).toBe("tool:session-1:read-2");
        expect(model.liveTailRowId).toBe(
            "activity-segment:session-1:read-1",
        );
        expect(model.historyRowIds).toEqual([
            "message:prompt-1",
        ]);
    });

    it("reuses unaffected historical segments when the live segment changes", () => {
        const first = createReadActivity(
            "read-1",
            "2026-04-14T00:00:01.000Z",
        );
        const second = createReadActivity(
            "read-2",
            "2026-04-14T00:00:03.000Z",
        );
        const boundary = createMessage({
            createdAt: "2026-04-14T00:00:02.000Z",
            id: "assistant-boundary",
        });
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [boundary],
            status: "streaming",
            toolActivity: [first, second],
            trackedFiles: [],
        });
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [boundary],
            status: "streaming",
            toolActivity: [
                first,
                second,
                createReadActivity(
                    "read-3",
                    "2026-04-14T00:00:04.000Z",
                    { status: "in_progress" },
                ),
            ],
            trackedFiles: [],
        });

        expect(nextModel.orderedRows[0]).toBe(initialModel.orderedRows[0]);
        expect(nextModel.orderedRows[2]).not.toBe(initialModel.orderedRows[2]);
    });

    it("preserves atomic createdAt anchors across an equivalent resync", () => {
        const first = createReadActivity(
            "read-1",
            "2026-04-14T00:00:01.000Z",
        );
        const second = createReadActivity(
            "read-2",
            "2026-04-14T00:00:02.000Z",
        );
        const initialModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: [first, second],
            trackedFiles: [],
        });
        const nextModel = reconcileChatTimelineModel(initialModel, {
            messages: [],
            status: "idle",
            toolActivity: [
                { ...first, createdAt: "2026-04-14T00:00:20.000Z" },
                { ...second, createdAt: "2026-04-14T00:00:10.000Z" },
            ],
            trackedFiles: [],
        });

        expect(nextModel.orderedAtomicRows).toBe(
            initialModel.orderedAtomicRows,
        );
        const segment = nextModel.orderedRows[0];
        expect(segment?.kind).toBe("activity-segment");
        if (segment?.kind === "activity-segment") {
            expect(
                segment.entries.map(
                    (entry) => entry.reviewEntry.activity.id,
                ),
            ).toEqual(["read-1", "read-2"]);
        }
    });

    it("produces the same segments from persisted data in live and history models", () => {
        const activities = [
            createReadActivity("read-1", "2026-04-14T00:00:01.000Z"),
            createReadActivity("read-2", "2026-04-14T00:00:02.000Z"),
        ];
        const liveModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "streaming",
            toolActivity: activities,
            trackedFiles: [],
        });
        const historyModel = reconcileChatTimelineModel(null, {
            messages: [],
            status: "idle",
            toolActivity: activities,
            trackedFiles: [],
        });

        expect(liveModel.orderedRowIds).toEqual(historyModel.orderedRowIds);
        expect(
            liveModel.orderedRows[0]?.kind === "activity-segment"
                ? liveModel.orderedRows[0].entries.map(
                      (entry) => entry.reviewEntry.activity.id,
                  )
                : [],
        ).toEqual(
            historyModel.orderedRows[0]?.kind === "activity-segment"
                ? historyModel.orderedRows[0].entries.map(
                      (entry) => entry.reviewEntry.activity.id,
                  )
                : [],
        );
    });
});
