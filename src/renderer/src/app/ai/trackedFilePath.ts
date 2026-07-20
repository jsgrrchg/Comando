import type { AiTrackedFile } from "@shared/ipc";
import {
    normalizePathKey,
    type PathIdentityPlatform,
} from "@shared/path-identity";

import { useAppStore } from "@renderer/app/store/app-store";

export interface TrackedFilePathMatchOptions {
    readonly platform?: PathIdentityPlatform;
}

/**
 * Deduplicates path references with the same absolute/relative matching rules
 * used by review data, without repeatedly scanning every previous path.
 */
export class TrackedFilePathReferenceSet {
    private readonly absolutePathKeys = new Set<string>();
    private readonly absolutePathSuffixKeys = new Set<string>();
    private readonly relativePathKeys = new Set<string>();

    add(path: string | null | undefined): boolean {
        const normalizedPath = path?.trim();
        if (!normalizedPath) return false;

        const platform = inferTrackedFilePathPlatform(normalizedPath);
        const pathKey = normalizePathKey(normalizedPath, { platform });
        if (looksAbsolutePath(normalizedPath)) {
            if (this.absolutePathKeys.has(pathKey)) return false;

            const suffixes = getPathSuffixKeys(pathKey);
            if (suffixes.some((suffix) => this.relativePathKeys.has(suffix))) {
                return false;
            }

            this.absolutePathKeys.add(pathKey);
            for (const suffix of suffixes) {
                this.absolutePathSuffixKeys.add(suffix);
            }
            return true;
        }

        if (
            this.relativePathKeys.has(pathKey) ||
            this.absolutePathSuffixKeys.has(pathKey)
        ) {
            return false;
        }

        this.relativePathKeys.add(pathKey);
        return true;
    }

    get size(): number {
        return (
            this.absolutePathKeys.size +
            this.relativePathKeys.size
        );
    }
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

export function areTrackedFilePathReferencesEquivalent(
    leftPath: string | null | undefined,
    rightPath: string | null | undefined,
): boolean {
    if (!leftPath || !rightPath) {
        return false;
    }

    return (
        areTrackedFilePathsEquivalent(leftPath, rightPath) ||
        isScopedPathSuffix(leftPath, rightPath) ||
        isScopedPathSuffix(rightPath, leftPath)
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

function isScopedPathSuffix(
    candidatePath: string,
    scopedPath: string,
): boolean {
    if (!looksAbsolutePath(candidatePath) || looksAbsolutePath(scopedPath)) {
        return false;
    }

    const platform = inferTrackedFilePathPlatform(candidatePath, scopedPath);
    const candidate = normalizePathKey(candidatePath, { platform });
    const scoped = normalizePathKey(scopedPath, { platform });
    return candidate.endsWith(`/${scoped}`);
}

function looksAbsolutePath(candidatePath: string): boolean {
    return (
        candidatePath.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/.test(candidatePath) ||
        /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(candidatePath)
    );
}

function getPathSuffixKeys(pathKey: string): readonly string[] {
    const segments = pathKey.split("/").filter(Boolean);
    return segments.map((_, index) => segments.slice(index).join("/"));
}
