import { describe, expect, it } from "vitest";

import type { GitWorktreeDiffResult } from "@shared/ipc";

import { serializeWorktreeDiffToPatch } from "./worktree-diff-patch";

function buildResult(
    overrides: Partial<GitWorktreeDiffResult> = {},
): GitWorktreeDiffResult {
    return {
        projectId: "project-1",
        sections: [
            {
                scope: "unstaged",
                files: [
                    {
                        additions: 1,
                        deletions: 1,
                        diff: {
                            hunks: [
                                {
                                    id: "hunk-1",
                                    lines: [
                                        {
                                            id: "l1",
                                            text: "const before = true;",
                                            type: "remove",
                                        },
                                        {
                                            id: "l2",
                                            text: "const after = true;",
                                            type: "add",
                                        },
                                        {
                                            id: "l3",
                                            text: "export {};",
                                            type: "context",
                                        },
                                    ],
                                    newCount: 2,
                                    newStart: 8,
                                    oldCount: 2,
                                    oldStart: 8,
                                },
                            ],
                            isText: true,
                            kind: "update",
                            newText: "const after = true;\n",
                            oldText: "const before = true;\n",
                            path: "src/app.ts",
                            previousPath: null,
                            reversible: true,
                        },
                        error: null,
                        isBinary: false,
                        isConflicted: false,
                        kind: "modified",
                        path: "src/app.ts",
                        previousPath: null,
                        scope: "unstaged",
                    },
                ],
            },
        ],
        updatedAt: "2026-05-21T00:00:00.000Z",
        worktreeId: null,
        ...overrides,
    };
}

describe("serializeWorktreeDiffToPatch", () => {
    it("returns an empty string when there is no result", () => {
        expect(serializeWorktreeDiffToPatch(null)).toBe("");
    });

    it("builds an applyable unified patch from hunks", () => {
        const patch = serializeWorktreeDiffToPatch(buildResult());

        expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
        expect(patch).toContain("--- a/src/app.ts");
        expect(patch).toContain("+++ b/src/app.ts");
        expect(patch).toContain("@@ -8,2 +8,2 @@");
        expect(patch).toContain("-const before = true;");
        expect(patch).toContain("+const after = true;");
        expect(patch).toContain(" export {};");
        expect(patch.endsWith("\n")).toBe(true);
    });

    it("marks new and deleted files with /dev/null endpoints", () => {
        const created = buildResult({
            sections: [
                {
                    scope: "untracked",
                    files: [
                        {
                            additions: 1,
                            deletions: 0,
                            diff: {
                                hunks: [
                                    {
                                        id: "h",
                                        lines: [
                                            {
                                                id: "a",
                                                text: "new line",
                                                type: "add",
                                            },
                                        ],
                                        newCount: 1,
                                        newStart: 1,
                                        oldCount: 0,
                                        oldStart: 0,
                                    },
                                ],
                                isText: true,
                                kind: "create",
                                newText: "new line\n",
                                oldText: null,
                                path: "src/new.ts",
                                previousPath: null,
                                reversible: true,
                            },
                            error: null,
                            isBinary: false,
                            isConflicted: false,
                            kind: "added",
                            path: "src/new.ts",
                            previousPath: null,
                            scope: "untracked",
                        },
                    ],
                },
            ],
        });

        const patch = serializeWorktreeDiffToPatch(created);
        expect(patch).toContain("new file mode 100644");
        expect(patch).toContain("--- /dev/null");
        expect(patch).toContain("+++ b/src/new.ts");
    });

    it("emits a binary placeholder and dedupes repeated paths", () => {
        const result = buildResult({
            sections: [
                {
                    scope: "staged",
                    files: [
                        {
                            additions: null,
                            deletions: null,
                            diff: null,
                            error: null,
                            isBinary: true,
                            isConflicted: false,
                            kind: "modified",
                            path: "assets/logo.png",
                            previousPath: null,
                            scope: "staged",
                        },
                    ],
                },
                {
                    scope: "unstaged",
                    files: [
                        {
                            additions: null,
                            deletions: null,
                            diff: null,
                            error: null,
                            isBinary: true,
                            isConflicted: false,
                            kind: "modified",
                            path: "assets/logo.png",
                            previousPath: null,
                            scope: "unstaged",
                        },
                    ],
                },
            ],
        });

        const patch = serializeWorktreeDiffToPatch(result);
        expect(patch).toContain("Binary files a/assets/logo.png");
        expect(patch.match(/diff --git/g)?.length).toBe(1);
    });
});
