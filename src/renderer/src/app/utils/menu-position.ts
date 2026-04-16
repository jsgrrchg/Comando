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
