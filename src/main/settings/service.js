const CODEX_BINARY_PATH_KEY = "ai.codex.binary_path";
export class SettingsService {
    #connection;
    constructor(connection) {
        this.#connection = connection;
    }
    loadSnapshot() {
        const codexBinaryPath = this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null;
        return {
            ai: {
                codex: {
                    binaryPath: codexBinaryPath,
                },
            },
            shellState: this.#loadJsonSetting("shell.state"),
        };
    }
    saveSnapshot(snapshot) {
        if (snapshot.shellState) {
            this.#saveSetting("shell.state", JSON.stringify(snapshot.shellState));
        }
        else {
            this.#deleteSetting("shell.state");
        }
        if (snapshot.ai?.codex) {
            this.saveCodexRuntimeSettings(snapshot.ai.codex);
        }
    }
    loadCodexRuntimeSettings() {
        return {
            binaryPath: this.#loadStringSetting(CODEX_BINARY_PATH_KEY) ?? null,
        };
    }
    saveCodexRuntimeSettings(settings) {
        if (settings.binaryPath?.trim()) {
            this.#saveSetting(CODEX_BINARY_PATH_KEY, settings.binaryPath.trim());
            return;
        }
        this.#deleteSetting(CODEX_BINARY_PATH_KEY);
    }
    #loadJsonSetting(key) {
        const row = this.#connection
            .prepare("SELECT value FROM app_settings WHERE key = ?")
            .get(key);
        if (!row) {
            return null;
        }
        try {
            return JSON.parse(row.value);
        }
        catch {
            return null;
        }
    }
    #loadStringSetting(key) {
        const row = this.#connection
            .prepare("SELECT value FROM app_settings WHERE key = ?")
            .get(key);
        return row?.value ?? null;
    }
    #saveSetting(key, value) {
        this.#connection
            .prepare(`
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                `)
            .run(key, value, new Date().toISOString());
    }
    #deleteSetting(key) {
        this.#connection
            .prepare("DELETE FROM app_settings WHERE key = ?")
            .run(key);
    }
}
