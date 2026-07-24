import type {
    AiPermissionResponseInput,
    AiHistorySessionSummary,
    AiHistoryMigrationInput,
    AiHistoryMigrationResult,
    AiHistoryStorageHealth,
    AiOpenTranscriptTail,
    AiOpenTranscriptTailCheckpoint,
    AiPromptResult,
    AiPromptQueueSnapshot,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionRenameMutationInput,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiRuntimeId,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeStatus,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionUpdate,
    AiSessionTranscriptPage,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptBlockMetadataOutput,
    AiTranscriptCapability,
    AiTranscriptEntryEnvelope,
    AiLoadTranscriptPayloadInput,
    AiLoadTranscriptPayloadsInput,
    AiLoadToolActivityDetailInput,
    AiTranscriptPayload,
    AiTranscriptPayloadsOutput,
    AiTranscriptStorageState,
    AiReconcileTerminalOpenTranscriptTailInput,
    AiSealTranscriptTurnInput,
    AiUserInputResponseInput,
    FileBufferNotificationInput,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
    PrepareAiSessionInput,
    SendAiPromptInput,
} from "@shared/ipc";
import type {
    NativeReviewDeltaReference,
    NativeReviewLoadDeltaOutput,
} from "@shared/native-backend";

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
export const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY =
    "codexAcpSubagentEventType";
export const CODEX_ACP_PARENT_SESSION_ID_KEY = "codexAcpParentSessionId";
export const CODEX_ACP_PARENT_THREAD_ID_KEY = "codexAcpParentThreadId";
export const CODEX_ACP_CHILD_SESSION_ID_KEY = "codexAcpChildSessionId";
export const CODEX_ACP_CHILD_THREAD_ID_KEY = "codexAcpChildThreadId";
export const CODEX_ACP_AGENT_PATH_KEY = "codexAcpAgentPath";
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
export const CODEX_ACP_USER_INPUT_RESPONSE_PREFIX =
    "__codex_acp_user_input_response__:";
export const SUPPRESSED_STATUS_TITLES = new Set([
    "Preparing input",
    "Drafting response",
    "Reasoning",
]);

export const AI_SESSION_STREAMING_FLUSH_MS = 120;

export interface AiServiceOptions {
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
    readonly onPromptQueueSnapshot?: (
        ownerWindowId: string,
        snapshot: AiPromptQueueSnapshot,
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

export interface NativeAiGateway {
    appendTranscriptEntries?(
        sessionId: string,
        entries: readonly AiTranscriptEntryEnvelope[],
    ): Promise<void>;
    checkpointOpenTranscriptTail?(
        input: AiOpenTranscriptTailCheckpoint,
    ): Promise<void>;
    cancelSession(sessionId: string): Promise<void>;
    captureReviewBaseline?(sessionId: string): Promise<boolean>;
    close(): Promise<void> | void;
    closeOwnedByWindow(ownerWindowId: string): Promise<void> | void;
    closeSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]>;
    listSessionRuntimeMappingsForParent?(
        parentSessionId: string,
    ): Promise<readonly AiRuntimeSessionMapping[]>;
    loadSessionSnapshot(sessionId: string): Promise<AiSessionSnapshot | null>;
    loadReviewDelta?(
        reference: NativeReviewDeltaReference,
    ): Promise<NativeReviewLoadDeltaOutput>;
    loadToolActivityDetail?(
        input: AiLoadToolActivityDetailInput,
    ): Promise<unknown>;
    loadOpenTranscriptTail?(
        sessionId: string,
    ): Promise<AiOpenTranscriptTail | null>;
    loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage | null>;
    loadTranscriptBlock?(sessionId: string, blockId: string): Promise<AiTranscriptBlock | null>;
    getHistoryStorageHealth?(): Promise<AiHistoryStorageHealth>;
    getTranscriptCapability?(): AiTranscriptCapability;
    getTranscriptStorageState?(sessionId: string): Promise<AiTranscriptStorageState>;
    loadTranscriptBlockMetadata?(sessionId: string): Promise<AiTranscriptBlockMetadataOutput>;
    loadTranscriptPayload?(input: AiLoadTranscriptPayloadInput): Promise<AiTranscriptPayload>;
    loadTranscriptPayloads?(input: AiLoadTranscriptPayloadsInput): Promise<AiTranscriptPayloadsOutput>;
    migrateSessionHistory?(input: AiHistoryMigrationInput): Promise<AiHistoryMigrationResult>;
    getRuntimeStatus?(runtimeId: AiRuntimeId): Promise<AiRuntimeStatus>;
    saveRuntimeSettings?(input: NativeAiRuntimeSettingsRpcInput): Promise<AiRuntimeStatus>;
    launchRuntimeAuth?(input: AiRuntimeAuthLaunchInput): Promise<void>;
    logoutRuntimeAuth?(input: AiRuntimeAuthLogoutInput): Promise<AiRuntimeStatus>;
    disconnectRuntimeAuth?(input: AiRuntimeAuthDisconnectInput): Promise<AiRuntimeStatus>;
    notifyFileBuffer?(input: FileBufferNotificationInput): Promise<void>;
    rejectAllTrackedFiles?(input: AiReviewSessionRpcInput<string>): Promise<AiReviewMutationResult>;
    rejectTrackedFile?(
        input: AiReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiReviewMutationResult>;
    rejectTrackedFileHunks?(
        input: AiReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiReviewMutationResult>;
    renameSession(input: AiSessionRenameMutationInput): Promise<void>;
    prepareSession(input: NativeAiPrepareSessionRpcInput): Promise<AiSessionSnapshot>;
    respondPermission(input: AiPermissionResponseInput): Promise<void>;
    respondUserInput(input: AiUserInputResponseInput): Promise<void>;
    sealTranscriptTurn?(
        input: AiSealTranscriptTurnInput,
    ): Promise<readonly AiTranscriptBlockMetadata[]>;
    reconcileTerminalOpenTranscriptTail?(
        input: AiReconcileTerminalOpenTranscriptTailInput,
    ): Promise<readonly AiTranscriptBlockMetadata[]>;
    sendPrompt(input: NativeAiSendPromptRpcInput): Promise<AiPromptResult>;
    setSessionPinned(input: AiSessionPinnedMutationInput): Promise<void>;
    setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void>;
    setSessionMode(input: AiSessionModeMutationInput): Promise<void>;
    setSessionModel(input: AiSessionModelMutationInput): Promise<void>;
    shouldHandleHistory(): boolean;
    shouldHandleReview?(): boolean;
    shouldHandleReviewDiskMutations?(): boolean;
    shouldHandleRuntime(runtimeId: AiRuntimeId): boolean;
}

export interface NativeAiSecretPatchRpcInput {
    readonly action: "delete" | "set";
    readonly envKey: string;
    readonly value?: string | null;
}

export interface NativeAiRuntimeSettingsRpcInput {
    readonly runtimeId: AiRuntimeId;
    readonly settings: {
        readonly authInvalidatedAtMs?: number | null;
        readonly authMethod?: string | null;
        readonly bedrockGatewayBaseUrl?: string | null;
        readonly binaryPath?: string | null;
        readonly gatewayBaseUrl?: string | null;
        readonly nonSecretEnv?: Readonly<Record<string, string>>;
    };
    readonly secretPatches?: readonly NativeAiSecretPatchRpcInput[];
}

export interface AiDesiredSelections {
    readonly configOptions: readonly AiSessionConfigOption[];
    readonly modeId: string | null;
    readonly modelId: string | null;
}

export interface AiRuntimeSessionMapping {
    readonly appSessionId: string;
    readonly parentAppSessionId: string | null;
    readonly parentRuntimeSessionId: string | null;
    readonly runtimeSessionId: string;
}

export interface AiSessionLaunchInput {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly desiredSelections: AiDesiredSelections;
    readonly input: SessionDescriptor;
    readonly ownerWindowId: string;
    readonly persistedSnapshot: AiSessionSnapshot;
    readonly persistedSubagentSessionMappings?: readonly AiRuntimeSessionMapping[];
    readonly projectRoot: string | null;
    readonly resolvedRuntime: ResolvedAcpRuntime;
}

export interface NativeAiPrepareSessionRpcInput {
    readonly input: SessionDescriptor;
    readonly launch: AiSessionLaunchInput;
}

export interface NativeAiSendPromptRpcInput {
    readonly input: SendAiPromptInput;
    readonly launch: AiSessionLaunchInput;
}

export interface AiReviewSessionContext {
    readonly additionalRoots: readonly string[];
    readonly cwd: string;
    readonly ownerWindowId: string;
    readonly projectRoot: string | null;
    readonly snapshot: AiSessionSnapshot;
}

export interface AiReviewMutationResult {
    readonly ownerWindowId: string;
    readonly snapshot: AiSessionSnapshot;
}

export interface AiReviewSessionRpcInput<TInput> {
    readonly context: AiReviewSessionContext;
    readonly input: TInput;
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


export type SessionDescriptor = Pick<
    PrepareAiSessionInput,
    "projectId" | "runtimeId" | "sessionId" | "title" | "worktreeId"
> & {
    readonly additionalRoots?: readonly string[];
};
