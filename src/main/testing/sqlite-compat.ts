import { DatabaseSync } from "node:sqlite";

import type Database from "better-sqlite3";

import type { DatabaseMigration } from "@main/db/migrations";

type BetterSqliteConnection = Database.Database;

interface SqliteCompatStatement {
    all: (...parameters: readonly unknown[]) => unknown;
    get: (...parameters: readonly unknown[]) => unknown;
    run: (...parameters: readonly unknown[]) => unknown;
}

interface SqliteCompatConnection {
    close: () => void;
    exec: (sql: string) => void;
    pragma: (source: string) => void;
    prepare: (sql: string) => SqliteCompatStatement;
    transaction: <TArgs extends readonly unknown[], TResult>(
        callback: (...args: TArgs) => TResult,
    ) => (...args: TArgs) => TResult;
}

export function createSqliteCompatConnection(
    location = ":memory:",
): BetterSqliteConnection {
    const database = new DatabaseSync(location);
    const connection: SqliteCompatConnection = {
        close: () => {
            database.close();
        },
        exec: (sql) => {
            database.exec(sql);
        },
        pragma: (source) => {
            database.exec(`PRAGMA ${source}`);
        },
        prepare: (sql) => {
            const statement = database.prepare(sql);

            return {
                all: (...parameters) =>
                    statement.all(
                        ...(parameters as Parameters<typeof statement.all>),
                    ),
                get: (...parameters) =>
                    statement.get(
                        ...(parameters as Parameters<typeof statement.get>),
                    ),
                run: (...parameters) =>
                    statement.run(
                        ...(parameters as Parameters<typeof statement.run>),
                    ),
            };
        },
        transaction:
            <TArgs extends readonly unknown[], TResult>(
                callback: (...args: TArgs) => TResult,
            ) =>
            (...args: TArgs): TResult => {
                database.exec("BEGIN");

                try {
                    const result = callback(...args);
                    database.exec("COMMIT");
                    return result;
                } catch (error) {
                    try {
                        database.exec("ROLLBACK");
                    } catch {
                        // Ignore secondary rollback errors during tests.
                    }

                    throw error;
                }
            },
    };

    return connection as unknown as BetterSqliteConnection;
}

export function applyMigrations(
    connection: BetterSqliteConnection,
    migrations: readonly DatabaseMigration[],
): void {
    connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);

    for (const migration of migrations) {
        connection.exec(migration.sql);
        connection
            .prepare(
                "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
            )
            .run(migration.id, new Date().toISOString());
    }
}
