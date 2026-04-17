import type * as monaco from "monaco-editor";
import {
    INITIAL,
    Registry,
    type IGrammar,
    type IRawGrammar,
    type StateStack,
} from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";

import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";

type MonacoNamespace = typeof import("monaco-editor");

type TextMateGrammarModule = {
    readonly default: readonly IRawGrammar[];
};

const TEXT_MATE_LANGUAGE_IDS = [
    "cmake",
    "dockerfile",
    "hcl",
    "python",
    "ruby",
    "rust",
    "shell",
] as const;

type TextMateLanguageId = (typeof TEXT_MATE_LANGUAGE_IDS)[number];

const TEXT_MATE_LANGUAGE_ALIASES: Readonly<Record<string, TextMateLanguageId>> = {
    bash: "shell",
    docker: "dockerfile",
    fish: "shell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    shellscript: "shell",
    tf: "hcl",
    terraform: "hcl",
    tfvars: "hcl",
    zsh: "shell",
};

type TextMateLanguageDefinition = {
    readonly canonicalLanguageId: TextMateLanguageId;
    readonly loadModule: () => Promise<TextMateGrammarModule>;
    readonly scopeName: string;
};

const TEXT_MATE_LANGUAGE_DEFINITIONS: Readonly<
    Record<TextMateLanguageId, TextMateLanguageDefinition>
> = {
    cmake: {
        canonicalLanguageId: "cmake",
        loadModule: () => import("@shikijs/langs/cmake"),
        scopeName: "source.cmake",
    },
    dockerfile: {
        canonicalLanguageId: "dockerfile",
        loadModule: () => import("@shikijs/langs/dockerfile"),
        scopeName: "source.dockerfile",
    },
    hcl: {
        canonicalLanguageId: "hcl",
        loadModule: () => import("@shikijs/langs/hcl"),
        scopeName: "source.hcl",
    },
    python: {
        canonicalLanguageId: "python",
        loadModule: () => import("@shikijs/langs/python"),
        scopeName: "source.python",
    },
    ruby: {
        canonicalLanguageId: "ruby",
        loadModule: () => import("@shikijs/langs/ruby"),
        scopeName: "source.ruby",
    },
    rust: {
        canonicalLanguageId: "rust",
        loadModule: () => import("@shikijs/langs/rust"),
        scopeName: "source.rust",
    },
    shell: {
        canonicalLanguageId: "shell",
        loadModule: () => import("@shikijs/langs/shellscript"),
        scopeName: "source.shell",
    },
};

const textMateDefinitions = Object.values(TEXT_MATE_LANGUAGE_DEFINITIONS);
const primaryScopeToLanguageId = new Map(
    textMateDefinitions.map((definition) => [
        definition.scopeName,
        definition.canonicalLanguageId,
    ]),
);
const rawGrammarCache = new Map<string, IRawGrammar>();
const grammarModuleLoadCache = new Map<TextMateLanguageId, Promise<void>>();
const textMateProviderInstallCache = new Map<string, Promise<boolean>>();

let onigLibPromise: Promise<{
    readonly createOnigScanner: (sources: string[]) => OnigScanner;
    readonly createOnigString: (source: string) => OnigString;
}> | null = null;
let textMateRegistryPromise: Promise<Registry> | null = null;
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
    public constructor(private readonly stateStack: StateStack) {}

    public clone(): TextMateTokenizerState {
        return new TextMateTokenizerState(this.stateStack);
    }

    public equals(other: monaco.languages.IState): boolean {
        return (
            other instanceof TextMateTokenizerState &&
            other.stateStack === this.stateStack
        );
    }

    public get ruleStack(): StateStack {
        return this.stateStack;
    }
}

function getTextMateLanguageDefinition(
    languageId: string,
): TextMateLanguageDefinition | null {
    const resolvedLanguageId = resolveTextMateLanguageId(languageId);
    if (!resolvedLanguageId) {
        return null;
    }

    return TEXT_MATE_LANGUAGE_DEFINITIONS[resolvedLanguageId];
}

function normalizeLanguageId(languageId: string): string {
    return languageId.trim().toLowerCase();
}

function resolveTextMateLanguageId(languageId: string): TextMateLanguageId | null {
    const normalizedLanguageId = normalizeLanguageId(languageId);

    if (!normalizedLanguageId) {
        return null;
    }

    return (
        TEXT_MATE_LANGUAGE_DEFINITIONS[
            normalizedLanguageId as TextMateLanguageId
        ]?.canonicalLanguageId ??
        TEXT_MATE_LANGUAGE_ALIASES[normalizedLanguageId] ??
        null
    );
}

function pickMonacoScope(scopes: readonly string[]): string {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
        const scope = scopes[index];
        if (
            scope.startsWith("meta.") ||
            scope.startsWith("source.") ||
            scope.startsWith("text.")
        ) {
            continue;
        }

        return scope;
    }

    return scopes[scopes.length - 1] ?? "";
}

function createTextMateTokensProvider(
    grammar: IGrammar,
): monaco.languages.TokensProvider {
    return {
        getInitialState: () => new TextMateTokenizerState(INITIAL),
        tokenize: (line, state) => {
            const currentState =
                state instanceof TextMateTokenizerState
                    ? state.ruleStack
                    : INITIAL;
            const lineTokens = grammar.tokenizeLine(line, currentState);

            return {
                endState: new TextMateTokenizerState(lineTokens.ruleStack),
                tokens: lineTokens.tokens.map((token) => ({
                    scopes: pickMonacoScope(token.scopes),
                    startIndex: token.startIndex,
                })),
            };
        },
    };
}

async function loadTextMateGrammarModule(
    languageId: TextMateLanguageId,
): Promise<void> {
    const cachedLoader = grammarModuleLoadCache.get(languageId);
    if (cachedLoader) {
        return cachedLoader;
    }

    const loaderPromise = (async () => {
        const definition = TEXT_MATE_LANGUAGE_DEFINITIONS[languageId];
        const grammarModule = await definition.loadModule();

        for (const grammar of grammarModule.default) {
            rawGrammarCache.set(grammar.scopeName, grammar);
        }

        if (!rawGrammarCache.has(definition.scopeName)) {
            throw new Error(
                `TextMate grammar module "${languageId}" did not expose "${definition.scopeName}".`,
            );
        }
    })();

    grammarModuleLoadCache.set(languageId, loaderPromise);
    return loaderPromise;
}

async function loadRawGrammarByScope(
    scopeName: string,
): Promise<IRawGrammar | null> {
    const cachedGrammar = rawGrammarCache.get(scopeName);
    if (cachedGrammar) {
        return cachedGrammar;
    }

    const primaryLanguageId = primaryScopeToLanguageId.get(scopeName);
    if (!primaryLanguageId) {
        return null;
    }

    await loadTextMateGrammarModule(primaryLanguageId);
    return rawGrammarCache.get(scopeName) ?? null;
}

async function loadOnigLib() {
    if (onigLibPromise) {
        return onigLibPromise;
    }

    onigLibPromise = (async () => {
        const response = await fetch(onigWasmUrl);
        if (!response.ok) {
            throw new Error(
                `Failed to load Oniguruma WASM (${response.status} ${response.statusText}).`,
            );
        }

        const wasmBytes = await response.arrayBuffer();
        await loadWASM(wasmBytes);

        return {
            createOnigScanner(sources: string[]) {
                return new OnigScanner(sources);
            },
            createOnigString(source: string) {
                return new OnigString(source);
            },
        };
    })();

    return onigLibPromise;
}

async function getTextMateRegistry(): Promise<Registry> {
    if (textMateRegistryPromise) {
        return textMateRegistryPromise;
    }

    textMateRegistryPromise = Promise.resolve(
        new Registry({
            loadGrammar: loadRawGrammarByScope,
            onigLib: loadOnigLib(),
        }),
    );

    return textMateRegistryPromise;
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
        const normalizedLanguageId = normalizeLanguageId(languageId);
        const definition = getTextMateLanguageDefinition(normalizedLanguageId);

        if (!definition) {
            return false;
        }

        await loadTextMateGrammarModule(definition.canonicalLanguageId);
        const registry = await getTextMateRegistry();
        const grammar = await registry.loadGrammar(definition.scopeName);

        if (!grammar) {
            throw new Error(
                `Could not load TextMate grammar "${definition.scopeName}".`,
            );
        }

        monacoNsps.languages.setTokensProvider(
            normalizedLanguageId,
            createTextMateTokensProvider(grammar),
        );

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
        return cachedInstallation;
    }

    const installPromise = installTextMateProvider(
        monacoNsps,
        normalizedLanguageId,
    );
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
    return ensureTextMateProvider(monacoNsps, languageId);
}

export function configureMonacoTextMateLanguages(monacoNsps: MonacoNamespace) {
    ensureHclFallback(monacoNsps);

    if (didRegisterTextMateLanguageHooks) {
        return;
    }

    monacoNsps.languages.onLanguage("hcl", () => {
        void ensureTextMateProvider(monacoNsps, "hcl");
    });

    didRegisterTextMateLanguageHooks = true;
}
