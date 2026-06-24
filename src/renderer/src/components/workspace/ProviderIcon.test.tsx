import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ACTIVE_AI_RUNTIME_IDS } from "@shared/ai-runtimes";
import type { AiRuntimeId } from "@shared/ipc";

import { ProviderIcon, PROVIDER_ICON_RUNTIME_IDS } from "./ProviderIcon";

describe("ProviderIcon", () => {
    it("covers every active AI runtime", () => {
        expect(PROVIDER_ICON_RUNTIME_IDS).toEqual(ACTIVE_AI_RUNTIME_IDS);

        for (const runtimeId of ACTIVE_AI_RUNTIME_IDS) {
            const markup = renderToStaticMarkup(
                createElement(ProviderIcon, { runtimeId }),
            );

            expect(markup).toContain(`data-provider-icon="${runtimeId}"`);
            expect(markup).toContain("provider");
        }
    });

    it("falls back to Codex for unknown legacy runtime ids", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, {
                runtimeId: "legacy-runtime" as AiRuntimeId,
            }),
        );

        expect(markup).toContain('data-provider-icon="codex"');
    });
});
