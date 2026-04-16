import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
    AiAuthMethod,
    AiRuntimeStatus,
    ClaudeAuthMethodId,
    ClaudeRuntimeSettings,
} from "@shared/ipc";

import type { SecretStoreGateway } from "@main/ai/secret-store";

const CLAUDE_LOGIN_METHOD_ID = "claude-login";
const CLAUDE_AI_LOGIN_METHOD_ID = "claude-ai-login";
const CONSOLE_LOGIN_METHOD_ID = "console-login";
const GATEWAY_METHOD_ID = "gateway";
const REMOTE_CLAUDE_AUTH_ENV_VARS = [
    "NO_BROWSER",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "CLAUDE_CODE_REMOTE",
] as const;
const CLAUDE_AUTH_TOKEN_SECRET = "anthropic_auth_token";
const CLAUDE_CUSTOM_HEADERS_SECRET = "anthropic_custom_headers";
const INVALID_GATEWAY_URL_MESSAGE = "Enter a valid gateway URL.";
const GATEWAY_HTTPS_REQUIRED_MESSAGE = "Gateway URL must use HTTPS.";
const GATEWAY_LOCAL_HTTP_ONLY_MESSAGE =
    "HTTP gateways are only allowed for localhost.";
const GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE =
    "Gateway URL must not include embedded credentials.";

interface ResolvedClaudeBinary {
    readonly args: readonly string[];
    readonly command: string | null;
    readonly program: string | null;
    readonly source: AiRuntimeStatus["source"];
    readonly state: AiRuntimeStatus["state"];
    readonly message: string | null;
}

export interface ResolvedClaudeRuntimeCommand {
    readonly args: readonly string[];
    readonly command: string;
    readonly program: string;
    readonly status: AiRuntimeStatus;
}

export interface ResolveClaudeRuntimeOptions {
    readonly allowPathFallback?: boolean;
    readonly appRoot?: string;
    readonly currentFilePath?: string;
    readonly debugMode?: boolean;
    readonly packagedResourcesPath?: string | null;
}

interface ClaudeSecretBundle {
    readonly anthropicAuthToken: string | null;
    readonly anthropicCustomHeaders: string | null;
}

interface GatewayEnvPolicy {
    readonly allowSecretBundle: boolean;
    readonly managedBaseUrl: string | null;
}

export function getClaudeRuntimeStatus(
    settings: ClaudeRuntimeSettings,
    secretStore: SecretStoreGateway,
    options: ResolveClaudeRuntimeOptions = {},
): AiRuntimeStatus {
    const resolved = resolveClaudeBinary(settings, options);
    const gatewayIssue = gatewayValidationError(settings);
    const authMethod = detectClaudeAuthMethod(settings);
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const gatewaySecretsReady = Boolean(
        secretStore.loadSecret("ai.claude", CLAUDE_AUTH_TOKEN_SECRET) ||
        secretStore.loadSecret("ai.claude", CLAUDE_CUSTOM_HEADERS_SECRET),
    );
    const authReady =
        authMethod !== null &&
        (authMethod !== GATEWAY_METHOD_ID || gatewaySecretsReady);
    const hasCustomBinaryPath = Boolean(settings.binaryPath?.trim());
    const hasGatewayUrl = Boolean(settings.gatewayBaseUrl?.trim());
    const hasGatewayConfig =
        gatewayIssue === null &&
        Boolean(settings.gatewayBaseUrl?.trim()) &&
        (settings.hasGatewayAuthToken || settings.hasGatewayCustomHeaders);
    const authMethods = getClaudeAuthMethods();
    const secretBundle = loadClaudeSecretBundle(secretStore);

    let message = resolved.message;
    if (binaryReady) {
        if (!authReady && gatewayIssue) {
            message = gatewayIssue;
        } else if (!authReady) {
            message =
                "Log in with Claude or configure a custom gateway to finish setup.";
        } else if (authMethod === GATEWAY_METHOD_ID) {
            message = "Claude gateway setup is ready.";
        } else if (
            settings.authMethod === GATEWAY_METHOD_ID &&
            !(
                secretBundle.anthropicAuthToken ||
                secretBundle.anthropicCustomHeaders
            )
        ) {
            message =
                "Claude gateway needs an auth token or custom headers before it can be used.";
        }
    }

    return {
        authMethod,
        authMethods,
        authReady,
        checkedAt: new Date().toISOString(),
        command: resolved.command,
        hasCustomBinaryPath,
        hasGatewayConfig,
        hasGatewayUrl,
        message,
        onboardingRequired: !binaryReady || !authReady,
        runtimeId: "claude",
        source: binaryReady ? resolved.source : resolved.source,
        state: resolved.state,
    };
}

export function resolveClaudeRuntime(
    settings: ClaudeRuntimeSettings,
    secretStore: SecretStoreGateway,
    options: ResolveClaudeRuntimeOptions = {},
): ResolvedClaudeRuntimeCommand {
    const resolved = resolveClaudeBinary(settings, options);
    const status = getClaudeRuntimeStatus(settings, secretStore, options);

    if (resolved.program === null || resolved.command === null) {
        throw new Error(
            status.message ?? "Claude ACP is not available on this machine.",
        );
    }

    return {
        args: resolved.args,
        command: resolved.command,
        program: resolved.program,
        status,
    };
}

export function loadClaudeSecretBundle(
    secretStore: SecretStoreGateway,
): ClaudeSecretBundle {
    return {
        anthropicAuthToken: secretStore.loadSecret(
            "ai.claude",
            CLAUDE_AUTH_TOKEN_SECRET,
        ),
        anthropicCustomHeaders: secretStore.loadSecret(
            "ai.claude",
            CLAUDE_CUSTOM_HEADERS_SECRET,
        ),
    };
}

export function saveClaudeSecrets(
    secretStore: SecretStoreGateway,
    input: {
        readonly gatewayAuthToken: string | null;
        readonly gatewayCustomHeaders: string | null;
    },
): {
    readonly hasGatewayAuthToken: boolean;
    readonly hasGatewayCustomHeaders: boolean;
} {
    secretStore.saveSecret(
        "ai.claude",
        CLAUDE_AUTH_TOKEN_SECRET,
        input.gatewayAuthToken,
    );
    secretStore.saveSecret(
        "ai.claude",
        CLAUDE_CUSTOM_HEADERS_SECRET,
        input.gatewayCustomHeaders,
    );

    return {
        hasGatewayAuthToken: Boolean(input.gatewayAuthToken?.trim()),
        hasGatewayCustomHeaders: Boolean(input.gatewayCustomHeaders?.trim()),
    };
}

export function applyClaudeAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: ClaudeRuntimeSettings,
    secretStore: SecretStoreGateway,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };
    const secrets = loadClaudeSecretBundle(secretStore);
    const externalTokenPresent = envSecretPresent(env, "ANTHROPIC_AUTH_TOKEN");
    const externalHeadersPresent = envSecretPresent(
        env,
        "ANTHROPIC_CUSTOM_HEADERS",
    );
    const externalBaseUrlPresent = envSecretPresent(env, "ANTHROPIC_BASE_URL");
    const policy = gatewayEnvPolicy(settings, externalBaseUrlPresent);

    if (policy.managedBaseUrl) {
        env.ANTHROPIC_BASE_URL = policy.managedBaseUrl;

        if (!externalTokenPresent) {
            if (secrets.anthropicAuthToken) {
                env.ANTHROPIC_AUTH_TOKEN = secrets.anthropicAuthToken;
            } else {
                env.ANTHROPIC_AUTH_TOKEN = "";
            }
        }
    } else if (policy.allowSecretBundle && !externalTokenPresent) {
        if (secrets.anthropicAuthToken) {
            env.ANTHROPIC_AUTH_TOKEN = secrets.anthropicAuthToken;
        }
    } else if (!externalTokenPresent && !externalBaseUrlPresent) {
        delete env.ANTHROPIC_AUTH_TOKEN;
    }

    if (!externalHeadersPresent && policy.allowSecretBundle) {
        if (secrets.anthropicCustomHeaders) {
            env.ANTHROPIC_CUSTOM_HEADERS = secrets.anthropicCustomHeaders;
        }
    }

    return env;
}

export function getClaudeAuthMethods(): readonly AiAuthMethod[] {
    const methods = isRemoteClaudeAuthEnvironment()
        ? [
              {
                  description:
                      "Open a Claude terminal session and complete sign-in with /login.",
                  id: CLAUDE_LOGIN_METHOD_ID,
                  name: "Log in with Claude",
              },
          ]
        : [
              {
                  description:
                      "Open a terminal-based Claude subscription login flow.",
                  id: CLAUDE_AI_LOGIN_METHOD_ID,
                  name: "Claude subscription",
              },
              {
                  description:
                      "Open a terminal-based Anthropic Console login flow.",
                  id: CONSOLE_LOGIN_METHOD_ID,
                  name: "Anthropic Console",
              },
          ];

    return [
        ...methods,
        {
            description:
                "Use a custom Anthropic-compatible gateway just for Comando.",
            id: GATEWAY_METHOD_ID,
            name: "Custom gateway",
        },
    ];
}

export function detectClaudeAuthMethod(
    settings: ClaudeRuntimeSettings,
): ClaudeAuthMethodId | null {
    if (
        settings.authMethod === GATEWAY_METHOD_ID &&
        gatewayIsConfigured(settings)
    ) {
        return GATEWAY_METHOD_ID;
    }

    const normalized = normalizeClaudeAuthMethodId(settings.authMethod);
    if (normalized && claudeLoginAvailable(settings)) {
        return projectTerminalAuthMethodId(normalized);
    }

    if (claudeLoginAvailable(settings)) {
        return defaultClaudeLoginMethodId();
    }

    return null;
}

export function markClaudeAuthInvalidated(
    settings: ClaudeRuntimeSettings,
): ClaudeRuntimeSettings {
    return {
        ...settings,
        authInvalidatedAtMs: Date.now(),
    };
}

export function launchClaudeLogin(
    resolved: ResolvedClaudeRuntimeCommand,
    methodId: string,
    cwd?: string | null,
): Promise<void> {
    const loginArgs = getClaudeLoginArgs(methodId);
    const commandParts = [resolved.program, ...resolved.args, ...loginArgs];

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
            "No compatible terminal launcher was found for Claude login.",
        ),
    );
}

export function gatewayValidationError(
    settings: ClaudeRuntimeSettings,
): string | null {
    try {
        validatedGatewayUrl(settings);
        return null;
    } catch (error) {
        return error instanceof Error
            ? error.message
            : INVALID_GATEWAY_URL_MESSAGE;
    }
}

function resolveClaudeBinary(
    settings: ClaudeRuntimeSettings,
    options: ResolveClaudeRuntimeOptions,
): ResolvedClaudeBinary {
    const envPath = process.env.COMANDO_CLAUDE_ACP_BIN?.trim() ?? "";
    const configuredPath = settings.binaryPath?.trim() ?? "";
    const appRoot = options.appRoot ?? getAppRoot(options.currentFilePath);
    const packagedResourcesPath =
        options.packagedResourcesPath ?? getPackagedResourcesPath();
    const debugMode =
        options.debugMode ?? process.env.NODE_ENV !== "production";
    const bundledPath = getBundledClaudeCandidate(
        appRoot,
        packagedResourcesPath,
    );
    const bundledVendorPath = getBundledClaudeVendorEntryPath(
        appRoot,
        packagedResourcesPath,
    );
    const bundledNodePath = getBundledNodePath(appRoot, packagedResourcesPath);
    const vendorPath = getVendorClaudeEntryPath(appRoot);

    if (envPath) {
        return resolveCommandCandidate(envPath, "env");
    }

    if (configuredPath) {
        return resolveCommandCandidate(configuredPath, "settings");
    }

    if (debugMode && isFile(vendorPath)) {
        return commandFromExistingPath(vendorPath, "vendor");
    }

    if (isExecutableFile(bundledNodePath) && isFile(bundledVendorPath)) {
        return commandFromEmbeddedNode(
            bundledNodePath,
            bundledVendorPath,
            "bundled",
        );
    }

    if (isExecutableFile(bundledPath)) {
        return commandFromExistingPath(bundledPath, "bundled");
    }

    if (isFile(vendorPath)) {
        return commandFromExistingPath(vendorPath, "vendor");
    }

    if (options.allowPathFallback !== false) {
        const pathResolved = resolveFromPath("claude-agent-acp");
        if (pathResolved) {
            return commandFromExistingPath(pathResolved, "path");
        }
    }

    return {
        args: [],
        command: bundledPath,
        program: null,
        source: "bundled",
        state: "missing",
        message:
            "Claude runtime was not found. Run `pnpm run stage:ai`, install `claude-agent-acp`, or provide a custom runtime path.",
    };
}

function gatewayEnvPolicy(
    settings: ClaudeRuntimeSettings,
    externalBaseUrlPresent: boolean,
): GatewayEnvPolicy {
    const managedBaseUrl = validatedGatewayUrl(settings);
    const invalidManagedGateway =
        settings.gatewayBaseUrl !== null && managedBaseUrl === null;

    return {
        allowSecretBundle: !invalidManagedGateway || externalBaseUrlPresent,
        managedBaseUrl,
    };
}

function gatewayIsConfigured(settings: ClaudeRuntimeSettings): boolean {
    return validatedGatewayUrl(settings) !== null;
}

function validatedGatewayUrl(settings: ClaudeRuntimeSettings): string | null {
    const raw = settings.gatewayBaseUrl?.trim() ?? "";
    if (!raw) {
        return null;
    }

    try {
        const parsed = new URL(raw);
        if (parsed.username || parsed.password) {
            throw new Error(GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE);
        }

        if (parsed.protocol === "https:") {
            return parsed.toString();
        }

        if (
            parsed.protocol === "http:" &&
            isLoopbackGatewayHost(parsed.hostname)
        ) {
            return parsed.toString();
        }

        if (parsed.protocol === "http:") {
            throw new Error(GATEWAY_LOCAL_HTTP_ONLY_MESSAGE);
        }

        throw new Error(GATEWAY_HTTPS_REQUIRED_MESSAGE);
    } catch (error) {
        if (error instanceof Error && error.message !== "Invalid URL") {
            throw error;
        }

        throw new Error(INVALID_GATEWAY_URL_MESSAGE);
    }
}

function isLoopbackGatewayHost(host: string): boolean {
    return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost")
    );
}

function normalizeClaudeAuthMethodId(
    methodId: string | null,
): ClaudeAuthMethodId | null {
    switch (methodId) {
        case CLAUDE_LOGIN_METHOD_ID:
        case CLAUDE_AI_LOGIN_METHOD_ID:
        case CONSOLE_LOGIN_METHOD_ID:
        case GATEWAY_METHOD_ID:
            return methodId;
        default:
            return null;
    }
}

function defaultClaudeLoginMethodId(): ClaudeAuthMethodId {
    return isRemoteClaudeAuthEnvironment()
        ? CLAUDE_LOGIN_METHOD_ID
        : CLAUDE_AI_LOGIN_METHOD_ID;
}

function projectTerminalAuthMethodId(
    methodId: ClaudeAuthMethodId,
): ClaudeAuthMethodId {
    if (isRemoteClaudeAuthEnvironment()) {
        return CLAUDE_LOGIN_METHOD_ID;
    }

    return methodId === CONSOLE_LOGIN_METHOD_ID
        ? CONSOLE_LOGIN_METHOD_ID
        : CLAUDE_AI_LOGIN_METHOD_ID;
}

function isRemoteClaudeAuthEnvironment(): boolean {
    return REMOTE_CLAUDE_AUTH_ENV_VARS.some((envVar) => {
        const value = process.env[envVar];
        return typeof value === "string" && value.trim().length > 0;
    });
}

function claudeLoginAvailable(settings: ClaudeRuntimeSettings): boolean {
    const authPath = getClaudeAuthFilePath();
    if (!authPath || !isFile(authPath)) {
        return false;
    }

    if (settings.authInvalidatedAtMs === null) {
        return true;
    }

    const modifiedAtMs = getFileModifiedAtMs(authPath);
    return modifiedAtMs !== null && modifiedAtMs > settings.authInvalidatedAtMs;
}

function getClaudeAuthFilePath(): string | null {
    const homeDir =
        process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";

    if (!homeDir) {
        return null;
    }

    return path.join(homeDir, ".claude.json");
}

function getFileModifiedAtMs(filePath: string): number | null {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

function getClaudeLoginArgs(methodId: string): readonly string[] {
    switch (normalizeClaudeAuthMethodId(methodId)) {
        case CLAUDE_LOGIN_METHOD_ID:
            return ["--cli"];
        case CLAUDE_AI_LOGIN_METHOD_ID:
            return ["--cli", "auth", "login", "--claudeai"];
        case CONSOLE_LOGIN_METHOD_ID:
            return ["--cli", "auth", "login", "--console"];
        default:
            throw new Error(`Unsupported Claude auth method: ${methodId}`);
    }
}

function commandFromEmbeddedNode(
    nodePath: string,
    entryPath: string,
    source: AiRuntimeStatus["source"],
): ResolvedClaudeBinary {
    return {
        args: [entryPath],
        command: `${nodePath} ${entryPath}`,
        program: nodePath,
        source,
        state: "ready",
        message: null,
    };
}

function resolveCommandCandidate(
    raw: string,
    source: AiRuntimeStatus["source"],
): ResolvedClaudeBinary {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {
            args: [],
            command: null,
            program: null,
            source,
            state: "missing",
            message: "Claude runtime path is empty.",
        };
    }

    const candidate = path.resolve(trimmed);
    const looksLikePath =
        path.isAbsolute(trimmed) ||
        trimmed.includes(path.sep) ||
        trimmed.includes("/") ||
        trimmed.includes("\\") ||
        isJavaScriptPath(trimmed);

    if (looksLikePath) {
        if (!isFile(candidate)) {
            return {
                args: [],
                command: candidate,
                program: null,
                source,
                state: "error",
                message: `Could not execute the configured Claude runtime: ${candidate}`,
            };
        }

        return commandFromExistingPath(candidate, source);
    }

    const found = resolveFromPath(trimmed);
    if (!found) {
        return {
            args: [],
            command: trimmed,
            program: null,
            source,
            state: "missing",
            message: `Configured command was not found: ${trimmed}`,
        };
    }

    return commandFromExistingPath(found, source);
}

function commandFromExistingPath(
    candidatePath: string,
    source: AiRuntimeStatus["source"],
): ResolvedClaudeBinary {
    if (isJavaScriptPath(candidatePath)) {
        const nodePath = resolveFromPath("node");
        if (!nodePath) {
            return {
                args: [],
                command: candidatePath,
                program: null,
                source,
                state: "missing",
                message:
                    "Claude vendor JS was found, but `node` is missing from PATH.",
            };
        }

        return {
            args: [candidatePath],
            command: `${nodePath} ${candidatePath}`,
            program: nodePath,
            source,
            state: "ready",
            message: null,
        };
    }

    if (!isExecutableFile(candidatePath)) {
        return {
            args: [],
            command: candidatePath,
            program: null,
            source,
            state: "error",
            message: `Claude runtime is not executable: ${candidatePath}`,
        };
    }

    return {
        args: [],
        command: candidatePath,
        program: candidatePath,
        source,
        state: "ready",
        message: null,
    };
}

function getAppRoot(currentFilePath?: string): string {
    const currentFile = currentFilePath ?? fileURLToPath(import.meta.url);
    const searchRoots = [
        path.dirname(currentFile),
        process.cwd(),
        path.resolve(path.dirname(currentFile), "../../../../"),
    ];

    for (const candidate of searchRoots) {
        const resolved = findAppRoot(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return path.resolve(path.dirname(currentFile), "../../../../");
}

function getPackagedResourcesPath(): string | null {
    return typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : null;
}

function getBundledClaudeCandidate(
    appRoot: string,
    packagedResourcesPath: string | null,
): string {
    const executableName =
        process.platform === "win32"
            ? "claude-agent-acp.exe"
            : "claude-agent-acp";
    const repoCandidate = path.join(
        appRoot,
        "resources",
        "ai",
        "binaries",
        executableName,
    );
    if (isExecutableFile(repoCandidate)) {
        return repoCandidate;
    }

    if (!packagedResourcesPath) {
        return repoCandidate;
    }

    const packagedArchCandidate = getPackagedDarwinBinaryCandidate(
        packagedResourcesPath,
        executableName,
    );
    if (packagedArchCandidate) {
        return packagedArchCandidate;
    }

    return path.join(packagedResourcesPath, "ai", "binaries", executableName);
}

function getBundledClaudeVendorEntryPath(
    appRoot: string,
    packagedResourcesPath: string | null,
): string {
    const repoCandidate = path.join(
        appRoot,
        "resources",
        "ai",
        "embedded",
        "claude-agent-acp",
        "dist",
        "index.js",
    );
    if (isFile(repoCandidate)) {
        return repoCandidate;
    }

    if (!packagedResourcesPath) {
        return repoCandidate;
    }

    return path.join(
        packagedResourcesPath,
        "ai",
        "embedded",
        "claude-agent-acp",
        "dist",
        "index.js",
    );
}

function getBundledNodePath(
    appRoot: string,
    packagedResourcesPath: string | null,
): string {
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    const repoCandidate = path.join(
        appRoot,
        "resources",
        "ai",
        "embedded",
        "node",
        "bin",
        executableName,
    );
    if (isExecutableFile(repoCandidate)) {
        return repoCandidate;
    }

    if (!packagedResourcesPath) {
        return repoCandidate;
    }

    const packagedArchCandidate = getPackagedDarwinNodeCandidate(
        packagedResourcesPath,
        executableName,
    );
    if (packagedArchCandidate) {
        return packagedArchCandidate;
    }

    return path.join(
        packagedResourcesPath,
        "ai",
        "embedded",
        "node",
        "bin",
        executableName,
    );
}

function getPackagedDarwinBinaryCandidate(
    packagedResourcesPath: string,
    executableName: string,
): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    return path.join(
        packagedResourcesPath,
        "ai",
        "binaries",
        `darwin-${process.arch}`,
        executableName,
    );
}

function getPackagedDarwinNodeCandidate(
    packagedResourcesPath: string,
    executableName: string,
): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    return path.join(
        packagedResourcesPath,
        "ai",
        "embedded",
        "node",
        `darwin-${process.arch}`,
        "bin",
        executableName,
    );
}

function getVendorClaudeEntryPath(appRoot: string): string {
    return path.join(
        appRoot,
        "vendor",
        "Claude-agent-acp-upstream",
        "dist",
        "index.js",
    );
}

function findAppRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);

    while (true) {
        if (isAppRootDirectory(currentDir)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return null;
        }

        currentDir = parentDir;
    }
}

function isAppRootDirectory(candidate: string): boolean {
    return (
        fs.existsSync(path.join(candidate, "package.json")) &&
        fs.existsSync(path.join(candidate, "resources", "ai"))
    );
}

function isJavaScriptPath(candidatePath: string): boolean {
    const extension = path.extname(candidatePath).toLowerCase();
    return extension === ".js" || extension === ".mjs" || extension === ".cjs";
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

function isExecutableFile(candidatePath: string): boolean {
    try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch {
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
        `comando-claude-login-${Date.now()}.cmd`,
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
        `comando-claude-login-${Date.now()}.sh`,
    );
    const lines = [
        "#!/bin/sh",
        "set -e",
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
