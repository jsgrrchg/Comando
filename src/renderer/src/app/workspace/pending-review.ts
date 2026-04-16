import { syncTrackedFile } from "@shared/ai-tracked-file";
import type { AiTrackedFile } from "@shared/ipc";

import type { RuntimeWorkspaceFileReviewContext } from "./tree";

type SessionWithTrackedFiles = {
    readonly snapshot?: {
        readonly trackedFiles?: readonly AiTrackedFile[];
    } | null;
};

export function collectPendingTrackedFilesFromSessions(
    sessions: Readonly<Record<string, SessionWithTrackedFiles | undefined>>,
): readonly AiTrackedFile[] {
    return Object.values(sessions)
        .flatMap((session) => session?.snapshot?.trackedFiles ?? [])
        .map((trackedFile) => syncTrackedFile(trackedFile))
        .filter((trackedFile) => trackedFile.reviewState === "pending");
}

export function matchesTrackedFilePath(
    trackedFile: AiTrackedFile,
    path: string,
): boolean {
    return trackedFile.path === path || trackedFile.previousPath === path;
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

    if (candidatePaths.some((path) => trackedFile.path === path)) {
        score += 2;
    }

    if (candidatePaths.some((path) => trackedFile.previousPath === path)) {
        score += 1;
    }

    return score;
}
