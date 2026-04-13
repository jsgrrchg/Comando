import type Database from "better-sqlite3";

import type { PersistedShellState, SettingsSnapshot } from "@shared/ipc";

interface SettingRow {
    readonly value: string;
}

export class SettingsService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSnapshot(): SettingsSnapshot {
        return {
            shellState: this.#loadJsonSetting<PersistedShellState>(
                "shell.state",
            ),
        };
    }

    saveSnapshot(snapshot: SettingsSnapshot): void {
        if (snapshot.shellState) {
            this.#saveSetting("shell.state", JSON.stringify(snapshot.shellState));
            return;
        }

        this.#deleteSetting("shell.state");
    }

    #loadJsonSetting<T>(key: string): T | null {
        const row = this.#connection
            .prepare<[string], SettingRow | undefined>(
                "SELECT value FROM app_settings WHERE key = ?",
            )
            .get(key);

        if (!row) {
            return null;
        }

        try {
            return JSON.parse(row.value) as T;
        } catch {
            return null;
        }
    }

    #saveSetting(key: string, value: string): void {
        this.#connection
            .prepare<[string, string, string], void>(
                `
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                `,
            )
            .run(key, value, new Date().toISOString());
    }

    #deleteSetting(key: string): void {
        this.#connection
            .prepare<[string], void>("DELETE FROM app_settings WHERE key = ?")
            .run(key);
    }
}
