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
    readonly viewportWidth: number;
    focusSurface: (surface: ShellSurface) => void;
    hydrate: (snapshot: PersistedShellState | null) => void;
    resizePanel: (side: ShellPanelSide, nextWidth: number) => void;
    nudgePanel: (side: ShellPanelSide, delta: number) => void;
    syncViewport: (viewportWidth: number) => void;
}

export const useShellStore = create<ShellStore>((set) => ({
    activeSurface: "workspace",
    leftWidth: initialLayout.leftWidth,
    rightWidth: initialLayout.rightWidth,
    viewportWidth: 1440,
    focusSurface: (surface) => set({ activeSurface: surface }),
    hydrate: (snapshot) => {
        if (!snapshot) {
            return;
        }

        set((state) => ({
            activeSurface: snapshot.activeSurface as ShellSurface,
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
    syncViewport: (viewportWidth) =>
        set((state) => ({
            viewportWidth,
            ...normalizeShellLayout(state, viewportWidth),
        })),
}));
