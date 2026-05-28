import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type Client,
    type ContentBlock,
    type CreateTerminalRequest,
    type CreateTerminalResponse,
    type KillTerminalRequest,
    type KillTerminalResponse,
    type ReadTextFileRequest,
    type ReleaseTerminalRequest,
    type ReleaseTerminalResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type TerminalExitStatus,
    type TerminalOutputRequest,
    type TerminalOutputResponse,
    type WaitForTerminalExitRequest,
    type WaitForTerminalExitResponse,
    type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
    AiPermissionRequest,
    AiPromptResult,
    AiSessionSnapshot,
    AiTrackedFile,
} from "@shared/ipc";
import {
    getImageAttachmentLimitMessage,
    MAX_IMAGE_ATTACHMENTS,
} from "@shared/ai-attachments";
import {
    computeDiffHunks,
    getTrackedFileCurrentText,
    replaceTrackedFile,
    resolveTrackedFileHunks,
    syncTrackedFile,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";
import { SessionBusyError } from "@shared/ai-errors";
import { isDefaultChatTitle } from "@shared/chatTitle";

import { debugBenignError } from "@main/observability/logging";

import {
    AI_SESSION_STREAMING_FLUSH_MS,
    type AiWorkerBootstrapState,
    type AiWorkerEventMessage,
    type AiWorkerRefreshProjectScopesRpcInput,
    type AiWorkerReviewMutationResult,
    type AiWorkerReviewSessionContext,
    type AiWorkerRpcMethodMap,
    type AiWorkerSessionLaunchInput,
    CODEX_ACP_AGENT_NICKNAME_KEY,
    CODEX_ACP_AGENT_STATUS_KEY,
    CODEX_ACP_AGENT_STATUSES_KEY,
    CODEX_ACP_CHILD_SESSION_ID_KEY,
    CODEX_ACP_CHILD_THREAD_ID_KEY,
    CODEX_ACP_CWD_KEY,
    CODEX_ACP_MODEL_KEY,
    CODEX_ACP_PARENT_SESSION_ID_KEY,
    CODEX_ACP_REASONING_EFFORT_KEY,
    CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE,
    CODEX_ACP_STATUS_EVENT_TYPE_KEY,
    CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE,
    CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY,
    CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE,
    CODEX_ACP_TURN_ABORTED_EVENT_TYPE,
    CODEX_ACP_TURN_COMPLETE_EVENT_TYPE,
    CODEX_ACP_TURN_EVENT_TYPE_KEY,
    CODEX_ACP_TURN_ID_KEY,
    CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE,
    CODEX_ACP_TURN_STARTED_EVENT_TYPE,
    CODEX_ACP_USER_INPUT_RESPONSE_PREFIX,
    type LiveAcpConnection,
    type LiveAcpSession,
    type LiveAcpTerminal,
} from "./contracts";
import {
    appendContentBlockToSnapshot,
    applySessionCatalogToSnapshot,
    buildAiSessionUpdate,
    buildPromptContentBlocks,
    buildUserInputResponsePrompt,
    finalizeStreamingMessages,
    getModeConfigOption,
    getModelConfigOption,
    getPreparedSessionStatus,
    getRecentStderrText,
    getRuntimeDisplayName,
    hasSelectConfigValue,
    isBusyAiSessionStatus,
    isPathInsideRoot,
    resolveSessionTitleOnPrompt,
    sameAdditionalRoots,
    serializeComposerPartsForDisplay,
    setConfigOptionOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setTitleOnSnapshot,
    shouldFlushLiveSessionImmediately,
    summarizeUserInputAnswers,
    toPosixPath,
} from "./session-core";
import {
    isImageGenerationToolUpdate,
    mapImageGenerationToolUpdate,
    mapToolCallUpdate,
    readTextIfExists,
    shouldSuppressToolActivityUpdate,
} from "./review-core";

export interface AiWorkerRuntimeOptions {
    readonly debugLogsEnabled?: boolean;
    readonly emitEvent: (message: AiWorkerEventMessage) => void;
}

interface TrackedPathRollbackBackup {
    readonly absolutePath: string;
    readonly bufferContent: string | null;
    readonly content: Buffer | null;
    readonly hadBuffer: boolean;
    readonly mode: number | null;
}

interface TrackedFileRollbackState {
    readonly missingDirectories: readonly string[];
    readonly pathBackups: readonly TrackedPathRollbackBackup[];
}

interface PendingUserTextEcho {
    bufferedText: string;
    readonly expectedContentBlocks: readonly ContentBlock[];
    readonly expectedTexts: readonly string[];
    readonly messageId: string | null;
    textMatched: boolean;
}

interface SubagentMirrorTurnState {
    assistantOutputSeen: boolean;
    readonly toolCallId: string;
}

const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 128 * 1024;
const TERMINAL_PERMISSION_ALLOW_OPTION_ID = "comando.terminal.allow_once";
const TERMINAL_PERMISSION_REJECT_OPTION_ID = "comando.terminal.reject_once";
const CODEX_ACP_SUBAGENT_CLOSE_END_EVENT_TYPE = "close_end";
const CODEX_ACP_SUBAGENT_INTERACTION_BEGIN_EVENT_TYPE = "interaction_begin";
const CODEX_ACP_SUBAGENT_INTERACTION_END_EVENT_TYPE = "interaction_end";
const CODEX_ACP_SUBAGENT_RESUME_BEGIN_EVENT_TYPE = "resume_begin";
const CODEX_ACP_SUBAGENT_RESUME_END_EVENT_TYPE = "resume_end";
const CODEX_ACP_SUBAGENT_WAITING_END_EVENT_TYPE = "waiting_end";
const CODEX_ACP_REASONING_CONFIG_OPTION_IDS = [
    "reasoning_effort",
    "effort",
    "effort_level",
] as const;
const CODEX_ACP_REASONING_EFFORT_SUFFIXES = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
] as const;
const MAX_PENDING_SESSION_UPDATES_PER_RUNTIME_SESSION = 16;
const PRE_EDIT_SNAPSHOT_MAX_ENTRIES = 128;
const PRE_EDIT_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

function setDesiredConfigValue(
    values: Map<string, boolean | string>,
    optionId: string,
    value: boolean | string,
    options: { readonly overrideCompatibility?: boolean } = {},
): void {
    values.set(optionId, value);

    const compatibilityId =
        optionId === "effort_level"
            ? "effort"
            : optionId === "effort"
              ? "effort_level"
              : null;
    if (
        compatibilityId &&
        (options.overrideCompatibility || !values.has(compatibilityId))
    ) {
        values.set(compatibilityId, value);
    }
}

function shouldSuppressSessionToolActivityUpdate(
    snapshot: Pick<AiSessionSnapshot, "toolActivity">,
    update: SessionNotification["update"],
): boolean {
    if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
    ) {
        return false;
    }

    const existing =
        snapshot.toolActivity.find(
            (candidate) => candidate.id === update.toolCallId,
        ) ?? null;
    const title =
        typeof update.title === "string" && update.title.trim().length > 0
            ? update.title.trim()
            : (existing?.title ?? null);

    return shouldSuppressToolActivityUpdate(update, title);
}

function isDirectStreamingSessionUpdate(
    update: SessionNotification["update"],
): boolean {
    return (
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "plan"
    );
}

function toWebByteWritable(stream: Writable): WritableStream<Uint8Array> {
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function toWebByteReadable(stream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export class AiWorkerRuntime {
    readonly #debugLogsEnabled: boolean;
    readonly #emitEvent: (message: AiWorkerEventMessage) => void;
    readonly #connections = new Map<string, LiveAcpConnection>();
    readonly #fileBuffers = new Map<string, string>();
    readonly #pendingUserTextEchoes = new Map<string, PendingUserTextEcho>();
    readonly #sessions = new Map<string, LiveAcpSession>();
    readonly #subagentMirrorTurns = new Map<string, SubagentMirrorTurnState>();
    readonly #startedAt = new Date().toISOString();

    constructor(options: AiWorkerRuntimeOptions) {
        this.#debugLogsEnabled = options.debugLogsEnabled ?? false;
        this.#emitEvent = options.emitEvent;
    }

    getBootstrapState(): AiWorkerBootstrapState {
        return {
            capabilities: {
                fileBufferMirroring: true,
                runtimeSessions: true,
            },
            protocolVersion: 1,
            startedAt: this.#startedAt,
        };
    }

    async dispatchMethod(
        method: string,
        params: unknown,
    ): Promise<unknown> {
        switch (method as keyof AiWorkerRpcMethodMap) {
            case "ai.notifyFileBuffer":
                this.#notifyFileBuffer(
                    params as AiWorkerRpcMethodMap["ai.notifyFileBuffer"]["params"],
                );
                return null;
            case "ai.prepareSession":
                return await this.#prepareSession(
                    params as AiWorkerRpcMethodMap["ai.prepareSession"]["params"],
                );
            case "ai.renameSession":
                this.#renameSession(
                    params as AiWorkerRpcMethodMap["ai.renameSession"]["params"],
                );
                return;
            case "ai.sendPrompt":
                return await this.#sendPrompt(
                    params as AiWorkerRpcMethodMap["ai.sendPrompt"]["params"],
                );
            case "ai.cancelSession":
                await this.#cancelSession(
                    params as AiWorkerRpcMethodMap["ai.cancelSession"]["params"],
                );
                return null;
            case "ai.closeSession":
                this.#closeSession(
                    params as AiWorkerRpcMethodMap["ai.closeSession"]["params"],
                );
                return null;
            case "ai.closeOwnedByWindow":
                this.#closeOwnedByWindow(
                    params as AiWorkerRpcMethodMap["ai.closeOwnedByWindow"]["params"],
                );
                return null;
            case "ai.keepTrackedFile":
                return await this.#keepTrackedFile(
                    params as AiWorkerRpcMethodMap["ai.keepTrackedFile"]["params"],
                );
            case "ai.rejectTrackedFile":
                return await this.#rejectTrackedFile(
                    params as AiWorkerRpcMethodMap["ai.rejectTrackedFile"]["params"],
                );
            case "ai.keepTrackedFileHunks":
                return await this.#keepTrackedFileHunks(
                    params as AiWorkerRpcMethodMap["ai.keepTrackedFileHunks"]["params"],
                );
            case "ai.rejectTrackedFileHunks":
                return await this.#rejectTrackedFileHunks(
                    params as AiWorkerRpcMethodMap["ai.rejectTrackedFileHunks"]["params"],
                );
            case "ai.keepAllTrackedFiles":
                return await this.#keepAllTrackedFiles(
                    params as AiWorkerRpcMethodMap["ai.keepAllTrackedFiles"]["params"],
                );
            case "ai.rejectAllTrackedFiles":
                return await this.#rejectAllTrackedFiles(
                    params as AiWorkerRpcMethodMap["ai.rejectAllTrackedFiles"]["params"],
                );
            case "ai.respondPermission":
                this.#respondPermission(
                    params as AiWorkerRpcMethodMap["ai.respondPermission"]["params"],
                );
                return null;
            case "ai.respondUserInput":
                await this.#respondUserInput(
                    params as AiWorkerRpcMethodMap["ai.respondUserInput"]["params"],
                );
                return null;
            case "ai.refreshProjectScopes":
                await this.#refreshProjectScopes(
                    params as AiWorkerRpcMethodMap["ai.refreshProjectScopes"]["params"],
                );
                return null;
            case "ai.setSessionMode":
                await this.#setSessionMode(
                    params as AiWorkerRpcMethodMap["ai.setSessionMode"]["params"],
                );
                return null;
            case "ai.setSessionModel":
                await this.#setSessionModel(
                    params as AiWorkerRpcMethodMap["ai.setSessionModel"]["params"],
                );
                return null;
            case "ai.setSessionConfigOption":
                await this.#setSessionConfigOption(
                    params as AiWorkerRpcMethodMap["ai.setSessionConfigOption"]["params"],
                );
                return null;
            default:
                throw new Error(`Unknown AI worker method: ${method}`);
        }
    }

    shutdown(): void {
        for (const liveConnection of [...this.#connections.values()]) {
            this.#disposeLiveConnection(liveConnection, {
                emitClosedEvent: false,
            });
        }
        this.#connections.clear();
        this.#sessions.clear();
        this.#fileBuffers.clear();
        this.#emitLog("info", "AI worker shutting down.", {
            trackedBuffers: this.#fileBuffers.size,
        });
    }

    #notifyFileBuffer(input: AiWorkerRpcMethodMap["ai.notifyFileBuffer"]["params"]): void {
        if (input.content === null) {
            this.#fileBuffers.delete(input.absolutePath);
        } else {
            this.#fileBuffers.set(input.absolutePath, input.content);
        }

        this.#emitLog("debug", "Mirrored file buffer state into AI worker.", {
            absolutePath: input.absolutePath,
            action: input.content === null ? "forget" : "record",
            trackedBuffers: this.#fileBuffers.size,
        });
    }

    async #prepareSession(
        params: AiWorkerRpcMethodMap["ai.prepareSession"]["params"],
    ): Promise<AiSessionSnapshot> {
        const liveSession = await this.#ensureRuntimeSession(params.launch);
        return liveSession.snapshot;
    }

    async #sendPrompt(
        params: AiWorkerRpcMethodMap["ai.sendPrompt"]["params"],
    ): Promise<AiPromptResult> {
        const liveSession = await this.#ensureRuntimeSession(params.launch);
        if (
            liveSession.snapshot.status === "starting" ||
            liveSession.snapshot.status === "streaming" ||
            liveSession.snapshot.status === "waiting_permission" ||
            liveSession.snapshot.status === "waiting_user_input"
        ) {
            throw new SessionBusyError();
        }

        const now = new Date().toISOString();
        const promptText = params.input.prompt.trim();
        if (params.input.attachments.length > MAX_IMAGE_ATTACHMENTS) {
            throw new Error(getImageAttachmentLimitMessage());
        }
        const displayContent = serializeComposerPartsForDisplay(
            params.input.composerParts,
            promptText,
        );
        if (!promptText && params.input.attachments.length === 0) {
            throw new Error("Type a prompt before sending it.");
        }

        const userMessageId = randomUUID();
        const promptContentBlocks = buildPromptContentBlocks(
            promptText,
            params.input.attachments,
        );
        liveSession.preEditSnapshots.clear();
        this.#clearSubagentMirrorTurn(liveSession);
        this.#setPendingUserTextEcho(liveSession, {
            expectedContentBlocks: promptContentBlocks,
            expectedTexts: [promptText, displayContent],
            messageId: userMessageId,
        });
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            activeTurnStartedAt: now,
            lastError: null,
            messages: [
                ...liveSession.snapshot.messages,
                {
                    attachments: params.input.attachments,
                    content: displayContent,
                    createdAt: now,
                    id: userMessageId,
                    kind: "user",
                    status: "completed",
                },
            ],
            pendingPermission: null,
            pendingUserInput: null,
            projectId: params.input.projectId,
            status: "starting",
            title: resolveSessionTitleOnPrompt({
                currentTitle: liveSession.snapshot.title,
                fallbackTitle: params.input.title,
                displayContent,
                hasPriorUserMessage: liveSession.snapshot.messages.some(
                    (message) => message.kind === "user",
                ),
            }),
            updatedAt: now,
            worktreeId: params.input.worktreeId ?? null,
        });
        this.#queueSnapshotFlush(liveSession);

        try {
            const response = await liveSession.connection.prompt({
                messageId: userMessageId,
                prompt: promptContentBlocks,
                sessionId: this.#requireRuntimeSessionId(liveSession),
            });

            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                activeTurnStartedAt: null,
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);
            this.#clearPendingUserTextEcho(liveSession);

            return {
                sessionId: params.input.sessionId,
                stopReason: response.stopReason,
            };
        } catch (error) {
            this.#clearPendingUserTextEcho(liveSession);
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(params.input.runtimeId)} could not complete the prompt.`;
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                activeTurnStartedAt: null,
                lastError: message,
                pendingPermission: null,
                pendingUserInput: null,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);
            throw error;
        }
    }

    async #cancelSession(sessionId: string): Promise<void> {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession?.snapshot.runtimeSessionId) {
            return;
        }

        this.#resolvePendingPermission(liveSession, null);
        try {
            await liveSession.connection.cancel({
                sessionId: liveSession.snapshot.runtimeSessionId,
            });
        } catch (error) {
            debugBenignError("ai.worker.cancelSession", error);
        } finally {
            if (this.#sessions.get(sessionId) === liveSession) {
                this.#markLiveSessionIdle(liveSession);
            }
        }
    }

    #closeSession(sessionId: string): void {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession) {
            return;
        }

        this.#disposeLiveSession(sessionId, liveSession, {
            emitClosedEvent: true,
        });
    }

    #markLiveSessionIdle(liveSession: LiveAcpSession): void {
        liveSession.activeTurnId = null;
        this.#clearPendingUserTextEcho(liveSession);
        this.#clearSubagentMirrorTurn(liveSession);
        if (
            liveSession.snapshot.status !== "streaming" &&
            liveSession.snapshot.status !== "starting" &&
            liveSession.snapshot.status !== "waiting_permission" &&
            liveSession.snapshot.status !== "waiting_user_input"
        ) {
            return;
        }

        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            activeTurnStartedAt: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "idle",
            updatedAt: new Date().toISOString(),
        });
        this.#queueSnapshotFlush(liveSession);
        this.#schedulePendingScopeRefresh(liveSession.snapshot.sessionId);
    }

    #closeOwnedByWindow(ownerWindowId: string): void {
        const sessionIds = [...this.#sessions.entries()]
            .filter(
                ([, liveSession]) =>
                    liveSession.ownerWindowId === ownerWindowId,
            )
            .map(([sessionId]) => sessionId);

        for (const sessionId of sessionIds) {
            const liveSession = this.#sessions.get(sessionId);
            if (!liveSession) {
                continue;
            }

            this.#disposeLiveSession(sessionId, liveSession, {
                emitClosedEvent: true,
            });
        }
    }

    async #keepTrackedFile(
        params: AiWorkerRpcMethodMap["ai.keepTrackedFile"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, (session) => {
            session.snapshot = {
                ...session.snapshot,
                trackedFiles: session.snapshot.trackedFiles.filter(
                    (trackedFile) => trackedFile.path !== params.input.path,
                ),
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #rejectTrackedFile(
        params: AiWorkerRpcMethodMap["ai.rejectTrackedFile"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, async (session) => {
            const trackedFile = session.snapshot.trackedFiles.find(
                (candidate) => candidate.path === params.input.path,
            );
            if (!trackedFile) {
                throw new Error("The file to review was not found.");
            }

            await this.#revertTrackedFile(session, trackedFile);
            session.snapshot = {
                ...session.snapshot,
                trackedFiles: session.snapshot.trackedFiles.filter(
                    (candidate) => candidate.path !== params.input.path,
                ),
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #keepTrackedFileHunks(
        params: AiWorkerRpcMethodMap["ai.keepTrackedFileHunks"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, (session) => {
            const trackedFile = session.snapshot.trackedFiles.find(
                (candidate) => candidate.path === params.input.path,
            );
            if (!trackedFile) {
                throw new Error("The file to review was not found.");
            }

            const nextTrackedFile = resolveTrackedFileHunks(
                trackedFile,
                params.input.hunkIds,
                "keep",
            );
            session.snapshot = {
                ...session.snapshot,
                trackedFiles: replaceTrackedFile(
                    session.snapshot.trackedFiles,
                    trackedFile.path,
                    nextTrackedFile,
                ),
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #rejectTrackedFileHunks(
        params: AiWorkerRpcMethodMap["ai.rejectTrackedFileHunks"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, async (session) => {
            const trackedFile = session.snapshot.trackedFiles.find(
                (candidate) => candidate.path === params.input.path,
            );
            if (!trackedFile) {
                throw new Error("The file to review was not found.");
            }

            const nextTrackedFile = resolveTrackedFileHunks(
                trackedFile,
                params.input.hunkIds,
                "reject",
            );

            if (!nextTrackedFile) {
                await this.#revertTrackedFile(session, trackedFile);
            } else if (nextTrackedFile.newText !== null) {
                await this.#applyTrackedFileText(
                    session,
                    nextTrackedFile,
                    trackedFile,
                );
            }

            session.snapshot = {
                ...session.snapshot,
                trackedFiles: replaceTrackedFile(
                    session.snapshot.trackedFiles,
                    trackedFile.path,
                    nextTrackedFile,
                ),
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #keepAllTrackedFiles(
        params: AiWorkerRpcMethodMap["ai.keepAllTrackedFiles"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, (session) => {
            session.snapshot = {
                ...session.snapshot,
                trackedFiles: [],
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #rejectAllTrackedFiles(
        params: AiWorkerRpcMethodMap["ai.rejectAllTrackedFiles"]["params"],
    ): Promise<AiWorkerReviewMutationResult> {
        return await this.#withReviewSession(params.context, async (session) => {
            const trackedFiles = session.snapshot.trackedFiles;
            for (const trackedFile of trackedFiles) {
                await this.#assertTrackedFileCanBeReverted(session, trackedFile);
            }

            const rollbackState =
                await this.#createTrackedFileRollbackBackups(
                    session,
                    trackedFiles,
                );

            try {
                for (const trackedFile of trackedFiles) {
                    await this.#revertTrackedFile(session, trackedFile);
                }
            } catch (error) {
                await this.#restoreTrackedFileRollbackState(rollbackState);
                throw error;
            }

            session.snapshot = {
                ...session.snapshot,
                trackedFiles: [],
                updatedAt: new Date().toISOString(),
            };
        });
    }

    #respondPermission(
        params: AiWorkerRpcMethodMap["ai.respondPermission"]["params"],
    ): void {
        const liveSession = this.#sessions.get(params.input.sessionId);
        if (!liveSession) {
            throw new Error("There is no pending permission request.");
        }

        const pendingPermission = liveSession.pendingPermissions.get(
            params.input.requestId,
        );
        if (!pendingPermission) {
            throw new Error("The permission request no longer matches.");
        }

        liveSession.pendingPermissions.delete(params.input.requestId);
        const visiblePendingPermission =
            this.#latestPendingPermission(liveSession);
        const visiblePendingEntry = visiblePendingPermission
            ? liveSession.pendingPermissions.get(visiblePendingPermission.requestId)
            : null;
        liveSession.pendingPermission =
            visiblePendingPermission && visiblePendingEntry
                ? {
                      requestId: visiblePendingPermission.requestId,
                      resolve: visiblePendingEntry.resolve,
                  }
                : null;
        liveSession.snapshot = {
            ...liveSession.snapshot,
            pendingPermission: visiblePendingPermission,
            status: visiblePendingPermission ? "waiting_permission" : "streaming",
            updatedAt: new Date().toISOString(),
        };
        this.#queueSnapshotFlush(liveSession);

        pendingPermission.resolve(
            params.input.optionId
                ? {
                      _meta: null,
                      outcome: {
                          optionId: params.input.optionId,
                          outcome: "selected",
                      },
                  }
                : {
                      _meta: null,
                      outcome: {
                          outcome: "cancelled",
                      },
                  },
        );
    }

    async #respondUserInput(
        params: AiWorkerRpcMethodMap["ai.respondUserInput"]["params"],
    ): Promise<void> {
        const liveSession = this.#sessions.get(params.input.sessionId);
        if (!liveSession) {
            throw new Error("The AI session was not found.");
        }

        const pendingUserInput = liveSession.snapshot.pendingUserInput;
        if (!pendingUserInput) {
            throw new Error("There is no pending input request.");
        }

        if (pendingUserInput.requestId !== params.input.requestId) {
            throw new Error("The input request no longer matches.");
        }

        const answers = params.input.answers
            .filter(
                (answer) =>
                    answer.questionId.trim().length > 0 &&
                    answer.answers.some((value) => value.trim().length > 0),
            )
            .map((answer) => ({
                answers: answer.answers
                    .map((value) => value.trim())
                    .filter(Boolean),
                questionId: answer.questionId,
            }))
            .filter((answer) => answer.answers.length > 0);

        if (!pendingUserInput.turnId) {
            throw new Error("Input request is missing a valid turnId.");
        }

        const promptText = buildUserInputResponsePrompt(
            pendingUserInput.turnId,
            answers,
        );
        const responseMessageId = randomUUID();
        const now = new Date().toISOString();

        this.#setPendingUserTextEcho(liveSession, {
            expectedTexts: [promptText],
            messageId: responseMessageId,
        });
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            activeTurnStartedAt: liveSession.snapshot.activeTurnStartedAt ?? now,
            lastError: null,
            messages: [
                ...liveSession.snapshot.messages,
                {
                    attachments: [],
                    content: summarizeUserInputAnswers(
                        pendingUserInput.questions,
                        answers,
                    ),
                    createdAt: now,
                    id: randomUUID(),
                    kind: "user",
                    status: "completed",
                },
            ],
            pendingUserInput: null,
            status: "starting",
            updatedAt: now,
        });
        this.#queueSnapshotFlush(liveSession);

        try {
            await liveSession.connection.prompt({
                messageId: responseMessageId,
                prompt: [
                    {
                        text: promptText,
                        type: "text",
                    },
                ],
                sessionId: this.#requireRuntimeSessionId(liveSession),
            });

            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                activeTurnStartedAt: null,
                status: "idle",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);
            this.#clearPendingUserTextEcho(liveSession);
        } catch (error) {
            this.#clearPendingUserTextEcho(liveSession);
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(liveSession.runtimeId)} ACP could not send the guided response.`;
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                activeTurnStartedAt: null,
                lastError: message,
                pendingUserInput,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);
            throw error;
        }
    }

    async #refreshProjectScopes(
        input: AiWorkerRefreshProjectScopesRpcInput,
    ): Promise<void> {
        const refreshTasks = input.sessions.map(async (launch) => {
            const liveSession = this.#sessions.get(launch.input.sessionId);
            if (!liveSession) {
                return;
            }

            try {
                await this.#refreshLiveSessionScopes(liveSession, launch);
            } catch (error) {
                console.error(
                    `[ai-worker] refreshProjectScopes failed for session ${launch.input.sessionId}`,
                    error,
                );
            }
        });

        await Promise.all(refreshTasks);
    }

    async #setSessionMode(
        input: AiWorkerRpcMethodMap["ai.setSessionMode"]["params"],
    ): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            throw new Error("The AI session was not found.");
        }

        await liveSession.connection.setSessionMode({
            modeId: input.modeId,
            sessionId: this.#requireRuntimeSessionId(liveSession),
        });

        liveSession.snapshot = setModeOnSnapshot(liveSession.snapshot, input.modeId);
        this.#queueSnapshotFlush(liveSession);
    }

    async #setSessionModel(
        input: AiWorkerRpcMethodMap["ai.setSessionModel"]["params"],
    ): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            throw new Error("The AI session was not found.");
        }

        await liveSession.connection.unstable_setSessionModel({
            modelId: input.modelId,
            sessionId: this.#requireRuntimeSessionId(liveSession),
        });

        liveSession.snapshot = setModelOnSnapshot(
            liveSession.snapshot,
            input.modelId,
        );
        this.#queueSnapshotFlush(liveSession);
    }

    async #setSessionConfigOption(
        input: AiWorkerRpcMethodMap["ai.setSessionConfigOption"]["params"],
    ): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            throw new Error("The AI session was not found.");
        }

        const response =
            typeof input.value === "boolean"
                ? await liveSession.connection.setSessionConfigOption({
                      configId: input.optionId,
                      sessionId: this.#requireRuntimeSessionId(liveSession),
                      type: "boolean",
                      value: input.value,
                  })
                : await liveSession.connection.setSessionConfigOption({
                      configId: input.optionId,
                      sessionId: this.#requireRuntimeSessionId(liveSession),
                      value: input.value,
                  });

        liveSession.snapshot = applySessionCatalogToSnapshot(
            {
                ...liveSession.snapshot,
                updatedAt: new Date().toISOString(),
            },
            {
                configOptions: response.configOptions,
            },
        );
        liveSession.snapshot = setConfigOptionOnSnapshot(
            liveSession.snapshot,
            input.optionId,
            input.value,
        );
        this.#queueSnapshotFlush(liveSession);
    }

    #renameSession(
        input: AiWorkerRpcMethodMap["ai.renameSession"]["params"],
    ): void {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            throw new Error("The AI session was not found.");
        }

        if (liveSession.snapshot.title === input.title) {
            return;
        }

        liveSession.snapshot = setTitleOnSnapshot(liveSession.snapshot, input.title);
        this.#flushSnapshotEvent(liveSession);
    }

    async #ensureRuntimeSession(
        launch: AiWorkerSessionLaunchInput,
    ): Promise<LiveAcpSession> {
        const existing = this.#sessions.get(launch.input.sessionId);
        if (
            existing?.snapshot.runtimeSessionId &&
            existing.runtimeId === launch.input.runtimeId &&
            sameAdditionalRoots(existing.additionalRoots, launch.additionalRoots)
        ) {
            existing.ownerWindowId = launch.ownerWindowId;
            existing.runtimeConnection.ownerWindowId = launch.ownerWindowId;
            existing.desiredSelections = launch.desiredSelections;
            existing.projectRoot = launch.projectRoot;
            existing.cwd = launch.cwd;
            return existing;
        }
        if (existing) {
            this.#disposeLiveSession(launch.input.sessionId, existing, {
                closeRuntimeSession: false,
                emitClosedEvent: false,
            });
        }

        const child = spawn(
            launch.resolvedRuntime.executable,
            [...launch.resolvedRuntime.args],
            {
                cwd: launch.cwd,
                env: launch.resolvedRuntime.env,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        const liveConnection = {} as LiveAcpConnection;
        const liveSession = {} as LiveAcpSession;
        const client: Client = {
            createTerminal: (params) =>
                this.#createTerminal(
                    this.#requireLiveSessionForRuntimeRequest(
                        liveConnection,
                        params.sessionId,
                    ),
                    params,
                ),
            killTerminal: (params) =>
                Promise.resolve(
                    this.#killTerminal(
                        this.#requireLiveSessionForRuntimeRequest(
                            liveConnection,
                            params.sessionId,
                        ),
                        params,
                    ),
                ),
            readTextFile: async (params) =>
                this.#readTextFile(
                    this.#requireLiveSessionForRuntimeRequest(
                        liveConnection,
                        params.sessionId,
                    ),
                    params,
                ),
            requestPermission: async (params) =>
                this.#requestPermission(
                    this.#requireLiveSessionForRuntimeRequest(
                        liveConnection,
                        params.sessionId,
                    ),
                    params,
                ),
            releaseTerminal: (params) =>
                Promise.resolve(
                    this.#releaseTerminal(
                        this.#requireLiveSessionForRuntimeRequest(
                            liveConnection,
                            params.sessionId,
                        ),
                        params,
                    ),
                ),
            sessionUpdate: async (params) =>
                this.#handleRuntimeSessionUpdate(liveConnection, params),
            terminalOutput: (params) =>
                Promise.resolve(
                    this.#terminalOutput(
                        this.#requireLiveSessionForRuntimeRequest(
                            liveConnection,
                            params.sessionId,
                        ),
                        params,
                    ),
                ),
            waitForTerminalExit: async (params) =>
                this.#waitForTerminalExit(
                    this.#requireLiveSessionForRuntimeRequest(
                        liveConnection,
                        params.sessionId,
                    ),
                    params,
                ),
            writeTextFile: async (params) =>
                this.#writeTextFile(
                    this.#requireLiveSessionForRuntimeRequest(
                        liveConnection,
                        params.sessionId,
                    ),
                    params,
                ),
        };
        const stream = ndJsonStream(
            toWebByteWritable(child.stdin),
            toWebByteReadable(child.stdout),
        );
        const connection = new ClientSideConnection(() => client, stream);
        const persistedSnapshot = launch.persistedSnapshot;
        Object.assign(liveConnection, {
            appSessionIdByRuntimeSessionId: new Map(),
            child,
            closing: false,
            connection,
            connectionId: randomUUID(),
            ownerWindowId: launch.ownerWindowId,
            pendingSessionUpdatesByRuntimeSessionId: new Map(),
            resolvedRuntime: launch.resolvedRuntime,
            runtimeId: launch.input.runtimeId,
            sessionsByAppSessionId: new Map(),
            stderrChunks: [],
            stderrHandler: null,
        } satisfies LiveAcpConnection);

        Object.assign(liveSession, {
            additionalRoots: launch.additionalRoots,
            activeTurnId: null,
            child,
            closing: false,
            connection,
            cwd: launch.cwd,
            desiredSelections: launch.desiredSelections,
            isRestoring: false,
            lastBroadcastSnapshot: null,
            ownerWindowId: launch.ownerWindowId,
            pendingAdditionalRoots: null,
            pendingLaunch: null,
            pendingPermission: null,
            pendingPermissions: new Map(),
            pendingPersistTimer: null,
            processedDiffPaths: new Map(),
            projectRoot: launch.projectRoot,
            resolvedRuntime: launch.resolvedRuntime,
            runtimeConnection: liveConnection,
            runtimeId: launch.input.runtimeId,
            snapshot: {
                ...persistedSnapshot,
                projectId: launch.input.projectId,
                runtimeId: launch.input.runtimeId,
                status: getPreparedSessionStatus(persistedSnapshot),
                title:
                    persistedSnapshot.title &&
                    !isDefaultChatTitle(persistedSnapshot.title)
                        ? persistedSnapshot.title
                        : launch.input.title,
                updatedAt: new Date().toISOString(),
                worktreeId: launch.input.worktreeId ?? null,
            },
            terminals: new Map(),
            terminalOutputBuffers: new Map(),
            preEditSnapshots: new Map(),
            stderrChunks: [],
            stderrHandler: null,
        } satisfies LiveAcpSession);

        const stderrHandler = (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            liveConnection.stderrChunks.push(text);
            if (liveConnection.stderrChunks.length > 20) {
                liveConnection.stderrChunks.shift();
            }
        };
        liveConnection.stderrHandler = stderrHandler;
        child.stderr.on("data", stderrHandler);
        // Attach no-crash listeners for any 'error' event on the child process
        // and its stdio streams. Without these, an EPIPE or spawn/kill failure
        // on one session would surface as an unhandled EventEmitter 'error'
        // and terminate the whole AI worker thread, taking every concurrent
        // session down with it. The 'exit' handler below remains the source of
        // truth for finalizing session state.
        const swallowStreamError =
            (streamName: "stdin" | "stdout" | "stderr") =>
            (error: unknown) => {
                debugBenignError(
                    `ai.worker.child.${streamName}`,
                    error,
                );
            };
        child.on("error", (error) => {
            debugBenignError("ai.worker.child.process", error);
        });
        child.stdin.on("error", swallowStreamError("stdin"));
        child.stdout.on("error", swallowStreamError("stdout"));
        child.stderr.on("error", swallowStreamError("stderr"));
        child.on("exit", (code, signal) => {
            this.#handleProcessExit(liveConnection, code, signal);
        });
        this.#sessions.set(launch.input.sessionId, liveSession);
        this.#connections.set(liveConnection.connectionId, liveConnection);
        liveConnection.sessionsByAppSessionId.set(
            launch.input.sessionId,
            liveSession,
        );
        this.#queueSnapshotFlush(liveSession);

        try {
            await connection.initialize({
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true,
                    },
                    terminal: true,
                },
                clientInfo: {
                    name: "comando",
                    title: "Comando",
                    version: process.versions.electron,
                },
                protocolVersion: PROTOCOL_VERSION,
            });

            const openedSession = await this.#openRuntimeSession(liveSession);
            liveSession.snapshot = {
                ...applySessionCatalogToSnapshot(
                    liveSession.snapshot,
                    openedSession,
                ),
                lastError: null,
                runtimeSessionId: openedSession.runtimeSessionId,
            };
            this.#registerRuntimeSessionMapping(
                liveConnection,
                launch.input.sessionId,
                openedSession.runtimeSessionId,
            );
            await this.#applyStoredSessionSelections(liveSession);
            liveSession.snapshot = {
                ...liveSession.snapshot,
                lastError: null,
                status: getPreparedSessionStatus(liveSession.snapshot),
                updatedAt: new Date().toISOString(),
            };
            this.#queueSnapshotFlush(liveSession);
            return liveSession;
        } catch (error) {
            const stderrText = getRecentStderrText(liveConnection.stderrChunks);
            const message =
                stderrText ||
                (error instanceof Error
                    ? error.message
                    : `Could not start ${getRuntimeDisplayName(launch.input.runtimeId)} ACP.`);
            liveSession.snapshot = {
                ...liveSession.snapshot,
                lastError: message,
                status: "error",
                updatedAt: new Date().toISOString(),
            };
            this.#queueSnapshotFlush(liveSession);
            this.#disposeLiveSession(launch.input.sessionId, liveSession, {
                emitClosedEvent: false,
            });
            throw error;
        }
    }

    async #openRuntimeSession(
        liveSession: LiveAcpSession,
    ): Promise<{
        readonly configOptions: Awaited<
            ReturnType<LiveAcpSession["connection"]["newSession"]>
        >["configOptions"] | null | undefined;
        readonly models: Awaited<
            ReturnType<LiveAcpSession["connection"]["newSession"]>
        >["models"] | null | undefined;
        readonly modes: Awaited<
            ReturnType<LiveAcpSession["connection"]["newSession"]>
        >["modes"] | null | undefined;
        readonly runtimeSessionId: string;
    }> {
        const additionalDirectories =
            liveSession.additionalRoots.length > 0
                ? [...liveSession.additionalRoots]
                : undefined;

        if (liveSession.snapshot.runtimeSessionId) {
            try {
                liveSession.isRestoring = true;
                const response = await liveSession.connection.loadSession({
                    additionalDirectories,
                    cwd: liveSession.cwd,
                    mcpServers: [],
                    sessionId: liveSession.snapshot.runtimeSessionId,
                });
                return {
                    configOptions: response.configOptions ?? null,
                    models: response.models ?? null,
                    modes: response.modes ?? null,
                    runtimeSessionId: liveSession.snapshot.runtimeSessionId,
                };
            } catch (error) {
                debugBenignError("ai.worker.loadSession.resume", error);
            } finally {
                liveSession.isRestoring = false;
            }
        }

        const response = await liveSession.connection.newSession({
            additionalDirectories,
            cwd: liveSession.cwd,
            mcpServers: [],
        });

        return {
            configOptions: response.configOptions ?? null,
            models: response.models ?? null,
            modes: response.modes ?? null,
            runtimeSessionId: response.sessionId,
        };
    }

    async #requestPermission(
        liveSession: LiveAcpSession,
        params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
        const requestId = randomUUID();
        const pendingPermission: AiPermissionRequest = {
            description: buildPermissionDescription(params.toolCall),
            options: params.options.map((option) => ({
                kind: option.kind,
                name: option.name,
                optionId: option.optionId,
            })),
            requestId,
            sessionId: liveSession.snapshot.sessionId,
            title: params.toolCall.title ?? "Permission required",
            toolCallId: params.toolCall.toolCallId,
            updatedAt: new Date().toISOString(),
        };

        liveSession.snapshot = {
            ...liveSession.snapshot,
            pendingPermission,
            pendingUserInput: null,
            status: "waiting_permission",
            updatedAt: new Date().toISOString(),
        };
        this.#queueSnapshotFlush(liveSession);

        return await new Promise<RequestPermissionResponse>((resolve) => {
            liveSession.pendingPermissions.set(requestId, {
                request: pendingPermission,
                resolve,
            });
            liveSession.pendingPermission = {
                requestId,
                resolve,
            };
        });
    }

    #handleRuntimeSessionUpdate(
        liveConnection: LiveAcpConnection,
        params: SessionNotification,
    ): Promise<void> {
        const liveSession = this.#resolveLiveSessionForRuntimeSessionId(
            liveConnection,
            params.sessionId,
        );
        if (liveSession) {
            const meta = getSessionNotificationMeta(params);
            if (
                readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) ===
                CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE
            ) {
                const runtimeParentSessionId = readMetaString(
                    meta,
                    CODEX_ACP_PARENT_SESSION_ID_KEY,
                );
                const parentAppSessionId = runtimeParentSessionId
                    ? (liveConnection.appSessionIdByRuntimeSessionId.get(
                          runtimeParentSessionId,
                      ) ?? null)
                    : null;
                const parentSession = parentAppSessionId
                    ? (liveConnection.sessionsByAppSessionId.get(
                          parentAppSessionId,
                      ) ?? null)
                    : null;
                if (parentSession && parentSession !== liveSession) {
                    this.#applySubagentSessionMetadata(
                        liveSession,
                        parentSession,
                        params,
                        meta,
                    );
                }
            }
            return this.#handleSessionUpdate(liveSession, params);
        }

        const subagentSession = this.#createSubagentLiveSessionFromNotification(
            liveConnection,
            params,
        );
        if (subagentSession) {
            const result = this.#handleSessionUpdate(subagentSession, params);
            this.#flushSnapshotEvent(subagentSession);
            return result;
        }

        // Some fast runtimes can emit session updates before newSession/loadSession
        // unwinds and gives us the runtime session ID to map.
        this.#bufferPendingSessionUpdate(liveConnection, params);
        return Promise.resolve();
    }

    #createSubagentLiveSessionFromNotification(
        liveConnection: LiveAcpConnection,
        params: SessionNotification,
    ): LiveAcpSession | null {
        const meta = getSessionNotificationMeta(params);
        if (
            readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) !==
            CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE
        ) {
            return null;
        }

        return this.#ensureSubagentLiveSessionFromMeta(
            liveConnection,
            params,
            meta,
        );
    }

    #ensureSubagentLiveSessionFromMeta(
        liveConnection: LiveAcpConnection,
        params: SessionNotification,
        meta: Record<string, unknown>,
    ): LiveAcpSession | null {
        const runtimeChildSessionId =
            readMetaString(meta, CODEX_ACP_CHILD_SESSION_ID_KEY) ??
            params.sessionId;
        const runtimeParentSessionId = readMetaString(
            meta,
            CODEX_ACP_PARENT_SESSION_ID_KEY,
        );
        if (!runtimeParentSessionId) {
            this.#emitLog("warn", "Ignoring subagent session without parent.", {
                runtimeChildSessionId,
                runtimeId: liveConnection.runtimeId,
            });
            return null;
        }

        const parentAppSessionId =
            liveConnection.appSessionIdByRuntimeSessionId.get(
                runtimeParentSessionId,
            ) ?? null;
        const parentSession = parentAppSessionId
            ? liveConnection.sessionsByAppSessionId.get(parentAppSessionId) ??
              null
            : null;
        if (!parentAppSessionId || !parentSession) {
            this.#emitLog(
                "warn",
                "Ignoring subagent session for unknown parent runtime session.",
                {
                    runtimeChildSessionId,
                    runtimeId: liveConnection.runtimeId,
                    runtimeParentSessionId,
                },
            );
            return null;
        }

        const existingAppSessionId =
            liveConnection.appSessionIdByRuntimeSessionId.get(
                runtimeChildSessionId,
            ) ?? null;
        if (existingAppSessionId) {
            const existingSession =
                liveConnection.sessionsByAppSessionId.get(existingAppSessionId) ??
                null;
            if (existingSession) {
                this.#applySubagentSessionMetadata(
                    existingSession,
                    parentSession,
                    params,
                    meta,
                );
            }
            return existingSession;
        }

        const now = new Date().toISOString();
        const appSessionId = randomUUID();
        const title =
            readMetaString(meta, CODEX_ACP_AGENT_NICKNAME_KEY) ??
            readSessionInfoTitle(params.update) ??
            "Subagent";
        const cwd =
            readMetaString(meta, CODEX_ACP_CWD_KEY)?.trim() ||
            parentSession.cwd;
        let snapshot: AiSessionSnapshot = {
            activeTurnStartedAt: null,
            availableCommands: parentSession.snapshot.availableCommands,
            configOptions: parentSession.snapshot.configOptions,
            lastError: null,
            messages: [],
            modeId: parentSession.snapshot.modeId,
            modes: parentSession.snapshot.modes,
            modelId: parentSession.snapshot.modelId,
            models: parentSession.snapshot.models,
            parentSessionId: parentAppSessionId,
            pendingPermission: null,
            pendingUserInput: null,
            plan: null,
            projectId: parentSession.snapshot.projectId,
            runtimeId: liveConnection.runtimeId,
            runtimeSessionId: runtimeChildSessionId,
            sessionId: appSessionId,
            status: "idle",
            title,
            tokenUsage: null,
            toolActivity: [],
            trackedFiles: [],
            updatedAt: now,
            worktreeId: parentSession.snapshot.worktreeId ?? null,
        };
        snapshot = applyCodexAcpSubagentModelMetadataToSnapshot(
            snapshot,
            meta,
            now,
        );
        const subagentSession: LiveAcpSession = {
            additionalRoots: parentSession.additionalRoots,
            activeTurnId: null,
            child: liveConnection.child,
            closing: false,
            connection: liveConnection.connection,
            cwd,
            desiredSelections: parentSession.desiredSelections,
            isRestoring: false,
            lastBroadcastSnapshot: null,
            ownerWindowId: liveConnection.ownerWindowId,
            pendingAdditionalRoots: null,
            pendingLaunch: null,
            pendingPermission: null,
            pendingPermissions: new Map(),
            pendingPersistTimer: null,
            preEditSnapshots: new Map(),
            processedDiffPaths: new Map(),
            projectRoot: parentSession.projectRoot,
            resolvedRuntime: liveConnection.resolvedRuntime,
            runtimeConnection: liveConnection,
            runtimeId: liveConnection.runtimeId,
            snapshot,
            stderrChunks: liveConnection.stderrChunks,
            stderrHandler: null,
            terminalOutputBuffers: new Map(),
            terminals: new Map(),
        };

        this.#sessions.set(appSessionId, subagentSession);
        liveConnection.sessionsByAppSessionId.set(appSessionId, subagentSession);
        this.#registerRuntimeSessionMapping(
            liveConnection,
            appSessionId,
            runtimeChildSessionId,
        );
        this.#emitLog("debug", "Registered ACP subagent session.", {
            parentSessionId: parentAppSessionId,
            runtimeChildSessionId,
            runtimeId: liveConnection.runtimeId,
            sessionId: appSessionId,
        });
        this.#queueSnapshotFlush(subagentSession);
        return subagentSession;
    }

    #applySubagentSessionMetadata(
        childSession: LiveAcpSession,
        parentSession: LiveAcpSession,
        params: SessionNotification,
        meta: Record<string, unknown>,
    ): void {
        const now = new Date().toISOString();
        const title =
            readMetaString(meta, CODEX_ACP_AGENT_NICKNAME_KEY) ??
            readSessionInfoTitle(params.update);
        const cwd =
            readMetaString(meta, CODEX_ACP_CWD_KEY)?.trim() ||
            childSession.cwd ||
            parentSession.cwd;
        let nextSnapshot = childSession.snapshot;

        childSession.cwd = cwd;
        if (
            title &&
            title !== nextSnapshot.title &&
            nextSnapshot.title === "Subagent"
        ) {
            nextSnapshot = {
                ...nextSnapshot,
                title,
                updatedAt: now,
            };
        }
        nextSnapshot = applyCodexAcpSubagentModelMetadataToSnapshot(
            nextSnapshot,
            meta,
            now,
        );

        if (nextSnapshot !== childSession.snapshot) {
            childSession.snapshot = nextSnapshot;
            this.#queueSnapshotFlush(childSession);
        }
    }

    #handleSessionUpdate(
        liveSession: LiveAcpSession,
        params: SessionNotification,
    ): Promise<void> {
        const now = new Date().toISOString();
        const update = params.update;
        const meta = getSessionNotificationMeta(params);
        if (this.#handleTurnLifecycleUpdate(liveSession, meta, now)) {
            return Promise.resolve();
        }

        if (
            liveSession.isRestoring &&
            (update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "plan" ||
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update")
        ) {
            return Promise.resolve();
        }

        if (shouldSuppressSessionToolActivityUpdate(liveSession.snapshot, update)) {
            return Promise.resolve();
        }

        if (
            update.sessionUpdate === "user_message_chunk" &&
            isInternalUserInputResponseEcho(update.content) &&
            !this.#pendingUserTextEchoes.has(liveSession.snapshot.sessionId)
        ) {
            return Promise.resolve();
        }

        const shouldMarkStreaming =
            update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk" ||
            update.sessionUpdate === "plan" ||
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update" ||
            (update.sessionUpdate === "available_commands_update" &&
                liveSession.snapshot.status === "starting");
        const nextStatus: AiSessionSnapshot["status"] =
            liveSession.snapshot.status === "waiting_permission"
                ? "waiting_permission"
                : liveSession.snapshot.status === "waiting_user_input"
                  ? "waiting_user_input"
                  : shouldMarkStreaming
                    ? "streaming"
                    : liveSession.snapshot.status;
        let nextSnapshot: AiSessionSnapshot = {
            ...liveSession.snapshot,
            activeTurnStartedAt:
                nextStatus === "streaming" &&
                liveSession.snapshot.activeTurnStartedAt === null &&
                isDirectStreamingSessionUpdate(update)
                    ? now
                    : liveSession.snapshot.activeTurnStartedAt,
            status: nextStatus,
            updatedAt: now,
        };

        switch (update.sessionUpdate) {
            case "user_message_chunk": {
                const echoResult = this.#applyPendingUserTextEcho(
                    liveSession,
                    nextSnapshot,
                    update.content,
                    update.messageId ?? null,
                );
                nextSnapshot = echoResult.snapshot;
                if (!echoResult.handled) {
                    if (!isInternalUserInputResponseEcho(update.content)) {
                        nextSnapshot = appendContentBlockToSnapshot(
                            nextSnapshot,
                            "user",
                            update.content,
                            update.messageId ?? null,
                        );
                    }
                }
                break;
            }
            case "agent_message_chunk":
                this.#markSubagentAssistantOutputSeen(liveSession);
                nextSnapshot = appendContentBlockToSnapshot(
                    nextSnapshot,
                    "assistant",
                    update.content,
                    update.messageId ?? null,
                );
                break;
            case "agent_thought_chunk":
                nextSnapshot = appendContentBlockToSnapshot(
                    nextSnapshot,
                    "thinking",
                    update.content,
                    update.messageId ?? null,
                );
                break;
            case "tool_call":
                nextSnapshot = finalizeStreamingMessages(nextSnapshot);
                nextSnapshot = isImageGenerationToolUpdate(update)
                    ? mapImageGenerationToolUpdate(nextSnapshot, update, now)
                    : mapToolCallUpdate(
                          liveSession,
                          nextSnapshot,
                          update,
                          "tool_call",
                          now,
                          {
                              readOpenFileBuffer: (absolutePath) =>
                                  this.#fileBuffers.get(absolutePath) ?? null,
                          },
                      );
                break;
            case "tool_call_update":
                nextSnapshot = isImageGenerationToolUpdate(update)
                    ? mapImageGenerationToolUpdate(nextSnapshot, update, now)
                    : mapToolCallUpdate(
                          liveSession,
                          nextSnapshot,
                          update,
                          "tool_call_update",
                          now,
                          {
                              readOpenFileBuffer: (absolutePath) =>
                                  this.#fileBuffers.get(absolutePath) ?? null,
                          },
                      );
                break;
            case "plan":
                nextSnapshot = {
                    ...nextSnapshot,
                    plan: {
                        entries: update.entries.map((entry) => ({
                            content: entry.content,
                            priority: entry.priority,
                            status: entry.status,
                        })),
                        updatedAt: now,
                    },
                };
                break;
            case "available_commands_update":
                nextSnapshot = {
                    ...nextSnapshot,
                    availableCommands: update.availableCommands.map(
                        (command) => ({
                            description: command.description,
                            id: command.name,
                            insertText: `/${command.name} `,
                            label: `/${command.name}`,
                        }),
                    ),
                };
                break;
            case "current_mode_update":
                nextSnapshot = setModeOnSnapshot(
                    nextSnapshot,
                    update.currentModeId,
                    now,
                );
                break;
            case "config_option_update":
                nextSnapshot = applySessionCatalogToSnapshot(
                    {
                        ...nextSnapshot,
                        updatedAt: now,
                    },
                    {
                        configOptions: update.configOptions,
                    },
                );
                break;
            case "session_info_update": {
                const updatedAt = update.updatedAt ?? now;
                nextSnapshot = {
                    ...nextSnapshot,
                    title:
                        typeof update.title === "string" && update.title.trim()
                            ? update.title.trim()
                            : nextSnapshot.title,
                    updatedAt,
                };
                if (isSubagentLiveSession(liveSession)) {
                    nextSnapshot =
                        applyCodexAcpSubagentModelMetadataToSnapshot(
                            nextSnapshot,
                            meta,
                            updatedAt,
                        );
                }
                break;
            }
            case "usage_update": {
                const size = Number(update.size);
                const used = Number(update.used);
                if (!Number.isFinite(size) || size <= 0) {
                    break;
                }
                const cost =
                    update.cost &&
                    typeof update.cost.amount === "number" &&
                    typeof update.cost.currency === "string"
                        ? {
                              amount: update.cost.amount,
                              currency: update.cost.currency,
                          }
                        : null;
                nextSnapshot = {
                    ...nextSnapshot,
                    tokenUsage: {
                        cost,
                        size,
                        updatedAt: now,
                        used: Number.isFinite(used) ? Math.max(0, used) : 0,
                    },
                };
                break;
            }
            default:
                break;
        }

        const snapshotBeforeOpenSessionAction = nextSnapshot;
        nextSnapshot = this.#attachSubagentOpenSessionAction(
            liveSession,
            nextSnapshot,
            params,
        );
        const shouldFlushOpenSessionActionImmediately =
            nextSnapshot !== snapshotBeforeOpenSessionAction;
        this.#handleSubagentLifecycleBreadcrumb(liveSession, params, now);
        liveSession.snapshot = nextSnapshot;
        if (shouldFlushOpenSessionActionImmediately) {
            this.#flushSnapshotEvent(liveSession);
        } else {
            this.#queueSnapshotFlush(liveSession);
        }
        this.#schedulePendingScopeRefresh(liveSession.snapshot.sessionId);
        return Promise.resolve();
    }

    #setPendingUserTextEcho(
        liveSession: LiveAcpSession,
        input: {
            readonly expectedContentBlocks?: readonly ContentBlock[];
            readonly expectedTexts: readonly string[];
            readonly messageId: string | null;
        },
    ): void {
        const expectedTexts = [
            ...new Set(input.expectedTexts.map((text) => text.trim()).filter(Boolean)),
        ];
        const expectedContentBlocks = (input.expectedContentBlocks ?? []).filter(
            (content) => content.type !== "text",
        );
        if (expectedTexts.length === 0 && expectedContentBlocks.length === 0) {
            this.#clearPendingUserTextEcho(liveSession);
            return;
        }

        this.#pendingUserTextEchoes.set(liveSession.snapshot.sessionId, {
            bufferedText: "",
            expectedContentBlocks,
            expectedTexts,
            messageId: input.messageId,
            textMatched: false,
        });
    }

    #clearPendingUserTextEcho(liveSession: LiveAcpSession): void {
        this.#pendingUserTextEchoes.delete(liveSession.snapshot.sessionId);
    }

    #applyPendingUserTextEcho(
        liveSession: LiveAcpSession,
        snapshot: AiSessionSnapshot,
        content: ContentBlock,
        messageId: string | null,
    ): { readonly handled: boolean; readonly snapshot: AiSessionSnapshot } {
        const pending = this.#pendingUserTextEchoes.get(
            liveSession.snapshot.sessionId,
        );
        if (!pending) {
            return {
                handled: false,
                snapshot,
            };
        }

        const hasMatchingMessageId =
            Boolean(messageId) &&
            Boolean(pending.messageId) &&
            messageId === pending.messageId;
        if (content.type !== "text") {
            const matchesExpectedContent = pending.expectedContentBlocks.some(
                (expectedContent) =>
                    isSamePromptEchoContentBlock(expectedContent, content),
            );
            if (!matchesExpectedContent && hasMatchingMessageId) {
                this.#clearPendingUserTextEcho(liveSession);
                return {
                    handled: true,
                    snapshot: appendContentBlockToSnapshot(
                        snapshot,
                        "user",
                        content,
                        null,
                    ),
                };
            }

            return {
                handled: matchesExpectedContent,
                snapshot,
            };
        }

        const text = content.text;
        if (pending.textMatched && !hasMatchingMessageId) {
            this.#clearPendingUserTextEcho(liveSession);
            return {
                handled: false,
                snapshot,
            };
        }

        const wasTextMatched = pending.textMatched;
        pending.bufferedText = `${pending.bufferedText}${text}`;
        const normalizedBufferedText = normalizeEchoText(pending.bufferedText);
        const normalizedExpectedTexts = pending.expectedTexts
            .map(normalizeEchoText)
            .filter(Boolean);
        const matchesExpectedText = normalizedExpectedTexts.some(
            (expectedText) => expectedText === normalizedBufferedText,
        );
        const isExpectedPrefix =
            normalizedBufferedText.length === 0 ||
            normalizedExpectedTexts.some((expectedText) =>
                expectedText.startsWith(normalizedBufferedText),
            );

        if (isExpectedPrefix) {
            if (matchesExpectedText) {
                pending.textMatched = true;
                if (pending.expectedContentBlocks.length === 0) {
                    this.#clearPendingUserTextEcho(liveSession);
                }
            }
            return {
                handled: true,
                snapshot,
            };
        }

        const bufferedText = wasTextMatched ? text : pending.bufferedText;
        this.#clearPendingUserTextEcho(liveSession);
        return {
            handled: true,
            snapshot: appendContentBlockToSnapshot(
                snapshot,
                "user",
                {
                    text: bufferedText,
                    type: "text",
                },
                hasMatchingMessageId ? null : messageId,
            ),
        };
    }

    #setSubagentMirrorTurn(
        liveSession: LiveAcpSession,
        toolCallId: string,
    ): void {
        this.#subagentMirrorTurns.set(liveSession.snapshot.sessionId, {
            assistantOutputSeen: false,
            toolCallId,
        });
    }

    #clearSubagentMirrorTurn(liveSession: LiveAcpSession): void {
        this.#subagentMirrorTurns.delete(liveSession.snapshot.sessionId);
    }

    #markSubagentAssistantOutputSeen(liveSession: LiveAcpSession): void {
        if (!isSubagentLiveSession(liveSession)) {
            return;
        }

        const state = this.#subagentMirrorTurns.get(
            liveSession.snapshot.sessionId,
        );
        if (state) {
            state.assistantOutputSeen = true;
        }
    }

    #getSubagentMirrorTurn(
        liveSession: LiveAcpSession,
    ): SubagentMirrorTurnState | null {
        return (
            this.#subagentMirrorTurns.get(liveSession.snapshot.sessionId) ?? null
        );
    }

    #handleTurnLifecycleUpdate(
        liveSession: LiveAcpSession,
        meta: Record<string, unknown>,
        updatedAt: string,
    ): boolean {
        if (
            readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) !==
            CODEX_ACP_TURN_LIFECYCLE_EVENT_TYPE
        ) {
            return false;
        }

        const turnEventType = readMetaString(meta, CODEX_ACP_TURN_EVENT_TYPE_KEY);
        if (!turnEventType) {
            return true;
        }

        if (!isSubagentLiveSession(liveSession)) {
            return true;
        }

        const turnId = readMetaString(meta, CODEX_ACP_TURN_ID_KEY);
        if (turnEventType === CODEX_ACP_TURN_STARTED_EVENT_TYPE) {
            this.#beginLiveSessionTurn(liveSession, turnId, updatedAt);
            return true;
        }

        if (
            turnEventType === CODEX_ACP_TURN_COMPLETE_EVENT_TYPE ||
            turnEventType === CODEX_ACP_TURN_ABORTED_EVENT_TYPE ||
            turnEventType === CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE
        ) {
            this.#endLiveSessionTurn(liveSession, turnId, updatedAt);
            if (
                turnEventType === CODEX_ACP_TURN_ABORTED_EVENT_TYPE ||
                turnEventType === CODEX_ACP_SHUTDOWN_COMPLETE_EVENT_TYPE
            ) {
                this.#clearSubagentMirrorTurn(liveSession);
            }
        }

        return true;
    }

    #beginLiveSessionTurn(
        liveSession: LiveAcpSession,
        turnId: string | null,
        updatedAt: string,
    ): void {
        liveSession.preEditSnapshots.clear();
        liveSession.activeTurnId = turnId;
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            activeTurnStartedAt:
                liveSession.snapshot.activeTurnStartedAt ?? updatedAt,
            lastError: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "streaming",
            updatedAt,
        });
        this.#queueSnapshotFlush(liveSession);
        this.#schedulePendingScopeRefresh(liveSession.snapshot.sessionId);
    }

    #endLiveSessionTurn(
        liveSession: LiveAcpSession,
        turnId: string | null,
        updatedAt: string,
    ): void {
        if (
            liveSession.activeTurnId &&
            turnId &&
            turnId !== liveSession.activeTurnId
        ) {
            return;
        }

        liveSession.activeTurnId = null;
        this.#clearPendingUserTextEcho(liveSession);
        this.#resolvePendingPermission(liveSession, null);
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            activeTurnStartedAt: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "idle",
            updatedAt,
        });
        this.#queueSnapshotFlush(liveSession);
        this.#schedulePendingScopeRefresh(liveSession.snapshot.sessionId);
    }

    #attachSubagentOpenSessionAction(
        liveSession: LiveAcpSession,
        snapshot: AiSessionSnapshot,
        params: SessionNotification,
    ): AiSessionSnapshot {
        const update = params.update;
        if (
            update.sessionUpdate !== "tool_call" &&
            update.sessionUpdate !== "tool_call_update"
        ) {
            return snapshot;
        }

        const meta = getSessionNotificationMeta(params);
        if (
            readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) !==
            CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE
        ) {
            return snapshot;
        }

        const runtimeChildSessionId = readMetaString(
            meta,
            CODEX_ACP_CHILD_SESSION_ID_KEY,
        );
        if (!runtimeChildSessionId) {
            return snapshot;
        }

        let childAppSessionId =
            liveSession.runtimeConnection.appSessionIdByRuntimeSessionId.get(
                runtimeChildSessionId,
            ) ?? null;
        if (!childAppSessionId) {
            const childSession = this.#ensureSubagentLiveSessionFromMeta(
                liveSession.runtimeConnection,
                params,
                meta,
            );
            childAppSessionId = childSession?.snapshot.sessionId ?? null;
        }
        if (!childAppSessionId || childAppSessionId === snapshot.sessionId) {
            return snapshot;
        }

        const resolvedChildAppSessionId = childAppSessionId;
        let changed = false;
        const toolActivity = snapshot.toolActivity.map((activity) => {
            if (activity.id !== update.toolCallId) {
                return activity;
            }

            if (
                activity.action?.kind === "open_session" &&
                activity.action.sessionId === resolvedChildAppSessionId
            ) {
                return activity;
            }

            changed = true;
            return {
                ...activity,
                action: {
                    kind: "open_session" as const,
                    sessionId: resolvedChildAppSessionId,
                },
            };
        });

        return changed ? { ...snapshot, toolActivity } : snapshot;
    }

    #handleSubagentLifecycleBreadcrumb(
        liveSession: LiveAcpSession,
        params: SessionNotification,
        updatedAt: string,
    ): void {
        const update = params.update;
        if (
            update.sessionUpdate !== "tool_call" &&
            update.sessionUpdate !== "tool_call_update"
        ) {
            return;
        }

        const meta = getSessionNotificationMeta(params);
        const subagentEventType = readMetaString(
            meta,
            CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY,
        );
        if (
            readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) !==
            CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT_TYPE
        ) {
            return;
        }

        if (subagentEventType === CODEX_ACP_SUBAGENT_WAITING_END_EVENT_TYPE) {
            this.#handleSubagentWaitingEnd(liveSession, update, meta, updatedAt);
            return;
        }

        const runtimeChildSessionId = readMetaString(
            meta,
            CODEX_ACP_CHILD_SESSION_ID_KEY,
        );
        if (!runtimeChildSessionId) {
            return;
        }

        const childAppSessionId =
            liveSession.runtimeConnection.appSessionIdByRuntimeSessionId.get(
                runtimeChildSessionId,
            ) ?? null;
        const childSession = childAppSessionId
            ? (liveSession.runtimeConnection.sessionsByAppSessionId.get(
                  childAppSessionId,
              ) ?? null)
            : null;
        if (!childSession || childSession === liveSession) {
            return;
        }

        if (subagentEventType === CODEX_ACP_SUBAGENT_CLOSE_END_EVENT_TYPE) {
            this.#markLiveSessionIdle(childSession);
            return;
        }

        if (
            subagentEventType ===
                CODEX_ACP_SUBAGENT_INTERACTION_BEGIN_EVENT_TYPE ||
            subagentEventType === CODEX_ACP_SUBAGENT_RESUME_BEGIN_EVENT_TYPE
        ) {
            this.#mirrorSubagentTurnBegin(childSession, update, updatedAt);
            return;
        }

        if (
            subagentEventType === CODEX_ACP_SUBAGENT_INTERACTION_END_EVENT_TYPE ||
            subagentEventType === CODEX_ACP_SUBAGENT_RESUME_END_EVENT_TYPE
        ) {
            const mirrorTurn = this.#getSubagentMirrorTurn(childSession);
            if (
                !childSession.activeTurnId &&
                (!mirrorTurn || mirrorTurn.toolCallId === update.toolCallId) &&
                isTerminalSubagentBreadcrumb(meta, update)
            ) {
                this.#mirrorSubagentTurnEnd(childSession, update, updatedAt);
            }
        }
    }

    #mirrorSubagentTurnBegin(
        childSession: LiveAcpSession,
        update: SessionNotification["update"],
        updatedAt: string,
    ): void {
        if (
            update.sessionUpdate !== "tool_call" &&
            update.sessionUpdate !== "tool_call_update"
        ) {
            return;
        }

        const prompt = readSubagentTurnPrompt(update);
        const latestMessage = childSession.snapshot.messages.at(-1) ?? null;
        const promptMergePrefix =
            prompt &&
            latestMessage?.kind === "user" &&
            latestMessage.status === "streaming" &&
            isNormalizedPrefixOf(latestMessage.content, prompt)
                ? latestMessage.content
                : null;
        const promptMergeMessageId =
            promptMergePrefix && latestMessage ? latestMessage.id : null;
        this.#setSubagentMirrorTurn(childSession, update.toolCallId);
        let nextSnapshot = finalizeStreamingMessages({
            ...childSession.snapshot,
            activeTurnStartedAt:
                childSession.snapshot.activeTurnStartedAt ?? updatedAt,
            lastError: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "streaming",
            updatedAt,
        });

        if (prompt) {
            const pendingPromptText = promptMergePrefix
                ? getPromptRemainderAfterPrefix(promptMergePrefix, prompt)
                : prompt;
            this.#setPendingUserTextEcho(childSession, {
                expectedTexts: [pendingPromptText],
                messageId: null,
            });
            nextSnapshot = appendMirroredSubagentPrompt(
                nextSnapshot,
                prompt,
                `subagent:${update.toolCallId}:user`,
                updatedAt,
                promptMergeMessageId,
            );
        }

        childSession.snapshot = nextSnapshot;
        this.#queueSnapshotFlush(childSession);
        this.#schedulePendingScopeRefresh(childSession.snapshot.sessionId);
    }

    #mirrorSubagentTurnEnd(
        childSession: LiveAcpSession,
        update: SessionNotification["update"],
        updatedAt: string,
    ): void {
        if (
            update.sessionUpdate !== "tool_call" &&
            update.sessionUpdate !== "tool_call_update"
        ) {
            return;
        }

        const response = readSubagentTurnResponse(update);
        const mirrorTurn = this.#getSubagentMirrorTurn(childSession);
        let nextSnapshot = finalizeStreamingMessages({
            ...childSession.snapshot,
            activeTurnStartedAt: null,
            pendingPermission: null,
            pendingUserInput: null,
            status: "idle",
            updatedAt,
        });

        if (response && !mirrorTurn?.assistantOutputSeen) {
            nextSnapshot = appendMirroredSubagentMessage(
                nextSnapshot,
                "assistant",
                response,
                `subagent:${update.toolCallId}:assistant`,
                updatedAt,
            );
        }

        childSession.activeTurnId = null;
        this.#clearPendingUserTextEcho(childSession);
        this.#clearSubagentMirrorTurn(childSession);
        childSession.snapshot = nextSnapshot;
        this.#queueSnapshotFlush(childSession);
        this.#schedulePendingScopeRefresh(childSession.snapshot.sessionId);
    }

    #handleSubagentWaitingEnd(
        parentSession: LiveAcpSession,
        update: SessionNotification["update"],
        meta: Record<string, unknown>,
        updatedAt: string,
    ): void {
        if (
            update.sessionUpdate !== "tool_call" &&
            update.sessionUpdate !== "tool_call_update"
        ) {
            return;
        }

        const childSessions = resolveChildSessionsForWaitingEnd(
            parentSession,
            update,
            meta,
        );
        for (const childSession of childSessions) {
            const mirrorTurn = this.#getSubagentMirrorTurn(childSession);
            if (childSession.activeTurnId) {
                continue;
            }

            const response = readSubagentWaitingEndResponse(
                update,
                meta,
                childSession.snapshot.runtimeSessionId,
                childSession.snapshot.title,
            );
            let nextSnapshot = finalizeStreamingMessages({
                ...childSession.snapshot,
                activeTurnStartedAt: null,
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
                updatedAt,
            });

            if (response && !mirrorTurn?.assistantOutputSeen) {
                nextSnapshot = appendMirroredSubagentMessage(
                    nextSnapshot,
                    "assistant",
                    response,
                    `subagent:${update.toolCallId}:${childSession.snapshot.runtimeSessionId ?? childSession.snapshot.sessionId}:waiting-end`,
                    updatedAt,
                );
            }

            childSession.activeTurnId = null;
            this.#clearPendingUserTextEcho(childSession);
            this.#clearSubagentMirrorTurn(childSession);
            childSession.snapshot = nextSnapshot;
            this.#queueSnapshotFlush(childSession);
            this.#schedulePendingScopeRefresh(childSession.snapshot.sessionId);
        }
    }

    async #readTextFile(
        liveSession: LiveAcpSession,
        params: ReadTextFileRequest,
    ): Promise<{ content: string }> {
        const resolvedPath = this.#resolveSessionPathInfo(
            liveSession,
            params.path,
            {
                allowAdditionalRoots: true,
            },
        );
        const fullContent =
            this.#fileBuffers.get(resolvedPath.absolutePath) ??
            (await fs.promises.readFile(resolvedPath.absolutePath, "utf8"));
        this.#rememberPreEditSnapshot(
            liveSession,
            resolvedPath.relativePath ?? resolvedPath.displayPath,
            fullContent,
        );

        if (!params.line && !params.limit) {
            return {
                content: fullContent,
            };
        }

        const startLine = Math.max((params.line ?? 1) - 1, 0);
        const lines = fullContent.split("\n");
        const selectedLines = params.limit
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);

        return {
            content: selectedLines.join("\n"),
        };
    }

    async #writeTextFile(
        liveSession: LiveAcpSession,
        params: WriteTextFileRequest,
    ): Promise<Record<string, never>> {
        const resolvedPath = this.#resolveWritableSessionPathInfo(
            liveSession,
            params.path,
        );
        const now = new Date().toISOString();
        const previousContent =
            this.#fileBuffers.get(resolvedPath.absolutePath) ??
            (await readTextIfExists(resolvedPath.absolutePath));
        if (previousContent !== null) {
            this.#rememberPreEditSnapshot(
                liveSession,
                resolvedPath.relativePath ?? resolvedPath.displayPath,
                previousContent,
            );
        }

        await fs.promises.mkdir(path.dirname(resolvedPath.absolutePath), {
            recursive: true,
        });
        await fs.promises.writeFile(
            resolvedPath.absolutePath,
            params.content,
            "utf8",
        );
        this.#fileBuffers.set(resolvedPath.absolutePath, params.content);

        const trackedPath =
            resolvedPath.relativePath ?? resolvedPath.displayPath;
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: upsertTrackedFile(
                liveSession.snapshot.trackedFiles,
                syncTrackedFile({
                    identityKey: trackedPath,
                    currentText: params.content,
                    diffBase: previousContent ?? "",
                    hunks:
                        previousContent === null
                            ? []
                            : computeDiffHunks(
                                  previousContent,
                                  params.content,
                                  trackedPath,
                              ),
                    isText: true,
                    kind: previousContent === null ? "create" : "update",
                    newText: params.content,
                    oldText: previousContent,
                    path: trackedPath,
                    previousPath: null,
                    reviewState: "pending",
                    reversible: true,
                    sessionId: liveSession.snapshot.sessionId,
                    toolCallId: null,
                    updatedAt: now,
                    version: 1,
                }),
            ),
            updatedAt: now,
        };
        this.#queueSnapshotFlush(liveSession);

        return {};
    }

    async #createTerminal(
        liveSession: LiveAcpSession,
        params: CreateTerminalRequest,
    ): Promise<CreateTerminalResponse> {
        this.#assertTerminalSession(liveSession, params.sessionId);

        const command = params.command.trim();
        if (!command) {
            throw new Error("The ACP terminal command cannot be empty.");
        }

        const args = params.args ?? [];
        const cwd = this.#resolveTerminalCwd(liveSession, params.cwd ?? null);
        const commandLine = formatTerminalCommandLine(command, args);
        const terminalId = randomUUID();

        const permission = await this.#requestPermission(liveSession, {
            _meta: null,
            options: [
                {
                    _meta: null,
                    kind: "allow_once",
                    name: "Run once",
                    optionId: TERMINAL_PERMISSION_ALLOW_OPTION_ID,
                },
                {
                    _meta: null,
                    kind: "reject_once",
                    name: "Deny",
                    optionId: TERMINAL_PERMISSION_REJECT_OPTION_ID,
                },
            ],
            sessionId: params.sessionId,
            toolCall: {
                _meta: null,
                kind: "execute",
                rawInput: {
                    command: commandLine,
                    cwd,
                },
                status: "pending",
                title: "Run terminal command",
                toolCallId: terminalId,
            },
        });

        if (
            permission.outcome.outcome !== "selected" ||
            permission.outcome.optionId !== TERMINAL_PERMISSION_ALLOW_OPTION_ID
        ) {
            throw new Error("The terminal command was not approved.");
        }

        const child = spawn(command, args, {
            cwd,
            env: buildTerminalEnv(params.env ?? []),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const terminal: LiveAcpTerminal = {
            child,
            commandLine,
            cwd,
            exitStatus: null,
            output: "",
            outputByteLimit: normalizeTerminalOutputByteLimit(
                params.outputByteLimit ?? null,
            ),
            released: false,
            truncated: false,
            waiters: new Set(),
        };

        liveSession.terminals.set(terminalId, terminal);
        this.#upsertTerminalActivity(liveSession, terminalId, {
            commandLine,
            cwd,
            status: "in_progress",
            terminal,
        });

        child.stdout.on("data", (chunk: Buffer | string) => {
            this.#appendTerminalOutput(
                liveSession,
                terminalId,
                chunk,
                commandLine,
                cwd,
            );
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
            this.#appendTerminalOutput(
                liveSession,
                terminalId,
                chunk,
                commandLine,
                cwd,
            );
        });
        child.on("error", (error) => {
            debugBenignError("ai.worker.terminal.process", error);
            this.#appendTerminalOutput(
                liveSession,
                terminalId,
                `${error.message}\n`,
                commandLine,
                cwd,
            );
        });
        child.on("close", (code, signal) => {
            this.#finalizeTerminal(
                liveSession,
                terminalId,
                {
                    exitCode: code,
                    signal,
                },
                commandLine,
                cwd,
            );
        });

        return {
            _meta: null,
            terminalId,
        };
    }

    #terminalOutput(
        liveSession: LiveAcpSession,
        params: TerminalOutputRequest,
    ): TerminalOutputResponse {
        this.#assertTerminalSession(liveSession, params.sessionId);
        const terminal = this.#requireTerminal(liveSession, params.terminalId);

        return {
            _meta: null,
            exitStatus: terminal.exitStatus,
            output: terminal.output,
            truncated: terminal.truncated,
        };
    }

    async #waitForTerminalExit(
        liveSession: LiveAcpSession,
        params: WaitForTerminalExitRequest,
    ): Promise<WaitForTerminalExitResponse> {
        this.#assertTerminalSession(liveSession, params.sessionId);
        const terminal = this.#requireTerminal(liveSession, params.terminalId);
        const exitStatus =
            terminal.exitStatus ??
            (await new Promise<TerminalExitStatus>((resolve) => {
                terminal.waiters.add(resolve);
            }));

        return {
            _meta: null,
            exitCode: exitStatus.exitCode ?? null,
            signal: exitStatus.signal ?? null,
        };
    }

    #killTerminal(
        liveSession: LiveAcpSession,
        params: KillTerminalRequest,
    ): KillTerminalResponse {
        this.#assertTerminalSession(liveSession, params.sessionId);
        const terminal = this.#requireTerminal(liveSession, params.terminalId);
        if (!terminal.exitStatus) {
            terminal.child.kill();
        }

        return {
            _meta: null,
        };
    }

    #releaseTerminal(
        liveSession: LiveAcpSession,
        params: ReleaseTerminalRequest,
    ): ReleaseTerminalResponse {
        this.#assertTerminalSession(liveSession, params.sessionId);
        const terminal = this.#requireTerminal(liveSession, params.terminalId);
        this.#releaseTerminalState(liveSession, params.terminalId, terminal);

        return {
            _meta: null,
        };
    }

    async #withReviewSession(
        context: AiWorkerReviewSessionContext,
        mutate: (session: LiveAcpSession) => Promise<void> | void,
    ): Promise<AiWorkerReviewMutationResult> {
        const liveSession =
            this.#sessions.get(context.snapshot.sessionId) ??
            this.#createReviewSession(context);
        const isLiveSession = this.#sessions.has(context.snapshot.sessionId);

        await mutate(liveSession);
        this.#markSnapshotExternallySynchronized(liveSession);

        return {
            ownerWindowId: isLiveSession
                ? liveSession.ownerWindowId
                : context.ownerWindowId,
            snapshot: liveSession.snapshot,
        };
    }

    #createReviewSession(context: AiWorkerReviewSessionContext): LiveAcpSession {
        const snapshot = context.snapshot;

        return {
            additionalRoots: context.additionalRoots,
            activeTurnId: null,
            child: null as never,
            closing: true,
            connection: null as never,
            cwd: context.cwd,
            desiredSelections: {
                configOptions: snapshot.configOptions,
                modeId: snapshot.modeId,
                modelId: snapshot.modelId,
                preferredConfigOptions: {},
            },
            isRestoring: false,
            lastBroadcastSnapshot: snapshot,
            ownerWindowId: context.ownerWindowId,
            pendingAdditionalRoots: null,
            pendingLaunch: null,
            pendingPermission: null,
            pendingPermissions: new Map(),
            pendingPersistTimer: null,
            preEditSnapshots: new Map(),
            processedDiffPaths: new Map(),
            projectRoot: context.projectRoot,
            resolvedRuntime: {
                args: [],
                command: "",
                env: process.env,
                executable: "",
                status: {
                    authMethod: null,
                    authMethods: [],
                    authReady: false,
                    checkedAt: new Date().toISOString(),
                    command: "",
                    hasCustomBinaryPath: false,
                    hasGatewayConfig: false,
                    hasGatewayUrl: false,
                    message: null,
                    onboardingRequired: false,
                    runtimeId: snapshot.runtimeId,
                    source: "unknown",
                    state: "ready",
                },
            },
            runtimeConnection: null as never,
            runtimeId: snapshot.runtimeId,
            snapshot,
            stderrChunks: [],
            stderrHandler: null,
            terminals: new Map(),
            terminalOutputBuffers: new Map(),
        };
    }

    async #assertTrackedFileCanBeReverted(
        liveSession: LiveAcpSession,
        trackedFile: AiTrackedFile,
    ): Promise<void> {
        const resolvedPath = this.#resolveWritableSessionPathInfo(
            liveSession,
            trackedFile.path,
        );
        await this.#assertTrackedFileCurrentState(
            resolvedPath.absolutePath,
            trackedFile,
        );

        if (trackedFile.kind === "move" && trackedFile.previousPath) {
            const previousPath = this.#resolveWritableSessionPathInfo(
                liveSession,
                trackedFile.previousPath,
            );
            await this.#assertTrackedMovePreviousPathAvailable(
                previousPath.absolutePath,
            );
        }
    }

    async #createTrackedFileRollbackBackups(
        liveSession: LiveAcpSession,
        trackedFiles: readonly AiTrackedFile[],
    ): Promise<TrackedFileRollbackState> {
        const backups = new Map<string, TrackedPathRollbackBackup>();
        const missingDirectories = new Set<string>();
        for (const trackedFile of trackedFiles) {
            for (const absolutePath of this.#getTrackedFileRevertPaths(
                liveSession,
                trackedFile,
            )) {
                if (backups.has(absolutePath)) {
                    continue;
                }

                backups.set(
                    absolutePath,
                    await this.#createTrackedPathRollbackBackup(absolutePath),
                );
            }

            for (const absolutePath of this.#getTrackedFileRevertWritePaths(
                liveSession,
                trackedFile,
            )) {
                await this.#rememberMissingParentDirectories(
                    absolutePath,
                    missingDirectories,
                );
            }
        }

        return {
            missingDirectories: Array.from(missingDirectories).sort(
                (left, right) => right.length - left.length,
            ),
            pathBackups: Array.from(backups.values()),
        };
    }

    #getTrackedFileRevertPaths(
        liveSession: LiveAcpSession,
        trackedFile: AiTrackedFile,
    ): readonly string[] {
        const absolutePaths = [
            this.#resolveWritableSessionPathInfo(
                liveSession,
                trackedFile.path,
            ).absolutePath,
        ];

        if (trackedFile.kind === "move" && trackedFile.previousPath) {
            absolutePaths.push(
                this.#resolveWritableSessionPathInfo(
                    liveSession,
                    trackedFile.previousPath,
                ).absolutePath,
            );
        }

        return absolutePaths;
    }

    #getTrackedFileRevertWritePaths(
        liveSession: LiveAcpSession,
        trackedFile: AiTrackedFile,
    ): readonly string[] {
        if (trackedFile.oldText === null) {
            return [];
        }

        if (trackedFile.kind === "move" && trackedFile.previousPath) {
            return [
                this.#resolveWritableSessionPathInfo(
                    liveSession,
                    trackedFile.previousPath,
                ).absolutePath,
            ];
        }

        if (trackedFile.kind === "create") {
            return [];
        }

        return [
            this.#resolveWritableSessionPathInfo(
                liveSession,
                trackedFile.path,
            ).absolutePath,
        ];
    }

    async #rememberMissingParentDirectories(
        absolutePath: string,
        missingDirectories: Set<string>,
    ): Promise<void> {
        const discoveredDirectories: string[] = [];
        let currentDirectory = path.dirname(absolutePath);

        while (true) {
            if (missingDirectories.has(currentDirectory)) {
                break;
            }

            try {
                const stat = await fs.promises.stat(currentDirectory);
                if (!stat.isDirectory()) {
                    throw new Error(
                        `Cannot safely prepare review rollback because ${currentDirectory} is not a directory.`,
                    );
                }
                break;
            } catch (error) {
                if (!isNodeError(error) || error.code !== "ENOENT") {
                    throw error;
                }
            }

            discoveredDirectories.push(currentDirectory);
            const parentDirectory = path.dirname(currentDirectory);
            if (parentDirectory === currentDirectory) {
                break;
            }
            currentDirectory = parentDirectory;
        }

        for (const directory of discoveredDirectories) {
            missingDirectories.add(directory);
        }
    }

    async #createTrackedPathRollbackBackup(
        absolutePath: string,
    ): Promise<TrackedPathRollbackBackup> {
        const hadBuffer = this.#fileBuffers.has(absolutePath);
        const bufferContent = hadBuffer
            ? (this.#fileBuffers.get(absolutePath) ?? null)
            : null;

        try {
            const [content, stat] = await Promise.all([
                fs.promises.readFile(absolutePath),
                fs.promises.stat(absolutePath),
            ]);

            return {
                absolutePath,
                bufferContent,
                content,
                hadBuffer,
                mode: stat.mode,
            };
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return {
                    absolutePath,
                    bufferContent,
                    content: null,
                    hadBuffer,
                    mode: null,
                };
            }

            throw error;
        }
    }

    async #restoreTrackedFileRollbackState(
        rollbackState: TrackedFileRollbackState,
    ): Promise<void> {
        for (const backup of [...rollbackState.pathBackups].reverse()) {
            if (backup.content === null) {
                await fs.promises.rm(backup.absolutePath, { force: true });
            } else {
                await fs.promises.mkdir(path.dirname(backup.absolutePath), {
                    recursive: true,
                });
                await fs.promises.writeFile(backup.absolutePath, backup.content);
                if (backup.mode !== null) {
                    await fs.promises.chmod(backup.absolutePath, backup.mode);
                }
            }

            if (backup.hadBuffer) {
                this.#fileBuffers.set(
                    backup.absolutePath,
                    backup.bufferContent ?? "",
                );
            } else {
                this.#fileBuffers.delete(backup.absolutePath);
            }
        }

        for (const directory of rollbackState.missingDirectories) {
            try {
                await fs.promises.rmdir(directory);
            } catch (error) {
                if (
                    isNodeError(error) &&
                    (error.code === "ENOENT" ||
                        error.code === "ENOTEMPTY" ||
                        error.code === "EEXIST")
                ) {
                    continue;
                }

                throw error;
            }
        }
    }

    async #revertTrackedFile(
        liveSession: LiveAcpSession,
        trackedFile: AiTrackedFile,
    ): Promise<void> {
        if (trackedFile.kind === "move" && trackedFile.previousPath) {
            const nextPath = this.#resolveWritableSessionPathInfo(
                liveSession,
                trackedFile.path,
            );
            const previousPath = this.#resolveWritableSessionPathInfo(
                liveSession,
                trackedFile.previousPath,
            );

            await this.#assertTrackedFileCurrentState(
                nextPath.absolutePath,
                trackedFile,
            );

            if (trackedFile.oldText !== null) {
                await this.#assertTrackedMovePreviousPathAvailable(
                    previousPath.absolutePath,
                );
                await fs.promises.mkdir(path.dirname(previousPath.absolutePath), {
                    recursive: true,
                });
                await fs.promises.writeFile(
                    previousPath.absolutePath,
                    trackedFile.oldText,
                    {
                        encoding: "utf8",
                        flag: "wx",
                    },
                );
                this.#fileBuffers.set(
                    previousPath.absolutePath,
                    trackedFile.oldText,
                );
            }

            await fs.promises.rm(nextPath.absolutePath, { force: true });
            this.#fileBuffers.delete(nextPath.absolutePath);
            return;
        }

        const resolvedPath = this.#resolveWritableSessionPathInfo(
            liveSession,
            trackedFile.path,
        );

        await this.#assertTrackedFileCurrentState(
            resolvedPath.absolutePath,
            trackedFile,
        );

        if (trackedFile.kind === "create") {
            await fs.promises.rm(resolvedPath.absolutePath, { force: true });
            this.#fileBuffers.delete(resolvedPath.absolutePath);
            return;
        }

        if (trackedFile.oldText === null) {
            return;
        }

        await fs.promises.mkdir(path.dirname(resolvedPath.absolutePath), {
            recursive: true,
        });
        await fs.promises.writeFile(
            resolvedPath.absolutePath,
            trackedFile.oldText,
            "utf8",
        );
        this.#fileBuffers.set(resolvedPath.absolutePath, trackedFile.oldText);
    }

    async #applyTrackedFileText(
        liveSession: LiveAcpSession,
        trackedFile: AiTrackedFile,
        expectedCurrentState: AiTrackedFile = trackedFile,
    ): Promise<void> {
        if (trackedFile.newText === null) {
            return;
        }

        const resolvedPath = this.#resolveWritableSessionPathInfo(
            liveSession,
            trackedFile.path,
        );

        await this.#assertTrackedFileCurrentState(
            resolvedPath.absolutePath,
            expectedCurrentState,
        );

        await fs.promises.mkdir(path.dirname(resolvedPath.absolutePath), {
            recursive: true,
        });
        await fs.promises.writeFile(
            resolvedPath.absolutePath,
            trackedFile.newText,
            "utf8",
        );
        this.#fileBuffers.set(resolvedPath.absolutePath, trackedFile.newText);
    }

    async #assertTrackedFileCurrentState(
        absolutePath: string,
        trackedFile: AiTrackedFile,
    ): Promise<void> {
        const expectedCurrentText =
            trackedFile.newText === null
                ? null
                : getTrackedFileCurrentText(trackedFile);

        try {
            const currentText = await fs.promises.readFile(
                absolutePath,
                "utf8",
            );
            if (
                expectedCurrentText !== null &&
                currentText === expectedCurrentText
            ) {
                return;
            }
        } catch (error) {
            if (
                isNodeError(error) &&
                error.code === "ENOENT" &&
                (expectedCurrentText === null || trackedFile.kind === "create")
            ) {
                return;
            }

            if (!isNodeError(error) || error.code !== "ENOENT") {
                throw error;
            }
        }

        throw new Error(
            "Cannot safely apply this review change because the file no longer matches the reviewed content. Reopen the diff or rerun the agent before accepting or rejecting it.",
        );
    }

    async #assertTrackedMovePreviousPathAvailable(
        absolutePath: string,
    ): Promise<void> {
        if (this.#fileBuffers.has(absolutePath)) {
            throw new Error(
                "Cannot safely apply this review change because the original path for a moved file already exists. Reopen the diff or rerun the agent before accepting or rejecting it.",
            );
        }

        try {
            await fs.promises.lstat(absolutePath);
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return;
            }

            throw error;
        }

        throw new Error(
            "Cannot safely apply this review change because the original path for a moved file already exists. Reopen the diff or rerun the agent before accepting or rejecting it.",
        );
    }

    #markSnapshotExternallySynchronized(liveSession: LiveAcpSession): void {
        if (liveSession.pendingPersistTimer !== null) {
            clearTimeout(liveSession.pendingPersistTimer);
            liveSession.pendingPersistTimer = null;
        }

        liveSession.lastBroadcastSnapshot = liveSession.snapshot;
    }

    async #refreshLiveSessionScopes(
        liveSession: LiveAcpSession,
        launch: AiWorkerSessionLaunchInput,
    ): Promise<void> {
        if (sameAdditionalRoots(liveSession.additionalRoots, launch.additionalRoots)) {
            liveSession.pendingAdditionalRoots = null;
            liveSession.pendingLaunch = null;
            return;
        }

        if (isBusyAiSessionStatus(liveSession.snapshot.status)) {
            liveSession.pendingAdditionalRoots = launch.additionalRoots;
            liveSession.pendingLaunch = launch;
            return;
        }

        liveSession.pendingAdditionalRoots = null;
        liveSession.pendingLaunch = null;
        await this.#ensureRuntimeSession(launch);
    }

    #schedulePendingScopeRefresh(sessionId: string): void {
        const liveSession = this.#sessions.get(sessionId);
        if (
            !liveSession?.pendingLaunch ||
            isBusyAiSessionStatus(liveSession.snapshot.status)
        ) {
            return;
        }

        const pendingLaunch = liveSession.pendingLaunch;
        if (
            sameAdditionalRoots(
                liveSession.additionalRoots,
                pendingLaunch.additionalRoots,
            )
        ) {
            liveSession.pendingAdditionalRoots = null;
            liveSession.pendingLaunch = null;
            return;
        }

        liveSession.pendingAdditionalRoots = null;
        liveSession.pendingLaunch = null;
        void this.#ensureRuntimeSession(pendingLaunch).catch(() => {
            const currentSession = this.#sessions.get(sessionId);
            if (!currentSession) {
                return;
            }

            currentSession.pendingAdditionalRoots =
                pendingLaunch.additionalRoots;
            currentSession.pendingLaunch = pendingLaunch;
        });
    }

    #queueSnapshotFlush(liveSession: LiveAcpSession): void {
        if (shouldFlushLiveSessionImmediately(liveSession.snapshot)) {
            this.#flushSnapshotEvent(liveSession);
            return;
        }

        if (liveSession.pendingPersistTimer !== null) {
            return;
        }

        liveSession.pendingPersistTimer = setTimeout(() => {
            liveSession.pendingPersistTimer = null;
            this.#flushSnapshotEvent(liveSession);
        }, AI_SESSION_STREAMING_FLUSH_MS);
    }

    #flushSnapshotEvent(liveSession: LiveAcpSession): void {
        if (liveSession.pendingPersistTimer !== null) {
            clearTimeout(liveSession.pendingPersistTimer);
            liveSession.pendingPersistTimer = null;
        }

        this.#emitEvent({
            event: "ai.snapshot.updated",
            payload: {
                ownerWindowId: liveSession.ownerWindowId,
                update: buildAiSessionUpdate(
                    liveSession.lastBroadcastSnapshot,
                    liveSession.snapshot,
                ),
            },
            type: "event",
        });
        liveSession.lastBroadcastSnapshot = liveSession.snapshot;
    }

    async #applyStoredSessionSelections(
        liveSession: LiveAcpSession,
    ): Promise<void> {
        const desiredSelections = liveSession.desiredSelections;
        const desiredModeId = desiredSelections.modeId?.trim() ?? "";
        const desiredModelId = desiredSelections.modelId?.trim() ?? "";
        const modeConfig = getModeConfigOption(
            liveSession.snapshot.configOptions,
        );
        const modelConfig = getModelConfigOption(
            liveSession.snapshot.configOptions,
        );

        if (
            desiredModeId &&
            desiredModeId !== liveSession.snapshot.modeId &&
            modeConfig?.type === "select" &&
            hasSelectConfigValue(modeConfig, desiredModeId)
        ) {
            await this.#setSessionConfigOption({
                optionId: modeConfig.id,
                sessionId: liveSession.snapshot.sessionId,
                value: desiredModeId,
            });
        } else if (
            desiredModeId &&
            desiredModeId !== liveSession.snapshot.modeId &&
            liveSession.snapshot.modes.some((mode) => mode.id === desiredModeId)
        ) {
            await this.#setSessionMode({
                modeId: desiredModeId,
                sessionId: liveSession.snapshot.sessionId,
            });
        }

        if (
            desiredModelId &&
            desiredModelId !== liveSession.snapshot.modelId &&
            modelConfig?.type === "select" &&
            hasSelectConfigValue(modelConfig, desiredModelId)
        ) {
            await this.#setSessionConfigOption({
                optionId: modelConfig.id,
                sessionId: liveSession.snapshot.sessionId,
                value: desiredModelId,
            });
        } else if (
            desiredModelId &&
            desiredModelId !== liveSession.snapshot.modelId &&
            liveSession.snapshot.models.some(
                (model) => model.id === desiredModelId,
            )
        ) {
            await this.#setSessionModel({
                modelId: desiredModelId,
                sessionId: liveSession.snapshot.sessionId,
            });
        }

        const desiredConfigValues = new Map<string, boolean | string>();
        for (const desiredOption of desiredSelections.configOptions) {
            setDesiredConfigValue(
                desiredConfigValues,
                desiredOption.id,
                desiredOption.value,
            );
        }

        for (const [optionId, value] of Object.entries(
            desiredSelections.preferredConfigOptions,
        )) {
            if (!desiredConfigValues.has(optionId)) {
                setDesiredConfigValue(desiredConfigValues, optionId, value, {
                    overrideCompatibility: true,
                });
            }
        }

        for (const [optionId, desiredValue] of desiredConfigValues.entries()) {
            const desiredOption = desiredSelections.configOptions.find(
                (option) => option.id === optionId,
            );
            if (
                desiredOption &&
                (desiredOption.category === "mode" ||
                    desiredOption.category === "model")
            ) {
                continue;
            }

            const currentOption = liveSession.snapshot.configOptions.find(
                (option) => option.id === optionId,
            );
            if (!currentOption) {
                continue;
            }

            if (desiredOption && currentOption.type !== desiredOption.type) {
                continue;
            }

            if (
                currentOption.type === "boolean" &&
                typeof desiredValue === "boolean" &&
                currentOption.value !== desiredValue
            ) {
                await this.#setSessionConfigOption({
                    optionId,
                    sessionId: liveSession.snapshot.sessionId,
                    value: desiredValue,
                });
            }

            if (
                currentOption.type === "select" &&
                typeof desiredValue === "string" &&
                currentOption.value !== desiredValue &&
                hasSelectConfigValue(currentOption, desiredValue)
            ) {
                await this.#setSessionConfigOption({
                    optionId,
                    sessionId: liveSession.snapshot.sessionId,
                    value: desiredValue,
                });
            }
        }
    }

    #assertTerminalSession(
        liveSession: LiveAcpSession,
        requestSessionId: string,
    ): void {
        const runtimeSessionId = this.#requireRuntimeSessionId(liveSession);
        if (
            requestSessionId !== runtimeSessionId &&
            requestSessionId !== liveSession.snapshot.sessionId
        ) {
            throw new Error("The ACP terminal request targets a different session.");
        }
    }

    #resolveTerminalCwd(
        liveSession: LiveAcpSession,
        candidateCwd: string | null,
    ): string {
        const cwd = candidateCwd?.trim() || liveSession.cwd;
        return this.#resolveSessionPathInfo(liveSession, cwd, {
            allowAdditionalRoots: true,
        }).absolutePath;
    }

    #requireTerminal(
        liveSession: LiveAcpSession,
        terminalId: string,
    ): LiveAcpTerminal {
        const terminal = liveSession.terminals.get(terminalId);
        if (!terminal || terminal.released) {
            throw new Error("The ACP terminal was not found.");
        }

        return terminal;
    }

    #appendTerminalOutput(
        liveSession: LiveAcpSession,
        terminalId: string,
        chunk: Buffer | string,
        commandLine: string,
        cwd: string,
    ): void {
        const terminal = liveSession.terminals.get(terminalId);
        if (!terminal || terminal.released || liveSession.closing) {
            return;
        }

        const nextOutput = appendTerminalOutput(
            terminal.output,
            typeof chunk === "string" ? chunk : chunk.toString("utf8"),
            terminal.outputByteLimit,
        );
        terminal.output = nextOutput.output;
        terminal.truncated = terminal.truncated || nextOutput.truncated;
        this.#upsertTerminalActivity(liveSession, terminalId, {
            commandLine,
            cwd,
            status: terminal.exitStatus ? "completed" : "in_progress",
            terminal,
        });
    }

    #finalizeTerminal(
        liveSession: LiveAcpSession,
        terminalId: string,
        exitStatus: TerminalExitStatus,
        commandLine: string,
        cwd: string,
    ): void {
        const terminal = liveSession.terminals.get(terminalId);
        if (!terminal || terminal.exitStatus) {
            return;
        }

        terminal.exitStatus = {
            _meta: null,
            exitCode: normalizeTerminalExitCode(exitStatus.exitCode ?? null),
            signal: exitStatus.signal ?? null,
        };
        for (const resolve of terminal.waiters) {
            resolve(terminal.exitStatus);
        }
        terminal.waiters.clear();

        if (!terminal.released && !liveSession.closing) {
            const failed =
                terminal.exitStatus.exitCode !== 0 ||
                terminal.exitStatus.signal !== null;
            this.#upsertTerminalActivity(liveSession, terminalId, {
                commandLine,
                cwd,
                status: failed ? "failed" : "completed",
                terminal,
            });
        }
    }

    #upsertTerminalActivity(
        liveSession: LiveAcpSession,
        terminalId: string,
        input: {
            readonly commandLine: string;
            readonly cwd: string;
            readonly status: AiSessionSnapshot["toolActivity"][number]["status"];
            readonly terminal: LiveAcpTerminal;
        },
    ): void {
        const now = new Date().toISOString();
        const existing =
            liveSession.snapshot.toolActivity.find(
                (activity) => activity.id === terminalId,
            ) ?? null;

        liveSession.snapshot = {
            ...liveSession.snapshot,
            status:
                liveSession.snapshot.status === "waiting_permission" ||
                liveSession.snapshot.status === "waiting_user_input"
                    ? liveSession.snapshot.status
                    : "streaming",
            toolActivity: [
                ...liveSession.snapshot.toolActivity.filter(
                    (activity) => activity.id !== terminalId,
                ),
                {
                    createdAt: existing?.createdAt ?? now,
                    diffs: existing?.diffs ?? [],
                    exitCode: input.terminal.exitStatus?.exitCode ?? null,
                    id: terminalId,
                    kind: "execute",
                    locations: existing?.locations ?? [],
                    rawInputJson:
                        existing?.rawInputJson ??
                        stringifyJson({
                            command: input.commandLine,
                            cwd: input.cwd,
                        }),
                    rawOutputJson: existing?.rawOutputJson ?? null,
                    sessionId: liveSession.snapshot.sessionId,
                    status: input.status,
                    summary: existing?.summary ?? null,
                    terminalOutput: input.terminal.output || null,
                    title: `Run ${input.commandLine}`,
                    updatedAt: now,
                },
            ],
            updatedAt: now,
        };
        this.#queueSnapshotFlush(liveSession);
    }

    #releaseTerminalState(
        liveSession: LiveAcpSession,
        terminalId: string,
        terminal: LiveAcpTerminal,
    ): void {
        terminal.released = true;
        let killed = false;
        if (!terminal.exitStatus) {
            terminal.child.kill();
            terminal.exitStatus = {
                _meta: null,
                exitCode: null,
                signal: "SIGTERM",
            };
            killed = true;
            for (const resolve of terminal.waiters) {
                resolve(terminal.exitStatus);
            }
            terminal.waiters.clear();
        }
        if (killed && !liveSession.closing) {
            this.#upsertTerminalActivity(liveSession, terminalId, {
                commandLine: terminal.commandLine,
                cwd: terminal.cwd,
                status: "failed",
                terminal,
            });
        }
        liveSession.terminals.delete(terminalId);
    }

    #releaseAllTerminals(liveSession: LiveAcpSession): void {
        for (const [terminalId, terminal] of liveSession.terminals.entries()) {
            this.#releaseTerminalState(liveSession, terminalId, terminal);
        }
        liveSession.terminals.clear();
    }

    #resolvePendingPermission(
        liveSession: LiveAcpSession,
        response: RequestPermissionResponse | null,
    ): void {
        if (liveSession.pendingPermissions.size === 0) {
            return;
        }

        const resolvedResponse = response ?? {
            _meta: null,
            outcome: {
                outcome: "cancelled",
            },
        };

        for (const pendingPermission of liveSession.pendingPermissions.values()) {
            pendingPermission.resolve(resolvedResponse);
        }
        liveSession.pendingPermissions.clear();
        liveSession.pendingPermission = null;
    }

    #latestPendingPermission(
        liveSession: LiveAcpSession,
    ): AiPermissionRequest | null {
        let latest: AiPermissionRequest | null = null;
        for (const pendingPermission of liveSession.pendingPermissions.values()) {
            latest = pendingPermission.request;
        }
        return latest;
    }

    #registerRuntimeSessionMapping(
        liveConnection: LiveAcpConnection,
        appSessionId: string,
        runtimeSessionId: string,
    ): void {
        liveConnection.appSessionIdByRuntimeSessionId.set(
            runtimeSessionId,
            appSessionId,
        );
        this.#drainPendingSessionUpdates(liveConnection, runtimeSessionId);
        this.#drainPendingSubagentCreatesForParent(
            liveConnection,
            runtimeSessionId,
        );
    }

    #bufferPendingSessionUpdate(
        liveConnection: LiveAcpConnection,
        params: SessionNotification,
    ): void {
        const pending =
            liveConnection.pendingSessionUpdatesByRuntimeSessionId.get(
                params.sessionId,
            ) ?? [];

        if (pending.length >= MAX_PENDING_SESSION_UPDATES_PER_RUNTIME_SESSION) {
            pending.shift();
            this.#emitLog(
                "warn",
                "Dropping the oldest pending ACP update for an unmapped runtime session.",
                {
                    runtimeId: liveConnection.runtimeId,
                    runtimeSessionId: params.sessionId,
                },
            );
        }

        pending.push(params);
        liveConnection.pendingSessionUpdatesByRuntimeSessionId.set(
            params.sessionId,
            pending,
        );
    }

    #drainPendingSessionUpdates(
        liveConnection: LiveAcpConnection,
        runtimeSessionId: string,
    ): void {
        const pending =
            liveConnection.pendingSessionUpdatesByRuntimeSessionId.get(
                runtimeSessionId,
            );
        if (!pending?.length) {
            return;
        }

        liveConnection.pendingSessionUpdatesByRuntimeSessionId.delete(
            runtimeSessionId,
        );
        const liveSession = this.#resolveLiveSessionForRuntimeSessionId(
            liveConnection,
            runtimeSessionId,
        );
        if (!liveSession) {
            return;
        }

        for (const update of pending) {
            void this.#handleSessionUpdate(liveSession, update);
        }
    }

    #drainPendingSubagentCreatesForParent(
        liveConnection: LiveAcpConnection,
        runtimeParentSessionId: string,
    ): void {
        const pendingSubagentCreates: SessionNotification[] = [];

        for (const [
            pendingRuntimeSessionId,
            pendingUpdates,
        ] of liveConnection.pendingSessionUpdatesByRuntimeSessionId) {
            const remainingUpdates = pendingUpdates.filter((pendingUpdate) => {
                const meta = getSessionNotificationMeta(pendingUpdate);
                const shouldRetry =
                    readMetaString(meta, CODEX_ACP_STATUS_EVENT_TYPE_KEY) ===
                        CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT_TYPE &&
                    readMetaString(meta, CODEX_ACP_PARENT_SESSION_ID_KEY) ===
                        runtimeParentSessionId;
                if (shouldRetry) {
                    pendingSubagentCreates.push(pendingUpdate);
                }
                return !shouldRetry;
            });

            if (remainingUpdates.length > 0) {
                liveConnection.pendingSessionUpdatesByRuntimeSessionId.set(
                    pendingRuntimeSessionId,
                    remainingUpdates,
                );
            } else {
                liveConnection.pendingSessionUpdatesByRuntimeSessionId.delete(
                    pendingRuntimeSessionId,
                );
            }
        }

        for (const pendingCreate of pendingSubagentCreates) {
            void this.#handleRuntimeSessionUpdate(liveConnection, pendingCreate);
        }
    }

    #resolveLiveSessionForRuntimeSessionId(
        liveConnection: LiveAcpConnection,
        runtimeSessionId: string | undefined,
    ): LiveAcpSession | null {
        if (!runtimeSessionId) {
            return null;
        }

        const appSessionId =
            liveConnection.appSessionIdByRuntimeSessionId.get(
                runtimeSessionId,
            ) ??
            (liveConnection.sessionsByAppSessionId.has(runtimeSessionId)
                ? runtimeSessionId
                : null);
        if (!appSessionId) {
            return null;
        }

        return liveConnection.sessionsByAppSessionId.get(appSessionId) ?? null;
    }

    #requireLiveSessionForRuntimeRequest(
        liveConnection: LiveAcpConnection,
        runtimeSessionId: string | undefined,
    ): LiveAcpSession {
        const liveSession = this.#resolveLiveSessionForRuntimeSessionId(
            liveConnection,
            runtimeSessionId,
        );
        if (liveSession) {
            return liveSession;
        }

        if (
            !runtimeSessionId &&
            liveConnection.sessionsByAppSessionId.size === 1
        ) {
            const onlySession =
                liveConnection.sessionsByAppSessionId.values().next().value;
            if (onlySession) {
                return onlySession;
            }
        }

        throw new Error("The ACP request targets an unknown session.");
    }

    #requireRuntimeSessionId(liveSession: LiveAcpSession): string {
        if (!liveSession.snapshot.runtimeSessionId) {
            throw new Error("The ACP session is not initialized yet.");
        }

        return liveSession.snapshot.runtimeSessionId;
    }

    #rememberPreEditSnapshot(
        liveSession: LiveAcpSession,
        trackedPath: string,
        content: string,
    ): void {
        if (
            liveSession.preEditSnapshots.has(trackedPath) ||
            Buffer.byteLength(content, "utf8") > PRE_EDIT_SNAPSHOT_MAX_BYTES
        ) {
            return;
        }

        while (
            liveSession.preEditSnapshots.size >= PRE_EDIT_SNAPSHOT_MAX_ENTRIES
        ) {
            const oldestKey = liveSession.preEditSnapshots.keys().next().value;
            if (typeof oldestKey !== "string") {
                break;
            }
            liveSession.preEditSnapshots.delete(oldestKey);
        }

        liveSession.preEditSnapshots.set(trackedPath, content);
    }

    #resolveWritableSessionPathInfo(
        liveSession: Pick<
            LiveAcpSession,
            "additionalRoots" | "cwd" | "projectRoot" | "runtimeId" | "snapshot"
        >,
        candidatePath: string,
    ): {
        readonly absolutePath: string;
        readonly displayPath: string;
        readonly relativePath: string | null;
    } {
        return this.#resolveSessionPathInfo(liveSession, candidatePath, {
            allowAdditionalRoots: true,
        });
    }

    #resolveSessionPathInfo(
        liveSession: Pick<
            LiveAcpSession,
            "additionalRoots" | "cwd" | "projectRoot" | "runtimeId" | "snapshot"
        >,
        candidatePath: string,
        options: {
            readonly allowAdditionalRoots?: boolean;
        } = {},
    ): {
        readonly absolutePath: string;
        readonly displayPath: string;
        readonly relativePath: string | null;
    } {
        const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
        const absolutePath = path.isAbsolute(candidatePath)
            ? path.resolve(candidatePath)
            : path.resolve(scopeRoot, candidatePath);
        const insidePrimaryScope =
            absolutePath === scopeRoot ||
            absolutePath.startsWith(`${scopeRoot}${path.sep}`);
        const insideAdditionalRoot =
            options.allowAdditionalRoots === true &&
            liveSession.additionalRoots.some((rootPath) =>
                isPathInsideRoot(absolutePath, rootPath),
            );

        if (!insidePrimaryScope && !insideAdditionalRoot) {
            throw new Error(
                `${getRuntimeDisplayName(liveSession.runtimeId)} attempted to access a path outside the project.`,
            );
        }

        const relativePath =
            insidePrimaryScope &&
            absolutePath.startsWith(`${scopeRoot}${path.sep}`)
                ? toPosixPath(path.relative(scopeRoot, absolutePath))
                : null;

        return {
            absolutePath,
            displayPath: relativePath ?? absolutePath,
            relativePath,
        };
    }

    #handleProcessExit(
        liveConnection: LiveAcpConnection,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (this.#connections.get(liveConnection.connectionId) !== liveConnection) {
            return;
        }

        this.#connections.delete(liveConnection.connectionId);
        this.#detachChildStreams(liveConnection);
        const stderrText = getRecentStderrText(liveConnection.stderrChunks);
        const lastError =
            stderrText ||
            `${getRuntimeDisplayName(liveConnection.runtimeId)} ACP ended unexpectedly (${code ?? "null"}${signal ? ` / ${signal}` : ""}).`;

        for (const liveSession of liveConnection.sessionsByAppSessionId.values()) {
            const sessionId = liveSession.snapshot.sessionId;
            this.#sessions.delete(sessionId);
            this.#pendingUserTextEchoes.delete(sessionId);
            this.#subagentMirrorTurns.delete(sessionId);
            this.#releaseAllTerminals(liveSession);
            if (liveSession.closing || liveConnection.closing) {
                continue;
            }

            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                lastError,
                pendingPermission: null,
                pendingUserInput: null,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#resolvePendingPermission(liveSession, null);
            this.#emitSessionClosed(liveSession);
        }
        liveConnection.sessionsByAppSessionId.clear();
        liveConnection.appSessionIdByRuntimeSessionId.clear();
        liveConnection.pendingSessionUpdatesByRuntimeSessionId.clear();
    }

    #disposeLiveSession(
        sessionId: string,
        liveSession: LiveAcpSession,
        options: {
            readonly closeRuntimeSession?: boolean;
            readonly emitClosedEvent: boolean;
        },
    ): void {
        const liveConnection = liveSession.runtimeConnection;
        this.#sessions.delete(sessionId);
        this.#pendingUserTextEchoes.delete(sessionId);
        this.#subagentMirrorTurns.delete(sessionId);
        liveConnection.sessionsByAppSessionId.delete(sessionId);
        if (liveSession.snapshot.runtimeSessionId) {
            liveConnection.appSessionIdByRuntimeSessionId.delete(
                liveSession.snapshot.runtimeSessionId,
            );
        }
        liveSession.closing = true;
        this.#flushSnapshotEvent(liveSession);
        this.#resolvePendingPermission(liveSession, null);
        try {
            if (
                options.closeRuntimeSession !== false &&
                liveSession.snapshot.runtimeSessionId
            ) {
                void liveConnection.connection
                    .closeSession({
                        sessionId: liveSession.snapshot.runtimeSessionId,
                    })
                    .catch((error: unknown) => {
                        debugBenignError("ai.worker.closeSession", error);
                    });
            }
        } catch (error) {
            debugBenignError("ai.worker.closeSession", error);
        }
        this.#releaseAllTerminals(liveSession);
        liveSession.terminalOutputBuffers.clear();
        if (options.emitClosedEvent) {
            this.#emitSessionClosed(liveSession);
        }
        if (liveConnection.sessionsByAppSessionId.size === 0) {
            this.#disposeLiveConnection(liveConnection, {
                emitClosedEvent: false,
            });
        }
    }

    #disposeLiveConnection(
        liveConnection: LiveAcpConnection,
        options: {
            readonly emitClosedEvent: boolean;
        },
    ): void {
        if (liveConnection.closing) {
            return;
        }

        liveConnection.closing = true;
        this.#connections.delete(liveConnection.connectionId);
        for (const liveSession of liveConnection.sessionsByAppSessionId.values()) {
            const sessionId = liveSession.snapshot.sessionId;
            this.#sessions.delete(sessionId);
            this.#pendingUserTextEchoes.delete(sessionId);
            this.#subagentMirrorTurns.delete(sessionId);
            liveSession.closing = true;
            this.#flushSnapshotEvent(liveSession);
            this.#resolvePendingPermission(liveSession, null);
            this.#releaseAllTerminals(liveSession);
            liveSession.terminalOutputBuffers.clear();
            if (options.emitClosedEvent) {
                this.#emitSessionClosed(liveSession);
            }
        }
        liveConnection.sessionsByAppSessionId.clear();
        liveConnection.appSessionIdByRuntimeSessionId.clear();
        liveConnection.pendingSessionUpdatesByRuntimeSessionId.clear();
        this.#detachChildStreams(liveConnection);
        liveConnection.child.kill();
        liveConnection.child.stdin?.destroy();
        liveConnection.child.stdout?.destroy();
        liveConnection.child.stderr?.destroy();
    }

    #detachChildStreams(liveConnection: LiveAcpConnection): void {
        const handler = liveConnection.stderrHandler;
        if (handler) {
            liveConnection.child.stderr?.off("data", handler);
            liveConnection.stderrHandler = null;
        }
    }

    #emitSessionClosed(liveSession: LiveAcpSession): void {
        this.#emitEvent({
            event: "ai.session.closed",
            payload: {
                ownerWindowId: liveSession.ownerWindowId,
                sessionId: liveSession.snapshot.sessionId,
            },
            type: "event",
        });
    }

    #emitLog(
        level: "debug" | "error" | "info" | "warn",
        message: string,
        context?: Record<string, boolean | number | string | null | undefined>,
    ): void {
        if (!this.#debugLogsEnabled && level === "debug") {
            return;
        }

        if (!this.#debugLogsEnabled && level === "info") {
            return;
        }

        this.#emitEvent({
            event: "ai.log",
            payload: {
                context,
                level,
                message,
            },
            type: "event",
        });
    }
}

function getSessionNotificationMeta(
    params: SessionNotification,
): Record<string, unknown> {
    const updateMeta = isRecordValue(params.update._meta)
        ? params.update._meta
        : {};
    const notificationMeta = isRecordValue(params._meta) ? params._meta : {};

    return {
        ...notificationMeta,
        ...updateMeta,
    };
}

function readMetaString(
    meta: Record<string, unknown>,
    key: string,
): string | null {
    const value = meta[key];
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
}

function readSessionInfoTitle(
    update: SessionNotification["update"],
): string | null {
    if (update.sessionUpdate !== "session_info_update") {
        return null;
    }

    return typeof update.title === "string" && update.title.trim().length > 0
        ? update.title.trim()
        : null;
}

function applyCodexAcpSubagentModelMetadataToSnapshot(
    snapshot: AiSessionSnapshot,
    meta: Record<string, unknown>,
    updatedAt: string,
): AiSessionSnapshot {
    const modelId = normalizeCodexAcpModelId(
        readMetaString(meta, CODEX_ACP_MODEL_KEY),
        snapshot,
        readMetaString(meta, CODEX_ACP_REASONING_EFFORT_KEY),
    );
    const reasoningEffort = readMetaString(
        meta,
        CODEX_ACP_REASONING_EFFORT_KEY,
    );
    let nextSnapshot = snapshot;

    if (modelId) {
        const modelConfig = getModelConfigOption(nextSnapshot.configOptions);
        const shouldUpdateModel =
            nextSnapshot.modelId !== modelId ||
            (modelConfig?.type === "select" &&
                modelConfig.value !== modelId &&
                hasSelectConfigValue(modelConfig, modelId));
        if (shouldUpdateModel) {
            nextSnapshot = setModelOnSnapshot(nextSnapshot, modelId, updatedAt);
        }
    }

    if (reasoningEffort) {
        nextSnapshot = setReasoningEffortOnSnapshot(
            nextSnapshot,
            reasoningEffort,
            updatedAt,
        );
    }

    return nextSnapshot;
}

function normalizeCodexAcpModelId(
    rawModelId: string | null,
    snapshot: AiSessionSnapshot,
    explicitReasoningEffort: string | null,
): string | null {
    if (!rawModelId) {
        return null;
    }

    if (hasKnownModelSelection(snapshot, rawModelId)) {
        return rawModelId;
    }

    const suffix = parseCodexAcpModelEffortSuffix(rawModelId);
    if (!suffix) {
        return rawModelId;
    }

    if (
        suffix.kind !== "dash" ||
        explicitReasoningEffort === suffix.effort ||
        hasKnownModelSelection(snapshot, suffix.base)
    ) {
        return suffix.base;
    }

    return rawModelId;
}

function parseCodexAcpModelEffortSuffix(
    modelId: string,
): { readonly base: string; readonly effort: string; readonly kind: string } | null {
    for (const effort of CODEX_ACP_REASONING_EFFORT_SUFFIXES) {
        const slashSuffix = `/${effort}`;
        if (modelId.endsWith(slashSuffix)) {
            const base = modelId.slice(0, -slashSuffix.length).trim();
            return base ? { base, effort, kind: "slash" } : null;
        }

        const parentheticalSuffix = ` (${effort})`;
        if (modelId.endsWith(parentheticalSuffix)) {
            const base = modelId.slice(0, -parentheticalSuffix.length).trim();
            return base ? { base, effort, kind: "parenthetical" } : null;
        }

        const dashSuffix = `-${effort}`;
        if (modelId.endsWith(dashSuffix)) {
            const base = modelId.slice(0, -dashSuffix.length).trim();
            return base ? { base, effort, kind: "dash" } : null;
        }
    }

    return null;
}

function hasKnownModelSelection(
    snapshot: AiSessionSnapshot,
    modelId: string,
): boolean {
    if (snapshot.models.some((model) => model.id === modelId)) {
        return true;
    }

    const modelConfig = getModelConfigOption(snapshot.configOptions);
    return modelConfig ? hasSelectConfigValue(modelConfig, modelId) : false;
}

function setReasoningEffortOnSnapshot(
    snapshot: AiSessionSnapshot,
    reasoningEffort: string,
    updatedAt: string,
): AiSessionSnapshot {
    let nextSnapshot = snapshot;
    for (const optionId of CODEX_ACP_REASONING_CONFIG_OPTION_IDS) {
        const option = nextSnapshot.configOptions.find(
            (candidate) => candidate.id === optionId,
        );
        if (
            option?.type !== "select" ||
            option.value === reasoningEffort ||
            !hasSelectConfigValue(option, reasoningEffort)
        ) {
            continue;
        }

        nextSnapshot = setConfigOptionOnSnapshot(
            nextSnapshot,
            option.id,
            reasoningEffort,
            updatedAt,
        );
    }

    return nextSnapshot;
}

function isSamePromptEchoContentBlock(
    expected: ContentBlock,
    candidate: ContentBlock,
): boolean {
    switch (expected.type) {
        case "text":
            return candidate.type === "text" && expected.text === candidate.text;
        case "image":
            return (
                candidate.type === "image" &&
                expected.data === candidate.data &&
                expected.mimeType === candidate.mimeType &&
                (expected.uri ?? null) === (candidate.uri ?? null)
            );
        case "audio":
            return (
                candidate.type === "audio" &&
                expected.data === candidate.data &&
                expected.mimeType === candidate.mimeType
            );
        case "resource_link":
            return (
                candidate.type === "resource_link" &&
                expected.uri === candidate.uri &&
                expected.name === candidate.name &&
                (expected.description ?? null) ===
                    (candidate.description ?? null) &&
                (expected.mimeType ?? null) === (candidate.mimeType ?? null) &&
                (expected.size ?? null) === (candidate.size ?? null) &&
                (expected.title ?? null) === (candidate.title ?? null)
            );
        case "resource":
            return (
                candidate.type === "resource" &&
                isSameEmbeddedResource(expected.resource, candidate.resource)
            );
    }
}

function isSameEmbeddedResource(
    expected: Extract<ContentBlock, { type: "resource" }>["resource"],
    candidate: Extract<ContentBlock, { type: "resource" }>["resource"],
): boolean {
    if ("text" in expected || "text" in candidate) {
        return (
            "text" in expected &&
            "text" in candidate &&
            expected.text === candidate.text &&
            expected.uri === candidate.uri &&
            (expected.mimeType ?? null) === (candidate.mimeType ?? null)
        );
    }

    return (
        expected.blob === candidate.blob &&
        expected.uri === candidate.uri &&
        (expected.mimeType ?? null) === (candidate.mimeType ?? null)
    );
}

function isInternalUserInputResponseEcho(content: ContentBlock): boolean {
    return (
        content.type === "text" &&
        content.text.trimStart().startsWith(CODEX_ACP_USER_INPUT_RESPONSE_PREFIX)
    );
}

function normalizeEchoText(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

function getPromptRemainderAfterPrefix(prefix: string, prompt: string): string {
    if (prompt.startsWith(prefix)) {
        return prompt.slice(prefix.length);
    }

    const trimmedPrefix = prefix.trim();
    if (trimmedPrefix && prompt.startsWith(trimmedPrefix)) {
        return prompt.slice(trimmedPrefix.length).trimStart();
    }

    const normalizedPrefix = normalizeEchoText(prefix);
    const normalizedPrompt = normalizeEchoText(prompt);
    if (normalizedPrefix && normalizedPrompt.startsWith(normalizedPrefix)) {
        return normalizedPrompt.slice(normalizedPrefix.length).trimStart();
    }

    return prompt;
}

function isNormalizedPrefixOf(value: string, expected: string): boolean {
    const normalizedValue = normalizeEchoText(value);
    const normalizedExpected = normalizeEchoText(expected);
    return (
        normalizedValue.length > 0 &&
        normalizedExpected.length > 0 &&
        normalizedExpected.startsWith(normalizedValue)
    );
}

function appendMirroredSubagentPrompt(
    snapshot: AiSessionSnapshot,
    content: string,
    id: string,
    createdAt: string,
    mergeMessageId: string | null = null,
): AiSessionSnapshot {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
        return snapshot;
    }

    const messages = [...snapshot.messages];
    const latestMessage = messages[messages.length - 1] ?? null;
    if (
        latestMessage?.kind === "user" &&
        (latestMessage.status === "streaming" ||
            latestMessage.id === mergeMessageId) &&
        isNormalizedPrefixOf(latestMessage.content, trimmedContent)
    ) {
        messages[messages.length - 1] = {
            ...latestMessage,
            content: trimmedContent,
            status: "completed",
        };
        return {
            ...snapshot,
            messages,
        };
    }

    return appendMirroredSubagentMessage(
        snapshot,
        "user",
        trimmedContent,
        id,
        createdAt,
    );
}

function appendMirroredSubagentMessage(
    snapshot: AiSessionSnapshot,
    kind: AiSessionSnapshot["messages"][number]["kind"],
    content: string,
    id: string,
    createdAt: string,
): AiSessionSnapshot {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
        return snapshot;
    }

    if (snapshot.messages.some((message) => message.id === id)) {
        return snapshot;
    }

    return {
        ...snapshot,
        messages: [
            ...snapshot.messages,
            {
                attachments: [],
                content: trimmedContent,
                createdAt,
                id,
                kind,
                status: "completed",
            },
        ],
    };
}

function readSubagentTurnPrompt(
    update: SessionNotification["update"],
): string | null {
    if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
    ) {
        return null;
    }

    return readRecordString(update.rawInput, "prompt");
}

function readSubagentTurnResponse(
    update: SessionNotification["update"],
): string | null {
    if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
    ) {
        return null;
    }

    const rawOutput = isRecordValue(update.rawOutput) ? update.rawOutput : null;
    const statusMessage = rawOutput
        ? readCompletedAgentStatusMessage(rawOutput.status) ??
          readCompletedAgentStatusMessage(rawOutput.agent_status) ??
          readCompletedAgentStatusMessage(rawOutput.agentStatus)
        : null;
    if (statusMessage) {
        return statusMessage;
    }

    return readCompletedStatusFromToolContent(update.content);
}

function resolveChildSessionsForWaitingEnd(
    parentSession: LiveAcpSession,
    update: SessionNotification["update"],
    meta: Record<string, unknown>,
): readonly LiveAcpSession[] {
    return [...readSubagentWaitingEndTerminalRuntimeSessionIds(update, meta)]
        .map((runtimeSessionId) => {
            const appSessionId =
                parentSession.runtimeConnection.appSessionIdByRuntimeSessionId.get(
                    runtimeSessionId,
                );
            return appSessionId
                ? parentSession.runtimeConnection.sessionsByAppSessionId.get(
                      appSessionId,
                  )
                : null;
        })
        .filter(
            (session): session is LiveAcpSession =>
                Boolean(session) && session !== parentSession,
        );
}

function readSubagentWaitingEndTerminalRuntimeSessionIds(
    update: SessionNotification["update"],
    meta: Record<string, unknown>,
): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const status of readSubagentStatusRecords(update, meta)) {
        const runtimeSessionId = readSubagentStatusRuntimeSessionId(status);
        if (
            runtimeSessionId &&
            isCodexAcpAgentStatusTerminal(readSubagentStatusValue(status)) === true
        ) {
            ids.add(runtimeSessionId);
        }
    }

    return ids;
}

function readSubagentStatusRecords(
    update: SessionNotification["update"],
    meta: Record<string, unknown>,
): readonly Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    const metaStatuses = meta[CODEX_ACP_AGENT_STATUSES_KEY];
    if (Array.isArray(metaStatuses)) {
        records.push(...metaStatuses.filter(isRecordValue));
    }

    const runtimeChildSessionId = readMetaString(
        meta,
        CODEX_ACP_CHILD_SESSION_ID_KEY,
    );
    if (runtimeChildSessionId && meta[CODEX_ACP_AGENT_STATUS_KEY] !== undefined) {
        records.push({
            [CODEX_ACP_AGENT_STATUS_KEY]: meta[CODEX_ACP_AGENT_STATUS_KEY],
            [CODEX_ACP_CHILD_SESSION_ID_KEY]: runtimeChildSessionId,
        });
    }

    if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
    ) {
        return records;
    }

    const rawOutput = isRecordValue(update.rawOutput) ? update.rawOutput : null;
    if (!rawOutput) {
        return records;
    }

    for (const key of ["agent_statuses", "agentStatuses", "statuses"]) {
        const value = rawOutput[key];
        if (Array.isArray(value)) {
            records.push(...value.filter(isRecordValue));
            continue;
        }
        if (key === "statuses" && isRecordValue(value)) {
            for (const [runtimeSessionId, status] of Object.entries(value)) {
                if (runtimeSessionId.trim()) {
                    records.push({
                        status,
                        thread_id: runtimeSessionId,
                    });
                }
            }
        }
    }

    return records;
}

function readSubagentWaitingEndResponse(
    update: SessionNotification["update"],
    meta: Record<string, unknown>,
    runtimeSessionId: string | null,
    title: string,
): string | null {
    const matchingStatus = readSubagentStatusRecords(update, meta).find((status) => {
        const statusRuntimeSessionId = readSubagentStatusRuntimeSessionId(status);
        if (runtimeSessionId && statusRuntimeSessionId === runtimeSessionId) {
            return true;
        }
        const nickname = readSubagentStatusNickname(status);
        return Boolean(nickname && nickname === title);
    });

    if (matchingStatus) {
        return (
            readCompletedAgentStatusMessage(
                readSubagentStatusValue(matchingStatus),
            ) ?? null
        );
    }

    return null;
}

function readSubagentStatusRuntimeSessionId(
    status: Record<string, unknown>,
): string | null {
    return (
        readRecordString(status, CODEX_ACP_CHILD_SESSION_ID_KEY) ??
        readRecordString(status, CODEX_ACP_CHILD_THREAD_ID_KEY) ??
        readRecordString(status, "thread_id") ??
        readRecordString(status, "threadId") ??
        readRecordString(status, "session_id") ??
        readRecordString(status, "sessionId")
    );
}

function readSubagentStatusNickname(status: Record<string, unknown>): string | null {
    return (
        readRecordString(status, CODEX_ACP_AGENT_NICKNAME_KEY) ??
        readRecordString(status, "agent_nickname") ??
        readRecordString(status, "agentNickname")
    );
}

function readSubagentStatusValue(status: Record<string, unknown>): unknown {
    return (
        status[CODEX_ACP_AGENT_STATUS_KEY] ??
        status.status ??
        status.agent_status ??
        status.agentStatus
    );
}

function isTerminalSubagentBreadcrumb(
    meta: Record<string, unknown>,
    update: SessionNotification["update"],
): boolean {
    const metaStatus = isCodexAcpAgentStatusTerminal(
        meta[CODEX_ACP_AGENT_STATUS_KEY],
    );
    if (metaStatus !== null) {
        return metaStatus;
    }

    if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
    ) {
        return false;
    }

    const rawOutput = isRecordValue(update.rawOutput) ? update.rawOutput : null;
    if (rawOutput) {
        const rawStatus =
            isCodexAcpAgentStatusTerminal(rawOutput.status) ??
            isCodexAcpAgentStatusTerminal(rawOutput.agent_status) ??
            isCodexAcpAgentStatusTerminal(rawOutput.agentStatus);
        if (rawStatus !== null) {
            return rawStatus;
        }
    }

    return readCompletedStatusFromToolContent(update.content) !== null;
}

function isCodexAcpAgentStatusTerminal(value: unknown): boolean | null {
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
        if (!normalized) {
            return null;
        }
        if (
            normalized === "completed" ||
            normalized.startsWith("completed:") ||
            normalized === "errored" ||
            normalized === "error" ||
            normalized === "failed" ||
            normalized === "interrupted" ||
            normalized === "shutdown" ||
            normalized === "not_found" ||
            normalized === "cancelled" ||
            normalized === "canceled"
        ) {
            return true;
        }
        if (
            normalized === "running" ||
            normalized === "pending" ||
            normalized === "pending_init" ||
            normalized === "in_progress"
        ) {
            return false;
        }
        return null;
    }

    if (Array.isArray(value)) {
        let sawTerminal = false;
        for (const item of value) {
            const terminal = isCodexAcpAgentStatusTerminal(item);
            if (terminal === false) {
                return false;
            }
            if (terminal === true) {
                sawTerminal = true;
            }
        }
        return sawTerminal ? true : null;
    }

    if (!isRecordValue(value)) {
        return null;
    }

    const keys = Object.keys(value).map((key) => key.toLowerCase());
    if (
        keys.some((key) =>
            [
                "completed",
                "errored",
                "error",
                "failed",
                "interrupted",
                "shutdown",
                "not_found",
                "notfound",
                "cancelled",
                "canceled",
            ].includes(key),
        )
    ) {
        return true;
    }
    if (
        keys.some((key) =>
            ["running", "pending", "pending_init", "in_progress"].includes(key),
        )
    ) {
        return false;
    }

    const type =
        readRecordString(value, "type") ??
        readRecordString(value, "kind") ??
        readRecordString(value, "status");
    return type ? isCodexAcpAgentStatusTerminal(type) : null;
}

function isSubagentLiveSession(liveSession: LiveAcpSession): boolean {
    const parentSessionId = liveSession.snapshot.parentSessionId?.trim() ?? "";
    return (
        parentSessionId.length > 0 &&
        parentSessionId !== liveSession.snapshot.sessionId
    );
}

function readCompletedAgentStatusMessage(value: unknown): string | null {
    if (typeof value === "string") {
        return parseCompletedStatusText(value);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const message = readCompletedAgentStatusMessage(item);
            if (message) {
                return message;
            }
        }
        return null;
    }

    if (!isRecordValue(value)) {
        return null;
    }

    for (const key of ["completed", "Completed"]) {
        const completed = value[key];
        if (typeof completed === "string") {
            return completed.trim() || null;
        }
        if (isRecordValue(completed)) {
            const message =
                readRecordString(completed, "message") ??
                readRecordString(completed, "content") ??
                readRecordString(completed, "text");
            if (message) {
                return message;
            }
        }
    }

    const type = readRecordString(value, "type") ?? readRecordString(value, "kind");
    if (type?.toLowerCase() === "completed") {
        return (
            readRecordString(value, "message") ??
            readRecordString(value, "content") ??
            readRecordString(value, "text")
        );
    }

    return null;
}

function readCompletedStatusFromToolContent(content: unknown): string | null {
    const text = readToolContentText(content);
    if (!text) {
        return null;
    }

    const match = text.match(/(?:^|\n)\s*Status:\s*(completed(?::\s*[\s\S]+)?)/i);
    return match ? parseCompletedStatusText(match[1] ?? "") : null;
}

function parseCompletedStatusText(value: string): string | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^completed:\s*([\s\S]+)$/i);
    return match?.[1]?.trim() || null;
}

function readToolContentText(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        const parts = value
            .map((item) => readToolContentText(item))
            .filter((item): item is string => Boolean(item));
        return parts.length > 0 ? parts.join("\n") : null;
    }

    if (!isRecordValue(value)) {
        return null;
    }

    return (
        readRecordString(value, "text") ??
        readRecordString(value, "content") ??
        readToolContentText(value.content) ??
        readToolContentText(value.value)
    );
}

function readRecordString(
    value: unknown,
    key: string,
): string | null {
    if (!isRecordValue(value)) {
        return null;
    }

    const candidate = value[key];
    return typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : null;
}

function buildTerminalEnv(
    env: NonNullable<CreateTerminalRequest["env"]>,
): NodeJS.ProcessEnv {
    const nextEnv: NodeJS.ProcessEnv = {
        ...process.env,
    };

    for (const entry of env) {
        if (!entry.name || entry.name.includes("=") || entry.name.includes("\0")) {
            continue;
        }
        nextEnv[entry.name] = entry.value;
    }

    return nextEnv;
}

function normalizeTerminalOutputByteLimit(limit: number | null): number {
    if (limit === null || !Number.isFinite(limit)) {
        return DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT;
    }

    return Math.max(0, Math.floor(limit));
}

function normalizeTerminalExitCode(exitCode: number | null): number | null {
    if (exitCode === null || !Number.isFinite(exitCode) || exitCode < 0) {
        return null;
    }

    return Math.floor(exitCode);
}

function appendTerminalOutput(
    currentOutput: string,
    chunk: string,
    outputByteLimit: number,
): {
    readonly output: string;
    readonly truncated: boolean;
} {
    const nextOutput = currentOutput + chunk;
    if (Buffer.byteLength(nextOutput, "utf8") <= outputByteLimit) {
        return {
            output: nextOutput,
            truncated: false,
        };
    }

    if (outputByteLimit <= 0) {
        return {
            output: "",
            truncated: nextOutput.length > 0,
        };
    }

    let low = 0;
    let high = nextOutput.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (Buffer.byteLength(nextOutput.slice(mid), "utf8") > outputByteLimit) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    let output = nextOutput.slice(low);
    if (/^[\uDC00-\uDFFF]/.test(output)) {
        output = output.slice(1);
    }

    return {
        output,
        truncated: true,
    };
}

function formatTerminalCommandLine(
    command: string,
    args: readonly string[],
): string {
    return [command, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
        return value;
    }

    return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPermissionDescription(
    toolCall: RequestPermissionRequest["toolCall"],
): string | null {
    const rawInput = toolCall.rawInput;
    if (!isRecordValue(rawInput) || typeof rawInput.command !== "string") {
        return null;
    }

    const lines = [`Command: ${rawInput.command}`];
    if (typeof rawInput.cwd === "string" && rawInput.cwd.trim()) {
        lines.push(`Directory: ${rawInput.cwd}`);
    }

    return lines.join("\n");
}

function stringifyJson(value: unknown): string | null {
    try {
        return JSON.stringify(value);
    } catch (error) {
        debugBenignError("ai.worker.stringifyJson", error);
        return null;
    }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}
