import type Database from "better-sqlite3";

import type {
    CodexRuntimeSettings,
    PersistedShellState,
    SettingsSnapshot,
} from "@shared/ipc";

const CODEX_BINARY_PATH_KEY = "ai.codex.binary_path";

interface SettingRow {
    readonly value: string;
}

export class SettingsService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSnapshot(): SettingsSnapshot {
        const codexBinaryPath =
            this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null;

        return {
            ai: {
                codex: {
                    binaryPath: codexBinaryPath,
                },
            },
            shellState:
                this.#loadJsonSetting<PersistedShellState>("shell.state"),
        };
    }

    saveSnapshot(snapshot: SettingsSnapshot): void {
        if (snapshot.shellState) {
            this.#saveSetting(
                "shell.state",
                JSON.stringify(snapshot.shellState),
            );
        } else {
            this.#deleteSetting("shell.state");
        }

        if (snapshot.ai?.codex) {
            this.saveCodexRuntimeSettings(snapshot.ai.codex);
        }
    }

    loadCodexRuntimeSettings(): CodexRuntimeSettings {
        return {
            binaryPath: this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null,
        };
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): void {
        if (settings.binaryPath?.trim()) {
            this.#saveSetting(
                CODEX_BINARY_PATH_KEY,
                settings.binaryPath.trim(),
            );
            return;
        }

        this.#deleteSetting(CODEX_BINARY_PATH_KEY);
    }

    #loadJsonSetting<T>(key: string): T | null {
        const row = this.#connection
            .prepare<
                [string],
                SettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
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

    #loadStringSetting(key: string): string | null {
        const row = this.#connection
            .prepare<
                [string],
                SettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
            .get(key);

        return row?.value ?? null;
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
