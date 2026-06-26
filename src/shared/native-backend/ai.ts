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

export type NativeAiCredentialSource =
    | "comando-secret"
    | "environment"
    | "external-runtime"
    | "none";

export type NativeAiRuntimeStatus = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly state: string;
    readonly authMethod: string | null;
    readonly authMethods: readonly NativeAiAuthMethod[];
    readonly authReady: boolean;
    readonly authCredentialSource?: NativeAiCredentialSource | null;
    readonly authCredentialSourceLabel?: string | null;
    readonly authSessionMessage?: string | null;
    readonly authStorageMessage?: string | null;
    readonly canDisconnectAuth?: boolean;
    readonly canLogoutAuth?: boolean;
    readonly checkedAt: string;
    readonly command: string | null;
    readonly availableCommands?: readonly unknown[];
    readonly configOptions?: readonly unknown[];
    readonly message: string | null;
    readonly modeId?: string | null;
    readonly modes?: readonly unknown[];
    readonly modelId?: string | null;
    readonly models?: readonly unknown[];
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

export type NativeSecretStorageStatus = {
    readonly backend: string;
    readonly available: boolean;
    readonly weak: boolean;
    readonly message: string | null;
    readonly platform: string;
};

export type NativeSecretSetInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly envKey: string;
    readonly value: string;
};

export type NativeSecretDeleteInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly envKey: string;
};

export type NativeSecretMutationOutput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly envKey: string;
    readonly present: boolean;
};

export type NativeSecretPatchAction = "delete" | "set";

export type NativeAiSecretPatch = {
    readonly envKey: string;
    readonly action: NativeSecretPatchAction;
    readonly value?: string | null;
};

export type NativeAiRuntimeSettingsPatch = {
    readonly binaryPath?: string | null;
    readonly authMethod?: string | null;
    readonly authInvalidatedAtMs?: number | null;
    readonly gatewayBaseUrl?: string | null;
    readonly bedrockGatewayBaseUrl?: string | null;
    readonly nonSecretEnv?: Readonly<Record<string, string>>;
};

export type NativeAiSaveRuntimeSettingsInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly settings: NativeAiRuntimeSettingsPatch;
    readonly secretPatches?: readonly NativeAiSecretPatch[];
};

export type NativeAiRuntimeStatusOutput = {
    readonly status: NativeAiRuntimeStatus;
};

export type NativeAiLaunchRuntimeAuthInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly methodId: string;
    readonly windowId: string;
    readonly projectId?: NativeProjectId | null;
    readonly worktreeId?: NativeWorktreeId | null;
    readonly cwd?: string | null;
    readonly cols?: number | null;
    readonly rows?: number | null;
};

export type NativeAiLaunchRuntimeAuthOutput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly methodId: string;
    readonly terminalSessionId: string | null;
    readonly status: NativeAiRuntimeStatus;
};

export type NativeAiRuntimeAuthInput = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly cwd?: string | null;
};

export type NativeAiAuthHandshakeSpec = {
    readonly envMethodId: string;
    readonly externalMethodId: string;
    readonly meta: Readonly<Record<string, unknown>>;
};

export type NativeAiDesiredSelections = {
    readonly modelId: string | null;
    readonly modeId: string | null;
    readonly configOptions: Readonly<Record<string, unknown>>;
};

export type NativeAiRuntimeSessionMapping = {
    readonly appSessionId: NativeSessionId;
    readonly parentAppSessionId: NativeSessionId | null;
    readonly parentRuntimeSessionId: NativeRuntimeSessionId | null;
    readonly runtimeSessionId: NativeRuntimeSessionId;
};

export type NativeAiLaunchSpec = {
    readonly runtimeId: NativeAiRuntimeId;
    readonly ownerWindowId: string;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly projectRoot: string | null;
    readonly additionalRoots: readonly string[];
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
    readonly status: NativeAiRuntimeStatus;
    readonly authMethod: string | null;
    readonly authCredentialSource: string | null;
    readonly authHandshake: NativeAiAuthHandshakeSpec | null;
    readonly persistedRuntimeSessionId: NativeRuntimeSessionId | null;
    readonly persistedSubagentSessionMappings: readonly NativeAiRuntimeSessionMapping[];
    readonly desiredSelections: NativeAiDesiredSelections;
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
    readonly persistedRuntimeSessionId?: NativeRuntimeSessionId | null;
    readonly persistedSubagentSessionMappings?: readonly NativeAiRuntimeSessionMapping[];
    readonly launch: NativeAiLaunchSpec | null;
};

export type NativeAiPromptInput = {
    readonly text: string;
    readonly displayText?: string | null;
    readonly attachments: readonly NativeAiImageAttachment[];
};

export type NativeAiImageAttachment = {
    readonly id: string;
    readonly dataBase64: string;
    readonly mimeType: string;
    readonly name: string | null;
    readonly sizeBytes: number | null;
};

export type NativeAiSendPromptInput = {
    readonly sessionId: NativeSessionId;
    readonly targetSessionId: NativeSessionId | null;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly messageId: NativeMessageId;
    readonly prompt: NativeAiPromptInput;
};

export type NativeAiSendPromptOutput = {
    readonly accepted: boolean;
    readonly sessionId: NativeSessionId;
};

export type NativeAiSessionIdInput = {
    readonly sessionId: NativeSessionId;
    readonly targetSessionId: NativeSessionId | null;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
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
    readonly targetSessionId: NativeSessionId | null;
    readonly requestId: string;
    readonly optionId: string | null;
};

export type NativeAiUserInputAnswer = {
    readonly questionId: string;
    readonly answers: readonly string[];
};

export type NativeAiUserInputResponseInput = {
    readonly sessionId: NativeSessionId;
    readonly targetSessionId: NativeSessionId | null;
    readonly requestId: string;
    readonly answers: readonly NativeAiUserInputAnswer[];
};

export type NativeAiSetSessionModeInput = {
    readonly sessionId: NativeSessionId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly modeId: string;
};

export type NativeAiSetSessionModelInput = {
    readonly sessionId: NativeSessionId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly modelId: string;
};

export type NativeAiSetSessionConfigOptionInput = {
    readonly sessionId: NativeSessionId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
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

export type NativeAiListSessionHistoryInput = {
    readonly projectId: NativeProjectId | null;
    readonly worktreeId?: NativeWorktreeId | null;
    readonly limit?: number | null;
};

export type NativeAiHistorySessionSummary = {
    readonly sessionId: NativeSessionId;
    readonly parentSessionId: NativeSessionId | null;
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly title: string;
    readonly preview: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly pinnedAt: string | null;
    readonly messageCount: number;
};

export type NativeAiLoadSessionTranscriptPageInput = {
    readonly sessionId: NativeSessionId;
    readonly offset: number;
    readonly limit: number;
};

export type NativeAiSessionTranscriptPage = {
    readonly sessionId: NativeSessionId;
    readonly offset: number;
    readonly totalMessages: number;
    readonly messages: readonly unknown[];
};

export type NativeAiLoadSessionSnapshotInput = {
    readonly sessionId: NativeSessionId;
};

export type NativeAiListSessionRuntimeMappingsInput = {
    readonly parentSessionId: NativeSessionId;
};

export type NativeAiSessionSnapshot = {
    readonly sessionId: NativeSessionId;
    readonly parentSessionId: NativeSessionId | null;
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly title: string;
    readonly status: NativeAiSessionStatus;
    readonly updatedAt: string;
    readonly activeTurnStartedAt: string | null;
    readonly closedAt: string | null;
    readonly lastError: string | null;
    readonly modeId: string | null;
    readonly modelId: string | null;
    readonly pendingPermission: unknown;
    readonly pendingUserInput: unknown;
    readonly plan: unknown;
    readonly tokenUsage: unknown;
    readonly availableCommands: readonly unknown[];
    readonly configOptions: readonly unknown[];
    readonly messages: readonly unknown[];
    readonly modes: readonly unknown[];
    readonly models: readonly unknown[];
    readonly toolActivity: readonly unknown[];
    readonly trackedFiles: readonly unknown[];
};

export type NativeAiSetSessionPinnedInput = {
    readonly sessionId: NativeSessionId;
    readonly pinned: boolean;
};

export type NativeAiDeleteSessionInput = {
    readonly sessionId: NativeSessionId;
};

export type NativeAiRenameSessionInput = {
    readonly sessionId: NativeSessionId;
    readonly title: string;
};

export type NativeAiMigrateSessionHistoryInput = {
    readonly sourceDatabasePath?: string | null;
    readonly mode?: string | null;
    readonly limit?: number | null;
};

export type NativeAiHistoryMigrationError = {
    readonly sessionId: NativeSessionId | null;
    readonly message: string;
};

export type NativeAiMigrateSessionHistoryOutput = {
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly completedAt: string | null;
    readonly migratedSessions: number;
    readonly skippedSessions: number;
    readonly failedSessions: number;
    readonly errors: readonly NativeAiHistoryMigrationError[];
};

export type NativeAiHistoryStorageHealth = {
    readonly healthy: boolean;
    readonly storageVersion: number;
    readonly nativeSessionCount: number;
    readonly legacyFallbackAvailable: boolean;
    readonly migrationManifestExists: boolean;
    readonly orphanedSessionDirs: number;
    readonly latestError: string | null;
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
    readonly runtimeId: NativeRuntimeId;
    readonly runtimeSessionId: NativeRuntimeSessionId | null;
    readonly status: NativeAiSessionStatus;
    readonly title: string | null;
    readonly updatedAt: string;
};

export type NativeAiSubagentCreatedPayload = NativeAiEventBase & {
    readonly childSessionId: NativeSessionId;
    readonly childRuntimeSessionId: NativeRuntimeSessionId;
    readonly parentSessionId: NativeSessionId;
    readonly parentRuntimeSessionId: NativeRuntimeSessionId | null;
    readonly modelId?: string | null;
    readonly title: string;
};

export type NativeAiSubagentBreadcrumbPayload = NativeAiEventBase & {
    readonly childSessionId: NativeSessionId;
    readonly childRuntimeSessionId: NativeRuntimeSessionId;
    readonly toolCallId: NativeToolCallId;
};

export type NativeAiSessionCatalogUpdatedPayload = NativeAiEventBase & {
    readonly availableCommands?: readonly NativeAiAvailableCommandPayload[] | null;
    readonly configOptions?: readonly NativeAiSessionConfigOptionPayload[] | null;
    readonly modeId?: string | null;
};

export type NativeAiAvailableCommandPayload = {
    readonly description: string;
    readonly name: string;
};

export type NativeAiSessionConfigOptionPayload =
    | {
          readonly category: string | null;
          readonly currentValue: boolean;
          readonly description: string | null;
          readonly id: string;
          readonly name: string;
          readonly options: null;
          readonly type: "boolean";
      }
    | {
          readonly category: string | null;
          readonly currentValue: string;
          readonly description: string | null;
          readonly id: string;
          readonly name: string;
          readonly options: readonly NativeAiSessionConfigSelectEntryPayload[];
          readonly type: "select";
      };

export type NativeAiSessionConfigSelectEntryPayload = {
    readonly description: string | null;
    readonly groupLabel: string | null;
    readonly name: string;
    readonly value: string;
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

export type NativeAiGeneratedImage = {
    readonly error: string | null;
    readonly mimeType: string | null;
    readonly path: string | null;
    readonly result: string | null;
    readonly revisedPrompt: string | null;
    readonly status: string;
    readonly title: string;
};

export type NativeAiImageMessage = {
    readonly attachments: readonly NativeAiImageAttachment[];
    readonly content: string;
    readonly createdAt: string;
    readonly generatedImage: NativeAiGeneratedImage;
    readonly id: string;
    readonly kind: "image";
    readonly status: "completed" | "streaming";
};

export type NativeAiImageGenerationPayload = NativeAiEventBase & {
    readonly message: NativeAiImageMessage;
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
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly diffs?: readonly unknown[];
    readonly terminalOutput?: string | null;
    readonly exitCode?: number | null;
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

export type NativeAiReviewUpdatedPayload = NativeAiEventBase & {
    readonly projectId: NativeProjectId | null;
    readonly worktreeId: NativeWorktreeId | null;
    readonly trackedFiles: readonly unknown[];
    readonly conflicts: readonly unknown[];
    readonly pendingCount: number;
    readonly conflictCount: number;
};

export type NativeAiTrackedFileUpdatedPayload = {
    readonly sessionId: NativeSessionId;
    readonly trackedFile: unknown;
    readonly mutation: string;
    readonly updatedAt: string;
};

export type NativeAiReviewCaptureOutput = {
    readonly captured: boolean;
    readonly sessionId: NativeSessionId;
    readonly updatedAt: string;
};

export type NativeAiReviewExactDiffInput = {
    readonly path: string;
    readonly previousPath?: string | null;
    readonly oldText?: string | null;
    readonly newText?: string | null;
    readonly isText?: boolean;
};

export type NativeAiReviewRecordDiffsInput = {
    readonly sessionId: NativeSessionId;
    readonly reviewRoot?: string | null;
    readonly toolCallId?: NativeToolCallId | null;
    readonly updatedAt?: string | null;
    readonly diffs: readonly NativeAiReviewExactDiffInput[];
};

export type NativeAiReviewCommandOutput = {
    readonly sessionId: NativeSessionId;
    readonly trackedFiles: readonly unknown[];
    readonly changedFiles: readonly string[];
    readonly conflicts: readonly unknown[];
    readonly updatedAt: string;
    readonly stateFound?: boolean;
};

export type NativeAiErrorPayload = {
    readonly sessionId: NativeSessionId | null;
    readonly runtimeId: NativeRuntimeId | null;
    readonly message: string;
    readonly recoverable: boolean;
    readonly updatedAt: string;
};
