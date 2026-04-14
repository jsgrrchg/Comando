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
    | "c"
    | "clojure"
    | "cmake"
    | "cpp"
    | "css"
    | "d"
    | "diff"
    | "dockerfile"
    | "erlang"
    | "go"
    | "groovy"
    | "haskell"
    | "html"
    | "java"
    | "javascript"
    | "javascript-jsx"
    | "json"
    | "julia"
    | "lua"
    | "makefile"
    | "pascal"
    | "perl"
    | "php"
    | "powershell"
    | "properties"
    | "protobuf"
    | "python"
    | "r"
    | "ruby"
    | "rust"
    | "sass"
    | "shell"
    | "sql"
    | "sql-mssql"
    | "sql-mysql"
    | "sql-postgresql"
    | "sql-sqlite"
    | "stex"
    | "stylus"
    | "swift"
    | "tcl"
    | "toml"
    | "typescript"
    | "typescript-jsx"
    | "vb"
    | "wast"
    | "xml"
    | "yaml";

const markdownFenceAliases: Record<LanguageKey, readonly string[]> = {
    c: ["c"],
    clojure: ["clojure", "clj", "cljs"],
    cmake: ["cmake"],
    cpp: ["cpp", "c++", "cc", "cxx", "h", "hpp"],
    css: ["css", "scss", "less"],
    d: ["d"],
    diff: ["diff", "patch"],
    dockerfile: ["dockerfile", "docker"],
    erlang: ["erlang", "erl", "elixir", "ex", "exs"],
    go: ["go", "golang"],
    groovy: ["groovy"],
    haskell: ["haskell", "hs"],
    html: ["html"],
    java: ["java", "kotlin", "kt", "kts", "scala"],
    javascript: ["javascript", "js", "node", "nodejs", "mjs", "cjs"],
    "javascript-jsx": ["jsx"],
    json: ["json", "jsonc"],
    julia: ["julia", "jl"],
    lua: ["lua"],
    makefile: ["make", "makefile", "mk"],
    pascal: ["pascal", "delphi"],
    perl: ["perl", "pl"],
    php: ["php", "php3", "php4", "php5", "phtml"],
    powershell: ["powershell", "ps1", "ps", "pwsh"],
    properties: ["properties", "ini", "cfg", "conf", "dotenv", "env"],
    protobuf: ["protobuf", "proto"],
    python: ["python", "py"],
    r: ["r"],
    ruby: ["ruby", "rb"],
    rust: ["rust", "rs"],
    sass: ["sass"],
    shell: ["shell", "sh", "bash", "zsh", "fish", "shellscript"],
    sql: ["sql"],
    "sql-mssql": ["mssql", "tsql"],
    "sql-mysql": ["mysql", "mariadb"],
    "sql-postgresql": ["postgres", "postgresql", "psql"],
    "sql-sqlite": ["sqlite", "sqlite3"],
    stex: ["tex", "latex"],
    stylus: ["stylus", "styl"],
    swift: ["swift"],
    tcl: ["tcl"],
    toml: ["toml"],
    typescript: ["typescript", "ts"],
    "typescript-jsx": ["tsx"],
    vb: ["vb", "vbnet", "csharp", "c#", "cs"],
    wast: ["wast", "wat", "wasm"],
    xml: ["xml", "svg", "xhtml"],
    yaml: ["yaml", "yml"],
};

const markdownFenceAliasToKey = new Map<string, LanguageKey>();
const pathLanguageIdToKey: Record<string, LanguageKey | null> = {
    c: "c",
    cpp: "cpp",
    csharp: "vb",
    css: "css",
    dockerfile: "dockerfile",
    go: "go",
    graphql: null,
    html: "html",
    ini: "properties",
    java: "java",
    javascript: "javascript",
    json: "json",
    kotlin: "java",
    less: "css",
    lua: "lua",
    markdown: null,
    mdx: null,
    php: "php",
    plaintext: null,
    python: "python",
    ruby: "ruby",
    rust: "rust",
    scss: "css",
    shell: "shell",
    sql: "sql",
    swift: "swift",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
};
const languageSupportCache = new Map<string, Promise<LanguageSupport | null>>();
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

function loadLanguageSupportByKey(
    key: LanguageKey,
): Promise<LanguageSupport | null> {
    const cacheKey = `key:${key}`;
    const cached = languageSupportCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const loader = Promise.resolve(loadLanguageByKey(key)).then((language) =>
        toLanguageSupport(language),
    );
    languageSupportCache.set(cacheKey, loader);
    return loader;
}

async function loadLanguageByKey(
    key: LanguageKey,
): Promise<LanguageSupport | Language | null> {
    switch (key) {
        case "c":
        case "cpp":
            return import("@codemirror/lang-cpp").then(({ cpp }) => cpp());
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
        case "html":
            return html();
        case "css":
            return css();
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

export function resolveCodeLanguageKeyFromPath(
    filePath: string,
    probeContent?: string,
): LanguageKey | null {
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

export async function loadMarkdownCodeLanguageSupport(
    info: string,
): Promise<LanguageSupport | null> {
    const key = resolveMarkdownCodeLanguageKey(info);
    if (!key) {
        return null;
    }
    return loadLanguageSupportByKey(key);
}

export async function loadCodeLanguageSupportForPath(
    filePath: string,
    probeContent?: string,
): Promise<LanguageSupport | null> {
    const key = resolveCodeLanguageKeyFromPath(filePath, probeContent);
    if (!key) {
        return null;
    }

    return loadLanguageSupportByKey(key);
}
