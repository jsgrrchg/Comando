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
    AiFileDiff,
    AiPermissionRequest,
    AiPermissionResponseInput,
    AiPromptResult,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionSnapshot,
    AiTrackedFile,
    AiTrackedFileMutationInput,
    CodexRuntimeSettings,
    SendAiPromptInput,
} from "@shared/ipc";

import type { ProjectService } from "@main/projects/service";
import type { SettingsService } from "@main/settings/service";

import { createEmptyAiSessionSnapshot, AiPersistence } from "./persistence";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";

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
            liveSession.snapshot.status === "waiting_permission"
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

    async keepTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const liveSession = await this.#loadSessionForReview(input.sessionId);
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: liveSession.snapshot.trackedFiles.map(
                (trackedFile) =>
                    trackedFile.path === input.path
                        ? {
                              ...trackedFile,
                              reviewState: "kept",
                              updatedAt: new Date().toISOString(),
                          }
                        : trackedFile,
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
            trackedFiles: liveSession.snapshot.trackedFiles.map((candidate) =>
                candidate.path === input.path
                    ? {
                          ...candidate,
                          reviewState: "rejected",
                          updatedAt: new Date().toISOString(),
                      }
                    : candidate,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        const liveSession = await this.#loadSessionForReview(sessionId);
        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: liveSession.snapshot.trackedFiles.map(
                (trackedFile) => ({
                    ...trackedFile,
                    reviewState: "kept",
                    updatedAt: new Date().toISOString(),
                }),
            ),
            updatedAt: new Date().toISOString(),
        };
        this.#persistAndBroadcast(liveSession);
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        const liveSession = await this.#loadSessionForReview(sessionId);

        for (const trackedFile of liveSession.snapshot.trackedFiles) {
            if (trackedFile.reviewState === "rejected") {
                continue;
            }

            await this.#revertTrackedFile(liveSession, trackedFile);
        }

        liveSession.snapshot = {
            ...liveSession.snapshot,
            trackedFiles: liveSession.snapshot.trackedFiles.map(
                (trackedFile) => ({
                    ...trackedFile,
                    reviewState: "rejected",
                    updatedAt: new Date().toISOString(),
                }),
            ),
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
                nextSnapshot = upsertToolActivity(nextSnapshot, update, now);
                break;
            case "tool_call_update":
                nextSnapshot = mergeToolActivity(nextSnapshot, update, now);
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
                isText: true,
                kind: previousContent === null ? "create" : "update",
                newText: params.content,
                oldText: previousContent,
                path: trackedPath,
                reviewState: "pending",
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

function upsertToolActivity(
    snapshot: AiSessionSnapshot,
    toolCall: ToolCall,
    updatedAt: string,
): AiSessionSnapshot {
    const activity = {
        diffs: collectDiffs(toolCall.content),
        id: toolCall.toolCallId,
        kind: toolCall.kind ?? "unknown",
        locations: (toolCall.locations ?? []).map((location) => location.path),
        rawInputJson: stringifyJson(toolCall.rawInput),
        rawOutputJson: stringifyJson(toolCall.rawOutput),
        sessionId: snapshot.sessionId,
        status: toolCall.status ?? "pending",
        summary: buildToolSummary(toolCall.title, toolCall.content),
        title: toolCall.title,
        updatedAt,
    };

    return {
        ...snapshot,
        toolActivity: [
            ...snapshot.toolActivity.filter(
                (candidate) => candidate.id !== toolCall.toolCallId,
            ),
            activity,
        ],
        trackedFiles: collectDiffTrackedFiles(snapshot, toolCall, updatedAt),
    };
}

function mergeToolActivity(
    snapshot: AiSessionSnapshot,
    update: ToolCallUpdate,
    updatedAt: string,
): AiSessionSnapshot {
    const existing =
        snapshot.toolActivity.find(
            (candidate) => candidate.id === update.toolCallId,
        ) ?? null;
    const diffs = update.content
        ? collectDiffs(update.content)
        : (existing?.diffs ?? []);
    const nextActivity = {
        diffs,
        id: update.toolCallId,
        kind: update.kind ?? existing?.kind ?? "unknown",
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
                update.content,
            ) ??
            existing?.summary ??
            null,
        title: update.title ?? existing?.title ?? "Tool call",
        updatedAt,
    };

    return {
        ...snapshot,
        toolActivity: [
            ...snapshot.toolActivity.filter(
                (candidate) => candidate.id !== update.toolCallId,
            ),
            nextActivity,
        ],
        trackedFiles: update.content
            ? update.content.reduce(
                  (trackedFiles, content) =>
                      content.type === "diff"
                          ? upsertTrackedFile(
                                trackedFiles,
                                diffToTrackedFile(
                                    snapshot,
                                    content,
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

function collectDiffTrackedFiles(
    snapshot: AiSessionSnapshot,
    toolCall: ToolCall,
    updatedAt: string,
): readonly AiTrackedFile[] {
    return (toolCall.content ?? []).reduce(
        (trackedFiles, content) =>
            content.type === "diff"
                ? upsertTrackedFile(
                      trackedFiles,
                      diffToTrackedFile(
                          snapshot,
                          content,
                          toolCall.toolCallId,
                          updatedAt,
                      ),
                  )
                : trackedFiles,
        snapshot.trackedFiles,
    );
}

function collectDiffs(
    content: readonly ToolCallContent[] | null | undefined,
): readonly AiFileDiff[] {
    return (content ?? []).flatMap((entry) =>
        entry.type === "diff" ? [diffToAiFileDiff(entry)] : [],
    );
}

function diffToAiFileDiff(diff: Diff): AiFileDiff {
    return {
        kind: diff.oldText == null ? "create" : "update",
        newText: diff.newText,
        oldText: diff.oldText ?? null,
        path: diff.path,
    };
}

function diffToTrackedFile(
    snapshot: AiSessionSnapshot,
    diff: Diff,
    toolCallId: string,
    updatedAt: string,
): AiTrackedFile {
    return {
        identityKey: diff.path,
        isText: true,
        kind: diff.oldText == null ? "create" : "update",
        newText: diff.newText,
        oldText: diff.oldText ?? null,
        path: diff.path,
        reviewState: "pending",
        sessionId: snapshot.sessionId,
        toolCallId,
        updatedAt,
    };
}

function upsertTrackedFile(
    trackedFiles: readonly AiTrackedFile[],
    nextTrackedFile: AiTrackedFile,
): readonly AiTrackedFile[] {
    return [
        ...trackedFiles.filter(
            (trackedFile) =>
                trackedFile.identityKey !== nextTrackedFile.identityKey,
        ),
        nextTrackedFile,
    ];
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
