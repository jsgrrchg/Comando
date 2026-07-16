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

    it("parses natural-language line references", () => {
        expect(
            parseProjectFileReference("manage_profiles_modal.rs (line 790)"),
        ).toEqual({
            endLine: 790,
            isAbsolute: false,
            path: "manage_profiles_modal.rs",
            startLine: 790,
        });
        expect(
            parseProjectFileReference(
                "src/profile_selector.rs (lines 177-184)",
            ),
        ).toEqual({
            endLine: 184,
            isAbsolute: false,
            path: "src/profile_selector.rs",
            startLine: 177,
        });
        expect(parseProjectFileReference("src/app.ts, line 12")).toEqual({
            endLine: 12,
            isAbsolute: false,
            path: "src/app.ts",
            startLine: 12,
        });
    });

    it("parses parenthesized relative file paths", () => {
        expect(parseProjectFileReference("src/components/Foo(test).tsx")).toEqual({
            endLine: null,
            isAbsolute: false,
            path: "src/components/Foo(test).tsx",
            startLine: null,
        });
    });

    it("unwraps angle-bracketed file targets", () => {
        expect(parseProjectFileReference("<src/components/Foo(test).tsx>")).toEqual({
            endLine: null,
            isAbsolute: false,
            path: "src/components/Foo(test).tsx",
            startLine: null,
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

    it("resolves UNC absolute paths without collapsing the server root", () => {
        expect(
            resolveProjectFileReference(
                "\\\\Server\\Share\\Comando\\src\\app.ts",
                {
                    projectRoots: ["\\\\server\\share\\comando"],
                },
            ),
        ).toEqual({
            endLine: null,
            isAbsolute: true,
            path: "//Server/Share/Comando/src/app.ts",
            relativePath: "src/app.ts",
            startLine: null,
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
