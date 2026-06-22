import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CodexRuntimeSettings } from "@shared/ipc";

import { applyCodexAuthEnv, detectCodexAuthMethod } from "./setup";

describe("Codex auth helpers", () => {
    it("uses stored API keys before external login when no method is selected", () => {
        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: null }),
                {
                    codexApiKey: "codex-secret",
                    openaiApiKey: null,
                },
                {},
            ),
        ).toBe("codex-api-key");
    });

    it("detects a local ChatGPT login when no method or API key is selected", () => {
        const codexHome = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-auth-"),
        );
        fs.writeFileSync(
            path.join(codexHome, "auth.json"),
            JSON.stringify({
                tokens: {
                    access_token: "access-token",
                    refresh_token: "refresh-token",
                },
            }),
        );

        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: null }),
                {
                    codexApiKey: null,
                    openaiApiKey: null,
                },
                {
                    CODEX_HOME: codexHome,
                },
            ),
        ).toBe("chatgpt");
    });

    it("ignores incomplete local ChatGPT auth files", () => {
        const codexHome = fs.mkdtempSync(
            path.join(os.tmpdir(), "comando-codex-auth-"),
        );
        fs.writeFileSync(
            path.join(codexHome, "auth.json"),
            JSON.stringify({
                tokens: {
                    access_token: "access-token",
                },
            }),
        );

        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: null }),
                {
                    codexApiKey: null,
                    openaiApiKey: null,
                },
                {
                    CODEX_HOME: codexHome,
                },
            ),
        ).toBeNull();
    });

    it("preserves environment credentials even when another method is selected", () => {
        const env = applyCodexAuthEnv(
            {
                CODEX_API_KEY: "external-codex",
                OPENAI_API_KEY: "external-openai",
                PATH: "/usr/bin",
            },
            createSettings({ authMethod: "openai-api-key" }),
            {
                codexApiKey: "stored-codex",
                openaiApiKey: "stored-openai",
            },
        );

        expect(env.PATH).toBe("/usr/bin");
        expect(env.CODEX_API_KEY).toBe("external-codex");
        expect(env.OPENAI_API_KEY).toBe("external-openai");
        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: "openai-api-key" }),
                {
                    codexApiKey: "stored-codex",
                    openaiApiKey: "stored-openai",
                },
                env,
            ),
        ).toBe("codex-api-key");
    });

    it("does not remove environment credentials when ChatGPT is the active method", () => {
        const env = applyCodexAuthEnv(
            {
                CODEX_API_KEY: "external-codex",
                OPENAI_API_KEY: "external-openai",
            },
            createSettings({ authMethod: "chatgpt" }),
            {
                codexApiKey: "stored-codex",
                openaiApiKey: "stored-openai",
            },
        );

        expect(env.CODEX_API_KEY).toBe("external-codex");
        expect(env.OPENAI_API_KEY).toBe("external-openai");
        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: "chatgpt" }),
                {
                    codexApiKey: "stored-codex",
                    openaiApiKey: "stored-openai",
                },
                env,
            ),
        ).toBe("codex-api-key");
    });

    it("respects a selected API key method when only stored secrets are available", () => {
        const env = applyCodexAuthEnv(
            {},
            createSettings({ authMethod: "openai-api-key" }),
            {
                codexApiKey: "stored-codex",
                openaiApiKey: "stored-openai",
            },
        );

        expect(env.CODEX_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe("stored-openai");
    });
});

function createSettings(
    overrides: Partial<CodexRuntimeSettings>,
): CodexRuntimeSettings {
    return {
        authMethod: null,
        binaryPath: null,
        hasCodexApiKey: false,
        hasOpenAiApiKey: false,
        ...overrides,
    };
}
