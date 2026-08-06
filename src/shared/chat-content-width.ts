export const CHAT_CONTENT_WIDTH_DEFAULT = 600;
export const CHAT_CONTENT_WIDTH_MIN = 480;
export const CHAT_CONTENT_WIDTH_MAX = 1_200;
export const CHAT_CONTENT_WIDTH_STEP = 20;

export function clampChatContentWidth(width: number): number {
    if (!Number.isFinite(width)) {
        return CHAT_CONTENT_WIDTH_DEFAULT;
    }

    return Math.min(
        CHAT_CONTENT_WIDTH_MAX,
        Math.max(CHAT_CONTENT_WIDTH_MIN, Math.round(width / CHAT_CONTENT_WIDTH_STEP) * CHAT_CONTENT_WIDTH_STEP),
    );
}
