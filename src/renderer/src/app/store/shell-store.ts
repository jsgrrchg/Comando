import { create } from "zustand";

import type { PersistedShellState } from "@shared/ipc";

import {
    createDefaultShellLayout,
    normalizeShellLayout,
    nudgeShellPanel,
    resizeShellPanel,
    type ShellLayoutDimensions,
    type ShellPanelSide,
    type ShellSurface,
} from "../layout/shell-layout";

const initialLayout = createDefaultShellLayout();

type SidebarView = "files" | "git" | "agents" | "issues" | "pull_requests";

interface ShellStore extends ShellLayoutDimensions {
    readonly activeSurface: ShellSurface;
    readonly leftCollapsed: boolean;
    readonly sidebarView: SidebarView;
    readonly viewportWidth: number;
    focusSurface: (surface: ShellSurface) => void;
    hydrate: (snapshot: PersistedShellState | null) => void;
    resizePanel: (side: ShellPanelSide, nextWidth: number) => void;
    nudgePanel: (side: ShellPanelSide, delta: number) => void;
    setLeftCollapsed: (collapsed: boolean) => void;
    setSidebarView: (view: SidebarView) => void;
    toggleLeftCollapsed: () => void;
    toggleSidebarView: () => void;
    syncViewport: (viewportWidth: number) => void;
}

type LegacyShellSnapshot = PersistedShellState & {
    readonly activeSurface?: string | null;
    readonly sidebarView?: string | null;
};

function normalizeActiveSurface(
    surface: LegacyShellSnapshot["activeSurface"],
): ShellSurface {
    return surface === "projects" ? "projects" : "workspace";
}

function normalizeSidebarView(
    view: LegacyShellSnapshot["sidebarView"],
): SidebarView {
    if (view === "git") {
        return "git";
    }
    if (view === "agents") {
        return "agents";
    }
    if (view === "issues") {
        return "issues";
    }
    if (view === "pull_requests") {
        return "pull_requests";
    }
    return "files";
}

export const useShellStore = create<ShellStore>((set) => ({
    activeSurface: "workspace",
    leftCollapsed: false,
    leftWidth: initialLayout.leftWidth,
    sidebarView: "files",
    viewportWidth: 1440,
    focusSurface: (surface) => set({ activeSurface: surface }),
    hydrate: (snapshot) => {
        if (!snapshot) {
            return;
        }

        const legacySnapshot = snapshot as LegacyShellSnapshot;

        set((state) => ({
            activeSurface: normalizeActiveSurface(legacySnapshot.activeSurface),
            leftCollapsed: legacySnapshot.leftCollapsed ?? false,
            sidebarView: normalizeSidebarView(legacySnapshot.sidebarView),
            viewportWidth: state.viewportWidth,
            ...normalizeShellLayout(
                {
                    leftWidth: legacySnapshot.leftWidth,
                },
                state.viewportWidth,
            ),
        }));
    },
    resizePanel: (side, nextWidth) =>
        set((state) =>
            resizeShellPanel(state, side, nextWidth, state.viewportWidth),
        ),
    nudgePanel: (side, delta) =>
        set((state) =>
            nudgeShellPanel(state, side, delta, state.viewportWidth),
        ),
    setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
    setSidebarView: (view) => set({ sidebarView: view }),
    toggleLeftCollapsed: () =>
        set((state) => ({ leftCollapsed: !state.leftCollapsed })),
    toggleSidebarView: () =>
        set((state) => ({
            sidebarView: state.sidebarView === "files" ? "git" : "files",
        })),
    syncViewport: (viewportWidth) =>
        set((state) => ({
            viewportWidth,
            ...normalizeShellLayout(state, viewportWidth),
        })),
}));
