import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";

import {
    computeDiffLines,
    computeDiffStats,
    createDiffFromTrackedFile,
    getFileNameFromPath,
    type DiffLine,
} from "./reviewDiff";

export interface ReviewFileTone {
    readonly accent: string;
    readonly badge: string | null;
}

export interface ReviewFileStats {
    readonly additions: number;
    readonly deletions: number;
    readonly approximate: boolean;
}

export interface ReviewFileItem {
    readonly file: AiTrackedFile;
    readonly diff: AiFileDiff;
    readonly lines: readonly DiffLine[];
    readonly stats: ReviewFileStats;
    readonly tone: ReviewFileTone;
    readonly summary: string;
    readonly canOpen: boolean;
    readonly openRelativePath: string | null;
    readonly canReject: boolean;
    readonly canResolveHunks: boolean;
}

export interface ReviewSummary {
    readonly fileCount: number;
    readonly additions: number;
    readonly deletions: number;
    readonly approximate: boolean;
    readonly partialCount: number;
}

function isPartialFile(file: AiTrackedFile): boolean {
    return file.reversible === false || file.isText === false;
}

export function getFileTone(file: AiTrackedFile): ReviewFileTone {
    if (isPartialFile(file)) {
        return { accent: "var(--diff-warn)", badge: "Partial" };
    }

    if (file.kind === "move") {
        return { accent: "var(--diff-move)", badge: null };
    }

    if (file.kind === "create") {
        return { accent: "var(--diff-add)", badge: null };
    }

    if (file.kind === "delete") {
        return { accent: "var(--diff-remove)", badge: null };
    }

    return { accent: "var(--diff-add)", badge: null };
}

export function getFileSummary(file: AiTrackedFile): string {
    if (file.kind === "move" && file.previousPath) {
        return `Moved from ${getFileNameFromPath(file.previousPath)}`;
    }

    if (file.kind === "create") {
        return "New file";
    }

    if (file.kind === "delete") {
        return "Deleted";
    }

    return "Modified";
}

export function canResolveFileHunks(
    file: AiTrackedFile,
    diff?: AiFileDiff,
): boolean {
    const candidateDiff = diff ?? createDiffFromTrackedFile(file);

    return (
        file.isText &&
        file.reversible !== false &&
        (file.kind === "move" || file.kind === "update") &&
        candidateDiff.isText !== false &&
        candidateDiff.hunks.length > 0
    );
}

export function computeFileStats(diff: AiFileDiff): ReviewFileStats {
    const stats = computeDiffStats([diff]);

    return {
        additions: stats.additions,
        deletions: stats.deletions,
        approximate: stats.approximate === true,
    };
}

function sortTrackedFiles(files: readonly AiTrackedFile[]): AiTrackedFile[] {
    return [...files].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

export function deriveReviewItems(
    files: readonly AiTrackedFile[],
    canOpenByPath:
        | ReadonlySet<string>
        | ((file: AiTrackedFile) => string | null) = new Set<string>(),
): ReviewFileItem[] {
    return sortTrackedFiles(files).map((file) => {
        const diff = createDiffFromTrackedFile(file);
        const openRelativePath =
            typeof canOpenByPath === "function"
                ? canOpenByPath(file)
                : canOpenByPath.has(file.path)
                  ? file.path
                  : null;

        return {
            file,
            diff,
            lines: computeDiffLines(diff),
            stats: computeFileStats(diff),
            tone: getFileTone(file),
            summary: getFileSummary(file),
            canOpen: openRelativePath !== null,
            openRelativePath,
            canReject: file.reversible !== false,
            canResolveHunks: canResolveFileHunks(file, diff),
        };
    });
}

export function deriveReviewSummary(
    items: readonly ReviewFileItem[],
): ReviewSummary {
    const diffs = items.map((item) => item.diff);
    const stats = computeDiffStats(diffs);

    return {
        fileCount: items.length,
        additions: stats.additions,
        deletions: stats.deletions,
        approximate: stats.approximate === true,
        partialCount: items.filter((item) => isPartialFile(item.file)).length,
    };
}
