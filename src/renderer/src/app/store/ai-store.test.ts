import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AiFileContextAttachment,
    AiMessage,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiToolActivity,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTrackedFile,
    AppBootstrapSnapshot,
    WorkspaceChatTab,
} from "@shared/ipc";
import {
    createReviewActionLogFromTrackedFiles,
    deriveTrackedFilesFromActionLog,
} from "@shared/ai-review-action-log";

import { getSessionReviewPreferencesStorageKey } from "@renderer/app/ai/sessionReviewPreferences";
import { buildBlockNativeTranscript } from "@renderer/app/ai/transcriptWindowProjection";
import { reconcileChatTimelineModelFromTranscript } from "@renderer/components/workspace/chat/chatTimelineModel";
import { useAppStore } from "./app-store";
import {
    applyAiTranscriptMemoryPressure,
    resetAiStoreRuntimeBuffersForTests,
    useAiStore,
} from "./ai-store";

const TAB: WorkspaceChatTab = {
    createdAt: "2026-04-14T00:00:00.000Z",
    draft: "",
    id: "tab-1",
    kind: "chat",
    projectId: "project-1",
    runtimeId: "codex",
    sessionId: "session-1",
    title: "Chat",
    worktreeId: null,
};

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: TAB.projectId,
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        status: "idle",
        title: TAB.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-14T00:00:00.000Z",
        worktreeId: TAB.worktreeId ?? null,
        ...overrides,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    { id: "line-1", text: "before", type: "remove" },
                    { id: "line-2", text: "after", type: "add" },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        identityKey: "tracked-1",
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: TAB.sessionId,
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
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
        runtimeId: TAB.runtimeId,
        runtimeSessionId: "runtime-session-1",
        sessionId: TAB.sessionId,
        updatedAt: "2026-04-14T00:00:00.000Z",
        activeTurnStartedAt: null,
        lastError: null,
        status: "idle",
        ...rest,
        kind,
    } as AiSessionDomainEvent;
}

function createRuntimeStatus(
    overrides: Partial<AiRuntimeStatus> = {},
): AiRuntimeStatus {
    return {
        authMethod: null,
        authMethods: [],
        authReady: true,
        checkedAt: "2026-04-14T00:00:00.000Z",
        command: "codex",
        hasCustomBinaryPath: false,
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message: null,
        onboardingRequired: false,
        runtimeId: TAB.runtimeId,
        source: null,
        state: "ready",
        ...overrides,
    };
}

function createMessage(overrides: Partial<AiMessage> = {}): AiMessage {
    return {
        attachments: [],
        content: "Hello",
        createdAt: "2026-04-14T00:00:00.000Z",
        id: "message-1",
        kind: "assistant",
        status: "streaming",
        ...overrides,
    };
}

function createFileContext(
    overrides: Partial<AiFileContextAttachment> = {},
): AiFileContextAttachment {
    return {
        extension: "ts",
        id: "ctx-1",
        languageId: "typescript",
        name: "app.ts",
        projectId: TAB.projectId ?? "project-1",
        relativePath: "src/app.ts",
        ...overrides,
    };
}

function createToolActivity(
    overrides: Partial<AiToolActivity> = {},
): AiToolActivity {
    return {
        createdAt: "2026-04-14T00:00:00.000Z",
        diffs: [],
        exitCode: null,
        id: "tool-1",
        kind: "shell",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: TAB.sessionId,
        status: "in_progress",
        summary: null,
        terminalOutput: null,
        title: "Run command",
        updatedAt: "2026-04-14T00:00:00.000Z",
        ...overrides,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });

    return { promise, resolve };
}

function setRendererPlatform(platform: string): void {
    useAppStore.setState({
        bootstrap: { platform } as AppBootstrapSnapshot,
        error: null,
        status: "ready",
    });
}

describe("ai-store queue", () => {
    beforeEach(() => {
        const storage = new Map<string, string>();

        vi.stubGlobal("localStorage", {
            clear: () => storage.clear(),
            getItem: (key: string) => storage.get(key) ?? null,
            key: (index: number) => Array.from(storage.keys())[index] ?? null,
            get length() {
                return storage.size;
            },
            removeItem: (key: string) => {
                storage.delete(key);
            },
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
        });
        useAiStore.setState((state) => ({
            ...state,
            runtimeCatalogById: {},
            runtimeStatusById: {},
            sessions: {},
        }));
        resetAiStoreRuntimeBuffersForTests();
        useAppStore.setState({
            bootstrap: null,
            error: null,
            status: "idle",
        });
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("hydrates compacted tool activity details into the snapshot and transcript", async () => {
        const activity = createToolActivity({
            id: "tool-compacted",
            status: "completed",
            toolActivityDetailId: "detail-1",
        });
        const detail = {
            diffs: [
                {
                    hunks: createTrackedFile().hunks,
                    isText: true,
                    kind: "update" as const,
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            rawInputJson: '{"command":"test"}',
            rawOutputJson: '{"exitCode":0}',
            terminalOutput: "done",
        };
        const loadAiToolActivityDetail = vi.fn().mockResolvedValue(detail);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: { comando: { loadAiToolActivityDetail } },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ toolActivity: [activity] }),
        );

        await useAiStore
            .getState()
            .hydrateToolActivityDetail(TAB.sessionId, activity.id);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(loadAiToolActivityDetail).toHaveBeenCalledWith({
            sessionId: TAB.sessionId,
            toolActivityDetailId: "detail-1",
        });
        expect(session?.snapshot?.toolActivity[0]).toMatchObject(detail);
        expect(session?.transcript.toolActivity[0]).toMatchObject(detail);
    });

    it("hydrates a sealed editable tool into its resident transcript payload", async () => {
        const activity = createToolActivity({
            diffs: [],
            id: "sealed-edit",
            kind: "edit",
            locations: [],
            status: "completed",
            toolActivityDetailId: "detail:sealed-edit",
        });
        const payloadRef = "payload:sealed-edit";
        const detail = {
            diffs: [
                {
                    hunks: createTrackedFile().hunks,
                    isText: true,
                    kind: "update" as const,
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            rawInputJson: null,
            rawOutputJson: null,
            terminalOutput: null,
        };
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    loadAiToolActivityDetail: vi.fn().mockResolvedValue(detail),
                },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(createSnapshot());
        const metadata: AiTranscriptBlockMetadata = {
            blockId: "block-sealed-edit",
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 80,
            estimatedRowCount: 1,
            firstCreatedAt: activity.createdAt,
            lastCreatedAt: activity.updatedAt,
            revision: 1,
            sessionId: TAB.sessionId,
            startSequence: 1,
        };
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: activity.createdAt,
                    id: `tool:${TAB.sessionId}:${activity.id}`,
                    kind: "tool",
                    payloadRef,
                    sequence: 1,
                    sessionId: TAB.sessionId,
                    summary: {
                        label: activity.title,
                        preview: activity.summary,
                        status: activity.status,
                        toolActivityDetailId: activity.toolActivityDetailId,
                        toolKind: activity.kind,
                    },
                    updatedAt: activity.updatedAt,
                },
            ],
            transcriptRevision: 1,
        };
        useAiStore.setState((state) => {
            const session = state.sessions[TAB.sessionId];
            return {
                sessions: {
                    ...state.sessions,
                    [TAB.sessionId]: {
                        ...session,
                        transcriptWindow: {
                            ...session.transcriptWindow,
                            blocksById: new Map([[metadata.blockId, block]]),
                            capabilityVersion: 1,
                            metadata: [metadata],
                            transcriptRevision: 1,
                        },
                    },
                },
            };
        });

        await useAiStore
            .getState()
            .hydrateToolActivityDetail(TAB.sessionId, activity.id, activity);

        const payload = useAiStore
            .getState()
            .sessions[TAB.sessionId]?.transcriptWindow.payloadsByRef.get(payloadRef);
        expect(payload?.value).toMatchObject({
            activity: detail,
            kind: "tool",
        });
    });

    it("replaces native review placeholders with hydrated tracked files", async () => {
        const delta = {
            deltaId: "delta-1",
            files: [
                {
                    path: "src/app.ts",
                    state: "ready" as const,
                },
            ],
            inputRevision: 4,
            revision: 5,
            sessionId: TAB.sessionId,
            state: "ready" as const,
            toolCallId: "tool-review",
            updatedAt: "2026-04-14T00:00:00.000Z",
            workCycleId: "cycle-1",
        };
        const hydratedFile = createTrackedFile({
            identityKey: "native:src/app.ts",
            toolCallId: "tool-review",
        });
        const loadAiReviewDelta = vi.fn().mockResolvedValue({
            delta,
            trackedFiles: [hydratedFile],
        });
        const releaseAiReviewDelta = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: { loadAiReviewDelta, releaseAiReviewDelta },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                reviewDeltas: [delta],
                trackedFiles: [
                    createTrackedFile({
                        hunks: [],
                        identityKey: "native-review:src/app.ts",
                        nativeReviewDeltaId: delta.deltaId,
                        nativeReviewInputRevision: delta.inputRevision,
                        nativeReviewWorkCycleId: delta.workCycleId,
                        newText: null,
                        oldText: null,
                        reversible: false,
                        toolCallId: delta.toolCallId,
                        version: delta.revision,
                    }),
                ],
            }),
        );

        await useAiStore.getState().hydrateReviewDeltas(TAB.sessionId);

        const trackedFile = useAiStore.getState().sessions[TAB.sessionId]
            ?.snapshot?.trackedFiles[0];
        expect(trackedFile).toMatchObject({
            hunks: hydratedFile.hunks,
            identityKey: hydratedFile.identityKey,
            nativeReviewDeltaId: delta.deltaId,
            nativeReviewInputRevision: delta.inputRevision,
            nativeReviewWorkCycleId: delta.workCycleId,
            version: delta.revision,
        });
        expect(releaseAiReviewDelta).toHaveBeenCalledWith(delta.deltaId);
    });

    it("hydrates bounded provisional review diffs before materialization completes", async () => {
        const delta = {
            deltaId: "delta-preparing",
            files: [{ path: "src/app.ts", state: "preparing" as const }],
            inputRevision: 4,
            revision: 4,
            sessionId: TAB.sessionId,
            state: "preparing" as const,
            toolCallId: "tool-review",
            updatedAt: "2026-04-14T00:00:00.000Z",
            workCycleId: "cycle-1",
        };
        const provisionalFile = createTrackedFile({
            hunks: [],
            identityKey: "native:src/app.ts",
            newText: "after\n",
            oldText: "before\n",
            toolCallId: "tool-review",
        });
        const loadAiReviewDelta = vi.fn().mockResolvedValue({
            delta,
            trackedFiles: [provisionalFile],
        });
        const releaseAiReviewDelta = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: { loadAiReviewDelta, releaseAiReviewDelta },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                reviewDeltas: [delta],
                trackedFiles: [
                    createTrackedFile({
                        hunks: [],
                        identityKey: "native-review:src/app.ts",
                        nativeReviewDeltaId: delta.deltaId,
                        nativeReviewInputRevision: delta.inputRevision,
                        nativeReviewState: "preparing",
                        nativeReviewWorkCycleId: delta.workCycleId,
                        newText: null,
                        oldText: null,
                        toolCallId: delta.toolCallId,
                        version: delta.revision,
                    }),
                ],
            }),
        );

        await useAiStore.getState().hydrateReviewDeltas(TAB.sessionId);

        expect(loadAiReviewDelta).toHaveBeenCalledWith({
            expectedRevision: delta.revision,
            reviewDeltaId: delta.deltaId,
            sessionId: TAB.sessionId,
        });
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles[0],
        ).toMatchObject({
            hunks: [],
            newText: "after\n",
            oldText: "before\n",
            nativeReviewState: "preparing",
        });
    });

    it("defers tool payloads while hydrating visible block-native transcript windows", async () => {
        const metadata = [1, 2, 3].map((index) => ({
            blockId: `block-${index}`,
            endSequence: index * 10,
            entryCount: 10,
            estimatedHeight: 720,
            estimatedRowCount: 10,
            firstCreatedAt: "2026-04-14T00:00:00.000Z",
            lastCreatedAt: "2026-04-14T00:00:00.000Z",
            revision: 1,
            sessionId: TAB.sessionId,
            startSequence: (index - 1) * 10 + 1,
        }));
        const getAiTranscriptBlock = vi.fn((_sessionId: string, blockId: string) => {
            const blockIndex = Number(blockId.slice("block-".length));
            return Promise.resolve({
                ...metadata.find((item) => item.blockId === blockId)!,
                capabilityVersion: 1,
                entries: ["message", "thinking", "tool"].map((kind, index) => ({
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: `${kind}-${blockIndex}`,
                    kind,
                    payloadRef: `payload:${kind}-${blockIndex}`,
                    sequence: blockIndex * 10 + index,
                    sessionId: TAB.sessionId,
                    summary: { label: kind, preview: kind, status: "completed" },
                    updatedAt: "2026-04-14T00:00:00.000Z",
                })),
                transcriptRevision: 3,
            } as AiTranscriptBlock);
        });
        const getAiTranscriptPayload = vi.fn((input: { readonly payloadRef: string }) =>
            Promise.resolve({
                byteLength: 100,
                capabilityVersion: 1,
                contentHash: input.payloadRef,
                payloadRef: input.payloadRef,
                sessionId: TAB.sessionId,
                transcriptRevision: 3,
                value: { content: input.payloadRef },
            }),
        );
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlock,
                    getAiTranscriptPayload,
                    getAiTranscriptBlockMetadata: vi.fn().mockResolvedValue({
                        blocks: metadata,
                        capabilityVersion: 1,
                        sessionId: TAB.sessionId,
                        transcriptRevision: 3,
                    }),
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);

        const windowState = useAiStore.getState().sessions[TAB.sessionId]
            ?.transcriptWindow;
        expect(windowState?.metadata).toHaveLength(3);
        expect([...windowState?.blocksById.keys() ?? []]).toEqual([
            "block-2",
            "block-3",
        ]);
        expect(windowState?.residentEntries).toBe(20);
        expect(getAiTranscriptBlock).toHaveBeenCalledTimes(2);
        expect(getAiTranscriptPayload.mock.calls.map(([input]) => input.payloadRef)).toEqual(
            expect.arrayContaining([
                "payload:message-2",
                "payload:thinking-2",
                "payload:message-3",
                "payload:thinking-3",
            ]),
        );
        expect(getAiTranscriptPayload.mock.calls.map(([input]) => input.payloadRef)).not.toEqual(
            expect.arrayContaining(["payload:tool-2", "payload:tool-3"]),
        );

        await useAiStore
            .getState()
            .prefetchTranscriptWindow(TAB.sessionId, "backward");

        expect(getAiTranscriptPayload.mock.calls.map(([input]) => input.payloadRef)).toEqual(
            expect.arrayContaining([
                "payload:message-1",
                "payload:thinking-1",
            ]),
        );
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcriptWindow.payloadsByRef.has(
                    "payload:thinking-1",
                ),
        ).toBe(true);

        await useAiStore
            .getState()
            .loadTranscriptPayload(TAB.sessionId, "payload:tool-1");
        expect(getAiTranscriptPayload).toHaveBeenCalledWith({
            payloadRef: "payload:tool-1",
            sessionId: TAB.sessionId,
        });

        useAiStore
            .getState()
            .setTranscriptWindowAnchor(TAB.sessionId, "block-1", false);
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcriptWindow.payloadsByRef.has(
                    "payload:thinking-1",
                ),
        ).toBe(true);
        useAiStore
            .getState()
            .setTranscriptWindowAnchor(TAB.sessionId, "block-2", false);
        expect(
            [...(
                useAiStore.getState().sessions[TAB.sessionId]?.transcriptWindow
                    .protectedBlockIds ?? []
            )],
        ).toEqual(expect.arrayContaining(["block-2"]));
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcriptWindow.protectedBlockIds.has(
                    "block-3",
                ),
        ).toBe(false);

        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);

        const rehydratedWindow =
            useAiStore.getState().sessions[TAB.sessionId]?.transcriptWindow;
        expect(rehydratedWindow).toMatchObject({
            anchorBlockId: "block-2",
            followTail: false,
        });
        expect([...rehydratedWindow?.protectedBlockIds ?? []]).toEqual([
            "block-2",
        ]);
    });

    it("keeps a sealed activity diff available after its rail is collapsed and expanded", async () => {
        const blockId = "block-with-diff";
        const payloadRef = "payload:tool-with-diff";
        const activity = createToolActivity({
            diffs: [
                {
                    hunks: [
                        {
                            id: "hunk-1",
                            lines: [
                                { id: "line-1", text: "before", type: "remove" },
                                { id: "line-2", text: "after", type: "add" },
                            ],
                            newCount: 1,
                            newStart: 1,
                            oldCount: 1,
                            oldStart: 1,
                        },
                    ],
                    isText: true,
                    kind: "update",
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "tool-with-diff",
            kind: "edit",
            status: "completed",
            title: "Edit src/app.ts",
        });
        const metadata: AiTranscriptBlockMetadata = {
            blockId,
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 80,
            estimatedRowCount: 1,
            firstCreatedAt: activity.createdAt,
            lastCreatedAt: activity.updatedAt,
            revision: 1,
            sessionId: TAB.sessionId,
            startSequence: 1,
        };
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: activity.createdAt,
                    id: `tool:${TAB.sessionId}:${activity.id}`,
                    kind: "tool",
                    payloadRef,
                    sequence: 1,
                    sessionId: TAB.sessionId,
                    summary: {
                        label: activity.title,
                        preview: activity.summary,
                        status: activity.status,
                    },
                    updatedAt: activity.updatedAt,
                },
            ],
            transcriptRevision: 1,
        };
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlock: vi.fn().mockResolvedValue(block),
                    getAiTranscriptBlockMetadata: vi.fn().mockResolvedValue({
                        blocks: [metadata],
                        capabilityVersion: 1,
                        sessionId: TAB.sessionId,
                        transcriptRevision: 1,
                    }),
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                    getAiTranscriptPayload: vi.fn().mockResolvedValue({
                        byteLength: 256,
                        capabilityVersion: 1,
                        contentHash: "tool-with-diff",
                        payloadRef,
                        sessionId: TAB.sessionId,
                        transcriptRevision: 1,
                        value: { activity, kind: "tool" },
                    }),
                },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(createSnapshot());
        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);
        await useAiStore
            .getState()
            .loadTranscriptPayload(TAB.sessionId, payloadRef);

        const getChangeCount = () => {
            const session = useAiStore.getState().sessions[TAB.sessionId];
            if (!session) throw new Error("Expected hydrated session.");
            const transcript = buildBlockNativeTranscript(
                session.transcript,
                session.transcriptWindow.blocksById,
                session.transcriptWindow.metadata,
                session.transcriptWindow.payloadsByRef,
                session.snapshot ?? createSnapshot(),
            );
            const timeline = reconcileChatTimelineModelFromTranscript(null, {
                status: "idle",
                trackedFiles: [],
                transcript,
            });
            return timeline.historyRows.find(
                (row) => row.kind === "activity-segment",
            )?.summary.changeCount;
        };

        expect(getChangeCount()).toBe(1);

        // Collapsing the rail unmounts the visible payload and releases it.
        useAiStore.getState().releaseTranscriptPayload(TAB.sessionId, payloadRef);

        // Expanding the same resident block must keep its diff without a reopen.
        expect(getChangeCount()).toBe(1);
    });

    it("does not inject historical messages when the first live follow-up snapshot arrives", () => {
        const historicalMessage = createMessage({
            content: "Earlier message that belongs to an unloaded block.",
            id: "historical-message",
            status: "completed",
        });
        const restoredTailMessage = createMessage({
            content: "Most recent restored message.",
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "restored-tail-message",
            status: "completed",
        });
        const followUpMessage = createMessage({
            content: "Continue this chat.",
            createdAt: "2026-04-14T00:02:00.000Z",
            id: "follow-up-message",
            kind: "user",
            status: "streaming",
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [restoredTailMessage],
                updatedAt: restoredTailMessage.createdAt,
            }),
        );
        useAiStore.setState((state) => {
            const session = state.sessions[TAB.sessionId];
            return {
                sessions: {
                    ...state.sessions,
                    [TAB.sessionId]: {
                        ...session,
                        transcriptWindow: {
                            ...session.transcriptWindow,
                            capabilityVersion: 1,
                            transcriptRevision: 1,
                        },
                    },
                },
            };
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                activeTurnStartedAt: followUpMessage.createdAt,
                messages: [
                    historicalMessage,
                    restoredTailMessage,
                    followUpMessage,
                ],
                status: "streaming",
                updatedAt: followUpMessage.createdAt,
            }),
        );

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcript.messages.map((message) => message.id),
        ).toEqual([restoredTailMessage.id, followUpMessage.id]);
    });

    it("keeps legacy history when block support is available but metadata is not", () => {
        const historicalMessage = createMessage({
            content: "Earlier response still stored in the legacy snapshot.",
            id: "legacy-history-message",
            status: "completed",
        });
        const followUpMessage = createMessage({
            content: "Continue this chat.",
            createdAt: "2026-04-14T00:02:00.000Z",
            id: "legacy-follow-up-message",
            kind: "user",
            status: "streaming",
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [historicalMessage],
                updatedAt: historicalMessage.createdAt,
            }),
        );
        useAiStore.setState((state) => {
            const session = state.sessions[TAB.sessionId];
            return {
                sessions: {
                    ...state.sessions,
                    [TAB.sessionId]: {
                        ...session,
                        transcriptWindow: {
                            ...session.transcriptWindow,
                            capabilityVersion: 1,
                        },
                    },
                },
            };
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                activeTurnStartedAt: followUpMessage.createdAt,
                messages: [historicalMessage, followUpMessage],
                status: "streaming",
                updatedAt: followUpMessage.createdAt,
            }),
        );

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcript.messages.map((message) => message.id),
        ).toEqual([historicalMessage.id, followUpMessage.id]);
    });

    it("keeps an unsealed turn visible while empty block metadata catches up", async () => {
        const previousResponse = createMessage({
            content: "Previous response waiting to be sealed.",
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "previous-unsealed-response",
            status: "completed",
        });
        const followUpMessage = createMessage({
            content: "Continue this chat.",
            createdAt: "2026-04-14T00:02:00.000Z",
            id: "follow-up-live-tail",
            kind: "user",
            status: "streaming",
        });
        const getAiTranscriptBlockMetadata = vi.fn().mockResolvedValue({
            blocks: [],
            capabilityVersion: 1,
            sessionId: TAB.sessionId,
            transcriptRevision: 0,
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlockMetadata,
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [previousResponse],
                updatedAt: previousResponse.createdAt,
            }),
        );
        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);
        useAiStore.getState().applyPromptQueueSnapshot({
            activeItem: {
                attachments: [],
                composerPartsSnapshot: [
                    { text: followUpMessage.content, type: "text" },
                ],
                createdAt: followUpMessage.createdAt,
                error: null,
                fileContextsSnapshot: [],
                id: followUpMessage.id,
                messageId: followUpMessage.id,
                optimisticMessageId: followUpMessage.id,
                projectId: TAB.projectId,
                prompt: followUpMessage.content,
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
                status: "sending",
                title: TAB.title,
                worktreeId: TAB.worktreeId ?? null,
            },
            editingItem: null,
            items: [],
            paused: false,
            revision: 1,
            sessionId: TAB.sessionId,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                activeTurnStartedAt: followUpMessage.createdAt,
                messages: [followUpMessage],
                status: "streaming",
                updatedAt: followUpMessage.createdAt,
            }),
        );

        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcript.messages.map((message) => message.id),
        ).toEqual([previousResponse.id, followUpMessage.id]);
        await vi.waitFor(() =>
            expect(getAiTranscriptBlockMetadata).toHaveBeenCalledTimes(2),
        );
    });

    it("keeps unsealed tool activity visible when a follow-up turn starts before block metadata catches up", async () => {
        const previousResponse = createMessage({
            content: "Previous response waiting to be sealed.",
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "previous-unsealed-response",
            status: "completed",
        });
        const previousTool = createToolActivity({
            createdAt: "2026-04-14T00:01:01.000Z",
            diffs: [
                {
                    hunks: [
                        {
                            id: "tool-hunk-1",
                            lines: [
                                {
                                    id: "tool-line-1",
                                    text: "before",
                                    type: "remove",
                                },
                                {
                                    id: "tool-line-2",
                                    text: "after",
                                    type: "add",
                                },
                            ],
                            newCount: 1,
                            newStart: 1,
                            oldCount: 1,
                            oldStart: 1,
                        },
                    ],
                    isText: true,
                    kind: "update",
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/activity-rail.ts",
                    previousPath: null,
                    reversible: true,
                },
            ],
            id: "previous-unsealed-tool",
            kind: "edit",
            status: "completed",
            title: "Edit activity rail",
            updatedAt: "2026-04-14T00:01:02.000Z",
        });
        const followUpMessage = createMessage({
            content: "Continue this chat.",
            createdAt: "2026-04-14T00:02:00.000Z",
            id: "follow-up-live-tail",
            kind: "user",
            status: "streaming",
        });
        const getAiTranscriptBlockMetadata = vi.fn().mockResolvedValue({
            blocks: [],
            capabilityVersion: 1,
            sessionId: TAB.sessionId,
            transcriptRevision: 0,
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlockMetadata,
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [previousResponse],
                toolActivity: [previousTool],
                updatedAt: previousTool.updatedAt,
            }),
        );
        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);

        // The live snapshot only owns the new turn while the previous one is
        // waiting for its persisted transcript block to become observable.
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                activeTurnStartedAt: followUpMessage.createdAt,
                messages: [followUpMessage],
                status: "streaming",
                toolActivity: [],
                updatedAt: followUpMessage.createdAt,
            }),
        );

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(
            session?.transcript.toolActivity.map((activity) => activity.id),
        ).toEqual([previousTool.id]);

        const timeline = reconcileChatTimelineModelFromTranscript(null, {
            activeTurnStartedAt: followUpMessage.createdAt,
            status: "streaming",
            trackedFiles: session?.snapshot?.trackedFiles ?? [],
            transcript: session.transcript,
        });
        const activitySegment = timeline.historyRows.find(
            (row) => row.kind === "activity-segment",
        );
        expect(activitySegment).toMatchObject({
            changeStats: {
                additions: 1,
                approximate: false,
                deletions: 1,
            },
            kind: "activity-segment",
            summary: {
                actionCount: 1,
                changeCount: 1,
                latestActivityId: previousTool.id,
            },
        });
    });

    it("evicts transcript payloads from both the cache and UI state", async () => {
        const payloadSize = 9 * 1024 * 1024;
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptPayload: vi.fn((input: { readonly payloadRef: string }) =>
                        Promise.resolve({
                            byteLength: payloadSize,
                            capabilityVersion: 1,
                            contentHash: input.payloadRef,
                            payloadRef: input.payloadRef,
                            sessionId: TAB.sessionId,
                            transcriptRevision: 1,
                            value: { content: input.payloadRef },
                        }),
                    ),
                },
            },
            writable: true,
        });
        useAiStore.getState().registerSessionTab(TAB);

        await useAiStore
            .getState()
            .loadTranscriptPayload(TAB.sessionId, "payload:first");
        await useAiStore
            .getState()
            .loadTranscriptPayload(TAB.sessionId, "payload:second");

        let payloads = useAiStore.getState().sessions[TAB.sessionId]
            ?.transcriptWindow.payloadsByRef;
        expect(payloads?.has("payload:first")).toBe(false);
        expect(payloads?.has("payload:second")).toBe(true);

        applyAiTranscriptMemoryPressure(0);

        payloads = useAiStore.getState().sessions[TAB.sessionId]
            ?.transcriptWindow.payloadsByRef;
        expect(payloads?.size).toBe(0);
    });

    it("shares the transcript payload budget across sessions", async () => {
        const payloadSize = 9 * 1024 * 1024;
        const secondTab: WorkspaceChatTab = {
            ...TAB,
            id: "tab-2",
            sessionId: "session-2",
        };
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptPayload: vi.fn((input: {
                        readonly payloadRef: string;
                        readonly sessionId: string;
                    }) =>
                        Promise.resolve({
                            byteLength: payloadSize,
                            capabilityVersion: 1,
                            contentHash: input.payloadRef,
                            payloadRef: input.payloadRef,
                            sessionId: input.sessionId,
                            transcriptRevision: 1,
                            value: { content: input.payloadRef },
                        })),
                },
            },
            writable: true,
        });
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().registerSessionTab(secondTab);

        await useAiStore
            .getState()
            .loadTranscriptPayload(TAB.sessionId, "payload:first");
        await useAiStore
            .getState()
            .loadTranscriptPayload(secondTab.sessionId, "payload:second");

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.transcriptWindow
                .payloadsByRef.has("payload:first"),
        ).toBe(false);
        expect(
            useAiStore.getState().sessions[secondTab.sessionId]
                ?.transcriptWindow.payloadsByRef.has("payload:second"),
        ).toBe(true);
    });

    it("releases evicted blocks from other session windows", async () => {
        const sessionIds = ["session-eviction-a", "session-eviction-b"] as const;
        const metadataBySession = new Map<
            string,
            readonly AiTranscriptBlockMetadata[]
        >(
            sessionIds.map((sessionId) => [
                sessionId,
                [1, 2, 3, 4].map((index) => ({
                    blockId: `${sessionId}:block-${index}`,
                    endSequence: index * 512,
                    entryCount: 512,
                    estimatedHeight: 512 * 72,
                    estimatedRowCount: 512,
                    firstCreatedAt: "2026-04-14T00:00:00.000Z",
                    lastCreatedAt: "2026-04-14T00:00:00.000Z",
                    revision: 1,
                    sessionId,
                    startSequence: (index - 1) * 512 + 1,
                })),
            ]),
        );
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlock: vi.fn(
                        (sessionId: string, blockId: string) =>
                            Promise.resolve({
                                ...metadataBySession
                                    .get(sessionId)!
                                    .find((block) => block.blockId === blockId)!,
                                capabilityVersion: 1,
                                entries: [],
                                transcriptRevision: 1,
                            } satisfies AiTranscriptBlock),
                    ),
                    getAiTranscriptBlockMetadata: vi.fn((sessionId: string) =>
                        Promise.resolve({
                            blocks: metadataBySession.get(sessionId)!,
                            capabilityVersion: 1,
                            sessionId,
                            transcriptRevision: 1,
                        }),
                    ),
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                    getAiTranscriptPayload: vi.fn(),
                },
            },
            writable: true,
        });

        for (const sessionId of sessionIds) {
            useAiStore.getState().applySessionSnapshot(
                createSnapshot({ sessionId }),
            );
        }
        await useAiStore.getState().hydrateTranscriptWindow(sessionIds[0]);
        await useAiStore
            .getState()
            .loadTranscriptWindowBlock(sessionIds[0], `${sessionIds[0]}:block-1`);
        expect(
            useAiStore
                .getState()
                .sessions[sessionIds[0]]?.transcriptWindow.blocksById.has(
                    `${sessionIds[0]}:block-1`,
                ),
        ).toBe(true);

        await useAiStore.getState().hydrateTranscriptWindow(sessionIds[1]);

        expect(
            useAiStore
                .getState()
                .sessions[sessionIds[0]]?.transcriptWindow.blocksById.has(
                    `${sessionIds[0]}:block-1`,
                ),
        ).toBe(false);
    });

    it("releases live transcript entries after their sealed block is hydrated", async () => {
        const sealedMessage = createMessage({
            id: "sealed-message",
            status: "completed",
        });
        const liveMessage = createMessage({
            content: "Still streaming",
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "live-message",
        });
        const sealedTool = createToolActivity({
            id: "sealed-tool",
            status: "completed",
        });
        const liveTool = createToolActivity({
            createdAt: "2026-04-14T00:01:00.000Z",
            id: "live-tool",
        });
        const metadata = {
            blockId: "block-sealed",
            endSequence: 2,
            entryCount: 2,
            estimatedHeight: 144,
            estimatedRowCount: 2,
            firstCreatedAt: sealedMessage.createdAt,
            lastCreatedAt: sealedTool.createdAt,
            revision: 1,
            sessionId: TAB.sessionId,
            startSequence: 1,
        };
        const block = {
            ...metadata,
            capabilityVersion: 1,
            entries: [
                {
                    createdAt: sealedMessage.createdAt,
                    id: `message:${sealedMessage.id}`,
                    kind: "message",
                    payloadRef: null,
                    sequence: 1,
                    sessionId: TAB.sessionId,
                    summary: {
                        label: "Assistant message",
                        preview: sealedMessage.content,
                        status: "completed",
                    },
                    updatedAt: sealedMessage.createdAt,
                },
                {
                    createdAt: sealedTool.createdAt,
                    id: `tool:${TAB.sessionId}:${sealedTool.id}`,
                    kind: "tool",
                    payloadRef: null,
                    sequence: 2,
                    sessionId: TAB.sessionId,
                    summary: {
                        label: sealedTool.title,
                        preview: sealedTool.summary,
                        status: sealedTool.status,
                    },
                    updatedAt: sealedTool.updatedAt,
                },
            ],
            transcriptRevision: 1,
        } as AiTranscriptBlock;
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlock: vi.fn().mockResolvedValue(block),
                    getAiTranscriptBlockMetadata: vi.fn().mockResolvedValue({
                        blocks: [metadata],
                        capabilityVersion: 1,
                        sessionId: TAB.sessionId,
                        transcriptRevision: 1,
                    }),
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                    getAiTranscriptPayload: vi.fn(),
                },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [sealedMessage, liveMessage],
                status: "streaming",
                toolActivity: [sealedTool, liveTool],
            }),
        );

        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(
            session?.transcript.messages.map((message) => message.id),
        ).toEqual([liveMessage.id]);
        expect(
            session?.transcript.toolActivity.map((activity) => activity.id),
        ).toEqual([liveTool.id]);
        expect(
            session?.snapshot?.messages.map((message) => message.id),
        ).toEqual([liveMessage.id]);
        expect(
            session?.snapshot?.toolActivity.map((activity) => activity.id),
        ).toEqual([liveTool.id]);
        expect(session?.transcriptWindow.blocksById.has(block.blockId)).toBe(
            true,
        );
    });

    it("keeps restored history stable when a follow-up is queued during block hydration", async () => {
        const previousPrompt = createMessage({
            content: "A long prompt that must remain visible during sealing.",
            id: "previous-prompt",
            kind: "user",
            status: "completed",
        });
        const previousResponse = createMessage({
            content: "Previous response",
            createdAt: "2026-04-14T00:00:01.000Z",
            id: "previous-response",
            status: "completed",
        });
        const metadata: AiTranscriptBlockMetadata = {
            blockId: "block-pending",
            endSequence: 2,
            entryCount: 2,
            estimatedHeight: 288,
            estimatedRowCount: 2,
            firstCreatedAt: previousPrompt.createdAt,
            lastCreatedAt: previousResponse.createdAt,
            revision: 1,
            sessionId: TAB.sessionId,
            startSequence: 1,
        };
        const pendingBlock = createDeferred<AiTranscriptBlock>();
        const block: AiTranscriptBlock = {
            ...metadata,
            capabilityVersion: 1,
            entries: [previousPrompt, previousResponse].map((message, index) => ({
                createdAt: message.createdAt,
                id: `message:${message.id}`,
                kind: "message",
                payloadRef: null,
                sequence: index + 1,
                sessionId: TAB.sessionId,
                summary: {
                    label: message.kind === "user" ? "User message" : "Assistant message",
                    preview: message.content,
                    status: "completed",
                },
                updatedAt: message.createdAt,
            })),
            transcriptRevision: 1,
        };
        const getAiTranscriptBlock = vi.fn(() => pendingBlock.promise);
        const enqueueAiPrompt = vi.fn().mockResolvedValue({
            activeItem: {
                attachments: [],
                composerPartsSnapshot: [
                    { text: "Continue from the restored chat.", type: "text" as const },
                ],
                createdAt: "2026-04-14T00:00:02.000Z",
                error: null,
                fileContextsSnapshot: [],
                id: "follow-up-prompt",
                messageId: "follow-up-prompt",
                optimisticMessageId: "follow-up-prompt",
                projectId: TAB.projectId,
                prompt: "Continue from the restored chat.",
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
                status: "sending" as const,
                title: TAB.title,
                worktreeId: TAB.worktreeId,
            },
            editingItem: null,
            items: [],
            paused: false,
            revision: 1,
            sessionId: TAB.sessionId,
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    enqueueAiPrompt,
                    getAiTranscriptBlock,
                    getAiTranscriptBlockMetadata: vi.fn().mockResolvedValue({
                        blocks: [metadata],
                        capabilityVersion: 1,
                        sessionId: TAB.sessionId,
                        transcriptRevision: 1,
                    }),
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                    getAiTranscriptPayload: vi.fn(),
                },
            },
            writable: true,
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [previousPrompt, previousResponse],
                status: "streaming",
            }),
        );

        const hydration = useAiStore
            .getState()
            .hydrateTranscriptWindow(TAB.sessionId);
        await vi.waitFor(() => expect(getAiTranscriptBlock).toHaveBeenCalledOnce());

        await useAiStore
            .getState()
            .sendPrompt(TAB, "Continue from the restored chat.");

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ messages: [], status: "idle" }),
        );

        expect(enqueueAiPrompt).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: "Continue from the restored chat.",
                sessionId: TAB.sessionId,
            }),
        );
        expect(
            useAiStore
                .getState()
                .sessions[TAB.sessionId]?.transcript.messages.map((message) => message.id),
        ).toEqual([
            previousPrompt.id,
            previousResponse.id,
            "follow-up-prompt",
        ]);

        pendingBlock.resolve(block);
        await hydration;

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.transcript.messages.map((message) => message.id)).toEqual([
            "follow-up-prompt",
        ]);
        expect(session?.transcriptWindow.blocksById.has(block.blockId)).toBe(true);
        expect(session?.activeQueuedPrompt?.queuedPrompt.id).toBe(
            "follow-up-prompt",
        );
    });

    it("retries sealed transcript hydration after native migration becomes available", async () => {
        const getAiTranscriptBlockMetadata = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                blocks: [],
                capabilityVersion: 1,
                sessionId: TAB.sessionId,
                transcriptRevision: 1,
            });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiTranscriptBlockMetadata,
                    getAiTranscriptCapability: vi.fn().mockResolvedValue({
                        blockNativeVersion: 1,
                        legacyFallbackAvailable: true,
                    }),
                },
            },
            writable: true,
        });
        useAiStore.getState().registerSessionTab(TAB);

        await useAiStore.getState().hydrateTranscriptWindow(TAB.sessionId);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.transcriptWindow,
        ).toMatchObject({
            capabilityVersion: 1,
            isLoading: false,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ messages: [], status: "idle" }),
        );

        await vi.waitFor(() => {
            expect(getAiTranscriptBlockMetadata).toHaveBeenCalledTimes(2);
        });
    });

    it("keeps a command-only runtime catalog from status updates", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];

        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({
                availableCommands,
            }),
        );

        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("projects the main-owned queue without clearing it on unrelated session snapshots", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());
        useAiStore.getState().applyPromptQueueSnapshot({
            activeItem: {
                attachments: [],
                composerPartsSnapshot: [
                    { text: "First prompt", type: "text" },
                ],
                createdAt: "2026-04-14T00:00:01.000Z",
                error: null,
                fileContextsSnapshot: [],
                id: "message-1",
                messageId: "message-1",
                optimisticMessageId: "message-1",
                projectId: TAB.projectId,
                prompt: "First prompt",
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
                status: "running",
                title: TAB.title,
                worktreeId: null,
            },
            editingItem: null,
            items: [
                {
                    attachments: [],
                    composerPartsSnapshot: [
                        { text: "Second prompt", type: "text" },
                    ],
                    createdAt: "2026-04-14T00:00:02.000Z",
                    error: null,
                    fileContextsSnapshot: [],
                    id: "message-2",
                    messageId: "message-2",
                    optimisticMessageId: "message-2",
                    projectId: TAB.projectId,
                    prompt: "Second prompt",
                    runtimeId: TAB.runtimeId,
                    sessionId: TAB.sessionId,
                    status: "queued",
                    title: TAB.title,
                    worktreeId: null,
                },
            ],
            paused: false,
            revision: 2,
            sessionId: TAB.sessionId,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "streaming",
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );
        useAiStore.getState().applyPromptQueueSnapshot({
            activeItem: null,
            editingItem: null,
            items: [],
            paused: false,
            revision: 1,
            sessionId: TAB.sessionId,
        });

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.activeQueuedPrompt?.queuedPrompt.id).toBe("message-1");
        expect(session?.queue.map((item) => item.id)).toEqual(["message-2"]);
        expect(session?.snapshot?.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    content: "First prompt",
                    id: "message-1",
                    kind: "user",
                }),
            ]),
        );
    });

    it("applies subagent-created model and reasoning selections over the runtime catalog", () => {
        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({
                configOptions: [
                    {
                        category: "model",
                        description: null,
                        id: "model",
                        label: "Model",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Default",
                                value: "gpt-4o",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "Subagent",
                                value: "gpt-5",
                            },
                        ],
                        type: "select",
                        value: "gpt-4o",
                    },
                    {
                        category: "reasoning",
                        description: null,
                        id: "codex-reasoning-effort",
                        label: "Reasoning",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Medium",
                                value: "medium",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "High",
                                value: "high",
                            },
                        ],
                        type: "select",
                        value: "medium",
                    },
                ],
                modelId: "gpt-4o",
                models: [
                    { description: null, id: "gpt-4o", name: "GPT-4o" },
                    { description: null, id: "gpt-5", name: "GPT-5" },
                ],
            }),
        );

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                childRuntimeSessionId: "runtime-child-1",
                childSessionId: "session-1:subagent:runtime-child-1",
                kind: "subagent-created",
                modelId: "gpt-5",
                parentSessionId: "session-1",
                reasoningEffort: "high",
                runtimeSessionId: "runtime-child-1",
                sessionId: "session-1:subagent:runtime-child-1",
                title: "Galileo",
            }),
        );

        const snapshot =
            useAiStore.getState().sessions["session-1:subagent:runtime-child-1"]
                ?.snapshot;
        const modelConfig = snapshot?.configOptions.find(
            (option) => option.id === "model",
        );
        const reasoningConfig = snapshot?.configOptions.find(
            (option) => option.id === "codex-reasoning-effort",
        );
        expect(snapshot?.modelId).toBe("gpt-5");
        expect(snapshot?.reasoningEffort).toBe("high");
        expect(modelConfig).toMatchObject({ value: "gpt-5" });
        expect(reasoningConfig).toMatchObject({ value: "high" });
    });

    it("applies subagent reasoning selections when the runtime catalog arrives later", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                childRuntimeSessionId: "runtime-child-1",
                childSessionId: "session-1:subagent:runtime-child-1",
                kind: "subagent-created",
                modelId: "gpt-5",
                parentSessionId: "session-1",
                reasoningEffort: "high",
                runtimeSessionId: "runtime-child-1",
                sessionId: "session-1:subagent:runtime-child-1",
                title: "Galileo",
            }),
        );

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    configOptions: [
                        {
                            category: "model",
                            description: null,
                            id: "model",
                            label: "Model",
                            options: [
                                {
                                    description: null,
                                    groupLabel: null,
                                    label: "Default",
                                    value: "gpt-4o",
                                },
                                {
                                    description: null,
                                    groupLabel: null,
                                    label: "Subagent",
                                    value: "gpt-5",
                                },
                            ],
                            type: "select",
                            value: "gpt-4o",
                        },
                        {
                            category: "other",
                            description: null,
                            id: "thought_level",
                            label: "Reasoning",
                            options: [
                                {
                                    description: null,
                                    groupLabel: null,
                                    label: "Medium",
                                    value: "medium",
                                },
                                {
                                    description: null,
                                    groupLabel: null,
                                    label: "High",
                                    value: "high",
                                },
                            ],
                            type: "select",
                            value: "medium",
                        },
                    ],
                },
                runtimeId: TAB.runtimeId,
                sessionId: "session-1:subagent:runtime-child-1",
            },
        });

        const snapshot =
            useAiStore.getState().sessions["session-1:subagent:runtime-child-1"]
                ?.snapshot;
        const modelConfig = snapshot?.configOptions.find(
            (option) => option.id === "model",
        );
        const reasoningConfig = snapshot?.configOptions.find(
            (option) => option.id === "thought_level",
        );
        expect(snapshot?.modelId).toBe("gpt-5");
        expect(snapshot?.reasoningEffort).toBe("high");
        expect(modelConfig).toMatchObject({ value: "gpt-5" });
        expect(reasoningConfig).toMatchObject({ value: "high" });
    });

    it("sends live subagent effort changes to the child session", async () => {
        const setAiSessionConfigOption = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        const childSessionId = "session-1:subagent:runtime-child-1";
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [
                    {
                        category: "reasoning",
                        description: null,
                        id: "codex-reasoning-effort",
                        label: "Reasoning",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Low",
                                value: "low",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "High",
                                value: "high",
                            },
                        ],
                        type: "select",
                        value: "high",
                    },
                ],
                parentSessionId: TAB.sessionId,
                reasoningEffort: "high",
                runtimeSessionId: "runtime-child-1",
                sessionId: childSessionId,
                title: "Galileo",
            }),
        );

        await useAiStore.getState().setSessionConfigOption({
            optionId: "codex-reasoning-effort",
            sessionId: childSessionId,
            value: "low",
        });

        const snapshot =
            useAiStore.getState().sessions[childSessionId]?.snapshot ?? null;
        const reasoningConfig = snapshot?.configOptions.find(
            (option) => option.id === "codex-reasoning-effort",
        );

        expect(setAiSessionConfigOption).toHaveBeenCalledWith({
            optionId: "codex-reasoning-effort",
            sessionId: childSessionId,
            value: "low",
        });
        expect(snapshot?.reasoningEffort).toBe("low");
        expect(reasoningConfig).toMatchObject({ value: "low" });
    });

    it("does not roll back a newer optimistic config selection when an older request fails", async () => {
        let rejectFirstMutation!: (reason: unknown) => void;
        const firstMutation = new Promise<void>((_resolve, reject) => {
            rejectFirstMutation = reject;
        });
        const thirdMutation = createDeferred<void>();
        const setAiSessionConfigOption = vi
            .fn()
            .mockReturnValueOnce(firstMutation)
            .mockResolvedValueOnce(undefined)
            .mockReturnValueOnce(thirdMutation.promise);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [
                    {
                        category: "reasoning",
                        description: null,
                        id: "reasoning_effort",
                        label: "Reasoning",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Low",
                                value: "low",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "Medium",
                                value: "medium",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "High",
                                value: "high",
                            },
                        ],
                        type: "select",
                        value: "low",
                    },
                ],
                reasoningEffort: "low",
            }),
        );

        const first = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "medium",
        });
        const second = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "high",
        });

        await second;

        const staleSnapshot =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot ?? null;
        if (!staleSnapshot) {
            throw new Error("Expected the optimistic session snapshot.");
        }
        useAiStore.getState().applySessionSnapshot({
            ...staleSnapshot,
            configOptions: staleSnapshot.configOptions.map((option) =>
                option.type === "select" &&
                option.id === "reasoning_effort"
                    ? { ...option, value: "low" }
                    : option,
            ),
            reasoningEffort: "low",
            updatedAt: "2026-04-14T00:00:01.000Z",
        });
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("high");

        const third = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "low",
        });

        rejectFirstMutation(new Error("The first mutation failed."));
        await expect(first).rejects.toThrow("The first mutation failed.");

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("low");

        thirdMutation.resolve();
        await third;
    });

    it("restores the authoritative value when consecutive selections for one control both fail", async () => {
        let rejectMediumMutation!: (reason: unknown) => void;
        let rejectHighMutation!: (reason: unknown) => void;
        const mediumMutation = new Promise<void>((_resolve, reject) => {
            rejectMediumMutation = reject;
        });
        const highMutation = new Promise<void>((_resolve, reject) => {
            rejectHighMutation = reject;
        });
        const setAiSessionConfigOption = vi
            .fn()
            .mockReturnValueOnce(mediumMutation)
            .mockReturnValueOnce(highMutation);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: { comando: { setAiSessionConfigOption } },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [
                    {
                        category: "reasoning",
                        description: null,
                        id: "reasoning_effort",
                        label: "Reasoning",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Low",
                                value: "low",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "Medium",
                                value: "medium",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "High",
                                value: "high",
                            },
                        ],
                        type: "select",
                        value: "low",
                    },
                ],
                reasoningEffort: "low",
            }),
        );

        const medium = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "medium",
        });
        const high = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "high",
        });

        rejectMediumMutation(new Error("Medium failed."));
        await expect(medium).rejects.toThrow("Medium failed.");
        rejectHighMutation(new Error("High failed."));
        await expect(high).rejects.toThrow("High failed.");

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("low");
    });

    it("rolls back a failed control without reverting a newer different control", async () => {
        let rejectReasoningMutation!: (reason: unknown) => void;
        const reasoningMutation = new Promise<void>((_resolve, reject) => {
            rejectReasoningMutation = reject;
        });
        const fastMutation = createDeferred<void>();
        const setAiSessionConfigOption = vi
            .fn()
            .mockReturnValueOnce(reasoningMutation)
            .mockReturnValueOnce(fastMutation.promise);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [
                    {
                        category: "reasoning",
                        description: null,
                        id: "reasoning_effort",
                        label: "Reasoning",
                        options: [
                            {
                                description: null,
                                groupLabel: null,
                                label: "Low",
                                value: "low",
                            },
                            {
                                description: null,
                                groupLabel: null,
                                label: "High",
                                value: "high",
                            },
                        ],
                        type: "select",
                        value: "low",
                    },
                    {
                        category: "other",
                        description: null,
                        id: "fast",
                        label: "Fast",
                        type: "boolean",
                        value: false,
                    },
                ],
                reasoningEffort: "low",
            }),
        );

        const reasoning = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "high",
        });
        const fast = useAiStore.getState().setSessionConfigOption({
            optionId: "fast",
            sessionId: TAB.sessionId,
            value: true,
        });

        rejectReasoningMutation(new Error("Reasoning failed."));
        await expect(reasoning).rejects.toThrow("Reasoning failed.");

        const snapshot = useAiStore.getState().sessions[TAB.sessionId]?.snapshot;
        expect(snapshot?.reasoningEffort).toBe("low");
        expect(
            snapshot?.configOptions.find((option) => option.id === "fast")
                ?.value,
        ).toBe(true);

        fastMutation.resolve();
        await fast;
    });

    it("keeps a cold-session selection visible while the provider is prepared", async () => {
        const preparation = createDeferred<void>();
        const setAiSessionConfigOption = vi.fn().mockResolvedValue(undefined);
        const ensureLiveSession = vi.fn(() => preparation.promise);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        const reasoningConfig = {
            category: "reasoning" as const,
            description: null,
            id: "reasoning_effort",
            label: "Reasoning",
            options: [
                {
                    description: null,
                    groupLabel: null,
                    label: "Low",
                    value: "low",
                },
                {
                    description: null,
                    groupLabel: null,
                    label: "High",
                    value: "high",
                },
            ],
            type: "select" as const,
            value: "low",
        };
        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({ configOptions: [reasoningConfig] }),
        );
        useAiStore.getState().registerSessionTab(TAB);

        const mutation = useAiStore.getState().setSessionConfigOption(
            {
                optionId: "reasoning_effort",
                sessionId: TAB.sessionId,
                value: "high",
            },
            { ensureLiveSession },
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("high");
        expect(setAiSessionConfigOption).not.toHaveBeenCalled();

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [reasoningConfig],
                reasoningEffort: "low",
                runtimeSessionId: "runtime-session-prepared",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("high");

        preparation.resolve();
        await mutation;

        expect(ensureLiveSession).toHaveBeenCalledWith(false);
        expect(setAiSessionConfigOption).toHaveBeenCalledOnce();
    });

    it("does not publish a pending selection into the inherited runtime catalog", async () => {
        let rejectMutation!: (reason: unknown) => void;
        const remoteMutation = new Promise<void>((_resolve, reject) => {
            rejectMutation = reject;
        });
        const setAiSessionConfigOption = vi.fn(() => remoteMutation);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        const reasoningConfig = {
            category: "reasoning" as const,
            description: null,
            id: "reasoning_effort",
            label: "Reasoning",
            options: [
                {
                    description: null,
                    groupLabel: null,
                    label: "Low",
                    value: "low",
                },
                {
                    description: null,
                    groupLabel: null,
                    label: "High",
                    value: "high",
                },
            ],
            type: "select" as const,
            value: "low",
        };
        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({ configOptions: [reasoningConfig] }),
        );
        useAiStore.getState().registerSessionTab(TAB);

        const mutation = useAiStore.getState().setSessionConfigOption({
            optionId: "reasoning_effort",
            sessionId: TAB.sessionId,
            value: "high",
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [reasoningConfig],
                reasoningEffort: "low",
                runtimeSessionId: "runtime-session-prepared",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("high");
        expect(
            useAiStore
                .getState()
                .runtimeCatalogById.codex?.configOptions.find(
                    (option) => option.id === "reasoning_effort",
                )?.value,
        ).toBe("low");

        rejectMutation(new Error("Provider rejected the selection."));
        await expect(mutation).rejects.toThrow(
            "Provider rejected the selection.",
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("low");
        expect(
            useAiStore
                .getState()
                .runtimeCatalogById.codex?.configOptions.find(
                    (option) => option.id === "reasoning_effort",
                )?.value,
        ).toBe("low");
    });

    it("reprepares a retained session when its control target was evicted", async () => {
        const setAiSessionConfigOption = vi
            .fn()
            .mockRejectedValueOnce(new Error("The AI session was not found."))
            .mockResolvedValueOnce(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    setAiSessionConfigOption,
                },
            },
            writable: true,
        });

        const reasoningConfig = {
            category: "reasoning" as const,
            description: null,
            id: "reasoning_effort",
            label: "Reasoning",
            options: [
                {
                    description: null,
                    groupLabel: null,
                    label: "Low",
                    value: "low",
                },
                {
                    description: null,
                    groupLabel: null,
                    label: "High",
                    value: "high",
                },
            ],
            type: "select" as const,
            value: "low",
        };
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                configOptions: [reasoningConfig],
                reasoningEffort: "low",
            }),
        );
        const ensureLiveSession = vi.fn((force: boolean) => {
            if (!force) {
                return Promise.resolve();
            }
            useAiStore.getState().applySessionSnapshot(
                createSnapshot({
                    configOptions: [reasoningConfig],
                    reasoningEffort: "low",
                    runtimeSessionId: "runtime-session-reprepared",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            );
            return Promise.resolve();
        });

        await useAiStore.getState().setSessionConfigOption(
            {
                optionId: "reasoning_effort",
                sessionId: TAB.sessionId,
                value: "high",
            },
            { ensureLiveSession },
        );

        expect(ensureLiveSession.mock.calls).toEqual([[false], [true]]);
        expect(setAiSessionConfigOption).toHaveBeenCalledTimes(2);
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reasoningEffort,
        ).toBe("high");
    });

    it("does not treat status summaries as session titles", () => {
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ title: "Codex 1" }),
        );

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "status",
                status: "streaming",
                title: "Revisa login",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.title,
        ).toBe("Codex 1");
    });

    it("keeps a manual display title when session info updates the runtime title", () => {
        useAiStore.getState().registerSessionTab({
            ...TAB,
            title: "Manual title",
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                manualTitle: "Manual title",
                title: "Codex 1",
            }),
        );

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "session-info",
                parentSessionId: null,
                projectId: TAB.projectId,
                title: "Late runtime title",
                updatedAt: "2026-04-14T00:00:01.000Z",
                worktreeId: null,
            }),
        );

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.snapshot).toMatchObject({
            manualTitle: "Manual title",
            title: "Late runtime title",
        });
        expect(session?.meta?.title).toBe("Manual title");
    });

    it("preserves the root chat title when cancellation only changes status", () => {
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "streaming",
                title: "Diagnose chat cancellation",
            }),
        );

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "status",
                status: "idle",
                title: null,
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.title,
        ).toBe("Diagnose chat cancellation");
    });

    it("does not request resync for idle sessions", async () => {
        vi.useFakeTimers();
        const resyncAiSession = vi.fn().mockResolvedValue(null);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ status: "idle" }),
        );
        await vi.advanceTimersByTimeAsync(20_000);

        expect(resyncAiSession).not.toHaveBeenCalled();
    });

    it("requests resync for waiting permission sessions", async () => {
        vi.useFakeTimers();
        const resyncAiSession = vi.fn().mockResolvedValue(null);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({ status: "waiting_permission" }),
        );
        await vi.advanceTimersByTimeAsync(20_000);

        expect(resyncAiSession).toHaveBeenCalledWith(TAB.sessionId);
    });

    it("does not request resync while active sessions keep making visible progress", async () => {
        vi.useFakeTimers();
        const resyncAiSession = vi.fn().mockResolvedValue(null);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [createMessage({ content: "Hel" })],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:00.000Z",
            }),
        );
        await vi.advanceTimersByTimeAsync(10_000);

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    messages: [createMessage({ content: "Hello" })],
                    updatedAt: "2026-04-14T00:00:10.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(resyncAiSession).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(resyncAiSession).toHaveBeenCalledTimes(1);
    });

    it("retries resync for an unchanged active session when no snapshot is returned", async () => {
        vi.useFakeTimers();
        const resyncAiSession = vi.fn().mockResolvedValue(null);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [createMessage()],
                status: "streaming",
            }),
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await vi.advanceTimersByTimeAsync(40_000);

        expect(resyncAiSession).toHaveBeenCalledTimes(2);
        expect(resyncAiSession).toHaveBeenCalledWith(TAB.sessionId);
    });

    it("retries resync after a transient failure", async () => {
        vi.useFakeTimers();
        const error = new Error("ipc unavailable");
        const message = createMessage({
            content: "Complete",
            status: "completed",
        });
        const resyncAiSession = vi
            .fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValue(
                createSnapshot({
                    messages: [message],
                    status: "idle",
                    updatedAt: "2026-04-14T00:00:50.000Z",
                }),
            );
        const warn = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [createMessage()],
                status: "streaming",
            }),
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await vi.advanceTimersByTimeAsync(30_000);

        const snapshot =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot ?? null;
        expect(resyncAiSession).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(
            "[comando] Failed to resync quiet AI session.",
            error,
        );
        expect(snapshot?.status).toBe("idle");
        expect(snapshot?.messages).toEqual([message]);
    });

    it("applies a resynced snapshot without duplicating messages", async () => {
        vi.useFakeTimers();
        const message = createMessage({
            content: "Complete",
            status: "completed",
        });
        const resyncSnapshot = createSnapshot({
            messages: [message],
            status: "idle",
            updatedAt: "2026-04-14T00:00:20.000Z",
        });
        const resyncAiSession = vi.fn().mockResolvedValue(resyncSnapshot);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [createMessage({ content: "Complete" })],
                status: "streaming",
            }),
        );
        await vi.advanceTimersByTimeAsync(20_000);

        const snapshot =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot ?? null;
        expect(snapshot?.status).toBe("idle");
        expect(snapshot?.messages).toEqual([message]);
    });

    it("applies authoritative snapshots after visible transcript deltas were missed", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: createMessage({
                    content: "",
                    id: "assistant-1",
                }),
                messageKind: "assistant",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hel",
                delta: "Hel",
                kind: "message-delta",
                messageId: "assistant-1",
                messageKind: "assistant",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        const authoritativeMessage = createMessage({
            content: "Hello from the completed snapshot",
            id: "assistant-1",
            status: "completed",
        });
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [authoritativeMessage],
                status: "idle",
                updatedAt: "2026-04-14T00:00:20.000Z",
            }),
        );

        const snapshot =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot ?? null;
        expect(snapshot?.status).toBe("idle");
        expect(snapshot?.messages).toEqual([authoritativeMessage]);
        expect(snapshot?.messages).toHaveLength(1);
    });

    it("applies resynced tool activity progress after an active stream goes quiet", async () => {
        vi.useFakeTimers();
        const initialTool = createToolActivity({
            id: "tool-1",
            status: "in_progress",
            summary: "Running tests",
            updatedAt: "2026-04-14T00:00:01.000Z",
        });
        const updatedTool = createToolActivity({
            createdAt: "2026-04-14T00:00:20.000Z",
            id: "tool-1",
            status: "completed",
            summary: "Tests passed",
            updatedAt: "2026-04-14T00:00:20.000Z",
        });
        const resyncAiSession = vi.fn().mockResolvedValue(
            createSnapshot({
                messages: [createMessage({ status: "completed" })],
                status: "idle",
                toolActivity: [updatedTool],
                updatedAt: "2026-04-14T00:00:20.000Z",
            }),
        );
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    resyncAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [createMessage()],
                status: "streaming",
                toolActivity: [initialTool],
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
        await vi.advanceTimersByTimeAsync(20_000);

        const snapshot =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot ?? null;
        expect(resyncAiSession).toHaveBeenCalledWith(TAB.sessionId);
        expect(snapshot?.status).toBe("idle");
        expect(snapshot?.toolActivity).toEqual([
            {
                ...updatedTool,
                changeStats: null,
                createdAt: "2026-04-14T00:00:00.000Z",
            },
        ]);
    });

    it("applies a prepared runtime session snapshot from the backend", async () => {
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        const sendAiPrompt = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    prepareAiSession,
                    sendAiPrompt,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(TAB, { force: true });

        expect(prepareAiSession).toHaveBeenCalledWith({
            projectId: TAB.projectId,
            runtimeId: TAB.runtimeId,
            sessionId: TAB.sessionId,
            title: TAB.title,
            worktreeId: TAB.worktreeId,
        });
        expect(sendAiPrompt).not.toHaveBeenCalled();
        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            createSnapshot(),
        );
    });

    it("preserves canonical review action log when live session prepare returns an empty review", async () => {
        const trackedFile = createTrackedFile({ path: "cuento.md" });
        const reviewActionLog = createReviewActionLogFromTrackedFiles(
            TAB.sessionId,
            [trackedFile],
            { updatedAt: "2026-04-14T00:00:01.000Z" },
        );
        const prepareAiSession = vi
            .fn()
            .mockResolvedValueOnce(
                createSnapshot({
                    reviewActionLog,
                    trackedFiles: deriveTrackedFilesFromActionLog(reviewActionLog),
                    updatedAt: "2026-04-14T00:00:01.000Z",
                }),
            )
            .mockResolvedValueOnce(
                createSnapshot({
                    trackedFiles: [],
                    updatedAt: "2026-04-14T00:00:02.000Z",
                }),
            );
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(TAB);
        await useAiStore.getState().ensureSession(TAB, { force: true });

        expect(prepareAiSession).toHaveBeenCalledTimes(2);
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual(deriveTrackedFilesFromActionLog(reviewActionLog));
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reviewActionLog,
        ).toBe(reviewActionLog);
    });

    it("does not preserve legacy pending review files when a full incoming snapshot is empty", () => {
        const trackedFile = createTrackedFile({ path: "cuento.md" });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [trackedFile],
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
    });

    it("preserves canonical review action log when a full incoming snapshot is empty", () => {
        const trackedFile = createTrackedFile({ path: "cuento.md" });
        const reviewActionLog = createReviewActionLogFromTrackedFiles(
            TAB.sessionId,
            [trackedFile],
            { updatedAt: "2026-04-14T00:00:01.000Z" },
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                reviewActionLog,
                trackedFiles: deriveTrackedFilesFromActionLog(reviewActionLog),
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        const snapshot = useAiStore.getState().sessions[TAB.sessionId]?.snapshot;
        expect(snapshot?.reviewActionLog).toBe(reviewActionLog);
        expect(snapshot?.trackedFiles).toEqual(
            deriveTrackedFilesFromActionLog(reviewActionLog),
        );
    });

    it("hydrates history chat tabs without preparing the runtime session", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(
            createSnapshot({
                activeTurnStartedAt: "2026-04-14T00:00:01.000Z",
                messages: [
                    {
                        attachments: [],
                        content: "Working",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "assistant-1",
                        kind: "assistant",
                        status: "streaming",
                    },
                ],
                status: "streaming",
                toolActivity: [
                    {
                        createdAt: "2026-04-14T00:00:03.000Z",
                        diffs: [],
                        exitCode: null,
                        id: "tool-1",
                        kind: "shell",
                        locations: [],
                        rawInputJson: null,
                        rawOutputJson: null,
                        sessionId: TAB.sessionId,
                        status: "in_progress",
                        summary: "Running",
                        terminalOutput: null,
                        title: "Run command",
                        updatedAt: "2026-04-14T00:00:04.000Z",
                    },
                ],
            }),
        );
        const getAiRuntimeStatus = vi.fn().mockResolvedValue(createRuntimeStatus());
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    getAiSessionSnapshot,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);

        expect(getAiSessionSnapshot).toHaveBeenCalledWith(TAB.sessionId);
        expect(prepareAiSession).not.toHaveBeenCalled();
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.status,
        ).toBe("idle");
        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.snapshot?.activeTurnStartedAt).toBeNull();
        expect(session?.snapshot?.messages[0]?.status).toBe("completed");
        expect(session?.snapshot?.toolActivity[0]?.status).toBe("failed");
        expect(session?.transcript.lastTurnStartedMessageId).toBeNull();
    });

    it("force prepares history chat tabs as live sessions", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(createSnapshot());
        const prepareAiSession = vi.fn().mockResolvedValue(
            createSnapshot({
                modelId: "gpt-5",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);
        await useAiStore.getState().ensureSession(historyTab, { force: true });

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(getAiSessionSnapshot).toHaveBeenCalledTimes(1);
        expect(prepareAiSession).toHaveBeenCalledWith({
            projectId: TAB.projectId,
            runtimeId: TAB.runtimeId,
            sessionId: TAB.sessionId,
            title: TAB.title,
            worktreeId: TAB.worktreeId,
        });
        expect(session?.runtimeState).toBe("live");
        expect(session?.snapshot?.modelId).toBe("gpt-5");
    });

    it("hydrates a registered history tab instead of mistaking its placeholder for history", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const snapshot = createSnapshot({
            messages: [createMessage({ content: "Restored history" })],
        });
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(snapshot);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(historyTab);
        expect(
            useAiStore.getState().sessions[TAB.sessionId]
                ?.historyHydrationState,
        ).toBe("not_loaded");

        await useAiStore.getState().ensureSession(historyTab);

        expect(getAiSessionSnapshot).toHaveBeenCalledWith(TAB.sessionId);
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("Restored history");
        expect(
            useAiStore.getState().sessions[TAB.sessionId]
                ?.historyHydrationState,
        ).toBe("loaded");
    });

    it("keeps a saved chat readable when its runtime status cannot be loaded", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(
            createSnapshot({
                messages: [
                    createMessage({ content: "RUNTIME_FAILURE_MARKER" }),
                ],
            }),
        );

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockRejectedValue(new Error("Runtime unavailable")),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(getAiSessionSnapshot).toHaveBeenCalledWith(TAB.sessionId);
        expect(session?.historyHydrationState).toBe("loaded");
        expect(session?.localError).toBeNull();
        expect(session?.snapshot?.messages[0]?.content).toBe(
            "RUNTIME_FAILURE_MARKER",
        );
        expect(session?.transcript.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ content: "RUNTIME_FAILURE_MARKER" }),
            ]),
        );
    });

    it("keeps a hydrated chat loaded when its prompt queue cannot be restored", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(
            createSnapshot({
                messages: [createMessage({ content: "QUEUE_FAILURE_MARKER" })],
            }),
        );
        const getAiPromptQueue = vi
            .fn()
            .mockRejectedValue(new Error("Queue unavailable"));

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiPromptQueue,
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(getAiPromptQueue).toHaveBeenCalledWith(TAB.sessionId);
        expect(session?.historyHydrationState).toBe("loaded");
        expect(session?.localError).toBeNull();
        expect(session?.snapshot?.messages[0]?.content).toBe(
            "QUEUE_FAILURE_MARKER",
        );
        expect(session?.queue).toEqual([]);
    });

    it("marks an absent historical snapshot as missing instead of a loaded empty chat", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(null);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(getAiSessionSnapshot).toHaveBeenCalledWith(TAB.sessionId);
        expect(session?.historyHydrationState).toBe("missing");
        expect(session?.localError).toBe(
            "This saved chat is no longer available.",
        );
    });

    it("retries a missing historical snapshot and restores it when it becomes available", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                createSnapshot({
                    messages: [
                        createMessage({ content: "RECOVERED_SNAPSHOT_MARKER" }),
                    ],
                }),
            );

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);
        await useAiStore.getState().ensureSession(historyTab);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(getAiSessionSnapshot).toHaveBeenCalledTimes(2);
        expect(session?.historyHydrationState).toBe("loaded");
        expect(session?.snapshot?.messages[0]?.content).toBe(
            "RECOVERED_SNAPSHOT_MARKER",
        );
    });

    it("treats an existing empty historical snapshot as loaded", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(createSnapshot());

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.historyHydrationState).toBe("loaded");
        expect(session?.localError).toBeNull();
        expect(session?.snapshot?.messages).toEqual([]);
    });

    it("prepares a closed restored history chat before queuing a follow-up prompt", async () => {
        const historyTab: WorkspaceChatTab = {
            ...TAB,
            sessionOpenMode: "history",
        };
        const getAiSessionSnapshot = vi.fn().mockResolvedValue(
            createSnapshot({
                closedAt: "2026-04-14T00:05:00.000Z",
            }),
        );
        const prepareAiSession = vi.fn().mockResolvedValue(
            createSnapshot({
                closedAt: null,
                updatedAt: "2026-04-14T00:06:00.000Z",
            }),
        );
        const enqueueAiPrompt = vi.fn().mockResolvedValue({
            activeItem: {
                attachments: [],
                composerPartsSnapshot: [
                    { text: "Continue.", type: "text" as const },
                ],
                createdAt: "2026-04-14T00:06:01.000Z",
                error: null,
                fileContextsSnapshot: [],
                id: "message-continue",
                messageId: "message-continue",
                optimisticMessageId: "message-continue",
                projectId: TAB.projectId,
                prompt: "Continue.",
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
                status: "sending" as const,
                title: TAB.title,
                worktreeId: TAB.worktreeId,
            },
            editingItem: null,
            items: [],
            paused: false,
            revision: 1,
            sessionId: TAB.sessionId,
        });
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    enqueueAiPrompt,
                    getAiRuntimeStatus: vi
                        .fn()
                        .mockResolvedValue(createRuntimeStatus()),
                    getAiSessionSnapshot,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(historyTab);
        await useAiStore.getState().sendPrompt(historyTab, "Continue.");

        // Dispatch preparation belongs to the main-owned prompt queue. The
        // renderer keeps history navigation free of runtime work.
        expect(prepareAiSession).not.toHaveBeenCalled();
        expect(enqueueAiPrompt).toHaveBeenCalled();
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.activeQueuedPrompt
                ?.queuedPrompt.status,
        ).toBe("sending");
    });

    it("deduplicates concurrent ensureSession calls", async () => {
        const getAiRuntimeStatus = vi.fn().mockResolvedValue(createRuntimeStatus());
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        const firstEnsure = useAiStore.getState().ensureSession(TAB);
        const secondEnsure = useAiStore.getState().ensureSession(TAB);

        await Promise.all([firstEnsure, secondEnsure]);

        expect(getAiRuntimeStatus).toHaveBeenCalledTimes(1);
        expect(prepareAiSession).toHaveBeenCalledTimes(1);
        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            createSnapshot(),
        );
    });

    it("runs review mutations for a cold registered session without preparing runtime", async () => {
        const keepAllAiTrackedFiles = vi.fn().mockResolvedValue(undefined);
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAllAiTrackedFiles,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        useAiStore.getState().registerSessionTab(TAB);

        await useAiStore.getState().keepAllTrackedFiles(TAB.sessionId);

        expect(keepAllAiTrackedFiles).toHaveBeenCalledWith(TAB.sessionId);
        expect(prepareAiSession).not.toHaveBeenCalled();
    });

    it("preserves runtime commands when session hydration returns an empty snapshot catalog", async () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
            {
                description: "Summarize conversation",
                id: "compact",
                insertText: "/compact ",
                label: "/compact",
            },
        ];
        const getAiRuntimeStatus = vi.fn().mockResolvedValue(
            createRuntimeStatus({
                availableCommands,
            }),
        );
        const prepareAiSession = vi.fn().mockResolvedValue(createSnapshot());

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        await useAiStore.getState().ensureSession(TAB);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("applies typed message events without duplicating the following snapshot", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hello",
                delta: "Hello",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-completed",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "Hello",
                        createdAt: "2026-04-14T00:00:00.000Z",
                        id: "msg-1",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
            }),
        );

        const messages =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages ??
            [];
        const transcript =
            useAiStore.getState().sessions[TAB.sessionId]?.transcript;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual(
            expect.objectContaining({
                content: "Hello",
                id: "msg-1",
                status: "completed",
            }),
        );
        expect(transcript?.messageOrder).toEqual(["message:msg-1"]);
        expect(transcript?.messagesById["message:msg-1"]).toEqual(
            expect.objectContaining({
                kind: "message",
            }),
        );
    });

    it("flushes buffered deltas before completing a message", () => {
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: {
                    attachments: [],
                    content: "",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "msg-1",
                    kind: "assistant",
                    status: "streaming",
                },
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hel",
                delta: "Hel",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hello",
                delta: "lo",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("");

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-completed",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        const message =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0];
        expect(message).toEqual(
            expect.objectContaining({
                content: "Hello",
                status: "completed",
            }),
        );
    });

    it("coalesces streaming deltas for a session on the next animation frame", () => {
        const frameCallbacks = new Map<number, FrameRequestCallback>();
        let nextFrameId = 0;
        const requestAnimationFrame = vi.fn(
            (callback: FrameRequestCallback) => {
                nextFrameId += 1;
                frameCallbacks.set(nextFrameId, callback);
                return nextFrameId;
            },
        );
        vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
        vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
            frameCallbacks.delete(frameId);
        });

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: createMessage({ content: "", id: "msg-1" }),
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hel",
                delta: "Hel",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Hello",
                delta: "lo",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("");

        frameCallbacks.get(1)?.(0);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("Hello");
    });

    it("preserves canonical state for concurrent pane streams", () => {
        const frameCallbacks = new Map<number, FrameRequestCallback>();
        let nextFrameId = 0;
        vi.stubGlobal(
            "requestAnimationFrame",
            (callback: FrameRequestCallback) => {
                nextFrameId += 1;
                frameCallbacks.set(nextFrameId, callback);
                return nextFrameId;
            },
        );
        vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
            frameCallbacks.delete(frameId);
        });
        const backgroundSessionId = "session-background-pane";

        for (const [sessionId, messageId, content] of [
            [TAB.sessionId, "message-focused", "Focused result"],
            [backgroundSessionId, "message-background", "Background result"],
        ] as const) {
            useAiStore.getState().applySessionEvent(
                createSessionEvent({
                    kind: "message-started",
                    message: createMessage({ content: "", id: messageId }),
                    messageKind: "assistant",
                    sessionId,
                }),
            );
            useAiStore.getState().applySessionEvent(
                createSessionEvent({
                    content,
                    delta: content,
                    kind: "message-delta",
                    messageId,
                    messageKind: "assistant",
                    sessionId,
                }),
            );
        }

        expect(frameCallbacks).toHaveLength(2);
        for (const callback of frameCallbacks.values()) {
            callback(0);
        }

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("Focused result");
        expect(
            useAiStore.getState().sessions[backgroundSessionId]?.snapshot
                ?.messages[0]?.content,
        ).toBe("Background result");
    });

    it("flushes structural events without draining another session's frame", () => {
        const frameCallbacks = new Map<number, FrameRequestCallback>();
        let nextFrameId = 0;
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            nextFrameId += 1;
            frameCallbacks.set(nextFrameId, callback);
            return nextFrameId;
        });
        vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
            frameCallbacks.delete(frameId);
        });

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: createMessage({ content: "", id: "msg-1" }),
                messageKind: "assistant",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "First",
                delta: "First",
                kind: "message-delta",
                messageId: "msg-1",
                messageKind: "assistant",
            }),
        );

        const secondSessionId = "session-2";
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-started",
                message: createMessage({ content: "", id: "msg-2" }),
                messageKind: "assistant",
                sessionId: secondSessionId,
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                content: "Second",
                delta: "Second",
                kind: "message-delta",
                messageId: "msg-2",
                messageKind: "assistant",
                sessionId: secondSessionId,
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                kind: "message-completed",
                messageId: "msg-2",
                messageKind: "assistant",
                sessionId: secondSessionId,
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("");
        expect(
            useAiStore.getState().sessions[secondSessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("Second");

        frameCallbacks.get(1)?.(0);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot?.messages[0]
                ?.content,
        ).toBe("First");
    });

    it("preserves closed subagent status from incoming snapshots", () => {
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                closedAt: "2026-04-14T00:00:01.000Z",
                parentSessionId: "parent-session-1",
                status: "streaming",
            }),
        );

        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            expect.objectContaining({
                closedAt: "2026-04-14T00:00:01.000Z",
                parentSessionId: "parent-session-1",
                status: "streaming",
            }),
        );
    });

    it("upserts typed tool activity events by tool id", () => {
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                activity: createToolActivity({
                    status: "in_progress",
                    summary: "Running",
                }),
                kind: "tool-activity",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                activity: createToolActivity({
                    createdAt: "2026-04-14T00:00:05.000Z",
                    status: "completed",
                    summary: "Done",
                    updatedAt: "2026-04-14T00:00:05.000Z",
                }),
                kind: "tool-activity",
            }),
        );

        const toolActivity =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.toolActivity ?? [];
        expect(toolActivity).toHaveLength(1);
        expect(toolActivity[0]).toEqual(
            expect.objectContaining({
                createdAt: "2026-04-14T00:00:00.000Z",
                id: "tool-1",
                status: "completed",
                summary: "Done",
            }),
        );
        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.transcript
                .messageOrder,
        ).toEqual(["tool:session-1:tool-1"]);
    });

    it("preserves terminal output when later tool updates omit terminal fields", () => {
        useAiStore.getState().applySessionSnapshot(createSnapshot());

        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                activity: createToolActivity({
                    exitCode: 0,
                    status: "completed",
                    terminalOutput: "hello world",
                }),
                kind: "tool-activity",
            }),
        );
        useAiStore.getState().applySessionEvent(
            createSessionEvent({
                activity: createToolActivity({
                    rawOutputJson: JSON.stringify("done"),
                    status: "completed",
                    summary: "Done",
                    updatedAt: "2026-04-14T00:00:05.000Z",
                }),
                kind: "tool-activity",
            }),
        );

        const toolActivity =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.toolActivity ?? [];
        expect(toolActivity).toHaveLength(1);
        expect(toolActivity[0]).toEqual(
            expect.objectContaining({
                exitCode: 0,
                rawOutputJson: JSON.stringify("done"),
                summary: "Done",
                terminalOutput: "hello world",
            }),
        );
    });

    it("does not let a stale snapshot revive old tool activity", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "streaming",
                toolActivity: [],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                status: "idle",
                toolActivity: [
                    createToolActivity({
                        id: "tool-stale",
                    }),
                ],
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        const session = useAiStore.getState().sessions[TAB.sessionId];
        expect(session?.snapshot?.toolActivity).toEqual([]);
        expect(session?.transcript.messageOrder).toEqual([]);
        expect(session?.snapshot?.status).toBe("streaming");
    });

    it("does not let stale session hydration overwrite a newer snapshot", async () => {
        const prepareDeferred = createDeferred<AiSessionSnapshot>();
        const getAiRuntimeStatus = vi
            .fn()
            .mockResolvedValue(createRuntimeStatus());
        const prepareAiSession = vi.fn(() => prepareDeferred.promise);

        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    getAiRuntimeStatus,
                    prepareAiSession,
                },
            },
            writable: true,
        });

        const ensurePromise = useAiStore.getState().ensureSession(TAB);

        await vi.waitFor(() => {
            expect(prepareAiSession).toHaveBeenCalledTimes(1);
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "hello from backend",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-1",
                        kind: "user",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
        prepareDeferred.resolve(
            createSnapshot({
                messages: [],
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        await ensurePromise;

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "hello from backend",
                        id: "msg-1",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("does not let a stale full snapshot overwrite a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [],
                status: "idle",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer message",
                        id: "msg-newer",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("does not let a stale patch overwrite a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer patch message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer-patch",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    messages: [],
                    status: "idle",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer patch message",
                        id: "msg-newer-patch",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );
    });

    it("applies explicit cleanup fields while preserving a newer transcript", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                messages: [
                    {
                        attachments: [],
                        content: "newer patch message",
                        createdAt: "2026-04-14T00:00:02.000Z",
                        id: "msg-newer-patch",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
                status: "streaming",
                toolActivity: [
                    createToolActivity({
                        id: "tool-cleanup",
                    }),
                ],
                trackedFiles: [
                    {
                        hunks: [],
                        identityKey: "src/app.ts",
                        isText: true,
                        kind: "update",
                        newText: "changed",
                        oldText: "old",
                        path: "src/app.ts",
                        previousPath: null,
                        reviewState: "pending",
                        reversible: true,
                        sessionId: TAB.sessionId,
                        toolCallId: "tool-1",
                        updatedAt: "2026-04-14T00:00:02.000Z",
                    },
                ],
                updatedAt: "2026-04-14T00:00:02.000Z",
            }),
        );

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    messages: [],
                    pendingPermission: null,
                    status: "idle",
                    toolActivity: [],
                    trackedFiles: [],
                    updatedAt: "2026-04-14T00:00:03.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot,
        ).toEqual(
            expect.objectContaining({
                messages: [
                    expect.objectContaining({
                        content: "newer patch message",
                        id: "msg-newer-patch",
                    }),
                ],
                status: "idle",
                toolActivity: [],
                trackedFiles: [],
                updatedAt: "2026-04-14T00:00:03.000Z",
            }),
        );
    });

    it("optimistically removes tracked files through normalized path aliases", async () => {
        const keepAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFile,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "src\\app.ts",
                    }),
                ],
            }),
        );

        await useAiStore.getState().keepTrackedFile({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(keepAiTrackedFile).toHaveBeenCalledWith({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("optimistically removes tracked files through relative Windows casing aliases", async () => {
        setRendererPlatform("win32");

        const rejectAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    rejectAiTrackedFile,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "src/App.ts",
                    }),
                ],
            }),
        );

        await useAiStore.getState().rejectTrackedFile({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(rejectAiTrackedFile).toHaveBeenCalledWith({
            path: "src/app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("optimistically removes tracked files through identity targets", async () => {
        const keepAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFile,
                },
            },
        });
        const trackedFile = createTrackedFile({
            identityKey: "tracked-file-1",
            path: "src/app.ts",
            version: 2,
        });
        const samePathFile = createTrackedFile({
            identityKey: "tracked-file-2",
            path: "src/app.ts",
            version: 1,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [trackedFile, samePathFile],
            }),
        );

        await useAiStore.getState().keepTrackedFile({
            expectedVersion: 2,
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([samePathFile]);
        expect(keepAiTrackedFile).toHaveBeenCalledWith({
            expectedVersion: 2,
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });
    });

    it("optimistically updates tracked file hunks through Windows casing aliases", async () => {
        const keepAiTrackedFileHunks = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFileHunks,
                },
            },
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [
                    createTrackedFile({
                        path: "C:\\Repo\\src\\App.ts",
                    }),
                ],
            }),
        );
        const hunkId = "C:\\Repo\\src\\App.ts:1:1:0";

        await useAiStore.getState().keepTrackedFileHunks({
            hunkIds: [hunkId],
            path: "c:\\repo\\src\\app.ts",
            sessionId: TAB.sessionId,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([]);
        expect(keepAiTrackedFileHunks).toHaveBeenCalledWith({
            hunkIds: [hunkId],
            path: "c:\\repo\\src\\app.ts",
            sessionId: TAB.sessionId,
        });
    });

    it("optimistically resolves review action log hunks and mirrors derived tracked files", async () => {
        const keepAiTrackedFileHunks = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFileHunks,
                },
            },
        });
        const identityKey = `review:${TAB.sessionId}:src/app.ts`;
        const baseTracked = createTrackedFile({
            currentText: "ONE\ntwo\nTHREE\nfour\n",
            diffBase: "one\ntwo\nthree\nfour\n",
            identityKey,
            newText: "ONE\ntwo\nTHREE\nfour\n",
            oldText: "one\ntwo\nthree\nfour\n",
            path: "src/app.ts",
            version: 2,
        });
        const reviewActionLog = createReviewActionLogFromTrackedFiles(
            TAB.sessionId,
            [baseTracked],
        );

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                reviewActionLog,
                trackedFiles: [baseTracked],
            }),
        );

        // Hunk ids are engine-generated; resolve the first one (line "one").
        const beforeFile =
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.reviewActionLog?.trackedFilesByIdentityKey?.[identityKey];
        expect(beforeFile?.hunks.length).toBe(2);
        const firstHunkId = beforeFile?.hunks[0]?.id ?? "";
        const keepInput = {
            expectedVersion: beforeFile?.version,
            hunkIds: [firstHunkId],
            path: "src/app.ts",
            sessionId: TAB.sessionId,
            trackedFileId: identityKey,
        };

        await useAiStore.getState().keepTrackedFileHunks(keepInput);

        const snapshot = useAiStore.getState().sessions[TAB.sessionId]?.snapshot;
        const file =
            snapshot?.reviewActionLog?.trackedFilesByIdentityKey?.[identityKey];
        // The accepted hunk folds into the base; the other change stays pending.
        expect(file?.diffBase).toBe("ONE\ntwo\nthree\nfour\n");
        expect(file?.hunks.length).toBe(1);
        expect(snapshot?.trackedFiles).toEqual([
            expect.objectContaining({
                diffBase: "ONE\ntwo\nthree\nfour\n",
                identityKey,
                path: "src/app.ts",
            }),
        ]);
        expect(snapshot?.trackedFiles[0]?.hunks.length).toBe(1);
        expect(keepAiTrackedFileHunks).toHaveBeenCalledWith(keepInput);
    });

    it("does not optimistically remove a tracked file when the expected version is stale", async () => {
        const keepAiTrackedFile = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFile,
                },
            },
        });
        const trackedFile = createTrackedFile({
            identityKey: "tracked-file-1",
            version: 2,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [trackedFile],
            }),
        );

        await useAiStore.getState().keepTrackedFile({
            expectedVersion: 1,
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([trackedFile]);
        expect(keepAiTrackedFile).toHaveBeenCalledWith({
            expectedVersion: 1,
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });
    });

    it("does not optimistically resolve hunks when the expected version is stale", async () => {
        const keepAiTrackedFileHunks = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                comando: {
                    keepAiTrackedFileHunks,
                },
            },
        });
        const trackedFile = createTrackedFile({
            identityKey: "tracked-file-1",
            version: 2,
        });

        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                trackedFiles: [trackedFile],
            }),
        );

        await useAiStore.getState().keepTrackedFileHunks({
            expectedVersion: 1,
            hunkIds: ["hunk-1"],
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.trackedFiles,
        ).toEqual([trackedFile]);
        expect(keepAiTrackedFileHunks).toHaveBeenCalledWith({
            expectedVersion: 1,
            hunkIds: ["hunk-1"],
            path: trackedFile.path,
            sessionId: TAB.sessionId,
            trackedFileId: trackedFile.identityKey,
        });
    });

    it("creates a minimal session for orphan patches with runtime metadata", () => {
        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    parentSessionId: "session-parent",
                    runtimeSessionId: "runtime-child",
                    title: "Child Agent",
                    updatedAt: "2026-04-14T00:00:03.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: "session-child",
            },
        });

        expect(useAiStore.getState().sessions["session-child"]?.snapshot).toEqual(
            expect.objectContaining({
                parentSessionId: "session-parent",
                runtimeId: TAB.runtimeId,
                runtimeSessionId: "runtime-child",
                sessionId: "session-child",
                title: "Child Agent",
            }),
        );
    });

    it("keeps commands from an early catalog patch even before the session is registered", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];

        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    availableCommands,
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("preserves catalog commands when later config patches arrive for an empty session snapshot", () => {
        const availableCommands = [
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ];
        const configOptions = [
            {
                category: "reasoning" as const,
                description: null,
                id: "reasoning_effort",
                label: "Reasoning",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "High",
                        value: "high",
                    },
                ],
                type: "select" as const,
                value: "high",
            },
        ];

        useAiStore.getState().applyRuntimeStatus(
            createRuntimeStatus({
                availableCommands,
            }),
        );
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(createSnapshot());
        useAiStore.getState().applySessionUpdate({
            kind: "patch",
            patch: {
                changes: {
                    configOptions,
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.snapshot
                ?.availableCommands,
        ).toEqual(availableCommands);
        expect(
            useAiStore.getState().runtimeCatalogById.codex?.availableCommands,
        ).toEqual(availableCommands);
    });

    it("stores the dismissed plan revision per session", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore
            .getState()
            .dismissSessionPlan(TAB.sessionId, "2026-04-15T12:00:00.000Z");

        expect(
            useAiStore.getState().sessions[TAB.sessionId]
                ?.dismissedPlanUpdatedAt,
        ).toBe("2026-04-15T12:00:00.000Z");
    });

    it("stores the plan collapse preference per session", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore.getState().setSessionPlanCollapsed(TAB.sessionId, true);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.isPlanCollapsed,
        ).toBe(true);
    });

    it("keeps the pending review collapse preference per session", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore
            .getState()
            .setSessionPendingReviewCollapsed(TAB.sessionId, false);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]
                ?.isPendingReviewCollapsed,
        ).toBe(false);
    });

    it("merges incremental session patches without replacing the whole snapshot", () => {
        useAiStore.getState().registerSessionTab(TAB);
        useAiStore.getState().applySessionSnapshot(
            createSnapshot({
                availableCommands: [
                    {
                        description: "Plan",
                        id: "plan",
                        insertText: "/plan ",
                        label: "/plan",
                    },
                ],
                messages: [
                    {
                        attachments: [],
                        content: "hello",
                        createdAt: "2026-04-14T00:00:00.000Z",
                        id: "msg-1",
                        kind: "assistant",
                        status: "completed",
                    },
                ],
            }),
        );

        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    messages: [
                        {
                            attachments: [],
                            content: "hello world",
                            createdAt: "2026-04-14T00:00:00.000Z",
                            id: "msg-1",
                            kind: "assistant",
                            status: "streaming",
                        },
                    ],
                    status: "streaming",
                    updatedAt: "2026-04-14T00:00:01.000Z",
                },
                runtimeId: TAB.runtimeId,
                sessionId: TAB.sessionId,
            },
        };

        useAiStore.getState().applySessionUpdate(update);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.snapshot).toEqual(
            expect.objectContaining({
                availableCommands: [
                    expect.objectContaining({
                        id: "plan",
                    }),
                ],
                messages: [
                    expect.objectContaining({
                        content: "hello world",
                        status: "streaming",
                    }),
                ],
                status: "streaming",
                updatedAt: "2026-04-14T00:00:01.000Z",
            }),
        );
    });

    it("stores and persists session review presentation preferences", () => {
        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            null,
        );

        useAiStore.getState().setSessionDiffZoom(TAB.sessionId, 0.823);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.82,
        );

        expect(
            globalThis.localStorage.getItem(
                getSessionReviewPreferencesStorageKey(
                    TAB.projectId,
                    TAB.worktreeId,
                    TAB.sessionId,
                ),
            ),
        ).toContain('"diffZoom":0.82');
    });

    it("hydrates persisted session review presentation preferences on register", () => {
        globalThis.localStorage.setItem(
            getSessionReviewPreferencesStorageKey(
                TAB.projectId,
                TAB.worktreeId,
                TAB.sessionId,
            ),
            JSON.stringify({
                diffZoom: 0.84,
                updatedAt: Date.now(),
                version: 1,
            }),
        );

        useAiStore.getState().registerSessionTab(TAB);

        expect(useAiStore.getState().sessions[TAB.sessionId]?.diffZoom).toBe(
            0.84,
        );
    });

    it("allows full context and line fragments from same file without duplicating the same range", () => {
        useAiStore.getState().registerSessionTab(TAB);

        const fullFileContext = createFileContext();
        const lineFragmentContext = createFileContext({
            endLine: 18,
            id: "ctx-2",
            selectedText: "const value = 1;",
            startLine: 12,
        });
        const duplicateLineFragmentContext = createFileContext({
            endLine: 18,
            id: "ctx-3",
            selectedText: "const value = 1;",
            startLine: 12,
        });

        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, fullFileContext);
        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, lineFragmentContext);
        useAiStore
            .getState()
            .addDraftFileContext(TAB.sessionId, duplicateLineFragmentContext);

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.draftFileContexts,
        ).toEqual([fullFileContext, lineFragmentContext]);
    });

    it("inserts editor selection as selection_mention and avoids duplicates", () => {
        useAiStore.getState().registerSessionTab(TAB);

        useAiStore.getState().attachSelectionMention(TAB.sessionId, {
            endLine: 18,
            path: "src/app.ts",
            selectedText: "const value = 1;",
            startLine: 12,
        });
        useAiStore.getState().attachSelectionMention(TAB.sessionId, {
            endLine: 18,
            path: "src/app.ts",
            selectedText: "const value = 1;",
            startLine: 12,
        });

        expect(
            useAiStore.getState().sessions[TAB.sessionId]?.draftComposerParts,
        ).toEqual([
            { type: "text", text: "" },
            {
                type: "selection_mention",
                endLine: 18,
                label: "(12:18) - const value = 1;",
                path: "src/app.ts",
                selectedText: "const value = 1;",
                startLine: 12,
            },
            { type: "text", text: " " },
        ]);
    });
});
