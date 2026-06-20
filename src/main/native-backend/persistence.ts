import type {
    NativePersistenceMode,
    NativePersistenceOpenStoreInput,
    NativePersistenceOpenStoreOutput,
    NativePersistenceStorageHealth,
} from "@shared/native-backend";

export const NATIVE_PERSISTENCE_ENABLED_ENV = "COMANDO_NATIVE_PERSISTENCE";
export const NATIVE_PERSISTENCE_STRICT_ENV = "COMANDO_NATIVE_PERSISTENCE_STRICT";

export interface NativeBackendRequester {
    request<T = unknown>(
        command: string,
        args?: Record<string, unknown>,
    ): Promise<T>;
}

export class NativePersistenceGateway {
    readonly #client: NativeBackendRequester;

    constructor(client: NativeBackendRequester) {
        this.#client = client;
    }

    async openStore(
        input: NativePersistenceOpenStoreInput,
    ): Promise<NativePersistenceOpenStoreOutput> {
        return parseNativePersistenceOpenStoreOutput(
            await this.#client.request("persistence_open_store", {
                appDataDir: input.appDataDir,
                databasePath: input.databasePath,
                mode: input.mode,
            }),
        );
    }

    async getStorageHealth(): Promise<NativePersistenceStorageHealth> {
        return parseNativePersistenceStorageHealth(
            await this.#client.request("persistence_get_storage_health"),
        );
    }
}

export function isNativePersistenceEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NATIVE_PERSISTENCE_ENABLED_ENV] === "1";
}

export function isNativePersistenceStrict(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NATIVE_PERSISTENCE_STRICT_ENV] === "1";
}

export function normalizeNativePersistenceMode(
    value: string | null | undefined,
): NativePersistenceMode {
    return value === "write" ? "write" : "shadow";
}

function parseNativePersistenceOpenStoreOutput(
    value: unknown,
): NativePersistenceOpenStoreOutput {
    const record = requireRecord(value, "Native persistence open store output");
    return {
        metadataReady: requireBoolean(record.metadataReady, "metadataReady"),
        opened: requireBoolean(record.opened, "opened"),
        schemaVersion: requireString(record.schemaVersion, "schemaVersion"),
        storageMode: requireString(record.storageMode, "storageMode"),
    };
}

function parseNativePersistenceStorageHealth(
    value: unknown,
): NativePersistenceStorageHealth {
    const record = requireRecord(value, "Native persistence storage health");
    return {
        checkedAt: requireString(record.checkedAt, "checkedAt"),
        databaseReachable: requireBoolean(
            record.databaseReachable,
            "databaseReachable",
        ),
        metadataReady: requireBoolean(record.metadataReady, "metadataReady"),
        opened: requireBoolean(record.opened, "opened"),
        projectCount: requireNumber(record.projectCount, "projectCount"),
        schemaCompatible: requireBoolean(
            record.schemaCompatible,
            "schemaCompatible",
        ),
        worktreeCount: requireNumber(record.worktreeCount, "worktreeCount"),
    };
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`Native persistence field ${fieldName} must be a boolean.`);
    }
    return value;
}

function requireNumber(value: unknown, fieldName: string): number {
    if (typeof value !== "number") {
        throw new Error(`Native persistence field ${fieldName} must be a number.`);
    }
    return value;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native persistence field ${fieldName} must be a string.`);
    }
    return value;
}
