import { describe, expect, it } from "vitest";

import { resolveProjectContextWorktreeId } from "./context-key";

describe("resolveProjectContextWorktreeId", () => {
    it("resolves the logical primary context to its canonical worktree id", () => {
        expect(
            resolveProjectContextWorktreeId(
                "project-1",
                null,
                "project-1:primary",
            ),
        ).toBe("project-1:primary");
        expect(
            resolveProjectContextWorktreeId("project-1", null, null),
        ).toBe("project-1:primary");
    });

    it("keeps an explicit macro worktree authoritative", () => {
        expect(
            resolveProjectContextWorktreeId(
                "project-1",
                "worktree-feature",
                "project-1:primary",
            ),
        ).toBe("worktree-feature");
    });
});
