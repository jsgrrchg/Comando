import type {
    PersistedChatSessionState,
    WorkspaceNavigationSnapshot,
    WindowWorkspaceRestoreRecord,
} from "@shared/ipc";

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
