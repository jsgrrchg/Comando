import type {
    PersistenceSnapshot,
    PersistedShellState,
    PersistedWindowState,
} from "@shared/ipc";

type Awaitable<T> = T | Promise<T>;

export interface CreateMainWindowSessionInput {
    readonly projectId?: string | null;
    readonly worktreeId?: string | null;
    readonly shellState?: PersistedShellState | null;
}

export interface PersistenceGateway {
    createMainWindowSession(
        input?: CreateMainWindowSessionInput,
    ): Awaitable<PersistenceSnapshot>;
    findClosedMainWindowSnapshotForProject(
        projectId: string,
        worktreeId?: string | null,
    ): Awaitable<PersistenceSnapshot | null>;
    listRestorableMainWindowSnapshots(): readonly PersistenceSnapshot[];
    loadSnapshot(windowId: string): PersistenceSnapshot;
    loadWindowState(windowId: string): PersistedWindowState | null;
    saveActiveProjectId(
        windowId: string,
        projectId: string | null,
        worktreeId?: string | null,
    ): void;
    saveShellState(
        windowId: string,
        shellState: PersistedShellState | null,
    ): void;
    saveWindowState(state: PersistedWindowState): void;
    markWindowClosed(windowId: string): void;
    markWindowOpen(windowId: string): void;
}
