import type { RuntimeWorkspaceTab } from "../workspace/tree";
import {
    selectGitTreeRange,
    toggleGitTreePathSelection,
} from "../../components/git/treeSelection";

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

interface ResolveFileTreeNodeClickSelectionInput {
    readonly anchorPath: string | null;
    readonly isRangeSelection: boolean;
    readonly isToggleSelection: boolean;
    readonly nodePath: string;
    readonly selectedPaths: readonly string[];
    readonly visiblePaths: readonly string[];
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
    if (selectedPaths.length > 0 || activeFileTreePath === null) {
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

export function resolveFileTreeNodeClickSelection({
    anchorPath,
    isRangeSelection,
    isToggleSelection,
    nodePath,
    selectedPaths,
    visiblePaths,
}: ResolveFileTreeNodeClickSelectionInput): FileTreeSelectionState {
    if (isRangeSelection) {
        const effectiveAnchorPath = anchorPath ?? nodePath;
        return {
            anchorPath: effectiveAnchorPath,
            selectedPaths: selectGitTreeRange(
                visiblePaths,
                effectiveAnchorPath,
                nodePath,
            ),
        };
    }

    if (isToggleSelection) {
        return {
            anchorPath: nodePath,
            selectedPaths: toggleGitTreePathSelection(selectedPaths, nodePath),
        };
    }

    return {
        anchorPath: null,
        selectedPaths: [],
    };
}
