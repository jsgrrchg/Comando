export type ShellPanelSide = "left";

export type ShellSurface = "projects" | "workspace" | "composer";

export interface ShellLayoutDimensions {
    readonly leftWidth: number;
}

export const shellLayoutConstraints = {
    defaultLeftWidth: 340,
    framePadding: 24,
    handleWidth: 1,
    minCenterWidth: 520,
    minLeftWidth: 340,
    maxLeftWidth: 500,
    keyboardStep: 24,
} as const;

export function createDefaultShellLayout(): ShellLayoutDimensions {
    return {
        leftWidth: shellLayoutConstraints.defaultLeftWidth,
    };
}

export function normalizeShellLayout(
    layout: ShellLayoutDimensions,
    viewportWidth: number,
): ShellLayoutDimensions {
    return {
        leftWidth: clamp(
            layout.leftWidth,
            shellLayoutConstraints.minLeftWidth,
            getLeftMaxWidth(viewportWidth),
        ),
    };
}

export function resizeShellPanel(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    nextWidth: number,
    viewportWidth: number,
): ShellLayoutDimensions {
    void layout;
    void side;
    return normalizeShellLayout(
        {
            leftWidth: nextWidth,
        },
        viewportWidth,
    );
}

export function nudgeShellPanel(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    delta: number,
    viewportWidth: number,
): ShellLayoutDimensions {
    void side;
    const currentWidth = layout.leftWidth;
    return resizeShellPanel(layout, side, currentWidth + delta, viewportWidth);
}

function getLeftMaxWidth(viewportWidth: number): number {
    return Math.max(
        shellLayoutConstraints.minLeftWidth,
        Math.min(
            shellLayoutConstraints.maxLeftWidth,
            viewportWidth -
                shellLayoutConstraints.framePadding -
                shellLayoutConstraints.handleWidth -
                shellLayoutConstraints.minCenterWidth,
        ),
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
