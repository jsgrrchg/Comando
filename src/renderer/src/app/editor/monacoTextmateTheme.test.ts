/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, Registry, type IRawGrammar } from "vscode-textmate";

import { MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT } from "./monacoSemanticTokens";
import {
    createComandoTextMateTheme,
    createMonarchFallbackRules,
    type ComandoTextMateThemeInput,
} from "./monacoTextmateTheme";
import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    type TextMateGrammarDefinition,
} from "./monacoTextmateLanguages";

const FOREGROUND_MASK = 0x00ff8000;
const FOREGROUND_OFFSET = 15;

const themeInput = {
    accent: "#818CF8",
    editorBackground: "#1C1C1C",
    editorForeground: "#E8E8E8",
    isDark: true,
    textSecondary: "#8A8A8A",
    themeName: "comando-dark",
} as const satisfies ComandoTextMateThemeInput;

const lightThemeInput = {
    accent: "#6366F1",
    editorBackground: "#FFFFFF",
    editorForeground: "#1C1C1C",
    isDark: false,
    textSecondary: "#737373",
    themeName: "comando-light",
} as const satisfies ComandoTextMateThemeInput;

let onigWasmPromise: Promise<void> | null = null;
const grammarDefinitionsByScope = new Map<string, TextMateGrammarDefinition>(
    TEXT_MATE_GRAMMAR_DEFINITIONS.map((definition) => [
        definition.scopeName,
        definition,
    ]),
);
const rawGrammarCache = new Map<string, IRawGrammar>();

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

function foregroundId(metadata: number): number {
    return (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
}

function foregroundIdForText(
    tokens: Uint32Array,
    line: string,
    text: string,
): number {
    const targetOffset = line.indexOf(text);

    if (targetOffset < 0) {
        throw new Error(`Text "${text}" was not found in "${line}".`);
    }

    for (let index = 0; index < tokens.length; index += 2) {
        const tokenOffset = tokens[index] ?? 0;
        const nextTokenOffset = tokens[index + 2] ?? line.length;

        if (tokenOffset <= targetOffset && targetOffset < nextTokenOffset) {
            return foregroundId(tokens[index + 1] ?? 0);
        }
    }

    throw new Error(`No token covered "${text}" in "${line}".`);
}

function createFixtureGrammar(): IRawGrammar {
    return {
        name: "Comando TextMate Fixture",
        patterns: [
            {
                match: "\\breturn\\b",
                name: "keyword.control.comando-fixture",
            },
            {
                match: "\\bfoo\\b",
                name: "entity.name.function.comando-fixture",
            },
            {
                match: "\\bbar\\b",
                name: "variable.parameter.comando-fixture",
            },
            {
                match: "\\bstring\\b",
                name: "entity.name.type.comando-fixture",
            },
            {
                match: "\"(?:[^\"\\\\]|\\\\.)*\"",
                name: "string.quoted.double.comando-fixture",
            },
        ],
        repository: {
            $base: {},
            $self: {},
        },
        scopeName: "source.comando-fixture",
    };
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

function getInjectionScopeNames(scopeName: string): string[] | undefined {
    const scopeNames = TEXT_MATE_GRAMMAR_DEFINITIONS.flatMap((definition) => {
        if (!("injectTo" in definition)) {
            return [];
        }

        const injectionTargets = definition.injectTo as readonly string[];
        return injectionTargets.includes(scopeName) ? [definition.scopeName] : [];
    });

    return scopeNames.length > 0 ? scopeNames : undefined;
}

function relativeLuminance(hexColor: string): number {
    const [red, green, blue] = [0, 2, 4].map((offset) => {
        const channel =
            Number.parseInt(hexColor.slice(1 + offset, 3 + offset), 16) / 255;

        return channel <= 0.03928
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(firstColor: string, secondColor: string): number {
    const firstLuminance = relativeLuminance(firstColor);
    const secondLuminance = relativeLuminance(secondColor);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);

    return (lighter + 0.05) / (darker + 0.05);
}

function flattenThemeScopes(theme: ReturnType<typeof createComandoTextMateTheme>) {
    return theme.rawTheme.settings.flatMap((setting) => {
        if (!setting.scope) {
            return [];
        }

        return Array.isArray(setting.scope) ? setting.scope : [setting.scope];
    });
}

function flattenPaletteColors(
    theme: ReturnType<typeof createComandoTextMateTheme>,
): string[] {
    const anchors = [
        theme.palette.anchors.comment,
        theme.palette.anchors.constant,
        theme.palette.anchors.escape,
        theme.palette.anchors.function,
        theme.palette.anchors.keyword,
        theme.palette.anchors.markup,
        theme.palette.anchors.parameter,
        theme.palette.anchors.property,
        theme.palette.anchors.string,
        theme.palette.anchors.type,
        theme.palette.anchors.typeParameter,
        theme.palette.anchors.variable,
    ];

    return [
        ...anchors,
        theme.palette.attribute,
        theme.palette.comment,
        theme.palette.constant,
        theme.palette.decorator,
        theme.palette.escape,
        theme.palette.function,
        theme.palette.keyword,
        theme.palette.macro,
        theme.palette.namespace,
        theme.palette.number,
        theme.palette.parameter,
        theme.palette.property,
        theme.palette.regexp,
        theme.palette.string,
        theme.palette.tag,
        theme.palette.type,
        theme.palette.typeParameter,
        theme.palette.variable,
    ];
}

function anchorColors(
    theme: ReturnType<typeof createComandoTextMateTheme>,
): string[] {
    return [
        theme.palette.anchors.comment,
        theme.palette.anchors.constant,
        theme.palette.anchors.escape,
        theme.palette.anchors.function,
        theme.palette.anchors.keyword,
        theme.palette.anchors.markup,
        theme.palette.anchors.parameter,
        theme.palette.anchors.property,
        theme.palette.anchors.string,
        theme.palette.anchors.type,
        theme.palette.anchors.typeParameter,
        theme.palette.anchors.variable,
    ];
}

describe("monacoTextmateTheme", () => {
    it("caches raw themes and exposes Monaco encoded color maps", () => {
        const theme = createComandoTextMateTheme(themeInput);

        expect(createComandoTextMateTheme(themeInput)).toBe(theme);
        expect(theme.encodedTokensColors).toEqual(
            theme.indexedColorMap.slice(1),
        );
        expect(
            theme.rawTheme.settings.find(
                (setting) =>
                    Array.isArray(setting.scope) &&
                    setting.scope.includes("entity.name.function"),
            )?.settings.foreground,
        ).toBe(theme.palette.function);
        expect(
            theme.rawTheme.settings.find(
                (setting) =>
                    Array.isArray(setting.scope) &&
                    setting.scope.includes("variable.parameter"),
            )?.settings.foreground,
        ).toBe(theme.palette.parameter);
        expect(theme.semanticTokenColors.class.foreground).toBe(
            theme.palette.type,
        );
        expect(theme.semanticTokenColors.property.foreground).toBe(
            theme.palette.property,
        );
        expect(Object.keys(theme.semanticTokenColors)).toEqual(
            expect.arrayContaining([
                ...MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT.selectors,
            ]),
        );
        expect(MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT.fixture).toContain(
            "readonly",
        );
        expect(MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT.fixture).toContain(
            "static",
        );
        expect(MONACO_TYPESCRIPT_SEMANTIC_TOKEN_AUDIT.fixture).toContain(
            "async",
        );
    });

    it("uses accessible multi-anchor code palettes in light and dark themes", () => {
        const themes = [
            createComandoTextMateTheme(themeInput),
            createComandoTextMateTheme(lightThemeInput),
        ];

        for (const theme of themes) {
            const background = theme.rawTheme.settings[0]?.settings.background;

            if (!background) {
                throw new Error("Expected the theme to declare a background.");
            }

            expect(new Set(anchorColors(theme)).size).toBe(12);

            for (const color of flattenPaletteColors(theme)) {
                expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(
                    4.5,
                );
            }
        }
    });

    it("declares common, markdown, invalid, and TS/JS-specific TextMate scopes", () => {
        const theme = createComandoTextMateTheme(themeInput);
        const scopes = flattenThemeScopes(theme);

        expect(scopes).toEqual(
            expect.arrayContaining([
                "comment",
                "string",
                "constant.numeric",
                "constant.language",
                "keyword",
                "keyword.operator",
                "storage",
                "entity.name.function",
                "support.function",
                "entity.name.type",
                "support.type",
                "entity.name.class",
                "entity.name.namespace",
                "variable",
                "variable.parameter",
                "variable.other.property",
                "variable.other.constant",
                "entity.other.attribute-name",
                "entity.name.tag",
                "punctuation.definition.string",
                "constant.character.escape",
                "markup.heading",
                "markup.bold",
                "markup.italic",
                "markup.inline.raw",
                "markup.fenced_code",
                "invalid",
                "variable.other.property.ts",
                "variable.other.constant.property.ts",
                "variable.other.readwrite.ts",
                "entity.name.function.ts",
                "entity.name.type.module.ts",
                "variable.other.property.rust",
                "meta.use.rust variable.other.rust",
                "variable.other.property.tsx",
                "variable.other.property.js",
                "variable.other.property.js.jsx",
            ]),
        );
    });

    it("resolves TextMate scope selectors into encoded token foreground ids", async () => {
        const theme = createComandoTextMateTheme(themeInput);
        const fixtureGrammar = createFixtureGrammar();
        const registry = new Registry({
            colorMap: [...theme.indexedColorMap],
            loadGrammar: (scopeName) =>
                Promise.resolve(
                    scopeName === fixtureGrammar.scopeName
                        ? fixtureGrammar
                        : null,
                ),
            onigLib: loadOnigWasm().then(() => ({
                createOnigScanner: (sources: string[]) =>
                    new OnigScanner(sources),
                createOnigString: (source: string) => new OnigString(source),
            })),
            theme: theme.rawTheme,
        });
        const grammar = await registry.loadGrammarWithConfiguration(
            fixtureGrammar.scopeName,
            1,
            {},
        );
        const line = `function foo(bar: string) { return "hello"; }`;
        const lineTokens = grammar?.tokenizeLine2(line, INITIAL);

        expect(grammar).not.toBeNull();
        expect(lineTokens?.tokens).toBeInstanceOf(Uint32Array);
        if (!lineTokens) {
            throw new Error("Expected the fixture grammar to tokenize the line.");
        }

        const tokens = lineTokens.tokens;

        expect(
            theme.indexedColorMap[foregroundIdForText(tokens, line, "foo")],
        ).toBe(theme.palette.function);
        expect(
            theme.indexedColorMap[foregroundIdForText(tokens, line, "bar")],
        ).toBe(theme.palette.parameter);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(tokens, line, "string")
            ],
        ).toBe(theme.palette.type);
        expect(
            theme.indexedColorMap[foregroundIdForText(tokens, line, "return")],
        ).toBe(theme.palette.keyword);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(tokens, line, "\"hello\"")
            ],
        ).toBe(theme.palette.string);
    });

    it("derives Monarch fallback rules from the palette without duplicating TextMate-only scopes", () => {
        const theme = createComandoTextMateTheme(themeInput);
        const rules = createMonarchFallbackRules(theme.palette);
        const tokens = rules.map((rule) => rule.token);

        // Core Monarch/basic-language tokens must be present — these are the
        // ones the Monaco basic-languages tokenizers actually emit.
        expect(tokens).toEqual(
            expect.arrayContaining([
                "comment",
                "keyword",
                "string",
                "number",
                "type.identifier",
                "regexp",
                "tag",
                "attribute.name",
                "variable.parameter",
                "annotation",
                "namespace",
                "parameter",
                "property",
                "invalid",
            ]),
        );

        // TextMate-only compound selectors must NOT leak into Monarch rules
        // — the TextMate encoded color map handles them on its own.
        for (const token of tokens) {
            expect(token).not.toMatch(/^source\./);
            expect(token).not.toMatch(/^entity\./);
            expect(token).not.toMatch(/^support\./);
            expect(token).not.toMatch(/^punctuation\./);
        }

        // Foregrounds match the palette verbatim and still wear the leading
        // `#` (Monaco callers are responsible for stripping it).
        const commentRule = rules.find((rule) => rule.token === "comment");
        expect(commentRule?.foreground).toBe(theme.palette.comment);
        expect(commentRule?.foreground.startsWith("#")).toBe(true);
        expect(commentRule?.fontStyle).toBe("italic");

        const keywordRule = rules.find((rule) => rule.token === "keyword");
        expect(keywordRule?.foreground).toBe(theme.palette.keyword);

        // Sanity check on size: the list should be compact, not a dump of
        // every TextMate scope.
        expect(rules.length).toBeLessThan(50);
    });

    it("keeps Rust imports, properties, functions, types, and constants visually distinct", async () => {
        const theme = createComandoTextMateTheme(themeInput);
        const registry = new Registry({
            colorMap: [...theme.indexedColorMap],
            getInjections: getInjectionScopeNames,
            loadGrammar: loadRawGrammarByScope,
            onigLib: loadOnigWasm().then(() => ({
                createOnigScanner: (sources: string[]) =>
                    new OnigScanner(sources),
                createOnigString: (source: string) => new OnigString(source),
            })),
            theme: theme.rawTheme,
        });
        const grammar = await registry.loadGrammarWithConfiguration(
            "source.rust",
            1,
            {},
        );

        expect(grammar).not.toBeNull();
        if (!grammar) {
            throw new Error("Expected the Rust grammar to load.");
        }

        const useStart = grammar.tokenizeLine2("use crate::{", INITIAL);
        const useLine =
            "    prompt_args::{expand_custom_prompt, parse_slash_name},";
        const useTokens = grammar.tokenizeLine2(
            useLine,
            useStart.ruleStack,
        ).tokens;
        expect(
            theme.indexedColorMap[
                foregroundIdForText(useTokens, useLine, "prompt_args")
            ],
        ).toBe(theme.palette.namespace);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(useTokens, useLine, "expand_custom_prompt")
            ],
        ).toBe(theme.palette.function);

        const propertyLine =
            "if &preset.approval != approval_policy { return false; }";
        const propertyTokens = grammar.tokenizeLine2(propertyLine, INITIAL).tokens;
        expect(
            theme.indexedColorMap[
                foregroundIdForText(propertyTokens, propertyLine, "approval")
            ],
        ).toBe(theme.palette.property);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(propertyTokens, propertyLine, "return")
            ],
        ).toBe(theme.palette.keyword);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(propertyTokens, propertyLine, "false")
            ],
        ).toBe(theme.palette.constant);

        const declarationLine =
            'const CODEX_ACP_STATUS_EVENT_TYPE_KEY: &str = "codex";';
        const declarationTokens = grammar.tokenizeLine2(
            declarationLine,
            INITIAL,
        ).tokens;
        expect(
            theme.indexedColorMap[
                foregroundIdForText(
                    declarationTokens,
                    declarationLine,
                    "CODEX_ACP_STATUS_EVENT_TYPE_KEY",
                )
            ],
        ).toBe(theme.palette.constant);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(declarationTokens, declarationLine, "str")
            ],
        ).toBe(theme.palette.type);
        expect(
            theme.indexedColorMap[
                foregroundIdForText(
                    declarationTokens,
                    declarationLine,
                    "\"codex\"",
                )
            ],
        ).toBe(theme.palette.string);
    });
});
