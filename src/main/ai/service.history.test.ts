import { describe, expect, it, vi } from "vitest";

import type {
    AiHistorySessionSummary,
    AiSessionTranscriptPage,
} from "@shared/ipc";

import { AiService } from "./service";

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
});

function createService(overrides: {
    readonly deleteSession?: ReturnType<typeof vi.fn>;
    readonly listSessionHistory?: ReturnType<typeof vi.fn>;
    readonly loadSessionTranscriptPage?: ReturnType<typeof vi.fn>;
    readonly setSessionPinned?: ReturnType<typeof vi.fn>;
}) {
    return new AiService({
        onRuntimeStatus: vi.fn(),
        onSessionSnapshot: vi.fn(),
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
            saveSessionSnapshot: vi.fn(),
            setSessionPinned: overrides.setSessionPinned ?? vi.fn(),
        } as never,
        projectService: {
            getProjectRootPath: vi.fn(() => process.cwd()),
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
                authMethod: null,
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
