import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type Client,
} from "@agentclientprotocol/sdk";
import type {
    AiHistorySessionSummary,
    AiPermissionResponseInput,
    AiPromptResult,
    PrepareAiSessionInput,
    AiRuntimeAuthLaunchInput,
    AiRuntimeAuthDisconnectInput,
    AiRuntimeAuthLogoutInput,
    AiRuntimeId,
    AiRuntimeStatus,
    AiSessionConfigOptionMutationInput,
    AiSessionModeMutationInput,
    AiSessionModelMutationInput,
    AiSessionPinnedMutationInput,
    AiSessionUpdate,
    AiSessionRenameMutationInput,
    AiSessionSnapshot,
    AiSessionTranscriptPage,
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
    resolveTrackedFileHunks,
    upsertTrackedFile,
} from "@shared/ai-tracked-file";

import type { ProjectService } from "@main/projects/service";
import type { SettingsGateway } from "@main/settings/service";
import type {
    SecretRecordPatch,
    SecretStoreGateway,
} from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";

import {
    createEmptyAiSessionSnapshot,
    type AiPersistenceGateway,
} from "./persistence";
import { createAiEnvironmentDiagnostics } from "./environment-diagnostics";
import { listOpenFileBuffers } from "./openFileBuffers";
import {
    type AiWorkerGateway,
    type AiWorkerRefreshProjectScopesRpcInput,
    type AiWorkerReviewMutationResult,
    type AiWorkerReviewSessionContext,
    type AiWorkerSessionLaunchInput,
    type AiServiceOptions,
    type ResolvedAcpRuntime,
    type SessionDescriptor,
} from "./contracts";
import {
    buildAiSessionUpdate,
    getModeConfigOption,
    getModelConfigOption,
    getRecentStderrText,
    getRuntimeDisplayName,
    normalizeAdditionalRoots,
    setConfigOptionOnSnapshot,
    setModeOnSnapshot,
    setModelOnSnapshot,
    setTitleOnSnapshot,
} from "./session-core";
import {
    diffToAiFileDiff,
    mapToolCallUpdate,
    normalizeTrackedDiffPath,
    resolveDiffToFullTexts,
    shouldSuppressToolActivityUpdate,
} from "./review-core";
import { buildRuntimeSpawnEnv } from "./runtime-env";
import { resolveCodexRuntime } from "./resolver/runtime-resolver";
import {
    applyCodexAuthEnv,
    buildCodexSecretPatches,
    getCodexAuthMethods,
    getCodexRuntimeStatus,
    isCodexAuthenticationError,
    type CodexSecretBundle,
    loadCodexSecretBundle,
} from "./codex/setup";
import {
    applyClaudeAuthEnv,
    buildClaudeSecretPatches,
    getClaudeRuntimeStatus,
    isClaudeAuthenticationError,
    launchClaudeLogin,
    loadClaudeSecretBundle,
    markClaudeAuthInvalidated,
    resolveClaudeRuntime,
} from "./claude/setup";
import {
    applyGeminiAuthEnv,
    buildGeminiSecretPatches,
    getGeminiRuntimeStatus,
    isGeminiAuthenticationError,
    launchGeminiLogin,
    markGeminiAuthInvalidated,
    resolveGeminiRuntime,
} from "./gemini/setup";
import {
    applyKiloAuthEnv,
    buildKiloSecretPatches,
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

type LiveSessionContext = {
    readonly additionalRoots: readonly string[];
    ownerWindowId: string;
    readonly parentSessionId: string | null;
    readonly projectId: string | null;
    readonly runtimeId: AiRuntimeId;
    readonly sessionId: string;
    readonly worktreeId: string | null;
};

export class AiService {
    #aiWorker: AiWorkerGateway | null;
    readonly #liveSessionContexts = new Map<string, LiveSessionContext>();
    readonly #liveSnapshots = new Map<string, AiSessionSnapshot>();
    readonly #onRuntimeStatus: (status: AiRuntimeStatus) => void;
    readonly #onSessionSnapshot: (
        ownerWindowId: string,
        update: AiSessionUpdate,
    ) => void;
    readonly #persistence: AiPersistenceGateway;
    readonly #projectService: ProjectService;
    readonly #secretStore: SecretStoreGateway;
    readonly #settingsService: SettingsGateway;

    constructor(options: AiServiceOptions) {
        this.#aiWorker = options.aiWorker ?? null;
        this.#onRuntimeStatus = options.onRuntimeStatus;
        this.#onSessionSnapshot = options.onSessionSnapshot;
        this.#persistence = options.persistence;
        this.#projectService = options.projectService;
        this.#secretStore = options.secretStore;
        this.#settingsService = options.settingsService;
    }

    setWorker(worker: AiWorkerGateway | null): void {
        this.#aiWorker = worker;
    }

    close(): void {
        this.#liveSessionContexts.clear();
        this.#liveSnapshots.clear();
    }

    handleWorkerRuntimeStatus(status: AiRuntimeStatus): void {
        this.#onRuntimeStatus(status);
    }

    handleWorkerSessionClosed(payload: {
        readonly ownerWindowId: string;
        readonly sessionId: string;
    }): void {
        this.#clearLiveSession(payload.sessionId);
    }

    handleWorkerSessionSnapshot(
        ownerWindowId: string,
        update: AiSessionUpdate,
    ): void {
        const snapshot = this.#resolveSnapshotFromWorkerUpdate(update);
        if (!snapshot) {
            return;
        }

        this.#cacheLiveSessionSnapshot(snapshot, ownerWindowId);
        this.#persistence.saveSessionSnapshot(snapshot);
        if (snapshot.lastError) {
            this.#invalidateRuntimeAuthIfNeeded(snapshot.runtimeId, snapshot.lastError);
        }
        this.#onSessionSnapshot(ownerWindowId, update);
    }

    async handleWorkerRestarted(): Promise<void> {
        const worker = this.#requireAiWorker();
        await Promise.all(
            listOpenFileBuffers().map(async (buffer) => {
                await worker.notifyFileBuffer(buffer);
            }),
        );
        const relaunches = this.#listRelaunchableLiveSessionContexts().map(
            async (context) => {
                const snapshot =
                    this.#liveSnapshots.get(context.sessionId) ??
                    (await this.#persistence.loadSessionSnapshot(
                        context.sessionId,
                    ));
                if (!snapshot) {
                    return;
                }

                const relaunchedSnapshot = await worker.prepareSession({
                    input: {
                        projectId: context.projectId,
                        runtimeId: context.runtimeId,
                        sessionId: context.sessionId,
                        title: snapshot.title,
                        worktreeId: context.worktreeId,
                    },
                    launch: await this.#buildWorkerSessionLaunchInput(
                        {
                            additionalRoots: context.additionalRoots,
                            projectId: context.projectId,
                            runtimeId: context.runtimeId,
                            sessionId: context.sessionId,
                            title: snapshot.title,
                            worktreeId: context.worktreeId,
                        },
                        context.ownerWindowId,
                        snapshot,
                    ),
                });
                this.#acceptPreparedLiveSnapshot(
                    relaunchedSnapshot,
                    context.ownerWindowId,
                );
            },
        );

        await Promise.allSettled(relaunches);
    }

    getRuntimeStatus(runtimeId: AiRuntimeId): AiRuntimeStatus {
        const status = this.#withPersistedRuntimeCatalog(
            this.#resolveRuntimeStatus(runtimeId),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    getEnvironmentDiagnostics() {
        return createAiEnvironmentDiagnostics({
            secretStore: this.#secretStore,
            settings: {
                claude: this.#settingsService.loadClaudeRuntimeSettings(),
                codex: this.#settingsService.loadCodexRuntimeSettings(),
                gemini: this.#settingsService.loadGeminiRuntimeSettings(),
                kilo: this.#settingsService.loadKiloRuntimeSettings(),
            },
        });
    }

    async saveCodexRuntimeSettings(
        settings: CodexRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings =
            this.#settingsService.loadCodexRuntimeSettings();
        const nextSecrets = resolveCodexSecretBundle(
            loadCodexSecretBundle(this.#secretStore),
            settings,
        );
        const secretPatch = buildCodexSecretPatches(this.#secretStore, {
            codexApiKey: nextSecrets.codexApiKey,
            openaiApiKey: nextSecrets.openaiApiKey,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
            hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;
        await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(nextSettings, nextSecrets),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveClaudeRuntimeSettings(
        settings: ClaudeRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings =
            this.#settingsService.loadClaudeRuntimeSettings();
        const currentSecrets = loadClaudeSecretBundle(this.#secretStore);
        const anthropicApiKey = applySecretValuePatch(
            currentSecrets.anthropicApiKey,
            settings.anthropicApiKey,
        );
        const gatewayAuthToken = applySecretValuePatch(
            currentSecrets.anthropicAuthToken,
            settings.gatewayAuthToken,
        );
        const gatewayCustomHeaders = applySecretValuePatch(
            currentSecrets.anthropicCustomHeaders,
            settings.gatewayCustomHeaders,
        );
        const secretPatch = buildClaudeSecretPatches(this.#secretStore, {
            anthropicApiKey,
            gatewayAuthToken,
            gatewayCustomHeaders,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            bedrockGatewayBaseUrl: normalizeOptionalText(
                settings.bedrockGatewayBaseUrl,
            ),
            binaryPath: normalizeOptionalText(settings.binaryPath),
            gatewayBaseUrl: normalizeOptionalText(settings.gatewayBaseUrl),
            hasAnthropicApiKey: secretPatch.flags.hasAnthropicApiKey,
            hasGatewayAuthToken: secretPatch.flags.hasGatewayAuthToken,
            hasGatewayCustomHeaders: secretPatch.flags.hasGatewayCustomHeaders,
        };

        await this.#saveClaudeAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getClaudeRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveGeminiRuntimeSettings(
        settings: GeminiRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
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
        const secretPatch = buildGeminiSecretPatches(this.#secretStore, {
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
            hasGeminiApiKey: secretPatch.flags.hasGeminiApiKey,
            hasGoogleApiKey: secretPatch.flags.hasGoogleApiKey,
        };

        await this.#saveGeminiAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getGeminiRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async saveKiloRuntimeSettings(
        settings: KiloRuntimeSettingsInput,
    ): Promise<AiRuntimeStatus> {
        const currentSettings = this.#settingsService.loadKiloRuntimeSettings();
        const kiloApiKey = applySecretValuePatch(
            this.#secretStore.loadSecret("ai.kilo", "kilo_api_key"),
            settings.kiloApiKey,
        );
        const secretPatch = buildKiloSecretPatches(this.#secretStore, {
            kiloApiKey,
        });
        const nextSettings = {
            authInvalidatedAtMs: currentSettings.authInvalidatedAtMs,
            authMethod: settings.authMethod,
            binaryPath: normalizeOptionalText(settings.binaryPath),
            hasKiloApiKey: secretPatch.flags.hasKiloApiKey,
        };

        await this.#saveKiloAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getKiloRuntimeStatus(nextSettings, this.#secretStore),
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
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            return liveSnapshot;
        }

        return await this.#persistence.loadSessionSnapshot(sessionId);
    }

    async listSessionHistory(
        input: ListAiSessionHistoryInput,
    ): Promise<readonly AiHistorySessionSummary[]> {
        return await this.#persistence.listSessionHistory(input);
    }

    async setSessionPinned(
        input: AiSessionPinnedMutationInput,
    ): Promise<void> {
        await this.#persistence.setSessionPinned(
            input.sessionId,
            input.pinned,
        );
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
        const worker = this.#requireAiWorker();
        const launch = await this.#buildWorkerSessionLaunchInput(
            input,
            ownerWindowId,
        );
        this.#rememberLiveSessionContext(input, ownerWindowId, launch.additionalRoots);
        try {
            const snapshot = await worker.prepareSession({
                input,
                launch,
            });
            this.#acceptPreparedLiveSnapshot(snapshot, ownerWindowId);
            return snapshot;
        } catch (error) {
            this.#discardPreparedSessionContextOnFailure(
                input.sessionId,
                ownerWindowId,
                input.runtimeId,
            );
            throw error;
        }
    }

    async refreshProjectScopes(projectId: string): Promise<void> {
        const worker = this.#requireAiWorker();
        const sessions = await this.#buildWorkerScopeRefreshInputs(projectId);
        if (sessions.length === 0) {
            return;
        }

        await worker.refreshProjectScopes({
            projectId,
            sessions,
        } satisfies AiWorkerRefreshProjectScopesRpcInput);
    }

    async sendPrompt(
        input: SendAiPromptInput,
        ownerWindowId: string,
    ): Promise<AiPromptResult> {
        const worker = this.#requireAiWorker();
        const launch = await this.#buildWorkerSessionLaunchInput(
            input,
            ownerWindowId,
        );
        this.#rememberLiveSessionContext(input, ownerWindowId, launch.additionalRoots);
        return await worker.sendPrompt({
            input,
            launch,
        });
    }

    async setSessionMode(input: AiSessionModeMutationInput): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
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

        await this.#requireAiWorker().setSessionMode(input);
        this.#persistence.saveRuntimeModePreference(
            this.#getLiveSessionRuntimeId(input.sessionId),
            input.modeId,
        );
    }

    async setSessionModel(input: AiSessionModelMutationInput): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
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

        await this.#requireAiWorker().setSessionModel(input);
        this.#persistence.saveRuntimeModelPreference(
            this.#getLiveSessionRuntimeId(input.sessionId),
            input.modelId,
        );
    }

    async setSessionConfigOption(
        input: AiSessionConfigOptionMutationInput,
    ): Promise<void> {
        if (!this.#liveSessionContexts.has(input.sessionId)) {
            const snapshot = await this.#updateSessionSnapshot(
                input.sessionId,
                (currentSnapshot) =>
                    setConfigOptionOnSnapshot(
                        currentSnapshot,
                        input.optionId,
                        input.value,
                    ),
            );
            this.#persistRuntimeConfigOptionSelection(
                snapshot.runtimeId,
                snapshot,
                input.optionId,
                input.value,
            );
            return;
        }

        const runtimeId = this.#getLiveSessionRuntimeId(input.sessionId);
        const snapshot = this.#liveSnapshots.get(input.sessionId) ?? null;
        await this.#requireAiWorker().setSessionConfigOption(input);
        this.#persistRuntimeConfigOptionSelection(
            runtimeId,
            snapshot,
            input.optionId,
            input.value,
        );
    }

    async renameSession(input: AiSessionRenameMutationInput): Promise<void> {
        if (this.#liveSessionContexts.has(input.sessionId)) {
            await this.#requireAiWorker().renameSession(input);
            return;
        }

        await this.#updateSessionSnapshot(input.sessionId, (snapshot) =>
            setTitleOnSnapshot(snapshot, input.title),
        );
    }

    async cancelSession(sessionId: string): Promise<void> {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        await this.#requireAiWorker().cancelSession(sessionId);
    }

    async closeSession(sessionId: string): Promise<void> {
        if (!this.#liveSessionContexts.has(sessionId)) {
            return;
        }

        await this.#requireAiWorker().closeSession(sessionId);
        this.#clearLiveSession(sessionId);
    }

    async deleteSession(sessionId: string): Promise<void> {
        if (this.#liveSessionContexts.has(sessionId)) {
            try {
                await this.cancelSession(sessionId);
            } catch (error) {
                // Closing and deleting the local session state is still safe.
                debugBenignError("ai.service.deleteSession.cancel", error);
            }

            await this.closeSession(sessionId);
        }

        this.#clearLiveSession(sessionId);
        await this.#persistence.deleteSession(sessionId);
    }

    closeOwnedByWindow(ownerWindowId: string): void {
        const sessionIds = [...this.#liveSessionContexts.entries()]
            .filter(
                ([, liveSession]) => liveSession.ownerWindowId === ownerWindowId,
            )
            .map(([sessionId]) => sessionId);

        void this.#aiWorker?.closeOwnedByWindow(ownerWindowId).catch((error) => {
            debugBenignError("ai.service.closeOwnedByWindow", error);
        });
        for (const sessionId of sessionIds) {
            this.#clearLiveSession(sessionId);
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
            await this.#saveClaudeAuthSettings(nextSettings, []);

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
            await this.#saveGeminiAuthSettings(nextSettings, []);

            await launchGeminiLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                getGeminiRuntimeStatus(nextSettings, this.#secretStore),
            );
            return;
        }

        if (input.runtimeId === "kilo") {
            if (input.methodId === "kilo-api-key") {
                throw new Error(
                    "The Kilo API key does not need a login terminal. Save the API key from settings.",
                );
            }

            if (input.methodId !== "kilo-login") {
                throw new Error(
                    "Select Kilo login before opening authentication.",
                );
            }

            const nextSettings = markKiloAuthInvalidated(
                {
                    ...this.#settingsService.loadKiloRuntimeSettings(),
                    authMethod: "kilo-login",
                },
            );
            await this.#saveKiloAuthSettings(nextSettings);

            await launchKiloLogin(nextSettings, cwd);
            this.#onRuntimeStatus(
                getKiloRuntimeStatus(nextSettings, this.#secretStore),
            );
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

            await this.#saveCodexAuthSettings(nextSettings, []);
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
        if (currentSettings.authMethod !== "chatgpt") {
            throw new Error(
                "Codex provider logout is only available for ChatGPT login. Use Disconnect from Comando to clear local API keys.",
            );
        }

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

        const secretPatch = buildCodexSecretPatches(this.#secretStore, {
            codexApiKey: null,
            openaiApiKey: null,
        });
        const nextSettings = {
            ...currentSettings,
            authMethod: null,
            hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
            hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
        } satisfies CodexRuntimeSettings;
        await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);

        const status = this.#withPersistedRuntimeCatalog(
            getCodexRuntimeStatus(
                nextSettings,
                loadCodexSecretBundle(this.#secretStore),
            ),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    async disconnectRuntimeAuth(
        input: AiRuntimeAuthDisconnectInput,
    ): Promise<AiRuntimeStatus> {
        if (input.runtimeId === "codex") {
            const currentSettings =
                this.#settingsService.loadCodexRuntimeSettings();
            const secretPatch = buildCodexSecretPatches(this.#secretStore, {
                codexApiKey: null,
                openaiApiKey: null,
            });
            const nextSettings = {
                ...currentSettings,
                authMethod: null,
                hasCodexApiKey: secretPatch.flags.hasCodexApiKey,
                hasOpenAiApiKey: secretPatch.flags.hasOpenAiApiKey,
            } satisfies CodexRuntimeSettings;
            await this.#saveCodexAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getCodexRuntimeStatus(
                    nextSettings,
                    loadCodexSecretBundle(this.#secretStore),
                ),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        if (input.runtimeId === "claude") {
            const currentSettings =
                this.#settingsService.loadClaudeRuntimeSettings();
            const secretPatch = buildClaudeSecretPatches(this.#secretStore, {
                anthropicApiKey: null,
                gatewayAuthToken: null,
                gatewayCustomHeaders: null,
            });
            const shouldInvalidateExternalLogin = ![
                "anthropic-api-key",
                "gateway",
                "gateway-bedrock",
            ].includes(currentSettings.authMethod ?? "");
            const nextSettings = {
                ...currentSettings,
                authInvalidatedAtMs:
                    shouldInvalidateExternalLogin
                        ? Date.now()
                        : currentSettings.authInvalidatedAtMs,
                authMethod: null,
                hasAnthropicApiKey: secretPatch.flags.hasAnthropicApiKey,
                hasGatewayAuthToken: secretPatch.flags.hasGatewayAuthToken,
                hasGatewayCustomHeaders:
                    secretPatch.flags.hasGatewayCustomHeaders,
            };
            await this.#saveClaudeAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getClaudeRuntimeStatus(nextSettings, this.#secretStore),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        if (input.runtimeId === "gemini") {
            const currentSettings =
                this.#settingsService.loadGeminiRuntimeSettings();
            const secretPatch = buildGeminiSecretPatches(this.#secretStore, {
                geminiApiKey: null,
                googleApiKey: null,
            });
            const nextSettings = {
                ...currentSettings,
                authInvalidatedAtMs:
                    currentSettings.authMethod === "use_gemini"
                        ? currentSettings.authInvalidatedAtMs
                        : Date.now(),
                authMethod: null,
                hasGeminiApiKey: secretPatch.flags.hasGeminiApiKey,
                hasGoogleApiKey: secretPatch.flags.hasGoogleApiKey,
            };
            await this.#saveGeminiAuthSettings(nextSettings, secretPatch.patches);
            const status = this.#withPersistedRuntimeCatalog(
                getGeminiRuntimeStatus(nextSettings, this.#secretStore),
            );
            this.#onRuntimeStatus(status);
            return status;
        }

        const currentSettings = this.#settingsService.loadKiloRuntimeSettings();
        const secretPatch = buildKiloSecretPatches(this.#secretStore, {
            kiloApiKey: null,
        });
        const nextSettings = {
            ...markKiloAuthInvalidated(currentSettings),
            authMethod: null,
            hasKiloApiKey: secretPatch.flags.hasKiloApiKey,
        };
        await this.#saveKiloAuthSettings(nextSettings, secretPatch.patches);
        const status = this.#withPersistedRuntimeCatalog(
            getKiloRuntimeStatus(nextSettings, this.#secretStore),
        );
        this.#onRuntimeStatus(status);
        return status;
    }

    respondPermission(input: AiPermissionResponseInput): Promise<void> {
        return this.#requireAiWorker().respondPermission(input);
    }

    async respondUserInput(input: AiUserInputResponseInput): Promise<void> {
        await this.#requireAiWorker().respondUserInput(input);
    }

    #requireAiWorker(): AiWorkerGateway {
        if (!this.#aiWorker) {
            throw new Error("The AI worker is not available.");
        }

        return this.#aiWorker;
    }

    #rememberLiveSessionContext(
        input: SessionDescriptor,
        ownerWindowId: string,
        additionalRoots: readonly string[],
    ): void {
        const existingContext = this.#liveSessionContexts.get(input.sessionId);
        const snapshotParentSessionId =
            this.#liveSnapshots.get(input.sessionId)?.parentSessionId ?? null;
        const parentSessionId =
            existingContext?.parentSessionId ?? snapshotParentSessionId ?? null;
        this.#liveSessionContexts.set(input.sessionId, {
            additionalRoots,
            ownerWindowId,
            parentSessionId,
            projectId: input.projectId,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            worktreeId: input.worktreeId ?? null,
        });
    }

    #cacheLiveSessionSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        this.#liveSnapshots.set(snapshot.sessionId, snapshot);
        const context = this.#liveSessionContexts.get(snapshot.sessionId);
        if (context) {
            context.ownerWindowId = ownerWindowId;
            return;
        }

        const parentSessionId = snapshot.parentSessionId ?? null;
        const parentContext = parentSessionId
            ? this.#liveSessionContexts.get(parentSessionId)
            : null;
        if (!parentContext) {
            return;
        }

        this.#liveSessionContexts.set(snapshot.sessionId, {
            additionalRoots: parentContext.additionalRoots,
            ownerWindowId,
            parentSessionId,
            projectId: snapshot.projectId,
            runtimeId: snapshot.runtimeId,
            sessionId: snapshot.sessionId,
            worktreeId: snapshot.worktreeId ?? null,
        });
    }

    #clearLiveSession(sessionId: string): void {
        this.#liveSnapshots.delete(sessionId);
        this.#liveSessionContexts.delete(sessionId);
    }

    #discardPreparedSessionContextOnFailure(
        sessionId: string,
        ownerWindowId: string,
        runtimeId: AiRuntimeId,
    ): void {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            return;
        }

        const context = this.#liveSessionContexts.get(sessionId);
        if (
            !context ||
            context.ownerWindowId !== ownerWindowId ||
            context.runtimeId !== runtimeId
        ) {
            return;
        }

        this.#liveSessionContexts.delete(sessionId);
    }

    #acceptPreparedLiveSnapshot(
        snapshot: AiSessionSnapshot,
        ownerWindowId: string,
    ): void {
        this.#cacheLiveSessionSnapshot(snapshot, ownerWindowId);
        this.#persistence.saveSessionSnapshot(snapshot);
    }

    #getLiveSessionRuntimeId(sessionId: string): AiRuntimeId {
        const runtimeId = this.#liveSnapshots.get(sessionId)?.runtimeId;
        if (!runtimeId) {
            throw new Error("The live AI session snapshot is not available.");
        }

        return runtimeId;
    }

    #resolveSnapshotFromWorkerUpdate(
        update: AiSessionUpdate,
    ): AiSessionSnapshot | null {
        if (update.kind === "snapshot") {
            return update.snapshot;
        }

        const previousSnapshot = this.#liveSnapshots.get(update.patch.sessionId);
        if (!previousSnapshot) {
            return null;
        }

        return {
            ...previousSnapshot,
            ...update.patch.changes,
            runtimeId: update.patch.runtimeId,
            sessionId: update.patch.sessionId,
        };
    }

    async #buildWorkerSessionLaunchInput(
        input: SessionDescriptor,
        ownerWindowId: string,
        snapshotOverride?: AiSessionSnapshot | null,
    ): Promise<AiWorkerSessionLaunchInput> {
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
            snapshotOverride ??
            this.#liveSnapshots.get(input.sessionId) ??
            (await this.#persistence.loadSessionSnapshot(input.sessionId)) ??
            createEmptyAiSessionSnapshot({
                projectId: input.projectId,
                runtimeId: input.runtimeId,
                sessionId: input.sessionId,
                title: input.title,
                worktreeId: input.worktreeId ?? null,
            });

        return {
            additionalRoots,
            cwd: projectRoot ?? process.cwd(),
            desiredSelections: this.#resolveDesiredSelections(
                input.runtimeId,
                persistedSnapshot,
            ),
            input: {
                ...input,
                additionalRoots,
                worktreeId: input.worktreeId ?? null,
            },
            ownerWindowId,
            persistedSnapshot,
            projectRoot,
            resolvedRuntime,
        };
    }

    async #buildWorkerScopeRefreshInputs(
        projectId: string,
    ): Promise<readonly AiWorkerSessionLaunchInput[]> {
        const launches = await Promise.all(
            this.#listRelaunchableLiveSessionContexts()
                .filter((context) => context.projectId === projectId)
                .map(async (context) => {
                    const snapshot =
                        this.#liveSnapshots.get(context.sessionId) ??
                        (await this.#persistence.loadSessionSnapshot(
                            context.sessionId,
                        ));
                    if (!snapshot) {
                        return null;
                    }

                    return await this.#buildWorkerSessionLaunchInput(
                        {
                            additionalRoots: context.additionalRoots,
                            projectId: context.projectId,
                            runtimeId: context.runtimeId,
                            sessionId: context.sessionId,
                            title: snapshot.title,
                            worktreeId: context.worktreeId,
                        },
                        context.ownerWindowId,
                        snapshot,
                    );
                }),
        );

        return launches.filter(
            (
                launch,
            ): launch is AiWorkerSessionLaunchInput => launch !== null,
        );
    }

    #listRelaunchableLiveSessionContexts(): readonly LiveSessionContext[] {
        return [...this.#liveSessionContexts.values()].filter(
            (context) =>
                !context.parentSessionId ||
                !this.#liveSessionContexts.has(context.parentSessionId),
        );
    }

    async #buildWorkerReviewContext(
        sessionId: string,
    ): Promise<{
        readonly context: AiWorkerReviewSessionContext;
        readonly snapshot: AiSessionSnapshot;
    }> {
        const liveContext = this.#liveSessionContexts.get(sessionId);
        const snapshot =
            this.#liveSnapshots.get(sessionId) ??
            (await this.#persistence.loadSessionSnapshot(sessionId));
        if (!snapshot) {
            throw new Error("The AI session was not found.");
        }

        const projectRoot =
            snapshot.projectId !== null
                ? this.#projectService.getProjectRootPath(
                      snapshot.projectId,
                      snapshot.worktreeId ?? null,
                  )
                : null;
        const additionalRoots = liveContext
            ? liveContext.additionalRoots
            : this.#resolveEffectiveAdditionalRoots(
                  {
                      additionalRoots: [],
                      projectId: snapshot.projectId,
                      worktreeId: snapshot.worktreeId ?? null,
                  },
                  projectRoot,
              );

        return {
            context: {
                additionalRoots,
                cwd: projectRoot ?? process.cwd(),
                ownerWindowId: liveContext?.ownerWindowId ?? "",
                projectRoot,
                snapshot,
            },
            snapshot,
        };
    }

    #persistReviewMutation(
        previousSnapshot: AiSessionSnapshot,
        result: AiWorkerReviewMutationResult,
    ): void {
        this.#persistence.saveSessionSnapshot(result.snapshot);
        if (this.#liveSnapshots.has(result.snapshot.sessionId)) {
            this.#liveSnapshots.set(result.snapshot.sessionId, result.snapshot);
        }
        this.#onSessionSnapshot(
            result.ownerWindowId,
            buildAiSessionUpdate(previousSnapshot, result.snapshot),
        );
    }

    async keepTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().keepTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFile(input: AiTrackedFileMutationInput): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().rejectTrackedFile({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().keepTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectTrackedFileHunks(
        input: AiTrackedFileHunkMutationInput,
    ): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(
            input.sessionId,
        );
        const result = await this.#requireAiWorker().rejectTrackedFileHunks({
            context: reviewSession.context,
            input,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async keepAllTrackedFiles(sessionId: string): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(sessionId);
        const result = await this.#requireAiWorker().keepAllTrackedFiles({
            context: reviewSession.context,
            input: sessionId,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
    }

    async rejectAllTrackedFiles(sessionId: string): Promise<void> {
        const reviewSession = await this.#buildWorkerReviewContext(sessionId);
        const result = await this.#requireAiWorker().rejectAllTrackedFiles({
            context: reviewSession.context,
            input: sessionId,
        });
        this.#persistReviewMutation(reviewSession.snapshot, result);
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

    #persistRuntimeConfigOptionSelection(
        runtimeId: AiRuntimeId,
        snapshot: Pick<AiSessionSnapshot, "configOptions"> | null,
        optionId: string,
        value: boolean | string,
    ): void {
        this.#persistence.saveRuntimeSelectionPreferenceOption(
            runtimeId,
            optionId,
            value,
        );

        if (typeof value !== "string") {
            return;
        }

        const configOptions = snapshot?.configOptions ?? [];
        const modeConfig = getModeConfigOption(configOptions);
        const modelConfig = getModelConfigOption(configOptions);
        const normalizedOptionId = optionId.toLowerCase();

        if (modelConfig?.id === optionId || normalizedOptionId === "model") {
            this.#persistence.saveRuntimeModelPreference(runtimeId, value);
        }

        if (modeConfig?.id === optionId || normalizedOptionId === "mode") {
            this.#persistence.saveRuntimeModePreference(runtimeId, value);
        }
    }

    async #updateSessionSnapshot(
        sessionId: string,
        mutate: (snapshot: AiSessionSnapshot) => AiSessionSnapshot,
    ): Promise<AiSessionSnapshot> {
        const liveSnapshot = this.#liveSnapshots.get(sessionId);
        if (liveSnapshot) {
            const nextSnapshot = mutate(liveSnapshot);
            this.#liveSnapshots.set(sessionId, nextSnapshot);
            this.#persistence.saveSessionSnapshot(nextSnapshot);
            this.#onSessionSnapshot(
                this.#liveSessionContexts.get(sessionId)?.ownerWindowId ?? "",
                buildAiSessionUpdate(liveSnapshot, nextSnapshot),
            );
            return nextSnapshot;
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
                this.#secretStore,
            );
        }

        return getCodexRuntimeStatus(
            this.#settingsService.loadCodexRuntimeSettings(),
            loadCodexSecretBundle(this.#secretStore),
        );
    }

    async #saveCodexAuthSettings(
        settings: CodexRuntimeSettings,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        if (this.#settingsService.saveCodexAuth) {
            await this.#settingsService.saveCodexAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveCodexRuntimeSettings(settings);
    }

    async #saveClaudeAuthSettings(
        settings: ReturnType<SettingsGateway["loadClaudeRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        if (this.#settingsService.saveClaudeAuth) {
            await this.#settingsService.saveClaudeAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveClaudeRuntimeSettings(settings);
    }

    async #saveGeminiAuthSettings(
        settings: ReturnType<SettingsGateway["loadGeminiRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        if (this.#settingsService.saveGeminiAuth) {
            await this.#settingsService.saveGeminiAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveGeminiRuntimeSettings(settings);
    }

    async #saveKiloAuthSettings(
        settings: ReturnType<SettingsGateway["loadKiloRuntimeSettings"]>,
        secrets: readonly SecretRecordPatch[] = [],
    ): Promise<void> {
        if (this.#settingsService.saveKiloAuth) {
            await this.#settingsService.saveKiloAuth(settings, secrets);
            this.#secretStore.cacheSecretPatches?.(secrets);
            return;
        }

        await this.#saveSecretPatches(secrets);
        this.#settingsService.saveKiloRuntimeSettings(settings);
    }

    async #saveSecretPatches(
        secrets: readonly SecretRecordPatch[],
    ): Promise<void> {
        for (const secret of secrets) {
            const parsed = parseSecretStorageKey(secret.key);
            await this.#secretStore.saveSecret(
                parsed.namespace,
                parsed.secretId,
                secret.value,
            );
        }
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
            const resolved = resolveKiloRuntime(settings, this.#secretStore);

            return {
                args: resolved.args,
                command: resolved.command,
                env: buildRuntimeSpawnEnv(
                    applyKiloAuthEnv(process.env, settings, this.#secretStore),
                    resolved.program,
                ),
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

        const nextSettings = markKiloAuthInvalidated({
            ...this.#settingsService.loadKiloRuntimeSettings(),
            authMethod: "kilo-login",
        });
        this.#settingsService.saveKiloRuntimeSettings(nextSettings);
        this.#onRuntimeStatus(
            getKiloRuntimeStatus(nextSettings, this.#secretStore),
        );
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

function parseSecretStorageKey(key: string): {
    readonly namespace: string;
    readonly secretId: string;
} {
    const prefix = "secret.";
    if (!key.startsWith(prefix)) {
        throw new Error(`Invalid secret storage key: ${key}`);
    }

    const keyBody = key.slice(prefix.length);
    const separatorIndex = keyBody.lastIndexOf(".");
    if (separatorIndex <= 0 || separatorIndex === keyBody.length - 1) {
        throw new Error(`Invalid secret storage key: ${key}`);
    }

    return {
        namespace: keyBody.slice(0, separatorIndex),
        secretId: keyBody.slice(separatorIndex + 1),
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
