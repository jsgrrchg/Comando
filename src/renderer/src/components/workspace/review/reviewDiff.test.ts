import { describe, expect, it } from "vitest";

import type { AiDiffHunk, AiFileDiff } from "@shared/ipc";

import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    clampDiffZoom,
    collectDiffHunks,
    computeDiffLines,
    computeDiffStats,
    computeExactDiffLines,
    computeFileDiffStats,
    computeUnifiedDiffLines,
    formatDiffStat,
    stepDiffZoom,
} from "./reviewDiff";

function createDiff(overrides: Partial<AiFileDiff> = {}): AiFileDiff {
    return {
        hunks: [],
        isText: true,
        kind: "update",
        newText: "alpha\nbeta\ncharlie",
        oldText: "alpha\nbravo\ncharlie",
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        ...overrides,
    };
}

function createHunk(overrides: Partial<AiDiffHunk> = {}): AiDiffHunk {
    return {
        id: "hunk-1",
        lines: [
            { id: "line-1", text: "alpha", type: "context" },
            { id: "line-2", text: "bravo", type: "remove" },
            { id: "line-3", text: "beta", type: "add" },
        ],
        newCount: 2,
        newStart: 1,
        oldCount: 2,
        oldStart: 1,
        ...overrides,
    };
}

function buildLineText(prefix: string, count: number): string {
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
        lines.push(`${prefix}-${index}`);
    }
    return lines.join("\n");
}

describe("reviewDiff", () => {
    it("derives exact line numbers from hunks without extending IPC", () => {
        const result = computeExactDiffLines([
            createHunk(),
            createHunk({
                id: "hunk-2",
                lines: [{ id: "line-4", text: "delta", type: "add" }],
                newCount: 1,
                newStart: 10,
                oldCount: 0,
                oldStart: 10,
            }),
        ]);

        expect(result.approximate).toBe(false);
        expect(result.lines).toEqual([
            expect.objectContaining({
                exact: true,
                newLineNumber: 1,
                oldLineNumber: 1,
                type: "context",
            }),
            expect.objectContaining({
                exact: true,
                newLineNumber: null,
                oldLineNumber: 2,
                type: "remove",
            }),
            expect.objectContaining({
                exact: true,
                newLineNumber: 2,
                oldLineNumber: null,
                type: "add",
            }),
            expect.objectContaining({
                exact: true,
                text: "···",
                type: "separator",
            }),
            expect.objectContaining({
                exact: true,
                newLineNumber: 10,
                oldLineNumber: null,
                type: "add",
            }),
        ]);
    });

    it("builds approximate decision hunks from raw text", () => {
        const hunks = collectDiffHunks(
            "one\ntwo\nthree",
            "one\nTWO\nthree\nfour",
        );

        expect(hunks).toHaveLength(2);
        expect(hunks[0]?.lines).toEqual([
            expect.objectContaining({ text: "two", type: "remove" }),
            expect.objectContaining({ text: "TWO", type: "add" }),
        ]);
        expect(hunks[1]?.lines).toEqual([
            expect.objectContaining({ text: "four", type: "add" }),
        ]);
    });

    it("computes exact diffs beyond the previous large-file preview threshold", () => {
        const oldText = buildLineText("old", 710);
        const newText = buildLineText("new", 710);
        const diff = createDiff({
            newText,
            oldText,
        });

        const lines = computeDiffLines(diff);
        const stats = computeFileDiffStats(diff);

        expect(
            lines.some((line) => line.text.includes("large file preview")),
        ).toBe(false);
        expect(lines.filter((line) => line.type === "add")).toHaveLength(710);
        expect(lines.filter((line) => line.type === "remove")).toHaveLength(
            710,
        );
        expect(stats.approximate).not.toBe(true);
        expect(stats).toEqual(
            expect.objectContaining({
                additions: 710,
                deletions: 710,
            }),
        );
    });

    it("parses unified diff blocks for markdown diff rendering", () => {
        const lines = computeUnifiedDiffLines(
            `@@ -1,2 +1,2 @@\n alpha\n-bravo\n+beta`,
        );

        expect(lines).toEqual([
            expect.objectContaining({
                exact: true,
                newLineNumber: 1,
                oldLineNumber: 1,
                type: "context",
            }),
            expect.objectContaining({
                exact: true,
                newLineNumber: null,
                oldLineNumber: 2,
                type: "remove",
            }),
            expect.objectContaining({
                exact: true,
                newLineNumber: 2,
                oldLineNumber: null,
                type: "add",
            }),
        ]);
    });

    it("aggregates stats and clamps diff zoom", () => {
        const stats = computeDiffStats([
            createDiff({
                kind: "create",
                newText: "one\ntwo",
                oldText: null,
            }),
            createDiff({
                kind: "delete",
                newText: null,
                oldText: "three",
            }),
        ]);

        expect(stats).toEqual({
            additions: 2,
            approximate: false,
            deletions: 1,
        });
        expect(formatDiffStat(9)).toBe("9");
        expect(formatDiffStat(9, true)).toBe("~9");
        expect(clampDiffZoom(0)).toBe(DIFF_ZOOM_MIN);
        expect(clampDiffZoom(2)).toBe(DIFF_ZOOM_MAX);
        expect(stepDiffZoom(0.72, 0.04)).toBe(0.76);
    });
});
