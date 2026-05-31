import { describe, expect, it } from "vitest";

import type { AiHistorySessionSummary } from "@shared/ipc";

import {
    buildAiSessionHierarchyGroups,
    filterAiSessionHierarchyRowsForCollapsedParents,
} from "./sessionHierarchy";

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

    it("allows callers to stabilize sibling order independently from updatedAt order", () => {
        const workingOrder = new Map([
            ["child-a", 1],
            ["child-b", 2],
        ]);
        const groups = buildAiSessionHierarchyGroups(
            [
                createSession({ sessionId: "parent", title: "Parent" }),
                createSession({
                    parentSessionId: "parent",
                    sessionId: "child-b",
                    title: "Ada",
                    updatedAt: "2026-04-20T10:12:00.000Z",
                }),
                createSession({
                    parentSessionId: "parent",
                    sessionId: "child-a",
                    title: "Galileo",
                    updatedAt: "2026-04-20T10:10:00.000Z",
                }),
            ],
            {
                compareSiblings: (left, right) =>
                    (workingOrder.get(left.sessionId) ?? 0) -
                    (workingOrder.get(right.sessionId) ?? 0),
            },
        );

        expect(groups[0]?.rows.map((row) => row.session.sessionId)).toEqual([
            "parent",
            "child-a",
            "child-b",
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

    it("groups children when the parent link references the parent runtime session", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({
                runtimeSessionId: "runtime-parent",
                sessionId: "parent",
                title: "Parent",
            }),
            createSession({
                parentSessionId: "runtime-parent",
                runtimeSessionId: "runtime-child",
                sessionId: "child",
                title: "Galileo",
            }),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.rows.map((row) => row.session.sessionId)).toEqual([
            "parent",
            "child",
        ]);
        expect(groups[0]?.rows[1]?.parentSession?.sessionId).toBe("parent");
    });

    it("filters descendants of collapsed parents without hiding later siblings", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({ sessionId: "parent-a", title: "Parent A" }),
            createSession({
                parentSessionId: "parent-a",
                sessionId: "child-a",
                title: "Galileo",
            }),
            createSession({
                parentSessionId: "child-a",
                sessionId: "grandchild-a",
                title: "Ada",
            }),
            createSession({
                parentSessionId: "parent-a",
                sessionId: "child-b",
                title: "Wegener",
            }),
            createSession({ sessionId: "parent-b", title: "Parent B" }),
        ]);

        const visibleRows = filterAiSessionHierarchyRowsForCollapsedParents(
            groups.flatMap((group) => group.rows),
            new Set(["parent-a"]),
        );

        expect(visibleRows.map((row) => row.session.sessionId)).toEqual([
            "parent-a",
            "parent-b",
        ]);
    });

    it("filters nested descendants when only a child parent is collapsed", () => {
        const groups = buildAiSessionHierarchyGroups([
            createSession({ sessionId: "parent", title: "Parent" }),
            createSession({
                parentSessionId: "parent",
                sessionId: "child-a",
                title: "Galileo",
            }),
            createSession({
                parentSessionId: "child-a",
                sessionId: "grandchild-a",
                title: "Ada",
            }),
            createSession({
                parentSessionId: "parent",
                sessionId: "child-b",
                title: "Wegener",
            }),
        ]);

        const visibleRows = filterAiSessionHierarchyRowsForCollapsedParents(
            groups[0]?.rows ?? [],
            new Set(["child-a"]),
        );

        expect(visibleRows.map((row) => row.session.sessionId)).toEqual([
            "parent",
            "child-a",
            "child-b",
        ]);
    });
});
