const DEFAULT_EDITOR_LANGUAGE = {
    id: "plaintext",
    label: "Plain Text",
};
const EDITOR_LANGUAGES = [
    {
        extensions: ["ts", "mts", "cts"],
        id: "typescript",
        interpreters: ["ts-node", "tsx"],
        label: "TypeScript",
    },
    {
        extensions: ["js", "mjs", "cjs"],
        id: "javascript",
        interpreters: ["bun", "deno", "node", "nodejs"],
        label: "JavaScript",
    },
    {
        extensions: ["json", "jsonc"],
        id: "json",
        label: "JSON",
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
        extensions: ["sh", "bash", "zsh", "ksh"],
        filenames: [
            ".bash_profile",
            ".bashrc",
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
        extensions: ["swift"],
        id: "swift",
        label: "Swift",
    },
];
const extensionIndex = new Map();
const filenameIndex = new Map();
const interpreterIndex = new Map();
const wrappedLanguageIds = new Set();
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
export function resolveEditorLanguage(options) {
    const fileName = getFileName(options.filePath).toLowerCase();
    const byFilename = filenameIndex.get(fileName);
    if (byFilename) {
        return toResolvedLanguage(byFilename);
    }
    const extension = getExtension(fileName);
    const byExtension = extension ? extensionIndex.get(extension) : undefined;
    if (byExtension) {
        return toResolvedLanguage(byExtension);
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
export function shouldWrapEditorLanguage(languageId) {
    return wrappedLanguageIds.has(languageId.toLowerCase());
}
function toResolvedLanguage(language) {
    return {
        id: language.id,
        label: language.label,
    };
}
function getFileName(filePath) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    return normalizedPath.split("/").at(-1) ?? filePath;
}
function getExtension(fileName) {
    const extension = fileName.split(".").at(-1);
    if (!extension || extension === fileName) {
        return "";
    }
    return extension.toLowerCase();
}
function extractInterpreter(probeContent) {
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
function normalizeInterpreter(value) {
    if (!value) {
        return null;
    }
    return value.split("/").at(-1)?.toLowerCase() ?? null;
}
function findLanguageByInterpreter(interpreter) {
    if (interpreterIndex.has(interpreter)) {
        return interpreterIndex.get(interpreter) ?? null;
    }
    if (interpreter.startsWith("python")) {
        return interpreterIndex.get("python") ?? null;
    }
    return null;
}
