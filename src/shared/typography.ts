export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 24;
export const DEFAULT_EDITOR_FONT_SIZE = 14;

export const EDITOR_FONT_FAMILY_IDS = [
    "system",
    "sans",
    "geist",
    "atkinson",
    "rounded",
    "humanist",
    "condensed",
    "serif",
    "literata",
    "lora",
    "merriweather",
    "source-serif",
    "reading",
    "newspaper",
    "slab",
    "mono",
    "sf-mono",
    "jetbrains",
    "jetbrains-mono",
    "geist-mono",
    "ibm-plex-mono",
    "courier",
    "andale",
    "typewriter",
    "cascadia-code",
] as const;

export type EditorFontFamily = (typeof EDITOR_FONT_FAMILY_IDS)[number];
export type ChatFontFamily = EditorFontFamily;

export const DEFAULT_EDITOR_FONT_FAMILY: EditorFontFamily = "ibm-plex-mono";
export const DEFAULT_AI_CHAT_FONT_FAMILY: ChatFontFamily = "andale";
export const DEFAULT_AI_COMPOSER_FONT_FAMILY: ChatFontFamily =
    "ibm-plex-mono";

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
