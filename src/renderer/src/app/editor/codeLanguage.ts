import {
    Language,
    LanguageSupport,
    StreamLanguage,
} from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";

import { resolveEditorLanguage } from "@shared/editor-language";

type LanguageKey =
    | "astro"
    | "c"
    | "csharp"
    | "clojure"
    | "cmake"
    | "cpp"
    | "css"
    | "d"
    | "diff"
    | "dockerfile"
    | "elixir"
    | "erlang"
    | "go"
    | "graphql"
    | "groovy"
    | "hcl"
    | "haskell"
    | "html"
    | "java"
    | "javascript"
    | "javascript-jsx"
    | "json"
    | "julia"
    | "kotlin"
    | "lua"
    | "markdown"
    | "makefile"
    | "pascal"
    | "perl"
    | "php"
    | "powershell"
    | "prisma"
    | "properties"
    | "protobuf"
    | "python"
    | "r"
    | "ruby"
    | "rust"
    | "sass"
    | "scala"
    | "shell"
    | "sql"
    | "sql-mssql"
    | "sql-mysql"
    | "sql-postgresql"
    | "sql-sqlite"
    | "stex"
    | "stylus"
    | "svelte"
    | "swift"
    | "tcl"
    | "toml"
    | "typescript"
    | "typescript-jsx"
    | "vb"
    | "vue"
    | "wast"
    | "xml"
    | "yaml";

const markdownFenceAliases: Record<LanguageKey, readonly string[]> = {
    astro: ["astro"],
    c: ["c"],
    csharp: ["csharp", "c#", "cs"],
    clojure: ["clojure", "clj", "cljs"],
    cmake: ["cmake"],
    cpp: ["cpp", "c++", "cc", "cxx", "h", "hpp"],
    css: ["css", "scss", "less"],
    d: ["d"],
    diff: ["diff", "patch"],
    dockerfile: ["dockerfile", "docker"],
    elixir: ["elixir", "ex", "exs"],
    erlang: ["erlang", "erl"],
    go: ["go", "golang"],
    graphql: ["graphql", "gql"],
    groovy: ["groovy"],
    hcl: ["hcl", "terraform", "tf", "tfvars"],
    haskell: ["haskell", "hs"],
    html: ["html"],
    java: ["java"],
    javascript: ["javascript", "js", "node", "nodejs", "mjs", "cjs"],
    "javascript-jsx": ["jsx"],
    json: ["json", "jsonc"],
    julia: ["julia", "jl"],
    kotlin: ["kotlin", "kt", "kts"],
    lua: ["lua"],
    markdown: ["markdown", "md", "mdown", "mkd"],
    makefile: ["make", "makefile", "mk"],
    pascal: ["pascal", "delphi"],
    perl: ["perl", "pl"],
    php: ["php", "php3", "php4", "php5", "phtml"],
    powershell: ["powershell", "ps1", "ps", "pwsh"],
    prisma: ["prisma"],
    properties: ["properties", "ini", "cfg", "conf", "dotenv", "env"],
    protobuf: ["protobuf", "proto"],
    python: ["python", "py"],
    r: ["r"],
    ruby: ["ruby", "rb"],
    rust: ["rust", "rs"],
    sass: ["sass"],
    scala: ["scala", "sc"],
    shell: ["shell", "sh", "bash", "zsh", "fish", "shellscript"],
    sql: ["sql"],
    "sql-mssql": ["mssql", "tsql"],
    "sql-mysql": ["mysql", "mariadb"],
    "sql-postgresql": ["postgres", "postgresql", "psql"],
    "sql-sqlite": ["sqlite", "sqlite3"],
    stex: ["tex", "latex"],
    stylus: ["stylus", "styl"],
    svelte: ["svelte"],
    swift: ["swift"],
    tcl: ["tcl"],
    toml: ["toml"],
    typescript: ["typescript", "ts"],
    "typescript-jsx": ["tsx", "mdx"],
    vb: ["vb", "vbnet"],
    vue: ["vue"],
    wast: ["wast", "wat", "wasm"],
    xml: ["xml", "svg", "xhtml"],
    yaml: ["yaml", "yml"],
};

const markdownFenceAliasToKey = new Map<string, LanguageKey>();
const pathLanguageIdToKey: Record<string, LanguageKey | null> = {
    astro: "astro",
    c: "c",
    clojure: "clojure",
    cmake: "cmake",
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    d: "d",
    dockerfile: "dockerfile",
    diff: "diff",
    elixir: "elixir",
    erlang: "erlang",
    go: "go",
    graphql: "graphql",
    groovy: "groovy",
    hcl: "hcl",
    haskell: "haskell",
    html: "html",
    ini: "properties",
    java: "java",
    javascript: "javascript",
    jsx: "javascript-jsx",
    json: "json",
    julia: "julia",
    kotlin: "kotlin",
    less: "css",
    lua: "lua",
    markdown: "markdown",
    makefile: "makefile",
    mdx: "typescript-jsx",
    pascal: "pascal",
    php: "php",
    plaintext: null,
    powershell: "powershell",
    prisma: "prisma",
    properties: "properties",
    protobuf: "protobuf",
    python: "python",
    r: "r",
    ruby: "ruby",
    rust: "rust",
    sass: "sass",
    scala: "scala",
    scss: "css",
    shell: "shell",
    sql: "sql",
    stylus: "stylus",
    svelte: "svelte",
    swift: "swift",
    tcl: "tcl",
    toml: "toml",
    typescript: "typescript",
    tsx: "typescript-jsx",
    vb: "vb",
    vue: "vue",
    wast: "wast",
    xml: "xml",
    yaml: "yaml",
};
const mimeTypeToKey: Record<string, LanguageKey | null> = {
    "application/astro": "astro",
    "application/graphql-response+json": "graphql",
    "application/hcl": "hcl",
    "application/json": "json",
    "application/prisma": "prisma",
    "application/sql": "sql",
    "application/toml": "toml",
    "application/typescript": "typescript",
    "application/x-httpd-php": "php",
    "application/x-sh": "shell",
    "application/x-terraform": "hcl",
    "application/xml": "xml",
    "application/yaml": "yaml",
    "image/svg+xml": "xml",
    "text/css": "css",
    "text/html": "html",
    "text/javascript": "javascript",
    "text/jsx": "javascript-jsx",
    "text/markdown": "markdown",
    "text/plain": null,
    "text/x-csharp": "csharp",
    "text/x-elixir": "elixir",
    "text/x-graphql": "graphql",
    "text/x-hcl": "hcl",
    "text/x-prisma": "prisma",
    "text/x-svelte": "svelte",
    "text/x-terraform": "hcl",
    "text/typescript": "typescript",
    "text/x-toml": "toml",
    "text/x-c": "c",
    "text/x-c++src": "cpp",
    "text/x-diff": "diff",
    "text/x-go": "go",
    "text/x-java-source": "java",
    "text/x-java": "java",
    "text/x-jsx": "javascript-jsx",
    "text/x-patch": "diff",
    "text/x-php": "php",
    "text/x-python": "python",
    "text/x-ruby": "ruby",
    "text/x-rustsrc": "rust",
    "text/x-shellscript": "shell",
    "text/x-sql": "sql",
    "text/x-tsx": "typescript-jsx",
    "text/x-vue": "vue",
    "text/xml": "xml",
    "text/yaml": "yaml",
};
const languageCache = new Map<LanguageKey, Promise<LanguageSupport | null>>();
const exactPathAliases = new Map<string, LanguageKey>([
    ["dockerfile", "dockerfile"],
    ["makefile", "makefile"],
]);

for (const key of Object.keys(markdownFenceAliases) as LanguageKey[]) {
    for (const alias of markdownFenceAliases[key]) {
        markdownFenceAliasToKey.set(alias.toLowerCase(), key);
    }
}

function toLanguageSupport(
    extension: LanguageSupport | Language | null,
): LanguageSupport | null {
    if (!extension) {
        return null;
    }
    if (extension instanceof LanguageSupport) {
        return extension;
    }
    if (extension instanceof Language) {
        return new LanguageSupport(extension);
    }
    return null;
}

function loadCachedLanguageByKey(
    key: LanguageKey,
): Promise<LanguageSupport | null> {
    const cached = languageCache.get(key);
    if (cached) {
        return cached;
    }

    const loader = Promise.resolve(loadLanguageByKey(key))
        .then((language) => toLanguageSupport(language))
        .catch((error) => {
            languageCache.delete(key);
            console.error(
                `Failed to load CodeMirror language support for "${key}".`,
                error,
            );
            return null;
        });
    languageCache.set(key, loader);
    return loader;
}

async function loadHclLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /#.*/, token: "comment" },
                { regex: /\/\/.*/, token: "comment" },
                { regex: /\/\*.*?\*\//, token: "comment" },
                { regex: /<<-?[A-Z][A-Z0-9_]*/, token: "string" },
                {
                    regex: /\b(?:terraform|provider|variable|output|resource|data|module|locals|backend|provisioner|connection|dynamic|moved|import|check|run)\b/,
                    token: "keyword",
                },
                {
                    regex: /\b(?:var|local|path|module|data|self|count|each|terraform)\b(?:\.[A-Za-z_][\w-]*)+/,
                    token: "variableName",
                },
                {
                    regex: /\b[A-Za-z_][\w-]*(?=\s*=)/,
                    token: "definition",
                },
                {
                    regex: /\b[A-Za-z_][\w-]*(?=\s*\()/,
                    token: "function",
                },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /\b(?:true|false|null)\b/, token: "atom" },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /==|!=|<=|>=|&&|\|\||=>|[=<>+\-*/%!?]/,
                    token: "operator",
                },
                { regex: /[()[\]{},.:]/, token: "punctuation" },
                { regex: /\b[A-Za-z_][\w-]*\b/, token: "propertyName" },
            ],
        }),
    );
}

async function loadPrismaLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /\/\/.*/, token: "comment" },
                {
                    regex: /\b(?:datasource|generator|model|enum|type|view)\b/,
                    token: "keyword",
                },
                { regex: /@@?[A-Za-z_][\w]*/, token: "meta" },
                {
                    regex: /\b(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported)\b/,
                    token: "typeName",
                },
                {
                    regex: /\b(?:env|uuid|cuid|cuid2|ulid|nanoid|now|autoincrement|dbgenerated|sequence)\b(?=\s*\()/,
                    token: "function",
                },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /\b(?:true|false|null)\b/, token: "atom" },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /\b[A-Za-z_][\w]*(?=\s+(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported|[A-Z][\w]*)(?:\[\]|\?)?)/,
                    token: "definition",
                },
                { regex: /[=?:@[\](),.]/, token: "operator" },
                { regex: /\b[A-Za-z_][\w]*\b/, token: "variableName" },
            ],
        }),
    );
}

async function loadElixirLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /#.*/, token: "comment" },
                { regex: /@[A-Za-z_][\w]*/, token: "meta" },
                {
                    regex: /\b(?:def|defp|defmodule|defimpl|defprotocol|defguard|defguardp|defmacro|defmacrop|defdelegate|defexception|defstruct|if|unless|case|cond|with|fn|do|end|else|rescue|after|catch|try|receive|quote|unquote|use|import|alias|require|super|when|for|in)\b/,
                    token: "keyword",
                },
                {
                    regex: /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*\b/,
                    token: "typeName",
                },
                {
                    regex: /:(?:[A-Za-z_][\w]*[!?]?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/,
                    token: "atom",
                },
                { regex: /~[a-zA-Z][^,\s)\]}]+/, token: "string" },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /'(?:[^'\\]|\\.)*'/, token: "string" },
                { regex: /\b(?:true|false|nil)\b/, token: "atom" },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /\b[a-z_][\w]*[!?]?(?=\s*\()/,
                    token: "function",
                },
                {
                    regex: /\|>|\+\+|--|=>|<-|::|=~|==|!=|<=|>=|&&|\|\||\\|[=+\-*/<>!|&^]/,
                    token: "operator",
                },
                { regex: /[%()[\]{}.,:]/, token: "punctuation" },
                { regex: /\b[a-z_][\w]*[!?]?\b/, token: "variableName" },
            ],
        }),
    );
}

async function loadVueLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /<!--.*?-->/, token: "comment" },
                { regex: /\/\/.*/, token: "comment" },
                { regex: /\/\*.*?\*\//, token: "comment" },
                { regex: /<\/?[A-Za-z][\w:-]*/, token: "tag" },
                { regex: /(?:v-[\w-]+|[:@#][\w-]+)/, token: "attributeName" },
                { regex: /\b[A-Za-z_][\w:-]*(?==)/, token: "attributeName" },
                { regex: /\{\{[^}]*\}\}/, token: "meta" },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /'(?:[^'\\]|\\.)*'/, token: "string" },
                {
                    regex: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|async|await|new|class|extends|implements|interface|type|typeof|try|catch|finally|throw)\b/,
                    token: "keyword",
                },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /=>|==|!=|<=|>=|&&|\|\||[=+\-*/<>!?|&.:]/,
                    token: "operator",
                },
                { regex: /\b[A-Z][A-Za-z0-9_]*\b/, token: "typeName" },
                { regex: /\b[A-Za-z_$][\w$-]*\b/, token: "variableName" },
            ],
        }),
    );
}

async function loadSvelteLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /<!--.*?-->/, token: "comment" },
                { regex: /\/\/.*/, token: "comment" },
                { regex: /\/\*.*?\*\//, token: "comment" },
                { regex: /<\/?[A-Za-z][\w:-]*/, token: "tag" },
                { regex: /\{[#:/@][^}]*\}|\{[^}]*\}/, token: "meta" },
                {
                    regex: /\b(?:on|bind|class|use|transition|animate|in|out):[\w-]+/,
                    token: "attributeName",
                },
                { regex: /\b[A-Za-z_][\w:-]*(?==)/, token: "attributeName" },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /'(?:[^'\\]|\\.)*'/, token: "string" },
                {
                    regex: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|async|await|new|class|extends|implements|interface|type|typeof|try|catch|finally|throw)\b/,
                    token: "keyword",
                },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /=>|==|!=|<=|>=|&&|\|\||[=+\-*/<>!?|&.:]/,
                    token: "operator",
                },
                { regex: /\b[A-Z][A-Za-z0-9_]*\b/, token: "typeName" },
                { regex: /\b[A-Za-z_$][\w$-]*\b/, token: "variableName" },
            ],
        }),
    );
}

async function loadAstroLanguage(): Promise<LanguageSupport | Language> {
    const { simpleMode } =
        await import("@codemirror/legacy-modes/mode/simple-mode");

    return StreamLanguage.define(
        simpleMode({
            start: [
                { regex: /^---$/, token: "meta" },
                { regex: /<!--.*?-->/, token: "comment" },
                { regex: /\/\/.*/, token: "comment" },
                { regex: /\/\*.*?\*\//, token: "comment" },
                { regex: /<\/?[A-Za-z][\w:-]*/, token: "tag" },
                { regex: /\{[^}]*\}/, token: "meta" },
                { regex: /\b[A-Za-z_][\w:-]*(?==)/, token: "attributeName" },
                { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
                { regex: /'(?:[^'\\]|\\.)*'/, token: "string" },
                {
                    regex: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|async|await|new|class|extends|implements|interface|type|typeof|try|catch|finally|throw)\b/,
                    token: "keyword",
                },
                { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
                {
                    regex: /=>|==|!=|<=|>=|&&|\|\||[=+\-*/<>!?|&.:]/,
                    token: "operator",
                },
                { regex: /\b[A-Z][A-Za-z0-9_]*\b/, token: "typeName" },
                { regex: /\b[A-Za-z_$][\w$-]*\b/, token: "variableName" },
            ],
        }),
    );
}

async function loadLanguageByKey(
    key: LanguageKey,
): Promise<LanguageSupport | Language | null> {
    switch (key) {
        case "markdown":
            return import("@codemirror/lang-markdown").then(({ markdown }) =>
                markdown(),
            );
        case "c":
        case "cpp":
            return import("@codemirror/lang-cpp").then(({ cpp }) => cpp());
        case "csharp":
            return import("@codemirror/legacy-modes/mode/clike").then(
                ({ csharp }) => StreamLanguage.define(csharp),
            );
        case "rust":
            return import("@codemirror/lang-rust").then(({ rust }) => rust());
        case "javascript":
            return javascript();
        case "javascript-jsx":
            return javascript({ jsx: true });
        case "typescript":
            return javascript({ typescript: true });
        case "typescript-jsx":
            return javascript({ typescript: true, jsx: true });
        case "json":
            return import("@codemirror/lang-json").then(({ json }) => json());
        case "python":
            return import("@codemirror/lang-python").then(({ python }) =>
                python(),
            );
        case "java":
            return import("@codemirror/lang-java").then(({ java }) => java());
        case "kotlin":
            return import("@codemirror/legacy-modes/mode/clike").then(
                ({ kotlin }) => StreamLanguage.define(kotlin),
            );
        case "scala":
            return import("@codemirror/legacy-modes/mode/clike").then(
                ({ scala }) => StreamLanguage.define(scala),
            );
        case "html":
            return html();
        case "css":
            return css();
        case "hcl":
            return loadHclLanguage();
        case "prisma":
            return loadPrismaLanguage();
        case "elixir":
            return loadElixirLanguage();
        case "vue":
            return loadVueLanguage();
        case "svelte":
            return loadSvelteLanguage();
        case "astro":
            return loadAstroLanguage();
        case "cmake":
            return import("@codemirror/legacy-modes/mode/cmake").then(
                ({ cmake }) => StreamLanguage.define(cmake),
            );
        case "dockerfile":
            return import("@codemirror/legacy-modes/mode/dockerfile").then(
                ({ dockerFile }) => StreamLanguage.define(dockerFile),
            );
        case "yaml":
            return import("@codemirror/lang-yaml").then(({ yaml }) => yaml());
        case "makefile":
            return import("@codemirror/legacy-modes/mode/simple-mode").then(
                ({ simpleMode }) =>
                    StreamLanguage.define(
                        simpleMode({
                            start: [
                                { regex: /#.*/, token: "comment" },
                                { regex: /^\t.*/, token: "meta" },
                                {
                                    regex: /^\s*(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|export|unexport|override|private|define|endef|undefine|vpath)\b/,
                                    token: "keyword",
                                },
                                {
                                    regex: /^\s*[A-Za-z0-9_.-]+\s*(?::=|\?=|\+=|!=|=)/,
                                    token: "def",
                                },
                                {
                                    regex: /^\s*[^\s:#=]+(?=\s*:)/,
                                    token: "definition",
                                },
                                {
                                    regex: /\$\((?:[^()\\]|\\.)+\)|\$\{(?:[^{}\\]|\\.)+\}/,
                                    token: "variableName",
                                },
                                {
                                    regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
                                    token: "string",
                                },
                                { regex: /[:=]/, token: "operator" },
                            ],
                        }),
                    ),
            );
        case "powershell":
            return import("@codemirror/legacy-modes/mode/powershell").then(
                ({ powerShell }) => StreamLanguage.define(powerShell),
            );
        case "properties":
            return import("@codemirror/legacy-modes/mode/properties").then(
                ({ properties }) => StreamLanguage.define(properties),
            );
        case "protobuf":
            return import("@codemirror/legacy-modes/mode/protobuf").then(
                ({ protobuf }) => StreamLanguage.define(protobuf),
            );
        case "swift":
            return import("@codemirror/legacy-modes/mode/swift").then(
                ({ swift }) => StreamLanguage.define(swift),
            );
        case "shell":
            return import("@codemirror/legacy-modes/mode/shell").then(
                ({ shell }) => StreamLanguage.define(shell),
            );
        case "toml":
            return import("@codemirror/legacy-modes/mode/toml").then(
                ({ toml }) => StreamLanguage.define(toml),
            );
        case "go":
            return import("@codemirror/legacy-modes/mode/go").then(({ go }) =>
                StreamLanguage.define(go),
            );
        case "graphql":
            return import("@codemirror/legacy-modes/mode/simple-mode").then(
                ({ simpleMode }) =>
                    StreamLanguage.define(
                        simpleMode({
                            start: [
                                { regex: /#.*/, token: "comment" },
                                {
                                    regex: /\b(?:query|mutation|subscription|fragment|on|schema|type|interface|union|enum|input|scalar|directive|extend|implements|repeatable|true|false|null)\b/,
                                    token: "keyword",
                                },
                                {
                                    regex: /\$[A-Za-z_][\w]*/,
                                    token: "variableName",
                                },
                                {
                                    regex: /@[A-Za-z_][\w]*/,
                                    token: "meta",
                                },
                                {
                                    regex: /"(?:[^"\\]|\\.)*"/,
                                    token: "string",
                                },
                                {
                                    regex: /\b\d+(?:\.\d+)?\b/,
                                    token: "number",
                                },
                                {
                                    regex: /\.\.\./,
                                    token: "operator",
                                },
                                {
                                    regex: /[!():=@[\]{}|]/,
                                    token: "punctuation",
                                },
                                {
                                    regex: /[A-Za-z_][\w]*/,
                                    token: "propertyName",
                                },
                            ],
                        }),
                    ),
            );
        case "ruby":
            return import("@codemirror/legacy-modes/mode/ruby").then(
                ({ ruby }) => StreamLanguage.define(ruby),
            );
        case "r":
            return import("@codemirror/legacy-modes/mode/r").then(({ r }) =>
                StreamLanguage.define(r),
            );
        case "clojure":
            return import("@codemirror/legacy-modes/mode/clojure").then(
                ({ clojure }) => StreamLanguage.define(clojure),
            );
        case "haskell":
            return import("@codemirror/legacy-modes/mode/haskell").then(
                ({ haskell }) => StreamLanguage.define(haskell),
            );
        case "erlang":
            return import("@codemirror/legacy-modes/mode/erlang").then(
                ({ erlang }) => StreamLanguage.define(erlang),
            );
        case "perl":
            return import("@codemirror/legacy-modes/mode/perl").then(
                ({ perl }) => StreamLanguage.define(perl),
            );
        case "php":
            return import("@codemirror/lang-php").then(({ php }) => php());
        case "d":
            return import("@codemirror/legacy-modes/mode/d").then(({ d }) =>
                StreamLanguage.define(d),
            );
        case "lua":
            return import("@codemirror/legacy-modes/mode/lua").then(({ lua }) =>
                StreamLanguage.define(lua),
            );
        case "julia":
            return import("@codemirror/legacy-modes/mode/julia").then(
                ({ julia }) => StreamLanguage.define(julia),
            );
        case "groovy":
            return import("@codemirror/legacy-modes/mode/groovy").then(
                ({ groovy }) => StreamLanguage.define(groovy),
            );
        case "sql":
            return import("@codemirror/lang-sql").then(({ sql }) => sql());
        case "sql-mssql":
            return import("@codemirror/lang-sql").then(({ MSSQL, sql }) =>
                sql({ dialect: MSSQL }),
            );
        case "sql-mysql":
            return import("@codemirror/lang-sql").then(({ MySQL, sql }) =>
                sql({ dialect: MySQL }),
            );
        case "sql-postgresql":
            return import("@codemirror/lang-sql").then(({ PostgreSQL, sql }) =>
                sql({ dialect: PostgreSQL }),
            );
        case "sql-sqlite":
            return import("@codemirror/lang-sql").then(({ SQLite, sql }) =>
                sql({ dialect: SQLite }),
            );
        case "diff":
            return import("@codemirror/legacy-modes/mode/diff").then(
                ({ diff }) => StreamLanguage.define(diff),
            );
        case "sass":
            return import("@codemirror/legacy-modes/mode/sass").then(
                ({ sass }) => StreamLanguage.define(sass),
            );
        case "stylus":
            return import("@codemirror/legacy-modes/mode/stylus").then(
                ({ stylus }) => StreamLanguage.define(stylus),
            );
        case "stex":
            return import("@codemirror/legacy-modes/mode/stex").then(
                ({ stex }) => StreamLanguage.define(stex),
            );
        case "tcl":
            return import("@codemirror/legacy-modes/mode/tcl").then(({ tcl }) =>
                StreamLanguage.define(tcl),
            );
        case "vb":
            return import("@codemirror/legacy-modes/mode/vb").then(({ vb }) =>
                StreamLanguage.define(vb),
            );
        case "wast":
            return import("@codemirror/legacy-modes/mode/wast").then(
                ({ wast }) => StreamLanguage.define(wast),
            );
        case "xml":
            return import("@codemirror/legacy-modes/mode/xml").then(({ xml }) =>
                StreamLanguage.define(xml),
            );
        case "pascal":
            return import("@codemirror/legacy-modes/mode/pascal").then(
                ({ pascal }) => StreamLanguage.define(pascal),
            );
        default:
            return null;
    }
}

export function extractFenceLanguageToken(info: string): string | null {
    const trimmed = info.trim().toLowerCase();
    if (!trimmed) return null;

    const braceLanguageMatch = trimmed.match(
        /(?:^|[\s{])(?:language-|\.)?([a-z0-9+#_-]+)(?=[\s},]|$)/,
    );
    const rawToken = braceLanguageMatch?.[1] ?? trimmed.split(/\s+/, 1)[0];
    if (!rawToken) return null;

    const normalized = rawToken
        .replace(/^[{[(<.'"]+/, "")
        .replace(/[>\])}',";:]+$/, "")
        .replace(/^language-/, "")
        .replace(/^\./, "");

    return normalized || null;
}

export function resolveMarkdownCodeLanguageKey(
    info: string,
): LanguageKey | null {
    const token = extractFenceLanguageToken(info);
    if (!token) {
        return null;
    }
    return markdownFenceAliasToKey.get(token) ?? null;
}

function normalizeMimeType(mimeType?: string | null): string | null {
    if (!mimeType) {
        return null;
    }

    const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return normalized || null;
}

function resolveCodeLanguageKeyFromMimeType(
    mimeType?: string | null,
): LanguageKey | null {
    const normalizedMimeType = normalizeMimeType(mimeType);
    if (!normalizedMimeType) {
        return null;
    }

    return mimeTypeToKey[normalizedMimeType] ?? null;
}

export function resolveCodeLanguageKey(
    filePath: string,
    mimeType?: string | null,
    probeContent?: string,
): LanguageKey | null {
    const mimeTypeKey = resolveCodeLanguageKeyFromMimeType(mimeType);
    if (mimeTypeKey) {
        return mimeTypeKey;
    }

    const normalizedPath = filePath.replaceAll("\\", "/");
    const fileName = normalizedPath.split("/").pop()?.toLowerCase() ?? "";
    const exactAlias = exactPathAliases.get(fileName);
    if (exactAlias) {
        return exactAlias;
    }

    const extension = fileName.includes(".")
        ? (fileName.split(".").pop()?.toLowerCase() ?? "")
        : "";
    if (extension) {
        const extensionAlias = markdownFenceAliasToKey.get(extension);
        if (extensionAlias) {
            return extensionAlias;
        }
    }

    const resolvedLanguage = resolveEditorLanguage({
        filePath,
        probeContent,
    });
    return pathLanguageIdToKey[resolvedLanguage.id] ?? null;
}

export function resolveCodeLanguageKeyFromPath(
    filePath: string,
    probeContent?: string,
): LanguageKey | null {
    return resolveCodeLanguageKey(filePath, null, probeContent);
}

export async function loadMarkdownCodeLanguageSupport(
    info: string,
): Promise<LanguageSupport | null> {
    const key = resolveMarkdownCodeLanguageKey(info);
    if (!key) {
        return null;
    }
    return loadCachedLanguageByKey(key);
}

export async function loadCodeLanguageSupportByPath(
    filePath: string,
    mimeType?: string | null,
    probeContent?: string,
): Promise<LanguageSupport | null> {
    const key = resolveCodeLanguageKey(filePath, mimeType, probeContent);
    if (!key) {
        return null;
    }

    return loadCachedLanguageByKey(key);
}

export async function loadCodeLanguageSupportForPath(
    filePath: string,
    probeContent?: string,
): Promise<LanguageSupport | null> {
    return loadCodeLanguageSupportByPath(filePath, null, probeContent);
}
