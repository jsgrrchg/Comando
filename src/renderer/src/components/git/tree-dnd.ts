import type { GitTreeDragData } from "./types";

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

export function getProjectEntryParentRelativePath(
    relativePath: string,
): string | null {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
        return null;
    }

    return segments.slice(0, -1).join("/");
}
