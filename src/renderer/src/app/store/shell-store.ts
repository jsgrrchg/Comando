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

interface ShellStore extends ShellLayoutDimensions {
    readonly activeSurface: ShellSurface;
    readonly leftCollapsed: boolean;
    readonly rightCollapsed: boolean;
    readonly viewportWidth: number;
    focusSurface: (surface: ShellSurface) => void;
    hydrate: (snapshot: PersistedShellState | null) => void;
    resizePanel: (side: ShellPanelSide, nextWidth: number) => void;
    nudgePanel: (side: ShellPanelSide, delta: number) => void;
    setLeftCollapsed: (collapsed: boolean) => void;
    setRightCollapsed: (collapsed: boolean) => void;
    toggleLeftCollapsed: () => void;
    toggleRightCollapsed: () => void;
    syncViewport: (viewportWidth: number) => void;
}

export const useShellStore = create<ShellStore>((set) => ({
    activeSurface: "workspace",
    leftCollapsed: false,
    leftWidth: initialLayout.leftWidth,
    rightCollapsed: false,
    rightWidth: initialLayout.rightWidth,
    viewportWidth: 1440,
    focusSurface: (surface) => set({ activeSurface: surface }),
    hydrate: (snapshot) => {
        if (!snapshot) {
            return;
        }

        set((state) => ({
            activeSurface: snapshot.activeSurface as ShellSurface,
            leftCollapsed: snapshot.leftCollapsed ?? false,
            rightCollapsed: snapshot.rightCollapsed ?? false,
            viewportWidth: state.viewportWidth,
            ...normalizeShellLayout(snapshot, state.viewportWidth),
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
    setRightCollapsed: (collapsed) => set({ rightCollapsed: collapsed }),
    toggleLeftCollapsed: () =>
        set((state) => ({ leftCollapsed: !state.leftCollapsed })),
    toggleRightCollapsed: () =>
        set((state) => ({ rightCollapsed: !state.rightCollapsed })),
    syncViewport: (viewportWidth) =>
        set((state) => ({
            viewportWidth,
            ...normalizeShellLayout(state, viewportWidth),
        })),
}));
