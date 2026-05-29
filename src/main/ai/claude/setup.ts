import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
    AiAuthCredentialSource,
    AiAuthMethod,
    AiRuntimeStatus,
    ClaudeAuthMethodId,
    ClaudeRuntimeSettings,
} from "@shared/ipc";

import {
    buildSecretStorageKey,
    type SecretRecordPatch,
    type SecretStoreGateway,
} from "@main/ai/secret-store";
import { launchTerminalLoginCommand } from "@main/ai/auth/terminal-login";
import { debugBenignError } from "@main/observability/logging";

const CLAUDE_LOGIN_METHOD_ID = "claude-login";
const CLAUDE_AI_LOGIN_METHOD_ID = "claude-ai-login";
const CONSOLE_LOGIN_METHOD_ID = "console-login";
const ANTHROPIC_API_KEY_METHOD_ID = "anthropic-api-key";
const GATEWAY_METHOD_ID = "gateway";
const BEDROCK_GATEWAY_METHOD_ID = "gateway-bedrock";
const REMOTE_CLAUDE_AUTH_ENV_VARS = [
    "NO_BROWSER",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    "CLAUDE_CODE_REMOTE",
] as const;
const ANTHROPIC_API_KEY_SECRET = "anthropic_api_key";
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
    readonly anthropicApiKey: string | null;
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
    const externalApiKeyPresent = envSecretPresent(
        process.env,
        "ANTHROPIC_API_KEY",
    );
    const externalTokenPresent = envSecretPresent(
        process.env,
        "ANTHROPIC_AUTH_TOKEN",
    );
    const externalHeadersPresent = envSecretPresent(
        process.env,
        "ANTHROPIC_CUSTOM_HEADERS",
    );
    const externalBaseUrlPresent = envSecretPresent(
        process.env,
        "ANTHROPIC_BASE_URL",
    );
    const externalBedrockBaseUrlPresent = envSecretPresent(
        process.env,
        "ANTHROPIC_BEDROCK_BASE_URL",
    );
    const gatewayIssue = externalBaseUrlPresent
        ? null
        : gatewayValidationError(settings);
    const bedrockGatewayIssue = externalBedrockBaseUrlPresent
        ? null
        : bedrockGatewayValidationError(settings);
    const authMethod = detectClaudeAuthMethod(
        settings,
        secretStore,
        process.env,
    );
    const binaryReady = resolved.state === "ready" && Boolean(resolved.program);
    const hasCustomBinaryPath = Boolean(settings.binaryPath?.trim());
    const authMethods = getClaudeAuthMethods();
    const secretBundle = loadClaudeSecretBundle(secretStore);
    const anthropicApiKeyReady =
        externalApiKeyPresent || Boolean(secretBundle.anthropicApiKey);
    const gatewayCredentialsReady =
        externalTokenPresent ||
        externalHeadersPresent ||
        Boolean(
            secretBundle.anthropicAuthToken ||
                secretBundle.anthropicCustomHeaders,
        );
    const hasCustomGatewayUrl =
        externalBaseUrlPresent || Boolean(settings.gatewayBaseUrl?.trim());
    const hasBedrockGatewayUrl =
        externalBedrockBaseUrlPresent ||
        Boolean(settings.bedrockGatewayBaseUrl?.trim());
    const customGatewayReady =
        gatewayIssue === null && hasCustomGatewayUrl && gatewayCredentialsReady;
    const bedrockGatewayReady =
        bedrockGatewayIssue === null && hasBedrockGatewayUrl;
    const authReady =
        authMethod !== null &&
        (authMethod === ANTHROPIC_API_KEY_METHOD_ID
            ? anthropicApiKeyReady
            : authMethod === GATEWAY_METHOD_ID
              ? customGatewayReady
              : authMethod === BEDROCK_GATEWAY_METHOD_ID
                ? bedrockGatewayReady
                : true);
    const hasGatewayUrl = hasCustomGatewayUrl || hasBedrockGatewayUrl;
    const hasGatewayConfig = customGatewayReady || bedrockGatewayReady;
    const credentialSource = getClaudeCredentialSource(
        authMethod,
        secretBundle,
        process.env,
        settings,
    );
    const storageStatus = secretStore.getStorageStatus?.() ?? {
        encryptionAvailable: true,
        isWeakBackend: false,
        message: null,
        platform: process.platform,
        selectedBackend: null,
    };

    let message = resolved.message;
    if (binaryReady) {
        if (authMethod === GATEWAY_METHOD_ID && !authReady && gatewayIssue) {
            message = gatewayIssue;
        } else if (
            authMethod === BEDROCK_GATEWAY_METHOD_ID &&
            !authReady &&
            bedrockGatewayIssue
        ) {
            message = bedrockGatewayIssue;
        } else if (!authReady) {
            if (authMethod === ANTHROPIC_API_KEY_METHOD_ID) {
                message = "Add an Anthropic API key to finish Claude setup.";
            } else if (authMethod === GATEWAY_METHOD_ID) {
                message =
                    "Claude gateway needs a URL plus an auth token or custom headers before it can be used.";
            } else if (authMethod === BEDROCK_GATEWAY_METHOD_ID) {
                message =
                    "Claude Bedrock gateway needs a base URL before it can be used.";
            } else {
                message =
                    "Log in with Claude or configure a Claude credential to finish setup.";
            }
        } else if (authMethod === ANTHROPIC_API_KEY_METHOD_ID) {
            message = "Claude API key setup is ready.";
        } else if (authMethod === GATEWAY_METHOD_ID) {
            message = "Claude gateway setup is ready.";
        } else if (authMethod === BEDROCK_GATEWAY_METHOD_ID) {
            message = "Claude Bedrock gateway setup is ready.";
        }
    }

    return {
        authMethod,
        authMethods,
        authReady,
        authCredentialSource: credentialSource,
        authCredentialSourceLabel:
            getCredentialSourceLabel(credentialSource),
        authSessionMessage:
            "This affects new sessions. Active sessions may keep using credentials loaded at launch.",
        authStorageMessage: storageStatus.message,
        canDisconnectAuth:
            settings.authMethod !== null ||
            Boolean(secretBundle.anthropicApiKey) ||
            Boolean(secretBundle.anthropicAuthToken) ||
            Boolean(secretBundle.anthropicCustomHeaders) ||
            (credentialSource !== "environment" && authMethod !== null),
        canLogoutAuth: false,
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
        anthropicApiKey: secretStore.loadSecret(
            "ai.claude",
            ANTHROPIC_API_KEY_SECRET,
        ),
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

export function getClaudeCredentialSource(
    authMethod: ClaudeAuthMethodId | null,
    secrets: ClaudeSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
    settings?: ClaudeRuntimeSettings,
): AiAuthCredentialSource {
    if (
        authMethod === ANTHROPIC_API_KEY_METHOD_ID &&
        envSecretPresent(env, "ANTHROPIC_API_KEY")
    ) {
        return "environment";
    }

    if (
        authMethod === BEDROCK_GATEWAY_METHOD_ID &&
        envSecretPresent(env, "ANTHROPIC_BEDROCK_BASE_URL")
    ) {
        return "environment";
    }

    if (
        authMethod === GATEWAY_METHOD_ID &&
        (envSecretPresent(env, "ANTHROPIC_BASE_URL") ||
            envSecretPresent(env, "ANTHROPIC_AUTH_TOKEN") ||
            envSecretPresent(env, "ANTHROPIC_CUSTOM_HEADERS"))
    ) {
        return "environment";
    }

    if (
        authMethod === ANTHROPIC_API_KEY_METHOD_ID &&
        secrets.anthropicApiKey
    ) {
        return "comando-secret";
    }

    if (
        authMethod === GATEWAY_METHOD_ID &&
        (secrets.anthropicAuthToken || secrets.anthropicCustomHeaders)
    ) {
        return "comando-secret";
    }

    if (
        authMethod === BEDROCK_GATEWAY_METHOD_ID &&
        settings?.bedrockGatewayBaseUrl?.trim()
    ) {
        return "comando-secret";
    }

    if (
        authMethod === CLAUDE_LOGIN_METHOD_ID ||
        authMethod === CLAUDE_AI_LOGIN_METHOD_ID ||
        authMethod === CONSOLE_LOGIN_METHOD_ID
    ) {
        return "external-runtime";
    }

    return "none";
}

export function saveClaudeSecrets(
    secretStore: SecretStoreGateway,
    input: {
        readonly anthropicApiKey: string | null;
        readonly gatewayAuthToken: string | null;
        readonly gatewayCustomHeaders: string | null;
    },
): {
    readonly hasAnthropicApiKey: boolean;
    readonly hasGatewayAuthToken: boolean;
    readonly hasGatewayCustomHeaders: boolean;
} {
    const anthropicApiKey = normalizeOptionalText(input.anthropicApiKey);
    const gatewayCustomHeaders = normalizeGatewayCustomHeaders(
        input.gatewayCustomHeaders,
    );
    saveSecretIfChanged(
        secretStore,
        "ai.claude",
        ANTHROPIC_API_KEY_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret("ai.claude", ANTHROPIC_API_KEY_SECRET),
        ),
        anthropicApiKey,
    );
    saveSecretIfChanged(
        secretStore,
        "ai.claude",
        CLAUDE_AUTH_TOKEN_SECRET,
        normalizeOptionalText(
            secretStore.loadSecret("ai.claude", CLAUDE_AUTH_TOKEN_SECRET),
        ),
        normalizeOptionalText(input.gatewayAuthToken),
    );
    saveSecretIfChanged(
        secretStore,
        "ai.claude",
        CLAUDE_CUSTOM_HEADERS_SECRET,
        normalizeGatewayCustomHeaders(
            secretStore.loadSecret(
                "ai.claude",
                CLAUDE_CUSTOM_HEADERS_SECRET,
            ),
        ),
        gatewayCustomHeaders,
    );

    return {
        hasAnthropicApiKey: Boolean(anthropicApiKey),
        hasGatewayAuthToken: Boolean(input.gatewayAuthToken?.trim()),
        hasGatewayCustomHeaders: Boolean(gatewayCustomHeaders),
    };
}

export function buildClaudeSecretPatches(
    secretStore: SecretStoreGateway,
    input: {
        readonly anthropicApiKey?: string | null;
        readonly gatewayAuthToken?: string | null;
        readonly gatewayCustomHeaders?: string | null;
    },
): {
    readonly flags: {
        readonly hasAnthropicApiKey: boolean;
        readonly hasGatewayAuthToken: boolean;
        readonly hasGatewayCustomHeaders: boolean;
    };
    readonly patches: readonly SecretRecordPatch[];
} {
    const currentAnthropicApiKey = normalizeOptionalText(
        secretStore.loadSecret("ai.claude", ANTHROPIC_API_KEY_SECRET),
    );
    const currentGatewayAuthToken = normalizeOptionalText(
        secretStore.loadSecret("ai.claude", CLAUDE_AUTH_TOKEN_SECRET),
    );
    const currentGatewayCustomHeaders = safeNormalizeExistingGatewayCustomHeaders(
        secretStore.loadSecret("ai.claude", CLAUDE_CUSTOM_HEADERS_SECRET),
    );
    const anthropicApiKey =
        input.anthropicApiKey === undefined
            ? currentAnthropicApiKey
            : normalizeOptionalText(input.anthropicApiKey);
    const gatewayAuthToken =
        input.gatewayAuthToken === undefined
            ? currentGatewayAuthToken
            : normalizeOptionalText(input.gatewayAuthToken);
    const gatewayCustomHeaders =
        input.gatewayCustomHeaders === undefined
            ? currentGatewayCustomHeaders
            : normalizeGatewayCustomHeaders(input.gatewayCustomHeaders);
    const patches: SecretRecordPatch[] = [];

    pushSecretPatchIfChanged(
        patches,
        "ai.claude",
        ANTHROPIC_API_KEY_SECRET,
        currentAnthropicApiKey,
        anthropicApiKey,
    );
    pushSecretPatchIfChanged(
        patches,
        "ai.claude",
        CLAUDE_AUTH_TOKEN_SECRET,
        currentGatewayAuthToken,
        gatewayAuthToken,
    );
    pushSecretPatchIfChanged(
        patches,
        "ai.claude",
        CLAUDE_CUSTOM_HEADERS_SECRET,
        currentGatewayCustomHeaders,
        gatewayCustomHeaders,
    );

    return {
        flags: {
            hasAnthropicApiKey: Boolean(anthropicApiKey),
            hasGatewayAuthToken: Boolean(gatewayAuthToken),
            hasGatewayCustomHeaders: Boolean(gatewayCustomHeaders),
        },
        patches,
    };
}

export function normalizeGatewayCustomHeaders(
    raw: string | null,
): string | null {
    const trimmed = raw?.trim() ?? "";
    if (!trimmed) {
        return null;
    }

    if (trimmed.length > 16_384) {
        throw new Error("Gateway custom headers are too large.");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error("Gateway custom headers must be valid JSON.");
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            "Gateway custom headers must be a JSON object with string values.",
        );
    }

    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
        const headerName = name.trim();
        if (!headerName) {
            throw new Error("Gateway custom header names cannot be empty.");
        }
        if (/[\r\n]/u.test(headerName)) {
            throw new Error(
                "Gateway custom header names cannot contain line breaks.",
            );
        }
        if (
            ["authorization", "host", "content-length"].includes(
                headerName.toLowerCase(),
            )
        ) {
            throw new Error(
                `Gateway custom header \`${headerName}\` is managed by the runtime and cannot be set here.`,
            );
        }
        if (typeof value !== "string") {
            throw new Error(
                "Gateway custom headers must use string values only.",
            );
        }
        if (/[\r\n]/u.test(value)) {
            throw new Error(
                "Gateway custom header values cannot contain line breaks.",
            );
        }
        normalized[headerName] = value;
    }

    if (Object.keys(normalized).length === 0) {
        return null;
    }

    return JSON.stringify(
        Object.fromEntries(
            Object.entries(normalized).sort(([a], [b]) =>
                a.localeCompare(b),
            ),
        ),
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

function safeNormalizeExistingGatewayCustomHeaders(
    value: string | null,
): string | null {
    try {
        return normalizeGatewayCustomHeaders(value);
    } catch {
        return normalizeOptionalText(value);
    }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

export function applyClaudeAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: ClaudeRuntimeSettings,
    secretStore: SecretStoreGateway,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };
    const secrets = loadClaudeSecretBundle(secretStore);
    const authMethod = detectClaudeAuthMethod(settings, secretStore, env);
    const externalApiKeyPresent = envSecretPresent(env, "ANTHROPIC_API_KEY");
    const externalTokenPresent = envSecretPresent(env, "ANTHROPIC_AUTH_TOKEN");
    const externalHeadersPresent = envSecretPresent(
        env,
        "ANTHROPIC_CUSTOM_HEADERS",
    );
    const externalBaseUrlPresent = envSecretPresent(env, "ANTHROPIC_BASE_URL");
    const externalBedrockBaseUrlPresent = envSecretPresent(
        env,
        "ANTHROPIC_BEDROCK_BASE_URL",
    );
    const externalAwsBearerTokenBedrockPresent = envSecretPresent(
        env,
        "AWS_BEARER_TOKEN_BEDROCK",
    );
    const shouldApplyApiKeySecret =
        authMethod === ANTHROPIC_API_KEY_METHOD_ID &&
        !externalApiKeyPresent &&
        Boolean(secrets.anthropicApiKey);
    const policy = gatewayEnvPolicy(
        settings,
        externalBaseUrlPresent,
        authMethod,
    );
    const managedBedrockBaseUrl =
        authMethod === BEDROCK_GATEWAY_METHOD_ID &&
        !externalBedrockBaseUrlPresent
            ? validatedBedrockGatewayUrl(settings)
            : null;

    if (shouldApplyApiKeySecret && secrets.anthropicApiKey) {
        env.ANTHROPIC_API_KEY = secrets.anthropicApiKey;
    } else if (!externalApiKeyPresent) {
        delete env.ANTHROPIC_API_KEY;
    }

    if (managedBedrockBaseUrl) {
        env.ANTHROPIC_BEDROCK_BASE_URL = managedBedrockBaseUrl;
        env.CLAUDE_CODE_USE_BEDROCK = "1";
        if (!externalAwsBearerTokenBedrockPresent) {
            env.AWS_BEARER_TOKEN_BEDROCK = " ";
        }

        if (!externalBaseUrlPresent) {
            delete env.ANTHROPIC_BASE_URL;
        }
        if (!externalTokenPresent) {
            delete env.ANTHROPIC_AUTH_TOKEN;
        }
        if (!externalHeadersPresent) {
            if (secrets.anthropicCustomHeaders) {
                env.ANTHROPIC_CUSTOM_HEADERS =
                    secrets.anthropicCustomHeaders;
            } else {
                delete env.ANTHROPIC_CUSTOM_HEADERS;
            }
        }

        return env;
    }

    if (
        authMethod === BEDROCK_GATEWAY_METHOD_ID &&
        externalBedrockBaseUrlPresent &&
        !envSecretPresent(env, "CLAUDE_CODE_USE_BEDROCK")
    ) {
        env.CLAUDE_CODE_USE_BEDROCK = "1";
    }
    if (
        authMethod === BEDROCK_GATEWAY_METHOD_ID &&
        externalBedrockBaseUrlPresent &&
        !externalAwsBearerTokenBedrockPresent
    ) {
        env.AWS_BEARER_TOKEN_BEDROCK = " ";
    }

    if (policy.managedBaseUrl) {
        env.ANTHROPIC_BASE_URL = policy.managedBaseUrl;
        delete env.ANTHROPIC_BEDROCK_BASE_URL;
        delete env.CLAUDE_CODE_USE_BEDROCK;
        delete env.AWS_BEARER_TOKEN_BEDROCK;

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
                "Use an Anthropic API key stored only for Comando on this machine.",
            id: ANTHROPIC_API_KEY_METHOD_ID,
            name: "Anthropic API key",
        },
        {
            description:
                "Use a custom Anthropic-compatible gateway just for Comando.",
            id: GATEWAY_METHOD_ID,
            name: "Custom gateway",
        },
        {
            description:
                "Use a custom Bedrock-compatible Claude gateway just for Comando.",
            id: BEDROCK_GATEWAY_METHOD_ID,
            name: "Bedrock gateway",
        },
    ];
}

export function detectClaudeAuthMethod(
    settings: ClaudeRuntimeSettings,
    secretStoreOrEnv?: SecretStoreGateway | NodeJS.ProcessEnv | null,
    env: NodeJS.ProcessEnv = process.env,
): ClaudeAuthMethodId | null {
    let secretStore: SecretStoreGateway | null = null;
    let resolvedEnv = env;

    if (isSecretStoreGateway(secretStoreOrEnv)) {
        secretStore = secretStoreOrEnv;
    } else if (secretStoreOrEnv) {
        resolvedEnv = secretStoreOrEnv;
    }

    const secrets = secretStore ? loadClaudeSecretBundle(secretStore) : null;

    if (envSecretPresent(resolvedEnv, "ANTHROPIC_BEDROCK_BASE_URL")) {
        return BEDROCK_GATEWAY_METHOD_ID;
    }

    if (envSecretPresent(resolvedEnv, "ANTHROPIC_BASE_URL")) {
        return GATEWAY_METHOD_ID;
    }

    if (envSecretPresent(resolvedEnv, "ANTHROPIC_API_KEY")) {
        return ANTHROPIC_API_KEY_METHOD_ID;
    }

    const normalized = normalizeClaudeAuthMethodId(settings.authMethod);
    if (normalized === ANTHROPIC_API_KEY_METHOD_ID) {
        return secrets?.anthropicApiKey || settings.hasAnthropicApiKey
            ? ANTHROPIC_API_KEY_METHOD_ID
            : null;
    }

    if (normalized === GATEWAY_METHOD_ID) {
        const gatewayReady =
            (envSecretPresent(resolvedEnv, "ANTHROPIC_BASE_URL") ||
                validatedGatewayUrl(settings) !== null) &&
            (Boolean(secrets?.anthropicAuthToken) ||
                Boolean(secrets?.anthropicCustomHeaders) ||
                settings.hasGatewayAuthToken ||
                settings.hasGatewayCustomHeaders);

        return gatewayReady ? GATEWAY_METHOD_ID : null;
    }

    if (normalized === BEDROCK_GATEWAY_METHOD_ID) {
        return validatedBedrockGatewayUrl(settings) !== null
            ? BEDROCK_GATEWAY_METHOD_ID
            : null;
    }

    if (normalized && claudeLoginAvailable(settings)) {
        return projectTerminalAuthMethodId(normalized);
    }

    if (secrets?.anthropicApiKey || settings.hasAnthropicApiKey) {
        return ANTHROPIC_API_KEY_METHOD_ID;
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

export function isClaudeAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("login required") ||
        normalized.includes("please run `claude login`") ||
        normalized.includes("invalid api key") ||
        normalized.includes("401") ||
        normalized.includes("unauthorized")
    );
}

export function launchClaudeLogin(
    resolved: ResolvedClaudeRuntimeCommand,
    methodId: string,
    cwd?: string | null,
): Promise<void> {
    const loginArgs = getClaudeLoginArgs(methodId);
    const commandParts = [resolved.program, ...resolved.args, ...loginArgs];

    return launchTerminalLoginCommand({
        commandParts,
        cwd,
        exitOnCommandError: true,
        missingTerminalMessage:
            "No compatible terminal launcher was found for Claude login.",
        scriptPrefix: "comando-claude-login",
    });
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

export function bedrockGatewayValidationError(
    settings: ClaudeRuntimeSettings,
): string | null {
    try {
        validatedBedrockGatewayUrl(settings);
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
    authMethod: ClaudeAuthMethodId | null,
): GatewayEnvPolicy {
    if (externalBaseUrlPresent) {
        return {
            allowSecretBundle: authMethod === GATEWAY_METHOD_ID,
            managedBaseUrl: null,
        };
    }

    const managedBaseUrl =
        authMethod === GATEWAY_METHOD_ID
            ? validatedGatewayUrl(settings)
            : null;
    const invalidManagedGateway =
        authMethod === GATEWAY_METHOD_ID &&
        settings.gatewayBaseUrl !== null &&
        managedBaseUrl === null;

    return {
        allowSecretBundle:
            authMethod === GATEWAY_METHOD_ID && !invalidManagedGateway,
        managedBaseUrl,
    };
}

function validatedGatewayUrl(settings: ClaudeRuntimeSettings): string | null {
    return validatedGatewayBaseUrl(settings.gatewayBaseUrl);
}

function validatedBedrockGatewayUrl(
    settings: ClaudeRuntimeSettings,
): string | null {
    return validatedGatewayBaseUrl(settings.bedrockGatewayBaseUrl);
}

function validatedGatewayBaseUrl(rawValue: string | null): string | null {
    const raw = rawValue?.trim() ?? "";
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

        throw new Error(INVALID_GATEWAY_URL_MESSAGE, {
            cause: error,
        });
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
        case null:
            return null;
        case ANTHROPIC_API_KEY_METHOD_ID:
        case CLAUDE_LOGIN_METHOD_ID:
        case CLAUDE_AI_LOGIN_METHOD_ID:
        case CONSOLE_LOGIN_METHOD_ID:
        case GATEWAY_METHOD_ID:
        case BEDROCK_GATEWAY_METHOD_ID:
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
    } catch (error) {
        debugBenignError("ai.claude.getFileModifiedAtMs", error);
        return null;
    }
}

function getClaudeLoginArgs(methodId: string): readonly string[] {
    switch (normalizeClaudeAuthMethodId(methodId)) {
        case null:
        case ANTHROPIC_API_KEY_METHOD_ID:
        case GATEWAY_METHOD_ID:
        case BEDROCK_GATEWAY_METHOD_ID:
            throw new Error(`Unsupported Claude auth method: ${methodId}`);
        case CLAUDE_LOGIN_METHOD_ID:
            return ["--cli"];
        case CLAUDE_AI_LOGIN_METHOD_ID:
            return ["--cli", "auth", "login", "--claudeai"];
        case CONSOLE_LOGIN_METHOD_ID:
            return ["--cli", "auth", "login", "--console"];
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

    for (;;) {
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
    } catch (error) {
        debugBenignError("ai.claude.isExecutableFile", error);
        return false;
    }
}

function isFile(candidatePath: string): boolean {
    try {
        return fs.statSync(candidatePath).isFile();
    } catch (error) {
        debugBenignError("ai.claude.isFile", error);
        return false;
    }
}

function envSecretPresent(env: NodeJS.ProcessEnv, key: string): boolean {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
}

function isSecretStoreGateway(
    value: SecretStoreGateway | NodeJS.ProcessEnv | null | undefined,
): value is SecretStoreGateway {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Partial<SecretStoreGateway>).loadSecret ===
            "function"
    );
}

function getCredentialSourceLabel(source: AiAuthCredentialSource): string {
    switch (source) {
        case "comando-secret":
            return "Using Comando gateway credentials";
        case "environment":
            return "Using Anthropic environment variables";
        case "external-runtime":
            return "Using external Claude login";
        case "none":
        default:
            return "Needs authentication";
    }
}
