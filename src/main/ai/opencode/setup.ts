import fs from "node:fs";
import path from "node:path";

import type {
    AiAuthCredentialSource,
    AiAuthMethod,
    AiRuntimeStatus,
    OpenCodeAuthMethodId,
    OpenCodeRuntimeSettings,
} from "@shared/ipc";

import { launchTerminalLoginCommand } from "../auth/terminal-login";
import type { SecretStoreGateway } from "../secret-store";
import { debugBenignError } from "../../observability/logging";

const OPENCODE_PROGRAM_NAME = "opencode";
const OPENCODE_ACP_SUBCOMMAND = "acp";
const OPENCODE_AUTH_LOGIN_SUBCOMMAND = ["auth", "login"] as const;
const OPENCODE_ENV_BIN = "COMANDO_OPENCODE_ACP_BIN";
const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
const OPENCODE_LOGIN_METHOD_ID =
    "opencode-login" satisfies OpenCodeAuthMethodId;
const OPENCODE_MACOS_FALLBACK_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
] as const;

interface ResolvedOpenCodeBinary {
    readonly args: readonly string[];
    readonly command: string | null;
    readonly message: string | null;
    readonly program: string | null;
    readonly source: AiRuntimeStatus["source"];
    readonly state: AiRuntimeStatus["state"];
}

export interface ResolvedOpenCodeRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly program: string;
    readonly status: AiRuntimeStatus;
}

interface OpenCodeAuthStoreStatus {
    readonly hasActiveAuth: boolean;
    readonly modifiedAtMs: number | null;
}

export function getOpenCodeRuntimeStatus(
    settings: OpenCodeRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): AiRuntimeStatus {
    const resolved = resolveOpenCodeBinary(settings);
    const authMethods = getOpenCodeAuthMethods();
    const authMethod = detectOpenCodeAuthMethod(settings);
    const credentialSource = getOpenCodeCredentialSource(authMethod);
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
        message =
            "Run OpenCode auth login, use /connect in OpenCode, set OPENCODE_API_KEY, or provide credentials through a project .env.";
    } else if (
        binaryReady &&
        authMethod === OPENCODE_LOGIN_METHOD_ID &&
        !openCodeLoginAvailable(settings) &&
        !environmentOpenCodeApiKeyReady(process.env)
    ) {
        message =
            "OpenCode auth is selected. Comando could not verify local OpenCode credentials, but OpenCode may still load providers from /connect, environment variables, or a project .env.";
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
            readSelectedOpenCodeAuthMethod(settings) !== null ||
            openCodeLoginAvailable(settings) ||
            settings.authInvalidatedAtMs !== null,
        canLogoutAuth: false,
        checkedAt: new Date().toISOString(),
        command: resolved.command,
        hasCustomBinaryPath: Boolean(settings.binaryPath?.trim()),
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message,
        onboardingRequired: !binaryReady || !authReady,
        runtimeId: "opencode",
        source: resolved.source,
        state: resolved.state,
    };
}

export function resolveOpenCodeRuntime(
    settings: OpenCodeRuntimeSettings,
    secretStore?: SecretStoreGateway | null,
): ResolvedOpenCodeRuntimeCommand {
    const resolved = resolveOpenCodeBinary(settings);
    const status = getOpenCodeRuntimeStatus(settings, secretStore);

    if (resolved.program === null || resolved.command === null) {
        throw new Error(
            status.message ??
                "OpenCode ACP is not available on this machine.",
        );
    }

    return {
        args: resolved.args,
        command: resolved.command,
        program: resolved.program,
        status,
    };
}

export function applyOpenCodeAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    _settings: OpenCodeRuntimeSettings,
    _secretStore?: SecretStoreGateway | null,
): NodeJS.ProcessEnv {
    return { ...baseEnv };
}

export function markOpenCodeAuthInvalidated(
    settings: OpenCodeRuntimeSettings,
): OpenCodeRuntimeSettings {
    return {
        ...settings,
        authInvalidatedAtMs: Date.now(),
    };
}

export function launchOpenCodeLogin(
    settings: OpenCodeRuntimeSettings,
    cwd?: string | null,
): Promise<void> {
    const resolved = resolveOpenCodeBinary(settings);
    if (!resolved.program) {
        throw new Error(
            resolved.message ??
                "OpenCode CLI was not found. Install opencode or provide a custom runtime path.",
        );
    }

    return launchTerminalLoginCommand({
        commandParts: [resolved.program, ...OPENCODE_AUTH_LOGIN_SUBCOMMAND],
        cwd,
        missingTerminalMessage:
            "No compatible terminal launcher was found for OpenCode auth.",
        scriptPrefix: "comando-opencode-login",
    });
}

export function isOpenCodeAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth required") ||
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("missing api key") ||
        normalized.includes("no provider configured") ||
        normalized.includes("run opencode auth login") ||
        normalized.includes("run `opencode auth login`") ||
        normalized.includes("use /connect") ||
        normalized.includes("unauthorized") ||
        normalized.includes("401")
    );
}

function detectOpenCodeAuthMethod(
    settings: OpenCodeRuntimeSettings,
): OpenCodeAuthMethodId | null {
    if (environmentOpenCodeApiKeyReady(process.env)) {
        return OPENCODE_LOGIN_METHOD_ID;
    }

    const selectedAuthMethod = readSelectedOpenCodeAuthMethod(settings);
    if (selectedAuthMethod === OPENCODE_LOGIN_METHOD_ID) {
        return OPENCODE_LOGIN_METHOD_ID;
    }

    if (openCodeLoginAvailable(settings)) {
        return OPENCODE_LOGIN_METHOD_ID;
    }

    return null;
}

function getOpenCodeAuthMethods(): readonly AiAuthMethod[] {
    return [
        {
            description:
                "Use providers and credentials configured by the OpenCode CLI.",
            id: OPENCODE_LOGIN_METHOD_ID,
            name: "OpenCode auth",
        },
    ];
}

function getOpenCodeCredentialSource(
    authMethod: OpenCodeAuthMethodId | null,
    env: NodeJS.ProcessEnv = process.env,
): AiAuthCredentialSource {
    if (authMethod === null) {
        return "none";
    }

    if (environmentOpenCodeApiKeyReady(env)) {
        return "environment";
    }

    return "external-runtime";
}

function getCredentialSourceLabel(source: AiAuthCredentialSource): string {
    switch (source) {
        case "environment":
            return "Using environment variable";
        case "external-runtime":
            return "Using external OpenCode auth";
        case "comando-secret":
            return "Using Comando stored credentials";
        case "none":
        default:
            return "Needs authentication";
    }
}

function readSelectedOpenCodeAuthMethod(
    settings: OpenCodeRuntimeSettings,
): OpenCodeAuthMethodId | null {
    const authMethod = (settings as { readonly authMethod?: unknown })
        .authMethod;
    return authMethod === OPENCODE_LOGIN_METHOD_ID ? authMethod : null;
}

function openCodeLoginAvailable(settings: OpenCodeRuntimeSettings): boolean {
    const status = getOpenCodeAuthStoreStatus();
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

function getOpenCodeAuthStoreStatus(): OpenCodeAuthStoreStatus | null {
    const authPath = getOpenCodeAuthStorePath();
    if (!authPath || !isFile(authPath)) {
        return null;
    }

    return {
        hasActiveAuth: true,
        modifiedAtMs: getFileModifiedAtMs(authPath),
    };
}

function getOpenCodeAuthStorePath(): string | null {
    const baseDir = getOpenCodeDataDir();
    return baseDir ? path.join(baseDir, "opencode", "auth.json") : null;
}

function getOpenCodeDataDir(): string | null {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim() ?? "";
    if (xdgDataHome) {
        return xdgDataHome;
    }

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA?.trim() ?? "";
        if (localAppData) {
            return localAppData;
        }
    }

    const homeDir =
        process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, ".local", "share");
}

function environmentOpenCodeApiKeyReady(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env[OPENCODE_API_KEY_ENV]?.trim());
}

function resolveOpenCodeBinary(
    settings: OpenCodeRuntimeSettings,
): ResolvedOpenCodeBinary {
    const envPath = process.env[OPENCODE_ENV_BIN]?.trim() ?? "";
    const configuredPath = settings.binaryPath?.trim() ?? "";

    if (envPath) {
        return resolveCommandCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCommandCandidate(configuredPath, "settings");
    }

    const pathResolved = resolveFromPath(OPENCODE_PROGRAM_NAME);
    if (pathResolved) {
        return commandFromExistingPath(pathResolved, "path");
    }

    const macOsResolved = resolveFromMacOsFallbackDirs(OPENCODE_PROGRAM_NAME);
    if (macOsResolved) {
        return commandFromExistingPath(macOsResolved, "path");
    }

    return {
        args: [],
        command: null,
        message:
            "OpenCode CLI was not found. Install `opencode` or provide a custom runtime path.",
        program: null,
        source: null,
        state: "missing",
    };
}

function resolveCommandCandidate(
    raw: string,
    source: AiRuntimeStatus["source"],
): ResolvedOpenCodeBinary {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            args: [],
            command: null,
            message: "OpenCode runtime path is empty.",
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
                message: `Could not execute the configured OpenCode runtime: ${candidate}`,
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
): ResolvedOpenCodeBinary {
    if (!isExecutableFile(candidatePath)) {
        return {
            args: [],
            command: candidatePath,
            message: `OpenCode runtime is not executable: ${candidatePath}`,
            program: null,
            source,
            state: "error",
        };
    }

    return {
        args: [OPENCODE_ACP_SUBCOMMAND],
        command: `${candidatePath} ${OPENCODE_ACP_SUBCOMMAND}`,
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
        debugBenignError("ai.opencode.getFileModifiedAtMs", error);
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

    for (const entry of OPENCODE_MACOS_FALLBACK_DIRS) {
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
        debugBenignError("ai.opencode.isExecutableFile", error);
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.opencode.isFile", error);
        return false;
    }
}
