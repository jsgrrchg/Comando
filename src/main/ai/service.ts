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
    AiHistorySessionSummary,
    AiPermissionRequest,
    AiPermissionResponseInput,
    AiPromptResult,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputResponseInput,
    ClaudeRuntimeSettingsInput,
    CodexRuntimeSettingsInput,
    CodexRuntimeSettings,
    GeminiRuntimeSettingsInput,
    GetAiSessionTranscriptPageInput,
    KiloRuntimeSettingsInput,
    ListAiSessionHistoryInput,
    SecretValuePatch,
    SendAiPromptInput,
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

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { SecretStoreGateway } from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
} from "./persistence";
import {
    AI_SESSION_STREAMING_FLUSH_MS,
    type AiServiceOptions,
    type LiveAcpSession,
    type OpenRuntimeSessionResult,
    type ResolvedAcpRuntime,
    type SessionDescriptor,
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
    normalizeAdditionalRoots,
    resolveSessionTitleOnPrompt,
    sameAdditionalRoots,
    setConfigOptionOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setTitleOnSnapshot,
    shouldFlushLiveSessionImmediately,
    summarizeUserInputAnswers,
    toPosixPath,
    serializeComposerPartsForDisplay,
} from "./session-core";
import {
    diffToAiFileDiff,
    mapToolCallUpdate,
    normalizeTrackedDiffPath,
    readTextIfExists,
    resolveDiffToFullTexts,
    shouldSuppressToolActivityUpdate,
} from "./review-core";
import { buildRuntimeSpawnEnv } from "./runtime-env";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";
import {
    applyCodexAuthEnv,
    getCodexAuthMethods,
    getCodexRuntimeStatus,
    isCodexAuthenticationError,
    type CodexSecretBundle,
    loadCodexSecretBundle,
    saveCodexSecrets,
} from "./codex/setup";
import {
    applyClaudeAuthEnv,
    getClaudeRuntimeStatus,
    isClaudeAuthenticationError,
    launchClaudeLogin,
    loadClaudeSecretBundle,
    markClaudeAuthInvalidated,
    resolveClaudeRuntime,
    saveClaudeSecrets,
} from "./claude/setup";
import {
    applyGeminiAuthEnv,
    getGeminiRuntimeStatus,
    isGeminiAuthenticationError,
    launchGeminiLogin,
    markGeminiAuthInvalidated,
    resolveGeminiRuntime,
    saveGeminiSecrets,
} from "./gemini/setup";
import {
    getKiloRuntimeStatus,
    isKiloAuthenticationError,
    launchKiloLogin,
    markKiloAuthInvalidated,
    resolveKiloRuntime,
} from "./kilo/setup";

function toWebByteWritable(stream: Writable): WritableStream<Uint8Array> {
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function toWebByteReadable(stream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export class AiService {
    readonly #onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly #onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly #persistence: AiPersistenceGateway;
    readonly #projectService: ProjectService;
    readonly #secretStore: SecretStoreGateway;
    readonly #settingsService: SettingsGateway;
    readonly #sessions = new Map<string, LiveAcpSession>();

    constructor(options: AiServiceOptions) {
        this.#onRuntimeStatus = options.onRuntimeStatus;
        this.#onSessionSnapshot = options.onSessionSnapshot;
        this.#persistence = options.persistence;
        this.#projectService = options.projectService;
        this.#secretStore = options.secretStore;
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
        const status = this.#withPersistedRuntimeCatalog(
            this.#resolveRuntimeStatus(runtimeId),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    saveCodexRuntimeSettings(
        settings: CodexRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        const nextSecrets = resolveCodexSecretBundle(
            loadCodexSecretBundle(this.#secretStore),
            settings,
        );
        const secretFlags = saveCodexSecrets(this.#secretStore, {
            codexApiKey: nextSecrets.codexApiKey,
            openaiApiKey: nextSecrets.openaiApiKey,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasCodexApiKey: secretFlags.hasCodexApiKey,
            hasOpenAiApiKey: secretFlags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;

        this.#settingsService.saveCodexRuntimeSettings(nextSettings);
        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(nextSettings, nextSecrets),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    saveClaudeRuntimeSettings(
        settings: ClaudeRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings =
            this.#settingsService.loadClaudeRuntimeSettings();
        const currentSecrets = loadClaudeSecretBundle(this.#secretStore);
        const gatewayAuthToken = applySecretValuePatch(
            currentSecrets.anthropicAuthToken,
            settings.gatewayAuthToken,
        );
        const gatewayCustomHeaders = applySecretValuePatch(
            currentSecrets.anthropicCustomHeaders,
            settings.gatewayCustomHeaders,
        );
        const secretFlags = saveClaudeSecrets(this.#secretStore, {
            gatewayAuthToken,
            gatewayCustomHeaders,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            gatewayBaseUrl: normalizeOptionalText(settings.gatewayBaseUrl),
            hasGatewayAuthToken: secretFlags.hasGatewayAuthToken,
            hasGatewayCustomHeaders: secretFlags.hasGatewayCustomHeaders,
        };

        this.#settingsService.saveClaudeRuntimeSettings(nextSettings);
        const status = this.#withPersistedRuntimeCatalog(
            getClaudeRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    saveGeminiRuntimeSettings(
        settings: GeminiRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings =
            this.#settingsService.loadGeminiRuntimeSettings();
        const geminiApiKey = applySecretValuePatch(
            this.#secretStore.loadSecret("ai.gemini", "gemini_api_key"),
            settings.geminiApiKey,
        );
        const googleApiKey = applySecretValuePatch(
            this.#secretStore.loadSecret("ai.gemini", "google_api_key"),
            settings.googleApiKey,
        );
        const secretFlags = saveGeminiSecrets(this.#secretStore, {
            geminiApiKey,
            googleApiKey,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            googleCloudLocation: normalizeOptionalText(
                settings.googleCloudLocation,
            ),
            googleCloudProject: normalizeOptionalText(
                settings.googleCloudProject,
            ),
            hasGeminiApiKey: secretFlags.hasGeminiApiKey,
            hasGoogleApiKey: secretFlags.hasGoogleApiKey,
        };

        this.#settingsService.saveGeminiRuntimeSettings(nextSettings);
        const status = this.#withPersistedRuntimeCatalog(
            getGeminiRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    saveKiloRuntimeSettings(
        settings: KiloRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings = this.#settingsService.loadKiloRuntimeSettings();
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            binaryPath: normalizeOptionalText(settings.binaryPath),
        };

        this.#settingsService.saveKiloRuntimeSettings(nextSettings);
        const status = this.#withPersistedRuntimeCatalog(
            getKiloRuntimeStatus(nextSettings),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    verifyCodexRuntimeSettings(
        settings: CodexRuntimeSettingsInput,
    ): AiRuntimeStatus {
        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        const nextSecrets = resolveCodexSecretBundle(
            loadCodexSecretBundle(this.#secretStore),
            settings,
        );
        const nextSettings = {
            ...currentSettings,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasCodexApiKey: Boolean(nextSecrets.codexApiKey),
            hasOpenAiApiKey: Boolean(nextSecrets.openaiApiKey),
        } satisfies CodexRuntimeSettings;
        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(nextSettings, nextSecrets),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async getSessionSnapshot(
        sessionId: string,
    ): Promise<AiSessionSnapshot | null> {
        const liveSession = this.#sessions.get(sessionId);
        if (liveSession) {
            return liveSession.snapshot;
        }

        return await this.#persistence.loadSessionSnapshot(sessionId);
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        return await this.#persistence.listSessionHistory(input);
    }

    async getSessionTranscriptPage(
        input: GetAiSessionTranscriptPageInput,
    ): Promise<AiSessionTranscriptPage> {
        const page = await this.#persistence.loadSessionTranscriptPage(input);
        if (!page) {
            throw new Error("The session could not be found.");
        }

        return page;
    }

    async prepareSession(
        input: PrepareAiSessionInput,
        ownerWindowId: string,
    ): Promise<AiSessionSnapshot> {
        const liveSession = await this.#ensureRuntimeSession(
            input,
            ownerWindowId,
        );
        return liveSession.snapshot;
    }

    async refreshProjectScopes(projectId: string): Promise<void> {
        const refreshTasks = [...this.#sessions.entries()]
            .filter(
                ([, liveSession]) =>
                    liveSession.snapshot.projectId === projectId,
            )
            .map(async ([sessionId, liveSession]) => {
                try {
                    await this.#refreshLiveSessionScopes(
                        sessionId,
                        liveSession,
                    );
                } catch (error) {
                    // A single session failing must not abort refreshes for
                    // other live sessions of the same project.
                    console.error(
                        `[ai] refreshProjectScopes failed for session ${sessionId}`,
                        error,
                    );
                }
            });

        await Promise.all(refreshTasks);
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        const liveSession = await this.#ensureRuntimeSession(
            input,
            ownerWindowId,
        );
        if (
            liveSession.snapshot.status === "starting" ||
            liveSession.snapshot.status === "streaming" ||
            liveSession.snapshot.status === "waiting_permission" ||
            liveSession.snapshot.status === "waiting_user_input"
        ) {
            throw new SessionBusyError();
        }

        const now = new Date().toISOString();
        const promptText = input.prompt.trim();
        const displayContent = serializeComposerPartsForDisplay(
            input.composerParts,
            promptText,
        );
        if (!promptText && input.attachments.length === 0) {
            throw new Error("Type a prompt before sending it.");
        }

        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            lastError: null,
            messages: [
                ...liveSession.snapshot.messages,
                {
                    attachments: input.attachments,
                    content: displayContent,
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
            title: resolveSessionTitleOnPrompt({
                currentTitle: liveSession.snapshot.title,
                fallbackTitle: input.title,
                displayContent,
                hasPriorUserMessage: liveSession.snapshot.messages.some(
                    (message) => message.kind === "user",
                ),
            }),
            updatedAt: now,
            worktreeId: input.worktreeId ?? null,
        });
        this.#persistAndBroadcast(liveSession);

        try {
            const response = await liveSession.connection.prompt({
                messageId: randomUUID(),
                prompt: buildPromptContentBlocks(promptText, input.attachments),
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
            this.#schedulePendingScopeRefresh(input.sessionId);

            return {
                sessionId: input.sessionId,
                stopReason: response.stopReason,
            };
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(input.runtimeId)} could not complete the prompt.`;
            this.#invalidateRuntimeAuthIfNeeded(liveSession.runtimeId, message);
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                lastError: message,
                pendingPermission: null,
                pendingUserInput: null,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#persistAndBroadcast(liveSession);
            this.#schedulePendingScopeRefresh(input.sessionId);
            throw error;
        }
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModeOnSnapshot(currentSnapshot, input.modeId),
            );
            this.#persistence.saveRuntimeModePreference(
                snapshot.runtimeId,
                input.modeId,
            );
            return;
        }

        await this.#setSessionModeOnLiveSession(liveSession, input.modeId);
        this.#persistence.saveRuntimeModePreference(
            liveSession.runtimeId,
            input.modeId,
        );
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setModelOnSnapshot(currentSnapshot, input.modelId),
            );
            this.#persistence.saveRuntimeModelPreference(
                snapshot.runtimeId,
                input.modelId,
            );
            return;
        }

        await this.#setSessionModelOnLiveSession(liveSession, input.modelId);
        this.#persistence.saveRuntimeModelPreference(
            liveSession.runtimeId,
            input.modelId,
        );
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setConfigOptionOnSnapshot(
                        currentSnapshot,
                        input.optionId,
                        input.value,
                    ),
            );
            this.#persistRuntimeSelectionPreference(
                snapshot.runtimeId,
                input.optionId,
                input.value,
            );
            return;
        }

        await this.#setSessionConfigOptionOnLiveSession(
            liveSession,
            input.optionId,
            input.value,
        );
        this.#persistRuntimeSelectionPreference(
            liveSession.runtimeId,
            input.optionId,
            input.value,
        );
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
            setTitleOnSnapshot(snapshot, input.title),
        );
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
        this.#flushLiveSessionPersistence(liveSession, {
            broadcast: false,
        });
        this.#resolvePendingPermission(liveSession, null);

        try {
            if (liveSession.snapshot.runtimeSessionId) {
                await liveSession.connection.unstable_closeSession({
                    sessionId: liveSession.snapshot.runtimeSessionId,
                });
            }
        } catch (error) {
            // The process is killed below regardless.
            debugBenignError("ai.service.unstableCloseSession", error);
        }

        liveSession.child.kill();
        this.#sessions.delete(sessionId);
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (this.#sessions.has(sessionId)) {
            try {
                await this.cancelSession(sessionId);
            } catch (error) {
                // Closing and deleting the local session state is still safe.
                debugBenignError("ai.service.deleteSession.cancel", error);
            }

            await this.closeSession(sessionId);
        }

        await this.#persistence.deleteSession(sessionId);
    }

    closeOwnedByWindow(ownerWindowId: string): void {
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

            liveSession.closing = true;
            this.#flushLiveSessionPersistence(liveSession, {
                broadcast: false,
            });
            this.#resolvePendingPermission(liveSession, null);
            liveSession.child.kill();
            this.#sessions.delete(sessionId);
        }
    }

    async launchRuntimeAuth(input: AiRuntimeAuthLaunchInput): Promise<void> {
        const cwd = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : process.cwd();

        if (input.runtimeId === "claude") {
            const currentSettings =
                this.#settingsService.loadClaudeRuntimeSettings();
            const authMethod =
                input.methodId === "gateway"
                    ? "gateway"
                    : input.methodId === "claude-login" ||
                        input.methodId === "claude-ai-login" ||
                        input.methodId === "console-login"
                      ? input.methodId
                      : null;

            if (authMethod === null || authMethod === "gateway") {
                throw new Error(
                    "Select a Claude login method before opening authentication.",
                );
            }

            const nextSettings = markClaudeAuthInvalidated({
                ...currentSettings,
                authMethod,
            });
            this.#settingsService.saveClaudeRuntimeSettings(nextSettings);

            const resolvedRuntime = resolveClaudeRuntime(
                nextSettings,
                this.#secretStore,
            );

            await launchClaudeLogin(resolvedRuntime, authMethod, cwd);
            this.#onRuntimeStatus(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (input.runtimeId === "gemini") {
            const currentSettings =
                this.#settingsService.loadGeminiRuntimeSettings();
            const authMethod =
                input.methodId === "login_with_google" ||
                input.methodId === "use_gemini"
                    ? input.methodId
                    : null;

            if (authMethod === null) {
                throw new Error(
                    "Select a valid Gemini login method before opening authentication.",
                );
            }

            if (authMethod === "use_gemini") {
                throw new Error(
                    "The Gemini API key does not need a login terminal. Save the API key from settings.",
                );
            }

            const nextSettings = markGeminiAuthInvalidated({
                ...currentSettings,
                authMethod,
            });
            this.#settingsService.saveGeminiRuntimeSettings(nextSettings);

            await launchGeminiLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                getGeminiRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (input.runtimeId === "kilo") {
            if (input.methodId !== "kilo-login") {
                throw new Error(
                    "Select Kilo login before opening authentication.",
                );
            }

            const nextSettings = markKiloAuthInvalidated(
                this.#settingsService.loadKiloRuntimeSettings(),
            );
            this.#settingsService.saveKiloRuntimeSettings(nextSettings);

            await launchKiloLogin(nextSettings, cwd);
            this.#onRuntimeStatus(getKiloRuntimeStatus(nextSettings));
            return;
        }

        if (input.runtimeId === "codex") {
            const currentSettings =
                this.#settingsService.loadCodexRuntimeSettings();
            const authMethod = getCodexAuthMethods().some(
                (method) => method.id === input.methodId,
            )
                ? (input.methodId as CodexRuntimeSettings["authMethod"])
                : null;

            if (authMethod === null) {
                throw new Error(
                    "Choose a valid Codex login method before opening authentication.",
                );
            }

            const nextSettings = {
                ...currentSettings,
                authMethod,
            } satisfies CodexRuntimeSettings;
            await this.#runRuntimeAuthConnection(
                "codex",
                cwd,
                async (connection) => {
                    const initializeResponse = await connection.initialize({
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

                    const advertisedMethods =
                        initializeResponse.authMethods?.map(
                            (method) => method.id,
                        ) ?? [];
                    if (!advertisedMethods.includes(authMethod)) {
                        throw new Error(
                            `Codex does not support the authentication method \`${authMethod}\` on this machine.`,
                        );
                    }

                    await connection.authenticate({
                        methodId: authMethod,
                    });
                },
                nextSettings,
            );

            this.#settingsService.saveCodexRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                this.#withPersistedRuntimeCatalog(
                    getCodexRuntimeStatus(
                        nextSettings,
                        loadCodexSecretBundle(this.#secretStore),
                    ),
                ),
            );
            return;
        }

        throw new Error(
            `${getRuntimeDisplayName(input.runtimeId)} does not support this authentication flow yet.`,
        );
    }

    async logoutRuntimeAuth(
        input: AiRuntimeAuthLogoutInput,
    ): Promise<AiRuntimeStatus> {
        if (input.runtimeId !== "codex") {
            throw new Error(
                `${getRuntimeDisplayName(input.runtimeId)} does not support logout yet.`,
            );
        }

        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        if (currentSettings.authMethod === "chatgpt") {
            await this.#runRuntimeAuthConnection(
                "codex",
                process.cwd(),
                async (connection) => {
                    const initializeResponse = await connection.initialize({
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

                    if (!initializeResponse.agentCapabilities?.auth?.logout) {
                        throw new Error(
                            "Codex does not advertise logout support on this machine.",
                        );
                    }

                    await connection.unstable_logout({});
                },
            );
        }

        const secretFlags = saveCodexSecrets(this.#secretStore, {
            codexApiKey: null,
            openaiApiKey: null,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: null,
            hasCodexApiKey: secretFlags.hasCodexApiKey,
            hasOpenAiApiKey: secretFlags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;
        this.#settingsService.saveCodexRuntimeSettings(nextSettings);

        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(
                nextSettings,
                loadCodexSecretBundle(this.#secretStore),
            ),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    respondPermission(input: AiPermissionResponseInput): Promise<void> {
        const liveSession = this.#sessions.get(input.sessionId);
        if (!liveSession?.pendingPermission) {
            throw new Error("There is no pending permission request.");
        }

        if (liveSession.pendingPermission.requestId !== input.requestId) {
            throw new Error("The permission request no longer matches.");
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
            throw new Error("The AI session was not found.");
        }

        const pendingUserInput = liveSession.snapshot.pendingUserInput;
        if (!pendingUserInput) {
            throw new Error("There is no pending input request.");
        }

        if (pendingUserInput.requestId !== input.requestId) {
            throw new Error("The input request no longer matches.");
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
            this.#schedulePendingScopeRefresh(input.sessionId);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : `${getRuntimeDisplayName(liveSession.runtimeId)} ACP no pudo enviar la respuesta guiada.`;
            this.#invalidateRuntimeAuthIfNeeded(liveSession.runtimeId, message);
            liveSession.snapshot = finalizeStreamingMessages({
                ...liveSession.snapshot,
                lastError: message,
                pendingUserInput,
                status: "error",
                updatedAt: new Date().toISOString(),
            });
            this.#persistAndBroadcast(liveSession);
            this.#schedulePendingScopeRefresh(input.sessionId);
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
            throw new Error("The file to review was not found.");
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
            throw new Error("The file to review was not found.");
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
            throw new Error("The file to review was not found.");
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

    async #ensureRuntimeSession(
        input: SessionDescriptor,
        ownerWindowId: string,
    ): Promise<LiveAcpSession> {
        const existing = this.#sessions.get(input.sessionId);
        const projectRoot = input.projectId
            ? this.#projectService.getProjectRootPath(
                  input.projectId,
                  input.worktreeId ?? null,
              )
            : null;
        const additionalRoots = this.#resolveEffectiveAdditionalRoots(
            input,
            projectRoot,
        );
        if (
            existing?.snapshot.runtimeSessionId &&
            existing.runtimeId === input.runtimeId &&
            sameAdditionalRoots(existing.additionalRoots, additionalRoots)
        ) {
            existing.ownerWindowId = ownerWindowId;
            return existing;
        }
        if (existing) {
            this.#disposeLiveSession(input.sessionId, existing);
        }

        const resolvedRuntime = this.#resolveRuntimeCommand(input.runtimeId);
        this.#onRuntimeStatus(resolvedRuntime.status);

        if (
            resolvedRuntime.status.state !== "ready" ||
            resolvedRuntime.status.onboardingRequired
        ) {
            throw new Error(
                resolvedRuntime.status.message ??
                    `${getRuntimeDisplayName(input.runtimeId)} ACP is not available on this machine.`,
            );
        }

        const persistedSnapshot =
            (await this.#persistence.loadSessionSnapshot(input.sessionId)) ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                sessionId: input.sessionId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            });
        const cwd = projectRoot ?? process.cwd();
        const child = spawn(
            resolvedRuntime.executable,
            [...resolvedRuntime.args],
            {
                cwd,
                env: resolvedRuntime.env,
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

        Object.assign(liveSession, {
            additionalRoots,
            child,
            closing: false,
            connection,
            cwd,
            isRestoring: false,
            lastBroadcastSnapshot: null,
            ownerWindowId,
            pendingPermission: null,
            pendingAdditionalRoots: null,
            pendingPersistTimer: null,
            processedDiffPaths: new Map(),
            projectRoot,
            runtimeId: input.runtimeId,
            snapshot: {
                ...persistedSnapshot,
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                status: getPreparedSessionStatus(persistedSnapshot),
                title:
                    persistedSnapshot.title &&
                    !isDefaultChatTitle(persistedSnapshot.title)
                        ? persistedSnapshot.title
                        : input.title,
                updatedAt: new Date().toISOString(),
                worktreeId: input.worktreeId ?? null,
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

            const desiredSelections = this.#resolveDesiredSelections(
                input.runtimeId,
                persistedSnapshot,
            );
            const openedSession = await this.#openRuntimeSession(liveSession);
            liveSession.snapshot = {
                ...applySessionCatalogToSnapshot(
                    liveSession.snapshot,
                    openedSession,
                ),
                lastError: null,
                runtimeSessionId: openedSession.runtimeSessionId,
            };
            await this.#applyStoredSessionSelections(
                liveSession,
                desiredSelections,
            );
            liveSession.snapshot = {
                ...liveSession.snapshot,
                lastError: null,
                status: getPreparedSessionStatus(liveSession.snapshot),
                updatedAt: new Date().toISOString(),
            };
            this.#persistAndBroadcast(liveSession);
            return liveSession;
        } catch (error) {
            const stderrText = getRecentStderrText(liveSession.stderrChunks);
            const message =
                stderrText ||
                (error instanceof Error
                    ? error.message
                    : `Could not start ${getRuntimeDisplayName(input.runtimeId)} ACP.`);
            this.#invalidateRuntimeAuthIfNeeded(input.runtimeId, message);
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

    async #openRuntimeSession(
        liveSession: LiveAcpSession,
    ): Promise<OpenRuntimeSessionResult> {
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
                // If the session cannot be resumed, start a new one.
                debugBenignError("ai.service.loadSession.resume", error);
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
        this.#persistAndBroadcast(liveSession);

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
                );
                break;
            case "tool_call_update":
                nextSnapshot = mapToolCallUpdate(
                    liveSession,
                    nextSnapshot,
                    update,
                    "tool_call_update",
                    now,
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
            default:
                break;
        }

        liveSession.snapshot = nextSnapshot;
        this.#persistAndBroadcast(liveSession);
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
        liveSession: LiveAcpSession,
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
                worktreeId: liveSession.snapshot.worktreeId ?? null,
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
        this.#persistAndBroadcast(liveSession);

        return {};
    }

    async #loadSessionForReview(sessionId: string): Promise<LiveAcpSession> {
        const liveSession = this.#sessions.get(sessionId);
        if (liveSession) {
            return liveSession;
        }

        const snapshot = await this.#persistence.loadSessionSnapshot(sessionId);
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        return {
            additionalRoots: [],
            child: null as never,
            closing: true,
            connection: null as never,
            cwd:
                snapshot.projectId !== null
                    ? this.#projectService.getProjectRootPath(
                          snapshot.projectId,
                          snapshot.worktreeId ?? null,
                      )
                    : process.cwd(),
            isRestoring: false,
            lastBroadcastSnapshot: snapshot,
            ownerWindowId: "",
            pendingPermission: null,
            pendingAdditionalRoots: null,
            pendingPersistTimer: null,
            processedDiffPaths: new Map(),
            projectRoot:
                snapshot.projectId !== null
                    ? this.#projectService.getProjectRootPath(
                          snapshot.projectId,
                          snapshot.worktreeId ?? null,
                      )
                    : null,
            runtimeId: snapshot.runtimeId,
            snapshot,
            terminalOutputBuffers: new Map(),
            stderrChunks: [],
            stderrHandler: null,
        };
    }

    async #revertTrackedFile(
        liveSession: LiveAcpSession,
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
                if (
                    previousPath.relativePath &&
                    liveSession.snapshot.projectId
                ) {
                    await this.#projectService.saveProjectFile({
                        content: trackedFile.oldText,
                        projectId: liveSession.snapshot.projectId,
                        relativePath: previousPath.relativePath,
                        worktreeId: liveSession.snapshot.worktreeId ?? null,
                    });
                } else {
                    await fs.promises.mkdir(
                        path.dirname(previousPath.absolutePath),
                        {
                            recursive: true,
                        },
                    );
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
                        worktreeId: liveSession.snapshot.worktreeId ?? null,
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
                        worktreeId: liveSession.snapshot.worktreeId ?? null,
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
                worktreeId: liveSession.snapshot.worktreeId ?? null,
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
        liveSession: LiveAcpSession,
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
                worktreeId: liveSession.snapshot.worktreeId ?? null,
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

    async #refreshLiveSessionScopes(
        sessionId: string,
        liveSession: LiveAcpSession,
    ): Promise<void> {
        const projectId = liveSession.snapshot.projectId;
        if (!projectId) {
            liveSession.pendingAdditionalRoots = null;
            return;
        }

        const projectRoot = this.#resolveProjectRootPathSafe(
            projectId,
            liveSession.snapshot.worktreeId ?? null,
        );
        if (!projectRoot) {
            return;
        }

        const additionalRoots = this.#resolveEffectiveAdditionalRoots(
            {
                additionalRoots: [],
                projectId,
                worktreeId: liveSession.snapshot.worktreeId ?? null,
            },
            projectRoot,
        );

        if (sameAdditionalRoots(liveSession.additionalRoots, additionalRoots)) {
            liveSession.pendingAdditionalRoots = null;
            return;
        }

        if (isBusyAiSessionStatus(liveSession.snapshot.status)) {
            liveSession.pendingAdditionalRoots = additionalRoots;
            return;
        }

        liveSession.pendingAdditionalRoots = null;
        await this.#ensureRuntimeSession(
            {
                additionalRoots,
                projectId,
                runtimeId: liveSession.runtimeId,
                sessionId,
                title: liveSession.snapshot.title,
                worktreeId: liveSession.snapshot.worktreeId ?? null,
            },
            liveSession.ownerWindowId,
        );
    }

    #schedulePendingScopeRefresh(sessionId: string): void {
        const liveSession = this.#sessions.get(sessionId);
        if (
            !liveSession?.pendingAdditionalRoots ||
            isBusyAiSessionStatus(liveSession.snapshot.status)
        ) {
            return;
        }

        const nextRoots = liveSession.pendingAdditionalRoots;
        if (sameAdditionalRoots(liveSession.additionalRoots, nextRoots)) {
            liveSession.pendingAdditionalRoots = null;
            return;
        }

        liveSession.pendingAdditionalRoots = null;
        void this.#ensureRuntimeSession(
            {
                additionalRoots: nextRoots,
                projectId: liveSession.snapshot.projectId,
                runtimeId: liveSession.runtimeId,
                sessionId,
                title: liveSession.snapshot.title,
                worktreeId: liveSession.snapshot.worktreeId ?? null,
            },
            liveSession.ownerWindowId,
        ).catch(() => {
            const currentSession = this.#sessions.get(sessionId);
            if (!currentSession) {
                return;
            }

            currentSession.pendingAdditionalRoots = nextRoots;
        });
    }

    #resolveEffectiveAdditionalRoots(
        input: Pick<
            SessionDescriptor,
            "additionalRoots" | "projectId" | "worktreeId"
        >,
        projectRoot: string | null,
    ): readonly string[] {
        const mergedRoots = [
            ...(input.additionalRoots ?? []),
            ...this.#listProjectScopeRoots(input.projectId),
        ];

        if (!projectRoot) {
            return normalizeAdditionalRoots(mergedRoots);
        }

        const normalizedProjectRoot = path.resolve(projectRoot);
        return normalizeAdditionalRoots(
            mergedRoots.filter(
                (rootPath) =>
                    rootPath.trim().length > 0 &&
                    path.resolve(rootPath) !== normalizedProjectRoot,
            ),
        );
    }

    #listProjectScopeRoots(projectId: string | null): readonly string[] {
        if (!projectId) {
            return [];
        }

        return this.#projectService
            .listProjectWorktrees(projectId)
            .map((worktree) => worktree.rootPath);
    }

    #resolveProjectRootPathSafe(
        projectId: string,
        worktreeId: string | null,
    ): string | null {
        try {
            return this.#projectService.getProjectRootPath(
                projectId,
                worktreeId,
            );
        } catch (error) {
            debugBenignError(
                "ai.service.resolveProjectRootPathSafe",
                error,
            );
            return null;
        }
    }

    #persistAndBroadcast(liveSession: LiveAcpSession): void {
        if (shouldFlushLiveSessionImmediately(liveSession.snapshot)) {
            this.#flushLiveSessionPersistence(liveSession);
            return;
        }

        if (liveSession.pendingPersistTimer !== null) {
            return;
        }

        liveSession.pendingPersistTimer = setTimeout(() => {
            liveSession.pendingPersistTimer = null;
            this.#flushLiveSessionPersistence(liveSession);
        }, AI_SESSION_STREAMING_FLUSH_MS);
    }

    #flushLiveSessionPersistence(
        liveSession: LiveAcpSession,
        options: {
            readonly broadcast?: boolean;
        } = {},
    ): void {
        if (liveSession.pendingPersistTimer !== null) {
            clearTimeout(liveSession.pendingPersistTimer);
            liveSession.pendingPersistTimer = null;
        }

        this.#persistence.saveSessionSnapshot(liveSession.snapshot);
        if (options.broadcast !== false) {
            this.#onSessionSnapshot(
                liveSession.ownerWindowId,
                buildAiSessionUpdate(
                    liveSession.lastBroadcastSnapshot,
                    liveSession.snapshot,
                ),
            );
        }
        liveSession.lastBroadcastSnapshot = liveSession.snapshot;
    }

    #resolveDesiredSelections(
        runtimeId: AiRuntimeId,
        persistedSnapshot: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId"
        >,
    ): Pick<AiSessionSnapshot, "configOptions" | "modeId" | "modelId"> & {
        readonly preferredConfigOptions: Record<string, boolean | string>;
    } {
        const preferences =
            this.#persistence.loadRuntimeSelectionPreferences(runtimeId);

        return {
            configOptions: persistedSnapshot.configOptions,
            modeId: persistedSnapshot.modeId ?? preferences.modeId,
            modelId: persistedSnapshot.modelId ?? preferences.modelId,
            preferredConfigOptions: preferences.configOptions,
        };
    }

    #persistRuntimeSelectionPreference(
        runtimeId: AiRuntimeId,
        optionId: string,
        value: boolean | string,
    ): void {
        this.#persistence.saveRuntimeSelectionPreferenceOption(
            runtimeId,
            optionId,
            value,
        );
    }

    async #applyStoredSessionSelections(
        liveSession: LiveAcpSession,
        desiredSelections: Pick<
            AiSessionSnapshot,
            "configOptions" | "modeId" | "modelId"
        > & {
            readonly preferredConfigOptions?: Record<string, boolean | string>;
        },
    ): Promise<void> {
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
            await this.#setSessionConfigOptionOnLiveSession(
                liveSession,
                modeConfig.id,
                desiredModeId,
            );
        } else if (
            desiredModeId &&
            desiredModeId !== liveSession.snapshot.modeId &&
            liveSession.snapshot.modes.some((mode) => mode.id === desiredModeId)
        ) {
            await this.#setSessionModeOnLiveSession(liveSession, desiredModeId);
        }

        if (
            desiredModelId &&
            desiredModelId !== liveSession.snapshot.modelId &&
            modelConfig?.type === "select" &&
            hasSelectConfigValue(modelConfig, desiredModelId)
        ) {
            await this.#setSessionConfigOptionOnLiveSession(
                liveSession,
                modelConfig.id,
                desiredModelId,
            );
        } else if (
            desiredModelId &&
            desiredModelId !== liveSession.snapshot.modelId &&
            liveSession.snapshot.models.some(
                (model) => model.id === desiredModelId,
            )
        ) {
            await this.#setSessionModelOnLiveSession(
                liveSession,
                desiredModelId,
            );
        }

        const desiredConfigValues = new Map<string, boolean | string>();
        for (const desiredOption of desiredSelections.configOptions) {
            desiredConfigValues.set(desiredOption.id, desiredOption.value);
        }

        for (const [optionId, value] of Object.entries(
            desiredSelections.preferredConfigOptions ?? {},
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
                await this.#setSessionConfigOptionOnLiveSession(
                    liveSession,
                    optionId,
                    desiredValue,
                );
            }

            if (
                currentOption.type === "select" &&
                typeof desiredValue === "string" &&
                currentOption.value !== desiredValue &&
                hasSelectConfigValue(currentOption, desiredValue)
            ) {
                await this.#setSessionConfigOptionOnLiveSession(
                    liveSession,
                    optionId,
                    desiredValue,
                );
            }
        }
    }

    async #setSessionModeOnLiveSession(
        liveSession: LiveAcpSession,
        modeId: string,
    ): Promise<void> {
        await liveSession.connection.setSessionMode({
            modeId,
            sessionId: this.#requireRuntimeSessionId(liveSession),
        });

        liveSession.snapshot = setModeOnSnapshot(liveSession.snapshot, modeId);
        this.#persistAndBroadcast(liveSession);
    }

    async #setSessionModelOnLiveSession(
        liveSession: LiveAcpSession,
        modelId: string,
    ): Promise<void> {
        await liveSession.connection.unstable_setSessionModel({
            modelId,
            sessionId: this.#requireRuntimeSessionId(liveSession),
        });

        liveSession.snapshot = setModelOnSnapshot(
            liveSession.snapshot,
            modelId,
        );
        this.#persistAndBroadcast(liveSession);
    }

    async #setSessionConfigOptionOnLiveSession(
        liveSession: LiveAcpSession,
        optionId: string,
        value: boolean | string,
    ): Promise<void> {
        const response =
            typeof value === "boolean"
                ? await liveSession.connection.setSessionConfigOption({
                      configId: optionId,
                      sessionId: this.#requireRuntimeSessionId(liveSession),
                      type: "boolean",
                      value,
                  })
                : await liveSession.connection.setSessionConfigOption({
                      configId: optionId,
                      sessionId: this.#requireRuntimeSessionId(liveSession),
                      value,
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
        this.#persistAndBroadcast(liveSession);
    }

    async #updateSessionSnapshot(
        sessionId: string,
        mutate: (snapshot: AiSessionSnapshot) => AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        const liveSession = this.#sessions.get(sessionId);
        if (liveSession) {
            liveSession.snapshot = mutate(liveSession.snapshot);
            this.#persistAndBroadcast(liveSession);
            return liveSession.snapshot;
        }

        const snapshot = await this.#persistence.loadSessionSnapshot(sessionId);
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        const nextSnapshot = mutate(snapshot);
        this.#persistence.saveSessionSnapshot(nextSnapshot);
        this.#onSessionSnapshot("", {
            kind: "snapshot",
            snapshot: nextSnapshot,
        });
        return nextSnapshot;
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
        this.#invalidateRuntimeAuthIfNeeded(liveSession.runtimeId, lastError);
        liveSession.snapshot = finalizeStreamingMessages({
            ...liveSession.snapshot,
            lastError,
            pendingPermission: null,
            pendingUserInput: null,
            status: "error",
            updatedAt: new Date().toISOString(),
        });
        this.#persistAndBroadcast(liveSession);
        this.#resolvePendingPermission(liveSession, null);
    }

    #disposeLiveSession(sessionId: string, liveSession: LiveAcpSession): void {
        this.#sessions.delete(sessionId);
        liveSession.closing = true;
        this.#flushLiveSessionPersistence(liveSession, {
            broadcast: false,
        });
        this.#resolvePendingPermission(liveSession, null);
        this.#detachChildStreams(liveSession);
        liveSession.child.kill();
        liveSession.child.stdin?.destroy();
        liveSession.child.stdout?.destroy();
        liveSession.child.stderr?.destroy();
        liveSession.terminalOutputBuffers.clear();
    }

    #detachChildStreams(liveSession: LiveAcpSession): void {
        const handler = liveSession.stderrHandler;
        if (handler) {
            liveSession.child.stderr?.off("data", handler);
            liveSession.stderrHandler = null;
        }
    }

    #resolveRuntimeStatus(runtimeId: AiRuntimeId): AiRuntimeStatus {
        if (runtimeId === "claude") {
            return getClaudeRuntimeStatus(
                this.#settingsService.loadClaudeRuntimeSettings(),
                this.#secretStore,
            );
        }

        if (runtimeId === "gemini") {
            return getGeminiRuntimeStatus(
                this.#settingsService.loadGeminiRuntimeSettings(),
                this.#secretStore,
            );
        }

        if (runtimeId === "kilo") {
            return getKiloRuntimeStatus(
                this.#settingsService.loadKiloRuntimeSettings(),
            );
        }

        return getCodexRuntimeStatus(
            this.#settingsService.loadCodexRuntimeSettings(),
            loadCodexSecretBundle(this.#secretStore),
        );
    }

    #withPersistedRuntimeCatalog(status: AiRuntimeStatus): AiRuntimeStatus {
        const catalog = this.#persistence.loadLatestRuntimeCatalog(
            status.runtimeId,
        );

        if (!catalog) {
            return status;
        }

        return {
            ...status,
            availableCommands: catalog.availableCommands,
            configOptions: catalog.configOptions,
            modeId: catalog.modeId,
            modes: catalog.modes,
            modelId: catalog.modelId,
            models: catalog.models,
        };
    }

    #resolveRuntimeCommand(
        runtimeId: AiRuntimeId,
        codexSettingsOverride?: CodexRuntimeSettings,
    ): ResolvedAcpRuntime {
        if (runtimeId === "claude") {
            const settings = this.#settingsService.loadClaudeRuntimeSettings();
            const resolved = resolveClaudeRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                command: resolved.command,
                env: applyClaudeAuthEnv(
                    process.env,
                    settings,
                    this.#secretStore,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        if (runtimeId === "gemini") {
            const settings = this.#settingsService.loadGeminiRuntimeSettings();
            const resolved = resolveGeminiRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                command: resolved.command,
                env: buildRuntimeSpawnEnv(
                    applyGeminiAuthEnv(
                        process.env,
                        settings,
                        this.#secretStore,
                    ),
                    resolved.program,
                ),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        if (runtimeId === "kilo") {
            const settings = this.#settingsService.loadKiloRuntimeSettings();
            const resolved = resolveKiloRuntime(settings);

            return {
                args: resolved.args,
                command: resolved.command,
                env: buildRuntimeSpawnEnv(process.env, resolved.program),
                executable: resolved.program,
                status: resolved.status,
            };
        }

        const settings =
            codexSettingsOverride ??
            this.#settingsService.loadCodexRuntimeSettings();
        const secrets = loadCodexSecretBundle(this.#secretStore);
        const resolved = resolveCodexRuntime(settings);

        return {
            args: resolved.args,
            command: resolved.command,
            env: applyCodexAuthEnv(process.env, settings, secrets),
            executable: resolved.executable,
            status: getCodexRuntimeStatus(settings, secrets),
        };
    }

    async #runRuntimeAuthConnection(
        runtimeId: AiRuntimeId,
        cwd: string,
        action: (connection: ClientSideConnection) => Promise<void>,
        codexSettingsOverride?: CodexRuntimeSettings,
    ): Promise<void> {
        const resolvedRuntime = this.#resolveRuntimeCommand(
            runtimeId,
            codexSettingsOverride,
        );
        if (resolvedRuntime.status.state !== "ready") {
            throw new Error(
                resolvedRuntime.status.message ??
                    `${getRuntimeDisplayName(runtimeId)} is not available on this machine.`,
            );
        }

        const child = spawn(
            resolvedRuntime.executable,
            [...resolvedRuntime.args],
            {
                cwd,
                env: resolvedRuntime.env,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        const stderrChunks: string[] = [];
        const stderrHandler = (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            stderrChunks.push(text);
            if (stderrChunks.length > 20) {
                stderrChunks.shift();
            }
        };
        child.stderr.on("data", stderrHandler);

        const client: Client = {
            readTextFile: () => {
                throw new Error("Runtime auth does not support file reads.");
            },
            requestPermission: () => {
                throw new Error(
                    "Runtime auth does not support permission requests.",
                );
            },
            sessionUpdate: () => Promise.resolve(undefined),
            writeTextFile: () => {
                throw new Error("Runtime auth does not support file writes.");
            },
        };
        const stream = ndJsonStream(
            toWebByteWritable(child.stdin),
            toWebByteReadable(child.stdout),
        );
        const connection = new ClientSideConnection(() => client, stream);

        try {
            await action(connection);
        } catch (error) {
            const stderrText = getRecentStderrText(stderrChunks);

            if (error instanceof Error && error.message.trim()) {
                throw error;
            }

            throw new Error(
                stderrText ||
                    `Failed to complete ${getRuntimeDisplayName(runtimeId)} authentication.`,
                {
                    cause: error,
                },
            );
        } finally {
            child.stderr?.off("data", stderrHandler);
            child.kill();
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
        }
    }

    #invalidateRuntimeAuthIfNeeded(
        runtimeId: AiRuntimeId,
        message: string,
    ): void {
        if (runtimeId === "codex" && isCodexAuthenticationError(message)) {
            const currentSettings =
                this.#settingsService.loadCodexRuntimeSettings();
            const nextSettings = {
                ...currentSettings,
                authMethod: null,
            } satisfies CodexRuntimeSettings;
            this.#settingsService.saveCodexRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getCodexRuntimeStatus(
                    nextSettings,
                    loadCodexSecretBundle(this.#secretStore),
                ),
            );
            return;
        }

        if (runtimeId === "claude" && isClaudeAuthenticationError(message)) {
            const nextSettings = markClaudeAuthInvalidated(
                this.#settingsService.loadClaudeRuntimeSettings(),
            );
            this.#settingsService.saveClaudeRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (runtimeId === "gemini" && isGeminiAuthenticationError(message)) {
            const nextSettings = markGeminiAuthInvalidated(
                this.#settingsService.loadGeminiRuntimeSettings(),
            );
            this.#settingsService.saveGeminiRuntimeSettings(nextSettings);
            this.#onRuntimeStatus(
                getGeminiRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (runtimeId !== "kilo" || !isKiloAuthenticationError(message)) {
            return;
        }

        const nextSettings = markKiloAuthInvalidated(
            this.#settingsService.loadKiloRuntimeSettings(),
        );
        this.#settingsService.saveKiloRuntimeSettings(nextSettings);
        this.#onRuntimeStatus(getKiloRuntimeStatus(nextSettings));
    }
}

function normalizeOptionalText(value: string | null): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function applySecretValuePatch(
    currentValue: string | null,
    patch: SecretValuePatch,
): string | null {
    if (patch.kind === "clear") {
        return null;
    }

    if (patch.kind === "set") {
        return normalizeOptionalText(patch.value);
    }

    return currentValue;
}

function resolveCodexSecretBundle(
    currentSecrets: CodexSecretBundle,
    settings: CodexRuntimeSettingsInput,
): CodexSecretBundle {
    let codexApiKey = applySecretValuePatch(
        currentSecrets.codexApiKey,
        settings.codexApiKey,
    );
    let openaiApiKey = applySecretValuePatch(
        currentSecrets.openaiApiKey,
        settings.openaiApiKey,
    );

    if (settings.authMethod === "codex-api-key") {
        openaiApiKey = null;
    } else if (settings.authMethod === "openai-api-key") {
        codexApiKey = null;
    } else {
        codexApiKey = null;
        openaiApiKey = null;
    }

    return {
        codexApiKey,
        openaiApiKey,
    };
}

export const __testing = {
    computeDiffHunks,
    diffToAiFileDiff,
    mapToolCallUpdate,
    normalizeTrackedDiffPath,
    resolveDiffToFullTexts,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
