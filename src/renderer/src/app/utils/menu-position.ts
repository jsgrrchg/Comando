export const CHAT_COMPOSER_PICKER_MIN_WIDTH = 300;
export const CHAT_COMPOSER_PICKER_MAX_WIDTH = 420;
export const CHAT_COMPOSER_PICKER_MAX_HEIGHT = 360;

export function getViewportSafeMenuPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    padding = 8,
) {
    const maxX = Math.max(padding, window.innerWidth - width - padding);
    const maxY = Math.max(padding, window.innerHeight - height - padding);

    return {
        x: Math.min(Math.max(padding, x), maxX),
        y: Math.min(Math.max(padding, y), maxY),
    };
}

export interface MenuAnchorRect {
    readonly left: number;
    readonly right: number;
    readonly top: number;
}

export function getViewportSafeSubmenuPosition(
    anchorRect: MenuAnchorRect,
    width: number,
    height: number,
    padding = 8,
    gap = 4,
) {
    const viewportRight = window.innerWidth - padding;
    const rightX = anchorRect.right + gap;
    const leftX = anchorRect.left - width - gap;
    const fitsRight = rightX + width <= viewportRight;
    const fitsLeft = leftX >= padding;
    const rightOverflow = Math.max(0, rightX + width - viewportRight);
    const leftOverflow = Math.max(0, padding - leftX);
    const preferredX = fitsRight
        ? rightX
        : fitsLeft
          ? leftX
          : leftOverflow < rightOverflow
            ? leftX
            : rightX;

    return getViewportSafeMenuPosition(
        preferredX,
        anchorRect.top,
        width,
        height,
        padding,
    );
}
