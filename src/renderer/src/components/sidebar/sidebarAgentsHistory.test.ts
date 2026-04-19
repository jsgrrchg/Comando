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
    it("applies a patch locally for a known session without forcing reload", () => {
        const sessions = [
            createSummary({
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
});
