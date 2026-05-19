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
    kilo: {
        authMethod: "kilo-api-key",
        binaryPath: null,
        hasKiloApiKey: true,
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
        expect(markup).toContain("Kilo");
        expect(markup).toContain("Anthropic API key");
        expect(markup).toContain("Bedrock gateway");
        expect(markup).toContain("Custom headers JSON");
        expect(markup).not.toContain("Auth token");
        expect(markup).toContain("Gemini API key");
        expect(markup).toContain("Google Cloud project");
        expect(markup).toContain("Kilo API key");
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
