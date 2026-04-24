import { resolveEditorLanguage } from "@shared/editor-language";

import { CatppuccinIcon } from "./CatppuccinIcon";
import {
    resolveAvailableCatppuccinIcon,
    type CatppuccinIconName,
} from "./catppuccin-icons";

export interface ResolvedFileTypeIcon {
    readonly iconName: CatppuccinIconName;
}

const SPECIAL_FILENAMES = new Map<string, CatppuccinIconName>([
    ["package.json", "package-json"],
    ["package-lock.json", "npm-lock"],
    ["npm-shrinkwrap.json", "npm-lock"],
    ["pnpm-lock.yaml", "pnpm-lock"],
    ["yarn.lock", "yarn-lock"],
    ["bun.lock", "bun-lock"],
    ["bun.lockb", "bun-lock"],
    ["cargo.lock", "cargo-lock"],
    ["poetry.lock", "poetry-lock"],
    [".gitignore", "git"],
    [".gitattributes", "git"],
    [".gitmodules", "git"],
    [".editorconfig", "editorconfig"],
]);

const IMAGE_EXTENSIONS = new Set([
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tiff",
    "webp",
]);

const LANGUAGE_TO_ICON: Record<string, CatppuccinIconName> = {
    astro: "astro",
    bat: "batch",
    c: "c",
    clojure: "clojure",
    cmake: "cmake",
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    csv: "csv",
    dart: "dart",
    diff: "diff",
    dockerfile: "docker",
    elixir: "elixir",
    erlang: "erlang",
    go: "go",
    graphql: "graphql",
    haskell: "haskell",
    hcl: "terraform",
    html: "html",
    http: "http",
    ini: "config",
    java: "java",
    javascript: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript-react",
    julia: "julia",
    kotlin: "kotlin",
    less: "less",
    log: "log",
    lua: "lua",
    makefile: "makefile",
    markdown: "markdown",
    mdx: "markdown-mdx",
    nginx: "nginx",
    nix: "nix",
    perl: "perl",
    php: "php",
    powershell: "powershell",
    prisma: "prisma",
    protobuf: "proto",
    python: "python",
    r: "r",
    ruby: "ruby",
    rust: "rust",
    sass: "sass",
    scala: "scala",
    scss: "sass",
    shell: "bash",
    solidity: "solidity",
    sql: "database",
    svelte: "svelte",
    swift: "swift",
    toml: "toml",
    tsx: "typescript-react",
    typescript: "typescript",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    zig: "zig",
};

const EXTENSION_TO_ICON: Record<string, CatppuccinIconName> = {
    dockerignore: "docker",
    env: "env",
    lock: "lock",
};

function getBaseFileName(fileName: string): string {
    const normalizedPath = fileName.replaceAll("\\", "/");
    return normalizedPath.split("/").at(-1) ?? fileName;
}

function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return "";
    return fileName.slice(dot + 1).toLowerCase();
}

function getPatternIcon(fileName: string): CatppuccinIconName | null {
    if (fileName.startsWith(".env")) {
        return "env";
    }

    if (fileName.startsWith("tsconfig") && fileName.endsWith(".json")) {
        return "typescript-config";
    }

    if (fileName.startsWith("vite.config.")) {
        return "vite";
    }

    if (fileName.startsWith("vitest.config.")) {
        return "vitest";
    }

    if (fileName.startsWith("eslint.config.")) {
        return "eslint";
    }

    if (
        fileName.startsWith("prettier.config.") ||
        fileName.startsWith(".prettierrc")
    ) {
        return "prettier";
    }

    if (fileName.startsWith("tailwind.config.")) {
        return "tailwind";
    }

    if (fileName.startsWith("postcss.config.")) {
        return "postcss";
    }

    if (fileName.startsWith("webpack.config.")) {
        return "webpack";
    }

    if (fileName.startsWith("rollup.config.")) {
        return "rollup";
    }

    if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) {
        return "docker";
    }

    return null;
}

export function resolveCatppuccinFileIcon(
    fileName: string,
): ResolvedFileTypeIcon {
    const baseFileName = getBaseFileName(fileName).toLowerCase();
    const specialIcon = SPECIAL_FILENAMES.get(baseFileName);

    if (specialIcon) {
        return {
            iconName: resolveAvailableCatppuccinIcon(specialIcon),
        };
    }

    const patternIcon = getPatternIcon(baseFileName);
    if (patternIcon) {
        return {
            iconName: resolveAvailableCatppuccinIcon(patternIcon),
        };
    }

    const extension = getExtension(baseFileName);
    if (IMAGE_EXTENSIONS.has(extension)) {
        return { iconName: "image" };
    }

    const resolvedLanguage = resolveEditorLanguage({ filePath: fileName });
    const languageIcon = LANGUAGE_TO_ICON[resolvedLanguage.id];

    if (languageIcon) {
        return {
            iconName: resolveAvailableCatppuccinIcon(languageIcon),
        };
    }

    const extensionIcon = EXTENSION_TO_ICON[extension];
    if (extensionIcon) {
        return {
            iconName: resolveAvailableCatppuccinIcon(extensionIcon),
        };
    }

    return { iconName: "file" };
}

export const resolveFileTypeIcon = resolveCatppuccinFileIcon;

export function FileTypeIcon({
    className,
    fileName,
    opacity = 0.86,
    scaled = false,
    size = 13,
}: {
    readonly className?: string;
    readonly color?: string;
    readonly fileName: string;
    readonly opacity?: number;
    readonly scaled?: boolean;
    readonly size?: number;
}) {
    const { iconName } = resolveCatppuccinFileIcon(fileName);

    return (
        <CatppuccinIcon
            className={className}
            iconName={iconName}
            opacity={opacity}
            scaled={scaled}
            size={size}
        />
    );
}
