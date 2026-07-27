import { describe, expect, it } from "vitest";

import type { GitDiffFile } from "./types";
import {
    canRenderGitDiffWithPierre,
    getPierreGitDiffInput,
} from "./PierreGitDiffFile";

function createDiffFile(overrides: Partial<GitDiffFile> = {}): GitDiffFile {
    return {
        hunks: [
            {
                header: "@@ -1,1 +1,1 @@",
                id: "hunk-1",
                lines: [],
                newCount: 1,
                newStart: 1,
                oldCount: 1,
                oldStart: 1,
            },
        ],
        id: "src/example.ts",
        isText: true,
        kind: "update",
        newText: "const after = true;\n",
        oldText: "const before = true;\n",
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        statusLabel: "modified",
        ...overrides,
    };
}

describe("Pierre Git diff adapter", () => {
    it("uses full content for an update", () => {
        const file = createDiffFile();
        const input = getPierreGitDiffInput(file);

        expect(canRenderGitDiffWithPierre(file)).toBe(true);
        expect(input).toEqual({
            newFile: {
                cacheKey: "src/example.ts:new",
                contents: "const after = true;\n",
                name: "src/example.ts",
            },
            oldFile: {
                cacheKey: "src/example.ts:old",
                contents: "const before = true;\n",
                name: "src/example.ts",
            },
        });
    });

    it("accepts empty creates and deletes", () => {
        const created = createDiffFile({
            kind: "create",
            newText: "",
            oldText: null,
        });
        const deleted = createDiffFile({
            kind: "delete",
            newText: null,
            oldText: "",
        });

        expect(getPierreGitDiffInput(created)).toMatchObject({
            newFile: { contents: "", name: "src/example.ts" },
            oldFile: null,
        });
        expect(getPierreGitDiffInput(deleted)).toMatchObject({
            newFile: null,
            oldFile: { contents: "", name: "src/example.ts" },
        });
    });

    it("uses the previous path for the old side of a rename", () => {
        const input = getPierreGitDiffInput(
            createDiffFile({
                kind: "move",
                path: "src/new-name.ts",
                previousPath: "src/old-name.ts",
            }),
        );

        expect(input?.oldFile?.name).toBe("src/old-name.ts");
        expect(input?.newFile?.name).toBe("src/new-name.ts");
    });

    it.each([
        ["binary", createDiffFile({ isText: false })],
        ["partial patch", createDiffFile({ oldText: null })],
        [
            "unavailable content",
            createDiffFile({ newText: null, oldText: null }),
        ],
    ])("keeps the legacy renderer for %s files", (_label, file) => {
        expect(canRenderGitDiffWithPierre(file)).toBe(false);
        expect(getPierreGitDiffInput(file)).toBeNull();
    });
});
