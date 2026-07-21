import type {
    AiHistorySessionSummary,
    AiHistoryMigrationInput,
    AiHistoryMigrationResult,
    AiHistoryStorageHealth,
    AiMessage,
    AiOpenTranscriptTail,
    AiOpenTranscriptTailCheckpoint,
    AiPermissionResponseInput,
    AiPromptResult,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOptionMutationInput,
    AiSessionDomainEvent,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionStatus,
    AiSessionTranscriptPage,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptBlockMetadataOutput,
    AiTranscriptCapability,
    AiTranscriptEntryEnvelope,
    AiLoadTranscriptPayloadInput,
    AiLoadTranscriptPayloadsInput,
    AiTranscriptPayload,
    AiTranscriptPayloadsOutput,
    AiTranscriptStorageState,
    AiSealTranscriptTurnInput,
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    FileBufferNotificationInput,
    GetAiSessionTranscriptPageInput,
    ListAiSessionHistoryInput,
} from "@shared/ipc";
import { AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX } from "@shared/ipc";
import {
    getNativeAiTranscriptBlockCapabilityVersion,
    NATIVE_AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION,
    nativeAiCatalogPatchToIpc,
    nativeAiEventToIpc,
    nativeAiRuntimeStatusToIpc,
    nativeReviewTrackedFileToIpc,
    type NativeAiCatalogPatch,
    type NativeAiCancelSessionOutput,
    type NativeAiCloseSessionOutput,
    type NativeAiHistorySessionSummary,
    type NativeAiHistoryStorageHealth,
    type NativeAiMigrateSessionHistoryOutput,
    type NativeAiLaunchRuntimeAuthOutput,
    type NativeAiReviewCaptureOutput,
    type NativeAiReviewCommandOutput,
    type NativeReviewDeltaReference,
    type NativeReviewLoadDeltaOutput,
    type NativeAiRuntimeSessionMapping,
    type NativeAiSessionSnapshot,
    type NativeAiSessionTranscriptPage,
    type NativeAiTranscriptBlock,
    type NativeAiTranscriptBlockMetadata,
    type NativeAiTranscriptBlockMetadataOutput,
    type NativeAiTranscriptPayload,
    type NativeAiTranscriptPayloadsOutput,
    type NativeAiTranscriptStorageState,
    type NativeCapabilitySet,
    type NativeAiRuntimeConnectionPayload,
    type NativeAiRuntimeStatus,
    type NativeAiSendPromptOutput,
    type NativeAiSessionCatalogUpdatedPayload,
    type NativeAiSessionSummary,
    type NativeBackendEvent,
} from "@shared/native-backend";

import { AI_SESSION_BUSY_MESSAGE } from "@shared/ai-errors";
import type {
    AiReviewMutationResult,
    AiReviewSessionRpcInput,
    AiRuntimeSessionMapping,
    NativeAiGateway as NativeAiGatewayContract,
    NativeAiPrepareSessionRpcInput,
    NativeAiRuntimeSettingsRpcInput,
    NativeAiSendPromptRpcInput,
} from "@main/ai/contracts";
import { isAiTrackedFileUnresolved } from "@shared/ai-tracked-file";
import { serializeComposerPartsForDisplay } from "@main/ai/session-core";
import { NativeBackendError } from "./client";
import type { NativeBackendRequester } from "./persistence";

type NativeAiClient = NativeBackendRequester & {
    onEvent(listener: (event: NativeBackendEvent) => void): () => void;
};

export interface NativeAiGatewayOptions {
    readonly capabilities?: NativeCapabilitySet | null;
    readonly client: NativeAiClient;
    readonly onDiagnostic?: (message: string) => void;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionEvent: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly onSessionCatalogPatch?: (
        ownerWindowId: string,
        sessionId: string,
        patch: NativeAiCatalogPatch,
        updatedAt: string,
    ) => void;
}

const DEFAULT_NATIVE_AI_RUNTIME_IDS = new Set<AiRuntimeId>([
    "claude",
    "codex",
    "grok",
    "kilo",
    "opencode",
]);

export class NativeAiGateway implements NativeAiGatewayContract {
    readonly #client: NativeAiClient;
    readonly #disposeEventListener: () => void;
    readonly #enabledRuntimeIds: ReadonlySet<AiRuntimeId>;
    readonly #historyEnabled: boolean;
    readonly #transcriptBlockCapabilityVersion: number | null;
    readonly #transcriptPayloadBatchEnabled: boolean;
    readonly #onDiagnostic?: (message: string) => void;
    readonly #onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly #onSessionEvent: (
        ownerWindowId: string,
        event: AiSessionDomainEvent,
    ) => void;
    readonly #onSessionCatalogPatch?: (
        ownerWindowId: string,
        sessionId: string,
        patch: NativeAiCatalogPatch,
        updatedAt: string,
    ) => void;
    readonly #reviewEnabled: boolean;
    readonly #runtimeSessionIds = new Map<string, string | null>();
    readonly #sessionOwners = new Map<string, string>();
    readonly #sessionRuntimeIds = new Map<string, AiRuntimeId>();
    readonly #subagentParentSessionIds = new Map<string, string>();

    constructor(options: NativeAiGatewayOptions) {
        this.#client = options.client;
        this.#enabledRuntimeIds = DEFAULT_NATIVE_AI_RUNTIME_IDS;
        this.#historyEnabled = true;
        this.#transcriptBlockCapabilityVersion =
            getNativeAiTranscriptBlockCapabilityVersion(options.capabilities);
        this.#transcriptPayloadBatchEnabled = Boolean(
            options.capabilities?.commands.includes(
                "ai_load_transcript_payloads",
            ),
        );
        this.#reviewEnabled = true;
        this.#onDiagnostic = options.onDiagnostic;
        this.#onRuntimeStatus = options.onRuntimeStatus;
        this.#onSessionEvent = options.onSessionEvent;
        this.#onSessionCatalogPatch = options.onSessionCatalogPatch;
        this.#disposeEventListener = this.#client.onEvent((event) => {
            this.#handleNativeEvent(event);
        });
    }

    shouldHandleRuntime(runtimeId: AiRuntimeId): boolean {
        return this.#enabledRuntimeIds.has(runtimeId);
    }

    getTranscriptCapability(): AiTranscriptCapability {
        return {
            blockNativeVersion: this.#transcriptBlockCapabilityVersion,
            legacyFallbackAvailable: true,
        };
    }

    async getRuntimeStatus(runtimeId: AiRuntimeId): Promise<AiRuntimeStatus> {
        const status = await this.#client.request<NativeAiRuntimeStatus>(
            "ai_get_runtime_status",
            { runtimeId },
        );
        return nativeAiRuntimeStatusToIpc(status);
    }

    async saveRuntimeSettings(
        input: NativeAiRuntimeSettingsRpcInput,
    ): Promise<AiRuntimeStatus> {
        const status = await this.#client.request<NativeAiRuntimeStatus>(
            "ai_save_runtime_settings",
            {
                runtimeId: input.runtimeId,
                settings: input.settings,
                secretPatches: input.secretPatches ?? [],
            },
        );
        return nativeAiRuntimeStatusToIpc(status);
    }

    async launchRuntimeAuth(input: AiRuntimeAuthLaunchInput): Promise<void> {
        const output =
            await this.#client.request<NativeAiLaunchRuntimeAuthOutput>(
                "ai_launch_runtime_auth",
                {
                    cols: null,
                    cwd: null,
                    methodId: input.methodId,
                    projectId: input.projectId ?? null,
                    rows: null,
                    runtimeId: input.runtimeId,
                    windowId: input.ownerWindowId ?? "auth",
                    worktreeId: input.worktreeId ?? null,
                },
            );
        this.#onRuntimeStatus(nativeAiRuntimeStatusToIpc(output.status));
    }

    async logoutRuntimeAuth(
        input: AiRuntimeAuthLogoutInput,
    ): Promise<AiRuntimeStatus> {
        const status = await this.#client.request<NativeAiRuntimeStatus>(
            "ai_logout_runtime_auth",
            {
                projectId: input.projectId ?? null,
                runtimeId: input.runtimeId,
                windowId: input.ownerWindowId ?? "auth",
                worktreeId: input.worktreeId ?? null,
            },
        );
        return nativeAiRuntimeStatusToIpc(status);
    }

    async disconnectRuntimeAuth(
        input: AiRuntimeAuthDisconnectInput,
    ): Promise<AiRuntimeStatus> {
        const status = await this.#client.request<NativeAiRuntimeStatus>(
            "ai_disconnect_runtime_auth",
            {
                runtimeId: input.runtimeId,
            },
        );
        return nativeAiRuntimeStatusToIpc(status);
    }

    shouldHandleHistory(): boolean {
        return this.#historyEnabled;
    }

    shouldHandleReview(): boolean {
        return this.#reviewEnabled;
    }

    shouldHandleReviewDiskMutations(): boolean {
        return this.#reviewEnabled;
    }

    async notifyFileBuffer(input: FileBufferNotificationInput): Promise<void> {
        if (!this.#reviewEnabled) {
            return;
        }
        await this.#client.request("ai_notify_file_buffer", {
            absolutePath: input.absolutePath,
            content: input.content,
        });
    }

    async captureReviewBaseline(sessionId: string): Promise<boolean> {
        if (!this.#reviewEnabled) {
            return false;
        }
        const output = await this.#client.request<NativeAiReviewCaptureOutput>(
            "ai_capture_review_baseline",
            { sessionId },
        );
        return output.captured === true;
    }

    async loadReviewDelta(
        reference: NativeReviewDeltaReference,
    ): Promise<NativeReviewLoadDeltaOutput> {
        if (!this.#reviewEnabled) {
            throw new Error("Native AI review is not enabled.");
        }
        return await this.#client.request<NativeReviewLoadDeltaOutput>(
            "ai_load_review_delta",
            { reference },
        );
    }

    async rejectTrackedFile(
        input: AiReviewSessionRpcInput<AiTrackedFileMutationInput>,
    ): Promise<AiReviewMutationResult> {
        const trackedFile = nativeReviewTrackedFileForInput(input);
        const reference = nativeReviewReferenceForTrackedFile(
            input.context.snapshot,
            trackedFile,
        );
        await this.#requestReviewDiskMutation(input, "ai_reject_tracked_file", {
            expectedVersion:
                input.input.expectedVersion ?? trackedFile.version ?? null,
            ...(reference ? { reference } : {}),
            trackedFile,
        });
        return reviewMutationResultFromContext(input);
    }

    async rejectTrackedFileHunks(
        input: AiReviewSessionRpcInput<AiTrackedFileHunkMutationInput>,
    ): Promise<AiReviewMutationResult> {
        const trackedFile = nativeReviewTrackedFileForInput(input);
        const reference = nativeReviewReferenceForTrackedFile(
            input.context.snapshot,
            trackedFile,
        );
        await this.#requestReviewDiskMutation(input, "ai_reject_tracked_file_hunks", {
            expectedVersion:
                input.input.expectedVersion ?? trackedFile.version ?? null,
            hunkIds: input.input.hunkIds,
            ...(reference ? { reference } : {}),
            trackedFile,
        });
        return reviewMutationResultFromContext(input);
    }

    async rejectAllTrackedFiles(
        input: AiReviewSessionRpcInput<string>,
    ): Promise<AiReviewMutationResult> {
        await this.#requestReviewDiskMutation(input, "ai_reject_all_tracked_files", {
            trackedFiles: input.context.snapshot.trackedFiles.filter(
                (file) =>
                    isAiTrackedFileUnresolved(file) && file.reversible,
            ),
        });
        return reviewMutationResultFromContext(input);
    }

    async #requestReviewDiskMutation<TInput>(
        input: AiReviewSessionRpcInput<TInput>,
        command:
            | "ai_reject_all_tracked_files"
            | "ai_reject_tracked_file"
            | "ai_reject_tracked_file_hunks",
        args: Record<string, unknown>,
    ): Promise<NativeAiReviewCommandOutput> {
        if (!this.#reviewEnabled) {
            throw new Error("Native AI review is not enabled.");
        }
        return await this.#client.request<NativeAiReviewCommandOutput>(
            command,
            {
                ...args,
                reviewRoot: input.context.projectRoot ?? null,
                sessionId: input.context.snapshot.sessionId,
            },
        );
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        if (!this.#historyEnabled) {
            return [];
        }
        const output = await this.#client.request<unknown>(
            "ai_list_session_history",
            {
                limit: input.limit ?? null,
                projectId: input.projectId,
                worktreeId: input.worktreeId ?? null,
            },
        );
        if (!Array.isArray(output)) {
            throw new Error("Native AI history list must be an array.");
        }
        return output.map((entry) =>
            nativeHistorySummaryToIpc(
                requireRecord(entry, "Native AI history summary") as unknown as NativeAiHistorySessionSummary,
            ),
        );
    }

    async listSessionRuntimeMappingsForParent(
        parentSessionId: string,
    ): Promise<readonly AiRuntimeSessionMapping[]> {
        if (!this.#historyEnabled) {
            return [];
        }
        const output = await this.#client.request<unknown>(
            "ai_list_session_runtime_mappings",
            { parentSessionId },
        );
        if (!Array.isArray(output)) {
            throw new Error("Native AI runtime mappings must be an array.");
        }
        return output.map((entry) =>
            nativeRuntimeMappingToIpc(
                requireRecord(entry, "Native AI runtime mapping") as unknown as NativeAiRuntimeSessionMapping,
            ),
        );
    }

    async loadSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage | null> {
        if (!this.#historyEnabled) {
            return null;
        }
        const output = await this.#client.request<unknown>(
            "ai_load_session_transcript_page",
            {
                limit: input.limit,
                offset: input.offset,
                sessionId: input.sessionId,
            },
        );
        if (output === null) {
            return null;
        }
        return nativeTranscriptPageToIpc(
            requireRecord(output, "Native AI transcript page") as unknown as NativeAiSessionTranscriptPage,
        );
    }

    async appendTranscriptEntries(
        sessionId: string,
        entries: readonly AiTranscriptEntryEnvelope[],
    ): Promise<void> {
        await this.#client.request("ai_append_transcript_entries", {
            entries,
            sessionId,
        });
    }

    async checkpointOpenTranscriptTail(
        input: AiOpenTranscriptTailCheckpoint,
    ): Promise<void> {
        await this.#client.request("ai_checkpoint_open_transcript_tail", {
            entries: input.entries,
            entryOrder: input.entryOrder,
            payloads: input.payloads,
            removedEntryIds: input.removedEntryIds,
            sessionId: input.sessionId,
            terminalStatus: input.terminalStatus,
            turnId: input.turnId,
        });
    }

    async loadOpenTranscriptTail(
        sessionId: string,
    ): Promise<AiOpenTranscriptTail | null> {
        return await this.#client.request<AiOpenTranscriptTail | null>(
            "ai_load_open_transcript_tail",
            { sessionId },
        );
    }

    async sealTranscriptTurn(
        input: AiSealTranscriptTurnInput,
    ): Promise<readonly AiTranscriptBlockMetadata[]> {
        const output = await this.#client.request<unknown>(
            "ai_seal_transcript_turn",
            {
                entries: input.entries,
                payloads: input.payloads,
                sessionId: input.sessionId,
                turnId: input.turnId,
            },
        );
        if (!Array.isArray(output)) {
            throw new Error("Native sealed transcript metadata must be an array.");
        }
        return output as NativeAiTranscriptBlockMetadata[];
    }

    async loadTranscriptBlockMetadata(
        sessionId: string,
    ): Promise<AiTranscriptBlockMetadataOutput> {
        const output = await this.#client.request<unknown>(
            "ai_load_transcript_block_metadata",
            { sessionId },
        );
        return requireTranscriptResponse<NativeAiTranscriptBlockMetadataOutput>(
            output,
            sessionId,
            "metadata",
        );
    }

    async loadTranscriptBlock(
        sessionId: string,
        blockId: string,
    ): Promise<AiTranscriptBlock | null> {
        const output = await this.#client.request<unknown>("ai_load_transcript_block", {
            blockId,
            sessionId,
        });
        return output === null
            ? null
            : requireTranscriptResponse<NativeAiTranscriptBlock>(
                  output,
                  sessionId,
                  "block",
              );
    }

    async loadTranscriptPayload(
        input: AiLoadTranscriptPayloadInput,
    ): Promise<AiTranscriptPayload> {
        const output = await this.#client.request<unknown>(
            "ai_load_transcript_payload",
            {
                maxBytes:
                    input.maxBytes ?? AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX,
                payloadRef: input.payloadRef,
                sessionId: input.sessionId,
            },
        );
        return requireTranscriptResponse<NativeAiTranscriptPayload>(
            output,
            input.sessionId,
            "payload",
        );
    }

    async loadTranscriptPayloads(
        input: AiLoadTranscriptPayloadsInput,
    ): Promise<AiTranscriptPayloadsOutput> {
        if (!this.#transcriptPayloadBatchEnabled) {
            const payloads = await Promise.all(
                [...new Set(input.payloadRefs)].map((payloadRef) =>
                    this.loadTranscriptPayload({
                        maxBytes: input.maxBytes,
                        payloadRef,
                        sessionId: input.sessionId,
                    }),
                ),
            );
            return {
                payloads,
                sessionId: input.sessionId,
            };
        }
        const output = await this.#client.request<unknown>(
            "ai_load_transcript_payloads",
            {
                maxBytes:
                    input.maxBytes ?? AI_TRANSCRIPT_PAYLOAD_LIMIT_MAX,
                payloadRefs: [...new Set(input.payloadRefs)],
                sessionId: input.sessionId,
            },
        );
        return requireTranscriptResponse<NativeAiTranscriptPayloadsOutput>(
            output,
            input.sessionId,
            "payload batch",
        );
    }

    async getTranscriptStorageState(
        sessionId: string,
    ): Promise<AiTranscriptStorageState> {
        const output = await this.#client.request<unknown>(
            "ai_get_transcript_storage_state",
            { sessionId },
        );
        return requireTranscriptResponse<NativeAiTranscriptStorageState>(
            output,
            sessionId,
            "storage state",
        );
    }

    async getHistoryStorageHealth(): Promise<AiHistoryStorageHealth> {
        return await this.#client.request<NativeAiHistoryStorageHealth>(
            "ai_get_history_storage_health",
        );
    }

    async migrateSessionHistory(
        input: AiHistoryMigrationInput,
    ): Promise<AiHistoryMigrationResult> {
        return await this.#client.request<NativeAiMigrateSessionHistoryOutput>(
            "ai_migrate_session_history",
            {
                limit: input.limit,
                mode: input.mode,
                sourceDatabasePath: input.sourceDatabasePath,
            },
        );
    }

    async loadSessionSnapshot(sessionId: string): Promise<AiSessionSnapshot | null> {
        if (!this.#historyEnabled) {
            return null;
        }
        const output = await this.#client.request<unknown>(
            "ai_load_session_snapshot",
            { sessionId },
        );
        if (output === null) {
            return null;
        }
        const snapshot = nativeSnapshotToIpc(
            requireRecord(output, "Native AI session snapshot") as unknown as NativeAiSessionSnapshot,
        );
        return stripHistoricalSnapshotReviewState(snapshot);
    }

    async setSessionPinned(input: AiSessionPinnedMutationInput): Promise<void> {
        if (!this.#historyEnabled) {
            return;
        }
        await this.#client.request("ai_set_session_pinned", {
            pinned: input.pinned,
            sessionId: input.sessionId,
        });
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (!this.#historyEnabled) {
            return;
        }
        await this.#client.request("ai_delete_session", { sessionId });
        this.#forgetSession(sessionId);
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        if (!this.#historyEnabled) {
            return;
        }
        await this.#client.request("ai_rename_session", {
            sessionId: input.sessionId,
            title: input.title,
        });
    }

    async prepareSession(
        request: NativeAiPrepareSessionRpcInput,
    ): Promise<AiSessionSnapshot> {
        const previousOwner = this.#sessionOwners.get(
            request.input.sessionId,
        );
        this.#rememberOwner(request.input.sessionId, request.launch);
        this.#rememberPersistedSubagentMappings(request.launch);

        try {
            const summary = await this.#prepareSessionWithStaleRuntimeRetry(
                request,
            );
            this.#rememberSummary(summary, request.launch.ownerWindowId);

            return nativeSummaryToSnapshot(summary, request.launch);
        } catch (error) {
            this.#restoreOwner(request.input.sessionId, previousOwner);
            throw error;
        }
    }

    async #prepareSessionWithStaleRuntimeRetry(
        request: NativeAiPrepareSessionRpcInput,
    ): Promise<NativeAiSessionSummary> {
        const persistedRuntimeSessionId =
            request.launch.persistedSnapshot.runtimeSessionId ?? null;

        try {
            return await this.#requestPrepareSession(
                request,
                persistedRuntimeSessionId,
            );
        } catch (error) {
            if (
                !persistedRuntimeSessionId ||
                !isStalePersistedRuntimeSessionError(error)
            ) {
                throw error;
            }

            this.#reportDiagnostic(
                `Native AI session ${request.input.sessionId} could not reload runtime session ${persistedRuntimeSessionId}; starting a fresh runtime session.`,
            );
            return await this.#requestPrepareSession(request, null);
        }
    }

    async #requestPrepareSession(
        request: NativeAiPrepareSessionRpcInput,
        persistedRuntimeSessionId: string | null,
    ): Promise<NativeAiSessionSummary> {
        return await this.#client.request<NativeAiSessionSummary>(
            "ai_prepare_session",
            {
                additionalRoots: request.launch.additionalRoots,
                configOptions: nativeConfigOptionsFromLaunch(request.launch),
                cwd: request.launch.cwd,
                launch: null,
                modeId: request.launch.desiredSelections.modeId,
                modelId: request.launch.desiredSelections.modelId,
                persistedRuntimeSessionId,
                persistedSubagentSessionMappings:
                    request.launch.persistedSubagentSessionMappings ?? [],
                projectId: request.input.projectId,
                runtimeId: request.input.runtimeId,
                sessionId: request.input.sessionId,
                title: request.input.title,
                windowId: request.launch.ownerWindowId,
                worktreeId: request.input.worktreeId ?? null,
            },
        );
    }

    async sendPrompt(
        request: NativeAiSendPromptRpcInput,
    ): Promise<AiPromptResult> {
        this.#rememberPersistedSubagentMappings(request.launch);
        const target = this.#resolveSessionTarget(request.input.sessionId);
        if (target.targetSessionId) {
            this.#rememberOwnerIdentity(target.backendSessionId, request.launch);
        } else {
            this.#rememberOwner(request.input.sessionId, request.launch);
        }

        let result: NativeAiSendPromptOutput;
        try {
            result = await this.#client.request<NativeAiSendPromptOutput>(
                "ai_send_prompt",
                {
                    messageId: request.input.messageId,
                    prompt: {
                        attachments: request.input.attachments,
                        displayText: serializeComposerPartsForDisplay(
                            request.input.composerParts,
                            request.input.prompt,
                        ),
                        text: request.input.prompt,
                    },
                    runtimeSessionId: target.runtimeSessionId,
                    sessionId: target.backendSessionId,
                    targetSessionId: target.targetSessionId,
                },
            );
        } catch (error) {
            if (isNativeAiSessionBusyError(error)) {
                throw new Error(AI_SESSION_BUSY_MESSAGE, { cause: error });
            }
            throw error;
        }

        if (result.accepted) {
            this.#emitUserMessage(request.input, request.launch);
        }

        return {
            sessionId: result.sessionId,
            stopReason: result.accepted ? "accepted" : "rejected",
        };
    }

    async cancelSession(sessionId: string): Promise<void> {
        if (!this.#sessionOwners.has(sessionId)) {
            return;
        }

        const target = this.#resolveSessionTarget(sessionId);
        await this.#client.request<NativeAiCancelSessionOutput>(
            "ai_cancel_session",
            {
                runtimeSessionId: target.runtimeSessionId,
                sessionId: target.backendSessionId,
                targetSessionId: target.targetSessionId,
            },
        );
    }

    async closeSession(sessionId: string): Promise<void> {
        if (!this.#sessionOwners.has(sessionId)) {
            return;
        }

        if (this.#subagentParentSessionIds.has(sessionId)) {
            // A child close is a view detach. ACP has no target-aware close primitive.
            return;
        }

        try {
            await this.#client.request<NativeAiCloseSessionOutput>(
                "ai_close_session",
                { sessionId },
            );
        } finally {
            this.#forgetSession(sessionId);
        }
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        const sessionIds = [...this.#sessionOwners.entries()]
            .filter(
                ([sessionId, owner]) =>
                    owner === ownerWindowId &&
                    !this.#subagentParentSessionIds.has(sessionId),
            )
            .map(([sessionId]) => sessionId);
        for (const sessionId of sessionIds) {
            void this.closeSession(sessionId).catch((error: unknown) => {
                if (isCleanupSessionNotFoundError(error)) {
                    return;
                }
                this.#reportDiagnostic(
                    `Native AI window cleanup failed: ${formatError(error)}`,
                );
            });
        }
    }

    async respondPermission(input: AiPermissionResponseInput): Promise<void> {
        const target = this.#resolveSessionTarget(input.sessionId);
        await this.#client.request("ai_respond_permission", {
            optionId: input.optionId,
            requestId: input.requestId,
            sessionId: target.backendSessionId,
            targetSessionId: target.targetSessionId,
        });
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        const target = this.#resolveSessionTarget(input.sessionId);
        await this.#client.request("ai_respond_user_input", {
            answers: input.answers,
            requestId: input.requestId,
            sessionId: target.backendSessionId,
            targetSessionId: target.targetSessionId,
        });
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        const target = this.#resolveSessionTarget(input.sessionId);
        await this.#client.request("ai_set_session_mode", {
            modeId: input.modeId,
            runtimeSessionId: target.runtimeSessionId,
            sessionId: target.backendSessionId,
        });
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        const target = this.#resolveSessionTarget(input.sessionId);
        await this.#client.request("ai_set_session_model", {
            modelId: input.modelId,
            runtimeSessionId: target.runtimeSessionId,
            sessionId: target.backendSessionId,
        });
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        const target = this.#resolveSessionTarget(input.sessionId);
        await this.#client.request("ai_set_session_config_option", {
            optionId: input.optionId,
            runtimeSessionId: target.runtimeSessionId,
            sessionId: target.backendSessionId,
            value: input.value,
        });
    }

    close(): void {
        this.#disposeEventListener();
        for (const sessionId of this.#sessionOwners.keys()) {
            void this.closeSession(sessionId).catch((error: unknown) => {
                if (isCleanupSessionNotFoundError(error)) {
                    return;
                }
                this.#reportDiagnostic(
                    `Native AI shutdown cleanup failed: ${formatError(error)}`,
                );
            });
        }
    }

    #handleNativeEvent(event: NativeBackendEvent): void {
        if (event.eventName === "ai://runtime-status") {
            try {
                this.#onRuntimeStatus(
                    nativeAiRuntimeStatusToIpc(
                        requireRecord(
                            event.payload,
                            "Native AI runtime status",
                        ) as unknown as NativeAiRuntimeStatus,
                    ),
                );
            } catch (error) {
                this.#reportDiagnostic(
                    `Native AI runtime event failed: ${formatError(error)}`,
                );
            }
            return;
        }

        if (event.eventName === "ai://runtime-connection") {
            try {
                const payload = requireRecord(
                    event.payload,
                    "Native AI runtime connection",
                ) as unknown as NativeAiRuntimeConnectionPayload;
                this.#reportDiagnostic(
                    `Native AI ${payload.runtimeId} connection: ${payload.status}${
                        payload.message ? ` (${payload.message})` : ""
                    }`,
                );
            } catch (error) {
                this.#reportDiagnostic(
                    `Native AI runtime connection event failed: ${formatError(error)}`,
                );
            }
            return;
        }

        if (!event.eventName.startsWith("ai://")) {
            return;
        }

        try {
            const sessionId = getPayloadSessionId(event.payload);
            if (!sessionId) {
                return;
            }

            let ownerWindowId = this.#sessionOwners.get(sessionId);
            if (!ownerWindowId && event.eventName === "ai://subagent-created") {
                const parentSessionId = getPayloadString(
                    event.payload,
                    "parentSessionId",
                );
                ownerWindowId = parentSessionId
                    ? this.#sessionOwners.get(parentSessionId)
                    : undefined;
                if (ownerWindowId) {
                    this.#sessionOwners.set(sessionId, ownerWindowId);
                }
            }
            if (!ownerWindowId) {
                return;
            }

            if (event.eventName === "ai://session-catalog-updated") {
                const payload = requireRecord(
                    event.payload,
                    "Native AI catalog update",
                ) as unknown as NativeAiSessionCatalogUpdatedPayload;
                this.#onSessionCatalogPatch?.(
                    ownerWindowId,
                    payload.sessionId,
                    nativeAiCatalogPatchToIpc(payload),
                    payload.updatedAt,
                );
                return;
            }

            const converted = this.#hydrateNativeSessionEvent(
                nativeAiEventToIpc(event),
            );
            if (!converted) {
                return;
            }

            // A close from an older runtime generation must not tear down the
            // ownership and routing state of a session that was reopened.
            if (this.#isStaleSessionCloseEvent(converted)) {
                return;
            }

            this.#rememberRuntimeSession(converted);
            if (converted.kind === "subagent-created") {
                this.#sessionOwners.set(converted.childSessionId, ownerWindowId);
                this.#sessionRuntimeIds.set(
                    converted.childSessionId,
                    converted.runtimeId,
                );
                this.#runtimeSessionIds.set(
                    converted.childSessionId,
                    converted.childRuntimeSessionId ?? converted.runtimeSessionId,
                );
                this.#subagentParentSessionIds.set(
                    converted.childSessionId,
                    converted.parentSessionId,
                );
            }
            this.#onSessionEvent(ownerWindowId, converted);
            if (converted.kind === "session-closed") {
                this.#forgetSession(converted.sessionId);
            }
        } catch (error) {
            this.#reportDiagnostic(
                `Native AI event failed: ${formatError(error)}`,
            );
        }
    }

    #emitUserMessage(
        input: NativeAiSendPromptRpcInput["input"],
        launch: NativeAiSendPromptRpcInput["launch"],
    ): void {
        const now = new Date().toISOString();
        const displayContent = serializeComposerPartsForDisplay(
            input.composerParts,
            input.prompt,
        );
        const runtimeSessionId =
            this.#runtimeSessionIds.get(input.sessionId) ??
            launch.persistedSnapshot.runtimeSessionId ??
            null;
        const parentSessionId = launch.persistedSnapshot.parentSessionId ?? null;
        const base = {
            origin: "live" as const,
            parentSessionId,
            runtimeId: input.runtimeId,
            runtimeSessionId,
            sessionId: input.sessionId,
            updatedAt: now,
        };

        this.#onSessionEvent(launch.ownerWindowId, {
            ...base,
            kind: "message-started",
            message: {
                attachments: input.attachments,
                content: "",
                createdAt: now,
                id: input.messageId,
                kind: "user",
                status: "streaming",
            },
            messageKind: "user",
        });
        this.#onSessionEvent(launch.ownerWindowId, {
            ...base,
            content: displayContent,
            delta: displayContent,
            kind: "message-delta",
            messageId: input.messageId,
            messageKind: "user",
        });
        this.#onSessionEvent(launch.ownerWindowId, {
            ...base,
            kind: "message-completed",
            messageId: input.messageId,
            messageKind: "user",
        });
    }

    #rememberOwner(
        sessionId: string,
        launch: NativeAiPrepareSessionRpcInput["launch"],
    ): void {
        this.#rememberOwnerIdentity(sessionId, launch);
        if (!this.#runtimeSessionIds.has(sessionId)) {
            this.#runtimeSessionIds.set(
                sessionId,
                launch.persistedSnapshot.runtimeSessionId ?? null,
            );
        }
    }

    #rememberOwnerIdentity(
        sessionId: string,
        launch: NativeAiPrepareSessionRpcInput["launch"],
    ): void {
        this.#sessionOwners.set(sessionId, launch.ownerWindowId);
        this.#sessionRuntimeIds.set(sessionId, launch.input.runtimeId);
    }

    #rememberPersistedSubagentMappings(
        launch: NativeAiPrepareSessionRpcInput["launch"],
    ): void {
        const snapshotParentSessionId =
            launch.persistedSnapshot.parentSessionId ?? null;
        if (snapshotParentSessionId) {
            this.#rememberOwnerIdentity(snapshotParentSessionId, launch);
            this.#sessionOwners.set(
                launch.persistedSnapshot.sessionId,
                launch.ownerWindowId,
            );
            this.#sessionRuntimeIds.set(
                launch.persistedSnapshot.sessionId,
                launch.input.runtimeId,
            );
            this.#runtimeSessionIds.set(
                launch.persistedSnapshot.sessionId,
                launch.persistedSnapshot.runtimeSessionId ?? null,
            );
            this.#subagentParentSessionIds.set(
                launch.persistedSnapshot.sessionId,
                snapshotParentSessionId,
            );
        }

        for (const mapping of launch.persistedSubagentSessionMappings ?? []) {
            this.#sessionOwners.set(mapping.appSessionId, launch.ownerWindowId);
            this.#sessionRuntimeIds.set(
                mapping.appSessionId,
                launch.input.runtimeId,
            );
            this.#runtimeSessionIds.set(
                mapping.appSessionId,
                mapping.runtimeSessionId,
            );
            if (mapping.parentAppSessionId) {
                this.#rememberOwnerIdentity(mapping.parentAppSessionId, launch);
                this.#subagentParentSessionIds.set(
                    mapping.appSessionId,
                    mapping.parentAppSessionId,
                );
                if (
                    mapping.parentRuntimeSessionId &&
                    !this.#runtimeSessionIds.has(mapping.parentAppSessionId)
                ) {
                    this.#runtimeSessionIds.set(
                        mapping.parentAppSessionId,
                        mapping.parentRuntimeSessionId,
                    );
                }
            }
        }
    }

    #rememberSummary(
        summary: NativeAiSessionSummary,
        ownerWindowId: string,
    ): void {
        this.#sessionOwners.set(summary.sessionId, ownerWindowId);
        this.#sessionRuntimeIds.set(
            summary.sessionId,
            summary.runtimeId as AiRuntimeId,
        );
        this.#runtimeSessionIds.set(
            summary.sessionId,
            summary.runtimeSessionId,
        );
    }

    #rememberRuntimeSession(event: AiSessionDomainEvent): void {
        this.#sessionRuntimeIds.set(event.sessionId, event.runtimeId);
        this.#runtimeSessionIds.set(event.sessionId, event.runtimeSessionId);
        if (event.kind === "session-info") {
            this.#runtimeSessionIds.set(
                event.sessionId,
                event.runtimeSessionId,
            );
        }
    }

    #hydrateNativeSessionEvent(
        event: AiSessionDomainEvent | null,
    ): AiSessionDomainEvent | null {
        if (!event || event.kind !== "session-closed") {
            return event;
        }

        const parentSessionId =
            event.parentSessionId ??
            this.#subagentParentSessionIds.get(event.sessionId) ??
            null;
        if (parentSessionId === event.parentSessionId) {
            return event;
        }

        return {
            ...event,
            parentSessionId,
        };
    }

    #isStaleSessionCloseEvent(event: AiSessionDomainEvent): boolean {
        if (event.kind !== "session-closed" || !event.runtimeSessionId) {
            return false;
        }

        const currentRuntimeSessionId = this.#runtimeSessionIds.get(
            event.sessionId,
        );
        return (
            currentRuntimeSessionId !== undefined &&
            currentRuntimeSessionId !== null &&
            currentRuntimeSessionId !== event.runtimeSessionId
        );
    }

    #restoreOwner(sessionId: string, previousOwner: string | undefined): void {
        if (previousOwner) {
            this.#sessionOwners.set(sessionId, previousOwner);
            return;
        }

        this.#forgetSession(sessionId);
    }

    #forgetSession(sessionId: string): void {
        for (const subtreeSessionId of this.#collectSessionSubtreeIds(sessionId)) {
            this.#subagentParentSessionIds.delete(subtreeSessionId);
            this.#runtimeSessionIds.delete(subtreeSessionId);
            this.#sessionOwners.delete(subtreeSessionId);
            this.#sessionRuntimeIds.delete(subtreeSessionId);
        }
    }

    #collectSessionSubtreeIds(sessionId: string): string[] {
        const subtreeSessionIds: string[] = [];
        const pendingSessionIds = [sessionId];
        const visitedSessionIds = new Set<string>();
        while (pendingSessionIds.length > 0) {
            const currentSessionId = pendingSessionIds.shift();
            if (!currentSessionId || visitedSessionIds.has(currentSessionId)) {
                continue;
            }
            visitedSessionIds.add(currentSessionId);
            subtreeSessionIds.push(currentSessionId);
            for (const [childSessionId, parentSessionId] of this
                .#subagentParentSessionIds) {
                if (parentSessionId === currentSessionId) {
                    pendingSessionIds.push(childSessionId);
                }
            }
        }
        return subtreeSessionIds;
    }

    #resolveSessionTarget(sessionId: string): {
        readonly backendSessionId: string;
        readonly runtimeSessionId: string | null;
        readonly targetSessionId: string | null;
    } {
        let backendSessionId = sessionId;
        const visited = new Set([sessionId]);
        while (true) {
            const parentSessionId =
                this.#subagentParentSessionIds.get(backendSessionId) ?? null;
            if (!parentSessionId || visited.has(parentSessionId)) {
                break;
            }
            visited.add(parentSessionId);
            backendSessionId = parentSessionId;
        }

        if (backendSessionId === sessionId) {
            return {
                backendSessionId: sessionId,
                runtimeSessionId: null,
                targetSessionId: null,
            };
        }

        return {
            backendSessionId,
            runtimeSessionId: this.#runtimeSessionIds.get(sessionId) ?? null,
            targetSessionId: sessionId,
        };
    }

    #reportDiagnostic(message: string): void {
        this.#onDiagnostic?.(message);
    }
}

function nativeReviewTrackedFileForInput(
    input: AiReviewSessionRpcInput<
        AiTrackedFileHunkMutationInput | AiTrackedFileMutationInput
    >,
): AiTrackedFile {
    const trackedFile = input.input.trackedFileId
        ? input.context.snapshot.trackedFiles.find(
              (file) => file.identityKey === input.input.trackedFileId,
          )
        : input.context.snapshot.trackedFiles.find(
              (file) =>
                  file.path === input.input.path ||
                  file.previousPath === input.input.path ||
                  file.identityKey === input.input.path,
          );
    if (!trackedFile) {
        throw new Error("The file to review was not found.");
    }
    return trackedFile;
}

function nativeReviewReferenceForTrackedFile(
    snapshot: AiSessionSnapshot,
    trackedFile: AiTrackedFile,
): NativeReviewDeltaReference | null {
    const deltaId = trackedFile.nativeReviewDeltaId;
    if (!deltaId) {
        return null;
    }
    const delta = snapshot.reviewDeltas?.find(
        (candidate) => candidate.deltaId === deltaId,
    );
    return delta ? nativeReviewDeltaReference(delta) : null;
}

function nativeReviewDeltaReference(
    delta: NonNullable<AiSessionSnapshot["reviewDeltas"]>[number],
): NativeReviewDeltaReference {
    return {
        deltaId: delta.deltaId,
        expectedRevision: delta.revision,
        inputRevision: delta.inputRevision,
        observedHashes: delta.files,
        sessionId: delta.sessionId,
        toolCallId: delta.toolCallId,
        workCycleId: delta.workCycleId,
    };
}

function reviewMutationResultFromContext<TInput>(
    input: AiReviewSessionRpcInput<TInput>,
): AiReviewMutationResult {
    return {
        ownerWindowId: input.context.ownerWindowId,
        snapshot: input.context.snapshot,
    };
}

function nativeSummaryToSnapshot(
    summary: NativeAiSessionSummary,
    launch: NativeAiPrepareSessionRpcInput["launch"],
): AiSessionSnapshot {
    const status = nativeSessionStatusToIpc(summary.status);
    const preservesActiveTurn =
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input";
    return {
        ...launch.persistedSnapshot,
        activeTurnStartedAt:
            preservesActiveTurn
                ? launch.persistedSnapshot.activeTurnStartedAt
                : null,
        // Preparing creates a live runtime session, even when the persisted
        // history snapshot was closed before the application restarted.
        closedAt: null,
        configOptions: launch.desiredSelections.configOptions,
        modeId: launch.desiredSelections.modeId,
        modelId: launch.desiredSelections.modelId,
        projectId: summary.projectId,
        runtimeId: summary.runtimeId as AiRuntimeId,
        runtimeSessionId: summary.runtimeSessionId,
        sessionId: summary.sessionId,
        status,
        title: summary.title,
        updatedAt: summary.updatedAt,
        worktreeId: summary.worktreeId,
    };
}

function stripHistoricalSnapshotReviewState(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    if (snapshot.trackedFiles.length === 0) {
        return snapshot;
    }

    return {
        ...snapshot,
        // Historical review diffs remain in the transcript; pending review files
        // are live session state and must not be resurrected after restart.
        trackedFiles: [],
    };
}

function nativeSessionStatusToIpc(status: string): AiSessionStatus {
    if (
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input" ||
        status === "error"
    ) {
        return status;
    }
    if (status === "closed") {
        return "idle";
    }
    return "idle";
}

function nativeHistorySummaryToIpc(
    summary: NativeAiHistorySessionSummary,
): AiHistorySessionSummary {
    requireString(summary.sessionId, "Native AI history summary sessionId");
    requireString(summary.runtimeId, "Native AI history summary runtimeId");
    requireString(summary.title, "Native AI history summary title");
    requireString(summary.createdAt, "Native AI history summary createdAt");
    requireString(summary.updatedAt, "Native AI history summary updatedAt");
    requireNumber(
        summary.messageCount,
        "Native AI history summary messageCount",
    );

    return {
        createdAt: summary.createdAt,
        messageCount: summary.messageCount,
        parentSessionId: nullableString(summary.parentSessionId),
        pinnedAt: nullableString(summary.pinnedAt),
        preview: nullableString(summary.preview),
        projectId: nullableString(summary.projectId),
        runtimeId: summary.runtimeId as AiRuntimeId,
        runtimeSessionId: nullableString(summary.runtimeSessionId),
        sessionId: summary.sessionId,
        title: summary.title,
        updatedAt: summary.updatedAt,
        worktreeId: nullableString(summary.worktreeId),
    };
}

function nativeRuntimeMappingToIpc(
    mapping: NativeAiRuntimeSessionMapping,
): AiRuntimeSessionMapping {
    requireString(mapping.appSessionId, "Native AI runtime mapping appSessionId");
    requireString(
        mapping.runtimeSessionId,
        "Native AI runtime mapping runtimeSessionId",
    );
    return {
        appSessionId: mapping.appSessionId,
        parentAppSessionId: nullableString(mapping.parentAppSessionId),
        parentRuntimeSessionId: nullableString(mapping.parentRuntimeSessionId),
        runtimeSessionId: mapping.runtimeSessionId,
    };
}

function nativeTranscriptPageToIpc(
    page: NativeAiSessionTranscriptPage,
): AiSessionTranscriptPage {
    requireString(page.sessionId, "Native AI transcript page sessionId");
    requireNumber(page.offset, "Native AI transcript page offset");
    requireNumber(page.totalMessages, "Native AI transcript page totalMessages");
    if (!Array.isArray(page.messages)) {
        throw new Error("Native AI transcript page messages must be an array.");
    }
    return {
        messages: page.messages.map((message) =>
            requireRecord(message, "Native AI transcript message") as unknown as AiMessage,
        ),
        offset: page.offset,
        sessionId: page.sessionId,
        totalMessages: page.totalMessages,
    };
}

function nativeSnapshotToIpc(snapshot: NativeAiSessionSnapshot): AiSessionSnapshot {
    requireString(snapshot.sessionId, "Native AI snapshot sessionId");
    requireString(snapshot.runtimeId, "Native AI snapshot runtimeId");
    requireString(snapshot.title, "Native AI snapshot title");
    requireString(snapshot.updatedAt, "Native AI snapshot updatedAt");

    return {
        activeTurnStartedAt: nullableString(snapshot.activeTurnStartedAt),
        availableCommands: requireRecordArray(
            snapshot.availableCommands,
            "Native AI snapshot availableCommands",
        ) as unknown as AiSessionSnapshot["availableCommands"],
        closedAt: nullableString(snapshot.closedAt),
        configOptions: requireRecordArray(
            snapshot.configOptions,
            "Native AI snapshot configOptions",
        ) as AiSessionSnapshot["configOptions"],
        lastError: nullableString(snapshot.lastError),
        messages: requireRecordArray(
            snapshot.messages,
            "Native AI snapshot messages",
        ) as unknown as readonly AiMessage[],
        modeId: nullableString(snapshot.modeId),
        modes: requireRecordArray(
            snapshot.modes,
            "Native AI snapshot modes",
        ) as unknown as AiSessionSnapshot["modes"],
        modelId: nullableString(snapshot.modelId),
        models: requireRecordArray(
            snapshot.models,
            "Native AI snapshot models",
        ) as unknown as AiSessionSnapshot["models"],
        pendingPermission: nullableRecord(
            snapshot.pendingPermission,
            "Native AI snapshot pendingPermission",
        ) as AiSessionSnapshot["pendingPermission"],
        pendingUserInput: nullableRecord(
            snapshot.pendingUserInput,
            "Native AI snapshot pendingUserInput",
        ) as AiSessionSnapshot["pendingUserInput"],
        plan: nullableRecord(
            snapshot.plan,
            "Native AI snapshot plan",
        ) as AiSessionSnapshot["plan"],
        parentSessionId: nullableString(snapshot.parentSessionId),
        projectId: nullableString(snapshot.projectId),
        reasoningEffort: nullableString(snapshot.reasoningEffort),
        runtimeId: snapshot.runtimeId as AiRuntimeId,
        runtimeSessionId: nullableString(snapshot.runtimeSessionId),
        sessionId: snapshot.sessionId,
        status: nativeSessionStatusToIpc(snapshot.status),
        title: snapshot.title,
        tokenUsage: nullableRecord(
            snapshot.tokenUsage,
            "Native AI snapshot tokenUsage",
        ) as AiSessionSnapshot["tokenUsage"],
        toolActivity: requireRecordArray(
            snapshot.toolActivity,
            "Native AI snapshot toolActivity",
        ) as unknown as AiSessionSnapshot["toolActivity"],
        trackedFiles: Array.isArray(snapshot.trackedFiles)
            ? snapshot.trackedFiles.map(nativeReviewTrackedFileToIpc)
            : [],
        updatedAt: snapshot.updatedAt,
        worktreeId: nullableString(snapshot.worktreeId),
    };
}

function nativeConfigOptionsFromLaunch(
    launch: NativeAiPrepareSessionRpcInput["launch"],
): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
        launch.desiredSelections.configOptions.map((option) => [
            option.id,
            option.value,
        ]),
    );
}

function getPayloadSessionId(payload: unknown): string | null {
    const record = requireRecord(payload, "Native AI event payload");
    const sessionId = record.sessionId;
    return typeof sessionId === "string" && sessionId.trim()
        ? sessionId
        : null;
}

function getPayloadString(payload: unknown, key: string): string | null {
    const record = requireRecord(payload, "Native AI event payload");
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireTranscriptResponse<T>(
    value: unknown,
    sessionId: string,
    label: string,
): T {
    const record = requireRecord(value, `Native transcript ${label}`);
    if (record.sessionId !== sessionId) {
        throw new Error(`Native transcript ${label} belongs to another session.`);
    }
    if (
        typeof record.capabilityVersion !== "number" ||
        !Number.isSafeInteger(record.capabilityVersion) ||
        record.capabilityVersion < 1 ||
        record.capabilityVersion >
            NATIVE_AI_TRANSCRIPT_BLOCK_CAPABILITY_VERSION
    ) {
        throw new Error(
            `Native transcript ${label} has an invalid capability version.`,
        );
    }
    return record as T;
}

function requireRecordArray(value: unknown, label: string): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    return value.map((entry) => requireRecord(entry, label));
}

function nullableRecord(value: unknown, label: string): Record<string, unknown> | null {
    if (value === null || value === undefined) {
        return null;
    }
    return requireRecord(value, label);
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string.`);
    }
    return value;
}

function nullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function requireNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return value;
}

function isStalePersistedRuntimeSessionError(error: unknown): boolean {
    if (!(error instanceof NativeBackendError)) {
        return false;
    }

    const message = error.message;
    return (
        error.code === "not_found" ||
        message === "Resource not found" ||
        message.includes("Resource not found:") ||
        (error.code === "ai_runtime_exited" &&
            message.includes("Resource not found"))
    );
}

function isCleanupSessionNotFoundError(error: unknown): boolean {
    return (
        error instanceof NativeBackendError &&
        (error.code === "ai_session_not_found" ||
            error.message.includes("was not found"))
    );
}

function isNativeAiSessionBusyError(error: unknown): boolean {
    return (
        error instanceof NativeBackendError && error.code === "ai_session_busy"
    );
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
