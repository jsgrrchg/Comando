import { describe, expect, it, vi } from "vitest";

import type {
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiTrackedFile,
    AiSessionUpdate,
} from "@shared/ipc";
import { forgetOpenFileBuffer, recordOpenFileBuffer } from "./openFileBuffers";

const readyStatus: AiRuntimeStatus = {
    authMethod: "chatgpt",
    authMethods: [],
    authReady: true,
    checkedAt: "2026-04-15T00:00:00.000Z",
    command: "mock-codex-acp",
    hasCustomBinaryPath: false,
    hasGatewayConfig: false,
    hasGatewayUrl: false,
    message: null,
    onboardingRequired: false,
    runtimeId: "codex",
    source: "bundled",
    state: "ready",
};

vi.mock("./resolver/runtime-resolver", () => ({
    resolveCodexRuntime: vi.fn(() => ({
        args: [],
        command: "mock-codex-acp",
        executable: "mock-codex-acp",
        status: readyStatus,
    })),
}));

vi.mock("./codex/setup", () => ({
    applyCodexAuthEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => ({
        ...baseEnv,
    })),
    getCodexAuthMethods: vi.fn(() => []),
    getCodexRuntimeStatus: vi.fn(() => readyStatus),
    isCodexAuthenticationError: vi.fn(() => false),
    loadCodexSecretBundle: vi.fn(() => ({
        codexApiKey: null,
        openaiApiKey: null,
    })),
    saveCodexSecrets: vi.fn(() => ({
        hasCodexApiKey: false,
        hasOpenAiApiKey: false,
    })),
}));

const { AiService } = await import("./service");

describe("AiService hybrid persistence", () => {
    it("returns the live cached snapshot before falling back to persistence", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Persisted",
            updatedAt: "2026-04-16T00:00:00.000Z",
        });
        const liveSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Live",
            updatedAt: "2026-04-16T01:00:00.000Z",
        });
        const loadSessionSnapshot = vi.fn(() => persistedSnapshot);
        const service = createService({
            loadSessionSnapshot,
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: liveSnapshot,
        });

        await expect(service.getSessionSnapshot("session-1")).resolves.toEqual(
            liveSnapshot,
        );
        expect(loadSessionSnapshot).not.toHaveBeenCalled();
    });

    it("persists and broadcasts patch updates while keeping the merged live cache", async () => {
        const baseSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Base title",
            updatedAt: "2026-04-16T00:00:00.000Z",
        });
        const saveSessionSnapshot = vi.fn();
        const onSessionSnapshot = vi.fn();
        const service = createService({
            loadSessionSnapshot: vi.fn(() => baseSnapshot),
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        service.handleWorkerSessionSnapshot("window-1", {
            kind: "snapshot",
            snapshot: baseSnapshot,
        });
        onSessionSnapshot.mockClear();
        saveSessionSnapshot.mockClear();

        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    lastError: null,
                    status: "streaming",
                    title: "Updated title",
                    updatedAt: "2026-04-16T02:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-1",
            },
        };

        service.handleWorkerSessionSnapshot("window-1", update);

        expect(saveSessionSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "session-1",
                status: "streaming",
                title: "Updated title",
                updatedAt: "2026-04-16T02:00:00.000Z",
            }),
        );
        expect(onSessionSnapshot).toHaveBeenCalledWith("window-1", update);
        await expect(service.getSessionSnapshot("session-1")).resolves.toEqual(
            expect.objectContaining({
                sessionId: "session-1",
                status: "streaming",
                title: "Updated title",
                updatedAt: "2026-04-16T02:00:00.000Z",
            }),
        );
    });

    it("replays open file buffers to the worker when it restarts", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            title: "Restartable",
        });
        const prepareSession = vi.fn(async () => persistedSnapshot);
        const notifyFileBuffer = vi.fn(async () => undefined);
        const absolutePath = "/tmp/comando-phase-4-buffer.txt";
        const service = createService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile: vi.fn(),
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer,
                prepareSession,
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
            },
            loadSessionSnapshot: vi.fn(() => persistedSnapshot),
        });

        recordOpenFileBuffer(absolutePath, "unsaved content");
        try {
            await service.prepareSession(
                {
                    projectId: null,
                    runtimeId: "codex",
                    sessionId: "session-1",
                    title: "Restartable",
                    worktreeId: null,
                },
                "window-1",
            );
            prepareSession.mockClear();

            await service.handleWorkerRestarted();

            expect(notifyFileBuffer).toHaveBeenCalledWith({
                absolutePath,
                content: "unsaved content",
            });
            expect(prepareSession).toHaveBeenCalledTimes(1);
        } finally {
            forgetOpenFileBuffer(absolutePath);
        }
    });

    it("delegates persisted review mutations to the worker and persists the returned snapshot", async () => {
        const persistedSnapshot = createSnapshot({
            sessionId: "session-1",
            trackedFiles: [
                {
                    hunks: [],
                    identityKey: "notes.md",
                    isText: true,
                    kind: "update",
                    newText: "after",
                    oldText: "before",
                    path: "notes.md",
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: "session-1",
                    toolCallId: "tool-1",
                    updatedAt: "2026-04-16T00:00:00.000Z",
                    version: 1,
                } satisfies AiTrackedFile,
            ],
        });
        const saveSessionSnapshot = vi.fn();
        const onSessionSnapshot = vi.fn();
        const keepTrackedFile = vi.fn(async () => ({
            ownerWindowId: "",
            snapshot: {
                ...persistedSnapshot,
                trackedFiles: [],
                updatedAt: "2026-04-16T03:00:00.000Z",
            },
        }));
        const service = createService({
            aiWorker: {
                cancelSession: vi.fn(),
                close: vi.fn(),
                closeOwnedByWindow: vi.fn(),
                closeSession: vi.fn(),
                keepAllTrackedFiles: vi.fn(),
                keepTrackedFile,
                keepTrackedFileHunks: vi.fn(),
                notifyFileBuffer: vi.fn(),
                prepareSession: vi.fn(),
                rejectAllTrackedFiles: vi.fn(),
                rejectTrackedFile: vi.fn(),
                rejectTrackedFileHunks: vi.fn(),
                refreshProjectScopes: vi.fn(),
                respondPermission: vi.fn(),
                respondUserInput: vi.fn(),
                sendPrompt: vi.fn(),
                setSessionConfigOption: vi.fn(),
                setSessionMode: vi.fn(),
                setSessionModel: vi.fn(),
            },
            loadSessionSnapshot: vi.fn(() => persistedSnapshot),
            onSessionSnapshot,
            saveSessionSnapshot,
        });

        await service.keepTrackedFile({
            path: "notes.md",
            sessionId: "session-1",
        });

        expect(keepTrackedFile).toHaveBeenCalledWith({
            context: expect.objectContaining({
                ownerWindowId: "",
                snapshot: persistedSnapshot,
            }),
            input: {
                path: "notes.md",
                sessionId: "session-1",
            },
        });
        expect(saveSessionSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                trackedFiles: [],
            }),
        );
        expect(onSessionSnapshot).toHaveBeenCalledWith(
            "",
            expect.objectContaining({
                kind: "patch",
            }),
        );
    });
});

function createService(overrides: {
    readonly aiWorker?: object;
    readonly loadSessionSnapshot?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly saveSessionSnapshot?: ReturnType<typeof vi.fn>;
} = {}) {
    return new AiService({
        aiWorker: overrides.aiWorker as never,
        onRuntimeStatus: vi.fn(),
        onSessionSnapshot: overrides.onSessionSnapshot ?? vi.fn(),
        persistence: {
            loadLatestRuntimeCatalog: vi.fn(() => null),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot:
                overrides.loadSessionSnapshot ?? vi.fn(() => null),
            saveRuntimeSelectionPreferenceOption: vi.fn(),
            saveRuntimeModePreference: vi.fn(),
            saveRuntimeModelPreference: vi.fn(),
            saveSessionSnapshot: overrides.saveSessionSnapshot ?? vi.fn(),
        } as never,
        projectService: {
            getProjectRootPath: vi.fn(() => process.cwd()),
            listProjectWorktrees: vi.fn(() => []),
        } as never,
        secretStore: {
            loadSecret: vi.fn(() => null),
            saveSecret: vi.fn(),
        } as never,
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
                authMethod: "chatgpt",
                binaryPath: null,
                hasCodexApiKey: false,
                hasOpenAiApiKey: false,
            })),
            loadGeminiRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                authMethod: null,
                binaryPath: null,
                googleCloudLocation: null,
                googleCloudProject: null,
                hasGeminiApiKey: false,
                hasGoogleApiKey: false,
            })),
            loadKiloRuntimeSettings: vi.fn(() => ({
                authInvalidatedAtMs: null,
                binaryPath: null,
            })),
            saveClaudeRuntimeSettings: vi.fn(),
            saveCodexRuntimeSettings: vi.fn(),
            saveGeminiRuntimeSettings: vi.fn(),
            saveKiloRuntimeSettings: vi.fn(),
        } as never,
    });
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> & { readonly sessionId: string },
): AiSessionSnapshot {
    const { sessionId, ...rest } = overrides;
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
        projectId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId,
        status: "idle",
        title: "Session",
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-16T00:00:00.000Z",
        worktreeId: null,
        ...rest,
    };
}
