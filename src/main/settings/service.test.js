import { describe, expect, it } from "vitest";
import { SettingsService } from "./service";
describe("SettingsService", () => {
    it("guarda y recarga el snapshot de settings", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(connection);
        service.saveSnapshot({
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
                rightWidth: 360,
            },
        });
        expect(service.loadSnapshot()).toEqual({
            ai: {
                codex: {
                    binaryPath: null,
                },
            },
            shellState: {
                activeSurface: "workspace",
                leftWidth: 280,
                rightWidth: 360,
            },
        });
    });
    it("tolera settings corruptos y devuelve null", () => {
        const connection = createFakeSettingsConnection({
            "shell.state": "{invalid json",
        });
        const service = new SettingsService(connection);
        expect(service.loadSnapshot()).toEqual({
            ai: {
                codex: {
                    binaryPath: null,
                },
            },
            shellState: null,
        });
    });
    it("guarda y recarga el path configurado de codex", () => {
        const connection = createFakeSettingsConnection();
        const service = new SettingsService(connection);
        service.saveCodexRuntimeSettings({
            binaryPath: "/usr/local/bin/codex-acp",
        });
        expect(service.loadCodexRuntimeSettings()).toEqual({
            binaryPath: "/usr/local/bin/codex-acp",
        });
        expect(service.loadSnapshot().ai).toEqual({
            codex: {
                binaryPath: "/usr/local/bin/codex-acp",
            },
        });
    });
});
function createFakeSettingsConnection(seed = {}) {
    const settings = new Map(Object.entries(seed));
    return {
        prepare(sql) {
            if (sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
                return {
                    get(key) {
                        const value = settings.get(key);
                        return value ? { value } : undefined;
                    },
                };
            }
            if (sql.includes("INSERT INTO app_settings")) {
                return {
                    run(key, value) {
                        settings.set(key, value);
                    },
                };
            }
            if (sql.includes("DELETE FROM app_settings WHERE key = ?")) {
                return {
                    run(key) {
                        settings.delete(key);
                    },
                };
            }
            throw new Error(`Unsupported SQL in fake settings test:\n${sql}`);
        },
    };
}
