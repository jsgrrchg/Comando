import type { AiFileDiff, AiToolActivity, AiTrackedFile } from "@shared/ipc";

import type {
    ReviewFileStats,
    ReviewFileTone,
} from "../review/editedFilesPresentationModel";
import {
    canResolveFileHunks,
    computeFileStats,
    getFileSummary,
    getFileTone,
} from "../review/editedFilesPresentationModel";
import {
    computeDiffStats,
    createDiffFromTrackedFile,
    getFileNameFromPath,
} from "../review/reviewDiff";

export interface ToolActivityReviewEntry {
    readonly activity: AiToolActivity;
    readonly hasPendingTrackedFiles: boolean;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly trackedFiles: readonly AiTrackedFile[];
}

export interface ChangeReviewItem {
    readonly canKeep: boolean;
    readonly canReject: boolean;
    readonly canResolveHunks: boolean;
    readonly diff: AiFileDiff;
    readonly file: AiTrackedFile | null;
    readonly key: string;
    readonly path: string;
    readonly stats: ReviewFileStats;
    readonly summary: string;
    readonly tone: ReviewFileTone;
}

export interface ChangeReviewSummary {
    readonly additions: number;
    readonly approximate: boolean;
    readonly deletions: number;
    readonly fileCount: number;
    readonly partialCount: number;
}

export function deriveToolActivityReviewEntries(
    activities: readonly AiToolActivity[],
    trackedFiles: readonly AiTrackedFile[],
): ToolActivityReviewEntry[] {
    return activities.map((activity) => {
        const activityTrackedFiles = deriveTrackedFilesForToolActivity(
            activity,
            trackedFiles,
        );
        const pendingTrackedFiles = activityTrackedFiles.filter(
            (trackedFile) => trackedFile.reviewState === "pending",
        );

        return {
            activity,
            hasPendingTrackedFiles: pendingTrackedFiles.length > 0,
            pendingTrackedFiles,
            trackedFiles: activityTrackedFiles,
        };
    });
}

export function deriveTrackedFilesForToolActivity(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): AiTrackedFile[] {
    const explicitMatches = trackedFiles.filter(
        (trackedFile) => trackedFile.toolCallId === activity.id,
    );

    if (explicitMatches.length > 0) {
        return sortTrackedFiles(explicitMatches);
    }

    const candidatePaths = collectActivityPaths(activity);
    if (candidatePaths.size === 0) {
        return [];
    }

    const matchedByPath = new Map<string, AiTrackedFile>();
    for (const candidatePath of candidatePaths) {
        const pathMatches = trackedFiles.filter(
            (trackedFile) =>
                trackedFile.path === candidatePath ||
                trackedFile.previousPath === candidatePath,
        );

        if (pathMatches.length === 1) {
            const [matchedTrackedFile] = pathMatches;
            if (matchedTrackedFile) {
                matchedByPath.set(
                    matchedTrackedFile.identityKey,
                    matchedTrackedFile,
                );
            }
        }
    }

    return sortTrackedFiles([...matchedByPath.values()]);
}

export function deriveChangeReviewItems(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): ChangeReviewItem[] {
    const unmatchedTrackedFiles = new Map(
        trackedFiles.map((trackedFile) => [
            trackedFile.identityKey,
            trackedFile,
        ]),
    );
    const items = activity.diffs.map((diff, index) => {
        const file = matchTrackedFileToDiff(diff, [
            ...unmatchedTrackedFiles.values(),
        ]);

        if (file) {
            unmatchedTrackedFiles.delete(file.identityKey);
        }

        return createChangeReviewItem(
            file ? createDiffFromTrackedFile(file) : diff,
            file,
            index,
        );
    });

    const fallbackItems = sortTrackedFiles([
        ...unmatchedTrackedFiles.values(),
    ]).map((file, index) =>
        createChangeReviewItem(
            createDiffFromTrackedFile(file),
            file,
            activity.diffs.length + index,
        ),
    );

    return [...items, ...fallbackItems];
}

export function deriveChangeReviewSummary(
    items: readonly ChangeReviewItem[],
): ChangeReviewSummary {
    const stats = computeDiffStats(items.map((item) => item.diff));

    return {
        additions: stats.additions,
        approximate: stats.approximate === true,
        deletions: stats.deletions,
        fileCount: items.length,
        partialCount: items.filter((item) => isPartialDiff(item.diff)).length,
    };
}

function collectActivityPaths(activity: AiToolActivity): Set<string> {
    const candidatePaths = new Set<string>();

    for (const location of activity.locations) {
        if (location.trim()) {
            candidatePaths.add(location);
        }
    }

    for (const diff of activity.diffs) {
        if (diff.path.trim()) {
            candidatePaths.add(diff.path);
        }
        if (diff.previousPath?.trim()) {
            candidatePaths.add(diff.previousPath);
        }
    }

    return candidatePaths;
}

function sortTrackedFiles(
    trackedFiles: readonly AiTrackedFile[],
): AiTrackedFile[] {
    return [...trackedFiles].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

function createChangeReviewItem(
    diff: AiFileDiff,
    file: AiTrackedFile | null,
    index: number,
): ChangeReviewItem {
    const isPendingReview = file?.reviewState === "pending";

    return {
        canKeep: isPendingReview,
        canReject: isPendingReview && file?.reversible !== false,
        canResolveHunks:
            isPendingReview && file != null && canResolveFileHunks(file, diff),
        diff,
        file,
        key:
            file?.identityKey ??
            `preview:${diff.kind}:${diff.previousPath ?? ""}:${diff.path}:${index}`,
        path: diff.path,
        stats: computeFileStats(diff),
        summary: file ? getFileSummary(file) : getDiffSummary(diff),
        tone: file ? getFileTone(file) : getDiffTone(diff),
    };
}

function getDiffSummary(diff: AiFileDiff): string {
    if (diff.kind === "move" && diff.previousPath) {
        return `Moved from ${getFileNameFromPath(diff.previousPath)}`;
    }

    if (diff.kind === "create") {
        return "New file";
    }

    if (diff.kind === "delete") {
        return "Deleted";
    }

    return "Modified";
}

function getDiffTone(diff: AiFileDiff): ReviewFileTone {
    if (isPartialDiff(diff)) {
        return { accent: "var(--diff-warn)", badge: "Partial" };
    }

    if (diff.kind === "move") {
        return { accent: "var(--diff-move)", badge: null };
    }

    if (diff.kind === "create") {
        return { accent: "var(--diff-add)", badge: null };
    }

    if (diff.kind === "delete") {
        return { accent: "var(--diff-remove)", badge: null };
    }

    return { accent: "var(--diff-add)", badge: null };
}

function isPartialDiff(diff: AiFileDiff): boolean {
    return diff.reversible === false || diff.isText === false;
}

function matchTrackedFileToDiff(
    diff: AiFileDiff,
    trackedFiles: readonly AiTrackedFile[],
): AiTrackedFile | null {
    let bestCandidate: AiTrackedFile | null = null;
    let bestScore = -1;
    let hasTie = false;

    for (const trackedFile of trackedFiles) {
        const score = scoreTrackedFileMatch(diff, trackedFile);
        if (score < 0) {
            continue;
        }

        if (score > bestScore) {
            bestCandidate = trackedFile;
            bestScore = score;
            hasTie = false;
            continue;
        }

        if (score === bestScore) {
            hasTie = true;
        }
    }

    if (hasTie) {
        return null;
    }

    return bestCandidate;
}

function scoreTrackedFileMatch(
    diff: AiFileDiff,
    trackedFile: AiTrackedFile,
): number {
    if (
        trackedFile.path === diff.path &&
        (trackedFile.previousPath ?? null) === (diff.previousPath ?? null)
    ) {
        return 4;
    }

    if (trackedFile.path === diff.path) {
        return 3;
    }

    if (diff.previousPath && trackedFile.previousPath === diff.previousPath) {
        return 2;
    }

    if (diff.previousPath && trackedFile.path === diff.previousPath) {
        return 1;
    }

    return -1;
}
