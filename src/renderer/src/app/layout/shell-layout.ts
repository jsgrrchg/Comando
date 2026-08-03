export type ShellPanelSide = "left" | "right";

export type ShellSurface =
    | "navigator"
    | "workspace"
    | "inspector"
    | "composer";

export type ShellResponsiveMode = "wide" | "medium" | "narrow";

export interface ShellLayoutDimensions {
    readonly leftWidth: number;
    readonly rightWidth: number;
}

export interface ShellCollapsePreferences {
    readonly leftCollapsed: boolean;
    readonly preferredDrawer: ShellPanelSide | null;
    readonly rightCollapsed: boolean;
}

export interface ShellResponsivePanel {
    readonly collapsed: boolean;
    readonly overlay: boolean;
    readonly width: number;
}

export interface ShellResponsiveLayout {
    readonly left: ShellResponsivePanel;
    readonly mode: ShellResponsiveMode;
    readonly right: ShellResponsivePanel;
}

export interface ShellPanelWidthRange {
    readonly max: number;
    readonly min: number;
}

export interface ShellSurfaceInsets {
    readonly left: number;
    readonly right: number;
    readonly top: number;
}

export const shellLayoutConstraints = {
    defaultLeftWidth: 280,
    defaultRightWidth: 340,
    handleWidth: 1,
    keyboardStep: 24,
    maxLeftWidth: 420,
    maxRightWidth: 500,
    mediumMinViewportWidth: 840,
    minCenterWidth: 520,
    minLeftWidth: 220,
    minRightWidth: 300,
    wideMinViewportWidth: 1_200,
} as const;

export function createDefaultShellLayout(): ShellLayoutDimensions {
    return {
        leftWidth: shellLayoutConstraints.defaultLeftWidth,
        rightWidth: shellLayoutConstraints.defaultRightWidth,
    };
}

export function getShellResponsiveMode(
    viewportWidth: number,
): ShellResponsiveMode {
    if (viewportWidth >= shellLayoutConstraints.wideMinViewportWidth) {
        return "wide";
    }
    if (viewportWidth >= shellLayoutConstraints.mediumMinViewportWidth) {
        return "medium";
    }
    return "narrow";
}

export function normalizeShellLayout(
    layout: ShellLayoutDimensions,
    viewportWidth: number,
    prioritySide?: ShellPanelSide,
): ShellLayoutDimensions {
    const mode = getShellResponsiveMode(viewportWidth);
    let leftWidth = clampFinite(
        layout.leftWidth,
        shellLayoutConstraints.defaultLeftWidth,
        shellLayoutConstraints.minLeftWidth,
        shellLayoutConstraints.maxLeftWidth,
    );
    let rightWidth = clampFinite(
        layout.rightWidth,
        shellLayoutConstraints.defaultRightWidth,
        shellLayoutConstraints.minRightWidth,
        shellLayoutConstraints.maxRightWidth,
    );

    if (mode === "medium") {
        leftWidth = Math.min(
            leftWidth,
            Math.max(
                shellLayoutConstraints.minLeftWidth,
                viewportWidth -
                    shellLayoutConstraints.handleWidth -
                    shellLayoutConstraints.minCenterWidth,
            ),
        );
    }

    if (mode === "wide") {
        const panelBudget = Math.max(
            shellLayoutConstraints.minLeftWidth +
                shellLayoutConstraints.minRightWidth,
            viewportWidth -
                shellLayoutConstraints.minCenterWidth -
                shellLayoutConstraints.handleWidth * 2,
        );
        const overflow = leftWidth + rightWidth - panelBudget;
        if (overflow > 0) {
            const fitted = shrinkPanelWidths(
                { leftWidth, rightWidth },
                overflow,
                prioritySide,
            );
            leftWidth = fitted.leftWidth;
            rightWidth = fitted.rightWidth;
        }
    }

    return { leftWidth, rightWidth };
}

export function resizeShellPanel(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    nextWidth: number,
    viewportWidth: number,
): ShellLayoutDimensions {
    return normalizeShellLayout(
        {
            leftWidth: side === "left" ? nextWidth : layout.leftWidth,
            rightWidth: side === "right" ? nextWidth : layout.rightWidth,
        },
        viewportWidth,
        side,
    );
}

export function nudgeShellPanel(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    delta: number,
    viewportWidth: number,
): ShellLayoutDimensions {
    const currentWidth = side === "left" ? layout.leftWidth : layout.rightWidth;
    return resizeShellPanel(
        layout,
        side,
        currentWidth + delta,
        viewportWidth,
    );
}

export function resolveShellResponsiveLayout(
    layout: ShellLayoutDimensions,
    preferences: ShellCollapsePreferences,
    viewportWidth: number,
): ShellResponsiveLayout {
    const normalized = normalizeShellLayout(layout, viewportWidth);
    const mode = getShellResponsiveMode(viewportWidth);

    if (mode === "wide") {
        return {
            left: {
                collapsed: preferences.leftCollapsed,
                overlay: false,
                width: normalized.leftWidth,
            },
            mode,
            right: {
                collapsed: preferences.rightCollapsed,
                overlay: false,
                width: normalized.rightWidth,
            },
        };
    }

    if (mode === "medium") {
        return {
            left: {
                collapsed: preferences.leftCollapsed,
                overlay: false,
                width: normalized.leftWidth,
            },
            mode,
            right: {
                collapsed: preferences.preferredDrawer !== "right",
                overlay: true,
                width: normalized.rightWidth,
            },
        };
    }

    return {
        left: {
            collapsed: preferences.preferredDrawer !== "left",
            overlay: true,
            width: normalized.leftWidth,
        },
        mode,
        right: {
            collapsed: preferences.preferredDrawer !== "right",
            overlay: true,
            width: normalized.rightWidth,
        },
    };
}

export function getShellGridTemplateColumns(
    responsive: ShellResponsiveLayout,
): string {
    const leftWidth = getPersistentPanelWidth(responsive.left);
    const rightWidth = getPersistentPanelWidth(responsive.right);
    const leftHandle = leftWidth > 0 ? shellLayoutConstraints.handleWidth : 0;
    const rightHandle = rightWidth > 0 ? shellLayoutConstraints.handleWidth : 0;
    return `${leftWidth}px ${leftHandle}px minmax(0, 1fr) ${rightHandle}px ${rightWidth}px`;
}

export function getOpenShellDrawerSide(
    responsive: ShellResponsiveLayout,
): ShellPanelSide | null {
    if (responsive.left.overlay && !responsive.left.collapsed) {
        return "left";
    }
    if (responsive.right.overlay && !responsive.right.collapsed) {
        return "right";
    }
    return null;
}

export function shouldHideWorkspaceSurfaceForHostOverlay(input: {
    readonly responsive: ShellResponsiveLayout;
    readonly settingsOpen: boolean;
    readonly workspaceSwitcherOpen: boolean;
}): boolean {
    return (
        input.settingsOpen ||
        input.workspaceSwitcherOpen ||
        getOpenShellDrawerSide(input.responsive) !== null
    );
}

export function getShellSurfaceSideInsets(
    responsive: ShellResponsiveLayout,
): { readonly left: number; readonly right: number } {
    const leftWidth = getPersistentPanelWidth(responsive.left);
    const rightWidth = getPersistentPanelWidth(responsive.right);
    return {
        left:
            leftWidth > 0
                ? leftWidth + shellLayoutConstraints.handleWidth
                : 0,
        right:
            rightWidth > 0
                ? rightWidth + shellLayoutConstraints.handleWidth
                : 0,
    };
}

export function scaleShellSurfaceInsets(
    insets: ShellSurfaceInsets,
    zoomFactor: number,
): ShellSurfaceInsets {
    const scale = Number.isFinite(zoomFactor) ? Math.max(0.5, zoomFactor) : 1;
    return {
        left: insets.left * scale,
        right: insets.right * scale,
        top: insets.top * scale,
    };
}

export function getShellPanelWidthRange(
    layout: ShellLayoutDimensions,
    side: ShellPanelSide,
    viewportWidth: number,
): ShellPanelWidthRange {
    const mode = getShellResponsiveMode(viewportWidth);
    const min =
        side === "left"
            ? shellLayoutConstraints.minLeftWidth
            : shellLayoutConstraints.minRightWidth;
    const absoluteMax =
        side === "left"
            ? shellLayoutConstraints.maxLeftWidth
            : shellLayoutConstraints.maxRightWidth;
    if (mode !== "wide") {
        if (mode === "medium" && side === "left") {
            return {
                min,
                max: Math.max(
                    min,
                    Math.min(
                        absoluteMax,
                        viewportWidth -
                            shellLayoutConstraints.handleWidth -
                            shellLayoutConstraints.minCenterWidth,
                    ),
                ),
            };
        }
        return { min, max: absoluteMax };
    }

    const oppositeWidth =
        side === "left"
            ? clamp(
                  layout.rightWidth,
                  shellLayoutConstraints.minRightWidth,
                  shellLayoutConstraints.maxRightWidth,
              )
            : clamp(
                  layout.leftWidth,
                  shellLayoutConstraints.minLeftWidth,
                  shellLayoutConstraints.maxLeftWidth,
              );
    return {
        min,
        max: Math.max(
            min,
            Math.min(
                absoluteMax,
                viewportWidth -
                    shellLayoutConstraints.minCenterWidth -
                    shellLayoutConstraints.handleWidth * 2 -
                    oppositeWidth,
            ),
        ),
    };
}

function shrinkPanelWidths(
    layout: ShellLayoutDimensions,
    overflow: number,
    prioritySide?: ShellPanelSide,
): ShellLayoutDimensions {
    let { leftWidth, rightWidth } = layout;
    let remaining = overflow;
    const shrink = (side: ShellPanelSide) => {
        const width = side === "left" ? leftWidth : rightWidth;
        const min =
            side === "left"
                ? shellLayoutConstraints.minLeftWidth
                : shellLayoutConstraints.minRightWidth;
        const reduction = Math.min(remaining, Math.max(0, width - min));
        if (side === "left") {
            leftWidth -= reduction;
        } else {
            rightWidth -= reduction;
        }
        remaining -= reduction;
    };

    // Preserve the panel under direct manipulation before reclaiming space
    // from it, so pointer and keyboard resize remain predictable.
    if (prioritySide === "left") {
        shrink("right");
        shrink("left");
    } else {
        shrink("left");
        shrink("right");
    }

    return { leftWidth, rightWidth };
}

function getPersistentPanelWidth(panel: ShellResponsivePanel): number {
    return panel.collapsed || panel.overlay ? 0 : panel.width;
}

function clampFinite(
    value: number,
    fallback: number,
    min: number,
    max: number,
): number {
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
