import { describe, expect, it } from "vitest";

import {
    parseProjectFileReference,
    resolveProjectFileReference,
} from "./projectFileReferences";

describe("projectFileReferences", () => {
    it("parsea referencias relativas con rango de líneas", () => {
        expect(parseProjectFileReference("src/app.ts:12-18")).toEqual({
            endLine: 18,
            isAbsolute: false,
            path: "src/app.ts",
            startLine: 12,
        });
    });

    it("resuelve rutas absolutas dentro del root del proyecto", () => {
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

    it("resuelve file URLs usando roots de worktree", () => {
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

    it("mantiene rutas relativas listas para abrir en tabs", () => {
        expect(resolveProjectFileReference("./src/app.ts", { projectRoots: [] }))
            .toEqual({
                endLine: null,
                isAbsolute: false,
                path: "src/app.ts",
                relativePath: "src/app.ts",
                startLine: null,
            });
    });

    it("rechaza URLs externas y referencias fuera del proyecto", () => {
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
});
