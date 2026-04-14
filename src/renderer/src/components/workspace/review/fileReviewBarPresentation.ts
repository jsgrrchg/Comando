import type { AiDiffHunk, AiTrackedFile } from "@shared/ipc";

export interface FileReviewBarHunkStats {
    readonly additions: number;
    readonly changedLines: number;
    readonly deletions: number;
}

export function getReviewKindLabel(kind: AiTrackedFile["kind"]): string {
    switch (kind) {
        case "create":
            return "New";
        case "delete":
            return "Deleted";
        case "move":
            return "Moved";
        case "update":
        default:
            return "Modified";
    }
}

export function computeReviewHunkStats(
    hunk: AiDiffHunk,
): FileReviewBarHunkStats {
    const additions = hunk.lines.filter((line) => line.type === "add").length;
    const deletions = hunk.lines.filter(
        (line) => line.type === "remove",
    ).length;

    return {
        additions,
        changedLines: additions + deletions,
        deletions,
    };
}

export function formatReviewHunkHeader(hunk: AiDiffHunk): string {
    return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

export function formatReviewHunkFocusSummary(hunk: AiDiffHunk): string {
    const stats = computeReviewHunkStats(hunk);
    const changedLabel =
        stats.changedLines === 1
            ? "1 changed line"
            : `${stats.changedLines} changed lines`;

    return `${changedLabel} in focus · ${formatReviewHunkHeader(hunk)}`;
}

export function getSelectedReviewLine(hunk: AiDiffHunk): number {
    return Math.max(hunk.newStart || hunk.oldStart || 1, 1);
}
