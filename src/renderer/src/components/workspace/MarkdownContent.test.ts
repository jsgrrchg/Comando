import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "./MarkdownContent";
import { resolveProjectFileReference } from "./projectFileReferences";

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

    it("keeps slash tokens as text unless they are strong file references", () => {
        const content = [
            "Läuft euer S/4 in der Public Cloud?",
            "Viele Schaltanlagenbauer /EVU-Partner gehen in unsere Richtung.",
            "TCP/IP ist der Standard.",
            "Zielquartal ist 2024/Q1.",
            "Inline code: `S/4`, `TCP/IP`, `2024/Q1`, `/LinkedIn`.",
            "Real file: `src/renderer/src/components/workspace/MarkdownContent.tsx`.",
        ].join("\n");
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: [
                            "/Users/test/workspace/comando",
                            "/Users/test/workspace/comando/.git/..",
                        ],
                    }),
            }),
        );

        expect(markup).toContain("S/4");
        expect(markup).toContain("/EVU-Partner");
        expect(markup).toContain("TCP/IP");
        expect(markup).toContain("2024/Q1");
        expect(markup).toContain("/LinkedIn");
        expect(markup).not.toContain('title="S/4"');
        expect(markup).not.toContain('title="TCP/IP"');
        expect(markup).not.toContain('title="2024/Q1"');
        expect(markup).not.toContain('title="/LinkedIn"');
        expect(markup).toContain(
            'title="src/renderer/src/components/workspace/MarkdownContent.tsx"',
        );
    });

    it("renders raw diagnostic file references as interactive pills", () => {
        const content = [
            "Errors at src/app.ts:12 and src/app.ts:12:5.",
            "Also ./src/app.ts:12.",
            "Absolute /Users/test/workspace/comando/src/app.ts:42.",
            "File URL file:///Users/test/workspace/comando/src/app.ts#L9-L14.",
        ].join(" ");
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(5);
        expect(markup).toContain(">app.ts:12<");
        expect(markup).toContain(">app.ts:12:5<");
        expect(markup).toContain(">app.ts:9-14<");
        expect(markup).toContain('title="src/app.ts:12"');
        expect(markup).toContain('title="src/app.ts:12:5"');
        expect(markup).toContain('title="./src/app.ts:12"');
        expect(markup).toContain(
            'title="/Users/test/workspace/comando/src/app.ts:42"',
        );
        expect(markup).toContain(
            'title="file:///Users/test/workspace/comando/src/app.ts#L9-L14"',
        );
    });

    it("renders markdown project file links as interactive pills", () => {
        const target = "src/renderer/src/components/workspace/MarkdownContent.tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: `Open [workspace markdown](${target}).`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">workspace markdown<");
        expect(markup).toContain(`title="${target}"`);
        expect(markup).not.toContain(`href="${target}"`);
    });

    it("keeps external markdown links as anchors", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: "Read [the docs](https://example.com/docs).",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain('href="https://example.com/docs"');
        expect(markup).toContain(">the docs<");
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
    });

    it("renders markdown file links with parenthesized angle targets", () => {
        const target = "src/components/Foo(test).tsx";
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: `Review [test component](<${target}>).`,
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">test component<");
        expect(markup).toContain(`title="&lt;${target}&gt;"`);
    });

    it("renders raw confirmed file paths without line references", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: "Touch src/app.ts before committing.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain(">app.ts<");
        expect(markup).toContain('title="src/app.ts"');
    });

    it("keeps incomplete streaming markdown links intact", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: "Streaming [app](src/app.ts",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain("Streaming [app](src/app.ts");
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
        expect(markup).not.toContain('title="src/app.ts"');
    });

    it("does not pillify dubious markdown path-like links", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content: "Check [SAP](S/4) and [quarter](2024/Q1).",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
        expect(markup).toContain('href="S/4"');
        expect(markup).toContain('href="2024/Q1"');
    });

    it("keeps URLs intact when they contain path-like diagnostic text", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => true,
                content:
                    "See https://example.com/src/app.ts:12 before src/app.ts:12.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain('href="https://example.com/src/app.ts:12"');
        expect(markup).not.toContain(
            'title="https://example.com/src/app.ts:12"',
        );
        expect(markup.match(/<button/g)?.length).toBe(1);
        expect(markup).toContain('title="src/app.ts:12"');
    });

    it("keeps raw diagnostic references as text when the project cannot confirm them", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                canRenderRawFileReference: () => false,
                content: "Example path src/app.ts:12 should not be clickable.",
                onOpenFile: () => undefined,
                resolveFileReference: (reference) =>
                    resolveProjectFileReference(reference, {
                        projectRoots: ["/Users/test/workspace/comando"],
                    }),
            }),
        );

        expect(markup).toContain("src/app.ts:12");
        expect(markup).not.toContain('title="src/app.ts:12"');
        expect(markup.match(/<button/g)?.length ?? 0).toBe(0);
    });

    it("renders conservative git and structured symbol pills", () => {
        const markup = renderToStaticMarkup(
            createElement(MarkdownContent, {
                content: [
                    "Fixed in commit abcdef1234567890.",
                    "Mention abcdef1 alone stays text.",
                    "\u200B\u00ABsymbol: WorkspaceView.openFileTab\u00BB\u200B",
                    "\u200B\u00ABcommit: 123456789abc\u00BB\u200B",
                ].join("\n"),
            }),
        );

        expect(markup).toContain('title="abcdef1234567890"');
        expect(markup).toContain(">abcdef123456<");
        expect(markup).toContain("Mention abcdef1 alone stays text.");
        expect(markup).toContain("WorkspaceView.openFileTab");
        expect(markup).not.toContain(">symbol: WorkspaceView.openFileTab<");
        expect(markup).toContain("commit: 123456789abc");
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
