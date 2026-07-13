export const CHROME_TRANSPARENCY_DEFAULT = 45;
export const CHROME_TRANSPARENCY_MIN = 0;
export const CHROME_TRANSPARENCY_MAX = 80;

export function clampChromeTransparency(value: number): number {
    return Math.min(
        CHROME_TRANSPARENCY_MAX,
        Math.max(CHROME_TRANSPARENCY_MIN, value),
    );
}
