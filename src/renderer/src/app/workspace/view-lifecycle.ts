export type WorkspaceViewLifecycle = "active" | "warm" | "cold" | "disposed";

export interface WorkspaceViewLifecyclePane {
    readonly activeTabId: string | null;
    readonly id: string;
    readonly tabIds: readonly string[];
    readonly visible: boolean;
}

export interface ResolveWorkspaceViewLifecyclesInput {
    readonly focusedPaneId: string;
    /** Most recent first. */
    readonly recentTabIds: readonly string[];
    readonly panes: readonly WorkspaceViewLifecyclePane[];
}

export interface WorkspaceViewLifecycleSnapshot {
    readonly lifecycleByTabId: ReadonlyMap<string, WorkspaceViewLifecycle>;
    readonly lifecycleByPaneId: ReadonlyMap<string, WorkspaceViewLifecycle>;
}

/**
 * Resolves resource ownership without coupling it to mounted React trees.
 * A visible selected tab is active, while recently visited inactive tabs are
 * warm state only: callers may retain serializable snapshots, never DOM work.
 */
export function resolveWorkspaceViewLifecycles({
    focusedPaneId,
    panes,
    recentTabIds,
}: ResolveWorkspaceViewLifecyclesInput): WorkspaceViewLifecycleSnapshot {
    const lifecycleByPaneId = new Map<string, WorkspaceViewLifecycle>();
    const lifecycleByTabId = new Map<string, WorkspaceViewLifecycle>();
    const knownTabIds = new Set<string>();

    for (const pane of panes) {
        // Every visible split is an active rendering surface. Focus still
        // determines input priority, but hiding a visible split would make a
        // multipane workspace appear empty.
        const paneLifecycle =
            pane.visible || pane.id === focusedPaneId ? "active" : "cold";
        lifecycleByPaneId.set(pane.id, paneLifecycle);

        for (const tabId of pane.tabIds) {
            knownTabIds.add(tabId);
            lifecycleByTabId.set(tabId, "cold");
        }

        if (pane.activeTabId && knownTabIds.has(pane.activeTabId)) {
            lifecycleByTabId.set(
                pane.activeTabId,
                paneLifecycle === "active" ? "active" : "warm",
            );
        }
    }

    for (const tabId of recentTabIds) {
        if (knownTabIds.has(tabId) && lifecycleByTabId.get(tabId) === "cold") {
            lifecycleByTabId.set(tabId, "warm");
        }
    }

    return { lifecycleByPaneId, lifecycleByTabId };
}

export function isWorkspaceViewInteractive(
    lifecycle: WorkspaceViewLifecycle,
): boolean {
    return lifecycle === "active";
}

export function shouldMountWorkspaceHeavyView(
    lifecycle: WorkspaceViewLifecycle,
): boolean {
    return lifecycle === "active";
}
