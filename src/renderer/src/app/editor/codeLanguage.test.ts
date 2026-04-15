import { describe, expect, it } from "vitest";

import {
    extractFenceLanguageToken,
    loadCodeLanguageSupportByPath,
    loadCodeLanguageSupportForPath,
    resolveCodeLanguageKey,
    resolveCodeLanguageKeyFromPath,
    resolveMarkdownCodeLanguageKey,
} from "./codeLanguage";

describe("extractFenceLanguageToken", () => {
    it("extracts simple fenced language tokens", () => {
        expect(extractFenceLanguageToken("typescript")).toBe("typescript");
        expect(extractFenceLanguageToken("tsx title=app.tsx")).toBe("tsx");
    });

    it("supports brace and class-style markdown info strings", () => {
        expect(extractFenceLanguageToken("{.ts}")).toBe("ts");
        expect(extractFenceLanguageToken("{language-python}")).toBe("python");
        expect(extractFenceLanguageToken(".json")).toBe("json");
    });
});

describe("resolveMarkdownCodeLanguageKey", () => {
    it("maps fence aliases to CodeMirror language keys", () => {
        expect(resolveMarkdownCodeLanguageKey("ts")).toBe("typescript");
        expect(resolveMarkdownCodeLanguageKey("tsx")).toBe("typescript-jsx");
        expect(resolveMarkdownCodeLanguageKey("mdx")).toBe("typescript-jsx");
        expect(resolveMarkdownCodeLanguageKey("markdown")).toBe("markdown");
        expect(resolveMarkdownCodeLanguageKey("csharp")).toBe("csharp");
        expect(resolveMarkdownCodeLanguageKey("terraform")).toBe("hcl");
        expect(resolveMarkdownCodeLanguageKey("prisma")).toBe("prisma");
        expect(resolveMarkdownCodeLanguageKey("bash")).toBe("shell");
        expect(resolveMarkdownCodeLanguageKey("graphql")).toBe("graphql");
        expect(resolveMarkdownCodeLanguageKey("patch")).toBe("diff");
    });
});

describe("resolveCodeLanguageKeyFromPath", () => {
    it("resolves direct extensions before shared language fallbacks", () => {
        expect(resolveCodeLanguageKeyFromPath("/workspace/src/App.tsx")).toBe(
            "typescript-jsx",
        );
        expect(resolveCodeLanguageKeyFromPath("/workspace/src/view.jsx")).toBe(
            "javascript-jsx",
        );
        expect(resolveCodeLanguageKeyFromPath("/workspace/src/App.tsx")).toBe(
            "typescript-jsx",
        );
        expect(resolveCodeLanguageKeyFromPath("/workspace/docs/page.mdx")).toBe(
            "typescript-jsx",
        );
        expect(resolveCodeLanguageKeyFromPath("/workspace/Cargo.toml")).toBe(
            "toml",
        );
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/schema/query.graphql"),
        ).toBe("graphql");
        expect(resolveCodeLanguageKeyFromPath("/workspace/.env")).toBe(
            "properties",
        );
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/docs/README.md"),
        ).toBe("markdown");
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/src/Program.cs"),
        ).toBe("csharp");
        expect(resolveCodeLanguageKeyFromPath("/workspace/infra/main.tf")).toBe(
            "hcl",
        );
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/infra/root.hcl"),
        ).toBe("hcl");
        expect(resolveCodeLanguageKeyFromPath("/workspace/src/App.vue")).toBe(
            "vue",
        );
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/src/App.svelte"),
        ).toBe("svelte");
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/src/pages/index.astro"),
        ).toBe("astro");
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/prisma/schema.prisma"),
        ).toBe("prisma");
        expect(resolveCodeLanguageKeyFromPath("/workspace/app/Main.kt")).toBe(
            "kotlin",
        );
        expect(
            resolveCodeLanguageKeyFromPath("/workspace/app/Main.scala"),
        ).toBe("scala");
        expect(resolveCodeLanguageKeyFromPath("/workspace/lib/demo.ex")).toBe(
            "elixir",
        );
    });

    it("falls back to shared editor-language resolution for named files", () => {
        expect(resolveCodeLanguageKeyFromPath("/workspace/Dockerfile")).toBe(
            "dockerfile",
        );
        expect(resolveCodeLanguageKeyFromPath("/workspace/Gemfile")).toBe(
            "ruby",
        );
    });
});

describe("resolveCodeLanguageKey", () => {
    it("permite resolver por mime type antes del fallback por path", () => {
        expect(
            resolveCodeLanguageKey("/workspace/notes.txt", "text/x-diff"),
        ).toBe("diff");
        expect(
            resolveCodeLanguageKey("/workspace/unknown", "application/json"),
        ).toBe("json");
        expect(
            resolveCodeLanguageKey("/workspace/notes.txt", "text/markdown"),
        ).toBe("markdown");
        expect(
            resolveCodeLanguageKey("/workspace/template.txt", "text/x-vue"),
        ).toBe("vue");
    });
});

describe("loadCodeLanguageSupportForPath", () => {
    it("reuses the shared cache for repeated path loads", async () => {
        const first = await loadCodeLanguageSupportForPath(
            "/workspace/src/example.ts",
        );
        const second = await loadCodeLanguageSupportForPath(
            "/workspace/src/example.ts",
        );

        expect(first).not.toBeNull();
        expect(second).toBe(first);
    });

    it("supports explicit mime type loads through the path-based helper", async () => {
        const first = await loadCodeLanguageSupportByPath(
            "/workspace/patch.txt",
            "text/x-diff",
        );
        const second = await loadCodeLanguageSupportByPath(
            "/workspace/patch.txt",
            "text/x-diff",
        );

        expect(first).not.toBeNull();
        expect(second).toBe(first);
    });

    it("loads TOML language support for config files", async () => {
        const support = await loadCodeLanguageSupportByPath(
            "/workspace/Cargo.toml",
        );

        expect(support).not.toBeNull();
    });

    it("loads GraphQL language support for schema files", async () => {
        const support = await loadCodeLanguageSupportByPath(
            "/workspace/schema/query.graphql",
        );

        expect(support).not.toBeNull();
    });

    it("loads language support for the extended language set", async () => {
        const filePaths = [
            "/workspace/docs/README.md",
            "/workspace/src/Program.cs",
            "/workspace/infra/main.tf",
            "/workspace/infra/root.hcl",
            "/workspace/src/App.vue",
            "/workspace/src/App.svelte",
            "/workspace/src/pages/index.astro",
            "/workspace/prisma/schema.prisma",
            "/workspace/app/Main.kt",
            "/workspace/app/Main.scala",
            "/workspace/lib/demo.ex",
        ] as const;

        for (const filePath of filePaths) {
            const support = await loadCodeLanguageSupportByPath(filePath);
            expect(support).not.toBeNull();
        }
    });
});
