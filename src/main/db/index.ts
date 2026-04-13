import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { DatabaseStatus } from "@shared/ipc";

import { databaseMigrations } from "./migrations";

export interface DatabaseManager {
    readonly connection: Database.Database;
    readonly status: DatabaseStatus;
    close: () => void;
}

export interface BootstrapDatabaseOptions {
    readonly dataDir: string;
    readonly fileName?: string;
}

export function bootstrapDatabase(
    options: BootstrapDatabaseOptions,
): DatabaseManager {
    fs.mkdirSync(options.dataDir, { recursive: true });

    const databaseFile = path.join(
        options.dataDir,
        options.fileName ?? "comando.sqlite3",
    );
    const connection = new Database(databaseFile);

    connection.pragma("journal_mode = WAL");
    connection.pragma("foreign_keys = ON");
    connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

    applyPendingMigrations(connection);

    const status: DatabaseStatus = {
        databaseFile,
        appliedMigrations: connection
            .prepare<[], { id: string }>(
                "SELECT id FROM schema_migrations ORDER BY id",
            )
            .all()
            .map((row) => row.id),
    };

    return {
        connection,
        status,
        close: () => connection.close(),
    };
}

function applyPendingMigrations(connection: Database.Database): void {
    const appliedMigrationIds = new Set(
        connection
            .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
            .all()
            .map((row) => row.id),
    );

    const insertMigration = connection.prepare<[string, string]>(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    );

    const applyMigrationBatch = connection.transaction(
        (pendingMigrations: typeof databaseMigrations) => {
            for (const migration of pendingMigrations) {
                connection.exec(migration.sql);
                insertMigration.run(migration.id, new Date().toISOString());
            }
        },
    );

    const pendingMigrations = databaseMigrations.filter(
        (migration) => !appliedMigrationIds.has(migration.id),
    );

    if (pendingMigrations.length > 0) {
        applyMigrationBatch(pendingMigrations);
    }
}
