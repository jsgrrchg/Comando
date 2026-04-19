import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import {
    configureMonacoTextMateLanguages,
    ensureMonacoTextMateProvider,
    isTextMateLanguageSupported,
} from "./monacoTextmate";
import {
    shellLanguageConfiguration,
    shellMonarchDefinition,
} from "./monacoShell";

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

type MonacoTypeScriptApi = {
    readonly javascriptDefaults: {
        getCompilerOptions(): Record<string, unknown>;
        setCompilerOptions(options: Record<string, unknown>): void;
        setEagerModelSync(value: boolean): void;
    };
    readonly typescriptDefaults: {
        getCompilerOptions(): Record<string, unknown>;
        setCompilerOptions(options: Record<string, unknown>): void;
        setEagerModelSync(value: boolean): void;
    };
    readonly JsxEmit: {
        readonly ReactJSX: number;
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
                    monaco.languages.setMonarchTokensProvider(
                        languageId,
                        monarchLanguage.language,
                    );
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
                monaco.languages.setTokensProvider(
                    languageId,
                    tokenizedLanguage.tokensProvider,
                );
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
        ["d"],
        basicLanguage(
            () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.js"),
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
        ["javascript", "js", "node", "nodejs", "mjs", "cjs", "jsx"],
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
    registerLanguageIds(
        ["make", "makefile", "mk"],
        monarchLanguage(makefileMonarchDefinition),
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
        ["shell", "sh", "bash", "zsh", "fish", "shellscript"],
        monarchLanguage(shellMonarchDefinition, shellLanguageConfiguration),
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
        ["typescript", "ts", "tsx"],
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
}

if (!monacoGlobal.__comandoMonacoConfigured) {
    monacoGlobal.MonacoEnvironment = {
        getWorker: (_moduleId, label) => {
            if (label === "json") {
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

            if (label === "typescript" || label === "javascript") {
                return new tsWorker();
            }

            return new editorWorker();
        },
    };

    loader.config({ monaco });
    const monacoTypeScript = monaco.languages
        .typescript as unknown as MonacoTypeScriptApi;

    monacoTypeScript.typescriptDefaults.setCompilerOptions({
        ...monacoTypeScript.typescriptDefaults.getCompilerOptions(),
        allowNonTsExtensions: true,
        jsx: monacoTypeScript.JsxEmit.ReactJSX,
        target: monacoTypeScript.ScriptTarget.Latest,
    });
    monacoTypeScript.javascriptDefaults.setCompilerOptions({
        ...monacoTypeScript.javascriptDefaults.getCompilerOptions(),
        allowJs: true,
        allowNonTsExtensions: true,
        jsx: monacoTypeScript.JsxEmit.ReactJSX,
        target: monacoTypeScript.ScriptTarget.Latest,
    });
    monacoTypeScript.typescriptDefaults.setEagerModelSync(true);
    monacoTypeScript.javascriptDefaults.setEagerModelSync(true);
    configureMarkdownFenceLanguages();
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

function parseHexColor(value: string): {
    readonly blue: number;
    readonly green: number;
    readonly red: number;
} | null {
    const normalized = normalizeMonacoColor(value, "");

    if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(normalized)) {
        return null;
    }

    return {
        blue: Number.parseInt(normalized.slice(5, 7), 16),
        green: Number.parseInt(normalized.slice(3, 5), 16),
        red: Number.parseInt(normalized.slice(1, 3), 16),
    };
}

function mixHexColors(
    base: string,
    overlay: string,
    overlayWeight: number,
): string {
    const baseColor = parseHexColor(base);
    const overlayColor = parseHexColor(overlay);
    const normalizedWeight = Math.min(1, Math.max(0, overlayWeight));

    if (!baseColor || !overlayColor) {
        return normalizeMonacoColor(overlay, base);
    }

    const baseWeight = 1 - normalizedWeight;

    return `#${channelToHex(baseColor.red * baseWeight + overlayColor.red * normalizedWeight)}${channelToHex(baseColor.green * baseWeight + overlayColor.green * normalizedWeight)}${channelToHex(baseColor.blue * baseWeight + overlayColor.blue * normalizedWeight)}`;
}

function themeRuleColor(value: string): string {
    return normalizeMonacoColor(value, value).slice(1, 7);
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
    const keywordColor = mixHexColors(editorForeground, accent, 0.84);
    const typeColor = mixHexColors(editorForeground, accent, 0.66);
    const functionColor = mixHexColors(editorForeground, accent, 0.58);
    const stringColor = mixHexColors(editorForeground, accent, 0.4);
    const numberColor = mixHexColors(editorForeground, accent, 0.74);
    const constantColor = mixHexColors(editorForeground, accent, 0.7);
    const tagColor = mixHexColors(editorForeground, accent, 0.8);
    const attributeColor = mixHexColors(editorForeground, accent, 0.48);
    const regexpColor = mixHexColors(editorForeground, accent, 0.52);
    const variableColor = mixHexColors(editorForeground, accent, 0.3);
    const propertyColor = mixHexColors(editorForeground, accent, 0.42);
    const namespaceColor = mixHexColors(editorForeground, accent, 0.5);
    const macroColor = mixHexColors(editorForeground, accent, 0.64);
    const decoratorColor = mixHexColors(editorForeground, accent, 0.72);
    const escapeColor = mixHexColors(editorForeground, accent, 0.78);
    const lineHighlight = withAlpha(editorForeground, isDark ? 0.04 : 0.035);
    const scrollbar = withAlpha(editorForeground, isDark ? 0.14 : 0.1);
    const scrollbarHover = withAlpha(editorForeground, isDark ? 0.22 : 0.16);
    const insertedBackground = withAlpha("#10b981", isDark ? 0.18 : 0.12);
    const insertedGutterBackground = withAlpha("#10b981", isDark ? 0.22 : 0.14);
    const removedBackground = withAlpha("#ef4444", isDark ? 0.18 : 0.12);
    const removedGutterBackground = withAlpha("#ef4444", isDark ? 0.22 : 0.14);

    monaco.editor.defineTheme(themeName, {
        base: isDark ? "vs-dark" : "vs",
        inherit: true,
        rules: [
            {
                token: "comment",
                foreground: themeRuleColor(textSecondary),
                fontStyle: "italic",
            },
            { token: "keyword", foreground: themeRuleColor(keywordColor) },
            { token: "operator", foreground: themeRuleColor(keywordColor) },
            {
                token: "keyword.control",
                foreground: themeRuleColor(keywordColor),
            },
            { token: "keyword.other", foreground: themeRuleColor(keywordColor) },
            { token: "keyword.operator", foreground: themeRuleColor(keywordColor) },
            { token: "storage", foreground: themeRuleColor(keywordColor) },
            { token: "storage.modifier", foreground: themeRuleColor(keywordColor) },
            { token: "string", foreground: themeRuleColor(stringColor) },
            {
                token: "punctuation.definition.string",
                foreground: themeRuleColor(stringColor),
            },
            {
                token: "constant.character.escape",
                foreground: themeRuleColor(escapeColor),
            },
            { token: "number", foreground: themeRuleColor(numberColor) },
            {
                token: "constant",
                foreground: themeRuleColor(constantColor),
            },
            { token: "regexp", foreground: themeRuleColor(regexpColor) },
            { token: "type", foreground: themeRuleColor(typeColor) },
            { token: "storage.type", foreground: themeRuleColor(typeColor) },
            {
                token: "type.identifier",
                foreground: themeRuleColor(typeColor),
            },
            { token: "class", foreground: themeRuleColor(typeColor) },
            { token: "interface", foreground: themeRuleColor(typeColor) },
            { token: "support.type", foreground: themeRuleColor(typeColor) },
            { token: "support.class", foreground: themeRuleColor(typeColor) },
            {
                token: "entity.name.type",
                foreground: themeRuleColor(typeColor),
            },
            { token: "function", foreground: themeRuleColor(functionColor) },
            {
                token: "function.method",
                foreground: themeRuleColor(functionColor),
            },
            {
                token: "entity.name.function",
                foreground: themeRuleColor(functionColor),
            },
            {
                token: "support.function",
                foreground: themeRuleColor(functionColor),
            },
            {
                token: "support.function.builtin",
                foreground: themeRuleColor(functionColor),
            },
            {
                token: "entity.name.function.decorator",
                foreground: themeRuleColor(decoratorColor),
            },
            {
                token: "entity.name.function.macro",
                foreground: themeRuleColor(macroColor),
            },
            { token: "tag", foreground: themeRuleColor(tagColor) },
            {
                token: "entity.name.namespace",
                foreground: themeRuleColor(namespaceColor),
            },
            {
                token: "entity.name.module",
                foreground: themeRuleColor(namespaceColor),
            },
            {
                token: "entity.name.constant",
                foreground: themeRuleColor(constantColor),
            },
            {
                token: "attribute.name",
                foreground: themeRuleColor(attributeColor),
            },
            {
                token: "entity.other.attribute-name",
                foreground: themeRuleColor(attributeColor),
            },
            {
                token: "meta.attribute",
                foreground: themeRuleColor(decoratorColor),
            },
            { token: "variable", foreground: themeRuleColor(variableColor) },
            {
                token: "variable.other",
                foreground: themeRuleColor(variableColor),
            },
            {
                token: "variable.other.readwrite",
                foreground: themeRuleColor(variableColor),
            },
            {
                token: "variable.parameter",
                foreground: themeRuleColor(variableColor),
            },
            {
                token: "variable.language",
                foreground: themeRuleColor(keywordColor),
            },
            {
                token: "variable.other.member",
                foreground: themeRuleColor(propertyColor),
            },
            {
                token: "variable.other.constant",
                foreground: themeRuleColor(constantColor),
            },
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
        },
    });
    monaco.editor.setTheme(themeName);

    return themeName;
}
