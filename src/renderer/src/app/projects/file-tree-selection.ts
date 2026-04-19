import type { RuntimeWorkspaceTab } from "../workspace/tree";

interface ResolveActiveFileTreePathInput {
    readonly activeProjectId: string | null;
    readonly activeWorkspaceTab: RuntimeWorkspaceTab | null;
    readonly activeWorktreeId: string | null;
}

interface ReconcileFileTreeSelectionInput {
    readonly activeFileTreePath: string | null;
    readonly anchorPath: string | null;
    readonly selectedPaths: readonly string[];
}

interface FileTreeSelectionState {
    readonly anchorPath: string | null;
    readonly selectedPaths: readonly string[];
}

export function resolveActiveFileTreePath({
    activeProjectId,
    activeWorkspaceTab,
    activeWorktreeId,
}: ResolveActiveFileTreePathInput): string | null {
    if (
        activeWorkspaceTab?.kind !== "file" ||
        !activeProjectId ||
        activeWorkspaceTab.projectId !== activeProjectId ||
        (activeWorkspaceTab.worktreeId ?? null) !== activeWorktreeId
    ) {
        return null;
    }

    return activeWorkspaceTab.relativePath;
}

export function reconcileFileTreeSelection({
    activeFileTreePath,
    anchorPath,
    selectedPaths,
}: ReconcileFileTreeSelectionInput): FileTreeSelectionState {
    if (activeFileTreePath === null) {
        return {
            anchorPath,
            selectedPaths,
        };
    }

    const matchesActiveFile =
        selectedPaths.length === 1 &&
        selectedPaths[0] === activeFileTreePath &&
        anchorPath === activeFileTreePath;

    if (matchesActiveFile) {
        return {
            anchorPath,
            selectedPaths,
        };
    }

    return {
        anchorPath: activeFileTreePath,
        selectedPaths: [activeFileTreePath],
    };
}
