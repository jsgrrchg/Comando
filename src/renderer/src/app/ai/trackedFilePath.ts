import type { AiTrackedFile } from "@shared/ipc";
import {
    normalizePathKey,
    type PathIdentityPlatform,
} from "@shared/path-identity";

import { useAppStore } from "@renderer/app/store/app-store";

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

    const platform = resolveTrackedFilePathPlatform(
        leftPath,
        rightPath,
        options,
    );
    return (
        normalizePathKey(leftPath, { platform }) ===
        normalizePathKey(rightPath, { platform })
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

function resolveTrackedFilePathPlatform(
    leftPath: string,
    rightPath: string,
    options: TrackedFilePathMatchOptions,
): PathIdentityPlatform {
    if (options.platform) {
        return options.platform;
    }

    const inferredPathPlatform = inferTrackedFilePathPlatform(
        leftPath,
        rightPath,
    );
    if (inferredPathPlatform === "win32") {
        return "win32";
    }

    return useAppStore.getState().bootstrap?.platform === "win32"
        ? "win32"
        : "posix";
}
