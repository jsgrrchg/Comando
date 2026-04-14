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
        expect(resolveMarkdownCodeLanguageKey("bash")).toBe("shell");
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
        expect(resolveCodeLanguageKeyFromPath("/workspace/.env")).toBe(
            "properties",
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
});
