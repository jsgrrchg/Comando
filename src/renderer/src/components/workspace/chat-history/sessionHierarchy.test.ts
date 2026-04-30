import { describe, expect, it } from "vitest";

import type { AiHistorySessionSummary } from "@shared/ipc";

import { buildAiSessionHierarchyGroups } from "./sessionHierarchy";

function createSession(
    overrides: Partial<AiHistorySessionSummary> = {},
): AiHistorySessionSummary {
    return {
        createdAt: "2026-04-20T10:00:00.000Z",
        messageCount: 1,
        preview: "Assistant response.",
        projectId: "project-1",
        runtimeId: "codex",
        sessionId: "parent",
        title: "Parent thread",
        updatedAt: "2026-04-20T10:05:00.000Z",
        worktreeId: "worktree-1",
        ...overrides,
    };
}

describe("buildAiSessionHierarchyGroups", () => {
    it("nests children under their parent without changing input order", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({ sessionId: "parent", title: "Parent" }),
            createSession({
                parentSessionId: "parent",
                sessionId: "child-a",
                title: "Galileo",
            }),
            createSession({
                parentSessionId: "parent",
                sessionId: "child-b",
                title: "Ada",
            }),
            createSession({ sessionId: "other", title: "Other" }),
        ]);

        expect(groups).toHaveLength(2);
        expect(
            groups[0]?.rows.map((row) => ({
                depth: row.depth,
                isSubagent: row.isSubagent,
                sessionId: row.session.sessionId,
            })),
        ).toEqual([
            { depth: 0, isSubagent: false, sessionId: "parent" },
            { depth: 1, isSubagent: true, sessionId: "child-a" },
            { depth: 1, isSubagent: true, sessionId: "child-b" },
        ]);
        expect(groups[1]?.rootSession.sessionId).toBe("other");
    });

    it("keeps children visually under their parent even when the child is newer", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({
                parentSessionId: "parent",
                sessionId: "child",
                title: "Galileo",
                updatedAt: "2026-04-20T10:10:00.000Z",
            }),
            createSession({
                sessionId: "parent",
                title: "Parent",
                updatedAt: "2026-04-20T10:05:00.000Z",
            }),
            createSession({
                sessionId: "other",
                title: "Other",
                updatedAt: "2026-04-20T10:09:00.000Z",
            }),
        ]);

        expect(groups.map((group) => group.rootSession.sessionId)).toEqual([
            "parent",
            "other",
        ]);
        expect(
            groups[0]?.rows.map((row) => ({
                depth: row.depth,
                sessionId: row.session.sessionId,
            })),
        ).toEqual([
            { depth: 0, sessionId: "parent" },
            { depth: 1, sessionId: "child" },
        ]);
    });

    it("keeps the parent as context when a child matches the filter", () => {
        const groups = buildAiSessionHierarchyGroups(
            [
                createSession({ sessionId: "parent", title: "Build plan" }),
                createSession({
                    parentSessionId: "parent",
                    preview: "Specialized review agent output.",
                    sessionId: "child",
                    title: "Galileo",
                }),
                createSession({ sessionId: "other", title: "Other" }),
            ],
            { filterQuery: "galileo" },
        );

        expect(groups).toHaveLength(1);
        expect(groups[0]?.rows.map((row) => row.session.sessionId)).toEqual([
            "parent",
            "child",
        ]);
    });

    it("keeps children visible when the parent matches the filter", () => {
        const groups = buildAiSessionHierarchyGroups(
            [
                createSession({
                    preview: "Main planning thread.",
                    sessionId: "parent",
                    title: "Build plan",
                }),
                createSession({
                    parentSessionId: "parent",
                    preview: "Specialized review agent output.",
                    sessionId: "child",
                    title: "Galileo",
                }),
                createSession({ sessionId: "other", title: "Other" }),
            ],
            { filterQuery: "build" },
        );

        expect(groups).toHaveLength(1);
        expect(groups[0]?.rows.map((row) => row.session.sessionId)).toEqual([
            "parent",
            "child",
        ]);
    });

    it("renders orphaned children as roots while keeping subagent metadata", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({
                parentSessionId: "missing-parent",
                sessionId: "child",
                title: "Detached agent",
            }),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.rows[0]).toMatchObject({
            depth: 0,
            isSubagent: true,
            parentSession: null,
        });
    });
});
