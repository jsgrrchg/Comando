import type { ProjectTreeNode } from "@shared/ipc";

import {
    getProjectEntryMoveValidation,
    type ProjectEntryMoveValidationReason,
} from "../../components/git/tree-dnd";
import type { GitTreeDragData } from "../../components/git/types";

export interface FileTreeMoveDestination {
    readonly canMove: boolean;
    readonly depth: number;
    readonly invalidReason: string | null;
    readonly name: string;
    readonly path: string | null;
    readonly pathLabel: string;
}

export function buildFileTreeMoveDestinations({
    activeProjectName,
    entries,
    projectEntryIndex,
    query,
    treeNodesByParent,
}: {
    readonly activeProjectName: string | null;
    readonly entries: readonly GitTreeDragData[] | null;
    readonly projectEntryIndex: readonly ProjectTreeNode[] | null;
    readonly query: string;
    readonly treeNodesByParent: Record<string, readonly ProjectTreeNode[]>;
}): readonly FileTreeMoveDestination[] {
    if (!entries || !activeProjectName) {
        return [];
    }

    const normalizedQuery = query.trim().toLowerCase();
    const directoryCandidates = collectFileTreeDirectoryCandidates({
        activeProjectName,
        projectEntryIndex,
        treeNodesByParent,
    });

    return directoryCandidates
        .filter((destination) => {
            if (!normalizedQuery) {
                return true;
            }

            return `${destination.name} ${destination.pathLabel}`
                .toLowerCase()
                .includes(normalizedQuery);
        })
        .map((destination) => {
            const validation = getProjectEntryMoveValidation(
                entries,
                destination.path,
            );

            return {
                ...destination,
                canMove: validation.canMove,
                invalidReason: validation.canMove
                    ? null
                    : getFileTreeMoveValidationMessage(validation.reason),
            };
        });
}

function collectFileTreeDirectoryCandidates({
    activeProjectName,
    projectEntryIndex,
    treeNodesByParent,
}: {
    readonly activeProjectName: string;
    readonly projectEntryIndex: readonly ProjectTreeNode[] | null;
    readonly treeNodesByParent: Record<string, readonly ProjectTreeNode[]>;
}): readonly Omit<FileTreeMoveDestination, "canMove" | "invalidReason">[] {
    const seenPaths = new Set<string>();
    const destinations: Omit<
        FileTreeMoveDestination,
        "canMove" | "invalidReason"
    >[] = [
        {
            depth: 0,
            name: activeProjectName,
            path: null,
            pathLabel: "Project root",
        },
    ];

    const pushDirectory = (relativePath: string) => {
        if (!relativePath || seenPaths.has(relativePath)) {
            return;
        }

        seenPaths.add(relativePath);
        const segments = relativePath.split("/").filter(Boolean);
        destinations.push({
            depth: segments.length,
            name: segments.at(-1) ?? relativePath,
            path: relativePath,
            pathLabel: relativePath,
        });
    };

    if (projectEntryIndex) {
        projectEntryIndex
            .filter((entry) => entry.kind === "directory")
            .map((entry) => entry.relativePath)
            .sort((left, right) =>
                left.localeCompare(right, undefined, { sensitivity: "base" }),
            )
            .forEach(pushDirectory);
        return destinations;
    }

    Object.values(treeNodesByParent)
        .flat()
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.relativePath)
        .sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: "base" }),
        )
        .forEach(pushDirectory);

    return destinations;
}

export function getFileTreeMoveValidationMessage(
    reason: ProjectEntryMoveValidationReason | null,
): string {
    switch (reason) {
        case "directory-descendant":
            return "Cannot move a folder into one of its subfolders.";
        case "directory-self":
            return "Cannot move a folder into itself.";
        case "empty":
            return "No items selected.";
        case "same-parent":
            return "Already in this folder.";
        default:
            return "Cannot move to this folder.";
    }
}

export function resolveFileTreeMovePickerSelectedIndex(
    destinations: readonly FileTreeMoveDestination[],
    index: number,
): number {
    if (destinations.length === 0) {
        return 0;
    }

    const clampedIndex = Math.min(Math.max(index, 0), destinations.length - 1);
    if (destinations[clampedIndex]?.canMove) {
        return clampedIndex;
    }

    const firstMovableIndex = destinations.findIndex(
        (destination) => destination.canMove,
    );
    return firstMovableIndex >= 0 ? firstMovableIndex : clampedIndex;
}

export function findNextFileTreeMoveDestinationIndex(
    destinations: readonly FileTreeMoveDestination[],
    selectedIndex: number,
    direction: 1 | -1,
): number {
    if (destinations.length === 0) {
        return 0;
    }

    for (let offset = 1; offset <= destinations.length; offset += 1) {
        const nextIndex =
            (selectedIndex + offset * direction + destinations.length) %
            destinations.length;
        if (destinations[nextIndex]?.canMove) {
            return nextIndex;
        }
    }

    return Math.min(Math.max(selectedIndex, 0), destinations.length - 1);
}
