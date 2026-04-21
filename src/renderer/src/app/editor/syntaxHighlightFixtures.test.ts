import { describe, expect, it } from "vitest";

import { resolveEditorLanguage } from "@shared/editor-language";

import {
    SYNTAX_HIGHLIGHT_BASELINE_FIXTURES,
    SYNTAX_HIGHLIGHT_LARGE_FIXTURES,
} from "./syntaxHighlightFixtures";

const EXPECTED_BASELINE_FIXTURE_IDS = [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "json",
    "jsonc",
    "markdown",
    "html",
    "css",
    "scss",
    "yaml",
    "vue",
    "svelte",
    "prisma",
    "graphql",
    "sql",
    "shell",
    "python",
    "rust",
    "env",
    "envrc",
    "gitignore",
] as const;

const EXPECTED_LARGE_FIXTURE_IDS = [
    "minified-typescript",
    "large-json",
] as const;

describe("syntax highlight fixtures", () => {
    it("covers the Phase 0 baseline language set", () => {
        expect(
            SYNTAX_HIGHLIGHT_BASELINE_FIXTURES.map((fixture) => fixture.id),
        ).toEqual(EXPECTED_BASELINE_FIXTURE_IDS);
        expect(SYNTAX_HIGHLIGHT_LARGE_FIXTURES.map((fixture) => fixture.id)).toEqual(
            EXPECTED_LARGE_FIXTURE_IDS,
        );
    });

    it("keeps fixture ids unique", () => {
        const ids = [
            ...SYNTAX_HIGHLIGHT_BASELINE_FIXTURES.map((fixture) => fixture.id),
            ...SYNTAX_HIGHLIGHT_LARGE_FIXTURES.map((fixture) => fixture.id),
        ];

        expect(new Set(ids).size).toBe(ids.length);
    });

    it("resolves every baseline fixture to its expected editor language", () => {
        for (const fixture of SYNTAX_HIGHLIGHT_BASELINE_FIXTURES) {
            expect(
                resolveEditorLanguage({
                    filePath: fixture.filePath,
                    probeContent: fixture.content,
                }).id,
            ).toBe(fixture.languageId);
        }
    });

    it("keeps the Markdown fixture broad enough for embedded highlighting", () => {
        const markdownFixture = SYNTAX_HIGHLIGHT_BASELINE_FIXTURES.find(
            (fixture) => fixture.id === "markdown",
        );

        expect(markdownFixture?.content).toContain("## Embedded Blocks");
        expect(markdownFixture?.content).toContain("`inlineCode`");
        expect(markdownFixture?.content).toContain("[Comando](./README.md)");
        expect(markdownFixture?.content).toContain("- TypeScript fence");
        expect(markdownFixture?.content).toContain("```ts");
        expect(markdownFixture?.content).toContain("```json");
        expect(markdownFixture?.content).toContain("```bash");
    });

    it("generates the large-file performance fixtures above their target sizes", () => {
        for (const fixture of SYNTAX_HIGHLIGHT_LARGE_FIXTURES) {
            const content = fixture.createContent();

            expect(content.length).toBeGreaterThanOrEqual(fixture.minBytes);
            expect(
                resolveEditorLanguage({
                    filePath: fixture.filePath,
                    probeContent: content.slice(0, 512),
                }).id,
            ).toBe(fixture.languageId);
        }
    });
});
