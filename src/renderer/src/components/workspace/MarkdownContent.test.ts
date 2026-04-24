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

    it("renders tilde fenced code blocks", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "~~~python\nprint('hello')\n~~~",
            }),
        );

        expect(markup).toContain(">python<");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("print");
    });

    it("renders unclosed fenced code blocks while content is streaming", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: "```zig\nconst value: i32 = 1;",
            }),
        );

        expect(markup).toContain(">zig<");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("value");
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

    it("renders long inline file reference pills without shortening the label", () => {
        const longPath =
            "src/renderer/src/components/workspace/chat/ExtraordinarilyLongFileNameForPillRendering.tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: `Review \`${longPath}\` please`,
                onOpenFile: () => undefined,
                resolveFileReference: () => ({
                    endLine: null,
                    isAbsolute: false,
                    path: longPath,
                    relativePath: longPath,
                    startLine: null,
                }),
            }),
        );

        expect(markup).toContain(longPath);
        expect(markup).toContain("white-space:normal");
        expect(markup).not.toContain("ExtraordinarilyLong...");
        expect(markup).not.toContain("text-overflow:ellipsis");
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

    it("closes ordered lists before top-level headings", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "1. Tradeoff a tener presente",
                    "Re-pintado: cuando cambia el composerFontSize reconstruye todo.",
                    "## Orden sugerido si lo avanzas",
                    "1. Helper createIconSvg.",
                ].join("\n"),
            }),
        );
        const listEnd = markup.indexOf("</ol>");
        const headingStart = markup.indexOf("Orden sugerido si lo avanzas");

        expect(listEnd).toBeGreaterThan(-1);
        expect(headingStart).toBeGreaterThan(listEnd);
        expect(markup).not.toContain("## Orden sugerido");
    });

    it("closes bullet lists before top-level headings after a blank line", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- folder_mention: usar FolderTypeIcon.",
                    "- git_commit_mention: icono git.",
                    "",
                    "## Orden sugerido si lo avanzas",
                    "1. Helper createIconSvg.",
                ].join("\n"),
            }),
        );
        const listEnd = markup.indexOf("</ul>");
        const headingStart = markup.indexOf("Orden sugerido si lo avanzas");

        expect(listEnd).toBeGreaterThan(-1);
        expect(headingStart).toBeGreaterThan(listEnd);
        expect(markup).not.toContain("## Orden sugerido");
    });

    it("closes lists before top-level blockquotes and tables", () => {
        const blockquoteMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: ["1. First point", "> quoted follow-up"].join("\n"),
            }),
        );
        const tableMarkup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- First point",
                    "| File | Status |",
                    "| --- | --- |",
                    "| app.ts | ok |",
                ].join("\n"),
            }),
        );

        const blockquoteListEnd = blockquoteMarkup.indexOf("</ol>");
        const blockquoteStart = blockquoteMarkup.indexOf("<blockquote");
        const tableListEnd = tableMarkup.indexOf("</ul>");
        const tableStart = tableMarkup.indexOf("<table");

        expect(blockquoteListEnd).toBeGreaterThan(-1);
        expect(blockquoteStart).toBeGreaterThan(blockquoteListEnd);
        expect(tableListEnd).toBeGreaterThan(-1);
        expect(tableStart).toBeGreaterThan(tableListEnd);
    });

    it("renders isolated bullet-like lines as a single-item list", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "- O sea: las adaptaciones especiales no viven en el vendor.",
                    "Comando Claude setup",
                    "Comando Claude process",
                ].join("\n"),
            }),
        );

        expect(markup).toContain("<ul");
        expect(markup).toContain(
            "O sea: las adaptaciones especiales no viven en el vendor.",
        );
        expect(markup).toContain("Comando Claude setup");
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
