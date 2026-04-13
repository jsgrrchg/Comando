export type ShellPanelSide = "left" | "right";
export type ShellSurface = "projects" | "workspace" | "utility" | "composer";
export interface ShellLayoutDimensions {
    readonly leftWidth: number;
    readonly rightWidth: number;
}
export declare const shellLayoutConstraints: {
    readonly defaultLeftWidth: 252;
    readonly defaultRightWidth: 328;
    readonly framePadding: 24;
    readonly handleWidth: 1;
    readonly minCenterWidth: 520;
    readonly minLeftWidth: 224;
    readonly maxLeftWidth: 340;
    readonly minRightWidth: 280;
    readonly maxRightWidth: 420;
    readonly keyboardStep: 24;
};
export declare function createDefaultShellLayout(): ShellLayoutDimensions;
export declare function normalizeShellLayout(layout: ShellLayoutDimensions, viewportWidth: number): ShellLayoutDimensions;
export declare function resizeShellPanel(layout: ShellLayoutDimensions, side: ShellPanelSide, nextWidth: number, viewportWidth: number): ShellLayoutDimensions;
export declare function nudgeShellPanel(layout: ShellLayoutDimensions, side: ShellPanelSide, delta: number, viewportWidth: number): ShellLayoutDimensions;
