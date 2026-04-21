export type TextMateGrammarModule = {
    readonly default: readonly unknown[];
};

export type TextMateLanguageId =
    | "astro"
    | "bat"
    | "c"
    | "clojure"
    | "cmake"
    | "cpp"
    | "csharp"
    | "css"
    | "csv"
    | "d"
    | "dart"
    | "diff"
    | "dockerfile"
    | "elixir"
    | "erlang"
    | "fish"
    | "go"
    | "graphql"
    | "groovy"
    | "haskell"
    | "hcl"
    | "html"
    | "http"
    | "ini"
    | "java"
    | "javascript"
    | "jsx"
    | "json"
    | "jsonc"
    | "julia"
    | "kotlin"
    | "less"
    | "log"
    | "lua"
    | "makefile"
    | "markdown"
    | "mdx"
    | "nginx"
    | "nix"
    | "nu"
    | "objc"
    | "pascal"
    | "perl"
    | "php"
    | "powershell"
    | "prisma"
    | "protobuf"
    | "python"
    | "r"
    | "ruby"
    | "rust"
    | "sass"
    | "scala"
    | "scss"
    | "shell"
    | "solidity"
    | "sql"
    | "stylus"
    | "svelte"
    | "swift"
    | "tcl"
    | "toml"
    | "typescript"
    | "tsx"
    | "vb"
    | "vue"
    | "wast"
    | "xml"
    | "yaml"
    | "zig";

export type TextMateTokenType = "comment" | "other" | "regex" | "string";

export type TextMateEmbeddedLanguageMap = Readonly<Record<string, string>>;
export type TextMateTokenTypeMap = Readonly<Record<string, TextMateTokenType>>;

export interface TextMateGrammarDefinition {
    readonly aliases: readonly string[];
    readonly balancedBracketScopes?: readonly string[];
    readonly embeddedLanguages?: TextMateEmbeddedLanguageMap;
    readonly injectTo?: readonly string[];
    readonly isPrimaryLanguage: boolean;
    readonly languageId: TextMateLanguageId;
    readonly loadModule: () => Promise<TextMateGrammarModule>;
    readonly scopeName: string;
    readonly shikiLanguageId: string;
    readonly tokenTypes?: TextMateTokenTypeMap;
    readonly unbalancedBracketScopes?: readonly string[];
}

const javascriptTokenTypes = {
    "entity.name.function.tagged-template": "other",
    "entity.name.type.instance.jsdoc": "other",
    "meta.import string.quoted": "other",
    "punctuation.definition.template-expression": "other",
    "string.regexp": "regex",
    "variable.other.jsdoc": "other",
} as const satisfies TextMateTokenTypeMap;

const typescriptUnbalancedBracketScopes = [
    "keyword.operator.relational",
    "storage.type.function.arrow",
    "keyword.operator.bitwise.shift",
    "meta.brace.angle",
    "punctuation.definition.tag",
    "keyword.operator.assignment.compound.bitwise.ts",
] as const;

const typescriptReactUnbalancedBracketScopes = [
    "keyword.operator.relational",
    "storage.type.function.arrow",
    "keyword.operator.bitwise.shift",
    "punctuation.definition.tag",
    "keyword.operator.assignment.compound.bitwise.ts",
] as const;

const commonStyleEmbeddedLanguages = {
    "source.css.less": "less",
    "source.css.postcss": "css",
    "source.css.sass": "sass",
    "source.css.scss": "scss",
    "source.css": "css",
    "source.postcss": "css",
    "source.sass": "sass",
    "source.stylus": "stylus",
} as const satisfies TextMateEmbeddedLanguageMap;

const commonScriptEmbeddedLanguages = {
    "source.js.jsx": "jsx",
    "source.js": "javascript",
    "source.tsx": "tsx",
    "source.ts": "typescript",
} as const satisfies TextMateEmbeddedLanguageMap;

const markdownEmbeddedLanguages = {
    "meta.embedded.block.css": "css",
    "meta.embedded.block.diff": "diff",
    "meta.embedded.block.frontmatter": "yaml",
    "meta.embedded.block.html": "html",
    "meta.embedded.block.jsonc": "jsonc",
    "meta.embedded.block.json-strict": "json",
    "meta.embedded.block.js": "javascript",
    "meta.embedded.block.javascriptreact": "jsx",
    "meta.embedded.block.python": "python",
    "meta.embedded.block.scss": "scss",
    "meta.embedded.block.shellscript": "shell",
    "meta.embedded.block.sql": "sql",
    "meta.embedded.block.ts": "typescript",
    "meta.embedded.block.typescriptreact": "tsx",
    "meta.embedded.block.xml": "xml",
    "meta.embedded.block.yaml": "yaml",
    "source.diff": "diff",
    "source.json.comments": "jsonc",
    "source.json": "json",
    "source.python": "python",
    "source.shell": "shell",
    "source.sql": "sql",
    "source.yaml": "yaml",
    "text.html.basic": "html",
    "text.html.derivative": "html",
    ...commonScriptEmbeddedLanguages,
    ...commonStyleEmbeddedLanguages,
} as const satisfies TextMateEmbeddedLanguageMap;

const vueEmbeddedLanguages = {
    "markdown.vue.codeblock": "markdown",
    "source.css.embedded.html.vue": "css",
    "source.graphql": "graphql",
    "source.json": "json",
    "source.json.comments": "jsonc",
    "source.ts.embedded.html.vue": "typescript",
    "source.yaml": "yaml",
    "text.html.basic": "html",
    "text.html.derivative": "html",
    "text.html.markdown": "markdown",
    ...commonScriptEmbeddedLanguages,
    ...commonStyleEmbeddedLanguages,
} as const satisfies TextMateEmbeddedLanguageMap;

const astroEmbeddedLanguages = {
    "source.json": "json",
    "source.unknown": "plaintext",
    ...commonScriptEmbeddedLanguages,
    ...commonStyleEmbeddedLanguages,
} as const satisfies TextMateEmbeddedLanguageMap;

const svelteEmbeddedLanguages = {
    ...commonScriptEmbeddedLanguages,
    ...commonStyleEmbeddedLanguages,
} as const satisfies TextMateEmbeddedLanguageMap;

const jsdocTypeScriptInjectionGrammar = {
    injectionSelector: "L:comment.block.documentation",
    patterns: [{ include: "#jsdocbody" }],
    repository: {
        jsdocbody: {
            begin: "(?<=/\\*\\*)([^*]|\\*(?!/))*$",
            patterns: [{ include: "source.ts#docblock" }],
            while: "(^|\\G)\\s*\\*(?!/)(?=([^*]|[*](?!/))*$)",
        },
    },
    scopeName: "documentation.injection.ts",
} as const;

const jsdocJavaScriptInjectionGrammar = {
    injectionSelector: "L:comment.block.documentation",
    patterns: [{ include: "#jsdocbody" }],
    repository: {
        jsdocbody: {
            begin: "(?<=/\\*\\*)([^*]|\\*(?!/))*$",
            patterns: [{ include: "source.js#docblock" }],
            while: "(^|\\G)\\s*\\*(?!/)(?=([^*]|[*](?!/))*$)",
        },
    },
    scopeName: "documentation.injection.js.jsx",
} as const;

const rustPropertyInjectionGrammar = {
    injectionSelector: "L:source.rust - string - comment",
    patterns: [
        {
            captures: {
                "3": { name: "entity.name.function.import.rust" },
            },
            match: "(^|[,{])([ \\t]*)([a-z_][A-Za-z0-9_]*)(?=\\s*(?:,|}|$))",
        },
        {
            captures: {
                "3": { name: "constant.other.caps.rust" },
            },
            match: "(^|[,{])([ \\t]*)([A-Z][A-Z0-9_]*)(?=\\s*(?:,|}|$))",
        },
        {
            match: "(?<=\\.)[A-Za-z_][A-Za-z0-9_]*",
            name: "variable.other.property.rust",
        },
    ],
    scopeName: "source.rust.comando-injections",
} as const;

function loadJsdocInjectionModule(): Promise<TextMateGrammarModule> {
    return Promise.resolve({
        default: [
            jsdocTypeScriptInjectionGrammar,
            jsdocJavaScriptInjectionGrammar,
        ],
    });
}

function loadRustInjectionModule(): Promise<TextMateGrammarModule> {
    return Promise.resolve({
        default: [rustPropertyInjectionGrammar],
    });
}

function createMarkdownFencedCodeBlockGrammar(options: {
    readonly contentName: string;
    readonly includeScopeName: string;
    readonly languagePattern: string;
}): Record<string, unknown> {
    return {
        begin: `(^|\\G)(\\s*)(\`{3,}|~{3,})\\s*(?i:(${options.languagePattern})((\\s+|[,:?{])[^\`]*)?$)`,
        beginCaptures: {
            "3": { name: "punctuation.definition.markdown" },
            "4": { name: "fenced_code.block.language.markdown" },
            "5": { name: "fenced_code.block.language.attributes.markdown" },
        },
        end: "(^|\\G)(\\2|\\s{0,3})(\\3)\\s*$",
        endCaptures: {
            "3": { name: "punctuation.definition.markdown" },
        },
        name: "markup.fenced_code.block.markdown",
        patterns: [
            {
                begin: "(^|\\G)(\\s*)(.*)",
                contentName: options.contentName,
                patterns: [{ include: options.includeScopeName }],
                while: "(^|\\G)(?!\\s*([`~]{3,})\\s*$)",
            },
        ],
    };
}

function asMutableRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

function clonePlainGrammar(grammar: unknown): unknown {
    return JSON.parse(JSON.stringify(grammar)) as unknown;
}

function insertRepositoryIncludeBefore(
    patterns: unknown[],
    includeScopeName: string,
    beforeScopeName: string,
) {
    const alreadyIncluded = patterns.some((pattern) => {
        const patternRecord = asMutableRecord(pattern);
        return patternRecord?.include === includeScopeName;
    });
    if (alreadyIncluded) {
        return;
    }

    const insertionIndex = patterns.findIndex((pattern) => {
        const patternRecord = asMutableRecord(pattern);
        return patternRecord?.include === beforeScopeName;
    });

    patterns.splice(
        insertionIndex === -1 ? patterns.length : insertionIndex,
        0,
        { include: includeScopeName },
    );
}

function updateFirstRepositoryPatternContentName(
    repository: Record<string, unknown>,
    repositoryKey: string,
    contentName: string,
) {
    const grammar = asMutableRecord(repository[repositoryKey]);
    const patterns = grammar?.patterns;
    if (!Array.isArray(patterns)) {
        return;
    }

    const firstPattern = asMutableRecord(patterns[0]);
    if (firstPattern) {
        firstPattern.contentName = contentName;
    }
}

function patchMarkdownGrammar(grammar: unknown): unknown {
    const clonedGrammar = clonePlainGrammar(grammar);
    const grammarRecord = asMutableRecord(clonedGrammar);
    if (grammarRecord?.scopeName !== "text.html.markdown") {
        return clonedGrammar;
    }

    const repository = asMutableRecord(grammarRecord.repository);
    const fencedCodeBlock = asMutableRecord(repository?.fenced_code_block);
    const patterns = fencedCodeBlock?.patterns;
    if (!repository || !Array.isArray(patterns)) {
        return clonedGrammar;
    }

    updateFirstRepositoryPatternContentName(
        repository,
        "fenced_code_block_js",
        "meta.embedded.block.js",
    );
    updateFirstRepositoryPatternContentName(
        repository,
        "fenced_code_block_json",
        "meta.embedded.block.json-strict",
    );
    updateFirstRepositoryPatternContentName(
        repository,
        "fenced_code_block_ts",
        "meta.embedded.block.ts",
    );

    repository.fenced_code_block_html = createMarkdownFencedCodeBlockGrammar({
        contentName: "meta.embedded.block.html",
        includeScopeName: "text.html.basic",
        languagePattern: "html|htm",
    });
    repository.fenced_code_block_jsx = createMarkdownFencedCodeBlockGrammar({
        contentName: "meta.embedded.block.javascriptreact",
        includeScopeName: "source.js.jsx",
        languagePattern: "jsx|javascriptreact",
    });

    insertRepositoryIncludeBefore(
        patterns,
        "#fenced_code_block_jsx",
        "#fenced_code_block_js",
    );
    insertRepositoryIncludeBefore(
        patterns,
        "#fenced_code_block_html",
        "#fenced_code_block_xml",
    );

    return clonedGrammar;
}

async function loadMarkdownGrammarModule(): Promise<TextMateGrammarModule> {
    const grammarModule = await import("@shikijs/langs/markdown");

    return {
        default: grammarModule.default.map((grammar) =>
            patchMarkdownGrammar(grammar),
        ),
    };
}

export const TEXT_MATE_LANGUAGE_DEFINITIONS = [
    {
        aliases: [],
        embeddedLanguages: astroEmbeddedLanguages,
        isPrimaryLanguage: true,
        languageId: "astro",
        loadModule: () => import("@shikijs/langs/astro"),
        scopeName: "source.astro",
        shikiLanguageId: "astro",
    },
    {
        aliases: ["batch", "cmd"],
        isPrimaryLanguage: true,
        languageId: "bat",
        loadModule: () => import("@shikijs/langs/bat"),
        scopeName: "source.batchfile",
        shikiLanguageId: "bat",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "c",
        loadModule: () => import("@shikijs/langs/c"),
        scopeName: "source.c",
        shikiLanguageId: "c",
    },
    {
        aliases: ["clj", "cljs", "cljc"],
        isPrimaryLanguage: true,
        languageId: "clojure",
        loadModule: () => import("@shikijs/langs/clojure"),
        scopeName: "source.clojure",
        shikiLanguageId: "clojure",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "cmake",
        loadModule: () => import("@shikijs/langs/cmake"),
        scopeName: "source.cmake",
        shikiLanguageId: "cmake",
    },
    {
        aliases: ["c++", "cc", "cxx", "h", "hh", "hpp", "hxx"],
        embeddedLanguages: {
            "source.c": "c",
            "source.glsl": "glsl",
            "source.sql": "sql",
        },
        isPrimaryLanguage: true,
        languageId: "cpp",
        loadModule: () => import("@shikijs/langs/cpp"),
        scopeName: "source.cpp",
        shikiLanguageId: "cpp",
    },
    {
        aliases: ["c#", "cs"],
        isPrimaryLanguage: true,
        languageId: "csharp",
        loadModule: () => import("@shikijs/langs/csharp"),
        scopeName: "source.cs",
        shikiLanguageId: "csharp",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "css",
        loadModule: () => import("@shikijs/langs/css"),
        scopeName: "source.css",
        shikiLanguageId: "css",
    },
    {
        aliases: ["tsv"],
        isPrimaryLanguage: true,
        languageId: "csv",
        loadModule: () => import("@shikijs/langs/csv"),
        scopeName: "text.csv",
        shikiLanguageId: "csv",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "d",
        loadModule: () => import("@shikijs/langs/d"),
        scopeName: "source.d",
        shikiLanguageId: "d",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "dart",
        loadModule: () => import("@shikijs/langs/dart"),
        scopeName: "source.dart",
        shikiLanguageId: "dart",
    },
    {
        aliases: ["patch"],
        isPrimaryLanguage: true,
        languageId: "diff",
        loadModule: () => import("@shikijs/langs/diff"),
        scopeName: "source.diff",
        shikiLanguageId: "diff",
    },
    {
        aliases: ["docker"],
        isPrimaryLanguage: true,
        languageId: "dockerfile",
        loadModule: () => import("@shikijs/langs/dockerfile"),
        scopeName: "source.dockerfile",
        shikiLanguageId: "dockerfile",
    },
    {
        aliases: ["ex", "exs"],
        embeddedLanguages: {
            "source.css": "css",
            "source.js": "javascript",
            "text.html.basic": "html",
        },
        isPrimaryLanguage: true,
        languageId: "elixir",
        loadModule: () => import("@shikijs/langs/elixir"),
        scopeName: "source.elixir",
        shikiLanguageId: "elixir",
    },
    {
        aliases: ["erl", "hrl"],
        embeddedLanguages: {
            "text.html.markdown": "markdown",
        },
        isPrimaryLanguage: true,
        languageId: "erlang",
        loadModule: () => import("@shikijs/langs/erlang"),
        scopeName: "source.erlang",
        shikiLanguageId: "erlang",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "fish",
        loadModule: () => import("@shikijs/langs/fish"),
        scopeName: "source.fish",
        shikiLanguageId: "fish",
    },
    {
        aliases: ["golang"],
        isPrimaryLanguage: true,
        languageId: "go",
        loadModule: () => import("@shikijs/langs/go"),
        scopeName: "source.go",
        shikiLanguageId: "go",
    },
    {
        aliases: ["gql"],
        embeddedLanguages: {
            "source.js": "javascript",
            "source.js.jsx": "jsx",
            "source.ts": "typescript",
            "source.tsx": "tsx",
        },
        isPrimaryLanguage: true,
        languageId: "graphql",
        loadModule: () => import("@shikijs/langs/graphql"),
        scopeName: "source.graphql",
        shikiLanguageId: "graphql",
    },
    {
        aliases: ["gradle"],
        isPrimaryLanguage: true,
        languageId: "groovy",
        loadModule: () => import("@shikijs/langs/groovy"),
        scopeName: "source.groovy",
        shikiLanguageId: "groovy",
    },
    {
        aliases: ["hs"],
        isPrimaryLanguage: true,
        languageId: "haskell",
        loadModule: () => import("@shikijs/langs/haskell"),
        scopeName: "source.haskell",
        shikiLanguageId: "haskell",
    },
    {
        aliases: ["terraform", "tf", "tfvars"],
        isPrimaryLanguage: true,
        languageId: "hcl",
        loadModule: () => import("@shikijs/langs/hcl"),
        scopeName: "source.hcl",
        shikiLanguageId: "hcl",
    },
    {
        aliases: ["htm"],
        embeddedLanguages: {
            "source.css": "css",
            "source.js": "javascript",
        },
        isPrimaryLanguage: true,
        languageId: "html",
        loadModule: () => import("@shikijs/langs/html"),
        scopeName: "text.html.basic",
        shikiLanguageId: "html",
    },
    {
        aliases: ["rest"],
        embeddedLanguages: {
            "source.graphql": "graphql",
            "source.java": "java",
            "source.js": "javascript",
            "source.js.jsx": "jsx",
            "source.json": "json",
            "source.shell": "shell",
            "source.ts": "typescript",
            "source.tsx": "tsx",
            "text.xml": "xml",
        },
        isPrimaryLanguage: true,
        languageId: "http",
        loadModule: () => import("@shikijs/langs/http"),
        scopeName: "source.http",
        shikiLanguageId: "http",
    },
    {
        aliases: ["cfg", "conf", "dotenv", "env", "properties"],
        isPrimaryLanguage: true,
        languageId: "ini",
        loadModule: () => import("@shikijs/langs/ini"),
        scopeName: "source.ini",
        shikiLanguageId: "ini",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "java",
        loadModule: () => import("@shikijs/langs/java"),
        scopeName: "source.java",
        shikiLanguageId: "java",
    },
    {
        aliases: ["js", "node", "nodejs", "mjs", "cjs"],
        embeddedLanguages: {
            "meta.embedded.expression.js": "javascript",
            "meta.tag.attributes.js": "javascript",
            "meta.tag.js": "jsx-tags",
            "meta.tag.without-attributes.js": "jsx-tags",
        },
        isPrimaryLanguage: true,
        languageId: "javascript",
        loadModule: () => import("@shikijs/langs/javascript"),
        scopeName: "source.js",
        shikiLanguageId: "javascript",
        tokenTypes: javascriptTokenTypes,
    },
    {
        aliases: ["javascriptreact"],
        embeddedLanguages: {
            "meta.embedded.expression.js": "jsx",
            "meta.tag.attributes.js.jsx": "jsx",
            "meta.tag.js": "jsx-tags",
            "meta.tag.without-attributes.js": "jsx-tags",
        },
        isPrimaryLanguage: true,
        languageId: "jsx",
        loadModule: () => import("@shikijs/langs/jsx"),
        scopeName: "source.js.jsx",
        shikiLanguageId: "jsx",
        tokenTypes: javascriptTokenTypes,
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "json",
        loadModule: () => import("@shikijs/langs/json"),
        scopeName: "source.json",
        shikiLanguageId: "json",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "jsonc",
        loadModule: () => import("@shikijs/langs/jsonc"),
        scopeName: "source.json.comments",
        shikiLanguageId: "jsonc",
    },
    {
        aliases: ["jl"],
        embeddedLanguages: {
            "source.c": "c",
            "source.cpp": "cpp",
            "source.js": "javascript",
            "source.python": "python",
            "source.r": "r",
            "source.sql": "sql",
        },
        isPrimaryLanguage: true,
        languageId: "julia",
        loadModule: () => import("@shikijs/langs/julia"),
        scopeName: "source.julia",
        shikiLanguageId: "julia",
    },
    {
        aliases: ["kt", "kts"],
        isPrimaryLanguage: true,
        languageId: "kotlin",
        loadModule: () => import("@shikijs/langs/kotlin"),
        scopeName: "source.kotlin",
        shikiLanguageId: "kotlin",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "less",
        loadModule: () => import("@shikijs/langs/less"),
        scopeName: "source.css.less",
        shikiLanguageId: "less",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "log",
        loadModule: () => import("@shikijs/langs/log"),
        scopeName: "text.log",
        shikiLanguageId: "log",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.c": "c",
        },
        isPrimaryLanguage: true,
        languageId: "lua",
        loadModule: () => import("@shikijs/langs/lua"),
        scopeName: "source.lua",
        shikiLanguageId: "lua",
    },
    {
        aliases: ["make", "mk"],
        isPrimaryLanguage: true,
        languageId: "makefile",
        loadModule: () => import("@shikijs/langs/make"),
        scopeName: "source.makefile",
        shikiLanguageId: "make",
    },
    {
        aliases: ["md", "markdown", "mdown", "mkd"],
        embeddedLanguages: markdownEmbeddedLanguages,
        isPrimaryLanguage: true,
        languageId: "markdown",
        loadModule: loadMarkdownGrammarModule,
        scopeName: "text.html.markdown",
        shikiLanguageId: "markdown",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "mdx",
        loadModule: () => import("@shikijs/langs/mdx"),
        scopeName: "source.mdx",
        shikiLanguageId: "mdx",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.c": "c",
            "source.lua": "lua",
        },
        isPrimaryLanguage: true,
        languageId: "nginx",
        loadModule: () => import("@shikijs/langs/nginx"),
        scopeName: "source.nginx",
        shikiLanguageId: "nginx",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "markdown.nix.codeblock": "markdown",
        },
        isPrimaryLanguage: true,
        languageId: "nix",
        loadModule: () => import("@shikijs/langs/nix"),
        scopeName: "source.nix",
        shikiLanguageId: "nix",
    },
    {
        aliases: ["nushell"],
        isPrimaryLanguage: true,
        languageId: "nu",
        loadModule: () => import("@shikijs/langs/nu"),
        scopeName: "source.nushell",
        shikiLanguageId: "nu",
    },
    {
        aliases: ["objective-c", "objectivec"],
        isPrimaryLanguage: true,
        languageId: "objc",
        loadModule: () => import("@shikijs/langs/objc"),
        scopeName: "source.objc",
        shikiLanguageId: "objc",
    },
    {
        aliases: ["delphi"],
        isPrimaryLanguage: true,
        languageId: "pascal",
        loadModule: () => import("@shikijs/langs/pascal"),
        scopeName: "source.pascal",
        shikiLanguageId: "pascal",
    },
    {
        aliases: ["pl"],
        embeddedLanguages: {
            "source.css": "css",
            "source.java": "java",
            "source.js": "javascript",
            "source.sql": "sql",
            "text.html.basic": "html",
            "text.xml": "xml",
        },
        isPrimaryLanguage: true,
        languageId: "perl",
        loadModule: () => import("@shikijs/langs/perl"),
        scopeName: "source.perl",
        shikiLanguageId: "perl",
    },
    {
        aliases: ["php3", "php4", "php5", "phtml"],
        embeddedLanguages: {
            "source.css": "css",
            "source.java": "java",
            "source.js": "javascript",
            "source.json": "json",
            "source.sql": "sql",
            "text.html.basic": "html",
            "text.xml": "xml",
        },
        isPrimaryLanguage: true,
        languageId: "php",
        loadModule: () => import("@shikijs/langs/php"),
        scopeName: "source.php",
        shikiLanguageId: "php",
    },
    {
        aliases: ["ps", "ps1", "pwsh"],
        isPrimaryLanguage: true,
        languageId: "powershell",
        loadModule: () => import("@shikijs/langs/powershell"),
        scopeName: "source.powershell",
        shikiLanguageId: "powershell",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "prisma",
        loadModule: () => import("@shikijs/langs/prisma"),
        scopeName: "source.prisma",
        shikiLanguageId: "prisma",
    },
    {
        aliases: ["proto"],
        isPrimaryLanguage: true,
        languageId: "protobuf",
        loadModule: () => import("@shikijs/langs/protobuf"),
        scopeName: "source.proto",
        shikiLanguageId: "protobuf",
    },
    {
        aliases: ["py"],
        isPrimaryLanguage: true,
        languageId: "python",
        loadModule: () => import("@shikijs/langs/python"),
        scopeName: "source.python",
        shikiLanguageId: "python",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "r",
        loadModule: () => import("@shikijs/langs/r"),
        scopeName: "source.r",
        shikiLanguageId: "r",
    },
    {
        aliases: ["rb"],
        isPrimaryLanguage: true,
        languageId: "ruby",
        loadModule: () => import("@shikijs/langs/ruby"),
        scopeName: "source.ruby",
        shikiLanguageId: "ruby",
    },
    {
        aliases: ["rs"],
        isPrimaryLanguage: true,
        languageId: "rust",
        loadModule: () => import("@shikijs/langs/rust"),
        scopeName: "source.rust",
        shikiLanguageId: "rust",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "sass",
        loadModule: () => import("@shikijs/langs/sass"),
        scopeName: "source.sass",
        shikiLanguageId: "sass",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "scala",
        loadModule: () => import("@shikijs/langs/scala"),
        scopeName: "source.scala",
        shikiLanguageId: "scala",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.css": "css",
        },
        isPrimaryLanguage: true,
        languageId: "scss",
        loadModule: () => import("@shikijs/langs/scss"),
        scopeName: "source.css.scss",
        shikiLanguageId: "scss",
    },
    {
        aliases: ["bash", "sh", "shellscript", "zsh"],
        isPrimaryLanguage: true,
        languageId: "shell",
        loadModule: () => import("@shikijs/langs/shellscript"),
        scopeName: "source.shell",
        shikiLanguageId: "shellscript",
    },
    {
        aliases: ["sol"],
        isPrimaryLanguage: true,
        languageId: "solidity",
        loadModule: () => import("@shikijs/langs/solidity"),
        scopeName: "source.solidity",
        shikiLanguageId: "solidity",
    },
    {
        aliases: ["mariadb", "mssql", "mysql", "postgres", "postgresql", "psql", "sqlite", "sqlite3", "tsql"],
        isPrimaryLanguage: true,
        languageId: "sql",
        loadModule: () => import("@shikijs/langs/sql"),
        scopeName: "source.sql",
        shikiLanguageId: "sql",
    },
    {
        aliases: ["styl"],
        isPrimaryLanguage: true,
        languageId: "stylus",
        loadModule: () => import("@shikijs/langs/stylus"),
        scopeName: "source.stylus",
        shikiLanguageId: "stylus",
    },
    {
        aliases: [],
        embeddedLanguages: svelteEmbeddedLanguages,
        isPrimaryLanguage: true,
        languageId: "svelte",
        loadModule: () => import("@shikijs/langs/svelte"),
        scopeName: "source.svelte",
        shikiLanguageId: "svelte",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "swift",
        loadModule: () => import("@shikijs/langs/swift"),
        scopeName: "source.swift",
        shikiLanguageId: "swift",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "tcl",
        loadModule: () => import("@shikijs/langs/tcl"),
        scopeName: "source.tcl",
        shikiLanguageId: "tcl",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "toml",
        loadModule: () => import("@shikijs/langs/toml"),
        scopeName: "source.toml",
        shikiLanguageId: "toml",
    },
    {
        aliases: ["ts", "cts", "mts"],
        isPrimaryLanguage: true,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/typescript"),
        scopeName: "source.ts",
        shikiLanguageId: "typescript",
        tokenTypes: javascriptTokenTypes,
        unbalancedBracketScopes: typescriptUnbalancedBracketScopes,
    },
    {
        aliases: ["typescriptreact"],
        embeddedLanguages: {
            "meta.embedded.expression.tsx": "tsx",
            "meta.tag.attributes.tsx": "tsx",
            "meta.tag.tsx": "jsx-tags",
            "meta.tag.without-attributes.tsx": "jsx-tags",
        },
        isPrimaryLanguage: true,
        languageId: "tsx",
        loadModule: () => import("@shikijs/langs/tsx"),
        scopeName: "source.tsx",
        shikiLanguageId: "tsx",
        tokenTypes: javascriptTokenTypes,
        unbalancedBracketScopes: typescriptReactUnbalancedBracketScopes,
    },
    {
        aliases: ["vbnet"],
        isPrimaryLanguage: true,
        languageId: "vb",
        loadModule: () => import("@shikijs/langs/vb"),
        scopeName: "source.asp.vb.net",
        shikiLanguageId: "vb",
    },
    {
        aliases: [],
        embeddedLanguages: vueEmbeddedLanguages,
        isPrimaryLanguage: true,
        languageId: "vue",
        loadModule: () => import("@shikijs/langs/vue"),
        scopeName: "text.html.vue",
        shikiLanguageId: "vue",
    },
    {
        aliases: ["wasm", "wat"],
        isPrimaryLanguage: true,
        languageId: "wast",
        loadModule: () => import("@shikijs/langs/wasm"),
        scopeName: "source.wat",
        shikiLanguageId: "wasm",
    },
    {
        aliases: ["svg", "xhtml"],
        embeddedLanguages: {
            "source.java": "java",
        },
        isPrimaryLanguage: true,
        languageId: "xml",
        loadModule: () => import("@shikijs/langs/xml"),
        scopeName: "text.xml",
        shikiLanguageId: "xml",
    },
    {
        aliases: ["yml"],
        isPrimaryLanguage: true,
        languageId: "yaml",
        loadModule: () => import("@shikijs/langs/yaml"),
        scopeName: "source.yaml",
        shikiLanguageId: "yaml",
    },
    {
        aliases: [],
        isPrimaryLanguage: true,
        languageId: "zig",
        loadModule: () => import("@shikijs/langs/zig"),
        scopeName: "source.zig",
        shikiLanguageId: "zig",
    },
] as const satisfies readonly TextMateGrammarDefinition[];

export const TEXT_MATE_AUXILIARY_GRAMMAR_DEFINITIONS = [
    {
        aliases: [],
        embeddedLanguages: {
            "source.css": "css",
            "source.js": "javascript",
            "text.html.basic": "html",
        },
        isPrimaryLanguage: false,
        languageId: "html",
        loadModule: () => import("@shikijs/langs/vue"),
        scopeName: "text.html.derivative",
        shikiLanguageId: "vue",
    },
] as const satisfies readonly TextMateGrammarDefinition[];

export const TEXT_MATE_INJECTION_DEFINITIONS = [
    {
        aliases: [],
        injectTo: ["source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: loadJsdocInjectionModule,
        scopeName: "documentation.injection.ts",
        shikiLanguageId: "vscode-jsdoc-injections",
    },
    {
        aliases: [],
        injectTo: ["source.js", "source.js.jsx"],
        isPrimaryLanguage: false,
        languageId: "javascript",
        loadModule: loadJsdocInjectionModule,
        scopeName: "documentation.injection.js.jsx",
        shikiLanguageId: "vscode-jsdoc-injections",
    },
    {
        aliases: [],
        injectTo: ["source.rust"],
        isPrimaryLanguage: false,
        languageId: "rust",
        loadModule: loadRustInjectionModule,
        scopeName: "source.rust.comando-injections",
        shikiLanguageId: "comando-rust-injections",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "meta.embedded.block.css": "css",
            "source.css": "css",
            "source.js": "javascript",
            "source.ts": "typescript",
        },
        injectTo: ["source.js", "source.js.jsx", "source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/ts-tags"),
        scopeName: "inline.es6-css",
        shikiLanguageId: "ts-tags",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.glsl": "glsl",
        },
        injectTo: ["source.js", "source.js.jsx", "source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/ts-tags"),
        scopeName: "inline.es6-glsl",
        shikiLanguageId: "ts-tags",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.css": "css",
            "source.js": "javascript",
            "text.html.basic": "html",
        },
        injectTo: ["source.js", "source.js.jsx", "source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/ts-tags"),
        scopeName: "inline.es6-html",
        shikiLanguageId: "ts-tags",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "source.sql": "sql",
        },
        injectTo: ["source.js", "source.js.jsx", "source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/ts-tags"),
        scopeName: "inline.tagged-template-sql",
        shikiLanguageId: "ts-tags",
    },
    {
        aliases: [],
        embeddedLanguages: {
            "text.xml": "xml",
        },
        injectTo: ["source.js", "source.js.jsx", "source.ts", "source.tsx"],
        isPrimaryLanguage: false,
        languageId: "typescript",
        loadModule: () => import("@shikijs/langs/ts-tags"),
        scopeName: "inline.es6-xml",
        shikiLanguageId: "ts-tags",
    },
] as const satisfies readonly TextMateGrammarDefinition[];

export const TEXT_MATE_GRAMMAR_DEFINITIONS = [
    ...TEXT_MATE_LANGUAGE_DEFINITIONS,
    ...TEXT_MATE_AUXILIARY_GRAMMAR_DEFINITIONS,
    ...TEXT_MATE_INJECTION_DEFINITIONS,
] as const satisfies readonly TextMateGrammarDefinition[];
