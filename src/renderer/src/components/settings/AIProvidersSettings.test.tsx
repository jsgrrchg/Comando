import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AIProvidersSettings } from "./AIProvidersSettings";
import {
    AI_PROVIDER_IDS,
    buildSecretPatch,
    type AiProviderRuntimeSettingsMap,
    type AiProviderRuntimeStatusMap,
} from "./aiProviderSettingsModel";

const RUNTIME_STATUSES: AiProviderRuntimeStatusMap = {
    claude: {
        authCredentialSourceLabel: "Comando secure storage",
        authMethod: "gateway-bedrock",
        authReady: true,
        canDisconnectAuth: true,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "claude-agent-acp",
        runtimeId: "claude",
        source: "bundled",
        state: "ready",
    },
    codex: {
        authCredentialSourceLabel: "Environment",
        authMethod: "chatgpt",
        authReady: true,
        canLogoutAuth: true,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "codex-acp",
        runtimeId: "codex",
        source: "env",
        state: "ready",
    },
    gemini: {
        authCredentialSourceLabel: "Comando secure storage",
        authMethod: "use_gemini",
        authReady: true,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "gemini",
        runtimeId: "gemini",
        source: "settings",
        state: "ready",
    },
    grok: {
        authCredentialSourceLabel: "Using environment variable",
        authMethod: "xai-api-key",
        authReady: true,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "grok --no-auto-update agent stdio",
        runtimeId: "grok",
        source: "env",
        state: "ready",
    },
    kilo: {
        authMethod: "kilo-api-key",
        authReady: false,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "kilo",
        message: "Kilo API key is not configured.",
        runtimeId: "kilo",
        source: "bundled",
        state: "missing",
    },
    opencode: {
        authCredentialSourceLabel: "Using external OpenCode auth",
        authMethod: "opencode-login",
        authReady: true,
        checkedAt: "2026-05-19T12:00:00.000Z",
        command: "opencode acp",
        runtimeId: "opencode",
        source: "path",
        state: "ready",
    },
};

const RUNTIME_SETTINGS: AiProviderRuntimeSettingsMap = {
    claude: {
        authMethod: "gateway-bedrock",
        bedrockGatewayBaseUrl: "https://bedrock.example.test",
        binaryPath: null,
    },
    codex: {
        authMethod: "chatgpt",
        binaryPath: null,
        hasCodexApiKey: true,
        hasOpenAiApiKey: true,
    },
    gemini: {
        authMethod: "use_gemini",
        binaryPath: null,
        googleCloudLocation: "us-central1",
        googleCloudProject: "comando-dev",
        hasGeminiApiKey: true,
        hasGoogleApiKey: true,
    },
    grok: {
        authMethod: "xai-api-key",
        binaryPath: null,
        hasXaiApiKey: true,
    },
    kilo: {
        authMethod: "kilo-api-key",
        binaryPath: null,
        hasKiloApiKey: true,
    },
    opencode: {
        authMethod: "opencode-login",
        binaryPath: null,
    },
};

describe("AIProvidersSettings", () => {
    it("renders the fixed provider catalog with the planned auth methods", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={AI_PROVIDER_IDS}
                runtimeSettings={RUNTIME_SETTINGS}
                runtimeStatuses={RUNTIME_STATUSES}
            />,
        );

        expect(markup).toContain("Codex");
        expect(markup).toContain("Claude");
        expect(markup).toContain("Gemini");
        expect(markup).toContain("Grok");
        expect(markup).toContain("Kilo");
        expect(markup).toContain("OpenCode");
        expect(markup).toContain("Anthropic API key");
        expect(markup).toContain("Bedrock gateway");
        expect(markup).toContain("Custom headers JSON");
        expect(markup).not.toContain("Auth token");
        expect(markup).toContain("Gemini API key");
        expect(markup).toContain("Google Cloud project");
        expect(markup).toContain("Grok login");
        expect(markup).toContain("xAI API key");
        expect(markup).toContain("Kilo API key");
        expect(markup).toContain("OpenCode auth");
        expect(markup).toContain("project .env");
        expect(markup).toContain("Open sign-in terminal");
    });

    it("shows stored secret state without rendering secret values", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={AI_PROVIDER_IDS}
                runtimeSettings={RUNTIME_SETTINGS}
                runtimeStatuses={RUNTIME_STATUSES}
            />,
        );

        expect(markup).toContain("Stored - enter a new value to replace");
        expect(markup).toContain("Stored");
        expect(markup).not.toContain("sk-live");
        expect(markup).not.toContain("secret-token");
    });

    it("renders diagnostics controls when diagnostics props are provided", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                diagnostics={{
                    entries: [
                        {
                            id: "secret-storage",
                            label: "Secret storage",
                            message: "Encrypted storage is available.",
                            providerId: null,
                            status: "ok",
                        },
                    ],
                    loading: false,
                    updatedAt: "2026-05-19T12:00:00.000Z",
                }}
                runtimeSettings={RUNTIME_SETTINGS}
                runtimeStatuses={RUNTIME_STATUSES}
            />,
        );

        expect(markup).toContain("Diagnostics");
        expect(markup).toContain("Show");
        expect(markup).toContain("Refresh");
    });

    it("shows detected auth methods without persisting default drafts first", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={["codex"]}
                runtimeSettings={{
                    codex: {
                        authMethod: null,
                        binaryPath: null,
                        hasCodexApiKey: false,
                        hasOpenAiApiKey: false,
                    },
                }}
                runtimeStatuses={{
                    codex: {
                        authMethod: "openai-api-key",
                        authReady: true,
                        checkedAt: "2026-05-19T12:00:00.000Z",
                        command: "codex-acp",
                        runtimeId: "codex",
                        source: "env",
                        state: "ready",
                    },
                }}
            />,
        );

        expect(markup).toContain("Optional OPENAI_API_KEY");
    });

    it("filters Claude login methods to the runtime-supported environment", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={["claude"]}
                runtimeSettings={{
                    claude: {
                        authMethod: null,
                        binaryPath: null,
                    },
                }}
                runtimeStatuses={{
                    claude: {
                        authMethod: null,
                        authMethods: [
                            {
                                description:
                                    "Open a terminal-based Claude subscription login flow.",
                                id: "claude-ai-login",
                                name: "Claude subscription",
                            },
                            {
                                description:
                                    "Open a terminal-based Anthropic Console login flow.",
                                id: "console-login",
                                name: "Anthropic Console",
                            },
                            {
                                description:
                                    "Use an Anthropic API key stored only for Comando on this machine.",
                                id: "anthropic-api-key",
                                name: "Anthropic API key",
                            },
                            {
                                description:
                                    "Use a custom Anthropic-compatible gateway just for Comando.",
                                id: "gateway",
                                name: "Custom gateway",
                            },
                            {
                                description:
                                    "Use a custom Bedrock-compatible Claude gateway just for Comando.",
                                id: "gateway-bedrock",
                                name: "Bedrock gateway",
                            },
                        ],
                        authReady: false,
                        checkedAt: "2026-05-19T12:00:00.000Z",
                        command: "claude-agent-acp",
                        runtimeId: "claude",
                        source: "bundled",
                        state: "ready",
                    },
                }}
            />,
        );

        expect(markup).toContain("Claude AI login");
        expect(markup).toContain("Console login");
        expect(markup).not.toContain("Claude login");
        expect(markup).toContain("Anthropic API key");
        expect(markup).toContain("Bedrock gateway");
    });

    it("filters Grok methods to the runtime-supported environment", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={["grok"]}
                runtimeSettings={{
                    grok: {
                        authMethod: "grok-login",
                        binaryPath: null,
                        hasXaiApiKey: false,
                    },
                }}
                runtimeStatuses={{
                    grok: {
                        authMethod: null,
                        authMethods: [
                            {
                                description:
                                    "Use an xAI API key stored only for Comando on this machine.",
                                id: "xai-api-key",
                                name: "xAI API key",
                            },
                        ],
                        authReady: false,
                        checkedAt: "2026-05-19T12:00:00.000Z",
                        command: "grok --no-auto-update agent stdio",
                        runtimeId: "grok",
                        source: "path",
                        state: "ready",
                    },
                }}
            />,
        );

        expect(markup).toContain("xAI API key");
        expect(markup).toContain("Optional XAI_API_KEY");
        expect(markup).not.toContain("Grok login");
        expect(markup).not.toContain("Run Grok login in a terminal");
    });

    it("does not render default API key fields before a method is selected or detected", () => {
        const markup = renderToStaticMarkup(
            <AIProvidersSettings
                defaultExpandedProviderIds={["codex"]}
                runtimeSettings={{
                    codex: {
                        authMethod: null,
                        binaryPath: null,
                        hasCodexApiKey: false,
                        hasOpenAiApiKey: false,
                    },
                }}
                runtimeStatuses={{
                    codex: {
                        authMethod: null,
                        authReady: false,
                        checkedAt: "2026-05-19T12:00:00.000Z",
                        command: "codex-acp",
                        runtimeId: "codex",
                        source: "env",
                        state: "ready",
                    },
                }}
            />,
        );

        expect(markup).not.toContain("Optional OPENAI_API_KEY");
    });
});

describe("buildSecretPatch", () => {
    it("prefers replacement values over clear requests", () => {
        expect(
            buildSecretPatch({
                clear: true,
                value: "  replacement  ",
            }),
        ).toEqual({
            kind: "set",
            value: "replacement",
        });
    });

    it("preserves unchanged secrets when no draft is provided", () => {
        expect(
            buildSecretPatch({
                clear: false,
                value: "",
            }),
        ).toEqual({
            kind: "unchanged",
        });
    });
});
