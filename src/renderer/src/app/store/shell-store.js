import { create } from "zustand";
import { createDefaultShellLayout, normalizeShellLayout, nudgeShellPanel, resizeShellPanel, } from "../layout/shell-layout";
const initialLayout = createDefaultShellLayout();
export const useShellStore = create((set) => ({
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
            activeSurface: snapshot.activeSurface,
            viewportWidth: state.viewportWidth,
            ...normalizeShellLayout(snapshot, state.viewportWidth),
        }));
    },
    resizePanel: (side, nextWidth) => set((state) => resizeShellPanel(state, side, nextWidth, state.viewportWidth)),
    nudgePanel: (side, delta) => set((state) => nudgeShellPanel(state, side, delta, state.viewportWidth)),
    syncViewport: (viewportWidth) => set((state) => ({
        viewportWidth,
        ...normalizeShellLayout(state, viewportWidth),
    })),
}));
