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
    type LoadSessionResponse,
    type NewSessionResponse,
    type ReadTextFileRequest,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionConfigOption,
    type SessionModeState,
    type SessionModelState,
    type SessionNotification,
    type ToolCall,
    type ToolCallContent,
    type ToolCallUpdate,
    type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
    AiFileDiff,
    AiHistorySessionSummary,
    AiImageAttachment,
    AiPermissionRequest,
    AiPermissionResponseInput,
    AiPromptResult,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOption,
    AiSessionConfigOptionMutationInput,
    AiSessionMode,
    AiSessionModeMutationInput,
    AiSessionModel,
    AiSessionModelMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
    AiTrackedFile,
    AiTrackedFileHunkMutationInput,
    AiTrackedFileMutationInput,
    AiUserInputRequest,
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

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type { SecretStoreGateway } from "@main/ai/secret-store";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
} from "./persistence";
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
    launchClaudeLogin,
    loadClaudeSecretBundle,
    markClaudeAuthInvalidated,
    resolveClaudeRuntime,
    saveClaudeSecrets,
} from "./claude/setup";
import {
    applyGeminiAuthEnv,
    getGeminiRuntimeStatus,
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

const NEVERWRITE_DIFF_PREVIOUS_PATH_KEY = "neverwritePreviousPath";
const NEVERWRITE_STATUS_EVENT_TYPE_KEY = "neverwriteEventType";
const NEVERWRITE_STATUS_EVENT_TYPE = "status";
const NEVERWRITE_STATUS_EVENT_ID_PREFIX = "neverwrite:status:";
const NEVERWRITE_STATUS_TURN_EVENT_ID_PREFIX = "neverwrite:status:turn:";
const NEVERWRITE_USER_INPUT_EVENT_TYPE = "user_input_request";
const NEVERWRITE_USER_INPUT_RESPONSE_PREFIX =
    "__neverwrite_user_input_response__:";
const SUPPRESSED_NEVERWRITE_STATUS_TITLES = new Set([
    "Preparing input",
    "Drafting response",
]);

function toWebByteWritable(stream: Writable): WritableStream<Uint8Array> {
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function toWebByteReadable(stream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

interface AiServiceOptions {
    readonly projectService: ProjectService;
    readonly settingsService: SettingsGateway;
    readonly secretStore: SecretStoreGateway;
    readonly onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly persistence: AiPersistenceGateway;
}

interface LiveAcpSession {
    additionalRoots: readonly string[];
    child: ChildProcessWithoutNullStreams;
    closing: boolean;
    connection: ClientSideConnection;
    cwd: string;
    isRestoring: boolean;
    ownerWindowId: string;
    pendingPermission: {
        readonly requestId: string;
        readonly resolve: (response: RequestPermissionResponse) => void;
    } | null;
    pendingAdditionalRoots: readonly string[] | null;
    pendingPersistTimer: ReturnType<typeof setTimeout> | null;
    projectRoot: string | null;
    runtimeId: AiRuntimeId;
    snapshot: AiSessionSnapshot;
    lastBroadcastSnapshot: AiSessionSnapshot | null;
    stderrChunks: string[];
}

interface ResolvedAcpRuntime {
    readonly args: readonly string[];
    readonly command: string;
    readonly env: NodeJS.ProcessEnv;
    readonly executable: string;
    readonly status: AiRuntimeStatus;
}

type AcpSessionCatalogPayload = Pick<
    LoadSessionResponse | NewSessionResponse,
    "configOptions" | "models" | "modes"
>;

interface OpenRuntimeSessionResult extends AcpSessionCatalogPayload {
    readonly runtimeSessionId: string;
}

type SessionDescriptor = Pick<
    PrepareAiSessionInput,
    "projectId" | "runtimeId" | "sessionId" | "title" | "worktreeId"
> & {
    readonly additionalRoots?: readonly string[];
};

const AI_SESSION_STREAMING_FLUSH_MS = 120;

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
            .map(([sessionId, liveSession]) =>
                this.#refreshLiveSessionScopes(sessionId, liveSession),
            );

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
            title: input.title,
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
        } catch {
            // El proceso igual se cierra abajo.
        }

        liveSession.child.kill();
        this.#sessions.delete(sessionId);
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (this.#sessions.has(sessionId)) {
            try {
                await this.cancelSession(sessionId);
            } catch {
                // Closing and deleting the local session state is still safe.
            }

            await this.closeSession(sessionId);
        }

        this.#persistence.deleteSession(sessionId);
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
            projectRoot,
            runtimeId: input.runtimeId,
            snapshot: {
                ...persistedSnapshot,
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                status: getPreparedSessionStatus(persistedSnapshot),
                title: input.title,
                updatedAt: new Date().toISOString(),
                worktreeId: input.worktreeId ?? null,
            },
            stderrChunks: [],
        } satisfies LiveAcpSession);

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
            } catch {
                // If the session cannot be resumed, start a new one.
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
                    now,
                );
                break;
            case "tool_call_update":
                nextSnapshot = mapToolCallUpdate(
                    liveSession,
                    nextSnapshot,
                    update,
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
            projectRoot:
                snapshot.projectId !== null
                    ? this.#projectService.getProjectRootPath(
                          snapshot.projectId,
                          snapshot.worktreeId ?? null,
                      )
                    : null,
            runtimeId: snapshot.runtimeId,
            snapshot,
            stderrChunks: [],
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
        } catch {
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
        liveSession.child.kill();
        terminalOutputBuffers.clear();
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
                env: applyGeminiAuthEnv(
                    process.env,
                    settings,
                    this.#secretStore,
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
                env: process.env,
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
        child.stderr.on("data", (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");
            stderrChunks.push(text);
            if (stderrChunks.length > 20) {
                stderrChunks.shift();
            }
        });

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
            );
        } finally {
            child.kill();
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

function shouldFlushLiveSessionImmediately(
    snapshot: AiSessionSnapshot,
): boolean {
    return (
        snapshot.status !== "streaming" ||
        snapshot.pendingPermission !== null ||
        snapshot.pendingUserInput !== null ||
        snapshot.lastError !== null
    );
}

function buildAiSessionUpdate(
    previousSnapshot: AiSessionSnapshot | null,
    nextSnapshot: AiSessionSnapshot,
): AiSessionUpdate {
    if (!previousSnapshot) {
        return {
            kind: "snapshot",
            snapshot: nextSnapshot,
        };
    }

    const changes = createAiSessionPatchChanges(previousSnapshot, nextSnapshot);

    if (Object.keys(changes).length === 0) {
        return {
            kind: "snapshot",
            snapshot: nextSnapshot,
        };
    }

    return {
        kind: "patch",
        patch: {
            changes,
            runtimeId: nextSnapshot.runtimeId,
            sessionId: nextSnapshot.sessionId,
        },
    };
}

function createAiSessionPatchChanges(
    previousSnapshot: AiSessionSnapshot,
    nextSnapshot: AiSessionSnapshot,
): Partial<Omit<AiSessionSnapshot, "runtimeId" | "sessionId">> {
    const changes: Record<string, unknown> = {};

    const patchableKeys = [
        "availableCommands",
        "configOptions",
        "lastError",
        "messages",
        "modeId",
        "modes",
        "modelId",
        "models",
        "pendingPermission",
        "pendingUserInput",
        "plan",
        "projectId",
        "runtimeSessionId",
        "status",
        "title",
        "toolActivity",
        "trackedFiles",
        "updatedAt",
        "worktreeId",
    ] satisfies readonly (keyof Omit<
        AiSessionSnapshot,
        "runtimeId" | "sessionId"
    >)[];

    for (const key of patchableKeys) {
        if (previousSnapshot[key] !== nextSnapshot[key]) {
            changes[key] = nextSnapshot[key];
        }
    }

    return changes as Partial<
        Omit<AiSessionSnapshot, "runtimeId" | "sessionId">
    >;
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

function getRuntimeDisplayName(runtimeId: AiRuntimeId): string {
    switch (runtimeId) {
        case "claude":
            return "Claude";
        case "gemini":
            return "Gemini";
        case "kilo":
            return "Kilo";
        case "codex":
        default:
            return "Codex";
    }
}

function applySessionCatalogToSnapshot(
    snapshot: AiSessionSnapshot,
    payload: AcpSessionCatalogPayload,
): AiSessionSnapshot {
    const configOptions =
        payload.configOptions !== undefined
            ? mapSessionConfigOptions(payload.configOptions)
            : snapshot.configOptions;
    const modes =
        payload.modes !== undefined
            ? mapSessionModes(payload.modes, configOptions)
            : snapshot.modes.length > 0
              ? snapshot.modes
              : buildModesFromConfigOptions(configOptions);
    const models =
        payload.models !== undefined
            ? mapSessionModels(payload.models, configOptions)
            : snapshot.models.length > 0
              ? snapshot.models
              : buildModelsFromConfigOptions(configOptions);
    const modeId =
        payload.modes !== undefined || payload.configOptions !== undefined
            ? deriveModeId(payload.modes, configOptions, snapshot.modeId)
            : snapshot.modeId;
    const modelId =
        payload.models !== undefined || payload.configOptions !== undefined
            ? deriveModelId(payload.models, configOptions, snapshot.modelId)
            : snapshot.modelId;

    return {
        ...snapshot,
        configOptions,
        modeId,
        modes,
        modelId,
        models,
    };
}

function mapSessionModes(
    state: SessionModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionMode[] {
    if (state?.availableModes?.length) {
        return state.availableModes.map((mode) => ({
            description: mode.description ?? null,
            id: mode.id,
            name: mode.name,
        }));
    }

    return buildModesFromConfigOptions(configOptions);
}

function mapSessionModels(
    state: SessionModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionModel[] {
    if (state?.availableModels?.length) {
        return state.availableModels.map((model) => ({
            description: model.description ?? null,
            id: model.modelId,
            name: model.name,
        }));
    }

    return buildModelsFromConfigOptions(configOptions);
}

function mapSessionConfigOptions(
    options: readonly SessionConfigOption[] | null | undefined,
): readonly AiSessionConfigOption[] {
    if (!options?.length) {
        return [];
    }

    return options.map((option) =>
        option.type === "boolean"
            ? {
                  category: mapConfigOptionCategory(option.category),
                  description: option.description ?? null,
                  id: option.id,
                  label: option.name,
                  type: "boolean",
                  value: option.currentValue,
              }
            : {
                  category: mapConfigOptionCategory(option.category),
                  description: option.description ?? null,
                  id: option.id,
                  label: option.name,
                  options: mapSessionSelectOptions(option),
                  type: "select",
                  value: option.currentValue,
              },
    );
}

function mapSessionSelectOptions(
    option: Extract<SessionConfigOption, { type: "select" }>,
): readonly {
    description: string | null;
    groupLabel: string | null;
    label: string;
    value: string;
}[] {
    const items: {
        description: string | null;
        groupLabel: string | null;
        label: string;
        value: string;
    }[] = [];

    for (const entry of option.options) {
        if ("group" in entry) {
            for (const childOption of entry.options) {
                items.push({
                    description: childOption.description ?? null,
                    groupLabel: entry.name,
                    label: childOption.name,
                    value: childOption.value,
                });
            }
            continue;
        }

        items.push({
            description: entry.description ?? null,
            groupLabel: null,
            label: entry.name,
            value: entry.value,
        });
    }

    return items;
}

function mapConfigOptionCategory(
    category: string | null | undefined,
): AiSessionConfigOption["category"] {
    if (category === "mode" || category === "model") {
        return category;
    }

    if (category === "thought_level") {
        return "reasoning";
    }

    return "other";
}

function deriveModeId(
    state: SessionModeState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    const modeConfig = getModeConfigOption(configOptions);
    if (modeConfig?.type === "select" && modeConfig.value.trim()) {
        return modeConfig.value;
    }

    if (state?.currentModeId?.trim()) {
        return state.currentModeId;
    }

    return fallback;
}

function deriveModelId(
    state: SessionModelState | null | undefined,
    configOptions: readonly AiSessionConfigOption[],
    fallback: string | null,
): string | null {
    const modelConfig = getModelConfigOption(configOptions);
    if (modelConfig?.type === "select" && modelConfig.value.trim()) {
        return modelConfig.value;
    }

    if (state?.currentModelId?.trim()) {
        return state.currentModelId;
    }

    return fallback;
}

function buildModesFromConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionMode[] {
    const modeConfig = getModeConfigOption(configOptions);
    if (!modeConfig || modeConfig.type !== "select") {
        return [];
    }

    return modeConfig.options.map((option) => ({
        description: option.description,
        id: option.value,
        name: option.label,
    }));
}

function buildModelsFromConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
): readonly AiSessionModel[] {
    const modelConfig = getModelConfigOption(configOptions);
    if (!modelConfig || modelConfig.type !== "select") {
        return [];
    }

    return modelConfig.options.map((option) => ({
        description: option.description,
        id: option.value,
        name: option.label,
    }));
}

function getModeConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "mode" ||
                option.id.toLowerCase() === "mode",
        ) ?? null
    );
}

function getModelConfigOption(
    configOptions: readonly AiSessionConfigOption[],
): AiSessionConfigOption | null {
    return (
        configOptions.find(
            (option) =>
                option.category === "model" ||
                option.id.toLowerCase() === "model",
        ) ?? null
    );
}

function hasSelectConfigValue(
    option: AiSessionConfigOption,
    value: string,
): boolean {
    return (
        option.type === "select" &&
        option.options.some((candidate) => candidate.value === value)
    );
}

function setModeOnSnapshot(
    snapshot: AiSessionSnapshot,
    modeId: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "mode" ||
                option.id.toLowerCase() === "mode") &&
            hasSelectConfigValue(option, modeId)
                ? {
                      ...option,
                      value: modeId,
                  }
                : option,
        ),
        modeId,
        updatedAt,
    };
}

function setModelOnSnapshot(
    snapshot: AiSessionSnapshot,
    modelId: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        configOptions: snapshot.configOptions.map((option) =>
            option.type === "select" &&
            (option.category === "model" ||
                option.id.toLowerCase() === "model") &&
            hasSelectConfigValue(option, modelId)
                ? {
                      ...option,
                      value: modelId,
                  }
                : option,
        ),
        modelId,
        updatedAt,
    };
}

function setTitleOnSnapshot(
    snapshot: AiSessionSnapshot,
    title: string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    return {
        ...snapshot,
        title,
        updatedAt,
    };
}

function setConfigOptionOnSnapshot(
    snapshot: AiSessionSnapshot,
    optionId: string,
    value: boolean | string,
    updatedAt: string = new Date().toISOString(),
): AiSessionSnapshot {
    const nextConfigOptions = snapshot.configOptions.map((option) =>
        option.id !== optionId
            ? option
            : option.type === "boolean" && typeof value === "boolean"
              ? {
                    ...option,
                    value,
                }
              : option.type === "select" &&
                  typeof value === "string" &&
                  hasSelectConfigValue(option, value)
                ? {
                      ...option,
                      value,
                  }
                : option,
    );
    const updatedOption =
        nextConfigOptions.find((option) => option.id === optionId) ?? null;

    return {
        ...snapshot,
        configOptions: nextConfigOptions,
        modeId:
            updatedOption?.type === "select" &&
            updatedOption.category === "mode" &&
            typeof value === "string"
                ? value
                : snapshot.modeId,
        modelId:
            updatedOption?.type === "select" &&
            updatedOption.category === "model" &&
            typeof value === "string"
                ? value
                : snapshot.modelId,
        updatedAt,
    };
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
                attachments: [],
                content,
                createdAt: new Date().toISOString(),
                id: messageId ?? randomUUID(),
                kind,
                status: "streaming",
            },
        ],
    };
}

function appendContentBlockToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    content: ContentBlock,
    messageId: string | null,
): AiSessionSnapshot {
    if (content.type === "image") {
        return appendAttachmentToSnapshot(
            snapshot,
            kind,
            imageContentToAttachment(content, messageId),
            messageId,
        );
    }

    return appendChunkToSnapshot(
        snapshot,
        kind,
        formatContentBlock(content),
        messageId,
    );
}

function appendAttachmentToSnapshot(
    snapshot: AiSessionSnapshot,
    kind: "assistant" | "thinking",
    attachment: AiImageAttachment,
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
            attachments: [...lastMessage.attachments, attachment],
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
                attachments: [attachment],
                content: "",
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

const TERMINAL_OUTPUT_MAX_LENGTH = 10_000;
const terminalOutputBuffers = new Map<string, string>();

function mapToolCallUpdate(
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    snapshot: AiSessionSnapshot,
    update: ToolCall | ToolCallUpdate,
    updatedAt: string,
): AiSessionSnapshot {
    const existing =
        snapshot.toolActivity.find(
            (candidate) => candidate.id === update.toolCallId,
        ) ?? null;
    const nextTitle =
        typeof update.title === "string" && update.title.trim().length > 0
            ? update.title.trim()
            : (existing?.title ?? null);

    if (shouldSuppressToolActivityUpdate(update, nextTitle)) {
        return snapshot;
    }

    const toolKind = update.kind ?? existing?.kind ?? "unknown";
    const content = update.content ?? null;
    const pendingUserInput = parseUserInputRequest(snapshot, update, updatedAt);

    let exitCode: number | null = existing?.exitCode ?? null;
    let terminalOutput: string | null = existing?.terminalOutput ?? null;

    if (isRecord(update._meta)) {
        if (isRecord(update._meta.terminal_output)) {
            const data = (update._meta.terminal_output as { data: string })
                .data;
            if (typeof data === "string") {
                const terminalId = (
                    update._meta.terminal_output as { terminal_id: string }
                ).terminal_id;
                const prev = terminalOutputBuffers.get(terminalId) ?? "";
                let next = prev + data;
                if (next.length > TERMINAL_OUTPUT_MAX_LENGTH) {
                    next = next.slice(-TERMINAL_OUTPUT_MAX_LENGTH);
                }
                terminalOutputBuffers.set(terminalId, next);
                terminalOutput = next;
            }
        }

        if (isRecord(update._meta.terminal_exit)) {
            const termExit = update._meta.terminal_exit as {
                terminal_id: string;
                exit_code: number;
                signal: string | null;
            };
            if (typeof termExit.exit_code === "number") {
                exitCode = termExit.exit_code;
            }
            const finalOutput = terminalOutputBuffers.get(termExit.terminal_id);
            if (finalOutput !== undefined) {
                terminalOutput = finalOutput;
                terminalOutputBuffers.delete(termExit.terminal_id);
            }
        }
    }

    const normalizeDiffPath = (candidatePath: string) =>
        normalizeTrackedDiffPath(liveSession, candidatePath);
    const nextActivity = {
        createdAt: existing?.createdAt ?? updatedAt,
        diffs: content
            ? collectDiffs(content, toolKind, normalizeDiffPath)
            : (existing?.diffs ?? []),
        exitCode,
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
                nextTitle ?? "Tool call",
                content,
                toolKind,
                update.rawInput,
                update.rawOutput,
            ) ??
            existing?.summary ??
            null,
        terminalOutput,
        title: nextTitle ?? "Tool call",
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
                                    normalizeDiffPath,
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
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): readonly AiFileDiff[] {
    return (content ?? []).flatMap((entry) =>
        entry.type === "diff"
            ? [diffToAiFileDiff(entry, toolKind, normalizePath)]
            : [],
    );
}

function shouldSuppressToolActivityUpdate(
    update: Pick<ToolCall | ToolCallUpdate, "_meta" | "toolCallId">,
    title: string | null,
): boolean {
    if (!title || !SUPPRESSED_NEVERWRITE_STATUS_TITLES.has(title)) {
        return false;
    }

    // codex-acp tags the initial tool_call with meta.neverwriteEventType =
    // "status", but the follow-up tool_call_update that completes the item
    // is emitted without meta (see vendor/codex-acp/src/thread.rs ~1030,
    // send_status_tool_call_update). Without a second signal the completion
    // update slipped through, recreating the suppressed "Drafting response"
    // activity after the agent's turn ended. The toolCallId prefix is
    // stable across both events, so we use it as the authoritative marker.
    // `turn:` ids are kept because the UI renders them as a timeline
    // divider (see ToolActivityItem.isTurnStartedActivity).
    if (
        update.toolCallId.startsWith(NEVERWRITE_STATUS_EVENT_ID_PREFIX) &&
        !update.toolCallId.startsWith(NEVERWRITE_STATUS_TURN_EVENT_ID_PREFIX)
    ) {
        return true;
    }

    if (
        isRecord(update._meta) &&
        update._meta[NEVERWRITE_STATUS_EVENT_TYPE_KEY] ===
            NEVERWRITE_STATUS_EVENT_TYPE
    ) {
        return true;
    }

    return false;
}

function diffToAiFileDiff(
    diff: Diff,
    toolKind: string,
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): AiFileDiff {
    const previousPathValue = readDiffMetaString(
        diff._meta,
        NEVERWRITE_DIFF_PREVIOUS_PATH_KEY,
    );
    const path = normalizePath(diff.path);
    const previousPath = previousPathValue
        ? normalizePath(previousPathValue)
        : null;
    const kind = inferDiffKind(diff, toolKind, previousPath);
    const oldText = normalizeOldText(diff.oldText ?? null);
    const newText = normalizeNewText(kind, diff.newText ?? null);

    return {
        hunks: computeTextDiffHunks(path, oldText, newText),
        isText: true,
        kind,
        newText,
        oldText,
        path,
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
    normalizePath: (candidatePath: string) => string = (candidatePath) =>
        candidatePath,
): AiTrackedFile {
    const fileDiff = diffToAiFileDiff(diff, toolKind, normalizePath);

    return syncTrackedFile({
        identityKey: fileDiff.previousPath
            ? `${fileDiff.previousPath}->${fileDiff.path}`
            : fileDiff.path,
        currentText: fileDiff.newText ?? "",
        diffBase: fileDiff.oldText ?? "",
        hunks: fileDiff.hunks,
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
        version: 1,
    });
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
        (diff.oldText !== null &&
            diff.oldText !== undefined &&
            diff.newText == null)
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

function computeTextDiffHunks(
    path: string,
    oldText: string | null,
    newText: string | null,
) {
    if (oldText === null && newText === null) {
        return [];
    }

    return computeDiffHunks(oldText ?? "", newText ?? "", path);
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

function readDiffMetaString(meta: unknown, key: string): string | null {
    if (!isRecord(meta)) {
        return null;
    }

    const value = meta[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    kind: string,
    rawInput: unknown,
    rawOutput: unknown,
): string | null {
    const diffCount = (content ?? []).filter(
        (entry) => entry.type === "diff",
    ).length;

    if (diffCount > 0) {
        return `${title} · ${diffCount} diff${diffCount === 1 ? "" : "s"}`;
    }

    const terminalCount = (content ?? []).filter(
        (entry) => entry.type === "terminal",
    ).length;
    if (terminalCount > 0) {
        return `${title} · terminal session`;
    }

    const lk = kind.toLowerCase();
    const input =
        rawInput && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>)
            : null;

    if (lk === "bash" || lk === "shell" || lk === "execute") {
        const cmd = input?.command;
        if (typeof cmd === "string") {
            const firstLine = cmd.split("\n")[0];
            const preview =
                firstLine.length > 80
                    ? firstLine.slice(0, 77) + "…"
                    : firstLine;
            return preview;
        }
    }

    if (lk === "read") {
        const filePath = input?.file_path ?? input?.path;
        if (typeof filePath === "string") {
            const segments = filePath.split("/");
            return segments.length > 2
                ? `…/${segments.slice(-2).join("/")}`
                : filePath;
        }
    }

    if (lk === "search" || lk === "grep") {
        const pattern = input?.pattern ?? input?.query ?? input?.regex;
        if (typeof pattern === "string") {
            return `"${pattern}"`;
        }
    }

    if (lk === "web_fetch" || lk === "fetch") {
        const url = input?.url;
        if (typeof url === "string") {
            try {
                const parsed = new URL(url);
                return parsed.hostname + parsed.pathname;
            } catch {
                return url.length > 60 ? url.slice(0, 57) + "…" : url;
            }
        }
    }

    if (rawOutput !== undefined && rawOutput !== null) {
        const outputStr =
            typeof rawOutput === "string"
                ? rawOutput
                : JSON.stringify(rawOutput);
        if (outputStr.length > 0 && outputStr.length <= 100) {
            return outputStr;
        }
        if (outputStr.length > 100) {
            const lines = outputStr.split("\n").length;
            return `${lines} line${lines === 1 ? "" : "s"} of output`;
        }
    }

    return null;
}

function formatContentBlock(content: ContentBlock): string {
    if (content.type === "text") {
        return content.text;
    }

    if (content.type === "image") {
        return content.uri ?? "";
    }

    if (content.type === "resource_link") {
        return content.uri;
    }

    return `[${content.type}]`;
}

const PILL_OPEN = "\u200B\u00AB";
const PILL_CLOSE = "\u00BB\u200B";

function serializeComposerPartsForDisplay(
    parts: SendAiPromptInput["composerParts"] | undefined,
    fallback: string,
): string {
    if (!parts || parts.length === 0) {
        return fallback;
    }

    return parts
        .map((part) => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file_mention":
                    return `${PILL_OPEN}@${part.label}${PILL_CLOSE}`;
                case "folder_mention":
                    return `${PILL_OPEN}@${part.label}${PILL_CLOSE}`;
                case "fetch_mention":
                    return `${PILL_OPEN}@fetch${PILL_CLOSE}`;
                case "plan_mention":
                    return `${PILL_OPEN}/plan${PILL_CLOSE}`;
                case "selection_mention":
                    return `${PILL_OPEN}${part.label}${PILL_CLOSE}`;
                case "file_attachment":
                    return `${PILL_OPEN}📎${part.label}${PILL_CLOSE}`;
                default:
                    return "";
            }
        })
        .join("")
        .trim();
}

function imageContentToAttachment(
    content: Extract<ContentBlock, { type: "image" }>,
    messageId: string | null,
): AiImageAttachment {
    return {
        dataBase64: content.data,
        id: messageId ? `${messageId}:image:${randomUUID()}` : randomUUID(),
        mimeType: content.mimeType,
        name: null,
        sizeBytes: estimateBase64Size(content.data),
    };
}

function buildPromptContentBlocks(
    promptText: string,
    attachments: readonly AiImageAttachment[],
): ContentBlock[] {
    const prompt: ContentBlock[] = [];

    if (promptText) {
        prompt.push({
            text: promptText,
            type: "text",
        });
    }

    for (const attachment of attachments) {
        prompt.push({
            data: attachment.dataBase64,
            mimeType: attachment.mimeType,
            type: "image",
        });
    }

    return prompt;
}

function estimateBase64Size(dataBase64: string): number {
    const padding = dataBase64.endsWith("==")
        ? 2
        : dataBase64.endsWith("=")
          ? 1
          : 0;

    return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

function getPreparedSessionStatus(
    snapshot: Pick<
        AiSessionSnapshot,
        "lastError" | "pendingPermission" | "pendingUserInput"
    >,
): AiSessionSnapshot["status"] {
    if (snapshot.pendingPermission) {
        return "waiting_permission";
    }
    if (snapshot.pendingUserInput) {
        return "waiting_user_input";
    }
    if (snapshot.lastError) {
        return "error";
    }
    return "idle";
}

function getRecentStderrText(stderrChunks: readonly string[]): string {
    const normalized = stripAnsiControlSequences(stderrChunks.join(""))
        .trim()
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

    if (normalized.length === 0) {
        return "";
    }

    return normalized.slice(-4).join("\n");
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsiControlSequences(value: string): string {
    return value.replace(ANSI_ESCAPE_RE, "");
}

function isBusyAiSessionStatus(status: AiSessionSnapshot["status"]): boolean {
    return (
        status === "starting" ||
        status === "streaming" ||
        status === "waiting_permission" ||
        status === "waiting_user_input"
    );
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

function normalizeAdditionalRoots(
    roots: readonly string[] | undefined,
): string[] {
    if (!roots || roots.length === 0) {
        return [];
    }

    const seen = new Set<string>();
    const normalizedRoots: string[] = [];

    for (const rootPath of roots) {
        if (!rootPath?.trim()) {
            continue;
        }

        const normalized = path.resolve(rootPath);
        if (seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        normalizedRoots.push(normalized);
    }

    normalizedRoots.sort((left, right) => left.localeCompare(right));
    return normalizedRoots;
}

function sameAdditionalRoots(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((entry, index) => entry === right[index]);
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedRoot = path.resolve(rootPath);

    return (
        resolvedCandidate === resolvedRoot ||
        resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
    );
}

function toPosixPath(candidatePath: string): string {
    return candidatePath.split(path.sep).join("/");
}

function normalizeTrackedDiffPath(
    liveSession: Pick<LiveAcpSession, "cwd" | "projectRoot">,
    candidatePath: string,
): string {
    const scopeRoot = liveSession.projectRoot ?? liveSession.cwd;
    const absolutePath = path.isAbsolute(candidatePath)
        ? path.resolve(candidatePath)
        : path.resolve(scopeRoot, candidatePath);

    if (
        absolutePath === scopeRoot ||
        absolutePath.startsWith(`${scopeRoot}${path.sep}`)
    ) {
        const relativePath = path.relative(scopeRoot, absolutePath);
        return relativePath.length > 0
            ? toPosixPath(relativePath)
            : toPosixPath(path.basename(absolutePath));
    }

    return path.isAbsolute(candidatePath)
        ? absolutePath
        : toPosixPath(candidatePath);
}

export const __testing = {
    computeDiffHunks,
    diffToAiFileDiff,
    normalizeTrackedDiffPath,
    resolveTrackedFileHunks,
    shouldSuppressToolActivityUpdate,
    upsertTrackedFile,
};
