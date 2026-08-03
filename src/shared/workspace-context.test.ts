import { describe, expect, it } from "vitest";

import {
    areWorkspaceWorktreeIdsEquivalent,
    getWorkspaceContextKey,
    getWorkspaceScopeKey,
    normalizeWorkspaceWorktreeId,
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
        expect(getWorkspaceScopeKey("project-1", null)).toBe(
            "project-1::__primary__",
        );
    });

    it("keeps distinct worktrees and projects isolated", () => {
        expect(
            areWorkspaceWorktreeIdsEquivalent(
                "project-1",
                "worktree-a",
                "worktree-b",
            ),
        ).toBe(false);
        expect(
            areWorkspaceWorktreeIdsEquivalent(
                "project-1",
                "shared-id",
                "project-2:primary",
            ),
        ).toBe(false);
    });
});
