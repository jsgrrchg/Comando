export interface EdgePeekPointerPosition {
    readonly x: number;
    readonly y: number;
}

export interface EdgePeekRect {
    readonly bottom: number;
    readonly height: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly width: number;
}

export const edgePeekConfig = {
    hotspotWidth: 8,
    safeGap: 28,
} as const;

export function isPointInsideInflatedRect(
    point: EdgePeekPointerPosition | null,
    rect: EdgePeekRect | null,
    gap: number,
): boolean {
    if (!point || !rect) {
        return false;
    }

    if (rect.width <= 0 && rect.height <= 0) {
        return false;
    }

    return (
        point.x >= rect.left - gap &&
        point.x <= rect.right + gap &&
        point.y >= rect.top - gap &&
        point.y <= rect.bottom + gap
    );
}
