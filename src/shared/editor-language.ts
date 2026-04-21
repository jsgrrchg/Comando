export interface ResolvedEditorLanguage {
    readonly id: string;
    readonly label: string;
}

interface EditorLanguageDefinition extends ResolvedEditorLanguage {
    readonly extensions?: readonly string[];
    readonly filenames?: readonly string[];
    readonly interpreters?: readonly string[];
    readonly shouldWrap?: boolean;
}

const DEFAULT_EDITOR_LANGUAGE: ResolvedEditorLanguage = {
    id: "plaintext",
    label: "Plain Text",
};

const EDITOR_LANGUAGES: readonly EditorLanguageDefinition[] = [
    {
        extensions: ["tsx"],
        id: "tsx",
        label: "TSX",
    },
    {
        extensions: ["ts", "mts", "cts"],
        id: "typescript",
        interpreters: ["ts-node", "tsx"],
        label: "TypeScript",
    },
    {
        extensions: ["jsx"],
        id: "jsx",
        label: "JSX",
    },
    {
        extensions: ["js", "mjs", "cjs"],
        id: "javascript",
        interpreters: ["bun", "deno", "node", "nodejs"],
        label: "JavaScript",
    },
    {
        extensions: ["json"],
        id: "json",
        label: "JSON",
    },
    {
        extensions: ["jsonc"],
        id: "jsonc",
        label: "JSONC",
    },
    {
        extensions: ["md", "markdown", "mdown", "mkd"],
        id: "markdown",
        label: "Markdown",
        shouldWrap: true,
    },
    {
        extensions: ["mdx"],
        id: "mdx",
        label: "MDX",
        shouldWrap: true,
    },
    {
        extensions: ["html", "htm", "xhtml"],
        id: "html",
        label: "HTML",
    },
    {
        extensions: ["css"],
        id: "css",
        label: "CSS",
    },
    {
        extensions: ["scss"],
        id: "scss",
        label: "SCSS",
    },
    {
        extensions: ["less"],
        id: "less",
        label: "Less",
    },
    {
        extensions: ["xml", "svg"],
        id: "xml",
        label: "XML",
    },
    {
        extensions: ["yaml", "yml"],
        id: "yaml",
        label: "YAML",
    },
    {
        extensions: ["sh", "bash", "zsh", "ksh", "env"],
        filenames: [
            ".bash_profile",
            ".bashrc",
            ".env",
            ".envrc",
            ".profile",
            ".zprofile",
            ".zshrc",
        ],
        id: "shell",
        interpreters: ["bash", "fish", "ksh", "sh", "zsh"],
        label: "Shell",
    },
    {
        extensions: ["py", "pyw", "rpy"],
        id: "python",
        interpreters: ["python", "python2", "python3", "pythonw"],
        label: "Python",
    },
    {
        extensions: ["go"],
        id: "go",
        label: "Go",
    },
    {
        extensions: ["rs"],
        id: "rust",
        label: "Rust",
    },
    {
        extensions: ["java"],
        id: "java",
        label: "Java",
    },
    {
        extensions: ["kt", "kts"],
        id: "kotlin",
        label: "Kotlin",
    },
    {
        extensions: ["php", "phtml"],
        id: "php",
        interpreters: ["php"],
        label: "PHP",
    },
    {
        extensions: ["rb", "gemspec"],
        filenames: ["appfile", "fastfile", "gemfile", "podfile", "rakefile"],
        id: "ruby",
        interpreters: ["ruby"],
        label: "Ruby",
    },
    {
        extensions: ["sql"],
        id: "sql",
        label: "SQL",
    },
    {
        extensions: ["graphql", "gql"],
        id: "graphql",
        label: "GraphQL",
    },
    {
        extensions: ["hcl", "tf", "tfvars"],
        id: "hcl",
        label: "HCL / Terraform",
    },
    {
        extensions: ["toml"],
        id: "toml",
        label: "TOML",
    },
    {
        extensions: ["dockerfile"],
        filenames: ["dockerfile"],
        id: "dockerfile",
        label: "Dockerfile",
    },
    {
        extensions: ["ini"],
        filenames: [".editorconfig"],
        id: "ini",
        label: "INI",
    },
    {
        extensions: ["lua"],
        id: "lua",
        label: "Lua",
    },
    {
        extensions: ["c", "h"],
        id: "c",
        label: "C",
    },
    {
        extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
        id: "cpp",
        label: "C++",
    },
    {
        extensions: ["cs"],
        id: "csharp",
        label: "C#",
    },
    {
        extensions: ["astro"],
        id: "astro",
        label: "Astro",
    },
    {
        extensions: ["prisma"],
        id: "prisma",
        label: "Prisma",
    },
    {
        extensions: ["swift"],
        id: "swift",
        label: "Swift",
    },
    {
        extensions: ["scala"],
        id: "scala",
        label: "Scala",
    },
    {
        extensions: ["cmake"],
        filenames: ["cmakelists.txt"],
        id: "cmake",
        label: "CMake",
    },
    {
        extensions: ["diff", "patch"],
        id: "diff",
        label: "Diff",
    },
    {
        extensions: ["clj", "cljs", "cljc"],
        id: "clojure",
        label: "Clojure",
    },
    {
        extensions: ["erl", "hrl"],
        id: "erlang",
        label: "Erlang",
    },
    {
        extensions: ["ex", "exs"],
        id: "elixir",
        label: "Elixir",
    },
    {
        extensions: ["groovy", "gradle"],
        id: "groovy",
        label: "Groovy",
    },
    {
        extensions: ["hs"],
        id: "haskell",
        label: "Haskell",
    },
    {
        extensions: ["jl"],
        id: "julia",
        label: "Julia",
    },
    {
        extensions: ["mk"],
        filenames: ["gnumakefile", "makefile"],
        id: "makefile",
        label: "Makefile",
    },
    {
        extensions: ["pas", "pp"],
        id: "pascal",
        label: "Pascal",
    },
    {
        extensions: ["pl", "pm"],
        id: "perl",
        label: "Perl",
    },
    {
        extensions: ["ps1", "psd1", "psm1", "ps"],
        id: "powershell",
        interpreters: ["powershell", "pwsh"],
        label: "PowerShell",
    },
    {
        extensions: ["proto"],
        id: "protobuf",
        label: "Protocol Buffers",
    },
    {
        extensions: ["r"],
        id: "r",
        label: "R",
    },
    {
        extensions: ["sass"],
        id: "sass",
        label: "Sass",
    },
    {
        extensions: ["styl", "stylus"],
        id: "stylus",
        label: "Stylus",
    },
    {
        extensions: ["svelte"],
        id: "svelte",
        label: "Svelte",
    },
    {
        extensions: ["tcl"],
        id: "tcl",
        label: "Tcl",
    },
    {
        extensions: ["vb", "vbs"],
        id: "vb",
        label: "Visual Basic",
    },
    {
        extensions: ["wat", "wasm", "wast"],
        id: "wast",
        label: "WebAssembly",
    },
    {
        extensions: ["d"],
        id: "d",
        label: "D",
    },
    {
        extensions: ["vue"],
        id: "vue",
        label: "Vue",
    },
    {
        extensions: ["dart"],
        id: "dart",
        label: "Dart",
    },
    {
        extensions: ["nix"],
        filenames: ["flake.nix"],
        id: "nix",
        label: "Nix",
    },
    {
        extensions: ["zig"],
        id: "zig",
        label: "Zig",
    },
    {
        extensions: ["m", "mm"],
        id: "objc",
        label: "Objective-C",
    },
    {
        extensions: ["bat"],
        id: "bat",
        label: "Batch",
    },
    {
        extensions: ["cmd"],
        id: "cmd",
        label: "Windows Command",
    },
    {
        extensions: ["fish"],
        id: "fish",
        interpreters: ["fish"],
        label: "Fish",
    },
    {
        extensions: ["nu"],
        id: "nu",
        interpreters: ["nu"],
        label: "Nushell",
    },
    {
        extensions: ["sol"],
        id: "solidity",
        label: "Solidity",
    },
    {
        extensions: ["nginx"],
        filenames: ["nginx.conf"],
        id: "nginx",
        label: "Nginx",
    },
    {
        extensions: ["http", "rest"],
        id: "http",
        label: "HTTP",
    },
    {
        extensions: ["csv", "tsv"],
        id: "csv",
        label: "CSV",
    },
    {
        extensions: ["log"],
        id: "log",
        label: "Log",
    },
];

const EDITOR_LANGUAGE_IDS: readonly string[] = [
    DEFAULT_EDITOR_LANGUAGE.id,
    ...EDITOR_LANGUAGES.map((language) => language.id),
];

const extensionIndex = new Map<string, EditorLanguageDefinition>();
const filenameIndex = new Map<string, EditorLanguageDefinition>();
const interpreterIndex = new Map<string, EditorLanguageDefinition>();
const wrappedLanguageIds = new Set<string>();

for (const language of EDITOR_LANGUAGES) {
    if (language.shouldWrap) {
        wrappedLanguageIds.add(language.id);
    }

    for (const extension of language.extensions ?? []) {
        extensionIndex.set(extension.toLowerCase(), language);
    }

    for (const filename of language.filenames ?? []) {
        filenameIndex.set(filename.toLowerCase(), language);
    }

    for (const interpreter of language.interpreters ?? []) {
        interpreterIndex.set(interpreter.toLowerCase(), language);
    }
}

export function resolveEditorLanguage(options: {
    readonly filePath: string;
    readonly probeContent?: string;
}): ResolvedEditorLanguage {
    const fileName = getFileName(options.filePath).toLowerCase();
    const byFilename = filenameIndex.get(fileName);

    if (byFilename) {
        return toResolvedLanguage(byFilename);
    }

    // Composite filenames like `Dockerfile.dev` / `Makefile.common`: probe the
    // first non-empty segment against the filename index before falling back
    // to extension matching.
    const firstNonEmptySegment = getFirstNonEmptySegment(fileName);
    if (firstNonEmptySegment && firstNonEmptySegment !== fileName) {
        const byPrefix = filenameIndex.get(firstNonEmptySegment);
        if (byPrefix) {
            return toResolvedLanguage(byPrefix);
        }
    }

    // Try progressively shorter suffixes so composite extensions like
    // `schema.prisma`, `.env.local` or `foo.test.ts` can match entries
    // registered for either the long or the short suffix.
    for (const candidate of getExtensionCandidates(fileName)) {
        const byExtension = extensionIndex.get(candidate);
        if (byExtension) {
            return toResolvedLanguage(byExtension);
        }
    }

    const interpreter = extractInterpreter(options.probeContent ?? "");
    if (interpreter) {
        const byInterpreter = findLanguageByInterpreter(interpreter);
        if (byInterpreter) {
            return toResolvedLanguage(byInterpreter);
        }
    }

    return DEFAULT_EDITOR_LANGUAGE;
}

export function shouldWrapEditorLanguage(languageId: string): boolean {
    return wrappedLanguageIds.has(languageId.toLowerCase());
}

export function getEditorLanguageIds(): readonly string[] {
    return EDITOR_LANGUAGE_IDS;
}

function toResolvedLanguage(
    language: EditorLanguageDefinition,
): ResolvedEditorLanguage {
    return {
        id: language.id,
        label: language.label,
    };
}

function getFileName(filePath: string): string {
    const normalizedPath = filePath.replaceAll("\\", "/");
    return normalizedPath.split("/").at(-1) ?? filePath;
}

function getExtensionCandidates(fileName: string): string[] {
    const parts = fileName.split(".");
    if (parts.length < 2) {
        return [];
    }
    const candidates: string[] = [];
    // Longest-first: `file.test.ts` → ["test.ts", "ts"].
    for (let i = 1; i < parts.length; i += 1) {
        const suffix = parts.slice(i).join(".").toLowerCase();
        if (suffix) {
            candidates.push(suffix);
        }
    }
    // Dotfiles like `.env.local`: also probe the first non-empty segment
    // (`env`) so language tables that only register the short name still
    // match. Appended last so a more specific suffix wins if ever registered.
    if (parts[0] === "" && parts[1]) {
        const firstSegment = parts[1].toLowerCase();
        if (firstSegment && !candidates.includes(firstSegment)) {
            candidates.push(firstSegment);
        }
    }
    return candidates;
}

function getFirstNonEmptySegment(fileName: string): string {
    for (const segment of fileName.split(".")) {
        const trimmed = segment.toLowerCase();
        if (trimmed) {
            return trimmed;
        }
    }
    return "";
}

function extractInterpreter(probeContent: string): string | null {
    const firstLine = probeContent.split(/\r?\n/, 1)[0]?.trim() ?? "";

    if (!firstLine.startsWith("#!")) {
        return null;
    }

    const command = firstLine.slice(2).trim();
    if (!command) {
        return null;
    }

    const commandParts = command.split(/\s+/).filter(Boolean);
    if (commandParts.length === 0) {
        return null;
    }

    if (commandParts[0]?.endsWith("/env")) {
        const interpreter = commandParts
            .slice(1)
            .find((part) => !part.startsWith("-"));

        return normalizeInterpreter(interpreter ?? null);
    }

    return normalizeInterpreter(commandParts[0] ?? null);
}

function normalizeInterpreter(value: string | null): string | null {
    if (!value) {
        return null;
    }

    return value.split("/").at(-1)?.toLowerCase() ?? null;
}

function findLanguageByInterpreter(
    interpreter: string,
): EditorLanguageDefinition | null {
    if (interpreterIndex.has(interpreter)) {
        return interpreterIndex.get(interpreter) ?? null;
    }

    if (interpreter.startsWith("python")) {
        return interpreterIndex.get("python") ?? null;
    }

    return null;
}
