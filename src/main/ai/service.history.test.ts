import { describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiSessionUpdate,
    AiTrackedFile,
} from "@shared/ipc";

import { createReviewActionLogFromTrackedFiles } from "@shared/ai-review-action-log";

import { AiService } from "./service";
import type { NativeAiGateway } from "./contracts";

describe("AiService history", () => {
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

    it("deletes a persisted session when no live runtime session exists", async () => {
        const deleteSession = vi.fn();
        const service = createService({
            deleteSession,
        });

        await service.deleteSession("session-1");

        expect(deleteSession).toHaveBeenCalledWith("session-1");
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
    readonly listSessionHistory?: ReturnType<typeof vi.fn>;
    readonly loadSessionSnapshot?: ReturnType<typeof vi.fn>;
    readonly loadSessionTranscriptPage?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
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
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: {
            deleteSession: overrides.deleteSession ?? vi.fn(),
            listSessionHistory: overrides.listSessionHistory ?? vi.fn(() => []),
            loadLatestRuntimeCatalog:
                overrides.loadLatestRuntimeCatalog ?? vi.fn(() => null),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot: overrides.loadSessionSnapshot ?? vi.fn(() => null),
            loadSessionTranscriptPage:
                overrides.loadSessionTranscriptPage ?? vi.fn(() => null),
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
