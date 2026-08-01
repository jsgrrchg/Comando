import type {
    PersistedChatSessionState,
    WorkspaceNavigationSnapshot,
    WindowWorkspaceRestoreRecord,
} from "@shared/ipc";
import type {
    NativeAppWorkspaceNavigation,
    NativeDurableWorkspace,
    NativeDurableWorkspaceCreateInput,
    NativeDurableWorkspaceLifecycle,
    NativeDurableWorkspacePurgeOutput,
    NativeDurableWorkspaceResetInput,
    NativeDurableWorkspaceRevisionInput,
    NativeDurableWorkspaceSaveInput,
    NativeDurableWorkspaceSummary,
} from "@shared/native-backend";
import {
    getWorkspaceScopeKey,
    normalizeWorkspaceWorktreeId,
    type WorkspaceScope,
} from "@shared/workspace-context";

type Awaitable<T> = T | Promise<T>;

export interface WorkspaceContextTransferInput {
    readonly contextKey: string;
    readonly sourceRevision: number;
    readonly sourceWorkspaceId: string;
    readonly targetIndex?: number;
    readonly targetRevision: number;
    readonly targetWorkspaceId: string;
}

export interface WorkspaceContextTransferResult {
    readonly source: WindowWorkspaceRestoreRecord;
    readonly target: WindowWorkspaceRestoreRecord;
}

export interface WorkspaceGateway {
    loadSnapshot(workspaceId: string): Awaitable<WindowWorkspaceRestoreRecord>;
    saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ): Awaitable<void>;
    transferContext(
        input: WorkspaceContextTransferInput,
    ): Awaitable<WorkspaceContextTransferResult>;
    loadChatSessionState(
        sessionId: string,
    ): Awaitable<PersistedChatSessionState | null>;
}

export interface DurableWorkspaceRepositoryGateway {
    archiveDurableWorkspace(
        input: NativeDurableWorkspaceRevisionInput,
    ): Promise<NativeDurableWorkspace>;
    createDurableWorkspace(
        input: NativeDurableWorkspaceCreateInput,
    ): Promise<NativeDurableWorkspace>;
    getWorkspaceNavigation(): Promise<NativeAppWorkspaceNavigation>;
    listDurableWorkspaces(): Promise<readonly NativeDurableWorkspaceSummary[]>;
    loadDurableWorkspace(scopeKey: string): Promise<NativeDurableWorkspace | null>;
    purgeDurableWorkspace(
        input: NativeDurableWorkspaceRevisionInput,
    ): Promise<NativeDurableWorkspacePurgeOutput>;
    resetDurableWorkspace(
        input: NativeDurableWorkspaceResetInput,
    ): Promise<NativeDurableWorkspace>;
    saveDurableWorkspace(
        input: NativeDurableWorkspaceSaveInput,
    ): Promise<NativeDurableWorkspace>;
    saveWorkspaceShell(input: {
        readonly expectedRevision: number;
        readonly shellSnapshot: Readonly<Record<string, unknown>>;
    }): Promise<NativeAppWorkspaceNavigation>;
    setActiveWorkspace(input: {
        readonly activeScopeKey: string | null;
        readonly expectedRevision: number;
    }): Promise<NativeAppWorkspaceNavigation>;
}

export class DurableWorkspaceService {
    readonly #repository: DurableWorkspaceRepositoryGateway;

    constructor(repository: DurableWorkspaceRepositoryGateway) {
        this.#repository = repository;
    }

    list(): Promise<readonly NativeDurableWorkspaceSummary[]> {
        return this.#repository.listDurableWorkspaces();
    }

    load(scope: WorkspaceScope): Promise<NativeDurableWorkspace | null> {
        return this.#repository.loadDurableWorkspace(scopeKey(scope));
    }

    create(
        scope: WorkspaceScope,
        layoutSnapshot: Readonly<Record<string, unknown>>,
        lifecycle: NativeDurableWorkspaceLifecycle = "active",
    ): Promise<NativeDurableWorkspace> {
        return this.#repository.createDurableWorkspace({
            layoutSnapshot,
            lifecycle,
            projectId: scope.projectId,
            scopeKey: scopeKey(scope),
            worktreeId: normalizeWorkspaceWorktreeId(
                scope.projectId,
                scope.worktreeId,
            ),
        });
    }

    save(
        workspace: Pick<NativeDurableWorkspace, "revision" | "scopeKey">,
        layoutSnapshot: Readonly<Record<string, unknown>>,
    ): Promise<NativeDurableWorkspace> {
        return this.#repository.saveDurableWorkspace({
            expectedRevision: workspace.revision,
            layoutSnapshot,
            scopeKey: workspace.scopeKey,
        });
    }

    archive(
        workspace: Pick<NativeDurableWorkspace, "revision" | "scopeKey">,
    ): Promise<NativeDurableWorkspace> {
        return this.#repository.archiveDurableWorkspace({
            expectedRevision: workspace.revision,
            scopeKey: workspace.scopeKey,
        });
    }

    reset(
        workspace: Pick<NativeDurableWorkspace, "revision" | "scopeKey">,
        emptyLayoutSnapshot: Readonly<Record<string, unknown>>,
    ): Promise<NativeDurableWorkspace> {
        return this.#repository.resetDurableWorkspace({
            expectedRevision: workspace.revision,
            layoutSnapshot: emptyLayoutSnapshot,
            scopeKey: workspace.scopeKey,
        });
    }

    purge(
        workspace: Pick<NativeDurableWorkspace, "revision" | "scopeKey">,
    ): Promise<NativeDurableWorkspacePurgeOutput> {
        return this.#repository.purgeDurableWorkspace({
            expectedRevision: workspace.revision,
            scopeKey: workspace.scopeKey,
        });
    }

    loadNavigation(): Promise<NativeAppWorkspaceNavigation> {
        return this.#repository.getWorkspaceNavigation();
    }

    activate(
        navigation: Pick<NativeAppWorkspaceNavigation, "revision">,
        scope: WorkspaceScope | null,
    ): Promise<NativeAppWorkspaceNavigation> {
        return this.#repository.setActiveWorkspace({
            activeScopeKey: scope ? scopeKey(scope) : null,
            expectedRevision: navigation.revision,
        });
    }

    saveShell(
        navigation: Pick<NativeAppWorkspaceNavigation, "revision">,
        shellSnapshot: Readonly<Record<string, unknown>>,
    ): Promise<NativeAppWorkspaceNavigation> {
        return this.#repository.saveWorkspaceShell({
            expectedRevision: navigation.revision,
            shellSnapshot,
        });
    }
}

function scopeKey(scope: WorkspaceScope): string {
    return getWorkspaceScopeKey(scope.projectId, scope.worktreeId);
}
