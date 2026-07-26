import { describe, expect, it } from "vitest";

import { joinProjectPath, resolveProjectFileFullPath } from "./projectPath";

describe("project paths", () => {
    it("joins POSIX project paths", () => {
        expect(joinProjectPath("/projects/comando/", "src/App.tsx")).toBe(
            "/projects/comando/src/App.tsx",
        );
    });

    it("joins Windows project paths with native separators", () => {
        expect(joinProjectPath("C:\\projects\\comando\\", "src/App.tsx")).toBe(
            "C:\\projects\\comando\\src\\App.tsx",
        );
    });

    it("prefers the loaded document path over the project root", () => {
        expect(
            resolveProjectFileFullPath({
                absolutePath: "/worktrees/feature/src/App.tsx",
                relativePath: "src/App.tsx",
                rootPath: "/projects/comando",
            }),
        ).toBe("/worktrees/feature/src/App.tsx");
    });

    it("resolves unloaded tabs from their project or worktree root", () => {
        expect(
            resolveProjectFileFullPath({
                absolutePath: null,
                relativePath: "src/App.tsx",
                rootPath: "/worktrees/feature",
            }),
        ).toBe("/worktrees/feature/src/App.tsx");
    });

    it("returns null when an unloaded tab has no resolvable root", () => {
        expect(
            resolveProjectFileFullPath({
                absolutePath: null,
                relativePath: "src/App.tsx",
                rootPath: null,
            }),
        ).toBeNull();
    });
});
