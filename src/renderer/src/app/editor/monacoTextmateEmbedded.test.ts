/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import {
    INITIAL,
    Registry,
    type IGrammar,
    type IRawGrammar,
} from "vscode-textmate";

import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    TEXT_MATE_LANGUAGE_DEFINITIONS,
    type TextMateGrammarDefinition,
} from "./monacoTextmateLanguages";

const TEST_MONACO_LANGUAGE_ID_ALIASES: Readonly<Record<string, string>> = {
    jsx: "javascriptreact",
    tsx: "typescriptreact",
};

const grammarDefinitionsByScope = new Map<string, TextMateGrammarDefinition>(
    TEXT_MATE_GRAMMAR_DEFINITIONS.map((definition) => [
        definition.scopeName,
        definition,
    ]),
);
const grammarDefinitionsByLanguageId = new Map<
    string,
    TextMateGrammarDefinition
>(
    TEXT_MATE_LANGUAGE_DEFINITIONS.map((definition) => [
        definition.languageId,
        definition,
    ]),
);

const rawGrammarCache = new Map<string, IRawGrammar>();
const configuredGrammarCache = new Map<string, Promise<IGrammar>>();
const testEncodedLanguageIds = new Map<string, number>();
let onigWasmPromise: Promise<void> | null = null;

function normalizeTestMonacoLanguageId(languageId: string): string {
    const normalizedLanguageId = languageId.trim().toLowerCase();

    return (
        TEST_MONACO_LANGUAGE_ID_ALIASES[normalizedLanguageId] ??
        normalizedLanguageId
    );
}

function getTestEncodedLanguageId(languageId: string): number {
    const normalizedLanguageId = normalizeTestMonacoLanguageId(languageId);
    const cachedLanguageId = testEncodedLanguageIds.get(normalizedLanguageId);
    if (cachedLanguageId) {
        return cachedLanguageId;
    }

    const encodedLanguageId = testEncodedLanguageIds.size + 1;
    testEncodedLanguageIds.set(normalizedLanguageId, encodedLanguageId);
    return encodedLanguageId;
}

function loadOnigWasm() {
    if (!onigWasmPromise) {
        onigWasmPromise = (async () => {
            const wasmBytes = await readFile(
                join(
                    process.cwd(),
                    "node_modules/vscode-oniguruma/release/onig.wasm",
                ),
            );
            const wasmBuffer = wasmBytes.buffer.slice(
                wasmBytes.byteOffset,
                wasmBytes.byteOffset + wasmBytes.byteLength,
            );

            await loadWASM(wasmBuffer);
        })();
    }

    return onigWasmPromise;
}

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

async function loadRawGrammarByScope(
    scopeName: string,
): Promise<IRawGrammar | null> {
    const cachedGrammar = rawGrammarCache.get(scopeName);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const definition = grammarDefinitionsByScope.get(scopeName);
    if (!definition) {
        return null;
    }

    const grammarModule = await definition.loadModule();
    for (const grammar of grammarModule.default) {
        const grammarScopeName = getRawGrammarScopeName(grammar);
        if (grammarScopeName) {
            rawGrammarCache.set(grammarScopeName, grammar as IRawGrammar);
        }
    }

    return rawGrammarCache.get(scopeName) ?? null;
}

function createRegistry() {
    return new Registry({
        loadGrammar: loadRawGrammarByScope,
        onigLib: loadOnigWasm().then(() => ({
            createOnigScanner: (sources: string[]) => new OnigScanner(sources),
            createOnigString: (source: string) => new OnigString(source),
        })),
    });
}

function createEmbeddedLanguagesConfiguration(
    definition: TextMateGrammarDefinition,
) {
    return Object.fromEntries(
        Object.entries(definition.embeddedLanguages ?? {}).map(
            ([scopeName, languageId]) => [
                scopeName,
                getTestEncodedLanguageId(languageId),
            ],
        ),
    );
}

async function loadConfiguredGrammar(languageId: string): Promise<IGrammar> {
    const cachedGrammar = configuredGrammarCache.get(languageId);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const definition = grammarDefinitionsByLanguageId.get(languageId);
    if (!definition) {
        throw new Error(`Missing TextMate definition for ${languageId}.`);
    }

    // vscode-textmate mutates raw grammar objects while compiling them, so this
    // mirrors runtime by reusing each configured grammar instance.
    const grammarPromise = (async () => {
        const registry = createRegistry();
        const grammar = await registry.loadGrammarWithConfiguration(
            definition.scopeName,
            getTestEncodedLanguageId(definition.languageId),
            {
                embeddedLanguages:
                    createEmbeddedLanguagesConfiguration(definition),
            },
        );

        if (!grammar) {
            throw new Error(`Could not load grammar for ${languageId}.`);
        }

        return grammar;
    })();

    configuredGrammarCache.set(languageId, grammarPromise);
    return grammarPromise;
}

function getEncodedTokenLanguageIds(tokens: Uint32Array): number[] {
    const languageIds: number[] = [];

    for (let index = 1; index < tokens.length; index += 2) {
        languageIds.push(tokens[index] & 0xff);
    }

    return languageIds;
}

async function tokenizeLineLanguageIds(options: {
    readonly languageId: string;
    readonly lines: readonly string[];
    readonly targetLineIndex: number;
}): Promise<number[]> {
    const grammar = await loadConfiguredGrammar(options.languageId);
    let state = INITIAL;

    for (const [lineIndex, line] of options.lines.entries()) {
        const lineTokens = grammar.tokenizeLine2(line, state);
        state = lineTokens.ruleStack;

        if (lineIndex === options.targetLineIndex) {
            return getEncodedTokenLanguageIds(lineTokens.tokens);
        }
    }

    throw new Error(`Target line ${options.targetLineIndex} was not tokenized.`);
}

describe("TextMate embedded languages", () => {
    it("declares embedded language maps for Markdown and component files", () => {
        const markdown = grammarDefinitionsByLanguageId.get("markdown");
        const vue = grammarDefinitionsByLanguageId.get("vue");
        const svelte = grammarDefinitionsByLanguageId.get("svelte");
        const astro = grammarDefinitionsByLanguageId.get("astro");

        expect(markdown?.embeddedLanguages).toMatchObject({
            "meta.embedded.block.html": "html",
            "meta.embedded.block.js": "javascript",
            "meta.embedded.block.javascriptreact": "jsx",
            "meta.embedded.block.shellscript": "shell",
            "meta.embedded.block.ts": "typescript",
            "meta.embedded.block.typescriptreact": "tsx",
            "text.html.derivative": "html",
        });
        expect(vue?.embeddedLanguages).toMatchObject({
            "source.css": "css",
            "source.ts": "typescript",
            "text.html.basic": "html",
        });
        expect(svelte?.embeddedLanguages).toMatchObject({
            "source.css": "css",
            "source.ts": "typescript",
        });
        expect(astro?.embeddedLanguages).toMatchObject({
            "source.css": "css",
            "source.ts": "typescript",
            "source.tsx": "tsx",
        });
    });

    it("assigns embedded language ids to common Markdown fences", async () => {
        await expect(
            tokenizeLineLanguageIds({
                languageId: "markdown",
                lines: [
                    "```ts",
                    "export const answer: number = 42;",
                    "```",
                ],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("typescript"));

        await expect(
            tokenizeLineLanguageIds({
                languageId: "markdown",
                lines: ["```jsx", "const view = <Button />;", "```"],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("jsx"));

        await expect(
            tokenizeLineLanguageIds({
                languageId: "markdown",
                lines: [
                    "```html",
                    '<section class="hero">Comando</section>',
                    "```",
                ],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("html"));
    });

    it("assigns embedded language ids to Markdown frontmatter", async () => {
        await expect(
            tokenizeLineLanguageIds({
                languageId: "markdown",
                lines: ["---", "title: Comando", "---", "# Notes"],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("yaml"));
    });

    it("assigns embedded language ids inside Vue, Svelte, and Astro blocks", async () => {
        await expect(
            tokenizeLineLanguageIds({
                languageId: "vue",
                lines: [
                    '<script setup lang="ts">',
                    'const value: string = "x";',
                    "</script>",
                ],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("typescript"));

        await expect(
            tokenizeLineLanguageIds({
                languageId: "svelte",
                lines: [
                    "<style>",
                    ".button { color: red; }",
                    "</style>",
                ],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("css"));

        await expect(
            tokenizeLineLanguageIds({
                languageId: "astro",
                lines: [
                    '<script lang="ts">',
                    'const value: string = "x";',
                    "</script>",
                ],
                targetLineIndex: 1,
            }),
        ).resolves.toContain(getTestEncodedLanguageId("typescript"));
    });
});
