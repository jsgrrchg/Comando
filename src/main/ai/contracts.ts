import type {
    ChildProcess,
    ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { MessagePort } from "node:worker_threads";

import type {
    ClientSideConnection,
    LoadSessionResponse,
    NewSessionResponse,
    RequestPermissionResponse,
    SessionNotification,
    TerminalExitStatus,
} from "@agentclientprotocol/sdk";
import type {
    AiPermissionRequest,
    AiPermissionResponseInput,
    AiHistorySessionSummary,
    AiPromptResult,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionRenameMutationInput,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiSessionTranscriptPage,
    AiTrackedFile,
    AiUserInputResponseInput,
    FileBufferNotificationInput,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { SecretStoreGateway } from "@main/ai/secret-store";

import type { AiPersistenceGateway } from "./persistence";

export const CODEX_ACP_DIFF_PREVIOUS_PATH_KEY = "codexAcpPreviousPath";
export const COMANDO_DIFF_PREVIOUS_PATH_KEY = "comandoPreviousPath";
export const CODEX_ACP_STATUS_EVENT_TYPE_KEY = "codexAcpEventType";
export const COMANDO_STATUS_EVENT_TYPE_KEY = "comandoEventType";
export const CODEX_ACP_STATUS_EVENT_TYPE = "status";
export const CODEX_ACP_TURN_EVENT_TYPE_KEY = "codexAcpTurnEventType";
export const CODEX_ACP_TURN_ID_KEY = "codexAcpTurnId";
export const CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE = "turn_lifecycle";
export const CODEX_ACP_TURN_STARTED_EVENT_TYPE = "turn_started";
export const CODEX_ACP_TURN_COMPLETE_EVENT_TYPE = "turn_complete";
export const CODEX_ACP_TURN_ABORTED_EVENT_TYPE = "turn_aborted";
export const CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE = "shutdown_complete";
export const CODEX_ACP_IMAGE_GENERATION_EVENT_TYPE = "image_generation";
export const CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE =
    "subagent_session_created";
export const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE = "subagent_breadcrumb";
export const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY =
    "codexAcpSubagentEventType";
export const CODEX_ACP_PARENT_SESSION_ID_KEY = "codexAcpParentSessionId";
export const CODEX_ACP_PARENT_THREAD_ID_KEY = "codexAcpParentThreadId";
export const CODEX_ACP_CHILD_SESSION_ID_KEY = "codexAcpChildSessionId";
export const CODEX_ACP_CHILD_THREAD_ID_KEY = "codexAcpChildThreadId";
export const CODEX_ACP_AGENT_NICKNAME_KEY = "codexAcpAgentNickname";
export const CODEX_ACP_AGENT_ROLE_KEY = "codexAcpAgentRole";
export const CODEX_ACP_AGENT_STATUS_KEY = "codexAcpAgentStatus";
export const CODEX_ACP_AGENT_STATUSES_KEY = "codexAcpAgentStatuses";
export const CODEX_ACP_MODEL_KEY = "codexAcpModel";
export const CODEX_ACP_REASONING_EFFORT_KEY = "codexAcpReasoningEffort";
export const CODEX_ACP_CWD_KEY = "codexAcpCwd";
export const CODEX_ACP_PLAN_TITLE_KEY = "codexAcpPlanTitle";
export const CODEX_ACP_STATUS_EVENT_ID_PREFIX = "codex-acp:status:";
export const CODEX_ACP_IMAGE_GENERATION_EVENT_ID_PREFIX = "codex-acp:image:";
export const COMANDO_STATUS_EVENT_ID_PREFIX = "comando:status:";
export const CODEX_ACP_STATUS_TURN_EVENT_ID_PREFIX =
    "codex-acp:status:turn:";
export const COMANDO_STATUS_TURN_EVENT_ID_PREFIX = "comando:status:turn:";
export const CODEX_ACP_USER_INPUT_EVENT_TYPE = "user_input_request";
export const CODEX_ACP_USER_INPUT_RESPONSE_PREFIX =
    "__codex_acp_user_input_response__:";
export const SUPPRESSED_STATUS_TITLES = new Set([
    "Preparing input",
    "Drafting response",
    "Reasoning",
]);

export const AI_SESSION_STREAMING_FLUSH_MS = 120;

export interface AiServiceOptions {
    readonly aiWorker?: AiWorkerGateway | null;
    readonly nativeAi?: NativeAiGateway | null;
    readonly aiScheduler?: Partial<AiSchedulerConfig>;
    readonly aiSessionRetention?: Partial<AiSessionRetentionConfig>;
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
    readonly secretStore: SecretStoreGateway;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionEvent?: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly persistence: AiPersistenceGateway;
}

export interface AiSchedulerConfig {
    readonly maxColdStartsGlobal: number;
    readonly maxColdStartsPerRuntime: number;
}

export interface AiSessionRetentionConfig {
    readonly idleTtlMs: number;
    readonly maxHotSessionsPerWindow: number;
}

export type AiSessionFreezeReason =
    | "budget"
    | "runtime_change"
    | "ttl"
    | "window_close";

export type AiSessionFreezeSkippedReason =
    | "active_terminal"
    | "active_turn"
    | "missing"
    | "pending_permission"
    | "pending_review"
    | "pending_user_input";

export interface AiWorkerFreezeSessionRpcInput {
    readonly reason: AiSessionFreezeReason;
    readonly sessionId: string;
}

export interface AiWorkerFreezeSessionResult {
    readonly frozen: boolean;
    readonly reason: AiSessionFreezeReason;
    readonly sessionId: string;
    readonly skippedReason?: AiSessionFreezeSkippedReason;
}

export interface AiWorkerGateway {
    cancelSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
    closeOwnedByWindow(ownerWindowId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    freezeSession(
        input: AiWorkerFreezeSessionRpcInput,
    ): Promise<AiWorkerFreezeSessionResult>;
    keepAllTrackedFiles(input: AiWorkerReviewSessionRpcInput<string>): Promise<AiWorkerReviewMutationResult>;
    keepTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    keepTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    notifyFileBuffer(input: FileBufferNotificationInput): Promise<void>;
    prepareSession(input: AiWorkerPrepareSessionRpcInput): Promise<AiSessionSnapshot>;
    renameSession(input: AiSessionRenameMutationInput): Promise<void>;
    rejectAllTrackedFiles(input: AiWorkerReviewSessionRpcInput<string>): Promise<AiWorkerReviewMutationResult>;
    rejectTrackedFile(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    rejectTrackedFileHunks(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    refreshProjectScopes(input: AiWorkerRefreshProjectScopesRpcInput): Promise<void>;
    respondPermission(input: AiPermissionResponseInput): Promise<void>;
    respondUserInput(input: AiUserInputResponseInput): Promise<void>;
    sendPrompt(input: AiWorkerSendPromptRpcInput): Promise<AiPromptResult>;
    setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void>;
    setSessionMode(input: AiSessionModeMutationInput): Promise<void>;
    setSessionModel(input: AiSessionModelMutationInput): Promise<void>;
}

export interface NativeAiGateway {
    cancelSession(sessionId: string): Promise<void>;
    captureReviewBaseline?(sessionId: string): Promise<boolean>;
    close(): Promise<void> | void;
    closeOwnedByWindow(ownerWindowId: string): Promise<void> | void;
    closeSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    keepAllTrackedFiles?(input: AiWorkerReviewSessionRpcInput<string>): Promise<AiWorkerReviewMutationResult>;
    keepTrackedFile?(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    keepTrackedFileHunks?(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]>;
    listSessionRuntimeMappingsForParent?(
        parentSessionId: string,
    ): Promise<readonly AiWorkerRuntimeSessionMapping[]>;
    loadSessionSnapshot(sessionId: string): Promise<AiSessionSnapshot | null>;
    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage | null>;
    loadReviewState?(sessionId: string): Promise<readonly AiTrackedFile[]>;
    notifyFileBuffer?(input: FileBufferNotificationInput): Promise<void>;
    reconcileTrackedFiles?(sessionId: string): Promise<readonly AiTrackedFile[]>;
    rejectAllTrackedFiles?(input: AiWorkerReviewSessionRpcInput<string>): Promise<AiWorkerReviewMutationResult>;
    rejectTrackedFile?(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    rejectTrackedFileHunks?(
        input: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiWorkerReviewMutationResult>;
    renameSession(input: AiSessionRenameMutationInput): Promise<void>;
    prepareSession(input: NativeAiPrepareSessionRpcInput): Promise<AiSessionSnapshot>;
    respondPermission(input: AiPermissionResponseInput): Promise<void>;
    respondUserInput(input: AiUserInputResponseInput): Promise<void>;
    sendPrompt(input: NativeAiSendPromptRpcInput): Promise<AiPromptResult>;
    setSessionPinned(input: AiSessionPinnedMutationInput): Promise<void>;
    setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void>;
    setSessionMode(input: AiSessionModeMutationInput): Promise<void>;
    setSessionModel(input: AiSessionModelMutationInput): Promise<void>;
    shouldHandleHistory(): boolean;
    shouldHandleReview?(): boolean;
    shouldHandleRuntime(runtimeId: AiRuntimeId): boolean;
}

export interface AiWorkerDesiredSelections {
    readonly configOptions: readonly AiSessionConfigOption[];
    readonly modeId: string | null;
    readonly modelId: string | null;
    readonly preferredConfigOptions: Record<string, boolean | string>;
}

export interface AiWorkerRuntimeSessionMapping {
    readonly appSessionId: string;
    readonly parentAppSessionId: string | null;
    readonly parentRuntimeSessionId: string | null;
    readonly runtimeSessionId: string;
}

export interface AiWorkerSessionLaunchInput {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly desiredSelections: AiWorkerDesiredSelections;
    readonly input: SessionDescriptor;
    readonly ownerWindowId: string;
    readonly persistedSnapshot: AiSessionSnapshot;
    readonly persistedSubagentSessionMappings?: readonly AiWorkerRuntimeSessionMapping[];
    readonly projectRoot: string | null;
    readonly resolvedRuntime: ResolvedAcpRuntime;
}

export interface NativeAiPrepareSessionRpcInput {
    readonly input: SessionDescriptor;
    readonly launch: AiWorkerSessionLaunchInput;
}

export interface NativeAiSendPromptRpcInput {
    readonly input: SendAiPromptInput;
    readonly launch: AiWorkerSessionLaunchInput;
}

export interface AiWorkerReviewSessionContext {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly ownerWindowId: string;
    readonly projectRoot: string | null;
    readonly snapshot: AiSessionSnapshot;
}

export interface AiWorkerReviewMutationResult {
    readonly ownerWindowId: string;
    readonly snapshot: AiSessionSnapshot;
}

export interface AiWorkerReviewSessionRpcInput<TInput> {
    readonly context: AiWorkerReviewSessionContext;
    readonly input: TInput;
}

export interface LiveAcpConnection {
    appSessionIdByRuntimeSessionId: Map<string, string>;
    child: ChildProcessWithoutNullStreams;
    closing: boolean;
    connection: ClientSideConnection;
    connectionId: string;
    ownerWindowId: string;
    pendingSessionUpdatesByRuntimeSessionId: Map<string, SessionNotification[]>;
    persistedSubagentMappingsByRuntimeSessionId: Map<
        string,
        AiWorkerRuntimeSessionMapping
    >;
    resolvedRuntime: ResolvedAcpRuntime;
    runtimeId: AiRuntimeId;
    sessionsByAppSessionId: Map<string, LiveAcpSession>;
    stderrChunks: string[];
    stderrHandler: ((chunk: Buffer | string) => void) | null;
}

export interface LiveAcpSession {
    additionalRoots: readonly string[];
    activeTurnId: string | null;
    child: ChildProcessWithoutNullStreams;
    closing: boolean;
    connection: ClientSideConnection;
    cwd: string;
    desiredSelections: AiWorkerDesiredSelections;
    isRestoring: boolean;
    ownerWindowId: string;
    pendingPermissions: Map<
        string,
        {
            readonly request: AiPermissionRequest;
            readonly resolve: (response: RequestPermissionResponse) => void;
        }
    >;
    pendingPermission: {
        readonly requestId: string;
        readonly resolve: (response: RequestPermissionResponse) => void;
    } | null;
    pendingAdditionalRoots: readonly string[] | null;
    pendingLaunch: AiWorkerSessionLaunchInput | null;
    pendingPersistTimer: ReturnType<typeof setTimeout> | null;
    preEditSnapshots: Map<string, string>;
    processedDiffPaths: Map<string, Set<string>>;
    projectRoot: string | null;
    resolvedRuntime: ResolvedAcpRuntime;
    runtimeConnection: LiveAcpConnection;
    runtimeId: AiRuntimeId;
    snapshot: AiSessionSnapshot;
    terminals: Map<string, LiveAcpTerminal>;
    terminalOutputBuffers: Map<string, string>;
    lastBroadcastSnapshot: AiSessionSnapshot | null;
    stderrChunks: string[];
    stderrHandler: ((chunk: Buffer | string) => void) | null;
}

export interface LiveAcpTerminal {
    child: ChildProcess;
    commandLine: string;
    cwd: string;
    exitStatus: TerminalExitStatus | null;
    output: string;
    outputByteLimit: number;
    released: boolean;
    truncated: boolean;
    waiters: Set<(status: TerminalExitStatus) => void>;
}

export interface ResolvedAcpRuntime {
    readonly args: readonly string[];
    readonly authHandshake?: {
        readonly envMethodId: string;
        readonly externalMethodId: string;
        readonly meta?: Record<string, unknown>;
    };
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

export interface AiWorkerBootstrapState {
    readonly capabilities: {
        readonly fileBufferMirroring: boolean;
        readonly runtimeSessions: boolean;
    };
    readonly protocolVersion: 1;
    readonly startedAt: string;
}

export interface AiWorkerLogEventPayload {
    readonly context?: Record<
        string,
        boolean | number | string | null | undefined
    >;
    readonly level: "debug" | "error" | "info" | "warn";
    readonly message: string;
}

export interface AiWorkerSessionClosedEventPayload {
    readonly ownerWindowId: string;
    readonly sessionId: string;
}

export interface AiWorkerSnapshotUpdatedEventPayload {
    readonly ownerWindowId: string;
    readonly update: AiSessionUpdate;
}

export interface AiWorkerSessionEventPayload {
    readonly event: AiSessionDomainEvent;
    readonly ownerWindowId: string;
}

export interface AiWorkerRuntimeStatusEventPayload {
    readonly status: AiRuntimeStatus;
}

export type AiWorkerEventPayloadByName = {
    "ai.log": AiWorkerLogEventPayload;
    "ai.runtime.status": AiWorkerRuntimeStatusEventPayload;
    "ai.session.event": AiWorkerSessionEventPayload;
    "ai.session.closed": AiWorkerSessionClosedEventPayload;
    "ai.snapshot.updated": AiWorkerSnapshotUpdatedEventPayload;
};

export type AiWorkerEventName = keyof AiWorkerEventPayloadByName;

export type AiWorkerEventMessage = {
    [TEvent in AiWorkerEventName]: {
        readonly event: TEvent;
        readonly payload: AiWorkerEventPayloadByName[TEvent];
        readonly type: "event";
    };
}[AiWorkerEventName];

export interface AiWorkerFatalMessage {
    readonly error: {
        readonly message: string;
        readonly name: string;
        readonly stack?: string;
    };
    readonly type: "fatal";
}

export interface AiWorkerInitMessage {
    readonly port: MessagePort;
}

export interface AiWorkerPrepareSessionRpcInput {
    readonly input: PrepareAiSessionInput;
    readonly launch: AiWorkerSessionLaunchInput;
}

export interface AiWorkerRefreshProjectScopesRpcInput {
    readonly projectId: string;
    readonly sessions: readonly AiWorkerSessionLaunchInput[];
}

export interface AiWorkerReadyMessage {
    readonly bootstrap: AiWorkerBootstrapState;
    readonly type: "ready";
}

export interface AiWorkerRespondPermissionRpcInput {
    readonly input: AiPermissionResponseInput;
}

export interface AiWorkerRespondUserInputRpcInput {
    readonly input: AiUserInputResponseInput;
}

export interface AiWorkerSendPromptRpcInput {
    readonly input: SendAiPromptInput;
    readonly launch: AiWorkerSessionLaunchInput;
}

export interface AiWorkerRpcMethodMap {
    readonly "ai.cancelSession": {
        readonly params: string;
        readonly result: void;
    };
    readonly "ai.closeOwnedByWindow": {
        readonly params: string;
        readonly result: void;
    };
    readonly "ai.closeSession": {
        readonly params: string;
        readonly result: void;
    };
    readonly "ai.freezeSession": {
        readonly params: AiWorkerFreezeSessionRpcInput;
        readonly result: AiWorkerFreezeSessionResult;
    };
    readonly "ai.notifyFileBuffer": {
        readonly params: FileBufferNotificationInput;
        readonly result: void;
    };
    readonly "ai.keepAllTrackedFiles": {
        readonly params: AiWorkerReviewSessionRpcInput<string>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.keepTrackedFile": {
        readonly params: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.keepTrackedFileHunks": {
        readonly params: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.prepareSession": {
        readonly params: AiWorkerPrepareSessionRpcInput;
        readonly result: AiSessionSnapshot;
    };
    readonly "ai.renameSession": {
        readonly params: AiSessionRenameMutationInput;
        readonly result: void;
    };
    readonly "ai.rejectAllTrackedFiles": {
        readonly params: AiWorkerReviewSessionRpcInput<string>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.rejectTrackedFile": {
        readonly params: AiWorkerReviewSessionRpcInput<AiTrackedFileMutationInput>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.rejectTrackedFileHunks": {
        readonly params: AiWorkerReviewSessionRpcInput<AiTrackedFileHunkMutationInput>;
        readonly result: AiWorkerReviewMutationResult;
    };
    readonly "ai.refreshProjectScopes": {
        readonly params: AiWorkerRefreshProjectScopesRpcInput;
        readonly result: void;
    };
    readonly "ai.respondPermission": {
        readonly params: AiWorkerRespondPermissionRpcInput;
        readonly result: void;
    };
    readonly "ai.respondUserInput": {
        readonly params: AiWorkerRespondUserInputRpcInput;
        readonly result: void;
    };
    readonly "ai.sendPrompt": {
        readonly params: AiWorkerSendPromptRpcInput;
        readonly result: AiPromptResult;
    };
    readonly "ai.setSessionConfigOption": {
        readonly params: AiSessionConfigOptionMutationInput;
        readonly result: void;
    };
    readonly "ai.setSessionMode": {
        readonly params: AiSessionModeMutationInput;
        readonly result: void;
    };
    readonly "ai.setSessionModel": {
        readonly params: AiSessionModelMutationInput;
        readonly result: void;
    };
}
