import type {
    PersistedChatSessionState,
    PersistedWorkspaceSnapshot,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";

type Awaitable<T> = T | Promise<T>;

export interface WorkspaceGateway {
    loadSnapshot(workspaceId: string): Awaitable<PersistedWorkspaceSnapshot>;
    saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceNavigationSnapshot,
    ): Awaitable<void>;
    loadChatSessionState(
        sessionId: string,
    ): Awaitable<PersistedChatSessionState | null>;
}
