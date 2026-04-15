export const LANE_WIDTH = 16;
export const LEFT_PADDING = 12;
export const COMMIT_RADIUS = 3.5;
export const COMMIT_STROKE = 1.5;
export const LINE_WIDTH = 1.5;

export function laneX(column: number): number {
    return LEFT_PADDING + column * LANE_WIDTH + LANE_WIDTH / 2;
}

export function computeGraphWidth(maxLanes: number): number {
    return LEFT_PADDING * 2 + Math.max(maxLanes, 6) * LANE_WIDTH;
}

export function buildCheckoutPath(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
): string {
    if (fromX === toX) {
        return `M ${fromX} ${fromY} L ${toX} ${toY}`;
    }

    const availableWidth = Math.abs(toX - fromX);
    const availableHeight = Math.abs(toY - fromY);
    const curveWidth = Math.min(LANE_WIDTH / 3, availableWidth);
    const curveHeight = Math.min(LANE_WIDTH / 3, availableHeight);

    const goingRight = toX > fromX;
    const signedCurveWidth = goingRight ? curveWidth : -curveWidth;

    const curveStartY = toY - curveHeight;
    const curveEndX = fromX + signedCurveWidth;

    return [
        `M ${fromX} ${fromY}`,
        `L ${fromX} ${curveStartY}`,
        `Q ${fromX} ${toY} ${curveEndX} ${toY}`,
        `L ${toX} ${toY}`,
    ].join(" ");
}

export function buildMergePath(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
): string {
    if (fromX === toX) {
        return `M ${fromX} ${fromY} L ${toX} ${toY}`;
    }

    const goingRight = toX > fromX;
    const columnShift = goingRight
        ? COMMIT_RADIUS + COMMIT_STROKE
        : -(COMMIT_RADIUS + COMMIT_STROKE);

    const mergeStartX = fromX + columnShift;
    const mergeStartY = fromY - COMMIT_RADIUS;

    const availableWidth = Math.abs(toX - mergeStartX);
    const availableHeight = Math.abs(toY - mergeStartY);
    const curveWidth = Math.min(LANE_WIDTH / 3, availableWidth);
    const curveHeight = Math.min(LANE_WIDTH / 3, availableHeight);

    const signedCurveWidth = goingRight ? curveWidth : -curveWidth;
    const curveStartX = toX - signedCurveWidth;
    const curveEndY = mergeStartY + curveHeight;

    return [
        `M ${mergeStartX} ${mergeStartY}`,
        `L ${curveStartX} ${mergeStartY}`,
        `Q ${toX} ${mergeStartY} ${toX} ${curveEndY}`,
        `L ${toX} ${toY}`,
    ].join(" ");
}
