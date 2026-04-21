/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, Registry, type IRawGrammar } from "vscode-textmate";

import {
    SYNTAX_HIGHLIGHT_BASELINE_FIXTURES,
    type SyntaxHighlightFixture,
} from "./syntaxHighlightFixtures";
import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    TEXT_MATE_LANGUAGE_DEFINITIONS,
    type TextMateGrammarDefinition,
} from "./monacoTextmateLanguages";
import {
    createComandoTextMateTheme,
    type ComandoTextMateThemeInput,
    type ComandoTextMateThemeName,
} from "./monacoTextmateTheme";

// Bit layout used by vscode-textmate to encode token metadata. Mirrors
// MetadataConsts.FOREGROUND_OFFSET (15) and FOREGROUND_MASK (0x00ff8000) from
// the vscode-textmate sources. They are kept local because vscode-textmate does
// not export them publicly.
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0x00ff8000;

const DARK_THEME_INPUT = {
    accent: "#818CF8",
    editorBackground: "#1C1C1C",
    editorForeground: "#E8E8E8",
    isDark: true,
    textSecondary: "#737373",
    themeName: "comando-dark",
} as const satisfies ComandoTextMateThemeInput;

const LIGHT_THEME_INPUT = {
    accent: "#6366F1",
    editorBackground: "#FFFFFF",
    editorForeground: "#1F2937",
    isDark: false,
    textSecondary: "#737373",
    themeName: "comando-light",
} as const satisfies ComandoTextMateThemeInput;

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

let onigWasmPromise: Promise<void> | null = null;
const rawGrammarCache = new Map<string, IRawGrammar>();
const encodedLanguageIds = new Map<string, number>();

// Mirrors the tokenization helper used in monacoTextmateTheme.test.ts to avoid
// coupling test code; the chromatic measurement needs the exact same grammar
// loading pipeline, so we replicate the setup locally.
function loadOnigWasm(): Promise<void> {
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

function getInjectionScopeNames(scopeName: string): string[] | undefined {
    const scopeNames = TEXT_MATE_GRAMMAR_DEFINITIONS.flatMap((definition) => {
        if (!("injectTo" in definition)) {
            return [];
        }

        const injectionTargets = definition.injectTo as readonly string[];
        return injectionTargets.includes(scopeName)
            ? [definition.scopeName]
            : [];
    });

    return scopeNames.length > 0 ? scopeNames : undefined;
}

function getEncodedLanguageId(languageId: string): number {
    const cached = encodedLanguageIds.get(languageId);
    if (cached) {
        return cached;
    }

    const nextId = encodedLanguageIds.size + 1;
    encodedLanguageIds.set(languageId, nextId);
    return nextId;
}

function createEmbeddedLanguagesConfiguration(
    definition: TextMateGrammarDefinition,
): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(definition.embeddedLanguages ?? {}).map(
            ([scopeName, embeddedLanguageId]) => [
                scopeName,
                getEncodedLanguageId(embeddedLanguageId),
            ],
        ),
    );
}

function createRegistryForTheme(
    themeInput: ComandoTextMateThemeInput,
): { readonly registry: Registry; readonly colorMap: readonly string[] } {
    const theme = createComandoTextMateTheme(themeInput);
    const registry = new Registry({
        colorMap: [...theme.indexedColorMap],
        getInjections: getInjectionScopeNames,
        loadGrammar: loadRawGrammarByScope,
        onigLib: loadOnigWasm().then(() => ({
            createOnigScanner: (sources: string[]) => new OnigScanner(sources),
            createOnigString: (source: string) => new OnigString(source),
        })),
        theme: theme.rawTheme,
    });

    return { colorMap: theme.indexedColorMap, registry };
}

export interface ChromaticCoverageResult {
    readonly languageId: string;
    readonly tokenCount: number;
    readonly distinctForegroundCount: number;
    readonly distinctForegroundIds: readonly number[];
}

export interface ChromaticCoverageOptions {
    readonly themeName: ComandoTextMateThemeName;
}

function resolveThemeInput(
    themeName: ComandoTextMateThemeName,
): ComandoTextMateThemeInput {
    return themeName === "comando-dark" ? DARK_THEME_INPUT : LIGHT_THEME_INPUT;
}

function extractForegroundId(metadata: number): number {
    return (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
}

export async function measureChromaticCoverage(
    languageId: string,
    source: string,
    options: ChromaticCoverageOptions,
): Promise<ChromaticCoverageResult> {
    const definition = grammarDefinitionsByLanguageId.get(languageId);
    if (!definition) {
        throw new Error(
            `No TextMate grammar definition for language id "${languageId}".`,
        );
    }

    const themeInput = resolveThemeInput(options.themeName);
    const { registry } = createRegistryForTheme(themeInput);
    const grammar = await registry.loadGrammarWithConfiguration(
        definition.scopeName,
        getEncodedLanguageId(definition.languageId),
        {
            embeddedLanguages: createEmbeddedLanguagesConfiguration(definition),
        },
    );

    if (!grammar) {
        throw new Error(
            `Could not load grammar "${definition.scopeName}" for "${languageId}".`,
        );
    }

    const lines = source.split(/\r?\n/);
    const distinctForegroundIds = new Set<number>();
    let tokenCount = 0;
    let ruleStack = INITIAL;

    for (const line of lines) {
        const lineTokens = grammar.tokenizeLine2(line, ruleStack);
        const tokens = lineTokens.tokens;

        for (let index = 0; index < tokens.length; index += 2) {
            const metadata = tokens[index + 1] ?? 0;
            const foregroundId = extractForegroundId(metadata);

            // Foreground id 0 means "no foreground override" (editor default).
            // We still count it because an absence of color is a distinguishable
            // visual signal inside the paint, but skipping it would also be a
            // valid interpretation. Including it gives a more complete view of
            // the chromatic surface emitted by each grammar.
            distinctForegroundIds.add(foregroundId);
            tokenCount += 1;
        }

        ruleStack = lineTokens.ruleStack;
    }

    const sortedForegroundIds = Array.from(distinctForegroundIds).sort(
        (first, second) => first - second,
    );

    return {
        distinctForegroundCount: sortedForegroundIds.length,
        distinctForegroundIds: sortedForegroundIds,
        languageId,
        tokenCount,
    };
}

// Returns the chromatic coverage for every fixture in
// SYNTAX_HIGHLIGHT_BASELINE_FIXTURES under the requested theme.
export async function measureBaselineChromaticCoverage(
    options: ChromaticCoverageOptions,
): Promise<readonly ChromaticCoverageResult[]> {
    const results: ChromaticCoverageResult[] = [];

    for (const fixture of SYNTAX_HIGHLIGHT_BASELINE_FIXTURES) {
        const coverage = await measureChromaticCoverageForFixture(
            fixture,
            options,
        );
        results.push(coverage);
    }

    return results;
}

async function measureChromaticCoverageForFixture(
    fixture: SyntaxHighlightFixture,
    options: ChromaticCoverageOptions,
): Promise<ChromaticCoverageResult> {
    // Fixtures whose languageId is not backed by a TextMate grammar (for
    // example plaintext) are still reported so callers can reason about them,
    // but with an empty coverage entry rather than throwing.
    if (!grammarDefinitionsByLanguageId.has(fixture.languageId)) {
        return {
            distinctForegroundCount: 0,
            distinctForegroundIds: [],
            languageId: fixture.languageId,
            tokenCount: 0,
        };
    }

    return measureChromaticCoverage(fixture.languageId, fixture.content, options);
}
