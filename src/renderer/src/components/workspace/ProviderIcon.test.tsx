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

    it("renders a generic ACP icon for a custom runtime", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, {
                runtimeId:
                    "custom:550e8400-e29b-41d4-a716-446655440000",
            }),
        );

        expect(markup).toContain('data-provider-icon="custom-acp"');
        expect(markup).not.toContain('data-provider-icon="codex"');
    });

    it("renders the generic ACP icon for an unknown persisted runtime", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, {
                runtimeId: "legacy-runtime" as AiRuntimeId,
            }),
        );

        expect(markup).toContain('data-provider-icon="custom-acp"');
    });

    it("uses the official OpenAI mark for Codex", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "codex" }),
        );

        expect(markup).toContain('viewBox="0 0 41 41"');
        expect(markup).toContain(
            'd="M37.5324 16.8707C37.9808 15.5241',
        );
    });

    it("uses the official Anthropic mark for Claude", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "claude" }),
        );

        expect(markup).toContain('viewBox="0 0 35 24"');
        expect(markup).toContain(
            'd="M24.5475 0H19.3384L28.8374 24H34.0465L24.5475 0Z"',
        );
    });

    it("uses the official Grok mark", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "grok" }),
        );

        expect(markup).toContain('viewBox="0 0 512 512"');
        expect(markup).toContain(
            'd="M210.484 312.759L343.465 210.383',
        );
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

    it("uses the official monochrome Kilo mark", () => {
        const markup = renderToStaticMarkup(
            createElement(ProviderIcon, { runtimeId: "kilo" }),
        );

        expect(markup).toContain('viewBox="0 0 16 16"');
        expect(markup).toContain(
            'd="M16 16H0V0H16V16ZM10.09 10.09H8.7',
        );
        expect(markup).toContain('fill-rule="evenodd"');
    });
});
