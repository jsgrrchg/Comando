import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type Client,
} from "@agentclientprotocol/sdk";

import type {
    AiAuthCredentialSource,
    AiAuthMethod,
    AiRuntimeStatus,
    GrokAuthMethodId,
    GrokRuntimeSettings,
} from "@shared/ipc";

import { launchTerminalLoginCommand } from "../auth/terminal-login";
import {
    buildSecretStorageKey,
    type SecretRecordPatch,
    type SecretStoreGateway,
} from "../secret-store";
import { debugBenignError } from "../../observability/logging";

const GROK_PROGRAM_NAME = "grok";
const GROK_ACP_ARGS = ["--no-auto-update", "agent", "stdio"] as const;
const GROK_AUTH_LOGIN_SUBCOMMAND = ["login"] as const;
const GROK_ENV_BIN = "COMANDO_GROK_ACP_BIN";
const XAI_API_KEY_ENV = "XAI_API_KEY";
const GROK_LOGIN_METHOD_ID = "grok-login" satisfies GrokAuthMethodId;
const XAI_API_KEY_METHOD_ID = "xai-api-key" satisfies GrokAuthMethodId;
const GROK_SECRET_NAMESPACE = "ai.grok";
const XAI_API_KEY_SECRET = "xai_api_key";
const GROK_MACOS_FALLBACK_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
] as const;
const GROK_AUTH_PROBE_TIMEOUT_MS = 2_000;

interface ResolvedGrokBinary {
    readonly args: readonly string[];
    readonly command: string | null;
    readonly message: string | null;
    readonly program: string | null;
    readonly source: AiRuntimeStatus["source"];
    readonly state: AiRuntimeStatus["state"];
}

export interface ResolvedGrokRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly program: string;
    readonly status: AiRuntimeStatus;
}

interface GrokAuthStoreStatus {
    readonly hasActiveAuth: boolean;
    readonly modifiedAtMs: number | null;
}

export interface GrokSecretBundle {
    readonly xaiApiKey: string | null;
}

export function getGrokRuntimeStatus(
    settings: GrokRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): AiRuntimeStatus {
    const resolved = resolveGrokBinary(settings);
    const authMethods = getGrokAuthMethods();
    const authMethod = detectGrokAuthMethod(settings, secretStore);
    const secrets = loadGrokSecretBundle(secretStore);
    const credentialSource = getGrokCredentialSource(
        authMethod,
        secrets,
        process.env,
    );
    const storageStatus = secretStore?.getStorageStatus?.() ?? {
        encryptionAvailable: true,
        isWeakBackend: false,
        message: null,
        platform: process.platform,
        selectedBackend: null,
    };
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const authReady = authMethod !== null;

    let message = resolved.message;
    if (binaryReady && !authReady) {
        message = "Run Grok login or add an xAI API key to finish setup.";
    } else if (
        binaryReady &&
        authMethod === GROK_LOGIN_METHOD_ID &&
        !grokLoginAvailable(settings) &&
        !envSecretPresent(process.env, XAI_API_KEY_ENV)
    ) {
        message =
            "Grok login is selected. Comando could not verify local Grok credentials, but Grok may still load credentials from its CLI login state.";
    }

    return {
        authMethod,
        authMethods,
        authReady,
        authCredentialSource: credentialSource,
        authCredentialSourceLabel: getCredentialSourceLabel(credentialSource),
        authSessionMessage:
            "This affects new sessions. Active sessions may keep using credentials loaded at launch.",
        authStorageMessage: storageStatus.message,
        canDisconnectAuth:
            readSelectedGrokAuthMethod(settings) !== null ||
            Boolean(secrets.xaiApiKey) ||
            (credentialSource !== "environment" && authMethod !== null) ||
            settings.authInvalidatedAtMs !== null,
        canLogoutAuth: false,
        checkedAt: new Date().toISOString(),
        command: resolved.command,
        hasCustomBinaryPath: Boolean(settings.binaryPath?.trim()),
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message,
        onboardingRequired: !binaryReady || !authReady,
        runtimeId: "grok",
        source: resolved.source,
        state: resolved.state,
    };
}

export function resolveGrokRuntime(
    settings: GrokRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): ResolvedGrokRuntimeCommand {
    const resolved = resolveGrokBinary(settings);
    const status = getGrokRuntimeStatus(settings, secretStore);

    if (resolved.program === null || resolved.command === null) {
        throw new Error(
            status.message ?? "Grok ACP is not available on this machine.",
        );
    }

    return {
        args: resolved.args,
        command: resolved.command,
        program: resolved.program,
        status,
    };
}

export function detectGrokAuthMethod(
    settings: GrokRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): GrokAuthMethodId | null {
    const secrets = loadGrokSecretBundle(secretStore);
    const selectedAuthMethod = readSelectedGrokAuthMethod(settings);

    if (envSecretPresent(process.env, XAI_API_KEY_ENV)) {
        return XAI_API_KEY_METHOD_ID;
    }

    if (
        selectedAuthMethod === XAI_API_KEY_METHOD_ID &&
        Boolean(secrets.xaiApiKey)
    ) {
        return XAI_API_KEY_METHOD_ID;
    }

    if (
        selectedAuthMethod === GROK_LOGIN_METHOD_ID &&
        settings.authInvalidatedAtMs === null
    ) {
        return GROK_LOGIN_METHOD_ID;
    }

    if (selectedAuthMethod !== null) {
        return null;
    }

    if (secrets.xaiApiKey) {
        return XAI_API_KEY_METHOD_ID;
    }

    if (grokLoginAvailable(settings)) {
        return GROK_LOGIN_METHOD_ID;
    }

    return null;
}

export function getGrokAuthMethods(): readonly AiAuthMethod[] {
    return [
        {
            description:
                "Open Grok CLI in a system terminal and complete sign-in there.",
            id: GROK_LOGIN_METHOD_ID,
            name: "Grok login",
        },
        {
            description:
                "Use an xAI API key stored only for Comando on this machine.",
            id: XAI_API_KEY_METHOD_ID,
            name: "xAI API key",
        },
    ];
}

export function getGrokCredentialSource(
    authMethod: GrokAuthMethodId | null,
    secrets: GrokSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
): AiAuthCredentialSource {
    if (authMethod === XAI_API_KEY_METHOD_ID) {
        if (envSecretPresent(env, XAI_API_KEY_ENV)) {
            return "environment";
        }

        if (secrets.xaiApiKey) {
            return "comando-secret";
        }
    }

    if (authMethod === GROK_LOGIN_METHOD_ID) {
        return "external-runtime";
    }

    return "none";
}

export function loadGrokSecretBundle(
    secretStore?: SecretStoreGateway | null,
): GrokSecretBundle {
    return {
        xaiApiKey:
            secretStore?.loadSecret(
                GROK_SECRET_NAMESPACE,
                XAI_API_KEY_SECRET,
            ) ?? null,
    };
}

export function saveGrokSecrets(
    secretStore: SecretStoreGateway,
    input: GrokSecretBundle,
): {
    readonly hasXaiApiKey: boolean;
} {
    const xaiApiKey = normalizeOptionalText(input.xaiApiKey);
    saveSecretIfChanged(
        secretStore,
        GROK_SECRET_NAMESPACE,
        XAI_API_KEY_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret(GROK_SECRET_NAMESPACE, XAI_API_KEY_SECRET),
        ),
        xaiApiKey,
    );

    return {
        hasXaiApiKey: Boolean(xaiApiKey),
    };
}

export function buildGrokSecretPatches(
    secretStore: SecretStoreGateway,
    input: GrokSecretBundle,
): {
    readonly flags: {
        readonly hasXaiApiKey: boolean;
    };
    readonly patches: readonly SecretRecordPatch[];
} {
    const xaiApiKey = normalizeOptionalText(input.xaiApiKey);
    const patches: SecretRecordPatch[] = [];

    pushSecretPatchIfChanged(
        patches,
        GROK_SECRET_NAMESPACE,
        XAI_API_KEY_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret(GROK_SECRET_NAMESPACE, XAI_API_KEY_SECRET),
        ),
        xaiApiKey,
    );

    return {
        flags: {
            hasXaiApiKey: Boolean(xaiApiKey),
        },
        patches,
    };
}

export function applyGrokAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: GrokRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };

    if (envSecretPresent(baseEnv, XAI_API_KEY_ENV)) {
        return env;
    }

    delete env[XAI_API_KEY_ENV];

    if (readSelectedGrokAuthMethod(settings) === GROK_LOGIN_METHOD_ID) {
        return env;
    }

    const secrets = loadGrokSecretBundle(secretStore);
    if (secrets.xaiApiKey) {
        env[XAI_API_KEY_ENV] = secrets.xaiApiKey;
    }

    return env;
}

export function isGrokEnvironmentCredentialReady(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return envSecretPresent(env, XAI_API_KEY_ENV);
}

export function isGrokExternalCredentialReady(
    settings: GrokRuntimeSettings,
): boolean {
    return grokLoginAvailable(settings);
}

export async function probeGrokCachedTokenAuth(
    settings: GrokRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
    options: {
        readonly cwd?: string | null;
        readonly timeoutMs?: number;
    } = {},
): Promise<boolean> {
    let resolved: ResolvedGrokRuntimeCommand;
    try {
        resolved = resolveGrokRuntime(settings, secretStore);
    } catch {
        return false;
    }

    const child = spawn(resolved.program, [...resolved.args], {
        cwd: options.cwd ?? undefined,
        env: applyGrokAuthEnv(process.env, settings, secretStore),
        stdio: ["pipe", "pipe", "pipe"],
    });
    const client: Client = {
        readTextFile: () => {
            throw new Error("Grok auth probe does not support file reads.");
        },
        requestPermission: () => {
            throw new Error(
                "Grok auth probe does not support permission requests.",
            );
        },
        sessionUpdate: () => Promise.resolve(undefined),
        writeTextFile: () => {
            throw new Error("Grok auth probe does not support file writes.");
        },
    };
    const stream = ndJsonStream(
        toWebByteWritable(child.stdin),
        toWebByteReadable(child.stdout),
    );
    const connection = new ClientSideConnection(() => client, stream);

    try {
        const initializeResponse = await withTimeout(
            connection.initialize({
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
            }),
            options.timeoutMs ?? GROK_AUTH_PROBE_TIMEOUT_MS,
        );
        const advertisedMethodIds =
            initializeResponse.authMethods?.map((method) => method.id) ?? [];
        return advertisedMethodIds.includes("cached_token");
    } catch (error) {
        debugBenignError("ai.grok.probeCachedTokenAuth", error);
        return false;
    } finally {
        child.kill();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
    }
}

export function markGrokAuthInvalidated(
    settings: GrokRuntimeSettings,
): GrokRuntimeSettings {
    return {
        ...settings,
        authInvalidatedAtMs: Date.now(),
    };
}

export function launchGrokLogin(
    settings: GrokRuntimeSettings,
    cwd?: string | null,
): Promise<void> {
    const resolved = resolveGrokBinary(settings);
    if (!resolved.program) {
        throw new Error(
            resolved.message ??
                "Grok CLI was not found. Install `grok` or provide a custom runtime path.",
        );
    }

    return launchTerminalLoginCommand({
        commandParts: [resolved.program, ...GROK_AUTH_LOGIN_SUBCOMMAND],
        cwd,
        missingTerminalMessage:
            "No compatible terminal launcher was found for Grok login.",
        scriptPrefix: "comando-grok-login",
    });
}

export function isGrokAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("run grok login") ||
        normalized.includes("set xai_api_key") ||
        normalized.includes("authentication required") ||
        normalized.includes("auth_required") ||
        normalized.includes("unauthorized") ||
        normalized.includes("401") ||
        normalized.includes("invalid api key") ||
        normalized.includes("cached_token")
    );
}

function saveSecretIfChanged(
    secretStore: SecretStoreGateway,
    namespace: string,
    secretId: string,
    currentValue: string | null,
    nextValue: string | null,
): void {
    if (currentValue === nextValue) {
        return;
    }

    void secretStore.saveSecret(namespace, secretId, nextValue);
}

function pushSecretPatchIfChanged(
    patches: SecretRecordPatch[],
    namespace: string,
    secretId: string,
    currentValue: string | null,
    nextValue: string | null,
): void {
    if (currentValue === nextValue) {
        return;
    }

    patches.push({
        key: buildSecretStorageKey(namespace, secretId),
        value: nextValue,
    });
}

function normalizeOptionalText(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function readSelectedGrokAuthMethod(
    settings: GrokRuntimeSettings,
): GrokAuthMethodId | null {
    const authMethod = (settings as { readonly authMethod?: unknown })
        .authMethod;
    if (
        authMethod === GROK_LOGIN_METHOD_ID ||
        authMethod === XAI_API_KEY_METHOD_ID
    ) {
        return authMethod;
    }

    return null;
}

function grokLoginAvailable(settings: GrokRuntimeSettings): boolean {
    const status = getGrokAuthStoreStatus();
    if (!status?.hasActiveAuth) {
        return false;
    }

    if (
        settings.authInvalidatedAtMs !== null &&
        status.modifiedAtMs !== null &&
        status.modifiedAtMs <= settings.authInvalidatedAtMs
    ) {
        return false;
    }

    return true;
}

function getGrokAuthStoreStatus(): GrokAuthStoreStatus | null {
    const authDir = getGrokAuthStorePath();
    if (!authDir || !isDirectory(authDir)) {
        return null;
    }

    return readGrokAuthStoreStatus(authDir);
}

function getGrokAuthStorePath(): string | null {
    const homeDir =
        process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, ".grok", "auth");
}

function readGrokAuthStoreStatus(authDir: string): GrokAuthStoreStatus {
    try {
        const entries = fs.readdirSync(authDir, { withFileTypes: true });
        let hasActiveAuth = false;
        let modifiedAtMs = getFileModifiedAtMs(authDir);

        for (const entry of entries) {
            const entryPath = path.join(authDir, entry.name);
            if (!entry.isFile()) {
                continue;
            }

            const stat = fs.statSync(entryPath);
            modifiedAtMs = Math.max(modifiedAtMs ?? 0, stat.mtimeMs);
            if (stat.size > 0) {
                hasActiveAuth = true;
            }
        }

        return {
            hasActiveAuth,
            modifiedAtMs,
        };
    } catch (error) {
        debugBenignError("ai.grok.readAuthStoreStatus", error);
        return {
            hasActiveAuth: false,
            modifiedAtMs: getFileModifiedAtMs(authDir),
        };
    }
}

function envSecretPresent(env: NodeJS.ProcessEnv, key: typeof XAI_API_KEY_ENV) {
    return Boolean(env[key]?.trim());
}

function toWebByteWritable(stream: Writable): WritableStream<Uint8Array> {
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function toWebByteReadable(stream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Grok auth probe timed out."));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timeout);
                reject(
                    error instanceof Error
                        ? error
                        : new Error("Grok auth probe failed.", {
                              cause: error,
                          }),
                );
            },
        );
    });
}

function getCredentialSourceLabel(source: AiAuthCredentialSource): string {
    switch (source) {
        case "comando-secret":
            return "Using Comando stored credentials";
        case "environment":
            return "Using environment variable";
        case "external-runtime":
            return "Using external Grok login";
        case "none":
        default:
            return "Needs authentication";
    }
}

function resolveGrokBinary(settings: GrokRuntimeSettings): ResolvedGrokBinary {
    const envPath = process.env[GROK_ENV_BIN]?.trim() ?? "";
    const configuredPath = settings.binaryPath?.trim() ?? "";

    if (envPath) {
        return resolveCommandCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCommandCandidate(configuredPath, "settings");
    }

    const pathResolved = resolveFromPath(GROK_PROGRAM_NAME);
    if (pathResolved) {
        return commandFromExistingPath(pathResolved, "path");
    }

    const macOsResolved = resolveFromMacOsFallbackDirs(GROK_PROGRAM_NAME);
    if (macOsResolved) {
        return commandFromExistingPath(macOsResolved, "path");
    }

    return {
        args: [],
        command: null,
        message:
            "Grok CLI was not found. Install `grok` or provide a custom runtime path.",
        program: null,
        source: null,
        state: "missing",
    };
}

function resolveCommandCandidate(
    raw: string,
    source: AiRuntimeStatus["source"],
): ResolvedGrokBinary {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            args: [],
            command: null,
            message: "Grok runtime path is empty.",
            program: null,
            source,
            state: "missing",
        };
    }

    const looksLikePath =
        path.isAbsolute(trimmed) ||
        trimmed.includes(path.sep) ||
        trimmed.includes("/") ||
        trimmed.includes("\\");

    if (looksLikePath) {
        const candidate = path.resolve(trimmed);
        if (!isExecutableFile(candidate)) {
            return {
                args: [],
                command: candidate,
                message: `Could not execute the configured Grok runtime: ${candidate}`,
                program: null,
                source,
                state: "error",
            };
        }

        return commandFromExistingPath(candidate, source);
    }

    const found = resolveFromPath(trimmed);
    if (!found) {
        return {
            args: [],
            command: trimmed,
            message: `Configured command was not found: ${trimmed}`,
            program: null,
            source,
            state: "missing",
        };
    }

    return commandFromExistingPath(found, source);
}

function commandFromExistingPath(
    candidatePath: string,
    source: AiRuntimeStatus["source"],
): ResolvedGrokBinary {
    if (!isExecutableFile(candidatePath)) {
        return {
            args: [],
            command: candidatePath,
            message: `Grok runtime is not executable: ${candidatePath}`,
            program: null,
            source,
            state: "error",
        };
    }

    return {
        args: GROK_ACP_ARGS,
        command: `${candidatePath} ${GROK_ACP_ARGS.join(" ")}`,
        message: null,
        program: candidatePath,
        source,
        state: "ready",
    };
}

function getFileModifiedAtMs(filePath: string): number | null {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch (error) {
        debugBenignError("ai.grok.getFileModifiedAtMs", error);
        return null;
    }
}

function resolveFromPath(command: string): string | null {
    const pathEntries = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    const pathextEntries =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];

    for (const entry of pathEntries) {
        for (const ext of pathextEntries) {
            const candidate = path.join(
                entry,
                process.platform === "win32" &&
                    !command.toLowerCase().endsWith(ext.toLowerCase())
                    ? `${command}${ext}`
                    : command,
            );
            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function resolveFromMacOsFallbackDirs(command: string): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    for (const entry of GROK_MACOS_FALLBACK_DIRS) {
        const candidate = path.join(entry, command);
        if (isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

function isExecutableFile(candidatePath: string): boolean {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.grok.isExecutableFile", error);
        return false;
    }
}

function isDirectory(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isDirectory();
    } catch (error) {
        debugBenignError("ai.grok.isDirectory", error);
        return false;
    }
}
