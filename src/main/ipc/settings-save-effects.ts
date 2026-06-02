import type { SettingsSnapshot } from "@shared/ipc";

export interface SettingsSnapshotSaveEffects {
    readonly applyAppZoom: boolean;
    readonly broadcastSettingsUpdated: boolean;
}

export function resolveSettingsSnapshotSaveEffects(
    snapshot: SettingsSnapshot,
): SettingsSnapshotSaveEffects {
    return {
        applyAppZoom: snapshot.appearance !== undefined,
        broadcastSettingsUpdated:
            snapshot.appearance !== undefined ||
            snapshot.editor !== undefined ||
            snapshot.aiChat !== undefined ||
            snapshot.terminal !== undefined,
    };
}
