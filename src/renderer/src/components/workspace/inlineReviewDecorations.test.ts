import { describe, expect, it } from "vitest";

import { buildInlineReviewDecorations } from "./inlineReviewDecorations";

describe("buildInlineReviewDecorations", () => {
    it("assigns add styling to addition-only hunks", () => {
        const decorations = buildInlineReviewDecorations(
            [
                {
                    id: "hunk-add",
                    lines: [
                        { id: "1", text: "added 1", type: "add" },
                        { id: "2", text: "added 2", type: "add" },
                    ],
                    newCount: 2,
                    newStart: 8,
                    oldCount: 0,
                    oldStart: 8,
                },
            ],
            20,
        );

        expect(decorations).toEqual([
            {
                options: {
                    isWholeLine: true,
                    lineNumberClassName:
                        "inline-review-line-number inline-review-line-number--add",
                },
                range: {
                    endColumn: 1,
                    endLineNumber: 9,
                    startColumn: 1,
                    startLineNumber: 8,
                },
            },
        ]);
    });

    it("assigns delete styling to deletion-only hunks", () => {
        const decorations = buildInlineReviewDecorations(
            [
                {
                    id: "hunk-delete",
                    lines: [{ id: "1", text: "removed", type: "remove" }],
                    newCount: 0,
                    newStart: 4,
                    oldCount: 1,
                    oldStart: 4,
                    visualEndLine: 4,
                    visualStartLine: 4,
                },
            ],
            20,
        );

        expect(decorations[0]?.options?.lineNumberClassName).toContain(
            "inline-review-line-number--delete",
        );
        expect(decorations[0]?.range).toEqual({
            endColumn: 1,
            endLineNumber: 4,
            startColumn: 1,
            startLineNumber: 4,
        });
    });

    it("assigns modify styling to mixed hunks and clamps the range", () => {
        const decorations = buildInlineReviewDecorations(
            [
                {
                    id: "hunk-modify",
                    lines: [
                        { id: "1", text: "removed", type: "remove" },
                        { id: "2", text: "added", type: "add" },
                    ],
                    newCount: 3,
                    newStart: 18,
                    oldCount: 2,
                    oldStart: 18,
                    visualEndLine: 25,
                    visualStartLine: 18,
                },
            ],
            20,
        );

        expect(decorations[0]?.options?.lineNumberClassName).toContain(
            "inline-review-line-number--modify",
        );
        expect(decorations[0]?.range).toEqual({
            endColumn: 1,
            endLineNumber: 20,
            startColumn: 1,
            startLineNumber: 18,
        });
    });
});
