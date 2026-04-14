import { describe, expect, it } from "vitest";

import type { AiDiffHunk } from "@shared/ipc";

import {
    computeReviewHunkStats,
    formatReviewHunkFocusSummary,
    formatReviewHunkHeader,
    getReviewHunkVisualEndLine,
    getReviewKindLabel,
    getSelectedReviewLine,
} from "./fileReviewBarPresentation";

function createHunk(overrides: Partial<AiDiffHunk> = {}): AiDiffHunk {
    return {
        id: "hunk-1",
        lines: [
            {
                id: "line-1",
                text: "const before = true;",
                type: "remove",
            },
            {
                id: "line-2",
                text: "const after = true;",
                type: "add",
            },
            {
                id: "line-3",
                text: "const stable = value;",
                type: "context",
            },
        ],
        newCount: 2,
        newStart: 8,
        oldCount: 2,
        oldStart: 8,
        ...overrides,
    };
}

describe("fileReviewBarPresentation", () => {
    it("returns semantic labels for tracked file kinds", () => {
        expect(getReviewKindLabel("create")).toBe("New");
        expect(getReviewKindLabel("delete")).toBe("Deleted");
        expect(getReviewKindLabel("move")).toBe("Moved");
        expect(getReviewKindLabel("update")).toBe("Modified");
    });

    it("computes hunk stats and focus summaries", () => {
        const hunk = createHunk();

        expect(computeReviewHunkStats(hunk)).toEqual({
            additions: 1,
            changedLines: 2,
            deletions: 1,
        });
        expect(formatReviewHunkHeader(hunk)).toBe("@@ -8,2 +8,2 @@");
        expect(formatReviewHunkFocusSummary(hunk)).toBe(
            "2 changed lines in focus · @@ -8,2 +8,2 @@",
        );
        expect(getSelectedReviewLine(hunk)).toBe(8);
    });

    it("falls back to the old line when the new range is empty", () => {
        const hunk = createHunk({
            newCount: 0,
            newStart: 12,
            oldCount: 3,
            oldStart: 24,
        });

        expect(getSelectedReviewLine(hunk)).toBe(12);
        expect(getReviewHunkVisualEndLine(hunk)).toBe(12);
    });

    it("prefers the explicit visual range when present", () => {
        const hunk = createHunk({
            newCount: 0,
            newStart: 14,
            oldCount: 2,
            oldStart: 8,
            visualEndLine: 9,
            visualStartLine: 9,
        });

        expect(getSelectedReviewLine(hunk)).toBe(9);
        expect(getReviewHunkVisualEndLine(hunk)).toBe(9);
    });
});
