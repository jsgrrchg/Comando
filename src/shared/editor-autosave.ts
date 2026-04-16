export const EDITOR_AUTOSAVE_DELAY_MS_DEFAULT = 900;
export const EDITOR_AUTOSAVE_DELAY_MS_MIN = 100;
export const EDITOR_AUTOSAVE_DELAY_MS_MAX = 5000;

export function clampEditorAutosaveDelayMs(value: number): number {
    if (!Number.isFinite(value)) {
        return EDITOR_AUTOSAVE_DELAY_MS_DEFAULT;
    }

    return Math.min(
        EDITOR_AUTOSAVE_DELAY_MS_MAX,
        Math.max(
            EDITOR_AUTOSAVE_DELAY_MS_MIN,
            Math.round(value),
        ),
    );
}
