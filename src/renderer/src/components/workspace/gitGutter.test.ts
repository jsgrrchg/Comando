import { describe, expect, it } from "vitest";

import type { GitDiffHunk, GitFileDiff } from "@shared/ipc";

import { computeGitGutterMarkers } from "./gitGutter";

function createDiff(
    hunks: readonly GitDiffHunk[],
    overrides: Partial<GitFileDiff> = {},
): GitFileDiff {
    return {
        hunks,
        isText: true,
        kind: "update",
        newText: null,
        oldText: null,
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        ...overrides,
    };
}

function createHunk(
    lines: GitDiffHunk["lines"],
    overrides: Partial<GitDiffHunk> = {},
): GitDiffHunk {
    return {
        id: "hunk-1",
        lines,
        newCount: 1,
        newStart: 1,
        oldCount: 1,
        oldStart: 1,
        ...overrides,
    };
}

describe("computeGitGutterMarkers", () => {
    it("marks pure additions as add", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "const added = true;",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 4, oldCount: 0, oldStart: 4 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 12)).toEqual([
            { lineNumber: 4, tone: "add" },
        ]);
    });

    it("marks replacements as modify", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                ],
                { newCount: 1, newStart: 8, oldCount: 1, oldStart: 8 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 20)).toEqual([
            { lineNumber: 8, tone: "modify" },
        ]);
    });

    it("marks extra added lines in a replacement block as add", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "before();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "after();",
                        type: "add",
                    },
                    {
                        id: "line-3",
                        text: "extra();",
                        type: "add",
                    },
                ],
                { newCount: 2, newStart: 10, oldCount: 1, oldStart: 10 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 30)).toEqual([
            { lineNumber: 10, tone: "modify" },
            { lineNumber: 11, tone: "add" },
        ]);
    });

    it("anchors deleted blocks to the next surviving line", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "removed();",
                        type: "remove",
                    },
                    {
                        id: "line-2",
                        text: "stable();",
                        type: "context",
                    },
                ],
                { newCount: 1, newStart: 6, oldCount: 2, oldStart: 6 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 18)).toEqual([
            { lineNumber: 6, tone: "delete-top" },
        ]);
    });

    it("anchors trailing deleted blocks to the final visible line", () => {
        const diff = createDiff([
            createHunk(
                [
                    {
                        id: "line-1",
                        text: "removed();",
                        type: "remove",
                    },
                ],
                { newCount: 0, newStart: 14, oldCount: 1, oldStart: 14 },
            ),
        ]);

        expect(computeGitGutterMarkers(diff, 13)).toEqual([
            { lineNumber: 13, tone: "delete-bottom" },
        ]);
    });
});
