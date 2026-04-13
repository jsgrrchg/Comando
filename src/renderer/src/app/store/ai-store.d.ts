import type { AiPermissionResponseInput, AiRuntimeId, AiRuntimeStatus, AiSessionSnapshot, AiSettingsSnapshot, AiTrackedFileMutationInput } from "@shared/ipc";
import type { RuntimeWorkspaceChatTab, RuntimeWorkspaceReviewTab } from "../workspace/tree";
type RuntimeAiSessionTab = RuntimeWorkspaceChatTab | RuntimeWorkspaceReviewTab;
interface QueuedPrompt {
    readonly createdAt: string;
    readonly id: string;
    readonly prompt: string;
}
interface RegisteredSessionMeta {
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly title: string;
}
interface AiSessionClientState {
    readonly hydrated: boolean;
    readonly isDispatching: boolean;
    readonly isHydrating: boolean;
    readonly localError: string | null;
    readonly meta: RegisteredSessionMeta | null;
    readonly queue: readonly QueuedPrompt[];
    readonly snapshot: AiSessionSnapshot | null;
}
interface AiStore {
    readonly codexBinaryPath: string;
    readonly runtimeStatusById: Partial<Record<AiRuntimeId, AiRuntimeStatus>>;
    readonly sessions: Record<string, AiSessionClientState>;
    applyRuntimeStatus: (status: AiRuntimeStatus) => void;
    applySessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    cancelSession: (sessionId: string) => Promise<void>;
    ensureSession: (tab: RuntimeAiSessionTab) => Promise<void>;
    hydrateSettings: (settings: AiSettingsSnapshot | null | undefined) => void;
    keepAllTrackedFiles: (sessionId: string) => Promise<void>;
    keepTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    refreshRuntimeStatus: (runtimeId: AiRuntimeId) => Promise<void>;
    registerSessionTab: (tab: RuntimeAiSessionTab) => void;
    rejectAllTrackedFiles: (sessionId: string) => Promise<void>;
    rejectTrackedFile: (input: AiTrackedFileMutationInput) => Promise<void>;
    removeQueuedPrompt: (sessionId: string, promptId: string) => void;
    respondPermission: (input: AiPermissionResponseInput) => Promise<void>;
    saveCodexBinaryPath: (binaryPath: string) => Promise<AiRuntimeStatus>;
    sendPrompt: (tab: RuntimeWorkspaceChatTab, prompt: string) => Promise<void>;
}
export declare const useAiStore: import("zustand").UseBoundStore<import("zustand").StoreApi<AiStore>>;
export {};
