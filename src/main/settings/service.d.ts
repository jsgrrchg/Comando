import type Database from "better-sqlite3";
import type { CodexRuntimeSettings, SettingsSnapshot } from "@shared/ipc";
export declare class SettingsService {
    #private;
    constructor(connection: Database.Database);
    loadSnapshot(): SettingsSnapshot;
    saveSnapshot(snapshot: SettingsSnapshot): void;
    loadCodexRuntimeSettings(): CodexRuntimeSettings;
    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void;
}
