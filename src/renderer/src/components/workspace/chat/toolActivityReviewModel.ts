import type { AiToolActivity, AiTrackedFile } from "@shared/ipc";

export interface ToolActivityReviewEntry {
    readonly activity: AiToolActivity;
    readonly hasPendingTrackedFiles: boolean;
    readonly pendingTrackedFiles: readonly AiTrackedFile[];
    readonly trackedFiles: readonly AiTrackedFile[];
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
