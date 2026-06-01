import type * as monaco from "monaco-editor";
import {
    INITIAL,
    Registry,
    type IGrammar,
    type IGrammarConfiguration,
    type IRawGrammar,
    type RegistryOptions,
    type StateStack,
} from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";

import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";

import { MONACO_MAX_TOKENIZATION_LINE_LENGTH } from "./monacoPerformance";
import {
    TEXT_MATE_GRAMMAR_DEFINITIONS,
    TEXT_MATE_INJECTION_DEFINITIONS,
    TEXT_MATE_LANGUAGE_DEFINITIONS,
    type TextMateGrammarDefinition,
    type TextMateLanguageId,
    type TextMateTokenType,
} from "./monacoTextmateLanguages";
import type { ComandoTextMateTheme } from "./monacoTextmateTheme";

type MonacoNamespace = typeof import("monaco-editor");

const TEXT_MATE_LANGUAGE_IDS = TEXT_MATE_LANGUAGE_DEFINITIONS.map(
    (definition) => definition.languageId,
);

const textMateLanguageDefinitionsById = new Map<
    TextMateLanguageId,
    TextMateGrammarDefinition
>(
    TEXT_MATE_LANGUAGE_DEFINITIONS.map((definition) => [
        definition.languageId,
        definition,
    ]),
);
const textMateLanguageAliases = new Map<string, TextMateLanguageId>(
    TEXT_MATE_LANGUAGE_DEFINITIONS.flatMap((definition) =>
        definition.aliases.map((alias) => [
            normalizeLanguageId(alias),
            definition.languageId,
        ]),
    ),
);
const textMateGrammarDefinitionsByScope = new Map<
    string,
    TextMateGrammarDefinition
>(
    TEXT_MATE_GRAMMAR_DEFINITIONS.map((definition) => [
        definition.scopeName,
        definition,
    ]),
);
const injectionScopeNamesByTargetScope = new Map<string, string[]>();

for (const definition of TEXT_MATE_INJECTION_DEFINITIONS) {
    for (const targetScopeName of definition.injectTo ?? []) {
        const scopeNames =
            injectionScopeNamesByTargetScope.get(targetScopeName) ?? [];
        scopeNames.push(definition.scopeName);
        injectionScopeNamesByTargetScope.set(targetScopeName, scopeNames);
    }
}

const standardTokenTypeByName = {
    comment: 1,
    other: 0,
    regex: 3,
    string: 2,
} as const satisfies Record<TextMateTokenType, number>;

const monacoTextMateLanguageIds: Readonly<Record<string, string>> = {
    jsx: "javascriptreact",
    tsx: "typescriptreact",
};

const rawGrammarCache = new Map<string, IRawGrammar>();
const configuredGrammarLoadCache = new Map<string, Promise<IGrammar>>();
const grammarModuleLoadCache = new Map<string, Promise<void>>();
const encodedLanguageIds = new Map<string, number>();
const textMateProviderInstallCache = new Map<string, Promise<boolean>>();
const textMateProviderDisposables = new Map<string, { dispose(): void }>();

let onigLibPromise: Promise<{
    readonly createOnigScanner: (sources: string[]) => OnigScanner;
    readonly createOnigString: (source: string) => OnigString;
}> | null = null;
let textMateRegistryPromise: Promise<Registry> | null = null;
let activeMonacoNamespace: MonacoNamespace | null = null;
let currentTextMateTheme: ComandoTextMateTheme | null = null;
let textMateThemeVersion = 0;
let didRegisterHclFallback = false;
let didRegisterTextMateLanguageHooks = false;

const hclFallbackMonarchDefinition: monaco.languages.IMonarchLanguage = {
    brackets: [
        { open: "{", close: "}", token: "delimiter.curly" },
        { open: "[", close: "]", token: "delimiter.square" },
        { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    defaultToken: "",
    tokenizer: {
        root: [
            [/#.*$/, "comment"],
            [/\/\/.*$/, "comment"],
            [/\/\*.*?\*\//, "comment"],
            [/<<-?[A-Z][A-Z0-9_]*/, "string"],
            [
                /\b(?:terraform|provider|variable|output|resource|data|module|locals|backend|provisioner|connection|dynamic|moved|import|check|run)\b/,
                "keyword",
            ],
            [
                /\b(?:var|local|path|module|data|self|count|each|terraform)\b(?:\.[A-Za-z_][\w-]*)+/,
                "variable",
            ],
            [/\b[A-Za-z_][\w-]*(?=\s*=)/, "variable.other.member"],
            [/\b[A-Za-z_][\w-]*(?=\s*\()/, "function"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/\b(?:true|false|null)\b/, "constant.language"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/==|!=|<=|>=|&&|\|\||=>|[=<>+\-*/%!?]/, "operator"],
            [/[()[\]{},.:]/, "@brackets"],
            [/\b[A-Za-z_][\w-]*\b/, "identifier"],
        ],
    },
};

const hclLanguageConfiguration: monaco.languages.LanguageConfiguration = {
    autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
    ],
    brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
    ],
    comments: {
        blockComment: ["/*", "*/"],
        lineComment: "#",
    },
    surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
    ],
};

class TextMateTokenizerState implements monaco.languages.IState {
    public constructor(
        private readonly stateStack: StateStack,
        private readonly themeVersion = textMateThemeVersion,
    ) {}

    public clone(): TextMateTokenizerState {
        return new TextMateTokenizerState(this.stateStack, this.themeVersion);
    }

    public equals(other: monaco.languages.IState): boolean {
        return (
            other instanceof TextMateTokenizerState &&
            other.stateStack === this.stateStack &&
            other.themeVersion === this.themeVersion
        );
    }

    public get ruleStack(): StateStack {
        return this.stateStack;
    }

    public get isCurrentThemeVersion(): boolean {
        return this.themeVersion === textMateThemeVersion;
    }
}

function getTextMateLanguageDefinition(
    languageId: string,
): TextMateGrammarDefinition | null {
    const resolvedLanguageId = resolveTextMateLanguageId(languageId);
    if (!resolvedLanguageId) {
        return null;
    }

    return textMateLanguageDefinitionsById.get(resolvedLanguageId) ?? null;
}

function normalizeLanguageId(languageId: string): string {
    return languageId.trim().toLowerCase();
}

function normalizeMonacoTextMateLanguageId(languageId: string): string {
    const normalizedLanguageId = normalizeLanguageId(languageId);

    return monacoTextMateLanguageIds[normalizedLanguageId] ?? normalizedLanguageId;
}

function resolveTextMateLanguageId(languageId: string): TextMateLanguageId | null {
    const normalizedLanguageId = normalizeLanguageId(languageId);

    if (!normalizedLanguageId) {
        return null;
    }

    if (
        textMateLanguageDefinitionsById.has(
            normalizedLanguageId as TextMateLanguageId,
        )
    ) {
        return normalizedLanguageId as TextMateLanguageId;
    }

    return textMateLanguageAliases.get(normalizedLanguageId) ?? null;
}

function getEncodedLanguageId(languageId: string): number {
    const normalizedLanguageId = normalizeLanguageId(languageId);
    const monacoEncodedLanguageId =
        activeMonacoNamespace?.languages.getEncodedLanguageId(
            normalizedLanguageId,
        );

    if (
        typeof monacoEncodedLanguageId === "number" &&
        monacoEncodedLanguageId > 0
    ) {
        encodedLanguageIds.set(normalizedLanguageId, monacoEncodedLanguageId);
        return monacoEncodedLanguageId;
    }

    const cachedLanguageId = encodedLanguageIds.get(normalizedLanguageId);
    if (cachedLanguageId) {
        return cachedLanguageId;
    }

    const encodedLanguageId = encodedLanguageIds.size + 1;
    encodedLanguageIds.set(normalizedLanguageId, encodedLanguageId);
    return encodedLanguageId;
}

function getTextMateInjectionScopeNames(scopeName: string): string[] | undefined {
    const scopeNames = injectionScopeNamesByTargetScope.get(scopeName);
    return scopeNames ? [...scopeNames] : undefined;
}

function getTextMateInjectionDefinitions(
    scopeName: string,
): readonly TextMateGrammarDefinition[] {
    const injectionScopeNames = getTextMateInjectionScopeNames(scopeName);
    if (!injectionScopeNames) {
        return [];
    }

    return injectionScopeNames.flatMap((injectionScopeName) => {
        const definition = textMateGrammarDefinitionsByScope.get(injectionScopeName);
        return definition ? [definition] : [];
    });
}

function mapEmbeddedLanguages(
    embeddedLanguages: TextMateGrammarDefinition["embeddedLanguages"],
): IGrammarConfiguration["embeddedLanguages"] | undefined {
    if (!embeddedLanguages) {
        return undefined;
    }

    return Object.fromEntries(
        Object.entries(embeddedLanguages).map(([scopeName, languageId]) => [
            scopeName,
            getEncodedLanguageId(normalizeMonacoTextMateLanguageId(languageId)),
        ]),
    );
}

function mapTokenTypes(
    tokenTypes: TextMateGrammarDefinition["tokenTypes"],
): IGrammarConfiguration["tokenTypes"] | undefined {
    if (!tokenTypes) {
        return undefined;
    }

    return Object.fromEntries(
        Object.entries(tokenTypes).map(([selector, tokenType]) => [
            selector,
            standardTokenTypeByName[tokenType],
        ]),
    );
}

function createTextMateGrammarConfiguration(
    definition: TextMateGrammarDefinition,
): IGrammarConfiguration {
    return {
        balancedBracketSelectors: definition.balancedBracketScopes
            ? [...definition.balancedBracketScopes]
            : undefined,
        embeddedLanguages: mapEmbeddedLanguages(definition.embeddedLanguages),
        tokenTypes: mapTokenTypes(definition.tokenTypes),
        unbalancedBracketSelectors: definition.unbalancedBracketScopes
            ? [...definition.unbalancedBracketScopes]
            : undefined,
    };
}

function createTextMateEncodedTokensProvider(
    grammar: IGrammar,
): monaco.languages.EncodedTokensProvider {
    return {
        getInitialState: () =>
            new TextMateTokenizerState(INITIAL, textMateThemeVersion),
        tokenizeEncoded: (line, state) => {
            const currentState =
                state instanceof TextMateTokenizerState &&
                state.isCurrentThemeVersion
                    ? state.ruleStack
                    : INITIAL;
            if (line.length > MONACO_MAX_TOKENIZATION_LINE_LENGTH) {
                return {
                    endState: new TextMateTokenizerState(
                        currentState,
                        textMateThemeVersion,
                    ),
                    tokens: new Uint32Array([0, 0]),
                };
            }
            const lineTokens = grammar.tokenizeLine2(line, currentState);

            return {
                endState: new TextMateTokenizerState(
                    lineTokens.ruleStack,
                    textMateThemeVersion,
                ),
                tokens: lineTokens.tokens,
            };
        },
    };
}

function refreshTextMateModelsForLanguage(
    monacoNsps: MonacoNamespace,
    languageId: string,
): number {
    let refreshedModelCount = 0;

    for (const model of monacoNsps.editor.getModels()) {
        if (normalizeLanguageId(model.getLanguageId()) !== languageId) {
            continue;
        }

        monacoNsps.editor.setModelLanguage(model, languageId);
        refreshedModelCount += 1;
    }

    return refreshedModelCount;
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

function getPerformanceNow(): number | null {
    return typeof performance === "undefined" ? null : performance.now();
}

function logTextMatePerformance(
    label: string,
    startedAt: number | null,
): void {
    if (!import.meta.env.DEV || startedAt === null) {
        return;
    }

    console.debug(
        `[monaco-textmate][perf] ${label} ${(performance.now() - startedAt).toFixed(1)}ms`,
    );
}

async function loadTextMateGrammarModule(
    definition: TextMateGrammarDefinition,
): Promise<void> {
    const cachedLoader = grammarModuleLoadCache.get(definition.shikiLanguageId);

    if (cachedLoader) {
        await cachedLoader;
        if (!rawGrammarCache.has(definition.scopeName)) {
            throw new Error(
                `TextMate grammar module "${definition.shikiLanguageId}" did not expose "${definition.scopeName}".`,
            );
        }
        return;
    }

    const loaderPromise = (async () => {
        try {
            const startedAt = getPerformanceNow();
            const grammarModule = await definition.loadModule();
            logTextMatePerformance(
                `module ${definition.shikiLanguageId}`,
                startedAt,
            );

            for (const grammar of grammarModule.default) {
                const scopeName = getRawGrammarScopeName(grammar);
                if (scopeName && !rawGrammarCache.has(scopeName)) {
                    rawGrammarCache.set(scopeName, grammar as IRawGrammar);
                }
            }
        } catch (error) {
            grammarModuleLoadCache.delete(definition.shikiLanguageId);
            throw error;
        }
    })();

    grammarModuleLoadCache.set(definition.shikiLanguageId, loaderPromise);
    await loaderPromise;

    if (!rawGrammarCache.has(definition.scopeName)) {
        throw new Error(
            `TextMate grammar module "${definition.shikiLanguageId}" did not expose "${definition.scopeName}".`,
        );
    }
}

async function loadTextMateGrammarsForDefinition(
    definition: TextMateGrammarDefinition,
): Promise<void> {
    await loadTextMateGrammarModule(definition);
    await Promise.all(
        getTextMateInjectionDefinitions(definition.scopeName).map(
            (injectionDefinition) =>
                loadTextMateGrammarModule(injectionDefinition),
        ),
    );
}

async function loadRawGrammarByScope(
    scopeName: string,
): Promise<IRawGrammar | null> {
    const cachedGrammar = rawGrammarCache.get(scopeName);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const definition = textMateGrammarDefinitionsByScope.get(scopeName);
    if (!definition) {
        return null;
    }

    await loadTextMateGrammarModule(definition);
    return rawGrammarCache.get(scopeName) ?? null;
}

async function loadOnigLib() {
    if (onigLibPromise) {
        return onigLibPromise;
    }

    onigLibPromise = (async () => {
        const startedAt = getPerformanceNow();
        try {
            const response = await fetch(onigWasmUrl);
            if (!response.ok) {
                throw new Error(
                    `Failed to load Oniguruma WASM (${response.status} ${response.statusText}).`,
                );
            }

            const wasmBytes = await response.arrayBuffer();
            await loadWASM(wasmBytes);
            logTextMatePerformance("oniguruma wasm", startedAt);

            return {
                createOnigScanner(sources: string[]) {
                    return new OnigScanner(sources);
                },
                createOnigString(source: string) {
                    return new OnigString(source);
                },
            };
        } catch (error) {
            onigLibPromise = null;
            throw new Error("Failed to initialize Oniguruma for TextMate.", {
                cause: error,
            });
        }
    })();

    return onigLibPromise;
}

async function getTextMateRegistry(): Promise<Registry> {
    if (textMateRegistryPromise) {
        return textMateRegistryPromise;
    }

    const registryOptions: RegistryOptions = {
        getInjections: getTextMateInjectionScopeNames,
        loadGrammar: loadRawGrammarByScope,
        onigLib: loadOnigLib(),
    };

    if (currentTextMateTheme) {
        registryOptions.theme = currentTextMateTheme.rawTheme;
        registryOptions.colorMap = [...currentTextMateTheme.indexedColorMap];
    }

    textMateRegistryPromise = Promise.resolve(
        new Registry(registryOptions),
    );

    return textMateRegistryPromise;
}

async function loadConfiguredTextMateGrammar(
    definition: TextMateGrammarDefinition,
    languageId: string,
): Promise<IGrammar> {
    const initialLanguageId = normalizeMonacoTextMateLanguageId(languageId);
    const grammarCacheKey = `${definition.scopeName}:${initialLanguageId}`;
    const cachedGrammar = configuredGrammarLoadCache.get(grammarCacheKey);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const grammarPromise = (async () => {
        try {
            const startedAt = getPerformanceNow();
            await loadTextMateGrammarsForDefinition(definition);
            const registry = await getTextMateRegistry();
            const grammar = await registry.loadGrammarWithConfiguration(
                definition.scopeName,
                getEncodedLanguageId(initialLanguageId),
                createTextMateGrammarConfiguration(definition),
            );

            if (!grammar) {
                throw new Error(
                    `Could not load TextMate grammar "${definition.scopeName}".`,
                );
            }

            logTextMatePerformance(
                `grammar ${definition.scopeName}:${initialLanguageId}`,
                startedAt,
            );

            return grammar;
        } catch (error) {
            configuredGrammarLoadCache.delete(grammarCacheKey);
            textMateRegistryPromise = null;
            throw error;
        }
    })();

    configuredGrammarLoadCache.set(grammarCacheKey, grammarPromise);
    return grammarPromise;
}

function ensureHclFallback(monacoNsps: MonacoNamespace) {
    if (didRegisterHclFallback) {
        return;
    }

    const isAlreadyRegistered = monacoNsps.languages
        .getLanguages()
        .some((language) => language.id === "hcl");

    if (!isAlreadyRegistered) {
        monacoNsps.languages.register({
            aliases: ["HCL", "Terraform"],
            id: "hcl",
        });
    }

    monacoNsps.languages.setMonarchTokensProvider(
        "hcl",
        hclFallbackMonarchDefinition,
    );
    monacoNsps.languages.setLanguageConfiguration(
        "hcl",
        hclLanguageConfiguration,
    );
    didRegisterHclFallback = true;
}

async function installTextMateProvider(
    monacoNsps: MonacoNamespace,
    languageId: string,
): Promise<boolean> {
    try {
        activeMonacoNamespace = monacoNsps;
        const normalizedLanguageId = normalizeLanguageId(languageId);
        const definition = getTextMateLanguageDefinition(normalizedLanguageId);

        if (!definition) {
            return false;
        }

        const grammar = await loadConfiguredTextMateGrammar(
            definition,
            normalizedLanguageId,
        );

        textMateProviderDisposables.get(normalizedLanguageId)?.dispose();
        textMateProviderDisposables.set(
            normalizedLanguageId,
            monacoNsps.languages.setTokensProvider(
                normalizedLanguageId,
                createTextMateEncodedTokensProvider(grammar),
            ),
        );
        refreshTextMateModelsForLanguage(monacoNsps, normalizedLanguageId);

        return true;
    } catch (error) {
        console.warn(
            `[monaco-textmate] Failed to install TextMate highlighting for "${languageId}".`,
            error,
        );
        return false;
    }
}

function ensureTextMateProvider(
    monacoNsps: MonacoNamespace,
    languageId: string,
) {
    const normalizedLanguageId = normalizeLanguageId(languageId);
    const definition = getTextMateLanguageDefinition(normalizedLanguageId);
    if (!definition) {
        return Promise.resolve(false);
    }

    const cachedInstallation = textMateProviderInstallCache.get(
        normalizedLanguageId,
    );
    if (cachedInstallation) {
        return cachedInstallation.then((installed) => {
            if (installed) {
                refreshTextMateModelsForLanguage(
                    monacoNsps,
                    normalizedLanguageId,
                );
            }

            return installed;
        });
    }

    const installPromise = installTextMateProvider(
        monacoNsps,
        normalizedLanguageId,
    ).then((installed) => {
        if (!installed) {
            textMateProviderInstallCache.delete(normalizedLanguageId);
        }

        return installed;
    });
    textMateProviderInstallCache.set(normalizedLanguageId, installPromise);
    return installPromise;
}

export function getTextMateLanguageIds(): readonly TextMateLanguageId[] {
    return TEXT_MATE_LANGUAGE_IDS;
}

export function getTextMateScopeName(languageId: string): string | null {
    return getTextMateLanguageDefinition(languageId)?.scopeName ?? null;
}

export function isTextMateLanguageSupported(languageId: string): boolean {
    return getTextMateLanguageDefinition(languageId) !== null;
}

export function ensureMonacoTextMateProvider(
    monacoNsps: MonacoNamespace,
    languageId: string,
) {
    activeMonacoNamespace = monacoNsps;
    return ensureTextMateProvider(monacoNsps, languageId);
}

export function applyMonacoTextMateTheme(
    monacoNsps: MonacoNamespace,
    theme: ComandoTextMateTheme,
) {
    activeMonacoNamespace = monacoNsps;
    currentTextMateTheme = theme;
    textMateThemeVersion += 1;
    monacoNsps.languages.setColorMap([...theme.indexedColorMap]);

    if (textMateRegistryPromise) {
        void textMateRegistryPromise.then((registry) => {
            registry.setTheme(theme.rawTheme, [...theme.indexedColorMap]);
        });
    }
}

export function configureMonacoTextMateLanguages(monacoNsps: MonacoNamespace) {
    activeMonacoNamespace = monacoNsps;
    ensureHclFallback(monacoNsps);

    if (didRegisterTextMateLanguageHooks) {
        return;
    }

    monacoNsps.languages.onLanguage("hcl", () => {
        void ensureTextMateProvider(monacoNsps, "hcl");
    });

    didRegisterTextMateLanguageHooks = true;
}
