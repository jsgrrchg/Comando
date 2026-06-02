export const AI_PROVIDER_IDS = [
    "codex",
    "claude",
    "gemini",
    "grok",
    "kilo",
    "opencode",
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type CodexProviderAuthMethodId =
    | "chatgpt"
    | "codex-api-key"
    | "openai-api-key";

export type ClaudeProviderAuthMethodId =
    | "claude-ai-login"
    | "claude-login"
    | "console-login"
    | "anthropic-api-key"
    | "gateway"
    | "gateway-bedrock";

export type GeminiProviderAuthMethodId = "login_with_google" | "use_gemini";

export type GrokProviderAuthMethodId = "grok-login" | "xai-api-key";

export type KiloProviderAuthMethodId = "kilo-login" | "kilo-api-key";

export type OpenCodeProviderAuthMethodId = "opencode-login";

export interface AiProviderAuthMethodById {
    readonly codex: CodexProviderAuthMethodId;
    readonly claude: ClaudeProviderAuthMethodId;
    readonly gemini: GeminiProviderAuthMethodId;
    readonly grok: GrokProviderAuthMethodId;
    readonly kilo: KiloProviderAuthMethodId;
    readonly opencode: OpenCodeProviderAuthMethodId;
}

export type AiProviderAuthMethodId =
    AiProviderAuthMethodById[AiProviderId];

export type AiProviderCredentialSource = string;

export type AiProviderRuntimeState = string;

export interface AiProviderAuthMethodOption {
    readonly description: string;
    readonly id: string;
    readonly name: string;
}

export interface AiProviderRuntimeStatus {
    readonly authCredentialSource?: AiProviderCredentialSource;
    readonly authCredentialSourceLabel?: string;
    readonly authMethod?: string | null;
    readonly authMethods?: readonly AiProviderAuthMethodOption[];
    readonly authReady?: boolean;
    readonly authSessionMessage?: string | null;
    readonly authStorageMessage?: string | null;
    readonly canDisconnectAuth?: boolean;
    readonly canLogoutAuth?: boolean;
    readonly checkedAt?: string | null;
    readonly command?: string | null;
    readonly hasCustomBinaryPath?: boolean;
    readonly hasGatewayConfig?: boolean;
    readonly hasGatewayUrl?: boolean;
    readonly message?: string | null;
    readonly onboardingRequired?: boolean;
    readonly runtimeId?: AiProviderId;
    readonly source?: string | null;
    readonly state?: AiProviderRuntimeState;
}

export type AiProviderSecretPatch =
    | {
          readonly kind: "clear";
      }
    | {
          readonly kind: "set";
          readonly value: string;
      }
    | {
          readonly kind: "unchanged";
      };

export interface AiProviderSecretDraft {
    readonly clear: boolean;
    readonly value: string;
}

export interface CodexProviderSettings {
    readonly authMethod?: CodexProviderAuthMethodId | null;
    readonly binaryPath?: string | null;
    readonly hasCodexApiKey?: boolean;
    readonly hasOpenAiApiKey?: boolean;
}

export interface CodexProviderSettingsInput {
    readonly authMethod: CodexProviderAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly codexApiKey: AiProviderSecretPatch;
    readonly openaiApiKey: AiProviderSecretPatch;
}

export interface ClaudeProviderSettings {
    readonly authInvalidatedAtMs?: number | null;
    readonly authMethod?: ClaudeProviderAuthMethodId | null;
    readonly bedrockGatewayBaseUrl?: string | null;
    readonly binaryPath?: string | null;
    readonly gatewayBaseUrl?: string | null;
    readonly hasAnthropicApiKey?: boolean;
    readonly hasGatewayAuthToken?: boolean;
    readonly hasGatewayCustomHeaders?: boolean;
}

export interface ClaudeProviderSettingsInput {
    readonly anthropicApiKey: AiProviderSecretPatch;
    readonly authMethod: ClaudeProviderAuthMethodId | null;
    readonly bedrockGatewayBaseUrl: string | null;
    readonly binaryPath: string | null;
    readonly gatewayAuthToken: AiProviderSecretPatch;
    readonly gatewayBaseUrl: string | null;
    readonly gatewayCustomHeaders: AiProviderSecretPatch;
}

export interface GeminiProviderSettings {
    readonly authInvalidatedAtMs?: number | null;
    readonly authMethod?: GeminiProviderAuthMethodId | null;
    readonly binaryPath?: string | null;
    readonly googleCloudLocation?: string | null;
    readonly googleCloudProject?: string | null;
    readonly hasGeminiApiKey?: boolean;
    readonly hasGoogleApiKey?: boolean;
}

export interface GeminiProviderSettingsInput {
    readonly authMethod: GeminiProviderAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly geminiApiKey: AiProviderSecretPatch;
    readonly googleApiKey: AiProviderSecretPatch;
    readonly googleCloudLocation: string | null;
    readonly googleCloudProject: string | null;
}

export interface GrokProviderSettings {
    readonly authInvalidatedAtMs?: number | null;
    readonly authMethod?: GrokProviderAuthMethodId | null;
    readonly binaryPath?: string | null;
    readonly hasXaiApiKey?: boolean;
}

export interface GrokProviderSettingsInput {
    readonly authMethod: GrokProviderAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly xaiApiKey: AiProviderSecretPatch;
}

export interface KiloProviderSettings {
    readonly authInvalidatedAtMs?: number | null;
    readonly authMethod?: KiloProviderAuthMethodId | null;
    readonly binaryPath?: string | null;
    readonly hasKiloApiKey?: boolean;
}

export interface KiloProviderSettingsInput {
    readonly authMethod: KiloProviderAuthMethodId | null;
    readonly binaryPath: string | null;
    readonly kiloApiKey: AiProviderSecretPatch;
}

export interface OpenCodeProviderSettings {
    readonly authInvalidatedAtMs?: number | null;
    readonly authMethod?: OpenCodeProviderAuthMethodId | null;
    readonly binaryPath?: string | null;
}

export interface OpenCodeProviderSettingsInput {
    readonly authMethod: OpenCodeProviderAuthMethodId | null;
    readonly binaryPath: string | null;
}

export interface AiProviderRuntimeSettingsById {
    readonly codex: CodexProviderSettings;
    readonly claude: ClaudeProviderSettings;
    readonly gemini: GeminiProviderSettings;
    readonly grok: GrokProviderSettings;
    readonly kilo: KiloProviderSettings;
    readonly opencode: OpenCodeProviderSettings;
}

export interface AiProviderRuntimeSettingsInputById {
    readonly codex: CodexProviderSettingsInput;
    readonly claude: ClaudeProviderSettingsInput;
    readonly gemini: GeminiProviderSettingsInput;
    readonly grok: GrokProviderSettingsInput;
    readonly kilo: KiloProviderSettingsInput;
    readonly opencode: OpenCodeProviderSettingsInput;
}

export type AiProviderRuntimeSettingsMap = Partial<{
    readonly [K in AiProviderId]: AiProviderRuntimeSettingsById[K];
}>;

export type AiProviderRuntimeStatusMap = Partial<
    Record<AiProviderId, AiProviderRuntimeStatus | null>
>;

export type AiProviderRuntimeSettingsInput =
    AiProviderRuntimeSettingsInputById[AiProviderId];

export interface AiProviderDiagnosticEntry {
    readonly details?: string | null;
    readonly id: string;
    readonly label: string;
    readonly message?: string | null;
    readonly providerId?: AiProviderId | null;
    readonly status: "error" | "ok" | "pending" | "warning";
}

export interface AiProviderDiagnosticsState {
    readonly entries: readonly AiProviderDiagnosticEntry[];
    readonly error?: string | null;
    readonly loading?: boolean;
    readonly updatedAt?: string | null;
}

export interface AiProviderMethodDefinition<
    TMethodId extends AiProviderAuthMethodId = AiProviderAuthMethodId,
> {
    readonly description: string;
    readonly id: TMethodId;
    readonly label: string;
    readonly terminalAuth: boolean;
}

export interface AiProviderDefinition<TProviderId extends AiProviderId> {
    readonly defaultMethodId: AiProviderAuthMethodById[TProviderId];
    readonly description: string;
    readonly envVars: readonly string[];
    readonly id: TProviderId;
    readonly methods: readonly AiProviderMethodDefinition<
        AiProviderAuthMethodById[TProviderId]
    >[];
    readonly name: string;
}

export const AI_PROVIDER_DEFINITIONS = {
    codex: {
        defaultMethodId: "chatgpt",
        description: "OpenAI Codex runtime for workspace automation.",
        envVars: ["OPENAI_API_KEY", "CODEX_API_KEY"],
        id: "codex",
        methods: [
            {
                description: "Use the Codex CLI ChatGPT account flow.",
                id: "chatgpt",
                label: "ChatGPT login",
                terminalAuth: true,
            },
            {
                description: "Store a Codex API key in Comando secure storage.",
                id: "codex-api-key",
                label: "Codex API key",
                terminalAuth: false,
            },
            {
                description: "Store an OpenAI API key in Comando secure storage.",
                id: "openai-api-key",
                label: "OpenAI API key",
                terminalAuth: false,
            },
        ],
        name: "Codex",
    },
    claude: {
        defaultMethodId: "claude-ai-login",
        description: "Claude runtime with first-party login, API key, or gateway.",
        envVars: ["ANTHROPIC_API_KEY"],
        id: "claude",
        methods: [
            {
                description: "Use Claude AI account sign-in from the CLI.",
                id: "claude-ai-login",
                label: "Claude AI login",
                terminalAuth: true,
            },
            {
                description: "Use the standard Claude CLI login flow.",
                id: "claude-login",
                label: "Claude login",
                terminalAuth: true,
            },
            {
                description: "Use the console login flow exposed by Claude.",
                id: "console-login",
                label: "Console login",
                terminalAuth: true,
            },
            {
                description: "Store an Anthropic API key in Comando secure storage.",
                id: "anthropic-api-key",
                label: "Anthropic API key",
                terminalAuth: false,
            },
            {
                description: "Route Claude through a custom gateway URL.",
                id: "gateway",
                label: "Custom gateway",
                terminalAuth: false,
            },
            {
                description: "Route Claude through a Bedrock-compatible gateway.",
                id: "gateway-bedrock",
                label: "Bedrock gateway",
                terminalAuth: false,
            },
        ],
        name: "Claude",
    },
    gemini: {
        defaultMethodId: "login_with_google",
        description: "Gemini runtime with Google login or API key credentials.",
        envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        id: "gemini",
        methods: [
            {
                description: "Use Google account sign-in from the Gemini CLI.",
                id: "login_with_google",
                label: "Login with Google",
                terminalAuth: true,
            },
            {
                description: "Store Gemini and Google API credentials in Comando.",
                id: "use_gemini",
                label: "Gemini API key",
                terminalAuth: false,
            },
        ],
        name: "Gemini",
    },
    grok: {
        defaultMethodId: "grok-login",
        description: "Grok Build runtime using local CLI login or an xAI API key.",
        envVars: ["XAI_API_KEY"],
        id: "grok",
        methods: [
            {
                description: "Use the local Grok CLI login state.",
                id: "grok-login",
                label: "Grok login",
                terminalAuth: true,
            },
            {
                description: "Store an xAI API key in Comando secure storage.",
                id: "xai-api-key",
                label: "xAI API key",
                terminalAuth: false,
            },
        ],
        name: "Grok",
    },
    kilo: {
        defaultMethodId: "kilo-login",
        description: "Kilo runtime using CLI login or a stored API key.",
        envVars: ["KILO_API_KEY"],
        id: "kilo",
        methods: [
            {
                description: "Use the local Kilo CLI login state.",
                id: "kilo-login",
                label: "Kilo login",
                terminalAuth: true,
            },
            {
                description: "Store a Kilo API key in Comando secure storage.",
                id: "kilo-api-key",
                label: "Kilo API key",
                terminalAuth: false,
            },
        ],
        name: "Kilo",
    },
    opencode: {
        defaultMethodId: "opencode-login",
        description: "OpenCode runtime using the local CLI auth state.",
        envVars: [
            "OPENCODE_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "CODEX_API_KEY",
        ],
        id: "opencode",
        methods: [
            {
                description:
                    "Use providers and credentials configured by the OpenCode CLI.",
                id: "opencode-login",
                label: "OpenCode auth",
                terminalAuth: true,
            },
        ],
        name: "OpenCode",
    },
} satisfies {
    readonly [K in AiProviderId]: AiProviderDefinition<K>;
};

export function getProviderDefinition<TProviderId extends AiProviderId>(
    providerId: TProviderId,
): (typeof AI_PROVIDER_DEFINITIONS)[TProviderId] {
    return AI_PROVIDER_DEFINITIONS[providerId];
}

export function getProviderMethod(
    providerId: AiProviderId,
    methodId: string | null | undefined,
): AiProviderMethodDefinition | null {
    if (!methodId) {
        return null;
    }

    return (
        AI_PROVIDER_DEFINITIONS[providerId].methods.find(
            (method) => method.id === methodId,
        ) ?? null
    );
}

export function getAvailableProviderMethods<TProviderId extends AiProviderId>(
    providerId: TProviderId,
    status: AiProviderRuntimeStatus | null | undefined,
): readonly AiProviderMethodDefinition<AiProviderAuthMethodById[TProviderId]>[] {
    type ProviderMethod = AiProviderMethodDefinition<
        AiProviderAuthMethodById[TProviderId]
    >;
    const methods = AI_PROVIDER_DEFINITIONS[providerId]
        .methods as unknown as readonly ProviderMethod[];
    const runtimeMethods = status?.authMethods;

    if (!runtimeMethods || runtimeMethods.length === 0) {
        return methods;
    }

    const runtimeMethodIds = new Set(runtimeMethods.map((method) => method.id));
    const filteredMethods = methods.filter((method) =>
        runtimeMethodIds.has(method.id),
    );

    return filteredMethods.length > 0 ? filteredMethods : methods;
}

export function isMethodIdForProvider<TProviderId extends AiProviderId>(
    providerId: TProviderId,
    methodId: string | null | undefined,
): methodId is AiProviderAuthMethodById[TProviderId] {
    if (!methodId) {
        return false;
    }

    return AI_PROVIDER_DEFINITIONS[providerId].methods.some(
        (method) => method.id === methodId,
    );
}

export function normalizeNullableText(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function buildSecretPatch(
    draft: AiProviderSecretDraft,
): AiProviderSecretPatch {
    const value = draft.value.trim();

    if (value.length > 0) {
        return {
            kind: "set",
            value,
        };
    }

    if (draft.clear) {
        return {
            kind: "clear",
        };
    }

    return {
        kind: "unchanged",
    };
}

export function createEmptySecretDraft(): AiProviderSecretDraft {
    return {
        clear: false,
        value: "",
    };
}

export function createClearSecretDraft(): AiProviderSecretDraft {
    return {
        clear: true,
        value: "",
    };
}
