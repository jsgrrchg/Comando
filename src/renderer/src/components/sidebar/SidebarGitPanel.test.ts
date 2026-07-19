import { describe, expect, it } from "vitest";

import { createSidebarGitSurfaceAction } from "./SidebarGitPanel";

describe("createSidebarGitSurfaceAction", () => {
    it("builds file, history, and review actions for the active context", () => {
        const context = {
            contextKey: "project-1::__primary__",
            projectId: "project-1",
            worktreeId: null,
        } as const;

        expect(
            createSidebarGitSurfaceAction({
                ...context,
                kind: "file",
                relativePath: "src/index.ts",
            }),
        ).toEqual({
            ...context,
            kind: "file",
            origin: "git",
            relativePath: "src/index.ts",
        });
        expect(
            createSidebarGitSurfaceAction({
                ...context,
                kind: "git-history",
            }),
        ).toEqual({ ...context, kind: "git-history" });
        expect(
            createSidebarGitSurfaceAction({
                ...context,
                kind: "git-worktree-diff",
            }),
        ).toEqual({ ...context, kind: "git-worktree-diff" });
    });
});
