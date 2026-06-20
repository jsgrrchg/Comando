import type {
    NativeMessageId,
    NativeProjectId,
    NativeRuntimeId,
    NativeRuntimeSessionId,
    NativeSessionId,
    NativeToolCallId,
    NativeWorktreeId,
} from "./ids";

export type NativeAiRuntimeId = NativeRuntimeId;
export type NativeAiRuntimeSupportState =
    | "legacy_only"
    | "native_ready"
    | "native_unavailable";

export type NativeAiRuntimeCapabilities = {
    readonly streaming: boolean;
    readonly thinking: boolean;
    readonly tools: boolean;
    readonly planUpdates: boolean;
    readonly permissions: boolean;
    readonly userInput: boolean;
    readonly subagents: boolean;
    readonly resumeSession: boolean;
    readonly loadSession: boolean;
    readonly authTerminal: boolean;
    readonly imageInput: boolean;
    readonly embeddedContext: boolean;
};

export type NativeAiRuntimeDescriptor = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly displayName: string;
    readonly defaultExecutable: string;
    readonly acpArgs: readonly string[];
    readonly nativeReady: boolean;
    readonly legacyReady: boolean;
    readonly supportState: NativeAiRuntimeSupportState;
    readonly message: string | null;
    readonly capabilities: NativeAiRuntimeCapabilities;
};

export type NativeAiListRuntimesOutput = {
    readonly runtimes: readonly NativeAiRuntimeDescriptor[];
};

export type NativeAiSessionStatus =
    | "closed"
    | "error"
    | "idle"
    | "review_required"
    | "streaming"
    | "waiting_permission"
    | "waiting_user_input";

export type NativeAiAuthMethod = {
    readonly id: string;
    readonly name: string;
    readonly description: string;
};

export type NativeAiRuntimeStatus = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly state: string;
    readonly authMethod: string | null;
    readonly authMethods: readonly NativeAiAuthMethod[];
    readonly authReady: boolean;
    readonly checkedAt: string;
    readonly command: string | null;
    readonly message: string | null;
    readonly onboardingRequired: boolean;
    readonly source: string | null;
    readonly hasCustomBinaryPath: boolean;
    readonly hasGatewayConfig: boolean;
    readonly hasGatewayUrl: boolean;
};

export type NativeAiGetRuntimeStatusInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly launch?: NativeAiLaunchSpec | null;
};

export type NativeAiLaunchSpec = {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
    readonly status: NativeAiRuntimeStatus;
};

export type NativeAiPrepareSessionInput = {
    readonly windowId: string;
    readonly sessionId: NativeSessionId;
    readonly runtimeId: NativeRuntimeId;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly cwd: string;
    readonly title: string;
    readonly modelId: string | null;
    readonly modeId: string | null;
    readonly configOptions: Readonly<Record<string, unknown>>;
    readonly additionalRoots: readonly string[];
    readonly launch: NativeAiLaunchSpec | null;
};

export type NativeAiPromptInput = {
    readonly text: string;
    readonly attachments: readonly unknown[];
};

export type NativeAiSendPromptInput = {
    readonly sessionId: NativeSessionId;
    readonly messageId: NativeMessageId;
    readonly prompt: NativeAiPromptInput;
};

export type NativeAiSendPromptOutput = {
    readonly accepted: boolean;
    readonly sessionId: NativeSessionId;
};

export type NativeAiSessionIdInput = {
    readonly sessionId: NativeSessionId;
};

export type NativeAiCancelSessionOutput = {
    readonly cancelled: boolean;
    readonly sessionId: NativeSessionId;
};

export type NativeAiCloseSessionOutput = {
    readonly closed: boolean;
    readonly sessionId: NativeSessionId;
};

export type NativeAiPermissionResponseInput = {
    readonly sessionId: NativeSessionId;
    readonly requestId: string;
    readonly optionId: string | null;
};

export type NativeAiUserInputAnswer = {
    readonly questionId: string;
    readonly answers: readonly string[];
};

export type NativeAiUserInputResponseInput = {
    readonly sessionId: NativeSessionId;
    readonly requestId: string;
    readonly answers: readonly NativeAiUserInputAnswer[];
};

export type NativeAiSetSessionModeInput = {
    readonly sessionId: NativeSessionId;
    readonly modeId: string;
};

export type NativeAiSetSessionModelInput = {
    readonly sessionId: NativeSessionId;
    readonly modelId: string;
};

export type NativeAiSetSessionConfigOptionInput = {
    readonly sessionId: NativeSessionId;
    readonly optionId: string;
    readonly value: unknown;
};

export type NativeAiModelOption = {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
};

export type NativeAiModeOption = NativeAiModelOption;

export type NativeAiConfigOption = {
    readonly id: string;
    readonly label: string;
    readonly category: string;
    readonly type: string;
    readonly value: unknown;
    readonly description: string | null;
};

export type NativeAiSessionSummary = {
    readonly sessionId: NativeSessionId;
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly title: string;
    readonly status: NativeAiSessionStatus;
    readonly updatedAt: string;
};

export type NativeAiEventBase = {
    readonly sessionId: NativeSessionId;
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly updatedAt: string;
};

export type NativeAiSessionCreatedPayload = NativeAiSessionSummary;

export type NativeAiSessionUpdatedPayload = {
    readonly sessionId: NativeSessionId;
    readonly status: NativeAiSessionStatus;
    readonly title: string | null;
    readonly updatedAt: string;
};

export type NativeAiSessionClosedPayload = {
    readonly sessionId: NativeSessionId;
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly updatedAt: string;
};

export type NativeAiRuntimeConnectionPayload = {
    readonly runtimeId: NativeRuntimeId;
    readonly status: string;
    readonly message: string | null;
    readonly updatedAt: string;
};

export type NativeAiStatusEventPayload = NativeAiEventBase & {
    readonly eventId: string;
    readonly status: string;
    readonly title: string;
    readonly detail: string | null;
};

export type NativeAiMessageStartedPayload = NativeAiEventBase & {
    readonly messageId: NativeMessageId;
    readonly messageKind: string;
    readonly content: string;
};

export type NativeAiMessageDeltaPayload = NativeAiEventBase & {
    readonly messageId: NativeMessageId;
    readonly messageKind: string;
    readonly delta: string;
    readonly content: string;
};

export type NativeAiMessageCompletedPayload = NativeAiEventBase & {
    readonly messageId: NativeMessageId;
    readonly messageKind: string;
};

export type NativeAiThinkingDeltaPayload = NativeAiMessageDeltaPayload;
export type NativeAiThinkingStartedPayload = NativeAiMessageStartedPayload;
export type NativeAiThinkingCompletedPayload = NativeAiMessageCompletedPayload;

export type NativeAiToolActivityPayload = NativeAiEventBase & {
    readonly toolCallId: NativeToolCallId;
    readonly title: string;
    readonly kind: string;
    readonly status: string;
    readonly summary: string | null;
};

export type NativeAiPlanEntryPayload = {
    readonly content: string;
    readonly priority: string;
    readonly status: string;
};

export type NativeAiPlanUpdatedPayload = NativeAiEventBase & {
    readonly title: string | null;
    readonly entries: readonly NativeAiPlanEntryPayload[];
};

export type NativeAiPermissionRequestPayload = NativeAiEventBase & {
    readonly requestId: string;
    readonly toolCallId: NativeToolCallId;
    readonly title: string;
    readonly description: string | null;
    readonly options: readonly NativeAiPermissionOptionPayload[];
};

export type NativeAiPermissionOptionPayload = {
    readonly optionId: string;
    readonly name: string;
    readonly kind: string;
};

export type NativeAiUserInputRequestPayload = NativeAiEventBase & {
    readonly requestId: string;
    readonly title: string;
    readonly toolCallId: NativeToolCallId;
    readonly turnId: string | null;
    readonly questions: readonly NativeAiUserInputQuestionPayload[];
};

export type NativeAiUserInputQuestionPayload = {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isOther: boolean;
    readonly isSecret: boolean;
    readonly options: readonly NativeAiUserInputQuestionOptionPayload[];
};

export type NativeAiUserInputQuestionOptionPayload = {
    readonly label: string;
    readonly description: string | null;
};

export type NativeAiTokenUsagePayload = NativeAiEventBase & {
    readonly used: number;
    readonly size: number;
    readonly cost: { readonly amount: number; readonly currency: string } | null;
};

export type NativeAiTrackedFileSummary = {
    readonly path: string;
    readonly previousPath: string | null;
    readonly status: string;
    readonly updatedAt: string;
};

export type NativeAiErrorPayload = {
    readonly sessionId: NativeSessionId | null;
    readonly runtimeId: NativeRuntimeId | null;
    readonly message: string;
    readonly recoverable: boolean;
    readonly updatedAt: string;
};
