import { beforeEach, describe, expect, it } from "vitest";

import type { AiHistorySessionSummary } from "@shared/ipc";

import {
    clearSidebarAgentsHistoryCache,
    getSidebarAgentsHistoryCacheKey,
    readSidebarAgentsHistoryCache,
    updateSidebarAgentsHistoryCache,
    writeSidebarAgentsHistoryCache,
} from "./sidebarAgentsHistoryCache";

function createSummary(
    overrides: Partial<AiHistorySessionSummary> = {},
): AiHistorySessionSummary {
    return {
        createdAt: "2026-04-19T09:00:00.000Z",
        messageCount: 1,
        preview: "Assistant returns a concise answer.",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "session-1",
        title: "Session One",
        updatedAt: "2026-04-19T10:00:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

describe("sidebarAgentsHistoryCache", () => {
    beforeEach(() => {
        clearSidebarAgentsHistoryCache();
    });

    it("stores and restores sessions scoped by project and worktree", () => {
        const sessions = [createSummary({ sessionId: "session-a" })];
        const written = writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
            sessions,
            100,
        );

        expect(written).toEqual({
            loadedAt: 100,
            scopeKey: getSidebarAgentsHistoryCacheKey(
                "project-1",
                "worktree-a",
            ),
            sessions,
        });
        expect(
            readSidebarAgentsHistoryCache("project-1", "worktree-a")?.sessions,
        ).toEqual(sessions);
    });

    it("keeps sessions isolated between scopes", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
            [createSummary({ sessionId: "session-a" })],
            100,
        );
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-b",
            [createSummary({ sessionId: "session-b", worktreeId: "worktree-b" })],
            200,
        );

        expect(
            readSidebarAgentsHistoryCache("project-1", "worktree-a")?.sessions.map(
                (session) => session.sessionId,
            ),
        ).toEqual(["session-a"]);
        expect(
            readSidebarAgentsHistoryCache("project-1", "worktree-b")?.sessions.map(
                (session) => session.sessionId,
            ),
        ).toEqual(["session-b"]);
        expect(readSidebarAgentsHistoryCache("project-2", "worktree-a")).toBeNull();
    });

    it("normalizes null scope ids to empty scope segments", () => {
        const nullScopeKey = getSidebarAgentsHistoryCacheKey(null, null);
        const emptyScopeKey = getSidebarAgentsHistoryCacheKey("", "");

        writeSidebarAgentsHistoryCache(
            null,
            null,
            [createSummary({ projectId: null, worktreeId: null })],
            100,
        );

        expect(nullScopeKey).toBe(emptyScopeKey);
        expect(readSidebarAgentsHistoryCache("", "")?.sessions).toHaveLength(1);
    });

    it("returns copied arrays so callers cannot mutate cached references", () => {
        const sessions = [createSummary({ sessionId: "session-a" })];

        writeSidebarAgentsHistoryCache("project-1", "worktree-a", sessions, 100);

        const firstRead = readSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
        );
        expect(firstRead?.sessions).not.toBe(sessions);

        (firstRead?.sessions as AiHistorySessionSummary[] | undefined)?.push(
            createSummary({ sessionId: "session-mutated" }),
        );

        expect(
            readSidebarAgentsHistoryCache("project-1", "worktree-a")?.sessions.map(
                (session) => session.sessionId,
            ),
        ).toEqual(["session-a"]);
    });

    it("updates cached arrays without mutating previous reads", () => {
        writeSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
            [createSummary({ sessionId: "session-a" })],
            100,
        );
        const previousRead = readSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
        );

        const updated = updateSidebarAgentsHistoryCache(
            "project-1",
            "worktree-a",
            (sessions) => [
                createSummary({ sessionId: "session-b" }),
                ...sessions,
            ],
            200,
        );

        expect(previousRead?.sessions.map((session) => session.sessionId)).toEqual([
            "session-a",
        ]);
        expect(updated?.loadedAt).toBe(200);
        expect(updated?.sessions.map((session) => session.sessionId)).toEqual([
            "session-b",
            "session-a",
        ]);
    });
});
