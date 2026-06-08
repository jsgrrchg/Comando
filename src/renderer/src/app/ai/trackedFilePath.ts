import type { AiTrackedFile } from "@shared/ipc";
import {
    normalizePathKey,
    type PathIdentityPlatform,
} from "@shared/path-identity";

export interface TrackedFilePathMatchOptions {
    readonly platform?: PathIdentityPlatform;
}

export function matchesTrackedFilePath(
    trackedFile: AiTrackedFile,
    candidatePath: string,
    options: TrackedFilePathMatchOptions = {},
): boolean {
    return getTrackedFilePathAliases(trackedFile).some((path) =>
        areTrackedFilePathsEquivalent(path, candidatePath, options),
    );
}

export function areTrackedFilePathsEquivalent(
    leftPath: string | null | undefined,
    rightPath: string | null | undefined,
    options: TrackedFilePathMatchOptions = {},
): boolean {
    if (!leftPath || !rightPath) {
        return false;
    }

    const platform =
        options.platform ?? inferTrackedFilePathPlatform(leftPath, rightPath);
    if (
        normalizePathKey(leftPath, { platform }) ===
        normalizePathKey(rightPath, { platform })
    ) {
        return true;
    }

    return (
        !options.platform &&
        platform !== "win32" &&
        normalizePathKey(leftPath, { platform: "win32" }) ===
            normalizePathKey(rightPath, { platform: "win32" })
    );
}

export function getTrackedFilePathAliases(
    trackedFile: AiTrackedFile,
): readonly string[] {
    return trackedFile.previousPath
        ? [trackedFile.path, trackedFile.previousPath]
        : [trackedFile.path];
}

function inferTrackedFilePathPlatform(
    ...paths: readonly string[]
): PathIdentityPlatform {
    return paths.some(
        (path) =>
            /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) ||
            path.includes("\\"),
    )
        ? "win32"
        : "posix";
}
