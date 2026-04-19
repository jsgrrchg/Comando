import type * as monaco from "monaco-editor";

const SHELL_KEYWORDS = [
    "if",
    "then",
    "do",
    "else",
    "elif",
    "while",
    "until",
    "for",
    "in",
    "case",
    "esac",
    "fi",
    "done",
    "function",
    "export",
    "set",
    "select",
    "time",
    "coproc",
    "unset",
] as const;

const SHELL_BUILTINS = [
    "alias",
    "awk",
    "bash",
    "bg",
    "bun",
    "bunx",
    "builtin",
    "cargo",
    "cat",
    "cd",
    "chmod",
    "chown",
    "clear",
    "cp",
    "curl",
    "deno",
    "diff",
    "docker",
    "docker-compose",
    "echo",
    "env",
    "exec",
    "exit",
    "fd",
    "fg",
    "find",
    "fish",
    "git",
    "gh",
    "go",
    "grep",
    "hg",
    "just",
    "kill",
    "kubectl",
    "ln",
    "ls",
    "make",
    "mkdir",
    "mv",
    "nc",
    "node",
    "nohup",
    "npm",
    "npx",
    "openssl",
    "pbcopy",
    "pbpaste",
    "pip",
    "pip3",
    "poetry",
    "pnpm",
    "pnpx",
    "popd",
    "printenv",
    "pushd",
    "pwd",
    "python",
    "python3",
    "pytest",
    "read",
    "rg",
    "rm",
    "rmdir",
    "rsync",
    "rustc",
    "rustup",
    "sed",
    "sh",
    "shift",
    "sleep",
    "source",
    "ssh",
    "sudo",
    "tail",
    "tee",
    "test",
    "touch",
    "trap",
    "turbo",
    "type",
    "typeset",
    "ulimit",
    "unalias",
    "uv",
    "vite",
    "wait",
    "which",
    "xargs",
    "yarn",
    "yarnpkg",
    "zsh",
] as const;

const SHELL_SUBCOMMANDS = [
    "add",
    "build",
    "check",
    "clean",
    "clone",
    "commit",
    "compose",
    "create",
    "deploy",
    "dev",
    "diff",
    "down",
    "exec",
    "fetch",
    "format",
    "generate",
    "init",
    "install",
    "lint",
    "link",
    "login",
    "logout",
    "migrate",
    "outdated",
    "preview",
    "publish",
    "pull",
    "push",
    "remove",
    "run",
    "serve",
    "start",
    "status",
    "stop",
    "sync",
    "test",
    "typecheck",
    "unlink",
    "up",
    "update",
    "why",
    "workspace",
    "workspaces",
] as const;

const SHELL_OPTION_REGEX =
    /(?:-{1,2}[A-Za-z0-9][\w-]*)(?:=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'`|&;(){}\[\]]+))?/;
const SHELL_PATH_REGEX =
    /(?:~\/|\.\.\/|\.\/|\/|[A-Za-z0-9._-]+\/)[^\s"'`|&;(){}\[\]]*/;
const SHELL_ASSIGNMENT_REGEX =
    /\b[A-Za-z_][\w]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"'`|&;(){}\[\]]+)/;

const shellKeywordSet = new Set<string>(SHELL_KEYWORDS);
const shellBuiltinSet = new Set<string>(SHELL_BUILTINS);
const shellSubcommandSet = new Set<string>(SHELL_SUBCOMMANDS);

export function classifyShellWord(
    value: string,
): "builtin" | "identifier" | "keyword" | "subcommand" {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return "identifier";
    }
    if (shellKeywordSet.has(normalized)) {
        return "keyword";
    }
    if (shellBuiltinSet.has(normalized)) {
        return "builtin";
    }
    if (shellSubcommandSet.has(normalized)) {
        return "subcommand";
    }
    return "identifier";
}

export function isLikelyShellPathToken(value: string): boolean {
    return SHELL_PATH_REGEX.test(value.trim());
}

export const shellLanguageConfiguration: monaco.languages.LanguageConfiguration =
    {
        autoClosingPairs: [
            { open: "{", close: "}" },
            { open: "[", close: "]" },
            { open: "(", close: ")" },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
            { open: "`", close: "`" },
        ],
        brackets: [
            ["{", "}"],
            ["[", "]"],
            ["(", ")"],
        ],
        comments: {
            lineComment: "#",
        },
        surroundingPairs: [
            { open: "{", close: "}" },
            { open: "[", close: "]" },
            { open: "(", close: ")" },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
            { open: "`", close: "`" },
        ],
    };

export const shellMonarchDefinition: monaco.languages.IMonarchLanguage = {
    assignment: SHELL_ASSIGNMENT_REGEX,
    brackets: [
        { close: "}", open: "{", token: "delimiter.bracket" },
        { close: ")", open: "(", token: "delimiter.parenthesis" },
        { close: "]", open: "[", token: "delimiter.square" },
    ],
    builtins: [...SHELL_BUILTINS],
    defaultToken: "",
    ignoreCase: true,
    keywords: [...SHELL_KEYWORDS],
    option: SHELL_OPTION_REGEX,
    pathToken: SHELL_PATH_REGEX,
    subcommands: [...SHELL_SUBCOMMANDS],
    tokenPostfix: ".shell",
    tokenizer: {
        root: [
            [/(^#!.*$)/, "metatag"],
            [/(^\s*#.*$)/, "comment"],
            [/\s+/, "white"],
            [/@assignment/, "variable.other.member"],
            [/@option/, "attribute.name"],
            [/@pathToken/, "string"],
            [/\$[A-Za-z_][\w]*/, "variable"],
            [/\$\{[^}\n]+\}/, "variable"],
            [/\$\d+/, "variable.predefined"],
            [/\$[*@#?\-$!0_]/, "variable.predefined"],
            [/\$\(/, { next: "@commandSubstitution", token: "variable" }],
            [/"/, { next: "@doubleQuotedString", token: "string" }],
            [/'/, { next: "@singleQuotedString", token: "string" }],
            [/`/, { next: "@backtickString", token: "string" }],
            [/\b\d+(?:\.\d+)?\b/, "number"],
            [
                /[A-Za-z_][\w:@-]*/,
                {
                    cases: {
                        "@keywords": "keyword",
                        "@builtins": "support.function.builtin",
                        "@subcommands": "keyword.other",
                        "@default": "identifier",
                    },
                },
            ],
            [/[{}[\]()]/, "@brackets"],
            [/&&|\|\||\||;|&/, "delimiter"],
            [/<<-?|>>?|[<>]=?|=|!/, "operator"],
            [/[,.:]/, "delimiter"],
            [/\\./, "constant.character.escape"],
        ],
        backtickString: [
            [/`/, { next: "@pop", token: "string" }],
            [/\\./, "constant.character.escape"],
            [/[^\\`$]+/, "string"],
            [/\$[A-Za-z_][\w]*/, "variable"],
            [/\$\{[^}\n]+\}/, "variable"],
        ],
        commandSubstitution: [
            [/\)/, { next: "@pop", token: "variable" }],
            { include: "@root" },
        ],
        doubleQuotedString: [
            [/"/, { next: "@pop", token: "string" }],
            [/\\./, "constant.character.escape"],
            [/\$[A-Za-z_][\w]*/, "variable"],
            [/\$\{[^}\n]+\}/, "variable"],
            [/[^\\"$]+/, "string"],
            [/[$]/, "string"],
        ],
        singleQuotedString: [
            [/'/, { next: "@pop", token: "string" }],
            [/[^']+/, "string"],
        ],
    },
};
