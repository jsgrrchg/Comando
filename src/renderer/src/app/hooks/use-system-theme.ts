import { useProjectsStore } from "../store/projects-store";
import { useWorkspaceStore } from "../store/workspace-store";
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
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const activePaneId = useWorkspaceStore((state) => state.activePaneId);
    const rootNode = useWorkspaceStore((state) => state.rootNode);
    const tabsById = useWorkspaceStore((state) => state.tabsById);
    const appearanceProjectId = resolveAppearanceProjectId(activeProjectId, {
        activePaneId,
        rootNode,
        tabsById,
    });

    useResolvedAppearance(appearanceProjectId);
}
