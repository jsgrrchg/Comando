import type Database from "better-sqlite3";
import type { AiSessionSnapshot } from "@shared/ipc";
export declare class AiPersistence {
    #private;
    constructor(connection: Database.Database);
    loadSessionSnapshot(sessionId: string): AiSessionSnapshot | null;
    saveSessionSnapshot(snapshot: AiSessionSnapshot, draft?: string): void;
}
export declare function createEmptyAiSessionSnapshot(options: {
    readonly projectId: string | null;
    readonly runtimeId: AiSessionSnapshot["runtimeId"];
    readonly runtimeSessionId?: string | null;
    readonly sessionId: string;
    readonly status?: AiSessionSnapshot["status"];
    readonly title: string;
    readonly updatedAt?: string;
}): AiSessionSnapshot;
