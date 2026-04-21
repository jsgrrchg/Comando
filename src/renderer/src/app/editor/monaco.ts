import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import type {
    TsconfigModuleResolution,
    TsconfigResolutionSnapshot,
} from "@shared/ipc";

import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
// Custom TypeScript worker that exposes getEncoded*Classifications so the
// semantic tokens provider can receive real data. See ts.worker.ts.
import tsWorker from "./ts.worker?worker";

import {
    applyMonacoTextMateTheme,
    configureMonacoTextMateLanguages,
    ensureMonacoTextMateProvider,
    isTextMateLanguageSupported,
} from "./monacoTextmate";
import { configureMonacoColorDecorators } from "./monacoColorProvider";
import { COMANDO_BRACKET_PAIR_COLOR_COUNT } from "./monacoEditorFeatures";
import {
    LARGE_FILE_JSON_LANGUAGE_ID,
    LARGE_FILE_JSONC_LANGUAGE_ID,
} from "./monacoPerformance";
import {
    createComandoTextMateTheme,
    createMonarchFallbackRules,
    type ComandoSemanticTokenColors,
} from "./monacoTextmateTheme";
import { installTypeScriptReactLanguageServices } from "./monacoTypeScriptReact";
import { setupTypeScriptCustomWorker } from "./monacoTypeScriptCustomWorker";
import { isTypeScriptWorkerLanguageId } from "./monacoLanguage";
import {
    shellLanguageConfiguration,
    shellMonarchDefinition,
} from "./monacoShell";

export { installMonacoTokenDebugAction } from "./monacoTokenDebug";

export type ComandoMonacoTheme = "comando-light" | "comando-dark";

type MonacoEnvironmentShape = {
    MonacoEnvironment?: {
        getWorker: (_moduleId: string, label: string) => Worker;
    };
    __comandoMonacoConfigured?: boolean;
};

const monacoGlobal = globalThis as typeof globalThis & MonacoEnvironmentShape;
const LIGHT_THEME_NAME: ComandoMonacoTheme = "comando-light";
const DARK_THEME_NAME: ComandoMonacoTheme = "comando-dark";

type MonarchLanguageModule = {
    readonly conf?: monaco.languages.LanguageConfiguration;
    readonly language: monaco.languages.IMonarchLanguage;
};

type MonacoLanguageServiceDefaults = {
    getCompilerOptions(): Record<string, unknown>;
    getDiagnosticsOptions(): Record<string, unknown>;
    setCompilerOptions(options: Record<string, unknown>): void;
    setDiagnosticsOptions(options: Record<string, unknown>): void;
    setEagerModelSync(value: boolean): void;
};

type MonacoTypeScriptApi = {
    readonly javascriptDefaults: MonacoLanguageServiceDefaults;
    readonly typescriptDefaults: MonacoLanguageServiceDefaults;
    readonly JsxEmit: {
        readonly ReactJSX: number;
    };
    readonly ModuleResolutionKind: {
        readonly Classic: number;
        readonly NodeJs: number;
    };
    readonly ScriptTarget: {
        readonly Latest: number;
    };
};

type TokenizedLanguageModule = {
    readonly conf?: monaco.languages.LanguageConfiguration;
    readonly tokensProvider: monaco.languages.TokensProvider;
};

type DeferredMonacoLanguage =
    | {
          readonly kind: "monarch";
          readonly load: () => Promise<MonarchLanguageModule>;
      }
    | {
          readonly kind: "tokens";
          readonly load: () => Promise<TokenizedLanguageModule>;
      };

const deferredMonacoLanguageCache = new Map<
    DeferredMonacoLanguage,
    Promise<MonarchLanguageModule | TokenizedLanguageModule>
>();
let currentTsconfigSignature: string | null = null;
let defaultTypeScriptCompilerOptions: Record<string, unknown> | null = null;
let defaultJavaScriptCompilerOptions: Record<string, unknown> | null = null;
let defaultTypeScriptDiagnosticsOptions: Record<string, unknown> | null = null;
let defaultJavaScriptDiagnosticsOptions: Record<string, unknown> | null = null;

function loadDeferredMonacoLanguage(
    definition: DeferredMonacoLanguage,
): Promise<MonarchLanguageModule | TokenizedLanguageModule> {
    const cached = deferredMonacoLanguageCache.get(definition);
    if (cached) {
        return cached;
    }

    const loaderPromise = definition.load();
    deferredMonacoLanguageCache.set(definition, loaderPromise);
    return loaderPromise;
}

function getMonacoTypeScriptApi(): MonacoTypeScriptApi {
    return monaco.languages.typescript as unknown as MonacoTypeScriptApi;
}

function createBaseTypeScriptCompilerOptions(
    compilerOptions: Record<string, unknown>,
    monacoTypeScript: MonacoTypeScriptApi,
): Record<string, unknown> {
    return {
        ...compilerOptions,
        allowNonTsExtensions: true,
        jsx: monacoTypeScript.JsxEmit.ReactJSX,
        target: monacoTypeScript.ScriptTarget.Latest,
    };
}

function mapModuleResolution(
    monacoTypeScript: MonacoTypeScriptApi,
    moduleResolution: TsconfigModuleResolution | null,
): number | null {
    if (moduleResolution === "classic") {
        return monacoTypeScript.ModuleResolutionKind.Classic;
    }

    if (
        moduleResolution === "node" ||
        moduleResolution === "node16" ||
        moduleResolution === "nodenext" ||
        moduleResolution === "bundler"
    ) {
        return monacoTypeScript.ModuleResolutionKind.NodeJs;
    }

    return null;
}

function createCompilerOptionsFromTsconfig(
    monacoTypeScript: MonacoTypeScriptApi,
    baseCompilerOptions: Record<string, unknown>,
    tsconfig: TsconfigResolutionSnapshot,
): Record<string, unknown> {
    const compilerOptions = tsconfig.compilerOptions;
    if (!compilerOptions) {
        return { ...baseCompilerOptions };
    }

    const moduleResolution = mapModuleResolution(
        monacoTypeScript,
        compilerOptions.moduleResolution,
    );

    return {
        ...baseCompilerOptions,
        ...(compilerOptions.baseUrl
            ? { baseUrl: compilerOptions.baseUrl }
            : {}),
        ...(compilerOptions.paths
            ? {
                  paths: Object.fromEntries(
                      Object.entries(compilerOptions.paths).map(
                          ([alias, targets]) => [alias, [...targets]],
                      ),
                  ),
              }
            : {}),
        ...(moduleResolution ? { moduleResolution } : {}),
    };
}

function mergeDiagnosticCodes(
    currentCodes: unknown,
    nextCodes: readonly number[],
): number[] {
    const codes = new Set(
        Array.isArray(currentCodes)
            ? currentCodes.filter(
                  (code): code is number => typeof code === "number",
              )
            : [],
    );

    for (const code of nextCodes) {
        codes.add(code);
    }

    return [...codes];
}

function createDiagnosticsOptionsFromTsconfig(
    baseDiagnosticsOptions: Record<string, unknown>,
    tsconfig: TsconfigResolutionSnapshot,
): Record<string, unknown> {
    if (tsconfig.diagnosticCodesToIgnore.length === 0) {
        return { ...baseDiagnosticsOptions };
    }

    return {
        ...baseDiagnosticsOptions,
        diagnosticCodesToIgnore: mergeDiagnosticCodes(
            baseDiagnosticsOptions.diagnosticCodesToIgnore,
            tsconfig.diagnosticCodesToIgnore,
        ),
    };
}

function configureDefaultTypeScriptLanguageServices(
    monacoTypeScript: MonacoTypeScriptApi,
) {
    defaultTypeScriptCompilerOptions = createBaseTypeScriptCompilerOptions(
        monacoTypeScript.typescriptDefaults.getCompilerOptions(),
        monacoTypeScript,
    );
    defaultJavaScriptCompilerOptions = {
        ...createBaseTypeScriptCompilerOptions(
            monacoTypeScript.javascriptDefaults.getCompilerOptions(),
            monacoTypeScript,
        ),
        allowJs: true,
    };
    defaultTypeScriptDiagnosticsOptions =
        monacoTypeScript.typescriptDefaults.getDiagnosticsOptions();
    defaultJavaScriptDiagnosticsOptions =
        monacoTypeScript.javascriptDefaults.getDiagnosticsOptions();

    monacoTypeScript.typescriptDefaults.setCompilerOptions(
        defaultTypeScriptCompilerOptions,
    );
    monacoTypeScript.javascriptDefaults.setCompilerOptions(
        defaultJavaScriptCompilerOptions,
    );
    monacoTypeScript.typescriptDefaults.setEagerModelSync(true);
    monacoTypeScript.javascriptDefaults.setEagerModelSync(true);
}

function applyTypeScriptProjectConfig(tsconfig: TsconfigResolutionSnapshot): void {
    const monacoTypeScript = getMonacoTypeScriptApi();
    const typeScriptCompilerOptions =
        defaultTypeScriptCompilerOptions ??
        createBaseTypeScriptCompilerOptions(
            monacoTypeScript.typescriptDefaults.getCompilerOptions(),
            monacoTypeScript,
        );
    const javaScriptCompilerOptions =
        defaultJavaScriptCompilerOptions ??
        createBaseTypeScriptCompilerOptions(
            monacoTypeScript.javascriptDefaults.getCompilerOptions(),
            monacoTypeScript,
        );
    const typeScriptDiagnosticsOptions =
        defaultTypeScriptDiagnosticsOptions ??
        monacoTypeScript.typescriptDefaults.getDiagnosticsOptions();
    const javaScriptDiagnosticsOptions =
        defaultJavaScriptDiagnosticsOptions ??
        monacoTypeScript.javascriptDefaults.getDiagnosticsOptions();

    monacoTypeScript.typescriptDefaults.setCompilerOptions(
        createCompilerOptionsFromTsconfig(
            monacoTypeScript,
            typeScriptCompilerOptions,
            tsconfig,
        ),
    );
    monacoTypeScript.javascriptDefaults.setCompilerOptions(
        createCompilerOptionsFromTsconfig(
            monacoTypeScript,
            javaScriptCompilerOptions,
            tsconfig,
        ),
    );
    monacoTypeScript.typescriptDefaults.setDiagnosticsOptions(
        createDiagnosticsOptionsFromTsconfig(
            typeScriptDiagnosticsOptions,
            tsconfig,
        ),
    );
    monacoTypeScript.javascriptDefaults.setDiagnosticsOptions(
        createDiagnosticsOptionsFromTsconfig(
            javaScriptDiagnosticsOptions,
            tsconfig,
        ),
    );
}

function getTsconfigSignature(tsconfig: TsconfigResolutionSnapshot): string {
    return JSON.stringify({
        aliasPatterns: tsconfig.aliasPatterns,
        compilerOptions: tsconfig.compilerOptions,
        configPath: tsconfig.configPath,
        diagnosticCodesToIgnore: tsconfig.diagnosticCodesToIgnore,
        errors: tsconfig.errors,
    });
}

export async function applyProjectTypeScriptConfigForPath(
    filePath: string,
): Promise<void> {
    if (typeof window === "undefined" || !window.comando) {
        return;
    }

    const tsconfig = await window.comando.resolveTsconfigForPath(filePath);
    const signature = getTsconfigSignature(tsconfig);
    if (signature === currentTsconfigSignature) {
        return;
    }

    currentTsconfigSignature = signature;
    applyTypeScriptProjectConfig(tsconfig);

    if (tsconfig.errors.length > 0) {
        console.warn(
            "[comando] TypeScript project config could not be fully resolved.",
            tsconfig.errors,
        );
    }
}

function basicLanguage(
    load: () => Promise<MonarchLanguageModule>,
): DeferredMonacoLanguage {
    return {
        kind: "monarch",
        load,
    };
}

function monarchLanguage(
    language: monaco.languages.IMonarchLanguage,
    conf?: monaco.languages.LanguageConfiguration,
): DeferredMonacoLanguage {
    return {
        kind: "monarch",
        load: () => Promise.resolve({ conf, language }),
    };
}

function textMateOnlyLanguage(): DeferredMonacoLanguage {
    return monarchLanguage(textMateOnlyMonarchDefinition);
}

function jsonLanguage({
    allowComments,
}: {
    readonly allowComments: boolean;
}): DeferredMonacoLanguage {
    return {
        kind: "tokens",
        load: async () => {
            const { createTokenizationSupport } =
                await import("monaco-editor/esm/vs/language/json/tokenization.js");

            return {
                tokensProvider: createTokenizationSupport(allowComments),
            };
        },
    };
}

const diffMonarchDefinition: monaco.languages.IMonarchLanguage = {
    tokenizer: {
        root: [
            [/^(diff|index)\b.*$/, "meta"],
            [/^(---|\+\+\+)\s.*$/, "keyword"],
            [/^@@.*@@$/, "keyword"],
            [/^\+.*$/, "string"],
            [/^-.*$/, "regexp"],
            [/^!.*$/, "type"],
            [/^ .*$/, ""],
        ],
    },
};

const cmakeMonarchDefinition: monaco.languages.IMonarchLanguage = {
    brackets: [
        { open: "(", close: ")", token: "delimiter.parenthesis" },
        { open: "[", close: "]", token: "delimiter.square" },
        { open: "{", close: "}", token: "delimiter.curly" },
    ],
    defaultToken: "",
    ignoreCase: true,
    tokenizer: {
        root: [
            [/#.*$/, "comment"],
            [/\$\{[^}]+\}/, "variable"],
            [/\$ENV\{[^}]+\}/, "variable.predefined"],
            [
                /\b(?:if|elseif|else|endif|foreach|endforeach|while|endwhile|function|endfunction|macro|endmacro|include|find_package|project|add_executable|add_library|target_link_libraries|target_include_directories|set|unset|option|message|cmake_minimum_required|install)\b(?=\s*\()/,
                "keyword",
            ],
            [/"([^"\\]|\\.)*"/, "string"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/[()[\]{}]/, "@brackets"],
            [/[A-Za-z_][\w-]*/, "identifier"],
        ],
    },
};

const makefileMonarchDefinition: monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    tokenizer: {
        root: [
            [/^\s*#.*$/, "comment"],
            [/^\s*\.[A-Za-z_-]+:/, "keyword"],
            [/^\s*[^\s:=#][^:=#]*:/, "type.identifier"],
            [/\$\(([^)]+)\)/, "variable"],
            [/\$\{([^}]+)\}/, "variable"],
            [/(?:\?|:)?\+=|::?=|=/, "keyword"],
            [
                /\b(?:ifneq|ifeq|ifdef|ifndef|else|endif|include|define|endef|override|export|unexport)\b/,
                "keyword",
            ],
            [/"([^"\\]|\\.)*"/, "string"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
        ],
    },
};

const haskellMonarchDefinition: monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    tokenizer: {
        root: [
            [/--.*$/, "comment"],
            [/\{-/, { token: "comment", next: "@comment" }],
            [/"([^"\\]|\\.)*"/, "string"],
            [/'([^'\\]|\\.)'/, "string"],
            [
                /\b(?:case|class|data|default|deriving|do|else|foreign|if|import|in|infix|infixl|infixr|instance|let|module|newtype|of|then|type|where)\b/,
                "keyword",
            ],
            [/\b(?:True|False|Nothing|Just)\b/, "constant"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/[A-Z][\w']*/, "type.identifier"],
            [/[a-z_][\w']*/, "identifier"],
            [/[()[\]{}]/, "@brackets"],
            [/[-!#$%&*+./<=>?@\\^|:~]+/, "operators"],
        ],
        comment: [
            [/[^-{]+/, "comment"],
            [/{-/, "comment", "@push"],
            [/-}/, "comment", "@pop"],
            [/[{-]/, "comment"],
        ],
    },
};

const latexMonarchDefinition: monaco.languages.IMonarchLanguage = {
    brackets: [
        { open: "{", close: "}", token: "delimiter.curly" },
        { open: "[", close: "]", token: "delimiter.square" },
        { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    defaultToken: "",
    tokenizer: {
        root: [
            [/%.*$/, "comment"],
            [/\\[A-Za-z@]+/, "keyword"],
            [/\\./, "keyword"],
            [/\$[^$]+\$/, "string"],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [/[()[\]{}]/, "@brackets"],
        ],
    },
};

const wastMonarchDefinition: monaco.languages.IMonarchLanguage = {
    brackets: [{ open: "(", close: ")", token: "delimiter.parenthesis" }],
    defaultToken: "",
    tokenizer: {
        root: [
            [/;;.*$/, "comment"],
            [/\(;/, { token: "comment", next: "@comment" }],
            [/"([^"\\]|\\.)*"/, "string"],
            [/\$[A-Za-z0-9!#$%&'*+\-./:<=>?@\\^_`|~]+/, "variable"],
            [
                /\b(?:module|func|param|result|local|global|table|memory|data|elem|type|import|export|start|offset|mut|call|loop|block|if|then|else|br|br_if|br_table|return|unreachable)\b/,
                "keyword",
            ],
            [/[+-]?\b\d+(?:\.\d+)?\b/, "number"],
            [/[()]/, "@brackets"],
        ],
        comment: [
            [/[^;(]+/, "comment"],
            [/\(;/, "comment", "@push"],
            [/;\)/, "comment", "@pop"],
            [/[;(]/, "comment"],
        ],
    },
};

const textMateOnlyMonarchDefinition: monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    tokenizer: {
        root: [],
    },
};

function registerLanguageIds(
    languageIds: readonly string[],
    definition: DeferredMonacoLanguage,
) {
    const knownLanguageIds = new Set(
        monaco.languages.getLanguages().map((language) => language.id),
    );

    for (const languageId of languageIds) {
        const shouldInstallTextMate = isTextMateLanguageSupported(languageId);

        if (knownLanguageIds.has(languageId)) {
            if (!shouldInstallTextMate) {
                continue;
            }
        } else {
            monaco.languages.register({
                aliases: [languageId],
                id: languageId,
            });
            knownLanguageIds.add(languageId);
        }

        let didAttachProvider = false;
        monaco.languages.onLanguage(languageId, () => {
            if (didAttachProvider) {
                return;
            }
            didAttachProvider = true;

            void loadDeferredMonacoLanguage(definition).then((loaded) => {
                if (definition.kind === "monarch") {
                    const monarchLanguage = loaded as MonarchLanguageModule;
                    if (!shouldInstallTextMate) {
                        monaco.languages.setMonarchTokensProvider(
                            languageId,
                            monarchLanguage.language,
                        );
                    }
                    if (monarchLanguage.conf) {
                        monaco.languages.setLanguageConfiguration(
                            languageId,
                            monarchLanguage.conf,
                        );
                    }
                    if (shouldInstallTextMate) {
                        void ensureMonacoTextMateProvider(monaco, languageId);
                    }
                    return;
                }

                const tokenizedLanguage = loaded as TokenizedLanguageModule;
                if (!shouldInstallTextMate) {
                    monaco.languages.setTokensProvider(
                        languageId,
                        tokenizedLanguage.tokensProvider,
                    );
                }
                if (tokenizedLanguage.conf) {
                    monaco.languages.setLanguageConfiguration(
                        languageId,
                        tokenizedLanguage.conf,
                    );
                }
                if (shouldInstallTextMate) {
                    void ensureMonacoTextMateProvider(monaco, languageId);
                }
            });
        });
    }
}

function configureMarkdownFenceLanguages() {
    registerLanguageIds(["astro"], textMateOnlyLanguage());
    registerLanguageIds(
        ["bat", "batch", "cmd"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/bat/bat.js"),
        ),
    );
    registerLanguageIds(
        [LARGE_FILE_JSON_LANGUAGE_ID],
        jsonLanguage({ allowComments: false }),
    );
    registerLanguageIds(
        [LARGE_FILE_JSONC_LANGUAGE_ID],
        jsonLanguage({ allowComments: true }),
    );
    registerLanguageIds(
        ["markdown"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/markdown/markdown.js"),
        ),
    );
    registerLanguageIds(
        ["mdx"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/mdx/mdx.js"),
        ),
    );
    registerLanguageIds(
        ["graphql", "gql"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/graphql/graphql.js"),
        ),
    );
    registerLanguageIds(
        ["c", "cpp", "c++", "cc", "cxx", "h", "hpp"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.js"),
        ),
    );
    registerLanguageIds(
        ["clojure", "clj", "cljs"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/clojure/clojure.js"),
        ),
    );
    registerLanguageIds(["cmake"], monarchLanguage(cmakeMonarchDefinition));
    registerLanguageIds(
        ["csharp", "c#", "cs"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/csharp/csharp.js"),
        ),
    );
    registerLanguageIds(
        ["csv", "tsv"],
        textMateOnlyLanguage(),
    );
    registerLanguageIds(
        ["d"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.js"),
        ),
    );
    registerLanguageIds(
        ["dart"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/dart/dart.js"),
        ),
    );
    registerLanguageIds(
        ["diff", "patch"],
        monarchLanguage(diffMonarchDefinition),
    );
    registerLanguageIds(
        ["css"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/css/css.js"),
        ),
    );
    registerLanguageIds(
        ["scss"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/scss/scss.js"),
        ),
    );
    registerLanguageIds(
        ["less"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/less/less.js"),
        ),
    );
    registerLanguageIds(
        ["dockerfile", "docker"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js"),
        ),
    );
    registerLanguageIds(
        ["elixir", "erlang", "erl", "ex", "exs"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/elixir/elixir.js"),
        ),
    );
    registerLanguageIds(["fish"], textMateOnlyLanguage());
    registerLanguageIds(
        ["go", "golang"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/go/go.js"),
        ),
    );
    registerLanguageIds(
        ["groovy"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/java/java.js"),
        ),
    );
    registerLanguageIds(
        ["haskell", "hs"],
        monarchLanguage(haskellMonarchDefinition),
    );
    registerLanguageIds(
        ["html"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/html/html.js"),
        ),
    );
    registerLanguageIds(["http", "rest"], textMateOnlyLanguage());
    registerLanguageIds(
        ["java"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/java/java.js"),
        ),
    );
    registerLanguageIds(
        ["julia", "jl"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/julia/julia.js"),
        ),
    );
    registerLanguageIds(["json"], jsonLanguage({ allowComments: false }));
    registerLanguageIds(["jsonc"], jsonLanguage({ allowComments: true }));
    registerLanguageIds(
        ["javascript", "js", "node", "nodejs", "mjs", "cjs"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/javascript/javascript.js"),
        ),
    );
    registerLanguageIds(
        ["javascriptreact", "jsx"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/javascript/javascript.js"),
        ),
    );
    registerLanguageIds(
        ["kotlin", "kt", "kts"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js"),
        ),
    );
    registerLanguageIds(
        ["lua"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/lua/lua.js"),
        ),
    );
    registerLanguageIds(["log"], textMateOnlyLanguage());
    registerLanguageIds(
        ["make", "makefile", "mk"],
        monarchLanguage(makefileMonarchDefinition),
    );
    registerLanguageIds(["nginx"], textMateOnlyLanguage());
    registerLanguageIds(["nix"], textMateOnlyLanguage());
    registerLanguageIds(["nu", "nushell"], textMateOnlyLanguage());
    registerLanguageIds(
        ["objc", "objective-c", "objectivec"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js"),
        ),
    );
    registerLanguageIds(
        ["pascal", "delphi"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/pascal/pascal.js"),
        ),
    );
    registerLanguageIds(
        ["perl", "pl"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/perl/perl.js"),
        ),
    );
    registerLanguageIds(
        ["php", "php3", "php4", "php5", "phtml"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/php/php.js"),
        ),
    );
    registerLanguageIds(
        ["powershell", "ps1", "ps", "pwsh"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/powershell/powershell.js"),
        ),
    );
    registerLanguageIds(["prisma"], textMateOnlyLanguage());
    registerLanguageIds(
        ["properties", "ini", "cfg", "conf", "dotenv", "env"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/ini/ini.js"),
        ),
    );
    registerLanguageIds(
        ["protobuf", "proto"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/protobuf/protobuf.js"),
        ),
    );
    registerLanguageIds(
        ["python", "py"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/python/python.js"),
        ),
    );
    registerLanguageIds(
        ["r"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/r/r.js"),
        ),
    );
    registerLanguageIds(
        ["ruby", "rb"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.js"),
        ),
    );
    registerLanguageIds(
        ["sass"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/scss/scss.js"),
        ),
    );
    registerLanguageIds(
        ["rust", "rs"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/rust/rust.js"),
        ),
    );
    registerLanguageIds(
        ["scala"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/scala/scala.js"),
        ),
    );
    registerLanguageIds(
        ["shell", "sh", "bash", "zsh", "shellscript"],
        monarchLanguage(shellMonarchDefinition, shellLanguageConfiguration),
    );
    registerLanguageIds(
        ["solidity", "sol"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/solidity/solidity.js"),
        ),
    );
    registerLanguageIds(
        ["sql"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/sql/sql.js"),
        ),
    );
    registerLanguageIds(
        ["mysql", "mariadb"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/mysql/mysql.js"),
        ),
    );
    registerLanguageIds(
        ["postgres", "postgresql", "psql"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js"),
        ),
    );
    registerLanguageIds(
        ["mssql", "tsql"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/sql/sql.js"),
        ),
    );
    registerLanguageIds(
        ["sqlite", "sqlite3"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/sql/sql.js"),
        ),
    );
    registerLanguageIds(
        ["tex", "latex"],
        monarchLanguage(latexMonarchDefinition),
    );
    registerLanguageIds(
        ["stylus", "styl"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/less/less.js"),
        ),
    );
    registerLanguageIds(["svelte"], textMateOnlyLanguage());
    registerLanguageIds(
        ["swift"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/swift/swift.js"),
        ),
    );
    registerLanguageIds(
        ["tcl"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/tcl/tcl.js"),
        ),
    );
    registerLanguageIds(
        ["toml"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/ini/ini.js"),
        ),
    );
    registerLanguageIds(
        ["typescript", "ts"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/typescript/typescript.js"),
        ),
    );
    registerLanguageIds(
        ["typescriptreact", "tsx"],
        basicLanguage(
            () =>
                import("monaco-editor/esm/vs/basic-languages/typescript/typescript.js"),
        ),
    );
    registerLanguageIds(
        ["vb", "vbnet"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/vb/vb.js"),
        ),
    );
    registerLanguageIds(["vue"], textMateOnlyLanguage());
    registerLanguageIds(
        ["xml", "svg", "xhtml"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/xml/xml.js"),
        ),
    );
    registerLanguageIds(
        ["yaml", "yml"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/yaml/yaml.js"),
        ),
    );
    registerLanguageIds(
        ["wast", "wat", "wasm"],
        monarchLanguage(wastMonarchDefinition),
    );
    registerLanguageIds(["zig"], textMateOnlyLanguage());
}

if (!monacoGlobal.__comandoMonacoConfigured) {
    monacoGlobal.MonacoEnvironment = {
        getWorker: (_moduleId, label) => {
            if (label === "json" || label === "jsonc") {
                return new jsonWorker();
            }

            if (label === "css" || label === "scss" || label === "less") {
                return new cssWorker();
            }

            if (
                label === "html" ||
                label === "handlebars" ||
                label === "razor"
            ) {
                return new htmlWorker();
            }

            if (isTypeScriptWorkerLanguageId(label)) {
                return new tsWorker();
            }

            return new editorWorker();
        },
    };

    loader.config({ monaco });
    setupTypeScriptCustomWorker(monaco);
    configureDefaultTypeScriptLanguageServices(getMonacoTypeScriptApi());
    configureMarkdownFenceLanguages();
    installTypeScriptReactLanguageServices(monaco);
    configureMonacoColorDecorators(monaco);
    configureMonacoTextMateLanguages(monaco);
    monacoGlobal.__comandoMonacoConfigured = true;
}

function isHexColor(value: string): boolean {
    return /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value);
}

function clampColorChannel(value: number): number {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function channelToHex(value: number): string {
    return clampColorChannel(value).toString(16).padStart(2, "0");
}

function normalizeMonacoColor(value: string, fallback: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return fallback;
    }

    if (isHexColor(normalized)) {
        return normalized;
    }

    const match = normalized.match(
        /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d*\.?\d+))?\s*\)$/i,
    );
    if (!match) {
        return fallback;
    }

    const [, red, green, blue, alpha] = match;
    const alphaHex =
        alpha === undefined ? "" : channelToHex(Number.parseFloat(alpha) * 255);

    return `#${channelToHex(Number.parseInt(red, 10))}${channelToHex(Number.parseInt(green, 10))}${channelToHex(Number.parseInt(blue, 10))}${alphaHex}`;
}

function withAlpha(hexColor: string, alpha: number): string {
    const normalized = normalizeMonacoColor(hexColor, hexColor);
    const base = normalized.slice(0, 7);
    return `${base}${channelToHex(alpha * 255)}`;
}

function themeRuleColor(value: string): string {
    return normalizeMonacoColor(value, value).slice(1, 7);
}

function createMonacoSemanticTokenRules(
    semanticTokenColors: ComandoSemanticTokenColors,
): monaco.editor.ITokenThemeRule[] {
    return Object.entries(semanticTokenColors).map(([token, rule]) => ({
        token,
        foreground: themeRuleColor(rule.foreground),
        ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
    }));
}

function createMonacoBracketPairThemeColors(
    bracketPairColors: readonly string[],
    unexpectedBracketColor: string,
    isDark: boolean,
): Record<string, string> {
    const colors: Record<string, string> = {
        "editorBracketHighlight.unexpectedBracket.foreground":
            unexpectedBracketColor,
    };

    bracketPairColors
        .slice(0, COMANDO_BRACKET_PAIR_COLOR_COUNT)
        .forEach((color, index) => {
            const colorIndex = index + 1;
            colors[`editorBracketHighlight.foreground${colorIndex}`] = color;
            colors[`editorBracketPairGuide.background${colorIndex}`] =
                withAlpha(color, isDark ? 0.2 : 0.16);
            colors[`editorBracketPairGuide.activeBackground${colorIndex}`] =
                withAlpha(color, isDark ? 0.52 : 0.42);
        });

    return colors;
}

function readThemeColor(
    styles: CSSStyleDeclaration,
    propertyName: string,
    fallback: string,
): string {
    return normalizeMonacoColor(
        styles.getPropertyValue(propertyName),
        fallback,
    );
}

export function getMonacoThemeFromDom(): ComandoMonacoTheme {
    if (typeof document === "undefined") {
        return LIGHT_THEME_NAME;
    }

    return document.documentElement.classList.contains("dark")
        ? DARK_THEME_NAME
        : LIGHT_THEME_NAME;
}

export function applyMonacoThemeFromDom(): ComandoMonacoTheme {
    const themeName = getMonacoThemeFromDom();

    if (typeof document === "undefined") {
        return themeName;
    }

    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const isDark = themeName === DARK_THEME_NAME;
    const editorBackground = readThemeColor(
        styles,
        "--color-editor",
        isDark ? "#1c1c1c" : "#ffffff",
    );
    const editorForeground = readThemeColor(
        styles,
        "--color-editor-text",
        isDark ? "#e8e8e8" : "#1c1c1c",
    );
    const textSecondary = readThemeColor(
        styles,
        "--color-text-secondary",
        isDark ? "#8a8a8a" : "#737373",
    );
    const border = readThemeColor(
        styles,
        "--color-border",
        isDark ? "#383838" : "#e5e5e5",
    );
    const borderSubtle = readThemeColor(
        styles,
        "--color-border-subtle",
        isDark ? "#38383873" : "#e5e5e559",
    );
    const accent = readThemeColor(
        styles,
        "--color-accent",
        isDark ? "#818cf8" : "#6366f1",
    );
    const accentSoft = readThemeColor(
        styles,
        "--color-accent-soft",
        withAlpha(accent, isDark ? 0.16 : 0.12),
    );
    const selection = readThemeColor(
        styles,
        "--color-selection",
        withAlpha(accent, isDark ? 0.2 : 0.12),
    );
    const elevatedBackground = readThemeColor(
        styles,
        "--color-bg-elevated",
        isDark ? "#232323" : "#fcfcfc",
    );
    const secondaryBackground = readThemeColor(
        styles,
        "--color-bg-secondary",
        isDark ? "#252525" : "#f5f5f5",
    );
    const textMateTheme = createComandoTextMateTheme({
        accent,
        editorBackground,
        editorForeground,
        isDark,
        textSecondary,
        themeName,
    });
    const {
        constant: constantColor,
        function: functionColor,
        keyword: keywordColor,
        namespace: namespaceColor,
        string: stringColor,
        tag: tagColor,
        type: typeColor,
    } = textMateTheme.palette;
    const lineHighlight = withAlpha(editorForeground, isDark ? 0.04 : 0.035);
    const scrollbar = withAlpha(editorForeground, isDark ? 0.14 : 0.1);
    const scrollbarHover = withAlpha(editorForeground, isDark ? 0.22 : 0.16);
    const insertedBackground = withAlpha("#10b981", isDark ? 0.18 : 0.12);
    const insertedGutterBackground = withAlpha("#10b981", isDark ? 0.22 : 0.14);
    const removedBackground = withAlpha("#ef4444", isDark ? 0.18 : 0.12);
    const removedGutterBackground = withAlpha("#ef4444", isDark ? 0.22 : 0.14);
    const bracketPairThemeColors = createMonacoBracketPairThemeColors(
        [
            keywordColor,
            stringColor,
            functionColor,
            typeColor,
            constantColor,
            namespaceColor,
        ],
        tagColor,
        isDark,
    );

    monaco.editor.defineTheme(themeName, {
        base: isDark ? "vs-dark" : "vs",
        encodedTokensColors: [...textMateTheme.encodedTokensColors],
        inherit: true,
        // These `rules` only fire for tokens emitted by Monaco's Monarch /
        // basic-languages tokenizers (SQL, XML, YAML, Makefile, etc.). Every
        // TextMate-backed language is painted via `encodedTokensColors`
        // above, so we deliberately keep this list small and derive it from
        // the same palette instead of hand-maintaining a parallel copy of
        // the TextMate scope table.
        rules: [
            ...createMonarchFallbackRules(textMateTheme.palette).map(
                (rule) => ({
                    token: rule.token,
                    foreground: themeRuleColor(rule.foreground),
                    ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
                }),
            ),
            ...createMonacoSemanticTokenRules(
                textMateTheme.semanticTokenColors,
            ),
        ],
        colors: {
            "diffEditor.insertedLineBackground": insertedBackground,
            "diffEditor.insertedTextBorder": "#00000000",
            "diffEditor.insertedTextBackground": insertedBackground,
            "diffEditor.removedLineBackground": removedBackground,
            "diffEditor.removedTextBorder": "#00000000",
            "diffEditor.removedTextBackground": removedBackground,
            "diffEditorGutter.insertedLineBackground": insertedGutterBackground,
            "diffEditorGutter.removedLineBackground": removedGutterBackground,
            "dropdown.background": elevatedBackground,
            "dropdown.border": border,
            "dropdown.foreground": editorForeground,
            "editor.background": editorBackground,
            "editor.foreground": editorForeground,
            "editorCursor.foreground": accent,
            "editorGutter.background": editorBackground,
            "editorHoverWidget.background": elevatedBackground,
            "editorHoverWidget.border": border,
            "editor.lineHighlightBackground": lineHighlight,
            "editor.lineHighlightBorder": "#00000000",
            "editorIndentGuide.activeBackground1": border,
            "editorIndentGuide.background1": borderSubtle,
            "editorLineNumber.activeForeground": editorForeground,
            "editorLineNumber.foreground": textSecondary,
            "editor.selectionBackground": selection,
            "editor.selectionHighlightBackground": accentSoft,
            "editor.inactiveSelectionBackground": accentSoft,
            "editorWhitespace.foreground": borderSubtle,
            "editorSuggestWidget.background": elevatedBackground,
            "editorSuggestWidget.border": border,
            "editorSuggestWidget.foreground": editorForeground,
            "editorSuggestWidget.selectedBackground": accentSoft,
            "editorWidget.background": elevatedBackground,
            "editorWidget.border": border,
            focusBorder: accent,
            "input.background": secondaryBackground,
            "input.border": border,
            "input.foreground": editorForeground,
            "inputOption.activeBorder": accent,
            "list.activeSelectionBackground": selection,
            "list.activeSelectionForeground": editorForeground,
            "list.hoverBackground": accentSoft,
            "list.inactiveSelectionBackground": accentSoft,
            "list.inactiveSelectionForeground": editorForeground,
            "minimap.background": editorBackground,
            "minimap.selectionHighlight": selection,
            "peekView.border": border,
            "peekViewEditor.background": editorBackground,
            "peekViewResult.background": secondaryBackground,
            "scrollbarSlider.activeBackground": scrollbarHover,
            "scrollbarSlider.background": scrollbar,
            "scrollbarSlider.hoverBackground": scrollbarHover,
            ...bracketPairThemeColors,
        },
    });
    monaco.editor.setTheme(themeName);
    applyMonacoTextMateTheme(monaco, textMateTheme);

    return themeName;
}

export function ensureMonacoTextMateForLanguage(languageId: string) {
    return ensureMonacoTextMateProvider(monaco, languageId);
}
