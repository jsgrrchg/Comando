import type { GitTreeDragData, GitTreeDragPayload } from "./types";

export type ProjectEntryMoveValidationReason =
    | "directory-descendant"
    | "directory-self"
    | "empty"
    | "same-parent";

export interface ProjectEntryMoveValidation {
    readonly canMove: boolean;
    readonly entries: readonly GitTreeDragData[];
    readonly reason: ProjectEntryMoveValidationReason | null;
}

export function normalizeGitTreeDragPayload(
    dragData: GitTreeDragPayload,
): readonly GitTreeDragData[] {
    if (Array.isArray(dragData)) {
        return dragData as readonly GitTreeDragData[];
    }

    return [dragData as GitTreeDragData];
}

export function compactGitTreeDragEntriesByAncestor(
    entries: readonly GitTreeDragData[],
): GitTreeDragData[] {
    const seenPaths = new Set<string>();
    const uniqueEntries = entries.filter((entry) => {
        if (seenPaths.has(entry.relativePath)) {
            return false;
        }

        seenPaths.add(entry.relativePath);
        return true;
    });

    return uniqueEntries.filter((entry) => {
        if (entry.relativePath === "") {
            return true;
        }

        return !uniqueEntries.some(
            (candidate) =>
                candidate.kind === "directory" &&
                candidate.relativePath !== "" &&
                isProjectEntryDescendantPath(
                    candidate.relativePath,
                    entry.relativePath,
                ),
        );
    });
}

export function getProjectEntryMoveValidation(
    dragData: GitTreeDragPayload | null,
    directoryPath: string | null,
): ProjectEntryMoveValidation {
    if (!dragData) {
        return { canMove: false, entries: [], reason: "empty" };
    }

    const destinationPath = normalizeProjectDirectoryPath(directoryPath);
    const compactedEntries = compactGitTreeDragEntriesByAncestor(
        normalizeGitTreeDragPayload(dragData),
    );
    if (compactedEntries.length === 0) {
        return { canMove: false, entries: [], reason: "empty" };
    }

    for (const entry of compactedEntries) {
        if (entry.kind !== "directory") {
            continue;
        }

        if (entry.relativePath === destinationPath) {
            return {
                canMove: false,
                entries: compactedEntries,
                reason: "directory-self",
            };
        }

        if (
            destinationPath &&
            isProjectEntryDescendantPath(entry.relativePath, destinationPath)
        ) {
            return {
                canMove: false,
                entries: compactedEntries,
                reason: "directory-descendant",
            };
        }
    }

    const movableEntries = compactedEntries.filter(
        (entry) =>
            getProjectEntryParentRelativePath(entry.relativePath) !==
            destinationPath,
    );
    if (movableEntries.length === 0) {
        return {
            canMove: false,
            entries: compactedEntries,
            reason: "same-parent",
        };
    }

    return { canMove: true, entries: movableEntries, reason: null };
}

export function canDropProjectEntryIntoDirectory(
    dragData: GitTreeDragData | null,
    directoryPath: string | null,
): dragData is GitTreeDragData {
    return getProjectEntryMoveValidation(dragData, directoryPath).canMove;
}

export function canDropProjectEntriesIntoDirectory(
    dragData: GitTreeDragPayload | null,
    directoryPath: string | null,
): dragData is GitTreeDragPayload {
    return getProjectEntryMoveValidation(dragData, directoryPath).canMove;
}

export function getProjectEntryParentRelativePath(
    relativePath: string,
): string | null {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
        return null;
    }

    return segments.slice(0, -1).join("/");
}

function normalizeProjectDirectoryPath(directoryPath: string | null): string | null {
    const normalizedPath = directoryPath?.split("/").filter(Boolean).join("/");
    return normalizedPath ? normalizedPath : null;
}

function isProjectEntryDescendantPath(
    parentPath: string,
    candidatePath: string,
): boolean {
    return (
        candidatePath !== parentPath &&
        candidatePath.startsWith(`${parentPath}/`)
    );
}
