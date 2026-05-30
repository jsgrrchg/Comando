import type { GitTreeDragData, GitTreeDragPayload } from "./types";

export function normalizeGitTreeDragPayload(
    dragData: GitTreeDragPayload,
): readonly GitTreeDragData[] {
    if (Array.isArray(dragData)) {
        return dragData as readonly GitTreeDragData[];
    }

    return [dragData as GitTreeDragData];
}

export function canDropProjectEntryIntoDirectory(
    dragData: GitTreeDragData | null,
    directoryPath: string | null,
): dragData is GitTreeDragData {
    if (!dragData) {
        return false;
    }

    const currentParentPath = getProjectEntryParentRelativePath(
        dragData.relativePath,
    );
    if (currentParentPath === directoryPath) {
        return false;
    }

    if (dragData.kind === "directory") {
        return (
            dragData.relativePath !== directoryPath &&
            !(directoryPath ?? "").startsWith(`${dragData.relativePath}/`)
        );
    }

    return true;
}

export function canDropProjectEntriesIntoDirectory(
    dragData: GitTreeDragPayload | null,
    directoryPath: string | null,
): dragData is GitTreeDragPayload {
    if (!dragData) {
        return false;
    }

    const entries = normalizeGitTreeDragPayload(dragData);
    return (
        entries.length > 0 &&
        entries.some(
            (entry) =>
                getProjectEntryParentRelativePath(entry.relativePath) !==
                directoryPath,
        ) &&
        entries.every((entry) => {
            if (entry.kind !== "directory") {
                return true;
            }

            return (
                entry.relativePath !== directoryPath &&
                !(directoryPath ?? "").startsWith(`${entry.relativePath}/`)
            );
        })
    );
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
