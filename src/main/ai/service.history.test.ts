import { describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiOpenTranscriptTail,
    AiPromptQueueSnapshot,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiSessionUpdate,
    AiTranscriptBlockMetadataOutput,
    AiTrackedFile,
} from "@shared/ipc";

import { createReviewActionLogFromTrackedFiles } from "@shared/ai-review-action-log";

import { AiService } from "./service";
import type { NativeAiGateway } from "./contracts";

describe("AiService history", () => {
    it("publishes one renderer path for noisy live tool revisions", async () => {
        const onSessionEvent = vi.fn();
        const onSessionSnapshot = vi.fn();
        const service = createService({ onSessionEvent, onSessionSnapshot });
        const snapshot = createSnapshot({ status: "streaming" });
        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot,
        });
        onSessionEvent.mockClear();
        onSessionSnapshot.mockClear();

        for (let index = 0; index < 10_000; index += 1) {
            const updatedAt = new Date(index + 1).toISOString();
            service.handleNativeSessionEvent("window-1", {
                activity: {
                    createdAt: snapshot.updatedAt,
                    diffs: [],
                    exitCode: null,
                    id: "tool-pressure",
                    kind: "shell",
                    locations: [],
                    rawInputJson: null,
                    rawOutputJson: null,
                    sessionId: snapshot.sessionId,
                    status: "in_progress",
                    summary: null,
                    terminalOutput: null,
                    title: "Run tests",
                    updatedAt,
                },
                kind: "tool-activity",
                origin: "live",
                parentSessionId: null,
                runtimeId: snapshot.runtimeId,
                runtimeSessionId: snapshot.runtimeSessionId,
                sessionId: snapshot.sessionId,
                updatedAt,
            });
        }

        expect(onSessionEvent).toHaveBeenCalledTimes(10_000);
        expect(onSessionSnapshot).not.toHaveBeenCalled();
        expect(await service.getSessionSnapshot(snapshot.sessionId)).toMatchObject({
            toolActivity: [
                expect.objectContaining({
                    id: "tool-pressure",
                    status: "in_progress",
                }),
            ],
        });
        service.close();
    });

    it("returns session history from persistence", async () => {
        const expectedHistory: readonly AiHistorySessionSummary[] = [
            {
                createdAt: "2026-04-16T12:00:00.000Z",
                messageCount: 3,
                preview: "Assistant preview",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-1",
                title: "Session 1",
                updatedAt: "2026-04-16T12:00:00.000Z",
                worktreeId: "worktree-a",
            },
        ];
        const listSessionHistory = vi.fn(() => expectedHistory);
        const service = createService({
            listSessionHistory,
        });

        const history = await service.listSessionHistory({
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(listSessionHistory).toHaveBeenCalledWith({
            projectId: "project-1",
            worktreeId: "worktree-a",
        });
        expect(history).toEqual(expectedHistory);
    });

    it("returns a transcript page from persistence", async () => {
        const expectedPage: AiSessionTranscriptPage = {
            messages: [],
            offset: 0,
            sessionId: "session-1",
            totalMessages: 0,
        };
        const loadSessionTranscriptPage = vi.fn(() => expectedPage);
        const service = createService({
            loadSessionTranscriptPage,
        });

        const page = await service.getSessionTranscriptPage({
            limit: 50,
            offset: 0,
            sessionId: "session-1",
        });

        expect(loadSessionTranscriptPage).toHaveBeenCalledWith({
            limit: 50,
            offset: 0,
            sessionId: "session-1",
        });
        expect(page).toEqual(expectedPage);
    });

    it("checkpoints an active tail received only through a native snapshot", async () => {
        const checkpointOpenTranscriptTail = vi.fn<
            NonNullable<NativeAiGateway["checkpointOpenTranscriptTail"]>
        >(() => Promise.resolve());
        const snapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-16T12:00:00.000Z",
            messages: [
                {
                    attachments: [],
                    content: "Recovered streamed output.",
                    createdAt: "2026-04-16T12:00:01.000Z",
                    id: "assistant-1",
                    kind: "assistant",
                    status: "streaming",
                },
            ],
            status: "streaming",
        });
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail,
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                loadOpenTranscriptTail: vi.fn(() => Promise.resolve(null)),
                sealTranscriptTurn: vi.fn(() => Promise.resolve([])),
            }),
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });

            await vi.waitFor(() =>
                expect(checkpointOpenTranscriptTail).toHaveBeenCalledOnce(),
            );
            const checkpoint = checkpointOpenTranscriptTail.mock.calls[0]?.[0];
            expect(checkpoint).toMatchObject({
                sessionId: snapshot.sessionId,
                turnId: snapshot.activeTurnStartedAt,
            });
            // Assert entries separately so Vitest's untyped asymmetric matcher is not assigned.
            expect(checkpoint?.entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "message:assistant-1" }),
                ]),
            );
        } finally {
            service.close();
        }
    });

    it("reconciles a recovered terminal tail before checkpointing a newer snapshot", async () => {
        let resolveReconciliation!: (value: readonly ReturnType<typeof transcriptBlock>[]) => void;
        const reconciliation = new Promise<readonly ReturnType<typeof transcriptBlock>[]>((resolve) => {
            resolveReconciliation = resolve;
        });
        const checkpointOpenTranscriptTail = vi.fn<
            NonNullable<NativeAiGateway["checkpointOpenTranscriptTail"]>
        >(() => Promise.resolve());
        const loadTranscriptBlockMetadata = vi.fn(() => Promise.resolve({
            blocks: [],
            capabilityVersion: 1,
            sessionId: "session-1",
            transcriptRevision: 2,
        }));
        const snapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-16T12:02:00.000Z",
            messages: [{
                attachments: [],
                content: "New runtime output.",
                createdAt: "2026-04-16T12:02:01.000Z",
                id: "assistant-new",
                kind: "assistant",
                status: "streaming",
            }],
            status: "streaming",
        });
        const reconcileTerminalOpenTranscriptTail = vi.fn(() => reconciliation);
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail,
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState: vi.fn(() => Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "block-native" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 5,
                })),
                loadOpenTranscriptTail: vi.fn(() => Promise.resolve(
                    terminalTail(snapshot.sessionId),
                )),
                loadTranscriptBlockMetadata,
                reconcileTerminalOpenTranscriptTail,
                sealTranscriptTurn: vi.fn(() => Promise.resolve([])),
            }),
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });

            await vi.waitFor(() =>
                expect(reconcileTerminalOpenTranscriptTail).toHaveBeenCalledOnce(),
            );
            expect(checkpointOpenTranscriptTail).not.toHaveBeenCalled();
            expect(loadTranscriptBlockMetadata).not.toHaveBeenCalled();

            resolveReconciliation([]);

            await vi.waitFor(() =>
                expect(checkpointOpenTranscriptTail).toHaveBeenCalledOnce(),
            );
            await vi.waitFor(() =>
                expect(loadTranscriptBlockMetadata).toHaveBeenCalledOnce(),
            );
        } finally {
            service.close();
        }
    });

    it("discards metadata that was loaded before a concurrent seal", async () => {
        let resolveFirstMetadata!: (value: AiTranscriptBlockMetadataOutput) => void;
        const firstMetadata = new Promise<AiTranscriptBlockMetadataOutput>((resolve) => {
            resolveFirstMetadata = resolve;
        });
        const snapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-16T12:03:00.000Z",
            messages: [{
                attachments: [],
                content: "Output that will be sealed.",
                createdAt: "2026-04-16T12:03:01.000Z",
                id: "assistant-sealed",
                kind: "assistant",
                status: "streaming",
            }],
            status: "streaming",
        });
        const staleBlock = transcriptBlock(snapshot.sessionId, "stale", 1);
        const sealedBlock = transcriptBlock(snapshot.sessionId, "sealed", 2);
        const loadTranscriptBlockMetadata = vi
            .fn()
            .mockReturnValueOnce(firstMetadata)
            .mockResolvedValueOnce({
                blocks: [sealedBlock],
                capabilityVersion: 1,
                sessionId: snapshot.sessionId,
                transcriptRevision: 2,
            });
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail: vi.fn(() => Promise.resolve()),
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState: vi.fn(() => Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "block-native" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 5,
                })),
                loadOpenTranscriptTail: vi.fn(() => Promise.resolve(null)),
                loadTranscriptBlockMetadata,
                sealTranscriptTurn: vi.fn(() => Promise.resolve([sealedBlock])),
            }),
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });
            await vi.waitFor(() =>
                expect(loadTranscriptBlockMetadata).toHaveBeenCalledOnce(),
            );

            service.handleNativeSessionEvent("window-1", {
                error: null,
                kind: "turn-status",
                origin: "live",
                parentSessionId: null,
                runtimeId: "codex",
                runtimeSessionId: snapshot.runtimeSessionId,
                sessionId: snapshot.sessionId,
                status: "completed",
                turnId: snapshot.activeTurnStartedAt!,
                updatedAt: "2026-04-16T12:03:02.000Z",
            });
            await vi.waitFor(() =>
                expect(loadTranscriptBlockMetadata).toHaveBeenCalledTimes(1),
            );

            resolveFirstMetadata({
                blocks: [staleBlock],
                capabilityVersion: 1,
                sessionId: snapshot.sessionId,
                transcriptRevision: 1,
            });

            await vi.waitFor(() =>
                expect(loadTranscriptBlockMetadata).toHaveBeenCalledTimes(2),
            );
            expect(
                service.getLiveTranscriptTail(snapshot.sessionId)?.stableBlocks,
            ).toEqual([sealedBlock]);
        } finally {
            service.close();
        }
    });

    it("retains a closing tail until a timed-out checkpoint becomes durable", async () => {
        vi.useFakeTimers();
        let resolveCheckpoint!: () => void;
        const blockedCheckpoint = new Promise<void>((resolve) => {
            resolveCheckpoint = resolve;
        });
        const checkpointOpenTranscriptTail = vi.fn<
            NonNullable<NativeAiGateway["checkpointOpenTranscriptTail"]>
        >(() => blockedCheckpoint);
        const snapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-16T12:00:00.000Z",
            messages: [
                {
                    attachments: [],
                    content: "Keep this closing output.",
                    createdAt: "2026-04-16T12:00:01.000Z",
                    id: "assistant-closing",
                    kind: "assistant",
                    status: "streaming",
                },
            ],
            status: "streaming",
        });
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail,
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                loadOpenTranscriptTail: vi.fn(() => Promise.resolve(null)),
                sealTranscriptTurn: vi.fn(() => Promise.resolve([])),
            }),
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });
            await vi.waitFor(() =>
                expect(checkpointOpenTranscriptTail).toHaveBeenCalledOnce(),
            );

            service.handleNativeSessionClosed({
                ownerWindowId: "window-1",
                sessionId: snapshot.sessionId,
            });
            await vi.advanceTimersByTimeAsync(751);

            expect(service.getLiveTranscriptTail(snapshot.sessionId)).not.toBeNull();

            resolveCheckpoint();
            await vi.waitFor(() =>
                expect(service.getLiveTranscriptTail(snapshot.sessionId)).toBeNull(),
            );
        } finally {
            service.close();
            vi.useRealTimers();
        }
    });

    it("throws when a transcript page is requested for a missing session", async () => {
        const service = createService({
            loadSessionTranscriptPage: vi.fn(() => null),
        });

        await expect(
            service.getSessionTranscriptPage({
                limit: 50,
                offset: 0,
                sessionId: "missing-session",
            }),
        ).rejects.toThrowError("The session could not be found.");
    });

    it("keeps a legacy session on its complete snapshot when blocks are available globally", async () => {
        const snapshot = createSnapshot({
            messages: [
                {
                    attachments: [],
                    content: "Restore this historical user message.",
                    createdAt: "2026-04-16T12:00:00.000Z",
                    id: "user-1",
                    kind: "user",
                    status: "completed",
                },
            ],
        });
        const loadTranscriptBlockMetadata = vi.fn();
        const nativeAi = createNativeAiGateway({
            getTranscriptCapability: vi.fn(() => ({
                blockNativeVersion: 1,
                legacyFallbackAvailable: true,
            })),
            getTranscriptStorageState: vi.fn(() =>
                Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "legacy" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 3,
                }),
            ),
            loadSessionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
            loadTranscriptBlockMetadata,
        });
        const service = createService({ nativeAi });

        await expect(service.getSessionSnapshot(snapshot.sessionId)).resolves.toMatchObject({
            messages: snapshot.messages,
        });
        await expect(
            service.getTranscriptBlockMetadata(snapshot.sessionId),
        ).resolves.toBeNull();
        expect(loadTranscriptBlockMetadata).not.toHaveBeenCalled();
    });

    it("keeps an open tail visible while a live runtime owns the session", async () => {
        const snapshot = createSnapshot({
            activeTurnStartedAt: "2026-04-16T12:00:00.000Z",
            status: "streaming",
        });
        const openTail: AiOpenTranscriptTail = {
            entries: [{
                createdAt: "2026-04-16T12:00:01.000Z",
                id: "message:assistant-1",
                kind: "message",
                payloadRef: "tail:assistant-1",
                sequence: 1,
                sessionId: snapshot.sessionId,
                summary: {
                    label: "Assistant",
                    preview: "Recovered streamed output.",
                    status: "streaming",
                },
                updatedAt: "2026-04-16T12:00:01.000Z",
            }],
            entryRevisions: [{
                entryId: "message:assistant-1",
                entryRevision: 1,
                ordinal: 0,
            }],
            payloads: [{
                payloadRef: "tail:assistant-1",
                value: {
                    kind: "message",
                    message: {
                        attachments: [],
                        content: "Recovered streamed output.",
                        createdAt: "2026-04-16T12:00:01.000Z",
                        id: "assistant-1",
                        kind: "assistant",
                        status: "streaming",
                    },
                },
            }],
            revision: 1,
            sessionId: snapshot.sessionId,
            terminalStatus: null,
            turnId: snapshot.activeTurnStartedAt!,
            updatedAt: "2026-04-16T12:00:01.000Z",
        };
        const loadOpenTranscriptTail = vi.fn(() => Promise.resolve(openTail));
        const sealTranscriptTurn = vi.fn(() => Promise.resolve([]));
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail: vi.fn(() => Promise.resolve()),
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState: vi.fn(() => Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "block-native" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 5,
                })),
                loadOpenTranscriptTail,
                loadSessionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
                sealTranscriptTurn,
            }),
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });
            await vi.waitFor(() => expect(loadOpenTranscriptTail).toHaveBeenCalledOnce());
            const restored = await service.getSessionSnapshot(snapshot.sessionId);
            const recoveredMessage = service
                .getLiveTranscriptTail(snapshot.sessionId)
                ?.entries.find((entry) => entry.envelope.id === "message:assistant-1");
            expect(recoveredMessage?.payload).toMatchObject({
                message: { id: "assistant-1" },
            });
            expect(restored).toMatchObject({
                messages: [{
                    content: "Recovered streamed output.",
                    id: "assistant-1",
                }],
            });
            expect(sealTranscriptTurn).not.toHaveBeenCalled();
            expect(loadOpenTranscriptTail).toHaveBeenCalledOnce();
        } finally {
            service.close();
        }
    });

    it("seals an interrupted historical tail before loading block metadata", async () => {
        const snapshot = createSnapshot();
        const sealedBlock = {
            blockId: `${snapshot.sessionId}:0`,
            endSequence: 1,
            entryCount: 1,
            estimatedHeight: 72,
            estimatedRowCount: 1,
            firstCreatedAt: "2026-04-16T12:00:01.000Z",
            lastCreatedAt: "2026-04-16T12:00:01.000Z",
            revision: 1,
            sessionId: snapshot.sessionId,
            startSequence: 1,
        };
        const openTail: AiOpenTranscriptTail = {
            entries: [{
                createdAt: "2026-04-16T12:00:01.000Z",
                id: "message:assistant-1",
                kind: "message",
                payloadRef: "tail:assistant-1",
                sequence: 1,
                sessionId: snapshot.sessionId,
                summary: {
                    label: "Assistant",
                    preview: "Recovered streamed output.",
                    status: "streaming",
                },
                updatedAt: "2026-04-16T12:00:01.000Z",
            }],
            entryRevisions: [{
                entryId: "message:assistant-1",
                entryRevision: 1,
                ordinal: 0,
            }],
            payloads: [{
                payloadRef: "tail:assistant-1",
                value: {
                    kind: "message",
                    message: {
                        attachments: [],
                        content: "Recovered streamed output.",
                        createdAt: "2026-04-16T12:00:01.000Z",
                        id: "assistant-1",
                        kind: "assistant",
                        status: "streaming",
                    },
                },
            }],
            revision: 1,
            sessionId: snapshot.sessionId,
            terminalStatus: null,
            turnId: "interrupted-turn",
            updatedAt: "2026-04-16T12:00:01.000Z",
        };
        const loadTranscriptBlockMetadata = vi.fn(() => Promise.resolve({
            blocks: [sealedBlock],
            capabilityVersion: 1,
            sessionId: snapshot.sessionId,
            transcriptRevision: 1,
        }));
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail: vi.fn(() => Promise.resolve()),
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState: vi.fn(() => Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "block-native" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 5,
                })),
                loadOpenTranscriptTail: vi
                    .fn()
                    .mockResolvedValueOnce(openTail)
                    .mockResolvedValue(null),
                loadSessionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
                loadTranscriptBlockMetadata,
                sealTranscriptTurn: vi.fn(() => Promise.resolve([sealedBlock])),
            }),
        });

        try {
            const metadata = await service.getTranscriptBlockMetadata(snapshot.sessionId);
            const restored = await service.getSessionSnapshot(snapshot.sessionId);

            expect(restored?.messages).toEqual([]);
            expect(metadata?.blocks).toEqual([sealedBlock]);
            expect(
                service.getLiveTranscriptTail(snapshot.sessionId)?.stableBlocks,
            ).toEqual([sealedBlock]);
            expect(loadTranscriptBlockMetadata).toHaveBeenCalled();
        } finally {
            service.close();
        }
    });

    it("keeps a readable snapshot available when terminal-tail repair fails", async () => {
        const snapshot = createSnapshot({
            activeTurnStartedAt: null,
            status: "idle",
        });
        const loadOpenTranscriptTail = vi.fn(() => Promise.resolve(
            terminalTail(snapshot.sessionId),
        ));
        const reconcileTerminalOpenTranscriptTail = vi.fn(() => Promise.reject(
            new Error("reconciliation unavailable"),
        ));
        const service = createService({
            nativeAi: createNativeAiGateway({
                checkpointOpenTranscriptTail: vi.fn(() => Promise.resolve()),
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState: vi.fn(() => Promise.resolve({
                    capabilityVersion: 1,
                    legacyFallbackAvailable: true,
                    migrationManifestExists: false,
                    mode: "block-native" as const,
                    sessionId: snapshot.sessionId,
                    storageVersion: 5,
                })),
                loadOpenTranscriptTail,
                loadSessionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
                reconcileTerminalOpenTranscriptTail,
                sealTranscriptTurn: vi.fn(() => Promise.resolve([])),
            }),
        });

        try {
            await expect(service.getSessionSnapshot(snapshot.sessionId)).resolves.toMatchObject({
                sessionId: snapshot.sessionId,
            });
            await vi.waitFor(() =>
                expect(reconcileTerminalOpenTranscriptTail).toHaveBeenCalled(),
            );

            expect(loadOpenTranscriptTail).toHaveBeenCalledOnce();
        } finally {
            service.close();
        }
    });

    it("retries a transient transcript migration status failure", async () => {
        vi.useFakeTimers();
        const snapshot = createSnapshot();
        const getTranscriptStorageState = vi
            .fn()
            .mockResolvedValueOnce({
                capabilityVersion: 1,
                legacyFallbackAvailable: true,
                migrationManifestExists: false,
                mode: "migrating" as const,
                sessionId: snapshot.sessionId,
                storageVersion: 5,
            })
            .mockRejectedValueOnce(new Error("temporary native backend failure"))
            .mockResolvedValue({
                capabilityVersion: 1,
                legacyFallbackAvailable: true,
                migrationManifestExists: false,
                mode: "block-native" as const,
                sessionId: snapshot.sessionId,
                storageVersion: 5,
            });
        const service = createService({
            nativeAi: createNativeAiGateway({
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState,
                loadSessionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
            }),
        });

        try {
            await service.getSessionSnapshot(snapshot.sessionId);
            await vi.advanceTimersByTimeAsync(50);

            expect(getTranscriptStorageState).toHaveBeenCalledTimes(3);
        } finally {
            service.close();
            vi.useRealTimers();
        }
    });

    it("notifies the renderer when a live transcript migration becomes block-native", async () => {
        vi.useFakeTimers();
        const snapshot = createSnapshot();
        const onSessionSnapshot = vi.fn();
        const getTranscriptStorageState = vi
            .fn()
            .mockResolvedValueOnce({
                capabilityVersion: 1,
                legacyFallbackAvailable: true,
                migrationManifestExists: true,
                mode: "migrating" as const,
                sessionId: snapshot.sessionId,
                storageVersion: 5,
            })
            .mockResolvedValue({
                capabilityVersion: 1,
                legacyFallbackAvailable: true,
                migrationManifestExists: false,
                mode: "block-native" as const,
                sessionId: snapshot.sessionId,
                storageVersion: 5,
            });
        const service = createService({
            nativeAi: createNativeAiGateway({
                getTranscriptCapability: vi.fn(() => ({
                    blockNativeVersion: 1,
                    legacyFallbackAvailable: true,
                })),
                getTranscriptStorageState,
                loadTranscriptBlockMetadata: vi.fn(() => Promise.resolve({
                    blocks: [],
                    capabilityVersion: 1,
                    sessionId: snapshot.sessionId,
                    transcriptRevision: 1,
                })),
            }),
            onSessionSnapshot,
        });

        try {
            service.handleNativeSessionSnapshot("window-1", {
                kind: "snapshot",
                snapshot,
            });
            await vi.advanceTimersByTimeAsync(25);

            expect(onSessionSnapshot).toHaveBeenCalledTimes(2);
            expect(onSessionSnapshot).toHaveBeenLastCalledWith(
                "",
                expect.objectContaining({ kind: "snapshot" }),
            );
        } finally {
            service.close();
            vi.useRealTimers();
        }
    });

    it("deletes a persisted session when no live runtime session exists", async () => {
        const deleteSession = vi.fn();
        const service = createService({
            deleteSession,
        });

        await service.deleteSession("session-1");

        expect(deleteSession).toHaveBeenCalledWith("session-1");
    });

    it("prunes expired native history and ignores later snapshots", async () => {
        const pruneSessionHistory = vi.fn(() =>
            Promise.resolve({
                deletedRootIds: ["session-1"],
                deletedSessionIds: ["session-1", "session-child"],
                failedRootIds: [],
                inspectedSessionCount: 3,
                protectedTreeCount: 1,
                invalidMetadataCount: 0,
                invalidTimestampCount: 0,
                policyChanged: false,
            }),
        );
        const onSessionSnapshot = vi.fn();
        const service = createService({
            nativeAi: createNativeAiGateway({ pruneSessionHistory }),
            onSessionSnapshot,
        });

        const result = await service.pruneExpiredHistory(
            "2026-08-01T12:00:00.000Z",
            7,
        );
        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({ sessionId: "session-child" }),
        });

        expect(pruneSessionHistory).toHaveBeenCalledWith({
            cutoff: "2026-08-01T12:00:00.000Z",
            protectedSessionIds: [],
            retentionDays: 7,
        });
        expect(result.deletedSessionIds).toEqual([
            "session-1",
            "session-child",
        ]);
        expect(onSessionSnapshot).not.toHaveBeenCalled();
    });

    it("protects restored prompt queues from retention pruning", async () => {
        const pruneSessionHistory = vi.fn(() =>
            Promise.resolve({
                deletedRootIds: [],
                deletedSessionIds: [],
                failedRootIds: [],
                inspectedSessionCount: 1,
                protectedTreeCount: 1,
                invalidMetadataCount: 0,
                invalidTimestampCount: 0,
                policyChanged: false,
            }),
        );
        const restoredPrompt = {
            additionalRoots: [],
            attachments: [],
            composerPartsSnapshot: [{ text: "Keep this prompt", type: "text" as const }],
            createdAt: "2026-07-01T12:00:00.000Z",
            error: null,
            fileContextsSnapshot: [],
            id: "queued-1",
            messageId: "message-1",
            projectId: "project-1",
            prompt: "Keep this prompt",
            runtimeId: "codex" as const,
            sessionId: "queued-session",
            status: "queued" as const,
            title: "Queued session",
            worktreeId: null,
        };
        const restoredQueue: AiPromptQueueSnapshot = {
            activeItem: null,
            editingItem: null,
            items: [restoredPrompt],
            paused: true,
            revision: 1,
            sessionId: "queued-session",
        };
        const service = createService({
            loadPromptQueueSnapshots: vi.fn(() => [restoredQueue]),
            nativeAi: createNativeAiGateway({ pruneSessionHistory }),
        });

        await service.pruneExpiredHistory("2026-08-01T12:00:00.000Z", 7);

        expect(pruneSessionHistory).toHaveBeenCalledWith({
            cutoff: "2026-08-01T12:00:00.000Z",
            protectedSessionIds: ["queued-session"],
            retentionDays: 7,
        });
    });

    it("deletes every persisted descendant from leaf to root", async () => {
        const deleteSession = vi.fn();
        const listSessionRuntimeMappingsForParent = vi.fn(() => [
            {
                appSessionId: "session-child",
                parentAppSessionId: "session-parent",
                parentRuntimeSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child",
            },
            {
                appSessionId: "session-grandchild",
                parentAppSessionId: "session-child",
                parentRuntimeSessionId: "runtime-child",
                runtimeSessionId: "runtime-grandchild",
            },
        ]);
        const service = createService({
            deleteSession,
            listSessionRuntimeMappingsForParent,
        });

        await service.deleteSession("session-parent");

        expect(listSessionRuntimeMappingsForParent).toHaveBeenCalledWith(
            "session-parent",
        );
        expect(deleteSession.mock.calls).toEqual([
            ["session-grandchild"],
            ["session-child"],
            ["session-parent"],
        ]);
    });

    it("ignores late worker snapshots after deleting a session", async () => {
        const deleteSession = vi.fn();
        const onSessionSnapshot = vi.fn();
        const saveSessionSnapshot = createSaveSessionSnapshotMock();
        const service = createService({
            deleteSession,
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        await service.deleteSession("session-1");

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                sessionId: "session-1",
                title: "Late snapshot",
            }),
        });

        expect(saveSessionSnapshot).not.toHaveBeenCalled();
        expect(onSessionSnapshot).not.toHaveBeenCalled();
    });

    it("persists native catalog patches for runtime control rehydration", () => {
        const onSessionSnapshot = vi.fn();
        const saveSessionSnapshot = vi.fn();
        const saveRuntimeCatalogPatch = vi.fn();
        const service = createService({
            onSessionSnapshot,
            saveRuntimeCatalogPatch,
            saveSessionSnapshot,
        });
        const configOptions = [
            {
                category: "model",
                description: null,
                id: "model",
                label: "Model",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "GPT-5",
                        value: "gpt-5",
                    },
                ],
                type: "select",
                value: "gpt-5",
            },
        ] satisfies AiSessionSnapshot["configOptions"];

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot(),
        });
        saveSessionSnapshot.mockClear();
        saveRuntimeCatalogPatch.mockClear();

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            {
                configOptions,
            },
            "2026-04-16T12:05:00.000Z",
        );

        expect(saveRuntimeCatalogPatch).toHaveBeenCalledWith(
            "codex",
            expect.objectContaining({
                configOptions,
                modelId: "gpt-5",
                models: [
                    {
                        description: null,
                        id: "gpt-5",
                        name: "GPT-5",
                    },
                ],
            }),
        );
        expect(saveSessionSnapshot).not.toHaveBeenCalled();
        expect(onSessionSnapshot).toHaveBeenLastCalledWith(
            "window-1",
            expect.objectContaining({
                kind: "patch",
            }),
        );
    });

    it("applies native catalog patches that arrive before the session snapshot", () => {
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const saveRuntimeCatalogPatch = vi.fn();
        const service = createService({
            onSessionSnapshot,
            saveRuntimeCatalogPatch,
        });
        const configOptions = [
            {
                category: "model",
                description: null,
                id: "model",
                label: "Model",
                options: [
                    {
                        description: null,
                        groupLabel: null,
                        label: "GPT-5",
                        value: "gpt-5",
                    },
                ],
                type: "select",
                value: "gpt-5",
            },
        ] satisfies AiSessionSnapshot["configOptions"];

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            { configOptions },
            "2026-04-16T12:05:00.000Z",
        );
        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot(),
        });

        expect(saveRuntimeCatalogPatch).toHaveBeenCalledWith(
            "codex",
            expect.objectContaining({
                configOptions,
                modelId: "gpt-5",
                models: [
                    {
                        description: null,
                        id: "gpt-5",
                        name: "GPT-5",
                    },
                ],
            }),
        );
        const lastSnapshotCall = onSessionSnapshot.mock.lastCall;
        expect(lastSnapshotCall?.[0]).toBe("window-1");
        const lastSnapshotUpdate = lastSnapshotCall?.[1];
        expect(lastSnapshotUpdate?.kind).toBe("snapshot");
        if (lastSnapshotUpdate?.kind !== "snapshot") {
            throw new Error("Expected the pending catalog patch to emit a snapshot.");
        }
        expect(lastSnapshotUpdate.snapshot).toMatchObject({
            configOptions,
            modelId: "gpt-5",
        });
    });

    it("preserves persisted controls when ACP sends a partial catalog patch", () => {
        const saveSessionSnapshot = vi.fn();
        const saveRuntimeCatalogPatch = vi.fn();
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const persistedCatalog = {
            availableCommands: [],
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
                            label: "GPT-5",
                            value: "gpt-5",
                        },
                    ],
                    type: "select",
                    value: "gpt-5",
                },
            ],
            modeId: "full-access",
            modes: [
                {
                    description: "No prompts",
                    id: "full-access",
                    name: "Full Access",
                },
            ],
            modelId: "gpt-5",
            models: [
                {
                    description: "Frontier model",
                    id: "gpt-5",
                    name: "GPT-5",
                },
            ],
        } satisfies Pick<
            AiSessionSnapshot,
            | "availableCommands"
            | "configOptions"
            | "modeId"
            | "modes"
            | "modelId"
            | "models"
        >;
        const service = createService({
            loadLatestRuntimeCatalog: vi.fn(() => persistedCatalog),
            onSessionSnapshot,
            saveRuntimeCatalogPatch,
            saveSessionSnapshot,
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot(),
        });
        const initialUpdate = onSessionSnapshot.mock.lastCall?.[1];
        expect(initialUpdate?.kind).toBe("snapshot");
        if (initialUpdate?.kind !== "snapshot") {
            throw new Error("Expected an initial snapshot update.");
        }
        expect(initialUpdate.snapshot.configOptions).toEqual(
            persistedCatalog.configOptions,
        );
        expect(initialUpdate.snapshot.models).toEqual(persistedCatalog.models);
        saveSessionSnapshot.mockClear();
        saveRuntimeCatalogPatch.mockClear();

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            {
                availableCommands: [
                    {
                        description: "Review changes",
                        id: "review",
                        insertText: "/review ",
                        label: "/review",
                    },
                ],
            },
            "2026-04-16T12:05:00.000Z",
        );

        expect(saveRuntimeCatalogPatch).toHaveBeenCalledWith(
            "codex",
            {
                availableCommands: [
                    {
                        description: "Review changes",
                        id: "review",
                        insertText: "/review ",
                        label: "/review",
                    },
                ],
            },
        );
        expect(saveSessionSnapshot).not.toHaveBeenCalled();
        const patchUpdate = onSessionSnapshot.mock.lastCall?.[1];
        expect(patchUpdate?.kind).toBe("patch");
        if (patchUpdate?.kind !== "patch") {
            throw new Error("Expected a catalog patch update.");
        }
        expect(patchUpdate.patch.changes.availableCommands).toEqual([
            {
                description: "Review changes",
                id: "review",
                insertText: "/review ",
                label: "/review",
            },
        ]);
    });

    it("clears stale model and mode ids when ACP clears config options", async () => {
        const saveRuntimeCatalogPatch = vi.fn();
        const persistedCatalog = {
            availableCommands: [],
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
                            label: "GPT-5",
                            value: "gpt-5",
                        },
                    ],
                    type: "select",
                    value: "gpt-5",
                },
            ],
            modeId: "full-access",
            modes: [
                {
                    description: "No prompts",
                    id: "full-access",
                    name: "Full Access",
                },
            ],
            modelId: "gpt-5",
            models: [
                {
                    description: "Frontier model",
                    id: "gpt-5",
                    name: "GPT-5",
                },
            ],
        } satisfies Pick<
            AiSessionSnapshot,
            | "availableCommands"
            | "configOptions"
            | "modeId"
            | "modes"
            | "modelId"
            | "models"
        >;
        const service = createService({
            loadLatestRuntimeCatalog: vi.fn(() => persistedCatalog),
            saveRuntimeCatalogPatch,
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot(),
        });
        saveRuntimeCatalogPatch.mockClear();

        service.handleNativeSessionCatalogPatch(
            "window-1",
            "session-1",
            {
                configOptions: [],
            },
            "2026-04-16T12:05:00.000Z",
        );

        expect(saveRuntimeCatalogPatch).toHaveBeenCalledWith("codex", {
            configOptions: [],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
        });
        await expect(service.getSessionSnapshot("session-1")).resolves.toMatchObject({
            configOptions: [],
            modeId: null,
            modes: [],
            modelId: null,
            models: [],
        });
    });

    it("delegates pinning mutations to persistence", async () => {
        const setSessionPinned = vi.fn();
        const service = createService({
            setSessionPinned,
        });

        await service.setSessionPinned({
            pinned: true,
            sessionId: "session-1",
        });

        expect(setSessionPinned).toHaveBeenCalledWith("session-1", true);
    });

    it("uses native history when the native gateway owns history", async () => {
        const expectedHistory: readonly AiHistorySessionSummary[] = [
            {
                createdAt: "2026-04-16T12:00:00.000Z",
                messageCount: 1,
                preview: "Native",
                projectId: "project-1",
                runtimeId: "codex",
                sessionId: "session-native",
                title: "Native",
                updatedAt: "2026-04-16T12:00:00.000Z",
                worktreeId: "worktree-a",
            },
        ];
        const nativeListSessionHistory = vi.fn(() =>
            Promise.resolve(expectedHistory),
        );
        const nativeAi = createNativeAiGateway({
            listSessionHistory: nativeListSessionHistory,
        });
        const persistenceList = vi.fn(() => []);
        const service = createService({
            listSessionHistory: persistenceList,
            nativeAi,
        });

        const history = await service.listSessionHistory({
            projectId: "project-1",
            worktreeId: "worktree-a",
        });

        expect(nativeListSessionHistory).toHaveBeenCalled();
        expect(persistenceList).not.toHaveBeenCalled();
        expect(history).toEqual(expectedHistory);
    });

    it("propagates native pinning failures without writing fallback persistence", async () => {
        const setSessionPinned = vi.fn();
        const nativeSetSessionPinned = vi.fn(() =>
            Promise.reject(new Error("missing")),
        );
        const nativeAi = createNativeAiGateway({
            setSessionPinned: nativeSetSessionPinned,
        });
        const service = createService({
            nativeAi,
            setSessionPinned,
        });

        await expect(
            service.setSessionPinned({
                pinned: true,
                sessionId: "session-native",
            }),
        ).rejects.toThrow("missing");

        expect(nativeSetSessionPinned).toHaveBeenCalled();
        expect(setSessionPinned).not.toHaveBeenCalled();
    });

    it("derives live tracked files from review action log snapshots", () => {
        const trackedFile = createTrackedFile();
        const reviewActionLog = createReviewActionLogFromTrackedFiles(
            "session-1",
            [trackedFile],
            {
                updatedAt: "2026-04-16T12:00:00.000Z",
            },
        );
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const saveSessionSnapshot = vi.fn();
        const service = createService({
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                reviewActionLog,
                trackedFiles: [],
            }),
        });

        const savedSnapshot =
            readLastSavedSessionSnapshot(saveSessionSnapshot);
        expect(savedSnapshot).toMatchObject({
            reviewActionLog,
            trackedFiles: [
                expect.objectContaining({
                    currentText: "after\n",
                    diffBase: "before\n",
                    path: "src/app.ts",
                    reviewState: "pending",
                }),
            ],
        });
        const update = onSessionSnapshot.mock.calls.at(-1)?.[1];
        expect(update?.kind).toBe("snapshot");
        if (update?.kind !== "snapshot") {
            throw new Error("Expected a snapshot update.");
        }
        expect(update.snapshot.trackedFiles).toEqual(savedSnapshot.trackedFiles);
    });

    it("drops live legacy tracked files without a review action log", () => {
        const trackedFile = createTrackedFile();
        const saveSessionSnapshot = createSaveSessionSnapshotMock();
        const service = createService({
            saveSessionSnapshot,
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                trackedFiles: [trackedFile],
            }),
        });

        const savedSnapshot =
            readLastSavedSessionSnapshot(saveSessionSnapshot);
        expect(savedSnapshot).toMatchObject({
            reviewActionLog: null,
            trackedFiles: [],
        });
    });

    it("does not rederive legacy tracked file patches from an old action log", () => {
        const trackedFile = createTrackedFile();
        const onSessionSnapshot = vi.fn<
            (ownerWindowId: string, update: AiSessionUpdate) => void
        >();
        const saveSessionSnapshot = createSaveSessionSnapshotMock();
        const service = createService({
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        service.handleNativeSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: createSnapshot({
                trackedFiles: [trackedFile],
            }),
        });
        saveSessionSnapshot.mockClear();
        onSessionSnapshot.mockClear();

        service.handleNativeSessionSnapshot("window-1", {
            kind: "patch",
            patch: {
                changes: {
                    trackedFiles: [],
                    updatedAt: "2026-04-16T12:01:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-1",
            },
        });

        const savedSnapshot =
            readLastSavedSessionSnapshot(saveSessionSnapshot);
        expect(savedSnapshot).toMatchObject({
            reviewActionLog: null,
            trackedFiles: [],
        });
        const update = onSessionSnapshot.mock.calls.at(-1)?.[1];
        expect(update).toMatchObject({
            kind: "patch",
            patch: {
                changes: {
                    trackedFiles: [],
                },
            },
        });
    });

    it("does not restore pending review state from persisted snapshots", async () => {
        const trackedFile = createTrackedFile();
        const reviewActionLog = createReviewActionLogFromTrackedFiles(
            "session-1",
            [trackedFile],
            {
                updatedAt: "2026-04-16T12:00:00.000Z",
            },
        );
        const service = createService({
            loadSessionSnapshot: vi.fn(() =>
                createSnapshot({
                    reviewActionLog,
                    trackedFiles: [trackedFile],
                }),
            ),
        });

        const snapshot = await service.getSessionSnapshot("session-1");

        expect(snapshot).toMatchObject({
            reviewActionLog: null,
            trackedFiles: [],
        });
    });

    it("restores versioned native review placeholders from persisted snapshots", async () => {
        const trackedFile = createTrackedFile({
            nativeReviewDeltaId: "delta-1",
            nativeReviewInputRevision: 4,
            nativeReviewState: "preparing",
            nativeReviewWorkCycleId: "cycle-1",
        });
        const service = createService({
            loadSessionSnapshot: vi.fn(() =>
                createSnapshot({
                    trackedFiles: [trackedFile],
                }),
            ),
        });

        const snapshot = await service.getSessionSnapshot("session-1");

        expect(snapshot?.trackedFiles).toEqual([trackedFile]);
    });
});

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
        projectId: "project-1",
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        status: "idle",
        title: "Session 1",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-16T12:00:00.000Z",
        worktreeId: "worktree-a",
        ...overrides,
    };
}

function terminalTail(sessionId: string): AiOpenTranscriptTail {
    return {
        entries: [],
        entryRevisions: [],
        payloads: [],
        revision: 1,
        sessionId,
        terminalStatus: "completed",
        turnId: "terminal-turn",
        updatedAt: "2026-04-16T12:00:01.000Z",
    };
}

function transcriptBlock(
    sessionId: string,
    suffix: string,
    revision: number,
) {
    return {
        blockId: `${sessionId}:${suffix}`,
        endSequence: revision,
        entryCount: 1,
        estimatedHeight: 72,
        estimatedRowCount: 1,
        firstCreatedAt: "2026-04-16T12:00:01.000Z",
        lastCreatedAt: "2026-04-16T12:00:01.000Z",
        revision,
        sessionId,
        startSequence: revision,
    };
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        currentText: "after\n",
        diffBase: "before\n",
        hunks: [],
        identityKey: "review:session-1:src/app.ts",
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-16T12:00:00.000Z",
        version: 1,
        ...overrides,
    };
}

function createService(overrides: {
    readonly deleteSession?: ReturnType<typeof vi.fn>;
    readonly loadLatestRuntimeCatalog?: ReturnType<typeof vi.fn>;
    readonly loadPromptQueueSnapshots?: ReturnType<typeof vi.fn>;
    readonly listSessionHistory?: ReturnType<typeof vi.fn>;
    readonly listSessionRuntimeMappingsForParent?: ReturnType<typeof vi.fn>;
    readonly loadSessionSnapshot?: ReturnType<typeof vi.fn>;
    readonly loadSessionTranscriptPage?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly onSessionEvent?: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly saveSessionSnapshot?: (
        snapshot: AiSessionSnapshot,
        draft?: string,
    ) => void;
    readonly saveRuntimeCatalogPatch?: ReturnType<typeof vi.fn>;
    readonly setSessionPinned?: ReturnType<typeof vi.fn>;
    readonly nativeAi?: NativeAiGateway | null;
}) {
    return new AiService({
        nativeAi: overrides.nativeAi ?? null,
        onRuntimeStatus: vi.fn(),
        onSessionEvent: overrides.onSessionEvent,
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: {
            deleteSession: overrides.deleteSession ?? vi.fn(),
            listSessionHistory: overrides.listSessionHistory ?? vi.fn(() => []),
            loadLatestRuntimeCatalog:
                overrides.loadLatestRuntimeCatalog ?? vi.fn(() => null),
            loadPromptQueueSnapshots:
                overrides.loadPromptQueueSnapshots ?? vi.fn(() => []),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot: overrides.loadSessionSnapshot ?? vi.fn(() => null),
            loadSessionTranscriptPage:
                overrides.loadSessionTranscriptPage ?? vi.fn(() => null),
            listSessionRuntimeMappingsForParent:
                overrides.listSessionRuntimeMappingsForParent ?? vi.fn(() => []),
            saveRuntimeSelectionPreferenceOption: vi.fn(),
            saveRuntimeModePreference: vi.fn(),
            saveRuntimeModelPreference: vi.fn(),
            saveRuntimeCatalogPatch:
                overrides.saveRuntimeCatalogPatch ?? vi.fn(),
            saveSessionSnapshot: overrides.saveSessionSnapshot ?? vi.fn(),
            setSessionPinned: overrides.setSessionPinned ?? vi.fn(),
        } as never,
        projectService: {
            getProjectRootPath: vi.fn(() => process.cwd()),
        } as never,
        secretStore: {
            loadSecret: vi.fn(() => null),
            saveSecret: vi.fn(),
        },
        settingsService: {
            loadClaudeRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                gatewayBaseUrl: null,
                hasGatewayAuthToken: false,
                hasGatewayCustomHeaders: false,
            })),
            loadCodexRuntimeSettings: vi.fn(() => ({
                authMethod: null,
                binaryPath: null,
                hasCodexApiKey: false,
                hasOpenAiApiKey: false,
            })),
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveKiloRuntimeSettings: vi.fn(),
        } as never,
    });
}

function createSaveSessionSnapshotMock() {
    return vi.fn<(snapshot: AiSessionSnapshot, draft?: string) => void>();
}

function readLastSavedSessionSnapshot(
    saveSessionSnapshot: ReturnType<typeof createSaveSessionSnapshotMock>,
): AiSessionSnapshot {
    const savedSnapshot = saveSessionSnapshot.mock.calls.at(-1)?.[0];
    if (!savedSnapshot) {
        throw new Error("Expected a saved session snapshot.");
    }

    return savedSnapshot;
}

function createNativeAiGateway(
    overrides: Partial<NativeAiGateway> = {},
): NativeAiGateway {
    return {
        cancelSession: vi.fn(),
        close: vi.fn(),
        closeOwnedByWindow: vi.fn(),
        closeSession: vi.fn(),
        deleteSession: vi.fn(),
        listSessionHistory: vi.fn(() => Promise.resolve([])),
        loadSessionSnapshot: vi.fn(() => Promise.resolve(null)),
        loadSessionTranscriptPage: vi.fn(() => Promise.resolve(null)),
        prepareSession: vi.fn(),
        reconcileTerminalOpenTranscriptTail: vi.fn(() => Promise.resolve([])),
        renameSession: vi.fn(),
        respondPermission: vi.fn(),
        respondUserInput: vi.fn(),
        sendPrompt: vi.fn(),
        setSessionConfigOption: vi.fn(),
        setSessionMode: vi.fn(),
        setSessionModel: vi.fn(),
        setSessionPinned: vi.fn(),
        shouldHandleHistory: vi.fn(() => true),
        shouldHandleRuntime: vi.fn(() => true),
        ...overrides,
    };
}
