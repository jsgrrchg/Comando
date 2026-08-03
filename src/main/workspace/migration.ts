import type {
    PersistenceSnapshot,
    WindowWorkspaceRestoreRecord,
} from "@shared/ipc";
import type {
    NativeLegacyWorkspaceWindow,
    NativeWorkspaceMigrationRunInput,
} from "@shared/native-backend";
import {
    normalizeWindowWorkspaceRestoreRecord,
    normalizeWorkspaceNavigationSnapshot,
} from "@shared/workspace-restore";

export const LEGACY_CLOSED_LAYOUT_CAP = 30;

export interface LegacyWorkspaceWindowRecord {
    readonly isOpen: boolean;
    readonly lastOpenedAt: string;
    readonly snapshot: PersistenceSnapshot;
    readonly workspaceRestore?: WindowWorkspaceRestoreRecord;
}

export interface PrepareLegacyWorkspaceMigrationOptions {
    readonly applicationVersion: string;
    readonly loadFallbackLayout: (workspaceId: string) => Promise<unknown>;
    readonly records: readonly LegacyWorkspaceWindowRecord[];
}

export async function prepareLegacyWorkspaceMigration(
    options: PrepareLegacyWorkspaceMigrationOptions,
): Promise<NativeWorkspaceMigrationRunInput> {
    const fallbackLayouts: Record<string, unknown> = {};
    const windows: NativeLegacyWorkspaceWindow[] = [];
    let normalizationDroppedContextCount = 0;
    let normalizationRepairedWindowCount = 0;

    for (const record of options.records) {
        const windowContext = record.snapshot.windowContext;
        if (!windowContext?.windowId) {
            continue;
        }
        const workspaceId = windowContext.workspaceId;
        let sourceRestore: unknown = record.workspaceRestore;
        if (sourceRestore === undefined && workspaceId) {
            // Older builds stored a single layout outside the window restore record.
            sourceRestore = await options.loadFallbackLayout(workspaceId);
            fallbackLayouts[workspaceId] = sourceRestore;
        }
        const normalization = normalizeWorkspaceNavigationSnapshot(
            restoreSnapshotValue(sourceRestore),
            {
                projectId: record.snapshot.activeProjectId,
                worktreeId: record.snapshot.activeWorktreeId,
            },
        );
        const restore = normalizeWindowWorkspaceRestoreRecord(sourceRestore, {
            projectId: record.snapshot.activeProjectId,
            worktreeId: record.snapshot.activeWorktreeId,
        });
        normalizationDroppedContextCount += normalization.droppedContextCount;
        if (
            normalization.repaired ||
            JSON.stringify(sourceRestore) !== JSON.stringify(restore)
        ) {
            normalizationRepairedWindowCount += 1;
        }
        windows.push({
            activeContextKey: restore.snapshot.activeContextKey,
            contexts: restore.snapshot.contexts.map((context) => ({
                lastActivatedAt: context.lastActivatedAt,
                layoutSnapshot: context.workspace,
                projectId: context.projectId,
                scopeKey: context.key,
                worktreeId: context.worktreeId,
            })),
            isOpen: record.isOpen,
            openContextKeys: restore.snapshot.openContextKeys,
            projectionTemplate: record,
            restoreRevision: restore.revision,
            restoreUpdatedAt: restore.updatedAt,
            shellSnapshot: {
                shellState: record.snapshot.shellState,
                windowState: record.snapshot.windowState,
            },
            windowId: windowContext.windowId,
            workspaceId,
        });
    }

    return {
        applicationVersion: options.applicationVersion,
        historicalLayoutCap: LEGACY_CLOSED_LAYOUT_CAP,
        normalizationDroppedContextCount,
        normalizationRepairedWindowCount,
        sourceBackup: {
            fallbackLayouts,
            format: "workspace-v3-backup",
            windows: options.records,
        },
        windows,
    };
}

function restoreSnapshotValue(value: unknown): unknown {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        return value;
    }
    return value.snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
