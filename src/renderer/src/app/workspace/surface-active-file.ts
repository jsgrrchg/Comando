import type { WorkspaceSurfaceActiveFileState } from "@shared/ipc";

import { resolveActiveFileTreePath } from "../projects/file-tree-selection";
import {
    findPaneById,
    type WorkspaceTreeState,
} from "./tree";

interface WorkspaceSurfaceContext {
    readonly key: string;
    readonly projectId: string;
    readonly worktreeId: string | null;
}

export type WorkspaceActiveFilePaths = Readonly<
    Record<string, string | null>
>;

export function updateWorkspaceActiveFilePaths(
    current: WorkspaceActiveFilePaths,
    state: WorkspaceSurfaceActiveFileState,
): WorkspaceActiveFilePaths {
    if (current[state.contextKey] === state.relativePath) {
        return current;
    }

    return {
        ...current,
        [state.contextKey]: state.relativePath,
    };
}

export function resolveWorkspaceSurfaceActiveFileState(
    workspace: WorkspaceTreeState,
    context: WorkspaceSurfaceContext,
): WorkspaceSurfaceActiveFileState {
    const activePane = findPaneById(
        workspace.rootNode,
        workspace.activePaneId,
    );
    const activeWorkspaceTab = activePane?.activeTabId
        ? (workspace.tabsById[activePane.activeTabId] ?? null)
        : null;

    return {
        contextKey: context.key,
        projectId: context.projectId,
        // Publish null for non-file tabs so the host clears only the active highlight.
        relativePath: resolveActiveFileTreePath({
            activeProjectId: context.projectId,
            activeWorkspaceTab,
            activeWorktreeId: context.worktreeId,
        }),
        worktreeId: context.worktreeId,
    };
}
