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
    NativeWorkspaceMigrationDiagnostics,
    NativeWorkspaceMigrationExportOutput,
    NativeWorkspaceMigrationRollbackOutput,
    NativeWorkspaceMigrationRunInput,
    NativeWorkspaceMigrationRunOutput,
    NativeWorkspaceDeletionBeginInput,
    NativeWorkspaceDeletionJournalEntry,
    NativeWorkspaceDeletionUpdateInput,
    NativeWorkspaceRecoveryApplyInput,
    NativeWorkspaceRecoveryLayoutSummary,
    NativeWorkspaceReassociateInput,
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

    async listWorkspaceRecoveryLayouts(): Promise<readonly NativeWorkspaceRecoveryLayoutSummary[]> {
        const output = requireRecord(
            await this.#client.request("workspace_recovery_list"),
            "Native workspace recovery list",
        );
        if (!Array.isArray(output.layouts)) {
            throw new Error("Native workspace recovery list must contain layouts.");
        }
        return output.layouts.map(parseNativeWorkspaceRecoveryLayout);
    }

    async applyWorkspaceRecoveryLayout(
        input: NativeWorkspaceRecoveryApplyInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("workspace_recovery_apply", { ...input }),
        );
    }

    async reassociateWorkspace(
        input: NativeWorkspaceReassociateInput,
    ): Promise<NativeDurableWorkspace> {
        return parseNativeDurableWorkspace(
            await this.#client.request("workspace_reassociate", { ...input }),
        );
    }

    async forgetWorkspaceSessionReferences(sessionId: string): Promise<number> {
        return requireRevision(
            await this.#client.request("workspace_forget_session", { sessionId }),
            "changedWorkspaceCount",
        );
    }

    async beginWorkspaceDeletion(
        input: NativeWorkspaceDeletionBeginInput,
    ): Promise<NativeWorkspaceDeletionJournalEntry> {
        return parseNativeWorkspaceDeletion(
            await this.#client.request("workspace_deletion_begin", { ...input }),
        );
    }

    async updateWorkspaceDeletion(
        input: NativeWorkspaceDeletionUpdateInput,
    ): Promise<NativeWorkspaceDeletionJournalEntry> {
        return parseNativeWorkspaceDeletion(
            await this.#client.request("workspace_deletion_update", { ...input }),
        );
    }

    async listIncompleteWorkspaceDeletions(): Promise<readonly NativeWorkspaceDeletionJournalEntry[]> {
        const output = requireRecord(
            await this.#client.request("workspace_deletion_list_incomplete"),
            "Native workspace deletion list",
        );
        if (!Array.isArray(output.operations)) {
            throw new Error("Native workspace deletion list must contain operations.");
        }
        return output.operations.map(parseNativeWorkspaceDeletion);
    }

    async completeWorkspaceDeletion(
        operationId: string,
    ): Promise<NativeWorkspaceDeletionJournalEntry> {
        return parseNativeWorkspaceDeletion(
            await this.#client.request("workspace_deletion_complete", { operationId }),
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

    async runWorkspaceMigration(
        input: NativeWorkspaceMigrationRunInput,
    ): Promise<NativeWorkspaceMigrationRunOutput> {
        return parseNativeWorkspaceMigrationRunOutput(
            await this.#client.request("workspace_migration_run", {
                ...input,
            }),
        );
    }

    async syncLegacyWorkspaceMigration(
        input: NativeWorkspaceMigrationRunInput,
    ): Promise<NativeAppWorkspaceNavigation> {
        return parseNativeAppWorkspaceNavigation(
            await this.#client.request("workspace_migration_sync_legacy", {
                ...input,
            }),
        );
    }

    async exportWorkspaceMigrationDiagnostics(): Promise<NativeWorkspaceMigrationExportOutput> {
        return parseNativeWorkspaceMigrationExportOutput(
            await this.#client.request(
                "workspace_migration_export_diagnostics",
            ),
        );
    }

    async rollbackWorkspaceMigration(): Promise<NativeWorkspaceMigrationRollbackOutput> {
        return parseNativeWorkspaceMigrationRollbackOutput(
            await this.#client.request("workspace_migration_rollback"),
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

function parseNativeWorkspaceRecoveryLayout(
    value: unknown,
): NativeWorkspaceRecoveryLayoutSummary {
    const record = requireRecord(value, "Native workspace recovery layout");
    return {
        createdAt: requireString(record.createdAt, "createdAt"),
        id: requireString(record.id, "id"),
        scopeKey: requireString(record.scopeKey, "scopeKey"),
        snapshotHash: requireString(record.snapshotHash, "snapshotHash"),
        sourceRevision: requireRevision(record.sourceRevision, "sourceRevision"),
        sourceUpdatedAt: requireString(record.sourceUpdatedAt, "sourceUpdatedAt"),
        sourceWindowId: requireNullableString(record.sourceWindowId, "sourceWindowId"),
        sourceWorkspaceId: requireNullableString(record.sourceWorkspaceId, "sourceWorkspaceId"),
    };
}

function parseNativeWorkspaceDeletion(
    value: unknown,
): NativeWorkspaceDeletionJournalEntry {
    const record = requireRecord(value, "Native workspace deletion operation");
    const kind = record.kind;
    const status = record.status;
    if (kind !== "delete_worktree" && kind !== "clear_project_data") {
        throw new Error("Native workspace deletion kind is invalid.");
    }
    if (
        status !== "pending" &&
        status !== "checkout_deleted" &&
        status !== "purging" &&
        status !== "completed" &&
        status !== "failed"
    ) {
        throw new Error("Native workspace deletion status is invalid.");
    }
    if (
        !Array.isArray(record.sessionIds) ||
        !record.sessionIds.every((sessionId) => typeof sessionId === "string")
    ) {
        throw new Error("Native workspace deletion sessionIds must be strings.");
    }
    return {
        checkoutPath: requireNullableString(record.checkoutPath, "checkoutPath"),
        errorCode: requireNullableString(record.errorCode, "errorCode"),
        forceApproved: requireBoolean(record.forceApproved, "forceApproved"),
        kind,
        operationId: requireString(record.operationId, "operationId"),
        projectId: requireString(record.projectId, "projectId"),
        scopeKey: requireString(record.scopeKey, "scopeKey"),
        sessionIds: record.sessionIds,
        startedAt: requireString(record.startedAt, "startedAt"),
        status,
        updatedAt: requireString(record.updatedAt, "updatedAt"),
        worktreeId: requireNullableString(record.worktreeId, "worktreeId"),
    };
}

function parseNativeWorkspaceMigrationRunOutput(
    value: unknown,
): NativeWorkspaceMigrationRunOutput {
    const record = requireRecord(value, "Native workspace migration output");
    return {
        applied: requireBoolean(record.applied, "applied"),
        diagnostics: parseNativeWorkspaceMigrationDiagnostics(
            record.diagnostics,
        ),
        navigation: parseNativeAppWorkspaceNavigation(record.navigation),
    };
}

function parseNativeWorkspaceMigrationExportOutput(
    value: unknown,
): NativeWorkspaceMigrationExportOutput {
    const record = requireRecord(
        value,
        "Native workspace migration diagnostics export",
    );
    if (!Array.isArray(record.recoveryLayouts)) {
        throw new Error("Native workspace recovery layouts must be an array.");
    }
    if (!Array.isArray(record.v3Projection)) {
        throw new Error("Native workspace v3 projection must be an array.");
    }
    return {
        diagnostics: parseNativeWorkspaceMigrationDiagnostics(
            record.diagnostics,
        ),
        recoveryLayouts: record.recoveryLayouts.map((value) => {
            const recovery = requireRecord(
                value,
                "Native workspace migration recovery source",
            );
            return {
                scopeKey: requireString(recovery.scopeKey, "scopeKey"),
                snapshotHash: requireString(
                    recovery.snapshotHash,
                    "snapshotHash",
                ),
                sourceWindowId: requireString(
                    recovery.sourceWindowId,
                    "sourceWindowId",
                ),
            };
        }),
        v3Projection: record.v3Projection,
    };
}

function parseNativeWorkspaceMigrationRollbackOutput(
    value: unknown,
): NativeWorkspaceMigrationRollbackOutput {
    const record = requireRecord(
        value,
        "Native workspace migration rollback output",
    );
    if (!Array.isArray(record.v3Projection)) {
        throw new Error("Native workspace rollback projection must be an array.");
    }
    return {
        diagnostics: parseNativeWorkspaceMigrationDiagnostics(
            record.diagnostics,
        ),
        v3Projection: record.v3Projection,
    };
}

function parseNativeWorkspaceMigrationDiagnostics(
    value: unknown,
): NativeWorkspaceMigrationDiagnostics {
    const record = requireRecord(
        value,
        "Native workspace migration diagnostics",
    );
    if (!Array.isArray(record.layoutSources)) {
        throw new Error("Native workspace layout sources must be an array.");
    }
    if (!Array.isArray(record.recoverySources)) {
        throw new Error("Native workspace recovery sources must be an array.");
    }
    return {
        activeScopeKey: requireNullableString(
            record.activeScopeKey,
            "activeScopeKey",
        ),
        activeSourceWindowId: requireNullableString(
            record.activeSourceWindowId,
            "activeSourceWindowId",
        ),
        applicationVersion: requireString(
            record.applicationVersion,
            "applicationVersion",
        ),
        candidateCount: requireRevision(
            record.candidateCount,
            "candidateCount",
        ),
        completedAt: requireNullableString(record.completedAt, "completedAt"),
        historicalLayoutCap: requireRevision(
            record.historicalLayoutCap,
            "historicalLayoutCap",
        ),
        layoutSources: record.layoutSources.map((value) => {
            const source = requireRecord(
                value,
                "Native workspace layout source",
            );
            return {
                scopeKey: requireString(source.scopeKey, "scopeKey"),
                sourceWindowId: requireString(
                    source.sourceWindowId,
                    "sourceWindowId",
                ),
            };
        }),
        limitation: requireString(record.limitation, "limitation"),
        migrationId: requireString(record.migrationId, "migrationId"),
        normalizationDroppedContextCount: requireRevision(
            record.normalizationDroppedContextCount,
            "normalizationDroppedContextCount",
        ),
        normalizationRepairedWindowCount: requireRevision(
            record.normalizationRepairedWindowCount,
            "normalizationRepairedWindowCount",
        ),
        prunedLayoutsPossible: requireBoolean(
            record.prunedLayoutsPossible,
            "prunedLayoutsPossible",
        ),
        recoveryLayoutCount: requireRevision(
            record.recoveryLayoutCount,
            "recoveryLayoutCount",
        ),
        recoverySources: record.recoverySources.map((value) => {
            const source = requireRecord(
                value,
                "Native workspace recovery source",
            );
            return {
                scopeKey: requireString(source.scopeKey, "scopeKey"),
                snapshotHash: requireString(
                    source.snapshotHash,
                    "snapshotHash",
                ),
                sourceWindowId: requireString(
                    source.sourceWindowId,
                    "sourceWindowId",
                ),
            };
        }),
        rollbackAt: requireNullableString(record.rollbackAt, "rollbackAt"),
        sourceBackupRef: requireString(
            record.sourceBackupRef,
            "sourceBackupRef",
        ),
        sourceChecksum: requireString(
            record.sourceChecksum,
            "sourceChecksum",
        ),
        sourceWindowCount: requireRevision(
            record.sourceWindowCount,
            "sourceWindowCount",
        ),
        startedAt: requireString(record.startedAt, "startedAt"),
        status: requireString(record.status, "status"),
        workspaceCount: requireRevision(
            record.workspaceCount,
            "workspaceCount",
        ),
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
