import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
    AiAuthMethod,
    AiRuntimeStatus,
    GeminiAuthMethodId,
    GeminiRuntimeSettings,
} from "@shared/ipc";

import type { SecretStoreGateway } from "@main/ai/secret-store";
import { debugBenignError } from "@main/observability/logging";

const GEMINI_PROGRAM_NAME = "gemini";
const GEMINI_ACP_FLAG = "--acp";
const GEMINI_ENV_BIN = "COMANDO_GEMINI_ACP_BIN";
const GEMINI_MACOS_FALLBACK_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
] as const;
const GEMINI_AUTH_SETTINGS_RELATIVE_PATH = path.join(
    ".gemini",
    "settings.json",
);
const GEMINI_GOOGLE_AUTH_TYPE_ALIASES = new Set([
    "google",
    "login_with_google",
    "oauth-personal",
]);
const GEMINI_API_KEY_SECRET = "gemini_api_key";
const GOOGLE_API_KEY_SECRET = "google_api_key";

interface ResolvedGeminiBinary {
    readonly args: readonly string[];
    readonly command: string | null;
    readonly message: string | null;
    readonly program: string | null;
    readonly source: AiRuntimeStatus["source"];
    readonly state: AiRuntimeStatus["state"];
}

export interface ResolvedGeminiRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly program: string;
    readonly status: AiRuntimeStatus;
}

interface GeminiSecretBundle {
    readonly geminiApiKey: string | null;
    readonly googleApiKey: string | null;
}

export function getGeminiRuntimeStatus(
    settings: GeminiRuntimeSettings,
    secretStore: SecretStoreGateway,
): AiRuntimeStatus {
    const resolved = resolveGeminiBinary(settings);
    const authMethods = getGeminiAuthMethods();
    const authMethod = detectGeminiAuthMethod(settings, secretStore);
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const authReady = authMethod !== null;

    let message = resolved.message;
    if (binaryReady && !authReady) {
        message = "Log in with Google or add a Gemini API key to finish setup.";
    }

    return {
        authMethod,
        authMethods,
        authReady,
        checkedAt: new Date().toISOString(),
        command: resolved.command,
        hasCustomBinaryPath: Boolean(settings.binaryPath?.trim()),
        hasGatewayConfig: false,
        hasGatewayUrl: false,
        message,
        onboardingRequired: !binaryReady || !authReady,
        runtimeId: "gemini",
        source: resolved.source,
        state: resolved.state,
    };
}

export function resolveGeminiRuntime(
    settings: GeminiRuntimeSettings,
    secretStore: SecretStoreGateway,
): ResolvedGeminiRuntimeCommand {
    const resolved = resolveGeminiBinary(settings);
    const status = getGeminiRuntimeStatus(settings, secretStore);

    if (resolved.program === null || resolved.command === null) {
        throw new Error(
            status.message ?? "Gemini ACP is not available on this machine.",
        );
    }

    return {
        args: resolved.args,
        command: resolved.command,
        program: resolved.program,
        status,
    };
}

export function loadGeminiSecretBundle(
    secretStore: SecretStoreGateway,
): GeminiSecretBundle {
    return {
        geminiApiKey: secretStore.loadSecret(
            "ai.gemini",
            GEMINI_API_KEY_SECRET,
        ),
        googleApiKey: secretStore.loadSecret(
            "ai.gemini",
            GOOGLE_API_KEY_SECRET,
        ),
    };
}

export function saveGeminiSecrets(
    secretStore: SecretStoreGateway,
    input: {
        readonly geminiApiKey: string | null;
        readonly googleApiKey: string | null;
    },
): {
    readonly hasGeminiApiKey: boolean;
    readonly hasGoogleApiKey: boolean;
} {
    secretStore.saveSecret(
        "ai.gemini",
        GEMINI_API_KEY_SECRET,
        input.geminiApiKey,
    );
    secretStore.saveSecret(
        "ai.gemini",
        GOOGLE_API_KEY_SECRET,
        input.googleApiKey,
    );

    return {
        hasGeminiApiKey: Boolean(input.geminiApiKey?.trim()),
        hasGoogleApiKey: Boolean(input.googleApiKey?.trim()),
    };
}

export function applyGeminiAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: GeminiRuntimeSettings,
    secretStore: SecretStoreGateway,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };
    const secrets = loadGeminiSecretBundle(secretStore);

    if (!envSecretPresent(env, "GEMINI_API_KEY") && secrets.geminiApiKey) {
        env.GEMINI_API_KEY = secrets.geminiApiKey;
    }

    if (!envSecretPresent(env, "GOOGLE_API_KEY") && secrets.googleApiKey) {
        env.GOOGLE_API_KEY = secrets.googleApiKey;
    }

    if (
        !envSecretPresent(env, "GOOGLE_CLOUD_PROJECT") &&
        settings.googleCloudProject?.trim()
    ) {
        env.GOOGLE_CLOUD_PROJECT = settings.googleCloudProject.trim();
    }

    if (
        !envSecretPresent(env, "GOOGLE_CLOUD_LOCATION") &&
        settings.googleCloudLocation?.trim()
    ) {
        env.GOOGLE_CLOUD_LOCATION = settings.googleCloudLocation.trim();
    }

    if (
        !envSecretPresent(env, "GEMINI_DEFAULT_AUTH_TYPE") &&
        settings.authMethod?.trim()
    ) {
        env.GEMINI_DEFAULT_AUTH_TYPE = settings.authMethod;
    }

    return env;
}

export function detectGeminiAuthMethod(
    settings: GeminiRuntimeSettings,
    secretStore: SecretStoreGateway,
): GeminiAuthMethodId | null {
    if (
        settings.authMethod === "use_gemini" &&
        geminiApiKeyReady(secretStore)
    ) {
        return "use_gemini";
    }

    if (
        settings.authMethod === "login_with_google" &&
        geminiGoogleLoginAvailable(settings)
    ) {
        return "login_with_google";
    }

    if (geminiApiKeyReady(secretStore)) {
        return "use_gemini";
    }

    if (geminiGoogleLoginAvailable(settings)) {
        return "login_with_google";
    }

    return null;
}

export function getGeminiAuthMethods(): readonly AiAuthMethod[] {
    return [
        {
            description:
                "Open Gemini CLI in a system terminal and complete Google sign-in there.",
            id: "login_with_google",
            name: "Log in with Google",
        },
        {
            description:
                "Use a Gemini Developer API key stored only for Comando.",
            id: "use_gemini",
            name: "Gemini API key",
        },
    ];
}

export function markGeminiAuthInvalidated(
    settings: GeminiRuntimeSettings,
): GeminiRuntimeSettings {
    return {
        ...settings,
        authInvalidatedAtMs: Date.now(),
    };
}

export function isGeminiAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("login required") ||
        normalized.includes("invalid api key") ||
        normalized.includes("401") ||
        normalized.includes("unauthorized") ||
        normalized.includes("re-authenticate") ||
        normalized.includes("please run `gemini auth`")
    );
}

export function launchGeminiLogin(
    settings: GeminiRuntimeSettings,
    cwd?: string | null,
): Promise<void> {
    const resolved = resolveGeminiBinary(settings);
    if (!resolved.program) {
        throw new Error(
            resolved.message ??
                "Gemini CLI was not found. Install gemini-cli first.",
        );
    }

    const commandParts = [resolved.program];

    if (process.platform === "win32") {
        const scriptPath = buildWindowsLoginScript(commandParts, cwd);
        return spawnDetached("cmd", [
            "/C",
            "start",
            "",
            "cmd",
            "/K",
            scriptPath,
        ]);
    }

    if (process.platform === "darwin") {
        const scriptPath = buildPosixLoginScript(commandParts, cwd);
        return spawnDetached("open", ["-a", "Terminal", scriptPath]);
    }

    const scriptPath = buildPosixLoginScript(commandParts, cwd);
    const candidates: Array<readonly [string, readonly string[]]> = [
        ["x-terminal-emulator", ["-e", scriptPath]],
        ["gnome-terminal", ["--", "bash", scriptPath]],
        ["konsole", ["-e", "bash", scriptPath]],
        ["xterm", ["-e", "bash", scriptPath]],
    ];

    for (const [program, args] of candidates) {
        const resolvedProgram = resolveFromPath(program);
        if (!resolvedProgram) {
            continue;
        }

        return spawnDetached(resolvedProgram, args);
    }

    return Promise.reject(
        new Error(
            "No compatible terminal launcher was found for Gemini login.",
        ),
    );
}

function resolveGeminiBinary(
    settings: GeminiRuntimeSettings,
): ResolvedGeminiBinary {
    const envPath = process.env[GEMINI_ENV_BIN]?.trim() ?? "";
    const configuredPath = settings.binaryPath?.trim() ?? "";

    if (envPath) {
        return resolveCommandCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCommandCandidate(configuredPath, "settings");
    }

    const pathResolved = resolveFromPath(GEMINI_PROGRAM_NAME);
    if (pathResolved) {
        return commandFromExistingPath(pathResolved, "path");
    }

    const macOsResolved = resolveFromMacOsFallbackDirs(GEMINI_PROGRAM_NAME);
    if (macOsResolved) {
        return commandFromExistingPath(macOsResolved, "path");
    }

    return {
        args: [],
        command: null,
        message:
            "Gemini CLI was not found. Install `gemini` or provide a custom runtime path.",
        program: null,
        source: null,
        state: "missing",
    };
}

function resolveCommandCandidate(
    raw: string,
    source: AiRuntimeStatus["source"],
): ResolvedGeminiBinary {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            args: [],
            command: null,
            message: "Gemini runtime path is empty.",
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
                message: `Could not execute the configured Gemini runtime: ${candidate}`,
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
): ResolvedGeminiBinary {
    if (!isExecutableFile(candidatePath)) {
        return {
            args: [],
            command: candidatePath,
            message: `Gemini runtime is not executable: ${candidatePath}`,
            program: null,
            source,
            state: "error",
        };
    }

    return {
        args: [GEMINI_ACP_FLAG],
        command: `${candidatePath} ${GEMINI_ACP_FLAG}`,
        message: null,
        program: candidatePath,
        source,
        state: "ready",
    };
}

function geminiApiKeyReady(secretStore: SecretStoreGateway): boolean {
    if (envSecretPresent(process.env, "GEMINI_API_KEY")) {
        return true;
    }

    if (envSecretPresent(process.env, "GOOGLE_API_KEY")) {
        return true;
    }

    const secrets = loadGeminiSecretBundle(secretStore);
    return Boolean(secrets.geminiApiKey || secrets.googleApiKey);
}

function geminiGoogleLoginAvailable(settings: GeminiRuntimeSettings): boolean {
    const authFilePath = getGeminiAuthFilePath();
    if (!authFilePath || !isFile(authFilePath)) {
        return false;
    }

    const selectedType = readSelectedAuthType(authFilePath);
    if (!selectedType || !matchesGoogleLoginSelectedType(selectedType)) {
        return false;
    }

    if (settings.authInvalidatedAtMs === null) {
        return true;
    }

    const modifiedAtMs = getFileModifiedAtMs(authFilePath);
    return modifiedAtMs !== null && modifiedAtMs > settings.authInvalidatedAtMs;
}

function readSelectedAuthType(filePath: string): string | null {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as {
            security?: {
                auth?: {
                    selectedType?: unknown;
                };
            };
        };
        const selectedType = parsed.security?.auth?.selectedType;
        return typeof selectedType === "string" ? selectedType : null;
    } catch (error) {
        debugBenignError("ai.gemini.readSelectedAuthType", error);
        return null;
    }
}

function matchesGoogleLoginSelectedType(selectedType: string): boolean {
    return GEMINI_GOOGLE_AUTH_TYPE_ALIASES.has(selectedType.trim());
}

function getGeminiAuthFilePath(): string | null {
    const homeDir =
        process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";
    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, GEMINI_AUTH_SETTINGS_RELATIVE_PATH);
}

function getFileModifiedAtMs(filePath: string): number | null {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch (error) {
        debugBenignError("ai.gemini.getFileModifiedAtMs", error);
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

    for (const entry of GEMINI_MACOS_FALLBACK_DIRS) {
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
        debugBenignError("ai.gemini.isExecutableFile", error);
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.gemini.isFile", error);
        return false;
    }
}

function envSecretPresent(env: NodeJS.ProcessEnv, key: string): boolean {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
}

function buildWindowsLoginScript(
    commandParts: readonly string[],
    cwd?: string | null,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `comando-gemini-login-${Date.now()}.cmd`,
    );
    const lines = [
        "@echo off",
        ...(cwd ? [`cd /d "${cwd}"`] : []),
        commandParts.map(quoteWindowsArg).join(" "),
        "pause",
    ];
    fs.writeFileSync(scriptPath, lines.join("\r\n"), "utf8");
    return scriptPath;
}

function buildPosixLoginScript(
    commandParts: readonly string[],
    cwd?: string | null,
): string {
    const scriptPath = path.join(
        os.tmpdir(),
        `comando-gemini-login-${Date.now()}.sh`,
    );
    const lines = [
        "#!/bin/sh",
        ...(cwd ? [`cd ${quoteShellArg(cwd)}`] : []),
        commandParts.map(quoteShellArg).join(" "),
        'printf "\\nPress Enter to close... "',
        "read _ignored",
    ];
    fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
}

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

function spawnDetached(
    program: string,
    args: readonly string[],
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(program, [...args], {
            detached: true,
            stdio: "ignore",
        });

        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
