import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";

import {
    computeDiffStats,
    createDiffFromTrackedFile,
    getFileNameFromPath,
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

// Cached ReviewFileItem keyed by the tracked file reference. Each entry also
// remembers the openRelativePath used to build it so cache hits stay
// consistent with the current resolver.
const reviewFileItemCache = new WeakMap<
    AiTrackedFile,
    { openRelativePath: string | null; item: ReviewFileItem }
>();

function buildReviewFileItem(
    file: AiTrackedFile,
    openRelativePath: string | null,
): ReviewFileItem {
    const cached = reviewFileItemCache.get(file);
    if (cached && cached.openRelativePath === openRelativePath) {
        return cached.item;
    }

    const diff = createDiffFromTrackedFile(file);
    const item: ReviewFileItem = {
        file,
        diff,
        stats: computeFileStats(diff),
        tone: getFileTone(file),
        summary: getFileSummary(file),
        canOpen: openRelativePath !== null,
        openRelativePath,
        canReject: file.reversible !== false,
        canResolveHunks: canResolveFileHunks(file, diff),
    };
    reviewFileItemCache.set(file, { openRelativePath, item });
    return item;
}

export function deriveReviewItems(
    files: readonly AiTrackedFile[],
    canOpenByPath:
        | ReadonlySet<string>
        | ((file: AiTrackedFile) => string | null) = new Set<string>(),
): ReviewFileItem[] {
    return sortTrackedFiles(files).map((file) => {
        const openRelativePath =
            typeof canOpenByPath === "function"
                ? canOpenByPath(file)
                : canOpenByPath.has(file.path)
                  ? file.path
                  : null;

        return buildReviewFileItem(file, openRelativePath);
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
