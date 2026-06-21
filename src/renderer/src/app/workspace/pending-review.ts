import type { AiTrackedFile } from "@shared/ipc";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";

import {
    areTrackedFilePathsEquivalent,
    matchesTrackedFilePath as matchesTrackedFilePathAlias,
} from "@renderer/app/ai/trackedFilePath";
import type { RuntimeWorkspaceFileReviewContext } from "./tree";

type SessionWithTrackedFiles = {
    readonly snapshot?: {
        readonly trackedFiles?: readonly AiTrackedFile[];
    } | null;
};

// Cache keyed by the sessions record itself. Zustand swaps this record on
// every mutation, so referential equality acts as a freshness signal; the
// cache short-circuits the flatMap/filter pipeline when the same sessions
// object is queried repeatedly (common under multiple FileTabView selectors
// firing on each patch). We deliberately skip re-syncing the tracked files
// here: the main process always runs them through syncTrackedFile before
// emitting over IPC, and local optimistic mutations also produce synced
// outputs (see resolveTrackedFileHunksInSnapshot). Re-syncing would force a
// redundant O(n*m) LCS recompute for every freshly arrived file — the exact
// work that caused the UI to lag when a new agent change landed.
const collectPendingCache = new WeakMap<object, readonly AiTrackedFile[]>();

export function collectPendingTrackedFilesFromSessions(
    sessions: Readonly<Record<string, SessionWithTrackedFiles | undefined>>,
): readonly AiTrackedFile[] {
    const cached = collectPendingCache.get(sessions);
    if (cached) {
        return cached;
    }

    const collected = Object.values(sessions)
        .flatMap((session) => session?.snapshot?.trackedFiles ?? [])
        .filter(isAiTrackedFileUnresolved);
    collectPendingCache.set(sessions, collected);
    return collected;
}

export function matchesTrackedFilePath(
    trackedFile: AiTrackedFile,
    path: string,
): boolean {
    return matchesTrackedFilePathAlias(trackedFile, path);
}

export function isInlineReviewSupported(
    trackedFile: AiTrackedFile | null | undefined,
): trackedFile is AiTrackedFile {
    return Boolean(
        trackedFile &&
        trackedFile.isText &&
        trackedFile.kind === "update" &&
        trackedFile.oldText !== null &&
        trackedFile.newText !== null,
    );
}

export function findBestPendingTrackedFile(input: {
    readonly paths: readonly (string | null | undefined)[];
    readonly preferInlineReview?: boolean;
    readonly reviewContext?: RuntimeWorkspaceFileReviewContext | null;
    readonly trackedFiles: readonly AiTrackedFile[];
}): AiTrackedFile | null {
    const candidatePaths = [...new Set(input.paths)].filter(
        (path): path is string => typeof path === "string" && path.length > 0,
    );

    if (candidatePaths.length === 0) {
        return null;
    }

    const pendingTrackedFiles = input.trackedFiles.filter(
        (trackedFile) => trackedFile.reviewState === "pending",
    );

    const reviewContextMatch =
        input.reviewContext &&
        pendingTrackedFiles.find(
            (trackedFile) =>
                trackedFile.sessionId === input.reviewContext?.sessionId &&
                matchesTrackedFilePath(trackedFile, input.reviewContext.path) &&
                candidatePaths.some((path) =>
                    matchesTrackedFilePath(trackedFile, path),
                ),
        );

    if (reviewContextMatch) {
        return reviewContextMatch;
    }

    const matchingTrackedFiles = pendingTrackedFiles
        .filter((trackedFile) =>
            candidatePaths.some((path) =>
                matchesTrackedFilePath(trackedFile, path),
            ),
        )
        .sort((left, right) => {
            const leftScore = getTrackedFilePriority(
                left,
                candidatePaths,
                input.preferInlineReview ?? false,
            );
            const rightScore = getTrackedFilePriority(
                right,
                candidatePaths,
                input.preferInlineReview ?? false,
            );

            if (leftScore !== rightScore) {
                return rightScore - leftScore;
            }

            return right.updatedAt.localeCompare(left.updatedAt);
        });

    return matchingTrackedFiles[0] ?? null;
}

export function resolveFileTabReviewContext(input: {
    readonly existingReviewContext?: RuntimeWorkspaceFileReviewContext | null;
    readonly relativePath: string;
    readonly requestedReviewContext?: RuntimeWorkspaceFileReviewContext | null;
    readonly trackedFiles: readonly AiTrackedFile[];
}): RuntimeWorkspaceFileReviewContext | null {
    if (input.requestedReviewContext !== undefined) {
        return input.requestedReviewContext;
    }

    const matchedTrackedFile = findBestPendingTrackedFile({
        paths: [input.relativePath],
        preferInlineReview: true,
        reviewContext: input.existingReviewContext,
        trackedFiles: input.trackedFiles,
    });

    if (!matchedTrackedFile) {
        return null;
    }

    return {
        path: matchedTrackedFile.path,
        sessionId: matchedTrackedFile.sessionId,
    };
}

function getTrackedFilePriority(
    trackedFile: AiTrackedFile,
    candidatePaths: readonly string[],
    preferInlineReview: boolean,
): number {
    let score = 0;

    if (preferInlineReview && isInlineReviewSupported(trackedFile)) {
        score += 4;
    }

    if (
        candidatePaths.some((path) =>
            areTrackedFilePathsEquivalent(trackedFile.path, path),
        )
    ) {
        score += 2;
    }

    if (
        candidatePaths.some((path) =>
            areTrackedFilePathsEquivalent(trackedFile.previousPath, path),
        )
    ) {
        score += 1;
    }

    return score;
}
