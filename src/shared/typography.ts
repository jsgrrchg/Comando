export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 24;
export const DEFAULT_EDITOR_FONT_SIZE = 14;

export const AI_CHAT_FONT_SIZE_MIN = 12;
export const AI_CHAT_FONT_SIZE_MAX = 28;
export const DEFAULT_AI_CHAT_FONT_SIZE = 14;

export const AI_COMPOSER_FONT_SIZE_MIN = 11;
export const AI_COMPOSER_FONT_SIZE_MAX = 20;
export const DEFAULT_AI_COMPOSER_FONT_SIZE = 14;

export function clampRoundedInt(
    value: number,
    min: number,
    max: number,
): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}
