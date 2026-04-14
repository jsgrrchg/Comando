export const APP_ZOOM_FACTOR_DEFAULT = 1;
export const APP_ZOOM_FACTOR_MIN = 0.75;
export const APP_ZOOM_FACTOR_MAX = 1.5;
export const APP_ZOOM_FACTOR_STEP = 0.05;

export type AppZoomDirection = "decrease" | "increase" | "reset";

export function clampAppZoomFactor(value: number): number {
    if (!Number.isFinite(value)) {
        return APP_ZOOM_FACTOR_DEFAULT;
    }

    return Math.min(
        APP_ZOOM_FACTOR_MAX,
        Math.max(APP_ZOOM_FACTOR_MIN, Math.round(value * 100) / 100),
    );
}

export function stepAppZoomFactor(
    currentValue: number,
    direction: AppZoomDirection,
): number {
    if (direction === "reset") {
        return APP_ZOOM_FACTOR_DEFAULT;
    }

    const delta =
        direction === "increase" ? APP_ZOOM_FACTOR_STEP : -APP_ZOOM_FACTOR_STEP;

    return clampAppZoomFactor(currentValue + delta);
}

export function formatAppZoomPercent(value: number): string {
    return `${Math.round(clampAppZoomFactor(value) * 100)}%`;
}
