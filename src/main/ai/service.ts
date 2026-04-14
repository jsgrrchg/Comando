import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
    ClientSideConnection,
    type ContentBlock,
    PROTOCOL_VERSION,
    ndJsonStream,
    type Client,
    type Diff,
    type ReadTextFileRequest,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type ToolCall,
    type ToolCallContent,
    type ToolCallUpdate,
    type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
    AiDiffHunk,
    AiFileDiff,
    AiPermissionRequest,
    AiPermissionResponseInput,
    AiPromptResult,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputRequest,
    AiUserInputResponseInput,
    CodexRuntimeSettings,
    SendAiPromptInput,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { SettingsService } from "@main/settings/service";

import { createEmptyAiSessionSnapshot, AiPersistence } from "./persistence";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";

const NEVERWRITE_DIFF_HUNKS_KEY = "neverwriteHunks";
const NEVERWRITE_DIFF_PREVIOUS_PATH_KEY = "neverwritePreviousPath";
const NEVERWRITE_STATUS_EVENT_TYPE_KEY = "neverwriteEventType";
const NEVERWRITE_USER_INPUT_EVENT_TYPE = "user_input_request";
const NEVERWRITE_USER_INPUT_RESPONSE_PREFIX =
    "__neverwrite_user_input_response__:";

interface AiServiceOptions {
    readonly projectService: ProjectService;
    readonly settingsService: SettingsService;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    readonly persistence: AiPersistence;
}

interface LiveCodexSession {
    child: ChildProcessWithoutNullStreams;
    closing: boolean;
    connection: ClientSideConnection;
    cwd: string;
    isRestoring: boolean;
    pendingPermission: {
        readonly requestId: string;
        readonly resolve: (response: RequestPermissionResponse) => void;
    } | null;
    projectRoot: string | null;
    snapshot: AiSessionSnapshot;
    stderrChunks: string[];
}

export class AiService {
    readonly #onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly #onSessionSnapshot: (snapshot: AiSessionSnapshot) => void;
    readonly #persistence: AiPersistence;
    readonly #projectService: ProjectService;
    readonly #settingsService: SettingsService;
    readonly #sessions = new Map<string, LiveCodexSession>();

    constructor(options: AiServiceOptions) {
        this.#onRuntimeStatus = options.onRuntimeStatus;
        this.#onSessionSnapshot = options.onSessionSnapshot;
        this.#persistence = options.persistence;
        this.#projectService = options.projectService;
        this.#settingsService = options.settingsService;
    }

    close(): void {
        for (const liveSession of this.#sessions.values()) {
            liveSession.closing = true;
            this.#resolvePendingPermission(liveSession, null);
            liveSession.child.kill();
        }

        this.#sessions.clear();
    }

    getRuntimeStatus(runtimeId: AiRuntimeId): AiRuntimeStatus {
        if (runtimeId !== "codex") {
            throw new Error("Runtime no soportado.");
        }

        const status = resolveCodexRuntime(
            this.#settingsService.loadCodexRuntimeSettings(),
        ).status;
        this.#onRuntimeStatus(status);
        return status;
    }

    saveCodexRuntimeSettings(settings: CodexRuntimeSettings): AiRuntimeStatus {
        this.#settingsService.saveCodexRuntimeSettings(settings);
        const status = resolveCodexRuntime(settings).status;
        this.#onRuntimeStatus(status);
        return status;
    }

    getSessionSnapshot(sessionId: string): AiSessionSnapshot | null {
        const liveSession = this.#sessions.get(sessionId);
        if (liveSession) {
            return liveSession.snapshot;
        }

        return this.#persistence.loadSessionSnapshot(sessionId);
    }

    async sendPrompt(input: SendAiPromptInput): Promise<AiPromptResult> {
        if (input.runtimeId !== "codex") {
            throw new Error("Runtime no soportado.");
        }

        const liveSession = await this.#ensureCodexSession(input);
        if (
            liveSession.snapshot.status === "starting" ||
            liveSession.snapshot.status === "streaming" ||
            liveSession.snapshot.status === "waiting_permission" ||
            liveSession.snapshot.status === "waiting_user_input"
        ) {
            throw new Error("La sesión todavía está ocupada.");
        }

        const now = new Date().toISOString();
        const promptText = input.prompt.trim();
        if (!promptText) {
            throw new Error("Escribe un prompt antes de enviarlo.");
        }

        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            lastError: null,
            messages: [
                ...liveSession.snapshot.messages,
                {
                    content: promptText,
                    createdAt: now,
                    id: randomUUID(),
                    kind: "user",
                    status: "completed",
                },
            ],
            pendingPermission: null,
            pendingUserInput: null,
            projectId: input.projectId,
            status: "starting",
            title: input.title,
            updatedAt: now,
        });
        this.#persistAndBroadcast(liveSession);

        try {
            const response = await liveSession.connection.prompt({
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
                pendingPermission: null,
                pendingUserInput: null,
                status: "idle",
                updatedAt: new Date().toISOString(),
            });
            this.#persistAndBroadcast(liveSession);

            return {
                sessionId: input.sessionId,
                stopReason: response.stopReason,
            };
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Codex ACP no pudo completar el prompt.";
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                lastError: message,
                pendingPermission: null,
                pendingUserInput: null,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#persistAndBroadcast(liveSession);
            throw error;
        }
    }

    async cancelSession(sessionId: string): Promise<void> {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession || !liveSession.snapshot.runtimeSessionId) {
            return;
        }

        this.#resolvePendingPermission(liveSession, null);
        await liveSession.connection.cancel({
            sessionId: liveSession.snapshot.runtimeSessionId,
        });
    }

    async closeSession(sessionId: string): Promise<void> {
        const liveSession = this.#sessions.get(sessionId);
        if (!liveSession) {
            return;
        }

        liveSession.closing = true;
        this.#resolvePendingPermission(liveSession, null);

        try {
            if (liveSession.snapshot.runtimeSessionId) {
                await liveSession.connection.unstable_closeSession({
                    sessionId: liveSession.snapshot.runtimeSessionId,
                });
            }
        } catch {
            // El proceso igual se cierra abajo.
        }

        liveSession.child.kill();
        this.#sessions.delete(sessionId);
    }

    respondPermission(input: AiPermissionResponseInput): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession?.pendingPermission) {
            throw new Error("No hay una solicitud de permiso pendiente.");
        }

        if (liveSession.pendingPermission.requestId !== input.requestId) {
            throw new Error("La solicitud de permiso ya no coincide.");
        }

        liveSession.snapshot = {
            ...liveSession.snapshot,
            pendingPermission: null,
            status: "streaming",
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);

        this.#resolvePendingPermission(
            liveSession,
            input.optionId
                ? {
                      _meta: null,
                      outcome: {
                          optionId: input.optionId,
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

        return Promise.resolve();
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            throw new Error("No se encontró la sesión AI.");
        }

        const pendingUserInput = liveSession.snapshot.pendingUserInput;
        if (!pendingUserInput) {
            throw new Error("No hay una solicitud de input pendiente.");
        }

        if (pendingUserInput.requestId !== input.requestId) {
            throw new Error("La solicitud de input ya no coincide.");
        }

        const answers = input.answers
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
            throw new Error("La solicitud de input no tiene un turnId válido.");
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
        this.#persistAndBroadcast(liveSession);

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
            this.#persistAndBroadcast(liveSession);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Codex ACP no pudo enviar la respuesta guiada.";
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                lastError: message,
                pendingUserInput,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#persistAndBroadcast(liveSession);
            throw error;
        }
    }

    async keepTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const liveSession = await this.#loadSessionForReview(input.sessionId);
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: liveSession.snapshot.trackedFiles.filter(
                (trackedFile) => trackedFile.path !== input.path,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async rejectTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const liveSession = await this.#loadSessionForReview(input.sessionId);
        const trackedFile = liveSession.snapshot.trackedFiles.find(
            (candidate) => candidate.path === input.path,
        );

        if (!trackedFile) {
            throw new Error("No se encontró el archivo a revisar.");
        }

        await this.#revertTrackedFile(liveSession, trackedFile);
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: liveSession.snapshot.trackedFiles.filter(
                (candidate) => candidate.path !== input.path,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async keepTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const liveSession = await this.#loadSessionForReview(input.sessionId);
        const trackedFile = liveSession.snapshot.trackedFiles.find(
            (candidate) => candidate.path === input.path,
        );

        if (!trackedFile) {
            throw new Error("No se encontró el archivo a revisar.");
        }

        const nextTrackedFile = resolveTrackedFileHunks(
            trackedFile,
            input.hunkIds,
            "keep",
        );
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: replaceTrackedFile(
                liveSession.snapshot.trackedFiles,
                trackedFile.path,
                nextTrackedFile,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async rejectTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const liveSession = await this.#loadSessionForReview(input.sessionId);
        const trackedFile = liveSession.snapshot.trackedFiles.find(
            (candidate) => candidate.path === input.path,
        );

        if (!trackedFile) {
            throw new Error("No se encontró el archivo a revisar.");
        }

        const nextTrackedFile = resolveTrackedFileHunks(
            trackedFile,
            input.hunkIds,
            "reject",
        );

        if (!nextTrackedFile) {
            await this.#revertTrackedFile(liveSession, trackedFile);
        } else if (nextTrackedFile.newText !== null) {
            await this.#applyTrackedFileText(liveSession, nextTrackedFile);
        }

        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: replaceTrackedFile(
                liveSession.snapshot.trackedFiles,
                trackedFile.path,
                nextTrackedFile,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        const liveSession = await this.#loadSessionForReview(sessionId);
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: [],
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        const liveSession = await this.#loadSessionForReview(sessionId);

        for (const trackedFile of liveSession.snapshot.trackedFiles) {
            await this.#revertTrackedFile(liveSession, trackedFile);
        }

        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: [],
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async #ensureCodexSession(
        input: SendAiPromptInput,
    ): Promise<LiveCodexSession> {
        const existing = this.#sessions.get(input.sessionId);
        if (existing?.snapshot.runtimeSessionId) {
            return existing;
        }
        if (existing) {
            this.#disposeLiveSession(input.sessionId, existing);
        }

        const settings = this.#settingsService.loadCodexRuntimeSettings();
        const resolvedRuntime = resolveCodexRuntime(settings);
        this.#onRuntimeStatus(resolvedRuntime.status);

        if (resolvedRuntime.status.state !== "ready") {
            throw new Error(
                resolvedRuntime.status.message ??
                    "Codex ACP no está disponible en esta máquina.",
            );
        }

        const persistedSnapshot =
            this.#persistence.loadSessionSnapshot(input.sessionId) ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: "codex",
                sessionId: input.sessionId,
                title: input.title,
            });
        const projectRoot = input.projectId
            ? this.#projectService.getProjectRootPath(input.projectId)
            : null;
        const cwd = projectRoot ?? process.cwd();
        const child = spawn(
            resolvedRuntime.executable,
            [...resolvedRuntime.args],
            {
                cwd,
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        const liveSession = {} as LiveCodexSession;

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
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout),
        );
        const connection = new ClientSideConnection(() => client, stream);

        Object.assign(liveSession, {
            child,
            closing: false,
            connection,
            cwd,
            isRestoring: false,
            pendingPermission: null,
            projectRoot,
            snapshot: {
                ...persistedSnapshot,
                projectId: input.projectId,
                runtimeId: "codex",
                status: "starting",
                title: input.title,
                updatedAt: new Date().toISOString(),
            },
            stderrChunks: [],
        } satisfies LiveCodexSession);

        child.stderr.on("data", (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            liveSession.stderrChunks.push(text);
            if (liveSession.stderrChunks.length > 20) {
                liveSession.stderrChunks.shift();
            }
        });
        child.on("exit", (code, signal) => {
            this.#handleProcessExit(input.sessionId, code, signal);
        });
        this.#sessions.set(input.sessionId, liveSession);
        this.#persistAndBroadcast(liveSession);

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

            const runtimeSessionId =
                await this.#openRuntimeSession(liveSession);
            liveSession.snapshot = {
                ...liveSession.snapshot,
                runtimeSessionId,
                status: "idle",
                updatedAt: new Date().toISOString(),
            };
            this.#persistAndBroadcast(liveSession);
            return liveSession;
        } catch (error) {
            const stderrText = liveSession.stderrChunks
                .join("")
                .trim()
                .split("\n")
                .slice(-4)
                .join("\n");
            const message =
                stderrText ||
                (error instanceof Error
                    ? error.message
                    : "No se pudo iniciar Codex ACP.");
            liveSession.snapshot = {
                ...liveSession.snapshot,
                lastError: message,
                status: "error",
                updatedAt: new Date().toISOString(),
            };
            this.#persistAndBroadcast(liveSession);
            this.#disposeLiveSession(input.sessionId, liveSession);
            throw error;
        }
    }

    async #openRuntimeSession(liveSession: LiveCodexSession): Promise<string> {
        if (liveSession.snapshot.runtimeSessionId) {
            try {
                liveSession.isRestoring = true;
                await liveSession.connection.loadSession({
                    cwd: liveSession.cwd,
                    mcpServers: [],
                    sessionId: liveSession.snapshot.runtimeSessionId,
                });
                return liveSession.snapshot.runtimeSessionId;
            } catch {
                // Si no se puede reanudar, abrimos una nueva.
            } finally {
                liveSession.isRestoring = false;
            }
        }

        const response = await liveSession.connection.newSession({
            cwd: liveSession.cwd,
            mcpServers: [],
        });

        return response.sessionId;
    }

    async #requestPermission(
        liveSession: LiveCodexSession,
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
        this.#persistAndBroadcast(liveSession);

        return await new Promise<RequestPermissionResponse>((resolve) => {
            liveSession.pendingPermission = {
                requestId,
                resolve,
            };
        });
    }

    #handleSessionUpdate(
        liveSession: LiveCodexSession,
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
        const nextStatus: AiSessionSnapshot["status"] =
            liveSession.snapshot.status === "waiting_permission"
                ? "waiting_permission"
                : liveSession.snapshot.status === "waiting_user_input"
                  ? "waiting_user_input"
                  : "streaming";
        let nextSnapshot: AiSessionSnapshot = {
            ...liveSession.snapshot,
            status: nextStatus,
            updatedAt: now,
        };

        switch (update.sessionUpdate) {
            case "agent_message_chunk":
                nextSnapshot = appendChunkToSnapshot(
                    nextSnapshot,
                    "assistant",
                    formatContentBlock(update.content),
                    update.messageId ?? null,
                );
                break;
            case "agent_thought_chunk":
                nextSnapshot = appendChunkToSnapshot(
                    nextSnapshot,
                    "thinking",
                    formatContentBlock(update.content),
                    update.messageId ?? null,
                );
                break;
            case "tool_call":
                nextSnapshot = mapToolCallUpdate(nextSnapshot, update, now);
                break;
            case "tool_call_update":
                nextSnapshot = mapToolCallUpdate(nextSnapshot, update, now);
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
            default:
                break;
        }

        liveSession.snapshot = nextSnapshot;
        this.#persistAndBroadcast(liveSession);
        return Promise.resolve();
    }

    async #readTextFile(
        liveSession: LiveCodexSession,
        params: ReadTextFileRequest,
    ): Promise<{ content: string }> {
        const absolutePath = this.#resolveAbsoluteSessionPath(
            liveSession,
            params.path,
        );
        const content = await fs.promises.readFile(absolutePath, "utf8");

        if (!params.line && !params.limit) {
            return {
                content,
            };
        }

        const startLine = Math.max((params.line ?? 1) - 1, 0);
        const lines = content.split("\n");
        const selectedLines = params.limit
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);

        return {
            content: selectedLines.join("\n"),
        };
    }

    async #writeTextFile(
        liveSession: LiveCodexSession,
        params: WriteTextFileRequest,
    ): Promise<Record<string, never>> {
        const resolvedPath = this.#resolveSessionPathInfo(
            liveSession,
            params.path,
        );
        const now = new Date().toISOString();
        const previousContent = await readTextIfExists(
            resolvedPath.absolutePath,
        );

        if (resolvedPath.relativePath && liveSession.snapshot.projectId) {
            await this.#projectService.saveProjectFile({
                content: params.content,
                projectId: liveSession.snapshot.projectId,
                relativePath: resolvedPath.relativePath,
            });
        } else {
            await fs.promises.writeFile(
                resolvedPath.absolutePath,
                params.content,
                "utf8",
            );
        }

        const trackedPath =
            resolvedPath.relativePath ?? resolvedPath.displayPath;
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: upsertTrackedFile(liveSession.snapshot.trackedFiles, {
                identityKey: trackedPath,
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
                reversible:
                    previousContent === null || previousContent !== null,
                sessionId: liveSession.snapshot.sessionId,
                toolCallId: null,
                updatedAt: now,
            }),
            updatedAt: now,
        };
        this.#persistAndBroadcast(liveSession);

        return {};
    }

    #loadSessionForReview(sessionId: string): Promise<LiveCodexSession> {
        const liveSession = this.#sessions.get(sessionId);
        if (liveSession) {
            return Promise.resolve(liveSession);
        }

        const snapshot = this.#persistence.loadSessionSnapshot(sessionId);
        if (!snapshot) {
            throw new Error("No se encontró la sesión AI.");
        }

        return Promise.resolve({
            child: null as never,
            closing: true,
            connection: null as never,
            cwd:
                snapshot.projectId !== null
                    ? this.#projectService.getProjectRootPath(
                          snapshot.projectId,
                      )
                    : process.cwd(),
            isRestoring: false,
            pendingPermission: null,
            projectRoot:
                snapshot.projectId !== null
                    ? this.#projectService.getProjectRootPath(
                          snapshot.projectId,
                      )
                    : null,
            snapshot,
            stderrChunks: [],
        });
    }

    async #revertTrackedFile(
        liveSession: LiveCodexSession,
        trackedFile: AiTrackedFile,
    ): Promise<void> {
        if (trackedFile.kind === "move" && trackedFile.previousPath) {
            const nextPath = this.#resolveSessionPathInfo(
                liveSession,
                trackedFile.path,
            );
            const previousPath = this.#resolveSessionPathInfo(
                liveSession,
                trackedFile.previousPath,
            );

            if (trackedFile.oldText !== null) {
                if (previousPath.relativePath && liveSession.snapshot.projectId) {
                    await this.#projectService.saveProjectFile({
                        content: trackedFile.oldText,
                        projectId: liveSession.snapshot.projectId,
                        relativePath: previousPath.relativePath,
                    });
                } else {
                    await fs.promises.mkdir(path.dirname(previousPath.absolutePath), {
                        recursive: true,
                    });
                    await fs.promises.writeFile(
                        previousPath.absolutePath,
                        trackedFile.oldText,
                        "utf8",
                    );
                }
            }

            if (nextPath.relativePath && liveSession.snapshot.projectId) {
                if (fs.existsSync(nextPath.absolutePath)) {
                    await this.#projectService.deleteProjectEntry({
                        projectId: liveSession.snapshot.projectId,
                        relativePath: nextPath.relativePath,
                    });
                }
            } else {
                await fs.promises.rm(nextPath.absolutePath, { force: true });
            }

            return;
        }

        const resolvedPath = this.#resolveSessionPathInfo(
            liveSession,
            trackedFile.path,
        );

        if (trackedFile.kind === "create") {
            if (resolvedPath.relativePath && liveSession.snapshot.projectId) {
                if (fs.existsSync(resolvedPath.absolutePath)) {
                    await this.#projectService.deleteProjectEntry({
                        projectId: liveSession.snapshot.projectId,
                        relativePath: resolvedPath.relativePath,
                    });
                }
                return;
            }

            await fs.promises.rm(resolvedPath.absolutePath, { force: true });
            return;
        }

        if (trackedFile.oldText === null) {
            return;
        }

        if (resolvedPath.relativePath && liveSession.snapshot.projectId) {
            await this.#projectService.saveProjectFile({
                content: trackedFile.oldText,
                projectId: liveSession.snapshot.projectId,
                relativePath: resolvedPath.relativePath,
            });
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
    }

    async #applyTrackedFileText(
        liveSession: LiveCodexSession,
        trackedFile: AiTrackedFile,
    ): Promise<void> {
        if (trackedFile.newText === null) {
            return;
        }

        const resolvedPath = this.#resolveSessionPathInfo(
            liveSession,
            trackedFile.path,
        );

        if (resolvedPath.relativePath && liveSession.snapshot.projectId) {
            await this.#projectService.saveProjectFile({
                content: trackedFile.newText,
                projectId: liveSession.snapshot.projectId,
                relativePath: resolvedPath.relativePath,
            });
            return;
        }

        await fs.promises.mkdir(path.dirname(resolvedPath.absolutePath), {
            recursive: true,
        });
        await fs.promises.writeFile(
            resolvedPath.absolutePath,
            trackedFile.newText,
            "utf8",
        );
    }

    #persistAndBroadcast(liveSession: LiveCodexSession): void {
        this.#persistence.saveSessionSnapshot(liveSession.snapshot);
        this.#onSessionSnapshot(liveSession.snapshot);
    }

    #resolvePendingPermission(
        liveSession: LiveCodexSession,
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

    #requireRuntimeSessionId(liveSession: LiveCodexSession): string {
        if (!liveSession.snapshot.runtimeSessionId) {
            throw new Error("La sesión ACP todavía no está inicializada.");
        }

        return liveSession.snapshot.runtimeSessionId;
    }

    #resolveAbsoluteSessionPath(
        liveSession: LiveCodexSession,
        candidatePath: string,
    ): string {
        return this.#resolveSessionPathInfo(liveSession, candidatePath)
            .absolutePath;
    }

    #resolveSessionPathInfo(
        liveSession: Pick<LiveCodexSession, "cwd" | "projectRoot" | "snapshot">,
        candidatePath: string,
    ): {
        readonly absolutePath: string;
        readonly displayPath: string;
        readonly relativePath: string | null;
    } {
        const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
        const absolutePath = path.isAbsolute(candidatePath)
            ? path.resolve(candidatePath)
            : path.resolve(scopeRoot, candidatePath);

        if (
            absolutePath !== scopeRoot &&
            !absolutePath.startsWith(`${scopeRoot}${path.sep}`)
        ) {
            throw new Error(
                "Codex intentó acceder a un path fuera del proyecto.",
            );
        }

        const relativePath = absolutePath.startsWith(`${scopeRoot}${path.sep}`)
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
        if (liveSession.closing) {
            return;
        }

        const stderrText = liveSession.stderrChunks
            .join("")
            .trim()
            .split("\n")
            .slice(-4)
            .join("\n");
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            lastError:
                stderrText ||
                `Codex ACP terminó inesperadamente (${code ?? "null"}${signal ? ` / ${signal}` : ""}).`,
            pendingPermission: null,
            pendingUserInput: null,
            status: "error",
            updatedAt: new Date().toISOString(),
        });
        this.#persistAndBroadcast(liveSession);
        this.#resolvePendingPermission(liveSession, null);
    }

    #disposeLiveSession(
        sessionId: string,
        liveSession: LiveCodexSession,
    ): void {
        this.#sessions.delete(sessionId);
        liveSession.closing = true;
        this.#resolvePendingPermission(liveSession, null);
        liveSession.child.kill();
    }
}

function appendChunkToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    content: string,
    messageId: string | null,
): AiSessionSnapshot {
    const messages = [...snapshot.messages];
    const lastMessage = messages.at(-1);

    if (
        lastMessage &&
        lastMessage.kind === kind &&
        lastMessage.status === "streaming" &&
        (!messageId || lastMessage.id === messageId)
    ) {
        messages[messages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage.content}${content}`,
        };

        return {
            ...snapshot,
            messages,
        };
    }

    return {
        ...snapshot,
        messages: [
            ...finalizeStreamingMessages(snapshot).messages,
            {
                content,
                createdAt: new Date().toISOString(),
                id: messageId ?? randomUUID(),
                kind,
                status: "streaming",
            },
        ],
    };
}

function finalizeStreamingMessages(
    snapshot: AiSessionSnapshot,
): AiSessionSnapshot {
    return {
        ...snapshot,
        messages: snapshot.messages.map((message) =>
            message.status === "streaming"
                ? {
                      ...message,
                      status: "completed",
                  }
                : message,
        ),
    };
}

function mapToolCallUpdate(
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updatedAt: string,
): AiSessionSnapshot {
    const existing =
        snapshot.toolActivity.find(
            (candidate) => candidate.id === update.toolCallId,
        ) ?? null;
    const toolKind = update.kind ?? existing?.kind ?? "unknown";
    const content = update.content ?? null;
    const pendingUserInput = parseUserInputRequest(snapshot, update, updatedAt);
    const nextActivity = {
        diffs: content
            ? collectDiffs(content, toolKind)
            : (existing?.diffs ?? []),
        id: update.toolCallId,
        kind: toolKind,
        locations:
            update.locations?.map((location) => location.path) ??
            existing?.locations ??
            [],
        rawInputJson:
            update.rawInput !== undefined
                ? stringifyJson(update.rawInput)
                : (existing?.rawInputJson ?? null),
        rawOutputJson:
            update.rawOutput !== undefined
                ? stringifyJson(update.rawOutput)
                : (existing?.rawOutputJson ?? null),
        sessionId: snapshot.sessionId,
        status: update.status ?? existing?.status ?? "pending",
        summary:
            buildToolSummary(
                update.title ?? existing?.title ?? "Tool call",
                content,
            ) ??
            existing?.summary ??
            null,
        title: update.title ?? existing?.title ?? "Tool call",
        updatedAt,
    };

    return {
        ...snapshot,
        pendingPermission: pendingUserInput ? null : snapshot.pendingPermission,
        pendingUserInput: pendingUserInput ?? snapshot.pendingUserInput,
        status: pendingUserInput ? "waiting_user_input" : snapshot.status,
        toolActivity: [
            ...snapshot.toolActivity.filter(
                (candidate) => candidate.id !== update.toolCallId,
            ),
            nextActivity,
        ],
        trackedFiles: content
            ? content.reduce(
                  (trackedFiles, entry) =>
                      entry.type === "diff"
                          ? upsertTrackedFile(
                                trackedFiles,
                                diffToTrackedFile(
                                    snapshot,
                                    entry,
                                    toolKind,
                                    update.toolCallId,
                                    updatedAt,
                                ),
                            )
                          : trackedFiles,
                  snapshot.trackedFiles,
              )
            : snapshot.trackedFiles,
    };
}

function collectDiffs(
    content: readonly ToolCallContent[] | null | undefined,
    toolKind: string,
): readonly AiFileDiff[] {
    return (content ?? []).flatMap((entry) =>
        entry.type === "diff" ? [diffToAiFileDiff(entry, toolKind)] : [],
    );
}

function diffToAiFileDiff(diff: Diff, toolKind: string): AiFileDiff {
    const previousPath = readDiffMetaString(
        diff._meta,
        NEVERWRITE_DIFF_PREVIOUS_PATH_KEY,
    );
    const kind = inferDiffKind(diff, toolKind, previousPath);
    const oldText = normalizeOldText(diff.oldText ?? null);
    const newText = normalizeNewText(kind, diff.newText ?? null);

    return {
        hunks: readDiffHunks(diff._meta, diff.path),
        isText: true,
        kind,
        newText,
        oldText,
        path: diff.path,
        previousPath,
        reversible: isDiffReversible(kind, oldText),
    };
}

function diffToTrackedFile(
    snapshot: AiSessionSnapshot,
    diff: Diff,
    toolKind: string,
    toolCallId: string,
    updatedAt: string,
): AiTrackedFile {
    const fileDiff = diffToAiFileDiff(diff, toolKind);
    const hunks =
        fileDiff.hunks.length > 0
            ? fileDiff.hunks
            : fileDiff.isText &&
                (fileDiff.oldText !== null || fileDiff.newText !== null)
              ? computeDiffHunks(
                    fileDiff.oldText ?? "",
                    fileDiff.newText ?? "",
                    diff.path,
                )
              : [];

    return {
        identityKey: fileDiff.previousPath
            ? `${fileDiff.previousPath}->${fileDiff.path}`
            : fileDiff.path,
        hunks,
        isText: true,
        kind: fileDiff.kind,
        newText: fileDiff.newText,
        oldText: fileDiff.oldText,
        path: fileDiff.path,
        previousPath: fileDiff.previousPath,
        reviewState: "pending",
        reversible: fileDiff.reversible,
        sessionId: snapshot.sessionId,
        toolCallId,
        updatedAt,
    };
}

function inferDiffKind(
    diff: Diff,
    toolKind: string,
    previousPath: string | null,
): AiTrackedFile["kind"] {
    if (previousPath || toolKind === "move") {
        return "move";
    }

    if (
        toolKind === "delete" ||
        (diff.oldText !== null && diff.oldText !== undefined && diff.newText == null)
    ) {
        return "delete";
    }

    if (diff.oldText == null) {
        return "create";
    }

    return "update";
}

function normalizeOldText(value: string | null): string | null {
    if (value === "[file deleted]") {
        return null;
    }

    return value;
}

function normalizeNewText(
    kind: AiTrackedFile["kind"],
    value: string | null,
): string | null {
    if (kind === "delete") {
        return null;
    }

    return value ?? "";
}

function isDiffReversible(
    kind: AiTrackedFile["kind"],
    oldText: string | null,
): boolean {
    if (kind === "create") {
        return true;
    }

    return oldText !== null;
}

function upsertTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    nextTrackedFile: AiTrackedFile,
): readonly AiTrackedFile[] {
    return replaceTrackedFile(
        trackedFiles,
        nextTrackedFile.path,
        nextTrackedFile,
    );
}

function replaceTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    path: string,
    nextTrackedFile: AiTrackedFile | null,
): readonly AiTrackedFile[] {
    const nextTrackedFiles = trackedFiles.filter(
        (trackedFile) => trackedFile.path !== path,
    );
    if (!nextTrackedFile) {
        return nextTrackedFiles;
    }

    return [...nextTrackedFiles, nextTrackedFile];
}

function parseUserInputRequest(
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updatedAt: string,
): AiUserInputRequest | null {
    if (
        !isRecord(update._meta) ||
        update._meta[NEVERWRITE_STATUS_EVENT_TYPE_KEY] !==
            NEVERWRITE_USER_INPUT_EVENT_TYPE ||
        !isRecord(update.rawInput)
    ) {
        return null;
    }

    const questionsValue = update.rawInput.questions;
    if (!Array.isArray(questionsValue)) {
        return null;
    }

    const questions = questionsValue
        .map((question, index) => parseUserInputQuestion(question, index))
        .filter((question): question is NonNullable<typeof question> =>
            Boolean(question),
        );
    if (questions.length === 0) {
        return null;
    }

    const headerTitle = questions
        .find((question) => question.header.trim().length > 0)
        ?.header.trim();
    const requestId =
        typeof update.rawInput.request_id === "string" &&
        update.rawInput.request_id.trim().length > 0
            ? update.rawInput.request_id
            : update.toolCallId;
    const turnId =
        typeof update.rawInput.turn_id === "string" &&
        update.rawInput.turn_id.trim().length > 0
            ? update.rawInput.turn_id
            : requestId;
    if (!turnId) {
        return null;
    }

    return {
        questions,
        requestId,
        sessionId: snapshot.sessionId,
        title:
            headerTitle ||
            (update.title ?? snapshot.title).trim() ||
            "Input requested",
        toolCallId: update.toolCallId,
        turnId,
        updatedAt,
    };
}

function parseUserInputQuestion(
    value: unknown,
    index: number,
): AiUserInputRequest["questions"][number] | null {
    if (!isRecord(value)) {
        return null;
    }

    const options = Array.isArray(value.options)
        ? value.options
              .map((option) => {
                  if (!isRecord(option) || typeof option.label !== "string") {
                      return null;
                  }

                  return {
                      description:
                          typeof option.description === "string"
                              ? option.description
                              : null,
                      label: option.label,
                  };
              })
              .filter((option): option is NonNullable<typeof option> =>
                  Boolean(option),
              )
        : [];

    return {
        header: typeof value.header === "string" ? value.header : "",
        id:
            typeof value.id === "string" && value.id.trim().length > 0
                ? value.id
                : `question-${index + 1}`,
        isOther: value.is_other === true,
        isSecret: value.is_secret === true,
        options,
        question:
            typeof value.question === "string"
                ? value.question
                : typeof value.label === "string"
                  ? value.label
                  : "Provide the requested input.",
    };
}

function buildUserInputResponsePrompt(
    turnId: string | null,
    answers: AiUserInputResponseInput["answers"],
): string {
    const payload = {
        response: {
            answers: Object.fromEntries(
                answers.map((answer) => [
                    answer.questionId,
                    {
                        answers: [...answer.answers],
                    },
                ]),
            ),
        },
        turn_id: turnId ?? "",
    };

    return `${NEVERWRITE_USER_INPUT_RESPONSE_PREFIX}${JSON.stringify(payload)}`;
}

function summarizeUserInputAnswers(
    questions: readonly AiUserInputRequest["questions"][number][],
    answers: AiUserInputResponseInput["answers"],
): string {
    if (answers.length === 0) {
        return "Responded to guided input.";
    }

    return answers
        .map((answer) => {
            const question = questions.find(
                (candidate) => candidate.id === answer.questionId,
            );
            const label =
                question?.header || question?.question || answer.questionId;
            return `${label}: ${answer.answers.join(", ")}`;
        })
        .join("\n");
}

function resolveTrackedFileHunks(
    trackedFile: AiTrackedFile,
    hunkIds: readonly string[],
    decision: "keep" | "reject",
): AiTrackedFile | null {
    if (
        hunkIds.length === 0 ||
        !trackedFile.isText ||
        trackedFile.hunks.length === 0
    ) {
        return trackedFile;
    }

    const selectedIds = new Set(hunkIds);
    const selectedHunks = trackedFile.hunks.filter((hunk) =>
        selectedIds.has(hunk.id),
    );
    if (selectedHunks.length === 0) {
        return trackedFile;
    }

    const baseOldText = trackedFile.oldText ?? "";
    const baseNewText = trackedFile.newText ?? "";
    const remainingHunks = trackedFile.hunks.filter(
        (hunk) => !selectedIds.has(hunk.id),
    );
    const oldText =
        decision === "keep"
            ? applyHunksToBase(baseOldText, selectedHunks)
            : baseOldText;
    const newText =
        decision === "keep"
            ? baseNewText
            : applyHunksToBase(baseOldText, remainingHunks);
    const nextHunks = computeDiffHunks(oldText, newText, trackedFile.path);

    if (oldText === newText) {
        return null;
    }

    const nextOldText = finalizeTrackedTextSide(trackedFile.oldText, oldText);
    const nextNewText = finalizeTrackedTextSide(trackedFile.newText, newText);

    return {
        ...trackedFile,
        hunks: nextHunks,
        kind: inferResolvedTrackedFileKind(trackedFile, nextOldText, nextNewText),
        newText: nextNewText,
        oldText: nextOldText,
        updatedAt: new Date().toISOString(),
    };
}

function inferResolvedTrackedFileKind(
    trackedFile: AiTrackedFile,
    oldText: string | null,
    newText: string | null,
): AiTrackedFile["kind"] {
    if (trackedFile.previousPath) {
        return "move";
    }

    if (oldText === null) {
        return "create";
    }

    if (newText === null) {
        return "delete";
    }

    return "update";
}

function finalizeTrackedTextSide(
    originalValue: string | null,
    nextValue: string,
): string | null {
    if (originalValue === null && nextValue.length === 0) {
        return null;
    }

    return nextValue;
}

function applyHunksToBase(
    baseText: string,
    hunks: readonly AiDiffHunk[],
): string {
    const baseLines = splitTextLines(baseText);
    const output: string[] = [];
    let cursor = 0;

    for (const hunk of [...hunks].sort(
        (left, right) => left.oldStart - right.oldStart,
    )) {
        const startIndex = Math.max(hunk.oldStart - 1, cursor);
        output.push(...baseLines.slice(cursor, startIndex));
        let localCursor = startIndex;

        for (const line of hunk.lines) {
            if (line.type === "context") {
                output.push(baseLines[localCursor] ?? line.text);
                localCursor += 1;
                continue;
            }

            if (line.type === "remove") {
                localCursor += 1;
                continue;
            }

            output.push(line.text);
        }

        cursor = localCursor;
    }

    output.push(...baseLines.slice(cursor));
    return output.join("\n");
}

function computeDiffHunks(
    oldText: string,
    newText: string,
    seed: string,
): readonly AiDiffHunk[] {
    const oldLines = splitTextLines(oldText);
    const newLines = splitTextLines(newText);
    const maxMatrixCells = 400_000;

    if (oldLines.length * newLines.length > maxMatrixCells) {
        return buildSingleHunk(seed, oldLines, newLines);
    }

    const matrix = Array.from(
        { length: oldLines.length + 1 },
        () => new Uint32Array(newLines.length + 1),
    );

    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            matrix[oldIndex][newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? matrix[oldIndex + 1][newIndex + 1] + 1
                    : Math.max(
                          matrix[oldIndex + 1][newIndex],
                          matrix[oldIndex][newIndex + 1],
                      );
        }
    }

    const operations: Array<{
        readonly text: string;
        readonly type: "add" | "context" | "remove";
    }> = [];
    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            operations.push({ text: oldLines[oldIndex], type: "context" });
            oldIndex += 1;
            newIndex += 1;
            continue;
        }

        if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) {
            operations.push({ text: oldLines[oldIndex], type: "remove" });
            oldIndex += 1;
            continue;
        }

        operations.push({ text: newLines[newIndex], type: "add" });
        newIndex += 1;
    }

    while (oldIndex < oldLines.length) {
        operations.push({ text: oldLines[oldIndex], type: "remove" });
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        operations.push({ text: newLines[newIndex], type: "add" });
        newIndex += 1;
    }

    const hunks: AiDiffHunk[] = [];
    let pendingLines: Array<{
        readonly id: string;
        readonly text: string;
        readonly type: "add" | "context" | "remove";
    }> = [];
    let pendingOldStart = 1;
    let pendingNewStart = 1;
    let pendingOldCount = 0;
    let pendingNewCount = 0;
    oldIndex = 1;
    newIndex = 1;

    const flushPending = () => {
        if (pendingLines.length === 0) {
            return;
        }

        hunks.push({
            id: `${seed}:${pendingOldStart}:${pendingNewStart}:${hunks.length}`,
            lines: pendingLines,
            newCount: pendingNewCount,
            newStart: pendingNewStart,
            oldCount: pendingOldCount,
            oldStart: pendingOldStart,
        });
        pendingLines = [];
        pendingOldCount = 0;
        pendingNewCount = 0;
    };

    for (const operation of operations) {
        if (operation.type === "context") {
            flushPending();
            oldIndex += 1;
            newIndex += 1;
            continue;
        }

        if (pendingLines.length === 0) {
            pendingOldStart = oldIndex;
            pendingNewStart = newIndex;
        }

        pendingLines.push({
            id: `line:${seed}:${pendingOldStart}:${pendingNewStart}:${pendingLines.length}`,
            text: operation.text,
            type: operation.type,
        });
        if (operation.type !== "add") {
            pendingOldCount += 1;
            oldIndex += 1;
        }
        if (operation.type !== "remove") {
            pendingNewCount += 1;
            newIndex += 1;
        }
    }
    flushPending();

    return hunks;
}

function buildSingleHunk(
    seed: string,
    oldLines: readonly string[],
    newLines: readonly string[],
): readonly AiDiffHunk[] {
    const lines = [
        ...oldLines.map((text, index) => ({
            id: `line:${seed}:remove:${index}`,
            text,
            type: "remove" as const,
        })),
        ...newLines.map((text, index) => ({
            id: `line:${seed}:add:${index}`,
            text,
            type: "add" as const,
        })),
    ];
    if (lines.length === 0) {
        return [];
    }

    return [
        {
            id: `${seed}:1:1:0`,
            lines,
            newCount: newLines.length,
            newStart: 1,
            oldCount: oldLines.length,
            oldStart: 1,
        },
    ];
}

function splitTextLines(text: string): string[] {
    if (text.length === 0) {
        return [];
    }

    return text.split("\n");
}

function readDiffMetaString(meta: unknown, key: string): string | null {
    if (!isRecord(meta)) {
        return null;
    }

    const value = meta[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readDiffHunks(meta: unknown, seed: string): readonly AiDiffHunk[] {
    if (!isRecord(meta) || !Array.isArray(meta[NEVERWRITE_DIFF_HUNKS_KEY])) {
        return [];
    }

    return meta[NEVERWRITE_DIFF_HUNKS_KEY].map((hunk, index) =>
        parseDiffHunk(hunk, `${seed}:${index}`),
    ).filter((hunk): hunk is NonNullable<typeof hunk> => Boolean(hunk));
}

function parseDiffHunk(value: unknown, seed: string): AiDiffHunk | null {
    if (!isRecord(value) || !Array.isArray(value.lines)) {
        return null;
    }

    const lines = value.lines
        .map((line, lineIndex) => {
            if (!isRecord(line) || typeof line.text !== "string") {
                return null;
            }
            if (
                line.type !== "add" &&
                line.type !== "context" &&
                line.type !== "remove"
            ) {
                return null;
            }

            const lineType: "add" | "context" | "remove" = line.type;

            return {
                id:
                    typeof line.id === "string"
                        ? line.id
                        : `line:${seed}:${lineIndex}`,
                text: line.text,
                type: lineType,
            };
        })
        .filter((line): line is NonNullable<typeof line> => Boolean(line));
    if (lines.length === 0) {
        return null;
    }

    return {
        id: seed,
        lines,
        newCount:
            typeof value.newCount === "number"
                ? value.newCount
                : typeof value.new_count === "number"
                  ? value.new_count
                  : 0,
        newStart:
            typeof value.newStart === "number"
                ? value.newStart
                : typeof value.new_start === "number"
                  ? value.new_start
                  : 1,
        oldCount:
            typeof value.oldCount === "number"
                ? value.oldCount
                : typeof value.old_count === "number"
                  ? value.old_count
                  : 0,
        oldStart:
            typeof value.oldStart === "number"
                ? value.oldStart
                : typeof value.old_start === "number"
                  ? value.old_start
                  : 1,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringifyJson(value: unknown): string | null {
    if (value === undefined) {
        return null;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return null;
    }
}

function buildToolSummary(
    title: string,
    content: readonly ToolCallContent[] | null | undefined,
): string | null {
    const diffCount = (content ?? []).filter(
        (entry) => entry.type === "diff",
    ).length;

    if (diffCount > 0) {
        return `${title} · ${diffCount} diff${diffCount === 1 ? "" : "s"}`;
    }

    return title || null;
}

function formatContentBlock(content: ContentBlock): string {
    if (content.type === "text") {
        return content.text;
    }

    if (content.type === "resource_link") {
        return content.uri;
    }

    return `[${content.type}]`;
}

async function readTextIfExists(absolutePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(absolutePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }

        throw error;
    }
}

function toPosixPath(candidatePath: string): string {
    return candidatePath.split(path.sep).join("/");
}
