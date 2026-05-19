import { describe, expect, it } from "vitest";

import { bootstrapSecretKeys } from "./worker";

describe("db worker bootstrap", () => {
    it("rehydrates all AI provider secrets needed at startup", () => {
        expect(bootstrapSecretKeys).toEqual(
            expect.arrayContaining([
                "secret.ai.claude.anthropic_api_key",
                "secret.ai.claude.anthropic_auth_token",
                "secret.ai.claude.anthropic_custom_headers",
                "secret.ai.codex.codex_api_key",
                "secret.ai.codex.openai_api_key",
                "secret.ai.gemini.gemini_api_key",
                "secret.ai.gemini.google_api_key",
                "secret.ai.kilo.kilo_api_key",
            ]),
        );
    });
});
