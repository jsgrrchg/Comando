import type {
    AiAuthCredentialSource,
    AiAuthMethod,
    AiRuntimeStatus,
    CodexAuthMethodId,
    CodexRuntimeSettings,
} from "@shared/ipc";

import {
    buildSecretStorageKey,
    type SecretRecordPatch,
    type SecretStoreGateway,
} from "@main/ai/secret-store";

import { resolveCodexRuntime } from "@main/ai/resolver/runtime-resolver";

const CHATGPT_AUTH_METHOD_ID: CodexAuthMethodId = "chatgpt";
const CODEX_API_KEY_AUTH_METHOD_ID: CodexAuthMethodId = "codex-api-key";
const OPENAI_API_KEY_AUTH_METHOD_ID: CodexAuthMethodId = "openai-api-key";
const CODEX_API_KEY_SECRET = "codex_api_key";
const OPENAI_API_KEY_SECRET = "openai_api_key";

export interface CodexSecretBundle {
    readonly codexApiKey: string | null;
    readonly openaiApiKey: string | null;
}

export function getCodexRuntimeStatus(
    settings: CodexRuntimeSettings,
    secrets: CodexSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
): AiRuntimeStatus {
    const resolved = resolveCodexRuntime(settings);
    const authMethod = detectCodexAuthMethod(settings, secrets, env);
    const credentialSource = getCodexCredentialSource(
        settings,
        secrets,
        env,
    );
    const authReady = authMethod !== null;
    const binaryReady = resolved.status.state === "ready";

    let message = resolved.status.message;
    if (binaryReady && !authReady) {
        message = "Log in with ChatGPT or add an API key to finish setup.";
    }

    return {
        ...resolved.status,
        authMethod,
        authMethods: getCodexAuthMethods(),
        authReady,
        authCredentialSource: credentialSource,
        authCredentialSourceLabel:
            getCredentialSourceLabel(credentialSource),
        authSessionMessage:
            "This affects new sessions. Active sessions may keep using credentials loaded at launch.",
        canDisconnectAuth:
            settings.authMethod !== null ||
            Boolean(secrets.codexApiKey) ||
            Boolean(secrets.openaiApiKey),
        canLogoutAuth: settings.authMethod === CHATGPT_AUTH_METHOD_ID,
        message,
        onboardingRequired: !binaryReady || !authReady,
    };
}

export function getCodexCredentialSource(
    settings: CodexRuntimeSettings,
    secrets: CodexSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
): AiAuthCredentialSource {
    if (
        settings.authMethod === CODEX_API_KEY_AUTH_METHOD_ID &&
        envSecretPresent(env, "CODEX_API_KEY")
    ) {
        return "environment";
    }

    if (
        settings.authMethod === OPENAI_API_KEY_AUTH_METHOD_ID &&
        envSecretPresent(env, "OPENAI_API_KEY")
    ) {
        return "environment";
    }

    if (
        settings.authMethod === CODEX_API_KEY_AUTH_METHOD_ID &&
        Boolean(normalizeOptionalText(secrets.codexApiKey))
    ) {
        return "comando-secret";
    }

    if (
        settings.authMethod === OPENAI_API_KEY_AUTH_METHOD_ID &&
        Boolean(normalizeOptionalText(secrets.openaiApiKey))
    ) {
        return "comando-secret";
    }

    if (settings.authMethod === CHATGPT_AUTH_METHOD_ID) {
        return "external-runtime";
    }

    return "none";
}

export function getCodexAuthMethods(): readonly AiAuthMethod[] {
    const methods: AiAuthMethod[] = [];

    if (!process.env.NO_BROWSER?.trim()) {
        methods.push({
            description:
                "Open the Codex ChatGPT login flow to connect your paid ChatGPT account.",
            id: CHATGPT_AUTH_METHOD_ID,
            name: "ChatGPT account",
        });
    }

    methods.push(
        {
            description:
                "Use a Codex API key stored only for Comando on this machine.",
            id: CODEX_API_KEY_AUTH_METHOD_ID,
            name: "Codex API key",
        },
        {
            description:
                "Use an OpenAI API key stored only for Comando on this machine.",
            id: OPENAI_API_KEY_AUTH_METHOD_ID,
            name: "OpenAI API key",
        },
    );

    return methods;
}

export function loadCodexSecretBundle(
    secretStore: SecretStoreGateway,
): CodexSecretBundle {
    return {
        codexApiKey: secretStore.loadSecret("ai.codex", CODEX_API_KEY_SECRET),
        openaiApiKey: secretStore.loadSecret("ai.codex", OPENAI_API_KEY_SECRET),
    };
}

export function saveCodexSecrets(
    secretStore: SecretStoreGateway,
    input: CodexSecretBundle,
): {
    readonly hasCodexApiKey: boolean;
    readonly hasOpenAiApiKey: boolean;
} {
    const codexApiKey = normalizeOptionalText(input.codexApiKey);
    const openaiApiKey = normalizeOptionalText(input.openaiApiKey);
    const currentCodexApiKey = normalizeOptionalText(
        secretStore.loadSecret("ai.codex", CODEX_API_KEY_SECRET),
    );
    const currentOpenAiApiKey = normalizeOptionalText(
        secretStore.loadSecret("ai.codex", OPENAI_API_KEY_SECRET),
    );

    if (codexApiKey) {
        saveSecretIfChanged(
            secretStore,
            "ai.codex",
            CODEX_API_KEY_SECRET,
            currentCodexApiKey,
            codexApiKey,
        );
        saveSecretIfChanged(
            secretStore,
            "ai.codex",
            OPENAI_API_KEY_SECRET,
            currentOpenAiApiKey,
            null,
        );

        return {
            hasCodexApiKey: true,
            hasOpenAiApiKey: false,
        };
    }

    if (openaiApiKey) {
        saveSecretIfChanged(
            secretStore,
            "ai.codex",
            OPENAI_API_KEY_SECRET,
            currentOpenAiApiKey,
            openaiApiKey,
        );
        saveSecretIfChanged(
            secretStore,
            "ai.codex",
            CODEX_API_KEY_SECRET,
            currentCodexApiKey,
            null,
        );

        return {
            hasCodexApiKey: false,
            hasOpenAiApiKey: true,
        };
    }

    saveSecretIfChanged(
        secretStore,
        "ai.codex",
        CODEX_API_KEY_SECRET,
        currentCodexApiKey,
        null,
    );
    saveSecretIfChanged(
        secretStore,
        "ai.codex",
        OPENAI_API_KEY_SECRET,
        currentOpenAiApiKey,
        null,
    );

    return {
        hasCodexApiKey: false,
        hasOpenAiApiKey: false,
    };
}

export function buildCodexSecretPatches(
    secretStore: SecretStoreGateway,
    input: CodexSecretBundle,
): {
    readonly flags: {
        readonly hasCodexApiKey: boolean;
        readonly hasOpenAiApiKey: boolean;
    };
    readonly patches: readonly SecretRecordPatch[];
} {
    const codexApiKey = normalizeOptionalText(input.codexApiKey);
    const openaiApiKey = normalizeOptionalText(input.openaiApiKey);
    const currentCodexApiKey = normalizeOptionalText(
        secretStore.loadSecret("ai.codex", CODEX_API_KEY_SECRET),
    );
    const currentOpenAiApiKey = normalizeOptionalText(
        secretStore.loadSecret("ai.codex", OPENAI_API_KEY_SECRET),
    );
    const patches: SecretRecordPatch[] = [];

    if (codexApiKey) {
        pushSecretPatchIfChanged(
            patches,
            "ai.codex",
            CODEX_API_KEY_SECRET,
            currentCodexApiKey,
            codexApiKey,
        );
        pushSecretPatchIfChanged(
            patches,
            "ai.codex",
            OPENAI_API_KEY_SECRET,
            currentOpenAiApiKey,
            null,
        );
        return {
            flags: {
                hasCodexApiKey: true,
                hasOpenAiApiKey: false,
            },
            patches,
        };
    }

    if (openaiApiKey) {
        pushSecretPatchIfChanged(
            patches,
            "ai.codex",
            OPENAI_API_KEY_SECRET,
            currentOpenAiApiKey,
            openaiApiKey,
        );
        pushSecretPatchIfChanged(
            patches,
            "ai.codex",
            CODEX_API_KEY_SECRET,
            currentCodexApiKey,
            null,
        );
        return {
            flags: {
                hasCodexApiKey: false,
                hasOpenAiApiKey: true,
            },
            patches,
        };
    }

    pushSecretPatchIfChanged(
        patches,
        "ai.codex",
        CODEX_API_KEY_SECRET,
        currentCodexApiKey,
        null,
    );
    pushSecretPatchIfChanged(
        patches,
        "ai.codex",
        OPENAI_API_KEY_SECRET,
        currentOpenAiApiKey,
        null,
    );
    return {
        flags: {
            hasCodexApiKey: false,
            hasOpenAiApiKey: false,
        },
        patches,
    };
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

export function applyCodexAuthEnv(
    baseEnv: NodeJS.ProcessEnv,
    settings: CodexRuntimeSettings,
    secrets: CodexSecretBundle,
): NodeJS.ProcessEnv {
    const env = { ...baseEnv };
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;

    if (settings.authMethod === CODEX_API_KEY_AUTH_METHOD_ID) {
        const codexApiKey =
            normalizeOptionalText(baseEnv.CODEX_API_KEY) ??
            normalizeOptionalText(secrets.codexApiKey);
        if (codexApiKey) {
            env.CODEX_API_KEY = codexApiKey;
        }
    }

    if (settings.authMethod === OPENAI_API_KEY_AUTH_METHOD_ID) {
        const openAiApiKey =
            normalizeOptionalText(baseEnv.OPENAI_API_KEY) ??
            normalizeOptionalText(secrets.openaiApiKey);
        if (openAiApiKey) {
            env.OPENAI_API_KEY = openAiApiKey;
        }
    }

    return env;
}

export function detectCodexAuthMethod(
    settings: CodexRuntimeSettings,
    secrets: CodexSecretBundle,
    env: NodeJS.ProcessEnv = process.env,
): CodexAuthMethodId | null {
    if (settings.authMethod === CHATGPT_AUTH_METHOD_ID) {
        return CHATGPT_AUTH_METHOD_ID;
    }

    if (
        settings.authMethod === CODEX_API_KEY_AUTH_METHOD_ID &&
        codexApiKeyReady(secrets, env)
    ) {
        return CODEX_API_KEY_AUTH_METHOD_ID;
    }

    if (
        settings.authMethod === OPENAI_API_KEY_AUTH_METHOD_ID &&
        openAiApiKeyReady(secrets, env)
    ) {
        return OPENAI_API_KEY_AUTH_METHOD_ID;
    }

    return null;
}

export function isCodexAuthenticationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();

    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("login required")
    );
}

function codexApiKeyReady(
    secrets: CodexSecretBundle,
    env: NodeJS.ProcessEnv,
): boolean {
    return (
        envSecretPresent(env, "CODEX_API_KEY") ||
        Boolean(normalizeOptionalText(secrets.codexApiKey))
    );
}

function openAiApiKeyReady(
    secrets: CodexSecretBundle,
    env: NodeJS.ProcessEnv,
): boolean {
    return (
        envSecretPresent(env, "OPENAI_API_KEY") ||
        Boolean(normalizeOptionalText(secrets.openaiApiKey))
    );
}

function envSecretPresent(
    env: NodeJS.ProcessEnv,
    key: "CODEX_API_KEY" | "OPENAI_API_KEY",
): boolean {
    return Boolean(env[key]?.trim());
}

function getCredentialSourceLabel(source: AiAuthCredentialSource): string {
    switch (source) {
        case "comando-secret":
            return "Using Comando stored credentials";
        case "environment":
            return "Using environment variable";
        case "external-runtime":
            return "Using external runtime login";
        case "none":
        default:
            return "Needs authentication";
    }
}

function normalizeOptionalText(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}
