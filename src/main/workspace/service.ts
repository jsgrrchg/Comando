import type { PersistedChatSessionState, WorkspaceSnapshot } from "@shared/ipc";

type Awaitable<T> = T | Promise<T>;

export interface WorkspaceGateway {
    loadSnapshot(workspaceId: string): Awaitable<WorkspaceSnapshot>;
    saveSnapshot(
        workspaceId: string,
        snapshot: WorkspaceSnapshot,
    ): Awaitable<void>;
    loadChatSessionState(
        sessionId: string,
    ): Awaitable<PersistedChatSessionState | null>;
}
