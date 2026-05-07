import {
    COMPOSER_PROJECT_ENTRY_LIST_MIME,
    COMPOSER_PROJECT_ENTRY_MIME,
    getExternalComposerDropItems,
    parseComposerProjectEntryListDragData,
    parseComposerProjectEntryDragData,
    type ComposerProjectEntryDragData,
} from "@renderer/app/drag-and-drop";
import type { WorkspaceOpenTarget } from "@renderer/app/store/workspace-store";

import type { WorkspacePaneDropTarget } from "./workspaceDropTargets";

export type WorkspacePaneFileDragOverIntent = {
    readonly acceptsDrop: boolean;
    readonly previewTarget: WorkspacePaneDropTarget | null;
};

export type WorkspaceDropTargetPreviewScheduler<TTarget> = {
    readonly clear: () => void;
    readonly dispose: () => void;
    readonly schedule: (target: TTarget | null) => void;
};

export function resolveWorkspacePaneFileDragOverIntent(input: {
    readonly dataTransfer: DataTransfer;
    readonly projectRootPath: string | null;
    readonly target: WorkspacePaneDropTarget | null;
}): WorkspacePaneFileDragOverIntent {
    if (
        !input.target ||
        !hasWorkspacePaneFileDragPayload(input.dataTransfer)
    ) {
        return {
            acceptsDrop: false,
            previewTarget: null,
        };
    }

    const fileEntries = getWorkspacePaneFileDropEntries({
        dataTransfer: input.dataTransfer,
        projectRootPath: input.projectRootPath,
    });

    return {
        acceptsDrop: true,
        previewTarget: fileEntries.length > 0 ? input.target : null,
    };
}

export function createWorkspaceDropTargetPreviewScheduler<TTarget>(input: {
    readonly applyTarget: (target: TTarget | null) => void;
    readonly cancelFrame: (frameId: number) => void;
    readonly requestFrame: (callback: () => void) => number;
}): WorkspaceDropTargetPreviewScheduler<TTarget> {
    let pendingTarget: TTarget | null = null;
    let frameId: number | null = null;

    const cancelPendingFrame = () => {
        if (frameId === null) {
            return;
        }

        input.cancelFrame(frameId);
        frameId = null;
    };

    return {
        clear: () => {
            pendingTarget = null;
            cancelPendingFrame();
            input.applyTarget(null);
        },
        dispose: () => {
            pendingTarget = null;
            cancelPendingFrame();
        },
        schedule: (target) => {
            pendingTarget = target;
            if (target) {
                cancelPendingFrame();
                input.applyTarget(target);
                return;
            }

            if (frameId !== null) {
                return;
            }

            frameId = input.requestFrame(() => {
                frameId = null;
                input.applyTarget(pendingTarget);
            });
        },
    };
}

export function hasWorkspacePaneFileDragPayload(
    dataTransfer: DataTransfer,
): boolean {
    const types = Array.from(dataTransfer.types ?? []);
    return (
        types.includes(COMPOSER_PROJECT_ENTRY_LIST_MIME) ||
        types.includes(COMPOSER_PROJECT_ENTRY_MIME) ||
        types.includes("Files")
    );
}

export function getWorkspacePaneFileDropEntries(input: {
    readonly dataTransfer: DataTransfer;
    readonly projectRootPath: string | null;
}): ComposerProjectEntryDragData[] {
    const projectEntries = getComposerProjectFileDragEntries(input.dataTransfer);
    if (projectEntries.length > 0) {
        return projectEntries;
    }

    const projectRootPath = input.projectRootPath;
    if (!projectRootPath) {
        return [];
    }

    return getExternalComposerDropItems(input.dataTransfer).flatMap((item) => {
        if (item.kind !== "file_attachment") {
            return [];
        }

        const relativePath = getRelativePathInsideRoot(
            item.filePath,
            projectRootPath,
        );
        if (!relativePath) {
            return [];
        }

        return [
            {
                kind: "file" as const,
                name: getPathBaseName(relativePath),
                relativePath,
            },
        ];
    });
}

export function workspacePaneDropTargetToOpenTarget(
    target: WorkspacePaneDropTarget,
): WorkspaceOpenTarget {
    if (target.type === "split") {
        return {
            direction: target.direction,
            insertIndex: 0,
            paneId: target.paneId,
            type: "split",
        };
    }

    if (target.type === "strip") {
        return {
            insertIndex: target.index,
            paneId: target.paneId,
            type: "pane",
        };
    }

    return {
        paneId: target.paneId,
        type: "pane",
    };
}

export function getNextProjectFileOpenTarget(
    currentTarget: WorkspaceOpenTarget,
    paneId: string,
): WorkspaceOpenTarget {
    const currentIndex = currentTarget.insertIndex;
    return {
        insertIndex: currentIndex === undefined ? undefined : currentIndex + 1,
        paneId,
        type: "pane",
    };
}

function getComposerProjectFileDragEntries(
    dataTransfer: DataTransfer,
): ComposerProjectEntryDragData[] {
    const listData = parseComposerProjectEntryListDragData(
        dataTransfer.getData(COMPOSER_PROJECT_ENTRY_LIST_MIME),
    );
    if (listData) {
        return listData.entries.filter((entry) => entry.kind === "file");
    }

    const singleData = parseComposerProjectEntryDragData(
        dataTransfer.getData(COMPOSER_PROJECT_ENTRY_MIME),
    );
    return singleData?.kind === "file" ? [singleData] : [];
}

function getRelativePathInsideRoot(
    filePath: string,
    rootPath: string,
): string | null {
    const normalizedFilePath = normalizeComparablePath(filePath);
    const normalizedRootPath = normalizeComparablePath(rootPath).replace(
        /\/+$/,
        "",
    );
    if (!normalizedFilePath || !normalizedRootPath) {
        return null;
    }

    const compareFilePath = shouldComparePathCaseInsensitive(normalizedRootPath)
        ? normalizedFilePath.toLowerCase()
        : normalizedFilePath;
    const compareRootPath = shouldComparePathCaseInsensitive(normalizedRootPath)
        ? normalizedRootPath.toLowerCase()
        : normalizedRootPath;
    const prefix = `${compareRootPath}/`;
    if (!compareFilePath.startsWith(prefix)) {
        return null;
    }

    return normalizedFilePath.slice(normalizedRootPath.length + 1);
}

function normalizeComparablePath(candidate: string): string {
    return candidate.trim().replaceAll("\\", "/");
}

function shouldComparePathCaseInsensitive(candidate: string): boolean {
    return /^[a-z]:\//i.test(candidate);
}

function getPathBaseName(candidatePath: string): string {
    const normalized = candidatePath.replace(/[\\/]+$/, "");
    const slashIndex = Math.max(
        normalized.lastIndexOf("/"),
        normalized.lastIndexOf("\\"),
    );
    return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}
