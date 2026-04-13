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
};
export function createDefaultShellLayout() {
    return {
        leftWidth: shellLayoutConstraints.defaultLeftWidth,
        rightWidth: shellLayoutConstraints.defaultRightWidth,
    };
}
export function normalizeShellLayout(layout, viewportWidth) {
    const leftWidth = clamp(layout.leftWidth, shellLayoutConstraints.minLeftWidth, getLeftMaxWidth(viewportWidth, layout.rightWidth));
    const rightWidth = clamp(layout.rightWidth, shellLayoutConstraints.minRightWidth, getRightMaxWidth(viewportWidth, leftWidth));
    return {
        leftWidth,
        rightWidth,
    };
}
export function resizeShellPanel(layout, side, nextWidth, viewportWidth) {
    if (side === "left") {
        return normalizeShellLayout({
            leftWidth: nextWidth,
            rightWidth: layout.rightWidth,
        }, viewportWidth);
    }
    return normalizeShellLayout({
        leftWidth: layout.leftWidth,
        rightWidth: nextWidth,
    }, viewportWidth);
}
export function nudgeShellPanel(layout, side, delta, viewportWidth) {
    const currentWidth = side === "left" ? layout.leftWidth : layout.rightWidth;
    return resizeShellPanel(layout, side, currentWidth + delta, viewportWidth);
}
function getLeftMaxWidth(viewportWidth, rightWidth) {
    return Math.max(shellLayoutConstraints.minLeftWidth, Math.min(shellLayoutConstraints.maxLeftWidth, viewportWidth -
        shellLayoutConstraints.framePadding -
        shellLayoutConstraints.handleWidth * 2 -
        rightWidth -
        shellLayoutConstraints.minCenterWidth));
}
function getRightMaxWidth(viewportWidth, leftWidth) {
    return Math.max(shellLayoutConstraints.minRightWidth, Math.min(shellLayoutConstraints.maxRightWidth, viewportWidth -
        shellLayoutConstraints.framePadding -
        shellLayoutConstraints.handleWidth * 2 -
        leftWidth -
        shellLayoutConstraints.minCenterWidth));
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
