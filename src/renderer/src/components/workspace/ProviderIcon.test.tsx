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

    it("uses the compact Codex tab glyph", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "codex" }),
        );

        expect(markup).toContain(
            'points="8,2.3 13.4,5.4 13.4,10.6 8,13.7 2.6,10.6 2.6,5.4"',
        );
        expect(markup).not.toContain("--provider-icon-accent");
    });

    it("uses the Grok tab glyph", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "grok" }),
        );

        expect(markup).toContain(
            'd="M3.25 8a4.75 4.75 0 1 1 4.75 4.75"',
        );
        expect(markup).toContain('d="M8 3.25v4.75h4.75"');
        expect(markup).toContain('d="M4.4 11.6 11.6 4.4"');
    });

    it("uses the OpenCode tab glyph", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "opencode" }),
        );

        expect(markup).toContain('viewBox="0 0 300 300"');
        expect(markup).toContain('d="M210 240H90V120H210V240Z"');
        expect(markup).toContain(
            'd="M210 60H90V240H210V60ZM270 300H30V0H270V300Z"',
        );
    });
});
