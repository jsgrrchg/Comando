import type Database from "better-sqlite3";
import type { PersistenceSnapshot, PersistedWindowState } from "@shared/ipc";
export declare class PersistenceService {
    #private;
    constructor(connection: Database.Database);
    loadSnapshot(): PersistenceSnapshot;
    loadWindowState(windowId?: string): PersistedWindowState | null;
    saveActiveProjectId(projectId: string | null): void;
    saveWindowState(state: PersistedWindowState): void;
}
