import type { PersistedShellState } from "@shared/ipc";
import { type ShellLayoutDimensions, type ShellPanelSide, type ShellSurface } from "../layout/shell-layout";
interface ShellStore extends ShellLayoutDimensions {
    readonly activeSurface: ShellSurface;
    readonly viewportWidth: number;
    focusSurface: (surface: ShellSurface) => void;
    hydrate: (snapshot: PersistedShellState | null) => void;
    resizePanel: (side: ShellPanelSide, nextWidth: number) => void;
    nudgePanel: (side: ShellPanelSide, delta: number) => void;
    syncViewport: (viewportWidth: number) => void;
}
export declare const useShellStore: import("zustand").UseBoundStore<import("zustand").StoreApi<ShellStore>>;
export {};
