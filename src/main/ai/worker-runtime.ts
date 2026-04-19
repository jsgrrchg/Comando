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
    type ReadTextFileRequest,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
    AiPermissionRequest,
    AiPromptResult,
    AiSessionSnapshot,
    AiTrackedFile,
} from "@shared/ipc";
import {
    computeDiffHunks,
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
    type LiveAcpSession,
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
    shouldFlushLiveSessionImmediately,
    summarizeUserInputAnswers,
    toPosixPath,
} from "./session-core";
import { mapToolCallUpdate, readTextIfExists } from "./review-core";

export interface AiWorkerRuntimeOptions {
    readonly debugLogsEnabled?: boolean;
    readonly emitEvent: (message: AiWorkerEventMessage) => void;
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
    readonly #fileBuffers = new Map<string, string>();
    readonly #sessions = new Map<string, LiveAcpSession>();
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
                await this.#closeSession(
                    params as AiWorkerRpcMethodMap["ai.closeSession"]["params"],
                );
                return null;
            case "ai.closeOwnedByWindow":
                await this.#closeOwnedByWindow(
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
                await this.#respondPermission(
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
        for (const [sessionId, liveSession] of this.#sessions.entries()) {
            this.#disposeLiveSession(sessionId, liveSession, {
                emitClosedEvent: false,
            });
        }
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
        const displayContent = serializeComposerPartsForDisplay(
            params.input.composerParts,
            promptText,
        );
        if (!promptText && params.input.attachments.length === 0) {
            throw new Error("Type a prompt before sending it.");
        }

        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            lastError: null,
            messages: [
                ...liveSession.snapshot.messages,
                {
                    attachments: params.input.attachments,
                    content: displayContent,
                    createdAt: now,
                    id: randomUUID(),
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
                messageId: randomUUID(),
                prompt: buildPromptContentBlocks(
                    promptText,
                    params.input.attachments,
                ),
                sessionId: this.#requireRuntimeSessionId(liveSession),
            });

            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);

            return {
                sessionId: params.input.sessionId,
                stopReason: response.stopReason,
            };
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(params.input.runtimeId)} could not complete the prompt.`;
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
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
        await liveSession.connection.cancel({
            sessionId: liveSession.snapshot.runtimeSessionId,
        });
    }

    async #closeSession(sessionId: string): Promise<void> {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession) {
            return;
        }

        this.#disposeLiveSession(sessionId, liveSession, {
            emitClosedEvent: true,
        });
    }

    async #closeOwnedByWindow(ownerWindowId: string): Promise<void> {
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
        return await this.#withReviewSession(params.context, async (session) => {
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
                await this.#applyTrackedFileText(session, nextTrackedFile);
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
        return await this.#withReviewSession(params.context, async (session) => {
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
            for (const trackedFile of session.snapshot.trackedFiles) {
                await this.#revertTrackedFile(session, trackedFile);
            }

            session.snapshot = {
                ...session.snapshot,
                trackedFiles: [],
                updatedAt: new Date().toISOString(),
            };
        });
    }

    async #respondPermission(
        params: AiWorkerRpcMethodMap["ai.respondPermission"]["params"],
    ): Promise<void> {
        const liveSession = this.#sessions.get(params.input.sessionId);
        if (!liveSession?.pendingPermission) {
            throw new Error("There is no pending permission request.");
        }

        if (
            liveSession.pendingPermission.requestId !== params.input.requestId
        ) {
            throw new Error("The permission request no longer matches.");
        }

        liveSession.snapshot = {
            ...liveSession.snapshot,
            pendingPermission: null,
            status: "streaming",
            updatedAt: new Date().toISOString(),
        };
        this.#queueSnapshotFlush(liveSession);

        this.#resolvePendingPermission(
            liveSession,
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
        const now = new Date().toISOString();

        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
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
                messageId: randomUUID(),
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
                status: "idle",
                updatedAt: new Date().toISOString(),
            });
            this.#queueSnapshotFlush(liveSession);
            this.#schedulePendingScopeRefresh(params.input.sessionId);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(liveSession.runtimeId)} ACP could not send the guided response.`;
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
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
            existing.desiredSelections = launch.desiredSelections;
            existing.projectRoot = launch.projectRoot;
            existing.cwd = launch.cwd;
            return existing;
        }
        if (existing) {
            this.#disposeLiveSession(launch.input.sessionId, existing, {
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
        const liveSession = {} as LiveAcpSession;
        const client: Client = {
            readTextFile: async (params) =>
                this.#readTextFile(liveSession, params),
            requestPermission: async (params) =>
                this.#requestPermission(liveSession, params),
            sessionUpdate: async (params) =>
                this.#handleSessionUpdate(liveSession, params),
            writeTextFile: async (params) =>
                this.#writeTextFile(liveSession, params),
        };
        const stream = ndJsonStream(
            toWebByteWritable(child.stdin),
            toWebByteReadable(child.stdout),
        );
        const connection = new ClientSideConnection(() => client, stream);
        const persistedSnapshot = launch.persistedSnapshot;

        Object.assign(liveSession, {
            additionalRoots: launch.additionalRoots,
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
            pendingPersistTimer: null,
            processedDiffPaths: new Map(),
            projectRoot: launch.projectRoot,
            resolvedRuntime: launch.resolvedRuntime,
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
            terminalOutputBuffers: new Map(),
            stderrChunks: [],
            stderrHandler: null,
        } satisfies LiveAcpSession);

        const stderrHandler = (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            liveSession.stderrChunks.push(text);
            if (liveSession.stderrChunks.length > 20) {
                liveSession.stderrChunks.shift();
            }
        };
        liveSession.stderrHandler = stderrHandler;
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
            this.#handleProcessExit(launch.input.sessionId, code, signal);
        });
        this.#sessions.set(launch.input.sessionId, liveSession);
        this.#queueSnapshotFlush(liveSession);

        try {
            await connection.initialize({
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true,
                    },
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
            const stderrText = getRecentStderrText(liveSession.stderrChunks);
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
            liveSession.pendingPermission = {
                requestId,
                resolve,
            };
        });
    }

    #handleSessionUpdate(
        liveSession: LiveAcpSession,
        params: SessionNotification,
    ): Promise<void> {
        const now = new Date().toISOString();
        const update = params.update;
        if (
            liveSession.isRestoring &&
            (update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "plan" ||
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update")
        ) {
            return Promise.resolve();
        }

        const shouldMarkStreaming =
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
            status: nextStatus,
            updatedAt: now,
        };

        switch (update.sessionUpdate) {
            case "agent_message_chunk":
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
                nextSnapshot = mapToolCallUpdate(
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
                nextSnapshot = mapToolCallUpdate(
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
            case "session_info_update":
                nextSnapshot = {
                    ...nextSnapshot,
                    title:
                        typeof update.title === "string" && update.title.trim()
                            ? update.title.trim()
                            : nextSnapshot.title,
                    updatedAt: update.updatedAt ?? now,
                };
                break;
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

        liveSession.snapshot = nextSnapshot;
        this.#queueSnapshotFlush(liveSession);
        this.#schedulePendingScopeRefresh(liveSession.snapshot.sessionId);
        return Promise.resolve();
    }

    async #readTextFile(
        liveSession: LiveAcpSession,
        params: ReadTextFileRequest,
    ): Promise<{ content: string }> {
        const absolutePath = this.#resolveReadableSessionPath(
            liveSession,
            params.path,
        );
        const fullContent =
            this.#fileBuffers.get(absolutePath) ??
            (await fs.promises.readFile(absolutePath, "utf8"));

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
            pendingPersistTimer: null,
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
            runtimeId: snapshot.runtimeId,
            snapshot,
            stderrChunks: [],
            stderrHandler: null,
            terminalOutputBuffers: new Map(),
        };
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

            if (trackedFile.oldText !== null) {
                await fs.promises.mkdir(path.dirname(previousPath.absolutePath), {
                    recursive: true,
                });
                await fs.promises.writeFile(
                    previousPath.absolutePath,
                    trackedFile.oldText,
                    "utf8",
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
    ): Promise<void> {
        if (trackedFile.newText === null) {
            return;
        }

        const resolvedPath = this.#resolveWritableSessionPathInfo(
            liveSession,
            trackedFile.path,
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
            desiredConfigValues.set(desiredOption.id, desiredOption.value);
        }

        for (const [optionId, value] of Object.entries(
            desiredSelections.preferredConfigOptions,
        )) {
            if (!desiredConfigValues.has(optionId)) {
                desiredConfigValues.set(optionId, value);
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

    #resolvePendingPermission(
        liveSession: LiveAcpSession,
        response: RequestPermissionResponse | null,
    ): void {
        if (!liveSession.pendingPermission) {
            return;
        }

        liveSession.pendingPermission.resolve(
            response ?? {
                _meta: null,
                outcome: {
                    outcome: "cancelled",
                },
            },
        );
        liveSession.pendingPermission = null;
    }

    #requireRuntimeSessionId(liveSession: LiveAcpSession): string {
        if (!liveSession.snapshot.runtimeSessionId) {
            throw new Error("The ACP session is not initialized yet.");
        }

        return liveSession.snapshot.runtimeSessionId;
    }

    #resolveReadableSessionPath(
        liveSession: LiveAcpSession,
        candidatePath: string,
    ): string {
        return this.#resolveSessionPathInfo(liveSession, candidatePath, {
            allowAdditionalRoots: true,
        }).absolutePath;
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
        sessionId: string,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession) {
            return;
        }

        this.#sessions.delete(sessionId);
        this.#detachChildStreams(liveSession);
        if (liveSession.closing) {
            return;
        }

        const stderrText = liveSession.stderrChunks
            ? getRecentStderrText(liveSession.stderrChunks)
            : "";
        const lastError =
            stderrText ||
            `${getRuntimeDisplayName(liveSession.runtimeId)} ACP ended unexpectedly (${code ?? "null"}${signal ? ` / ${signal}` : ""}).`;
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

    #disposeLiveSession(
        sessionId: string,
        liveSession: LiveAcpSession,
        options: {
            readonly emitClosedEvent: boolean;
        },
    ): void {
        this.#sessions.delete(sessionId);
        liveSession.closing = true;
        this.#flushSnapshotEvent(liveSession);
        this.#resolvePendingPermission(liveSession, null);
        this.#detachChildStreams(liveSession);
        try {
            if (liveSession.snapshot.runtimeSessionId) {
                void liveSession.connection
                    .unstable_closeSession({
                        sessionId: liveSession.snapshot.runtimeSessionId,
                    })
                    .catch((error) => {
                        debugBenignError(
                            "ai.worker.unstableCloseSession",
                            error,
                        );
                    });
            }
        } catch (error) {
            debugBenignError("ai.worker.unstableCloseSession", error);
        }
        liveSession.child.kill();
        liveSession.child.stdin?.destroy();
        liveSession.child.stdout?.destroy();
        liveSession.child.stderr?.destroy();
        liveSession.terminalOutputBuffers.clear();
        if (options.emitClosedEvent) {
            this.#emitSessionClosed(liveSession);
        }
    }

    #detachChildStreams(liveSession: LiveAcpSession): void {
        const handler = liveSession.stderrHandler;
        if (handler) {
            liveSession.child.stderr?.off("data", handler);
            liveSession.stderrHandler = null;
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
