import type {
    NativeAppWorkspaceNavigation,
    NativeAppWorkspaceSaveShellInput,
    NativeAppWorkspaceSetActiveInput,
    NativePersistenceOpenStoreInput,
    NativePersistenceOpenStoreOutput,
    NativePersistenceStorageHealth,
    NativeDurableWorkspace,
    NativeDurableWorkspaceCreateInput,
    NativeDurableWorkspacePurgeOutput,
    NativeDurableWorkspaceResetInput,
    NativeDurableWorkspaceRevisionInput,
    NativeDurableWorkspaceSaveInput,
    NativeDurableWorkspaceSummary,
} from "@shared/native-backend";

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

    async loadDurableWorkspace(
        scopeKey: string,
    ): Promise<NativeDurableWorkspace | null> {
        const value = await this.#client.request("durable_workspace_load", {
            scopeKey,
        });
        return value === null ? null : parseNativeDurableWorkspace(value);
    }

    async listDurableWorkspaces(): Promise<readonly NativeDurableWorkspaceSummary[]> {
        const value = requireRecord(
            await this.#client.request("durable_workspace_list"),
            "Native durable workspace list output",
        );
        if (!Array.isArray(value.workspaces)) {
            throw new Error("Native durable workspace list must contain workspaces.");
        }
        return value.workspaces.map(parseNativeDurableWorkspaceSummary);
    }

    async createDurableWorkspace(
        input: NativeDurableWorkspaceCreateInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("durable_workspace_create", { ...input }),
        );
    }

    async saveDurableWorkspace(
        input: NativeDurableWorkspaceSaveInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("durable_workspace_save", { ...input }),
        );
    }

    async archiveDurableWorkspace(
        input: NativeDurableWorkspaceRevisionInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("durable_workspace_archive", { ...input }),
        );
    }

    async resetDurableWorkspace(
        input: NativeDurableWorkspaceResetInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("durable_workspace_reset", { ...input }),
        );
    }

    async purgeDurableWorkspace(
        input: NativeDurableWorkspaceRevisionInput,
    ): Promise<NativeDurableWorkspacePurgeOutput> {
        return parseNativeDurableWorkspacePurgeOutput(
            await this.#client.request("durable_workspace_purge", { ...input }),
        );
    }

    async getWorkspaceNavigation(): Promise<NativeAppWorkspaceNavigation> {
        return parseNativeAppWorkspaceNavigation(
            await this.#client.request("workspace_navigation_get"),
        );
    }

    async setActiveWorkspace(
        input: NativeAppWorkspaceSetActiveInput,
    ): Promise<NativeAppWorkspaceNavigation> {
        return parseNativeAppWorkspaceNavigation(
            await this.#client.request("workspace_navigation_set_active", {
                ...input,
            }),
        );
    }

    async saveWorkspaceShell(
        input: NativeAppWorkspaceSaveShellInput,
    ): Promise<NativeAppWorkspaceNavigation> {
        return parseNativeAppWorkspaceNavigation(
            await this.#client.request("workspace_navigation_save_shell", {
                ...input,
            }),
        );
    }
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

function parseNativeDurableWorkspace(value: unknown): NativeDurableWorkspace {
    const record = requireRecord(value, "Native durable workspace");
    return {
        ...parseNativeDurableWorkspaceSummary(record),
        layoutSnapshot: requireRecord(
            record.layoutSnapshot,
            "Native durable workspace layoutSnapshot",
        ),
    };
}

function parseNativeDurableWorkspaceSummary(
    value: unknown,
): NativeDurableWorkspaceSummary {
    const record = requireRecord(value, "Native durable workspace summary");
    const lifecycle = record.lifecycle;
    if (
        lifecycle !== "active" &&
        lifecycle !== "archived" &&
        lifecycle !== "orphaned"
    ) {
        throw new Error("Native durable workspace lifecycle is invalid.");
    }
    return {
        createdAt: requireString(record.createdAt, "createdAt"),
        lastActivatedAt: requireNullableString(
            record.lastActivatedAt,
            "lastActivatedAt",
        ),
        lifecycle,
        projectId: requireString(record.projectId, "projectId"),
        revision: requireRevision(record.revision, "revision"),
        runtimeOwnerId: requireString(record.runtimeOwnerId, "runtimeOwnerId"),
        scopeKey: requireString(record.scopeKey, "scopeKey"),
        updatedAt: requireString(record.updatedAt, "updatedAt"),
        worktreeId: requireNullableString(record.worktreeId, "worktreeId"),
    };
}

function parseNativeAppWorkspaceNavigation(
    value: unknown,
): NativeAppWorkspaceNavigation {
    const record = requireRecord(value, "Native app workspace navigation");
    if (
        !Array.isArray(record.recentScopeKeys) ||
        !record.recentScopeKeys.every((scopeKey) => typeof scopeKey === "string")
    ) {
        throw new Error(
            "Native app workspace navigation recentScopeKeys must be strings.",
        );
    }
    return {
        activeScopeKey: requireNullableString(
            record.activeScopeKey,
            "activeScopeKey",
        ),
        recentScopeKeys: record.recentScopeKeys,
        revision: requireRevision(record.revision, "revision"),
        shellSnapshot: requireRecord(
            record.shellSnapshot,
            "Native app workspace navigation shellSnapshot",
        ),
        updatedAt: requireString(record.updatedAt, "updatedAt"),
    };
}

function parseNativeDurableWorkspacePurgeOutput(
    value: unknown,
): NativeDurableWorkspacePurgeOutput {
    const record = requireRecord(value, "Native durable workspace purge output");
    return {
        navigation: parseNativeAppWorkspaceNavigation(record.navigation),
        purgedScopeKey: requireString(record.purgedScopeKey, "purgedScopeKey"),
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

function requireRevision(value: unknown, fieldName: string): number {
    const revision = requireNumber(value, fieldName);
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error(
            `Native persistence field ${fieldName} must be a non-negative safe integer.`,
        );
    }
    return revision;
}

function requireString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new Error(`Native persistence field ${fieldName} must be a string.`);
    }
    return value;
}

function requireNullableString(
    value: unknown,
    fieldName: string,
): string | null {
    if (value === null) {
        return null;
    }
    return requireString(value, fieldName);
}
