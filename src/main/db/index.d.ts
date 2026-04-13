import Database from "better-sqlite3";
import type { DatabaseStatus } from "@shared/ipc";
export interface DatabaseManager {
    readonly connection: Database.Database;
    readonly status: DatabaseStatus;
    close: () => void;
}
export interface BootstrapDatabaseOptions {
    readonly dataDir: string;
    readonly fileName?: string;
}
export declare function bootstrapDatabase(options: BootstrapDatabaseOptions): DatabaseManager;
