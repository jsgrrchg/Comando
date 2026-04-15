import type { editor as MonacoEditor } from "monaco-editor";

import type { AiDiffHunk } from "@shared/ipc";

import {
    computeReviewHunkStats,
    getReviewHunkVisualEndLine,
    getReviewHunkVisualStartLine,
} from "@renderer/components/workspace/review/fileReviewBarPresentation";

type InlineReviewDecorationTone = "add" | "delete" | "modify";

function resolveInlineReviewDecorationTone(
    hunk: AiDiffHunk,
): InlineReviewDecorationTone {
    const stats = computeReviewHunkStats(hunk);

    if (stats.additions > 0 && stats.deletions === 0) {
        return "add";
    }

    if (stats.deletions > 0 && stats.additions === 0) {
        return "delete";
    }

    return "modify";
}

export function buildInlineReviewDecorations(
    hunks: readonly AiDiffHunk[],
    maxLineNumber: number,
): MonacoEditor.IModelDeltaDecoration[] {
    const boundedMaxLineNumber = Math.max(1, maxLineNumber);

    return hunks.map((hunk) => {
        const tone = resolveInlineReviewDecorationTone(hunk);
        const startLineNumber = Math.min(
            Math.max(getReviewHunkVisualStartLine(hunk), 1),
            boundedMaxLineNumber,
        );
        const endLineNumber = Math.min(
            Math.max(getReviewHunkVisualEndLine(hunk), startLineNumber),
            boundedMaxLineNumber,
        );

        return {
            options: {
                isWholeLine: true,
                lineNumberClassName: [
                    "inline-review-line-number",
                    `inline-review-line-number--${tone}`,
                ].join(" "),
            },
            range: {
                endColumn: 1,
                endLineNumber,
                startColumn: 1,
                startLineNumber,
            },
        };
    });
}
