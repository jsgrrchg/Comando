import { findPaneById, type WorkspaceTreeState } from "../workspace/tree";
import { useResolvedAppearance } from "./use-resolved-appearance";

export function resolveAppearanceProjectId(
    activeProjectId: string | null,
    workspaceState: WorkspaceTreeState,
): string | null {
    const activePane = findPaneById(
        workspaceState.rootNode,
        workspaceState.activePaneId,
    );
    const activeTabId = activePane?.activeTabId ?? null;
    const activeTab = activeTabId
        ? workspaceState.tabsById[activeTabId]
        : undefined;

    return activeTab?.projectId ?? activeProjectId;
}

export function useSystemTheme(): void {
    useResolvedAppearance();
}
