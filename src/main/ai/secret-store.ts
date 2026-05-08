import { safeStorage } from "electron";

import type Database from "better-sqlite3";

import { debugBenignError } from "@main/observability/logging";

export interface SecretStoreGateway {
    loadSecret(namespace: string, secretId: string): string | null;
    saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): Promise<void> | void;
}

interface SettingRow {
    readonly value: string;
}

export interface StoredSecretRecord {
    readonly scheme: "electron-safe-storage-v1" | "plain-text-v1";
    readonly value: string;
}

export class SecretStoreService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSecret(namespace: string, secretId: string): string | null {
        const row = this.#connection
            .prepare<
                [string],
                SettingRow | undefined
            >("SELECT value FROM app_settings WHERE key = ?")
            .get(buildSecretStorageKey(namespace, secretId));

        return deserializeStoredSecretValue(row?.value ?? null);
    }

    saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): void {
        const normalizedValue = value?.trim() ?? "";
        const key = buildSecretStorageKey(namespace, secretId);

        if (!normalizedValue) {
            this.#connection
                .prepare<
                    [string],
                    void
                >("DELETE FROM app_settings WHERE key = ?")
                .run(key);
            return;
        }

        const payload = serializeStoredSecretValue(normalizedValue);

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
            .run(key, payload, new Date().toISOString());
    }
}

export function buildSecretStorageKey(
    namespace: string,
    secretId: string,
): string {
    return `secret.${namespace}.${secretId}`;
}

export function deserializeStoredSecretValue(
    storedValue: string | null,
): string | null {
    if (!storedValue) {
        return null;
    }

    try {
        const stored = JSON.parse(storedValue) as StoredSecretRecord;
        if (stored.scheme === "electron-safe-storage-v1") {
            const decrypted = safeStorage.decryptString(
                Buffer.from(stored.value, "base64"),
            );

            return decrypted.trim() ? decrypted : null;
        }

        return stored.value.trim() ? stored.value : null;
    } catch (error) {
        debugBenignError("ai.secretStore.decrypt", error);
        return null;
    }
}

export function serializeStoredSecretValue(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
            "Secure secret storage is unavailable on this machine.",
        );
    }

    const payload: StoredSecretRecord = {
        scheme: "electron-safe-storage-v1",
        value: safeStorage.encryptString(value).toString("base64"),
    };

    return JSON.stringify(payload);
}
