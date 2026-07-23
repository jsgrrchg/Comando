import { describe, expect, it } from "vitest";

import {
    areWorkspaceScopesEquivalent,
    getWorkspaceContextKey,
    normalizeWorkspaceWorktreeId,
    type WorkspaceLocation,
} from "./workspace-context";

describe("workspace context identity", () => {
    it("normalizes both primary worktree representations", () => {
        expect(normalizeWorkspaceWorktreeId("project-1", null)).toBeNull();
        expect(
            normalizeWorkspaceWorktreeId("project-1", "project-1:primary"),
        ).toBeNull();
        expect(getWorkspaceContextKey("project-1", null)).toBe(
            "project-1::__primary__",
        );
        expect(
            getWorkspaceContextKey("project-1", "project-1:primary"),
        ).toBe("project-1::__primary__");
    });

    it("keeps distinct worktrees and projects isolated", () => {
        expect(
            areWorkspaceScopesEquivalent(
                { projectId: "project-1", worktreeId: "worktree-a" },
                { projectId: "project-1", worktreeId: "worktree-b" },
            ),
        ).toBe(false);
        expect(
            areWorkspaceScopesEquivalent(
                { projectId: "project-1", worktreeId: "shared-id" },
                { projectId: "project-2", worktreeId: "shared-id" },
            ),
        ).toBe(false);
    });

    it("requires a host and context to locate a workspace globally", () => {
        const location: WorkspaceLocation = {
            contextKey: "project-1::__primary__",
            hostWindowId: "window-1",
            projectId: "project-1",
            worktreeId: null,
        };

        expect(location).toMatchObject({
            contextKey: "project-1::__primary__",
            hostWindowId: "window-1",
        });
    });
});
