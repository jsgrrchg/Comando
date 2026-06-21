import { describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiSessionUpdate,
} from "@shared/ipc";

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
        const saveSessionSnapshot = vi.fn();
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

function createService(overrides: {
    readonly deleteSession?: ReturnType<typeof vi.fn>;
    readonly listSessionHistory?: ReturnType<typeof vi.fn>;
    readonly loadSessionTranscriptPage?: ReturnType<typeof vi.fn>;
    readonly onSessionSnapshot?: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly saveSessionSnapshot?: (
        snapshot: AiSessionSnapshot,
        draft?: string,
    ) => void;
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
            loadLatestRuntimeCatalog: vi.fn(() => null),
            loadRuntimeSelectionPreferences: vi.fn(() => ({
                configOptions: {},
                modeId: null,
                modelId: null,
            })),
            loadSessionSnapshot: vi.fn(() => null),
            loadSessionTranscriptPage:
                overrides.loadSessionTranscriptPage ?? vi.fn(() => null),
            saveRuntimeSelectionPreferenceOption: vi.fn(),
            saveRuntimeModePreference: vi.fn(),
            saveRuntimeModelPreference: vi.fn(),
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
