import { describe, expect, it } from "vitest";

import type {
    AiHistorySessionSummary,
    AiMessage,
    AiSessionSnapshot,
    AiSessionUpdate,
} from "@shared/ipc";

import {
    applySessionUpdateToSidebarHistory,
    SIDEBAR_AGENTS_HISTORY_LIMIT,
} from "./sidebarAgentsHistory";

const DEFAULT_SCOPE = {
    projectId: "project-1",
    worktreeId: "worktree-1",
} as const;

function createMessage(
    overrides: Partial<AiMessage> = {},
): AiMessage {
    return {
        attachments: [],
        content: "Assistant returns a concise answer.",
        createdAt: "2026-04-19T10:00:00.000Z",
        id: "message-1",
        kind: "assistant",
        status: "completed",
        ...overrides,
    };
}

function createSummary(
    overrides: Partial<AiHistorySessionSummary> = {},
): AiHistorySessionSummary {
    return {
        createdAt: "2026-04-19T09:00:00.000Z",
        messageCount: 1,
        preview: "Assistant returns a concise answer.",
        projectId: DEFAULT_SCOPE.projectId,
        runtimeId: "codex",
        sessionId: "session-1",
        title: "Session One",
        updatedAt: "2026-04-19T10:00:00.000Z",
        worktreeId: DEFAULT_SCOPE.worktreeId,
        ...overrides,
    };
}

function createSnapshot(
    overrides: Partial<AiSessionSnapshot> = {},
): AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [createMessage()],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: DEFAULT_SCOPE.projectId,
        runtimeId: "codex",
        runtimeSessionId: null,
        sessionId: "session-1",
        status: "idle",
        title: "Session One",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-19T10:00:00.000Z",
        worktreeId: DEFAULT_SCOPE.worktreeId,
        ...overrides,
    };
}

describe("applySessionUpdateToSidebarHistory", () => {
    it("includes primary sessions stored with null in a canonical primary scope", () => {
        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: {
                projectId: "project-1",
                worktreeId: "project-1:primary",
            },
            sessions: [],
            update: {
                kind: "snapshot",
                snapshot: createSnapshot({ worktreeId: null }),
            },
        });

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.worktreeId).toBeNull();
    });

    it("applies a patch locally for a known session without forcing reload", () => {
        const sessions = [
            createSummary({
                pinnedAt: "2026-04-19T09:30:00.000Z",
                sessionId: "session-1",
                title: "Old Title",
                updatedAt: "2026-04-19T10:00:00.000Z",
            }),
            createSummary({
                sessionId: "session-2",
                title: "Second Session",
                updatedAt: "2026-04-19T09:00:00.000Z",
            }),
        ] as const;
        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    messages: [
                        createMessage({
                            content: "Updated preview from latest assistant turn.",
                            id: "message-2",
                        }),
                    ],
                    title: "New Title",
                    updatedAt: "2026-04-19T11:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-1",
            },
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions).toHaveLength(2);
        expect(result.sessions[0]).toMatchObject({
            messageCount: 1,
            pinnedAt: "2026-04-19T09:30:00.000Z",
            preview: "Updated preview from latest assistant turn.",
            sessionId: "session-1",
            title: "New Title",
            updatedAt: "2026-04-19T11:00:00.000Z",
        });
    });

    it("inserts a new in-scope snapshot without forcing reload", () => {
        const sessions = [
            createSummary({
                sessionId: "session-2",
                title: "Second Session",
                updatedAt: "2026-04-19T09:00:00.000Z",
            }),
        ] as const;
        const update: AiSessionUpdate = {
            kind: "snapshot",
            snapshot: createSnapshot({
                messages: [
                    createMessage({
                        content: "Fresh snapshot preview.",
                        id: "message-3",
                    }),
                ],
                sessionId: "session-3",
                title: "Newest Session",
                updatedAt: "2026-04-19T12:00:00.000Z",
            }),
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions.map((session) => session.sessionId)).toEqual([
            "session-3",
            "session-2",
        ]);
        expect(result.sessions[0]).toMatchObject({
            createdAt: "2026-04-19T12:00:00.000Z",
            preview: "Fresh snapshot preview.",
            sessionId: "session-3",
        });
    });

    it("does not resurrect a locally deleted session from a late snapshot", () => {
        const update: AiSessionUpdate = {
            kind: "snapshot",
            snapshot: createSnapshot({
                sessionId: "deleted-session",
                title: "Deleted Session",
                updatedAt: "2026-04-19T12:00:00.000Z",
            }),
        };

        const result = applySessionUpdateToSidebarHistory({
            deletedSessionIds: new Set(["deleted-session"]),
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions: [],
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions).toEqual([]);
    });

    it("preserves pinned metadata when a snapshot refreshes a known session", () => {
        const sessions = [
            createSummary({
                pinnedAt: "2026-04-19T09:45:00.000Z",
                sessionId: "session-1",
            }),
        ] as const;
        const update: AiSessionUpdate = {
            kind: "snapshot",
            snapshot: createSnapshot({
                messages: [
                    createMessage({
                        content: "Snapshot update should not clear the pin.",
                        id: "message-4",
                    }),
                ],
                sessionId: "session-1",
                updatedAt: "2026-04-19T12:30:00.000Z",
            }),
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions[0]).toMatchObject({
            pinnedAt: "2026-04-19T09:45:00.000Z",
            preview: "Snapshot update should not clear the pin.",
            sessionId: "session-1",
            updatedAt: "2026-04-19T12:30:00.000Z",
        });
    });

    it("removes a known session when a patch moves it outside the active scope", () => {
        const sessions = [createSummary()] as const;
        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    projectId: "project-2",
                },
                runtimeId: "codex",
                sessionId: "session-1",
            },
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions).toEqual([]);
    });

    it("inserts an unknown session immediately when the first patch has message data and seed metadata", () => {
        const sessions = [createSummary()] as const;
        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    messages: [
                        createMessage({
                            content: "The very first user turn should surface immediately.",
                            id: "message-seeded-1",
                            kind: "user",
                        }),
                    ],
                    updatedAt: "2026-04-19T12:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-seeded",
            },
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            unknownSessionSeed: {
                projectId: DEFAULT_SCOPE.projectId,
                title: "Seeded Session",
                updatedAt: "2026-04-19T11:59:00.000Z",
                worktreeId: DEFAULT_SCOPE.worktreeId,
            },
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions.map((session) => session.sessionId)).toEqual([
            "session-seeded",
            "session-1",
        ]);
        expect(result.sessions[0]).toMatchObject({
            messageCount: 1,
            preview: "The very first user turn should surface immediately.",
            projectId: DEFAULT_SCOPE.projectId,
            sessionId: "session-seeded",
            title: "Seeded Session",
            updatedAt: "2026-04-19T12:00:00.000Z",
            worktreeId: DEFAULT_SCOPE.worktreeId,
        });
    });

    it("keeps the list untouched and asks for reload when a patch arrives for an unknown session", () => {
        const sessions = [createSummary()] as const;
        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    title: "Unknown Session",
                    updatedAt: "2026-04-19T12:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "session-unknown",
            },
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(true);
        expect(result.sessions).toBe(sessions);
    });

    it("keeps empty child snapshots visible in the sidebar history", () => {
        const sessions = [createSummary({ sessionId: "parent" })] as const;
        const update: AiSessionUpdate = {
            kind: "snapshot",
            snapshot: createSnapshot({
                messages: [],
                parentSessionId: "parent",
                sessionId: "child",
                title: "Galileo",
                updatedAt: "2026-04-19T12:00:00.000Z",
            }),
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions,
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions[0]).toMatchObject({
            messageCount: 0,
            parentSessionId: "parent",
            sessionId: "child",
            title: "Galileo",
        });
    });

    it("inserts an unknown empty child patch when seed metadata has a parent", () => {
        const update: AiSessionUpdate = {
            kind: "patch",
            patch: {
                changes: {
                    parentSessionId: "parent",
                    title: "Ada",
                    updatedAt: "2026-04-19T12:00:00.000Z",
                },
                runtimeId: "codex",
                sessionId: "child",
            },
        };

        const result = applySessionUpdateToSidebarHistory({
            limit: SIDEBAR_AGENTS_HISTORY_LIMIT,
            scope: DEFAULT_SCOPE,
            sessions: [],
            unknownSessionSeed: {
                parentSessionId: "parent",
                projectId: DEFAULT_SCOPE.projectId,
                title: "Ada",
                updatedAt: "2026-04-19T11:59:00.000Z",
                worktreeId: DEFAULT_SCOPE.worktreeId,
            },
            update,
        });

        expect(result.needsReload).toBe(false);
        expect(result.sessions).toEqual([
            expect.objectContaining({
                messageCount: 0,
                parentSessionId: "parent",
                preview: null,
                sessionId: "child",
            }),
        ]);
    });
});
