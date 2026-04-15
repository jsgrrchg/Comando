import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
    decryptString: vi.fn<(value: Buffer) => string>(),
    encryptString: vi.fn<(value: string) => Buffer>(),
    isEncryptionAvailable: vi.fn<() => boolean>(),
}));

vi.mock("electron", () => ({
    safeStorage: safeStorageMock,
}));

import { SecretStoreService } from "./secret-store";

describe("SecretStoreService", () => {
    beforeEach(() => {
        safeStorageMock.decryptString.mockReset();
        safeStorageMock.encryptString.mockReset();
        safeStorageMock.isEncryptionAvailable.mockReset();
    });

    it("guarda secretos cifrados cuando safeStorage está disponible", () => {
        const connection = createFakeConnection();
        const service = new SecretStoreService(
            connection as unknown as Database.Database,
        );

        safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
        safeStorageMock.encryptString.mockReturnValue(
            Buffer.from("ciphertext", "utf8"),
        );

        service.saveSecret("ai.codex", "openai_api_key", "secret-value");

        expect(connection.appSettings.get("secret.ai.codex.openai_api_key")).toBe(
            JSON.stringify({
                scheme: "electron-safe-storage-v1",
                value: Buffer.from("ciphertext", "utf8").toString("base64"),
            }),
        );
    });

    it("rechaza persistir secretos en claro cuando no hay cifrado disponible", () => {
        const connection = createFakeConnection();
        const service = new SecretStoreService(
            connection as unknown as Database.Database,
        );

        safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

        expect(() =>
            service.saveSecret("ai.codex", "openai_api_key", "secret-value"),
        ).toThrowError("Secure secret storage is unavailable");
        expect(connection.appSettings.size).toBe(0);
    });

    it("todavía puede leer secretos legacy en texto plano", () => {
        const connection = createFakeConnection({
            "secret.ai.codex.openai_api_key": JSON.stringify({
                scheme: "plain-text-v1",
                value: "legacy-secret",
            }),
        });
        const service = new SecretStoreService(
            connection as unknown as Database.Database,
        );

        expect(service.loadSecret("ai.codex", "openai_api_key")).toBe(
            "legacy-secret",
        );
    });
});

function createFakeConnection(seed: Record<string, string> = {}) {
    const appSettings = new Map(Object.entries(seed));

    return {
        appSettings,
        prepare(sql: string) {
            const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase();

            if (
                normalizedSql.includes(
                    "select value from app_settings where key = ?",
                )
            ) {
                return {
                    get(key: string) {
                        const value = appSettings.get(key);
                        return value !== undefined ? { value } : undefined;
                    },
                };
            }

            if (normalizedSql.includes("delete from app_settings where key = ?")) {
                return {
                    run(key: string) {
                        appSettings.delete(key);
                    },
                };
            }

            if (normalizedSql.includes("insert into app_settings")) {
                return {
                    run(key: string, value: string) {
                        appSettings.set(key, value);
                    },
                };
            }

            throw new Error(`Unsupported SQL in fake connection: ${sql}`);
        },
    };
}
