import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ensureMonacoTextMateProvider,
    getTextMateLanguageIds,
    getTextMateScopeName,
    isTextMateLanguageSupported,
} from "./monacoTextmate";
import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    TEXT_MATE_INJECTION_DEFINITIONS,
    TEXT_MATE_LANGUAGE_DEFINITIONS,
    type TextMateGrammarDefinition,
} from "./monacoTextmateLanguages";

const loadGrammarWithConfigurationMock = vi.hoisted(() =>
    vi.fn(async () => ({
        tokenizeLine2: vi.fn(() => ({
            ruleStack: { depth: 1 },
            tokens: new Uint32Array([0, 123]),
        })),
    })),
);
const registrySetThemeMock = vi.hoisted(() => vi.fn());

vi.mock("vscode-textmate", () => ({
    INITIAL: { depth: 0 },
    Registry: vi.fn().mockImplementation(function MockRegistry() {
        return {
            loadGrammarWithConfiguration: loadGrammarWithConfigurationMock,
            setTheme: registrySetThemeMock,
        };
    }),
}));

vi.mock("vscode-oniguruma", () => ({
    OnigScanner: vi.fn(),
    OnigString: vi.fn(),
    loadWASM: vi.fn(async () => {}),
}));

const textMateDefinitionsByLanguageId = new Map<
    string,
    TextMateGrammarDefinition
>(
    TEXT_MATE_LANGUAGE_DEFINITIONS.map((definition) => [
        definition.languageId,
        definition,
    ]),
);

function getRawGrammarScopeName(grammar: unknown): string | null {
    if (
        typeof grammar === "object" &&
        grammar !== null &&
        "scopeName" in grammar &&
        typeof grammar.scopeName === "string"
    ) {
        return grammar.scopeName;
    }

    return null;
}

interface TestEncodedTokensProvider {
    getInitialState(): unknown;
    tokenizeEncoded(
        line: string,
        state: unknown,
    ): { readonly tokens: Uint32Array };
}

afterEach(() => {
    vi.unstubAllGlobals();
    loadGrammarWithConfigurationMock.mockClear();
    registrySetThemeMock.mockClear();
});

describe("monacoTextmate", () => {
    it("exposes the primary TextMate language set", () => {
        expect(getTextMateLanguageIds()).toEqual([
            "astro",
            "bat",
            "c",
            "clojure",
            "cmake",
            "cpp",
            "csharp",
            "css",
            "csv",
            "d",
            "dart",
            "diff",
            "dockerfile",
            "elixir",
            "erlang",
            "fish",
            "go",
            "graphql",
            "groovy",
            "haskell",
            "hcl",
            "html",
            "http",
            "ini",
            "java",
            "javascript",
            "jsx",
            "json",
            "jsonc",
            "julia",
            "kotlin",
            "less",
            "log",
            "lua",
            "makefile",
            "markdown",
            "mdx",
            "nginx",
            "nix",
            "nu",
            "objc",
            "pascal",
            "perl",
            "php",
            "powershell",
            "prisma",
            "protobuf",
            "python",
            "r",
            "ruby",
            "rust",
            "sass",
            "scala",
            "scss",
            "shell",
            "solidity",
            "sql",
            "stylus",
            "svelte",
            "swift",
            "tcl",
            "toml",
            "typescript",
            "tsx",
            "vb",
            "vue",
            "wast",
            "xml",
            "yaml",
            "zig",
        ]);
    });

    it("maps supported language ids to their TextMate scopes", () => {
        expect(getTextMateScopeName("astro")).toBe("source.astro");
        expect(getTextMateScopeName("typescript")).toBe("source.ts");
        expect(getTextMateScopeName("ts")).toBe("source.ts");
        expect(getTextMateScopeName("tsx")).toBe("source.tsx");
        expect(getTextMateScopeName("typescriptreact")).toBe("source.tsx");
        expect(getTextMateScopeName("javascript")).toBe("source.js");
        expect(getTextMateScopeName("js")).toBe("source.js");
        expect(getTextMateScopeName("jsx")).toBe("source.js.jsx");
        expect(getTextMateScopeName("javascriptreact")).toBe("source.js.jsx");
        expect(getTextMateScopeName("rust")).toBe("source.rust");
        expect(getTextMateScopeName("rs")).toBe("source.rust");
        expect(getTextMateScopeName("python")).toBe("source.python");
        expect(getTextMateScopeName("py")).toBe("source.python");
        expect(getTextMateScopeName("shell")).toBe("source.shell");
        expect(getTextMateScopeName("bash")).toBe("source.shell");
        expect(getTextMateScopeName("dockerfile")).toBe("source.dockerfile");
        expect(getTextMateScopeName("docker")).toBe("source.dockerfile");
        expect(getTextMateScopeName("cmake")).toBe("source.cmake");
        expect(getTextMateScopeName("hcl")).toBe("source.hcl");
        expect(getTextMateScopeName("terraform")).toBe("source.hcl");
        expect(getTextMateScopeName("ruby")).toBe("source.ruby");
        expect(getTextMateScopeName("rb")).toBe("source.ruby");
        expect(getTextMateScopeName("json")).toBe("source.json");
        expect(getTextMateScopeName("jsonc")).toBe("source.json.comments");
        expect(getTextMateScopeName("markdown")).toBe("text.html.markdown");
        expect(getTextMateScopeName("mdx")).toBe("source.mdx");
        expect(getTextMateScopeName("vue")).toBe("text.html.vue");
        expect(getTextMateScopeName("svelte")).toBe("source.svelte");
        expect(getTextMateScopeName("prisma")).toBe("source.prisma");
        expect(getTextMateScopeName("cmd")).toBe("source.batchfile");
        expect(getTextMateScopeName("nu")).toBe("source.nushell");
        expect(getTextMateScopeName("wast")).toBe("source.wat");
    });

    it("reports unsupported ids cleanly", () => {
        expect(isTextMateLanguageSupported("astro")).toBe(true);
        expect(isTextMateLanguageSupported("rust")).toBe(true);
        expect(isTextMateLanguageSupported("typescript")).toBe(true);
        expect(isTextMateLanguageSupported("unknown-language")).toBe(false);
        expect(getTextMateScopeName("unknown-language")).toBeNull();
    });

    it("installs the Rust TextMate provider and refreshes Rust models", async () => {
        const rustModel = {
            getLanguageId: vi.fn(() => "rust"),
        };
        const typeScriptModel = {
            getLanguageId: vi.fn(() => "typescript"),
        };
        const installedProviders: TestEncodedTokensProvider[] = [];
        const setTokensProvider = vi.fn(
            (_languageId: string, provider: TestEncodedTokensProvider) => {
                installedProviders.push(provider);
                return { dispose: vi.fn() };
            },
        );
        const setModelLanguage = vi.fn();
        const monacoApi = {
            editor: {
                getModels: vi.fn(() => [rustModel, typeScriptModel]),
                setModelLanguage,
            },
            languages: {
                getEncodedLanguageId: vi.fn((languageId: string) =>
                    languageId === "rust" ? 42 : 0,
                ),
                setTokensProvider,
            },
        } as unknown as Parameters<typeof ensureMonacoTextMateProvider>[0];

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                arrayBuffer: async () => new ArrayBuffer(8),
                ok: true,
                status: 200,
                statusText: "OK",
            })),
        );

        await expect(
            ensureMonacoTextMateProvider(monacoApi, "rust"),
        ).resolves.toBe(true);

        expect(loadGrammarWithConfigurationMock).toHaveBeenCalledWith(
            "source.rust",
            42,
            expect.objectContaining({}),
        );
        expect(setTokensProvider).toHaveBeenCalledTimes(1);
        expect(setTokensProvider).toHaveBeenCalledWith(
            "rust",
            expect.objectContaining({
                getInitialState: expect.any(Function),
                tokenizeEncoded: expect.any(Function),
            }),
        );
        expect(setModelLanguage).toHaveBeenCalledTimes(1);
        expect(setModelLanguage).toHaveBeenCalledWith(rustModel, "rust");

        const provider = installedProviders[0];
        if (!provider) {
            throw new Error("Rust TextMate provider was not installed.");
        }

        const tokens = provider.tokenizeEncoded(
            "pub fn main() {}",
            provider.getInitialState(),
        ).tokens;

        expect(Array.from(tokens)).toEqual([0, 123]);

        const laterRustModel = {
            getLanguageId: vi.fn(() => "rust"),
        };
        const setTokensProviderAfterCacheHit = vi.fn(() => ({
            dispose: vi.fn(),
        }));
        const setModelLanguageAfterCacheHit = vi.fn();
        const laterMonacoApi = {
            editor: {
                getModels: vi.fn(() => [laterRustModel]),
                setModelLanguage: setModelLanguageAfterCacheHit,
            },
            languages: {
                getEncodedLanguageId: vi.fn(() => 42),
                setTokensProvider: setTokensProviderAfterCacheHit,
            },
        } as unknown as Parameters<typeof ensureMonacoTextMateProvider>[0];

        await expect(
            ensureMonacoTextMateProvider(laterMonacoApi, "rust"),
        ).resolves.toBe(true);

        expect(setTokensProviderAfterCacheHit).not.toHaveBeenCalled();
        expect(setModelLanguageAfterCacheHit).toHaveBeenCalledTimes(1);
        expect(setModelLanguageAfterCacheHit).toHaveBeenCalledWith(
            laterRustModel,
            "rust",
        );
    });

    it("keeps rich grammar metadata for embedded languages and token types", () => {
        const javascript =
            textMateDefinitionsByLanguageId.get("javascript") ?? null;
        const jsx = textMateDefinitionsByLanguageId.get("jsx") ?? null;
        const typescript =
            textMateDefinitionsByLanguageId.get("typescript") ?? null;
        const tsx = textMateDefinitionsByLanguageId.get("tsx") ?? null;

        expect(javascript?.embeddedLanguages).toMatchObject({
            "meta.embedded.expression.js": "javascript",
            "meta.tag.attributes.js": "javascript",
            "meta.tag.js": "jsx-tags",
        });
        expect(jsx?.embeddedLanguages).toMatchObject({
            "meta.embedded.expression.js": "jsx",
            "meta.tag.attributes.js.jsx": "jsx",
        });
        expect(typescript?.tokenTypes).toMatchObject({
            "entity.name.type.instance.jsdoc": "other",
            "string.regexp": "regex",
            "variable.other.jsdoc": "other",
        });
        expect(typescript?.unbalancedBracketScopes).toContain(
            "keyword.operator.relational",
        );
        expect(tsx?.embeddedLanguages).toMatchObject({
            "meta.embedded.expression.tsx": "tsx",
            "meta.tag.attributes.tsx": "tsx",
            "meta.tag.tsx": "jsx-tags",
        });
        expect(tsx?.unbalancedBracketScopes).toContain(
            "punctuation.definition.tag",
        );
    });

    it("declares injection scopes for JSDoc and tagged template grammars", () => {
        expect(TEXT_MATE_INJECTION_DEFINITIONS).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    injectTo: ["source.ts", "source.tsx"],
                    scopeName: "documentation.injection.ts",
                    shikiLanguageId: "vscode-jsdoc-injections",
                }),
                expect.objectContaining({
                    injectTo: ["source.rust"],
                    scopeName: "source.rust.comando-injections",
                    shikiLanguageId: "comando-rust-injections",
                }),
                expect.objectContaining({
                    injectTo: ["source.js", "source.js.jsx"],
                    scopeName: "documentation.injection.js.jsx",
                    shikiLanguageId: "vscode-jsdoc-injections",
                }),
                expect.objectContaining({
                    injectTo: [
                        "source.js",
                        "source.js.jsx",
                        "source.ts",
                        "source.tsx",
                    ],
                    scopeName: "inline.tagged-template-sql",
                    shikiLanguageId: "ts-tags",
                }),
            ]),
        );
    });

    it("keeps grammar scope names unique", () => {
        const scopeNames = TEXT_MATE_GRAMMAR_DEFINITIONS.map(
            (definition) => definition.scopeName,
        );

        expect(new Set(scopeNames).size).toBe(scopeNames.length);
    });

    it("keeps the Shiki grammar catalog curated and lazy", () => {
        expect(TEXT_MATE_LANGUAGE_DEFINITIONS).toHaveLength(70);
        expect(TEXT_MATE_GRAMMAR_DEFINITIONS.length).toBeLessThan(100);
        expect(
            TEXT_MATE_GRAMMAR_DEFINITIONS.map(
                (definition) => definition.shikiLanguageId,
            ),
        ).not.toContain("langs");
    });

    it("loads injection modules that expose their declared scopes", async () => {
        const modulesByShikiLanguageId = new Map<
            string,
            ReturnType<(typeof TEXT_MATE_INJECTION_DEFINITIONS)[number]["loadModule"]>
        >();

        for (const definition of TEXT_MATE_INJECTION_DEFINITIONS) {
            const modulePromise =
                modulesByShikiLanguageId.get(definition.shikiLanguageId) ??
                definition.loadModule();
            modulesByShikiLanguageId.set(
                definition.shikiLanguageId,
                modulePromise,
            );

            const grammarModule = await modulePromise;
            const exposedScopeNames = grammarModule.default.map(
                (grammar) => getRawGrammarScopeName(grammar),
            );

            expect(exposedScopeNames).toContain(definition.scopeName);
        }
    });
});
