export type ShellPanelSide = "left" | "right";

export type ShellSurface = "projects" | "workspace" | "utility" | "composer";

export interface ShellLayoutDimensions {
    readonly leftWidth: number;
    readonly rightWidth: number;
}

export const shellLayoutConstraints = {
    defaultLeftWidth: 252,
    defaultRightWidth: 328,
    framePadding: 24,
    handleWidth: 1,
    minCenterWidth: 520,
    minLeftWidth: 224,
    maxLeftWidth: 340,
    minRightWidth: 280,
    maxRightWidth: 420,
    keyboardStep: 24,
} as const;

export function createDefaultShellLayout(): ShellLayoutDimensions {
    return {
        leftWidth: shellLayoutConstraints.defaultLeftWidth,
        rightWidth: shellLayoutConstraints.defaultRightWidth,
    };
}

export function normalizeShellLayout(
    layout: ShellLayoutDimensions,
    viewportWidth: number,
): ShellLayoutDimensions {
    const leftWidth = clamp(
        layout.leftWidth,
        shellLayoutConstraints.minLeftWidth,
        getLeftMaxWidth(viewportWidth, layout.rightWidth),
    );

    const rightWidth = clamp(
        layout.rightWidth,
        shellLayoutConstraints.minRightWidth,
        getRightMaxWidth(viewportWidth, leftWidth),
    );

    return {
        leftWidth,
        rightWidth,
    };
}

export function resizeShellPanel(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    nextWidth: number,
    viewportWidth: number,
): ShellLayoutDimensions {
    if (side === "left") {
        return normalizeShellLayout(
            {
                leftWidth: nextWidth,
                rightWidth: layout.rightWidth,
            },
            viewportWidth,
        );
    }

    return normalizeShellLayout(
        {
            leftWidth: layout.leftWidth,
            rightWidth: nextWidth,
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
    const currentWidth = side === "left" ? layout.leftWidth : layout.rightWidth;
    return resizeShellPanel(layout, side, currentWidth + delta, viewportWidth);
}

function getLeftMaxWidth(viewportWidth: number, rightWidth: number): number {
    return Math.max(
        shellLayoutConstraints.minLeftWidth,
        Math.min(
            shellLayoutConstraints.maxLeftWidth,
            viewportWidth -
                shellLayoutConstraints.framePadding -
                shellLayoutConstraints.handleWidth * 2 -
                rightWidth -
                shellLayoutConstraints.minCenterWidth,
        ),
    );
}

function getRightMaxWidth(viewportWidth: number, leftWidth: number): number {
    return Math.max(
        shellLayoutConstraints.minRightWidth,
        Math.min(
            shellLayoutConstraints.maxRightWidth,
            viewportWidth -
                shellLayoutConstraints.framePadding -
                shellLayoutConstraints.handleWidth * 2 -
                leftWidth -
                shellLayoutConstraints.minCenterWidth,
        ),
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
