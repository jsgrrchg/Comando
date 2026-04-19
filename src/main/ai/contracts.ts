import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
    ClientSideConnection,
    LoadSessionResponse,
    NewSessionResponse,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiSessionUpdate,
    PrepareAiSessionInput,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { SecretStoreGateway } from "@main/ai/secret-store";

import type { AiPersistenceGateway } from "./persistence";

export const CODEX_ACP_DIFF_PREVIOUS_PATH_KEY = "codexAcpPreviousPath";
export const LEGACY_DIFF_PREVIOUS_PATH_KEY = "neverwritePreviousPath";
export const CODEX_ACP_STATUS_EVENT_TYPE_KEY = "codexAcpEventType";
export const LEGACY_STATUS_EVENT_TYPE_KEY = "neverwriteEventType";
export const CODEX_ACP_STATUS_EVENT_TYPE = "status";
export const CODEX_ACP_STATUS_EVENT_ID_PREFIX = "codex-acp:status:";
export const LEGACY_STATUS_EVENT_ID_PREFIX = "neverwrite:status:";
export const CODEX_ACP_STATUS_TURN_EVENT_ID_PREFIX =
    "codex-acp:status:turn:";
export const LEGACY_STATUS_TURN_EVENT_ID_PREFIX = "neverwrite:status:turn:";
export const CODEX_ACP_USER_INPUT_EVENT_TYPE = "user_input_request";
export const CODEX_ACP_USER_INPUT_RESPONSE_PREFIX =
    "__codex_acp_user_input_response__:";
export const SUPPRESSED_STATUS_TITLES = new Set([
    "Preparing input",
    "Drafting response",
]);

export const AI_SESSION_STREAMING_FLUSH_MS = 120;

export interface AiServiceOptions {
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
    readonly secretStore: SecretStoreGateway;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly persistence: AiPersistenceGateway;
}

export interface LiveAcpSession {
    additionalRoots: readonly string[];
    child: ChildProcessWithoutNullStreams;
    closing: boolean;
    connection: ClientSideConnection;
    cwd: string;
    isRestoring: boolean;
    ownerWindowId: string;
    pendingPermission: {
        readonly requestId: string;
        readonly resolve: (response: RequestPermissionResponse) => void;
    } | null;
    pendingAdditionalRoots: readonly string[] | null;
    pendingPersistTimer: ReturnType<typeof setTimeout> | null;
    processedDiffPaths: Map<string, Set<string>>;
    projectRoot: string | null;
    runtimeId: AiRuntimeId;
    snapshot: AiSessionSnapshot;
    terminalOutputBuffers: Map<string, string>;
    lastBroadcastSnapshot: AiSessionSnapshot | null;
    stderrChunks: string[];
    stderrHandler: ((chunk: Buffer | string) => void) | null;
}

export interface ResolvedAcpRuntime {
    readonly args: readonly string[];
    readonly command: string;
    readonly env: NodeJS.ProcessEnv;
    readonly executable: string;
    readonly status: AiRuntimeStatus;
}

export type AcpSessionCatalogPayload = Pick<
    LoadSessionResponse | NewSessionResponse,
    "configOptions" | "models" | "modes"
>;

export interface OpenRuntimeSessionResult extends AcpSessionCatalogPayload {
    readonly runtimeSessionId: string;
}

export type SessionDescriptor = Pick<
    PrepareAiSessionInput,
    "projectId" | "runtimeId" | "sessionId" | "title" | "worktreeId"
> & {
    readonly additionalRoots?: readonly string[];
};
