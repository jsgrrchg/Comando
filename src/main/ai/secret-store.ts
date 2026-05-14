import { safeStorage } from "electron";

import type Database from "better-sqlite3";

import { debugBenignError } from "@main/observability/logging";

export interface SecretStoreGateway {
    cacheSecretPatches?(secrets: readonly SecretRecordPatch[]): void;
    deleteSecrets?(
        secrets: readonly {
            readonly namespace: string;
            readonly secretId: string;
        }[],
    ): Promise<void> | void;
    getStorageStatus?(): SecretStorageStatus;
    loadSecret(namespace: string, secretId: string): string | null;
    saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): Promise<void> | void;
}

export interface SecretRecordPatch {
    readonly key: string;
    readonly value: string | null;
}

interface SettingRow {
    readonly value: string;
}

export interface StoredSecretRecord {
    readonly scheme: "electron-safe-storage-v1" | "plain-text-v1";
    readonly value: string;
}

export interface SecretStorageStatus {
    readonly encryptionAvailable: boolean;
    readonly isWeakBackend: boolean;
    readonly message: string | null;
    readonly platform: NodeJS.Platform;
    readonly selectedBackend: string | null;
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

    getStorageStatus(): SecretStorageStatus {
        return getSecretStorageStatus();
    }

    deleteSecrets(
        secrets: readonly {
            readonly namespace: string;
            readonly secretId: string;
        }[],
    ): void {
        if (secrets.length === 0) {
            return;
        }

        const deleteSecret = this.#connection.prepare<
            [string],
            void
        >("DELETE FROM app_settings WHERE key = ?");
        const transaction = this.#connection.transaction(() => {
            for (const secret of secrets) {
                deleteSecret.run(
                    buildSecretStorageKey(secret.namespace, secret.secretId),
                );
            }
        });
        transaction();
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

export function getSecretStorageStatus(): SecretStorageStatus {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    const selectedBackend =
        process.platform === "linux" &&
        typeof safeStorage.getSelectedStorageBackend === "function"
            ? safeStorage.getSelectedStorageBackend()
            : null;
    const isWeakBackend =
        process.platform === "linux" &&
        (selectedBackend === "basic_text" || selectedBackend === "unknown");
    const message = !encryptionAvailable
        ? "Secure secret storage is unavailable on this machine."
        : isWeakBackend
          ? "Linux keyring backend is weak; Comando cannot save new secrets until a secure keyring is available."
          : null;

    return {
        encryptionAvailable,
        isWeakBackend,
        message,
        platform: process.platform,
        selectedBackend,
    };
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
        switch (stored.scheme) {
            case "electron-safe-storage-v1": {
                const decrypted = safeStorage.decryptString(
                    Buffer.from(stored.value, "base64"),
                );

                return decrypted.trim() ? decrypted : null;
            }
            case "plain-text-v1":
                return stored.value.trim() ? stored.value : null;
            default:
                debugBenignError(
                    "ai.secretStore.unknownScheme",
                    new Error(`Unknown secret storage scheme: ${stored.scheme}`),
                );
                return null;
        }
    } catch (error) {
        debugBenignError("ai.secretStore.decrypt", error);
        return null;
    }
}

export function serializeStoredSecretValue(value: string): string {
    const status = getSecretStorageStatus();
    if (!status.encryptionAvailable || status.isWeakBackend) {
        throw new Error(
            status.message ??
                "Secure secret storage is unavailable on this machine.",
        );
    }

    const payload: StoredSecretRecord = {
        scheme: "electron-safe-storage-v1",
        value: safeStorage.encryptString(value).toString("base64"),
    };

    return JSON.stringify(payload);
}
