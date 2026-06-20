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
};

export type NativeAiUserInputRequestPayload = NativeAiEventBase & {
    readonly requestId: string;
    readonly title: string;
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
