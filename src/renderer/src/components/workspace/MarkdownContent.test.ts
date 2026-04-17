import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
    it("renders diff blocks with DiffLineView", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```diff\n@@ -1,2 +1,2 @@\n alpha\n-bravo\n+beta\n```",
            }),
        );

        expect(markup).toContain("markdown-diff-block");
        expect(markup).toContain('data-diff-line="true"');
        expect(markup).toContain('data-line-type="remove"');
        expect(markup).toContain('data-line-type="add"');
        expect(markup).toContain(">diff<");
    });

    it("keeps normal rendering for non-diff code blocks", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```ts\nconst value = 1;\n```",
            }),
        );

        expect(markup).toContain(">ts<");
        expect(markup).toContain("cm-static-code");
        expect(markup).not.toContain("markdown-diff-block");
    });

    it("keeps highlighting for TOML and GraphQL", () => {
        const tomlMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: '```toml\n[package]\nname = "comando"\n```',
            }),
        );
        const graphqlMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```graphql\nquery Viewer { viewer { login } }\n```",
            }),
        );

        expect(tomlMarkup).toContain(">toml<");
        expect(tomlMarkup).toContain("cm-static-code");
        expect(graphqlMarkup).toContain(">graphql<");
        expect(graphqlMarkup).toContain("cm-static-code");
    });

    it("renders inline selection pills from serialized composer markers", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content:
                    "\u200B\u00AB(8:14) - Si ves que un\u00BB\u200B expande",
            }),
        );

        expect(markup).toContain("(8:14) - Si ves que un");
        expect(markup).toContain("expande");
    });

    it("keeps ordered items grouped when they contain paragraphs and nested bullets", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Plan principal",
                    "Mientras esperas, mantienes el contexto.",
                    "   - Recuperas el hilo",
                    "   - Sigues con una salida decente",
                    "",
                    "1. Objetivo",
                    "Primero estabilizar el flujo.",
                    "   - Luego refinar detalles",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ol");
        expect(markup).toContain("<li");
        expect(markup.match(/<ol/g)?.length).toBe(1);
        expect(markup).toContain("<ul");
        expect(markup).toContain("Mientras esperas, mantienes el contexto.");
        expect(markup).toContain("Luego refinar detalles");
    });

    it("renders isolated bullet-like lines as a single-item list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- O sea: las adaptaciones especiales no viven en el vendor.",
                    "reference app Claude setup",
                    "reference app Claude process",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ul");
        expect(markup).toContain(
            "O sea: las adaptaciones especiales no viven en el vendor.",
        );
        expect(markup).toContain("reference app Claude setup");
    });

    it("renders isolated ordered-like lines as a single-item list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Actualizacion conservadora primero.",
                    "Luego validas login, prompt y cierre.",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ol");
        expect(markup).toContain("Actualizacion conservadora primero.");
        expect(markup).toContain("Luego validas login, prompt y cierre.");
    });

    it("respects the starting number of ordered lists", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "3. Third item\n4. Fourth item",
            }),
        );

        expect(markup).toContain('<ol start="3"');
        expect(markup).toContain("Third item");
        expect(markup).toContain("Fourth item");
    });
});
