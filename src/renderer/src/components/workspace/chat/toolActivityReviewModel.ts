import type { AiFileDiff, AiToolActivity, AiTrackedFile } from "@shared/ipc";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";
import { normalizePathKey } from "@shared/path-identity";
import { measureChatPerformance } from "@renderer/app/debug/chatPerformanceProbe";

import {
    areTrackedFilePathReferencesEquivalent,
    areTrackedFilePathsEquivalent,
    matchesTrackedFilePath,
} from "@renderer/app/ai/trackedFilePath";
import type {
    ReviewFileStats,
    ReviewFileTone,
} from "../review/editedFilesPresentationModel";
import {
    canResolveFileHunks,
    computeFileStats,
    getFileSummary,
    getFileTone,
    isReviewConflictFile,
} from "../review/editedFilesPresentationModel";
import {
    computeDiffStats,
    createDiffFromTrackedFile,
    getFileNameFromPath,
} from "../review/reviewDiff";
import { getStructuredToolTarget } from "./toolActivityDescriptor";

export interface ToolActivityReviewEntry {
    readonly activity: AiToolActivity;
    readonly hasPendingTrackedFiles: boolean;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly trackedFiles: readonly AiTrackedFile[];
}

export interface ToolActivityReviewIndex {
    readonly fallbackTrackedFilesBySessionPath: ReadonlyMap<
        string,
        readonly AiTrackedFile[]
    >;
    readonly revision: string;
    readonly trackedFilesBySessionId: ReadonlyMap<
        string,
        readonly AiTrackedFile[]
    >;
    readonly trackedFilesByToolCallId: ReadonlyMap<
        string,
        readonly AiTrackedFile[]
    >;
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

const reviewIndexByTrackedFiles = new WeakMap<
    readonly AiTrackedFile[],
    ToolActivityReviewIndex
>();
const reviewEntryCacheByIndex = new WeakMap<
    ToolActivityReviewIndex,
    WeakMap<AiToolActivity, ToolActivityReviewEntry>
>();

export function createToolActivityReviewIndex(
    trackedFiles: readonly AiTrackedFile[],
): ToolActivityReviewIndex {
    return measureChatPerformance(
        "review_index_ms",
        {
            sessionId: trackedFiles[0]?.sessionId,
            values: { trackedFileCount: trackedFiles.length },
        },
        () => createToolActivityReviewIndexUnmeasured(trackedFiles),
    );
}

function createToolActivityReviewIndexUnmeasured(
    trackedFiles: readonly AiTrackedFile[],
): ToolActivityReviewIndex {
    const cached = reviewIndexByTrackedFiles.get(trackedFiles);
    if (cached) {
        return cached;
    }

    const trackedFilesBySessionId = new Map<string, AiTrackedFile[]>();
    const trackedFilesByToolCallId = new Map<string, AiTrackedFile[]>();
    const fallbackTrackedFilesBySessionPath = new Map<
        string,
        AiTrackedFile[]
    >();

    for (const trackedFile of trackedFiles) {
        appendToReviewIndex(
            trackedFilesBySessionId,
            trackedFile.sessionId,
            trackedFile,
        );

        if (trackedFile.toolCallId !== null) {
            appendToReviewIndex(
                trackedFilesByToolCallId,
                getSessionToolCallKey(
                    trackedFile.sessionId,
                    trackedFile.toolCallId,
                ),
                trackedFile,
            );
            continue;
        }

        for (const path of getTrackedFilePathReferences(trackedFile)) {
            for (const pathKey of getPathLookupKeys(path)) {
                appendToReviewIndex(
                    fallbackTrackedFilesBySessionPath,
                    getSessionPathKey(trackedFile.sessionId, pathKey),
                    trackedFile,
                );
            }
        }
    }

    const index: ToolActivityReviewIndex = {
        fallbackTrackedFilesBySessionPath,
        revision: getTrackedFilesRevision(trackedFiles),
        trackedFilesBySessionId,
        trackedFilesByToolCallId,
    };
    reviewIndexByTrackedFiles.set(trackedFiles, index);
    return index;
}

export function deriveToolActivityReviewEntries(
    activities: readonly AiToolActivity[],
    trackedFiles: readonly AiTrackedFile[],
): ToolActivityReviewEntry[] {
    return deriveToolActivityReviewEntriesFromIndex(
        activities,
        createToolActivityReviewIndex(trackedFiles),
    );
}

export function deriveToolActivityReviewEntriesFromIndex(
    activities: readonly AiToolActivity[],
    index: ToolActivityReviewIndex,
    previousEntries: readonly ToolActivityReviewEntry[] = [],
): ToolActivityReviewEntry[] {
    const previousEntriesByActivityId = new Map(
        previousEntries.map((entry) => [
            getSessionToolCallKey(entry.activity.sessionId, entry.activity.id),
            entry,
        ]),
    );
    const entriesByActivity = getReviewEntryCache(index);

    return activities.map((activity) => {
        const entry = deriveToolActivityReviewEntry(activity, index);
        const previousEntry = previousEntriesByActivityId.get(
            getSessionToolCallKey(activity.sessionId, activity.id),
        );
        if (
            previousEntry?.activity === activity &&
            areTrackedFileReferencesEqual(
                previousEntry.trackedFiles,
                entry.trackedFiles,
            )
        ) {
            entriesByActivity.set(activity, previousEntry);
            return previousEntry;
        }

        return entry;
    });
}

export function deriveToolActivityReviewEntry(
    activity: AiToolActivity,
    index: ToolActivityReviewIndex,
): ToolActivityReviewEntry {
    const entriesByActivity = getReviewEntryCache(index);

    const cached = entriesByActivity.get(activity);
    if (cached) {
        return cached;
    }

    const trackedFiles = deriveTrackedFilesForToolActivityFromIndex(
        activity,
        index,
    );
    const pendingTrackedFiles = trackedFiles.filter(isAiTrackedFileUnresolved);
    const entry = {
        activity,
        hasPendingTrackedFiles: pendingTrackedFiles.length > 0,
        pendingTrackedFiles,
        trackedFiles,
    };
    entriesByActivity.set(activity, entry);
    return entry;
}

function getReviewEntryCache(
    index: ToolActivityReviewIndex,
): WeakMap<AiToolActivity, ToolActivityReviewEntry> {
    let entriesByActivity = reviewEntryCacheByIndex.get(index);
    if (!entriesByActivity) {
        entriesByActivity = new WeakMap();
        reviewEntryCacheByIndex.set(index, entriesByActivity);
    }
    return entriesByActivity;
}

export function deriveTrackedFilesForToolActivity(
    activity: AiToolActivity,
    trackedFiles: readonly AiTrackedFile[],
): AiTrackedFile[] {
    return deriveTrackedFilesForToolActivityFromIndex(
        activity,
        createToolActivityReviewIndex(trackedFiles),
    );
}

export function deriveTrackedFilesForToolActivityFromIndex(
    activity: AiToolActivity,
    index: ToolActivityReviewIndex,
): AiTrackedFile[] {
    const explicitMatches = index.trackedFilesByToolCallId.get(
        getSessionToolCallKey(activity.sessionId, activity.id),
    );

    if (explicitMatches && explicitMatches.length > 0) {
        return sortTrackedFiles(explicitMatches);
    }

    const candidatePaths = collectActivityPaths(activity);
    if (candidatePaths.size === 0) {
        return [];
    }

    const matchedByPath = new Map<string, AiTrackedFile>();
    for (const candidatePath of candidatePaths) {
        const pathMatches = getPathCandidates(
            index,
            activity.sessionId,
            candidatePath,
        ).filter((trackedFile) =>
            matchesTrackedFilePathReference(trackedFile, candidatePath),
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

    const structuredTarget = getStructuredToolTarget(activity);
    if (structuredTarget?.trim()) {
        candidatePaths.add(structuredTarget);
    }

    for (const location of activity.locations) {
        if (location.path.trim()) {
            candidatePaths.add(location.path);
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

function areTrackedFileReferencesEqual(
    previous: readonly AiTrackedFile[],
    next: readonly AiTrackedFile[],
): boolean {
    return (
        previous.length === next.length &&
        previous.every((trackedFile, index) => trackedFile === next[index])
    );
}

function appendToReviewIndex(
    index: Map<string, AiTrackedFile[]>,
    key: string,
    trackedFile: AiTrackedFile,
): void {
    const entries = index.get(key);
    if (entries) {
        entries.push(trackedFile);
        return;
    }

    index.set(key, [trackedFile]);
}

function getSessionToolCallKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u{1f}${toolCallId}`;
}

function getSessionPathKey(sessionId: string, pathKey: string): string {
    return `${sessionId}\u{1f}${pathKey}`;
}

function getTrackedFilePathReferences(
    trackedFile: AiTrackedFile,
): readonly string[] {
    return trackedFile.previousPath
        ? [trackedFile.path, trackedFile.previousPath]
        : [trackedFile.path];
}

function getPathLookupKeys(path: string): readonly string[] {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
        return [];
    }

    const normalizedPosixPath = normalizePathKey(normalizedPath, {
        platform: "posix",
    });
    const normalizedWindowsPath = normalizePathKey(normalizedPath, {
        platform: "win32",
    });
    const baseName = normalizedWindowsPath
        .split("/")
        .at(-1)
        ?.toLowerCase();

    return [
        `path:${normalizedPosixPath}`,
        `path:${normalizedWindowsPath}`,
        ...(baseName ? [`name:${baseName}`] : []),
    ];
}

function getPathCandidates(
    index: ToolActivityReviewIndex,
    sessionId: string,
    candidatePath: string,
): AiTrackedFile[] {
    const candidatesByIdentityKey = new Map<string, AiTrackedFile>();
    for (const pathKey of getPathLookupKeys(candidatePath)) {
        const candidates = index.fallbackTrackedFilesBySessionPath.get(
            getSessionPathKey(sessionId, pathKey),
        );
        for (const trackedFile of candidates ?? []) {
            candidatesByIdentityKey.set(trackedFile.identityKey, trackedFile);
        }
    }

    return [...candidatesByIdentityKey.values()];
}

function getTrackedFilesRevision(
    trackedFiles: readonly AiTrackedFile[],
): string {
    return trackedFiles
        .map((trackedFile) =>
            [
                trackedFile.identityKey,
                trackedFile.sessionId,
                trackedFile.toolCallId ?? "",
                trackedFile.path,
                trackedFile.previousPath ?? "",
                trackedFile.reviewState,
                trackedFile.updatedAt,
            ].join("\u{1e}"),
        )
        .join("\u{1f}");
}

function createChangeReviewItem(
    diff: AiFileDiff,
    file: AiTrackedFile | null,
    index: number,
): ChangeReviewItem {
    const isPendingReview =
        file != null && isAiTrackedFileUnresolved(file);
    const isConflict = file != null && isReviewConflictFile(file);

    return {
        canKeep: isPendingReview && !isConflict,
        canReject: isPendingReview && !isConflict && file?.reversible !== false,
        canResolveHunks:
            isPendingReview &&
            !isConflict &&
            file != null &&
            canResolveFileHunks(file, diff),
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
        areTrackedFilePathReferencesEquivalent(trackedFile.path, diff.path) &&
        areOptionalTrackedFilePathsEquivalent(
            trackedFile.previousPath,
            diff.previousPath,
        )
    ) {
        return 4;
    }

    if (areTrackedFilePathReferencesEquivalent(trackedFile.path, diff.path)) {
        return 3;
    }

    if (
        diff.previousPath &&
        areTrackedFilePathReferencesEquivalent(
            trackedFile.previousPath,
            diff.previousPath,
        )
    ) {
        return 2;
    }

    if (
        diff.previousPath &&
        areTrackedFilePathReferencesEquivalent(
            trackedFile.path,
            diff.previousPath,
        )
    ) {
        return 1;
    }

    return -1;
}

function matchesTrackedFilePathReference(
    trackedFile: AiTrackedFile,
    candidatePath: string,
): boolean {
    return (
        matchesTrackedFilePath(trackedFile, candidatePath) ||
        [trackedFile.path, trackedFile.previousPath].some((path) =>
            areTrackedFilePathReferencesEquivalent(path, candidatePath),
        )
    );
}

function areOptionalTrackedFilePathsEquivalent(
    leftPath: string | null | undefined,
    rightPath: string | null | undefined,
): boolean {
    if (!leftPath && !rightPath) {
        return true;
    }

    return areTrackedFilePathsEquivalent(leftPath, rightPath);
}
