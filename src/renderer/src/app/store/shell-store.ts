import { create } from "zustand";

import type {
    PersistedShellState,
    PersistedShellStateV3,
    WorkspaceInspectorView,
} from "@shared/ipc";

import {
    createDefaultShellLayout,
    normalizeShellLayout,
    nudgeShellPanel,
    resizeShellPanel,
    resolveShellResponsiveLayout,
    type ShellLayoutDimensions,
    type ShellPanelSide,
    type ShellResponsiveLayout,
    type ShellSurface,
} from "../layout/shell-layout";

const initialLayout = createDefaultShellLayout();
const INITIAL_VIEWPORT_WIDTH = 1_440;

export interface ShellStore extends ShellLayoutDimensions {
    readonly activeSurface: ShellSurface;
    readonly drawerChangedLocally: boolean;
    readonly expandedProjectIds: readonly string[];
    readonly isResizingPanel: boolean;
    readonly leftCollapsed: boolean;
    readonly leftCollapsedChangedLocally: boolean;
    readonly preferredDrawer: ShellPanelSide | null;
    readonly responsive: ShellResponsiveLayout;
    readonly rightCollapsed: boolean;
    readonly rightCollapsedChangedLocally: boolean;
    readonly rightInspectorView: WorkspaceInspectorView;
    readonly viewportWidth: number;
    focusSurface: (surface: ShellSurface) => void;
    hydrate: (snapshot: PersistedShellState | null) => void;
    nudgePanel: (side: ShellPanelSide, delta: number) => void;
    resizePanel: (side: ShellPanelSide, nextWidth: number) => void;
    setLeftCollapsed: (collapsed: boolean) => void;
    setProjectExpanded: (projectId: string, expanded: boolean) => void;
    setPanelCollapsed: (side: ShellPanelSide, collapsed: boolean) => void;
    setPreferredDrawer: (side: ShellPanelSide | null) => void;
    setResizingPanel: (resizing: boolean) => void;
    setRightCollapsed: (collapsed: boolean) => void;
    setRightInspectorView: (view: WorkspaceInspectorView) => void;
    syncViewport: (viewportWidth: number) => void;
    toggleLeftCollapsed: () => void;
    togglePanel: (side: ShellPanelSide) => void;
    toggleRightCollapsed: () => void;
    toggleSidebarView: () => void;
}

export function migratePersistedShellState(
    snapshot: PersistedShellState | null,
): PersistedShellStateV3 {
    if (snapshot?.version === 2 || snapshot?.version === 3) {
        return {
            activeSurface: normalizeActiveSurface(snapshot.activeSurface),
            expandedProjectIds:
                snapshot.version === 3
                    ? normalizeExpandedProjectIds(snapshot.expandedProjectIds)
                    : [],
            leftCollapsed: snapshot.leftCollapsed === true,
            leftWidth: finiteOrDefault(
                snapshot.leftWidth,
                initialLayout.leftWidth,
            ),
            preferredDrawer: normalizePreferredDrawer(
                snapshot.preferredDrawer,
            ),
            rightCollapsed: snapshot.rightCollapsed === true,
            rightInspectorView: normalizeInspectorView(
                snapshot.rightInspectorView,
            ),
            rightWidth: finiteOrDefault(
                snapshot.rightWidth,
                initialLayout.rightWidth,
            ),
            version: 3,
        };
    }

    return {
        activeSurface: normalizeActiveSurface(snapshot?.activeSurface),
        expandedProjectIds: [],
        leftCollapsed: false,
        leftWidth: initialLayout.leftWidth,
        preferredDrawer: null,
        // The legacy panel becomes the inspector; navigator preferences start
        // from their own defaults instead of inheriting unrelated UI state.
        rightCollapsed: snapshot?.leftCollapsed === true,
        rightInspectorView: normalizeInspectorView(snapshot?.sidebarView),
        rightWidth: finiteOrDefault(
            snapshot?.leftWidth,
            initialLayout.rightWidth,
        ),
        version: 3,
    };
}

export function createPersistedShellState(
    state: Pick<
        ShellStore,
        | "activeSurface"
        | "expandedProjectIds"
        | "leftCollapsed"
        | "leftWidth"
        | "preferredDrawer"
        | "rightCollapsed"
        | "rightInspectorView"
        | "rightWidth"
    >,
): PersistedShellStateV3 {
    return {
        activeSurface: state.activeSurface,
        expandedProjectIds: state.expandedProjectIds,
        leftCollapsed: state.leftCollapsed,
        leftWidth: state.leftWidth,
        preferredDrawer: state.preferredDrawer,
        rightCollapsed: state.rightCollapsed,
        rightInspectorView: state.rightInspectorView,
        rightWidth: state.rightWidth,
        version: 3,
    };
}

const initialPreferences = {
    leftCollapsed: false,
    preferredDrawer: null,
    rightCollapsed: false,
};

export const useShellStore = create<ShellStore>((set) => ({
    activeSurface: "workspace",
    drawerChangedLocally: false,
    expandedProjectIds: [],
    isResizingPanel: false,
    leftCollapsed: initialPreferences.leftCollapsed,
    leftCollapsedChangedLocally: false,
    leftWidth: initialLayout.leftWidth,
    preferredDrawer: initialPreferences.preferredDrawer,
    responsive: resolveShellResponsiveLayout(
        initialLayout,
        initialPreferences,
        INITIAL_VIEWPORT_WIDTH,
    ),
    rightCollapsed: initialPreferences.rightCollapsed,
    rightCollapsedChangedLocally: false,
    rightInspectorView: "files",
    rightWidth: initialLayout.rightWidth,
    viewportWidth: INITIAL_VIEWPORT_WIDTH,
    focusSurface: (surface) => set({ activeSurface: surface }),
    hydrate: (snapshot) => {
        if (!snapshot) {
            return;
        }

        const migrated = migratePersistedShellState(snapshot);
        set((state) =>
            withResponsiveState({
                ...state,
                activeSurface: migrated.activeSurface,
                expandedProjectIds: migrated.expandedProjectIds,
                leftCollapsed: state.leftCollapsedChangedLocally
                    ? state.leftCollapsed
                    : migrated.leftCollapsed,
                preferredDrawer: state.drawerChangedLocally
                    ? state.preferredDrawer
                    : migrated.preferredDrawer,
                rightCollapsed: state.rightCollapsedChangedLocally
                    ? state.rightCollapsed
                    : migrated.rightCollapsed,
                rightInspectorView: migrated.rightInspectorView,
                ...normalizeShellLayout(
                    {
                        leftWidth: migrated.leftWidth,
                        rightWidth: migrated.rightWidth,
                    },
                    Number.POSITIVE_INFINITY,
                ),
            }),
        );
    },
    nudgePanel: (side, delta) =>
        set((state) =>
            withResponsiveState({
                ...state,
                ...nudgeShellPanel(
                    getEffectiveDimensions(state),
                    side,
                    delta,
                    state.viewportWidth,
                ),
            }),
        ),
    resizePanel: (side, nextWidth) =>
        set((state) =>
            withResponsiveState({
                ...state,
                ...resizeShellPanel(
                    getEffectiveDimensions(state),
                    side,
                    nextWidth,
                    state.viewportWidth,
                ),
            }),
        ),
    setLeftCollapsed: (collapsed) => {
        setPanelEffectiveCollapsed(set, "left", collapsed);
    },
    setProjectExpanded: (projectId, expanded) =>
        set((state) => ({
            expandedProjectIds: expanded
                ? state.expandedProjectIds.includes(projectId)
                    ? state.expandedProjectIds
                    : [...state.expandedProjectIds, projectId]
                : state.expandedProjectIds.filter(
                      (candidate) => candidate !== projectId,
                  ),
        })),
    setPanelCollapsed: (side, collapsed) => {
        setPanelEffectiveCollapsed(set, side, collapsed);
    },
    setPreferredDrawer: (side) =>
        set((state) =>
            withResponsiveState({
                ...state,
                drawerChangedLocally: true,
                preferredDrawer: side,
            }),
        ),
    setResizingPanel: (resizing) => set({ isResizingPanel: resizing }),
    setRightCollapsed: (collapsed) => {
        setPanelEffectiveCollapsed(set, "right", collapsed);
    },
    setRightInspectorView: (view) => set({ rightInspectorView: view }),
    syncViewport: (viewportWidth) =>
        set((state) =>
            withResponsiveState({
                ...state,
                viewportWidth,
            }),
        ),
    toggleLeftCollapsed: () => {
        togglePanel(set, "left");
    },
    togglePanel: (side) => {
        togglePanel(set, side);
    },
    toggleRightCollapsed: () => {
        togglePanel(set, "right");
    },
    toggleSidebarView: () =>
        set((state) => ({
            rightInspectorView:
                state.rightInspectorView === "files" ? "git" : "files",
        })),
}));

function setPanelEffectiveCollapsed(
    set: (
        update: (state: ShellStore) => ShellStore,
    ) => void,
    side: ShellPanelSide,
    collapsed: boolean,
): void {
    set((state) => {
        const usesDrawer =
            state.responsive.mode === "narrow" ||
            (state.responsive.mode === "medium" && side === "right");
        if (usesDrawer) {
            return withResponsiveState({
                ...state,
                drawerChangedLocally: true,
                preferredDrawer: collapsed
                    ? state.preferredDrawer === side
                        ? null
                        : state.preferredDrawer
                    : side,
            });
        }
        return withResponsiveState({
            ...state,
            ...(side === "left"
                ? {
                      leftCollapsed: collapsed,
                      leftCollapsedChangedLocally: true,
                  }
                : {
                      rightCollapsed: collapsed,
                      rightCollapsedChangedLocally: true,
                  }),
        });
    });
}

function togglePanel(
    set: (
        update: (state: ShellStore) => ShellStore,
    ) => void,
    side: ShellPanelSide,
): void {
    set((state) => {
        const usesDrawer =
            state.responsive.mode === "narrow" ||
            (state.responsive.mode === "medium" && side === "right");
        if (usesDrawer) {
            return withResponsiveState({
                ...state,
                drawerChangedLocally: true,
                preferredDrawer:
                    state.preferredDrawer === side ? null : side,
            });
        }
        return withResponsiveState({
            ...state,
            ...(side === "left"
                ? {
                      leftCollapsed: !state.leftCollapsed,
                      leftCollapsedChangedLocally: true,
                  }
                : {
                      rightCollapsed: !state.rightCollapsed,
                      rightCollapsedChangedLocally: true,
                  }),
        });
    });
}

function withResponsiveState(state: ShellStore): ShellStore {
    return {
        ...state,
        responsive: resolveShellResponsiveLayout(
            state,
            state,
            state.viewportWidth,
        ),
    };
}

function getEffectiveDimensions(state: ShellStore): ShellLayoutDimensions {
    return {
        leftWidth: state.responsive.left.width,
        rightWidth: state.responsive.right.width,
    };
}

function normalizeActiveSurface(surface: unknown): ShellSurface {
    if (
        surface === "navigator" ||
        surface === "inspector" ||
        surface === "composer"
    ) {
        return surface;
    }
    if (surface === "projects") {
        return "navigator";
    }
    return "workspace";
}

function normalizeExpandedProjectIds(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [
        ...new Set(
            value.filter(
                (projectId): projectId is string =>
                    typeof projectId === "string" && projectId.length > 0,
            ),
        ),
    ];
}

function normalizeInspectorView(view: unknown): WorkspaceInspectorView {
    if (
        view === "git" ||
        view === "agents" ||
        view === "issues" ||
        view === "pull_requests"
    ) {
        return view;
    }
    return "files";
}

function normalizePreferredDrawer(value: unknown): ShellPanelSide | null {
    return value === "left" || value === "right" ? value : null;
}

function finiteOrDefault(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}
