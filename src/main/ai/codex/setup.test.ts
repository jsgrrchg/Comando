import { describe, expect, it } from "vitest";

import type { CodexRuntimeSettings } from "@shared/ipc";

import { applyCodexAuthEnv, detectCodexAuthMethod } from "./setup";

describe("Codex auth helpers", () => {
    it("no reactiva keys almacenadas cuando no hay un método seleccionado", () => {
        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: null }),
                {
                    codexApiKey: "codex-secret",
                    openaiApiKey: null,
                },
                {},
            ),
        ).toBe(null);
    });

    it("sólo expone al runtime la credencial del método elegido", () => {
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
        expect(env.CODEX_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe("external-openai");
    });

    it("limpia variables heredadas cuando el método activo es ChatGPT", () => {
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

        expect(env.CODEX_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(
            detectCodexAuthMethod(
                createSettings({ authMethod: "chatgpt" }),
                {
                    codexApiKey: "stored-codex",
                    openaiApiKey: "stored-openai",
                },
                env,
            ),
        ).toBe("chatgpt");
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
