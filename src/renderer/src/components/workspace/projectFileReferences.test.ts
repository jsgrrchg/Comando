import { describe, expect, it } from "vitest";

import {
    collectProjectFileRoots,
    parseProjectFileReference,
    resolveProjectFileReference,
} from "./projectFileReferences";

describe("projectFileReferences", () => {
    it("parses relative references with line ranges", () => {
        expect(parseProjectFileReference("src/app.ts:12-18")).toEqual({
            endLine: 18,
            isAbsolute: false,
            path: "src/app.ts",
            startLine: 12,
        });
    });

    it("resolves absolute paths within project root", () => {
        expect(
            resolveProjectFileReference(
                "/Users/test/workspace/comando/src/app.ts:42",
                {
                    projectRoots: ["/Users/test/workspace/comando"],
                },
            ),
        ).toEqual({
            endLine: 42,
            isAbsolute: true,
            path: "/Users/test/workspace/comando/src/app.ts",
            relativePath: "src/app.ts",
            startLine: 42,
        });
    });

    it("resolves file URLs using worktree roots", () => {
        expect(
            resolveProjectFileReference(
                "file:///Users/test/worktrees/comando-feature/src/chat.tsx#L9-L14",
                {
                    projectRoots: [
                        "/Users/test/workspace/comando",
                        "/Users/test/worktrees/comando-feature",
                    ],
                },
            ),
        ).toEqual({
            endLine: 14,
            isAbsolute: true,
            path: "/Users/test/worktrees/comando-feature/src/chat.tsx",
            relativePath: "src/chat.tsx",
            startLine: 9,
        });
    });

    it("keeps relative paths ready to open in tabs", () => {
        expect(
            resolveProjectFileReference("./src/app.ts", { projectRoots: [] }),
        ).toEqual({
            endLine: null,
            isAbsolute: false,
            path: "src/app.ts",
            relativePath: "src/app.ts",
            startLine: null,
        });
    });

    it("rejects external URLs and references outside project", () => {
        expect(
            resolveProjectFileReference("https://example.com/docs", {
                projectRoots: ["/Users/test/workspace/comando"],
            }),
        ).toBeNull();
        expect(
            resolveProjectFileReference("/tmp/other-project/src/app.ts", {
                projectRoots: ["/Users/test/workspace/comando"],
            }),
        ).toBeNull();
    });

    it("collects unique project and worktree roots for path resolution", () => {
        expect(
            collectProjectFileRoots({
                canonicalProjectRoot: "/Users/test/workspace/comando",
                currentWorktreeRoot: "/Users/test/worktrees/comando-feature",
                projectRoot: "/Users/test/workspace/comando",
                repositoryCanonicalRoot: "/Users/test/workspace/comando",
                repositoryRoot: "/Users/test/workspace/comando/.git/..",
            }),
        ).toEqual([
            "/Users/test/workspace/comando",
            "/Users/test/workspace/comando/.git/..",
            "/Users/test/worktrees/comando-feature",
        ]);
    });
});
