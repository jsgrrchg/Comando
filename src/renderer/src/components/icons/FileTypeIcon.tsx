import { resolveEditorLanguage } from "@shared/editor-language";
import { LANGUAGE_COLORS } from "@renderer/components/workspace/LanguageIcon";

/* ─── Types ─── */

type FileTypeIconId =
    | "astro"
    | "clang"
    | "config"
    | "css"
    | "dart"
    | "document"
    | "elixir"
    | "gitfile"
    | "go"
    | "graphql"
    | "haskell"
    | "hcl"
    | "html"
    | "image"
    | "java"
    | "javascript"
    | "json"
    | "kotlin"
    | "lockfile"
    | "lua"
    | "markdown"
    | "nix"
    | "package"
    | "php"
    | "prisma"
    | "python"
    | "ruby"
    | "rust"
    | "shell"
    | "solidity"
    | "sql"
    | "svelte"
    | "swift"
    | "typescript"
    | "vue"
    | "yaml"
    | "zig";

interface ResolvedIcon {
    readonly iconId: FileTypeIconId;
    readonly color: string;
}

/* ─── Special filenames (exact match, lowercase) ─── */

const SPECIAL_FILENAMES = new Map<string, ResolvedIcon>([
    [
        "package.json",
        { iconId: "package", color: "var(--color-text-secondary)" },
    ],
    [
        "package-lock.json",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    ["yarn.lock", { iconId: "lockfile", color: "var(--color-text-secondary)" }],
    [
        "pnpm-lock.yaml",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    ["bun.lockb", { iconId: "lockfile", color: "var(--color-text-secondary)" }],
    ["bun.lock", { iconId: "lockfile", color: "var(--color-text-secondary)" }],
    [
        "cargo.lock",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    [
        "gemfile.lock",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    [
        "composer.lock",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    [
        "poetry.lock",
        { iconId: "lockfile", color: "var(--color-text-secondary)" },
    ],
    [".gitignore", { iconId: "gitfile", color: "var(--color-text-secondary)" }],
    [
        ".gitattributes",
        { iconId: "gitfile", color: "var(--color-text-secondary)" },
    ],
    [
        ".gitmodules",
        { iconId: "gitfile", color: "var(--color-text-secondary)" },
    ],
    [
        ".editorconfig",
        { iconId: "config", color: LANGUAGE_COLORS["dockerfile"] ?? "#384d54" },
    ],
]);

const IMAGE_EXTENSIONS = new Set([
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

const LANGUAGE_TO_ICON: Record<string, FileTypeIconId> = {
    astro: "astro",
    c: "clang",
    clojure: "document",
    cmake: "config",
    cpp: "clang",
    csharp: "clang",
    css: "css",
    d: "clang",
    dart: "dart",
    diff: "document",
    dockerfile: "config",
    elixir: "elixir",
    erlang: "document",
    go: "go",
    graphql: "graphql",
    groovy: "java",
    haskell: "haskell",
    hcl: "hcl",
    html: "html",
    ini: "config",
    java: "java",
    javascript: "javascript",
    jsx: "javascript",
    json: "json",
    jsonc: "json",
    julia: "document",
    kotlin: "kotlin",
    less: "css",
    lua: "lua",
    makefile: "config",
    markdown: "markdown",
    mdx: "markdown",
    nix: "nix",
    pascal: "document",
    perl: "document",
    php: "php",
    powershell: "shell",
    prisma: "prisma",
    protobuf: "config",
    python: "python",
    r: "document",
    ruby: "ruby",
    rust: "rust",
    sass: "css",
    scala: "java",
    scss: "css",
    shell: "shell",
    solidity: "solidity",
    sql: "sql",
    stylus: "css",
    svelte: "svelte",
    swift: "swift",
    tcl: "document",
    toml: "config",
    typescript: "typescript",
    tsx: "typescript",
    vb: "document",
    vue: "vue",
    wast: "document",
    xml: "html",
    yaml: "yaml",
    zig: "zig",
};

/* ─── Resolution ─── */

function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return "";
    return fileName.slice(dot + 1).toLowerCase();
}

export function resolveFileTypeIcon(fileName: string): ResolvedIcon {
    const lower = fileName.toLowerCase();

    const special = SPECIAL_FILENAMES.get(lower);
    if (special) return special;

    if (lower.startsWith(".env")) {
        return {
            iconId: "config",
            color: LANGUAGE_COLORS["dockerfile"] ?? "#384d54",
        };
    }

    if (lower.startsWith("tsconfig") && lower.endsWith(".json")) {
        return {
            iconId: "typescript",
            color: LANGUAGE_COLORS["typescript"] ?? "currentColor",
        };
    }

    const ext = getExtension(lower);

    if (IMAGE_EXTENSIONS.has(ext)) {
        return { iconId: "image", color: "var(--color-text-secondary)" };
    }

    const resolved = resolveEditorLanguage({ filePath: fileName });
    if (resolved.id !== "plaintext") {
        const iconId = LANGUAGE_TO_ICON[resolved.id] ?? "document";
        const color = LANGUAGE_COLORS[resolved.id] ?? "currentColor";
        return { iconId, color };
    }

    return { iconId: "document", color: "currentColor" };
}

/* ─── Helpers ─── */

function scalePx(value: number): string {
    return `calc(${value}px * var(--file-tree-scale, 1))`;
}

interface SvgShellProps {
    readonly color: string;
    readonly size: number;
    readonly scaled: boolean;
    readonly opacity: number;
    readonly className?: string;
    readonly children: React.ReactNode;
}

function SvgShell({
    color,
    size,
    scaled,
    opacity,
    className,
    children,
}: SvgShellProps) {
    const dim = scaled ? scalePx(size) : `${size}px`;
    return (
        <svg
            className={className}
            fill="none"
            height={dim}
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, opacity }}
            viewBox="0 0 16 16"
            width={dim}
            xmlns="http://www.w3.org/2000/svg"
        >
            {children}
        </svg>
    );
}

/* ─── Icon SVGs ─── */

function TypeScriptIcon() {
    return (
        <>
            <path d="M3.5 4 6 8l-2.5 4" strokeWidth="1" />
            <path d="M12.5 4 10 8l2.5 4" strokeWidth="1" />
            <path d="M6.5 7h3" strokeWidth="0.8" />
        </>
    );
}

function JavaScriptIcon() {
    return (
        <>
            <path d="M4 4v5a3 3 0 0 0 3 3" strokeWidth="1" />
            <path
                d="M9 4h3v4a2 2 0 0 1-2 2H9v2a2 2 0 0 0 3 0"
                strokeWidth="1"
            />
        </>
    );
}

function PythonIcon() {
    return (
        <>
            <path
                d="M8 2C5.5 2 4 3 4 4.5V6h4v1H3.5C2 7 1.5 8.5 1.5 10s.5 3 2 3H5v-2a2 2 0 0 1 2-2h3a1.5 1.5 0 0 0 1.5-1.5V4.5C11.5 3 10.5 2 8 2Z"
                strokeWidth="0.9"
            />
            <path
                d="M8 14c2.5 0 4-1 4-2.5V10H8V9h4.5c1.5 0 2-1.5 2-3s-.5-3-2-3H11v2a2 2 0 0 1-2 2H6a1.5 1.5 0 0 0-1.5 1.5v3C4.5 13 5.5 14 8 14Z"
                strokeWidth="0.9"
            />
            <circle
                cx="6.25"
                cy="4.5"
                r="0.6"
                fill="currentColor"
                stroke="none"
            />
            <circle
                cx="9.75"
                cy="11.5"
                r="0.6"
                fill="currentColor"
                stroke="none"
            />
        </>
    );
}

function RustIcon() {
    return (
        <>
            <circle cx="8" cy="8" r="5" strokeWidth="1" />
            <circle cx="8" cy="8" r="1.5" strokeWidth="0.8" />
            <line x1="8" y1="3" x2="8" y2="5" strokeWidth="0.8" />
            <line x1="8" y1="11" x2="8" y2="13" strokeWidth="0.8" />
            <line x1="3" y1="8" x2="5" y2="8" strokeWidth="0.8" />
            <line x1="11" y1="8" x2="13" y2="8" strokeWidth="0.8" />
            <line x1="4.5" y1="4.5" x2="5.9" y2="5.9" strokeWidth="0.8" />
            <line x1="10.1" y1="10.1" x2="11.5" y2="11.5" strokeWidth="0.8" />
        </>
    );
}

function GoIcon() {
    return (
        <>
            <path d="M4 5h8" strokeWidth="1" />
            <path d="M4 5v5a4 4 0 0 0 4 4 4 4 0 0 0 4-4V5" strokeWidth="1" />
            <path d="M8 5V2" strokeWidth="0.8" />
            <circle cx="6" cy="8" r="0.7" fill="currentColor" stroke="none" />
            <circle cx="10" cy="8" r="0.7" fill="currentColor" stroke="none" />
        </>
    );
}

function HtmlIcon() {
    return (
        <>
            <path d="M3 4l2.5 4-2.5 4" strokeWidth="1" />
            <path d="M13 4l-2.5 4 2.5 4" strokeWidth="1" />
            <path d="M9.5 3l-3 10" strokeWidth="0.8" />
        </>
    );
}

function CssIcon() {
    return (
        <>
            <path d="M5 3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2" strokeWidth="1" />
            <path d="M5 9a2 2 0 0 0 2 2v2" strokeWidth="1" />
            <path d="M11 3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2" strokeWidth="1" />
            <path d="M11 9a2 2 0 0 1-2 2v2" strokeWidth="1" />
        </>
    );
}

function JsonIcon() {
    return (
        <>
            <path
                d="M4.5 3a1.5 1.5 0 0 0-1.5 1.5v2L4.5 8 3 9.5v2A1.5 1.5 0 0 0 4.5 13"
                strokeWidth="1"
            />
            <path
                d="M11.5 3a1.5 1.5 0 0 1 1.5 1.5v2L11.5 8 13 9.5v2a1.5 1.5 0 0 1-1.5 1.5"
                strokeWidth="1"
            />
            <circle cx="6.5" cy="8" r="0.6" fill="currentColor" stroke="none" />
            <circle cx="9.5" cy="8" r="0.6" fill="currentColor" stroke="none" />
        </>
    );
}

function MarkdownIcon() {
    return (
        <>
            <path d="M2.5 4v8l3-4 3 4V4" strokeWidth="1" />
            <path d="M11.5 12V7l2-2" strokeWidth="1" />
            <path d="M11.5 7l-2-2" strokeWidth="1" />
        </>
    );
}

function YamlIcon() {
    return (
        <>
            <path d="M3 4h5" strokeWidth="1" />
            <path d="M5 7h6" strokeWidth="1" />
            <path d="M7 10h5" strokeWidth="1" />
            <circle cx="3" cy="7" r="0.6" fill="currentColor" stroke="none" />
            <circle cx="5" cy="10" r="0.6" fill="currentColor" stroke="none" />
            <circle cx="3" cy="13" r="0.6" fill="currentColor" stroke="none" />
            <path d="M5 13h4" strokeWidth="1" />
        </>
    );
}

function ShellIcon() {
    return (
        <>
            <path d="M4 5l3 3-3 3" strokeWidth="1.1" />
            <path d="M9 11h4" strokeWidth="1" />
        </>
    );
}

function SqlIcon() {
    return (
        <>
            <ellipse cx="8" cy="4.5" rx="4.5" ry="2" strokeWidth="1" />
            <path
                d="M3.5 4.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7"
                strokeWidth="1"
            />
            <path d="M3.5 8c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" strokeWidth="0.8" />
        </>
    );
}

function JavaIcon() {
    return (
        <>
            <path d="M5 3h6v5a3 3 0 0 1-6 0V3Z" strokeWidth="1" />
            <path d="M4 5.5h1" strokeWidth="0.8" />
            <path d="M11 5.5h1" strokeWidth="0.8" />
            <path d="M8 8v3" strokeWidth="0.8" />
            <path d="M6 11h4" strokeWidth="0.8" />
            <path
                d="M5.5 11v2a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-2"
                strokeWidth="0.8"
            />
        </>
    );
}

function KotlinIcon() {
    return (
        <>
            <path d="M3 3h10L8 8l5 5H3V3Z" strokeWidth="1" />
        </>
    );
}

function ClangIcon() {
    return (
        <>
            <path
                d="M11 4.5A4.5 4.5 0 0 0 6.5 3 4.5 4.5 0 0 0 2 7.5v1A4.5 4.5 0 0 0 6.5 13 4.5 4.5 0 0 0 11 11.5"
                strokeWidth="1.1"
            />
        </>
    );
}

function RubyIcon() {
    return (
        <>
            <path d="M8 2L13.5 8 8 14 2.5 8Z" strokeWidth="1" />
            <path d="M2.5 8h11" strokeWidth="0.8" />
            <path d="M8 2v12" strokeWidth="0.8" />
        </>
    );
}

function PhpIcon() {
    return (
        <>
            <ellipse cx="8" cy="8" rx="6.5" ry="4.5" strokeWidth="1" />
            <path d="M5 6v4" strokeWidth="0.9" />
            <path d="M5 6h1.5a1.2 1.2 0 0 1 0 2.4H5" strokeWidth="0.9" />
            <path d="M10 6v4" strokeWidth="0.9" />
            <path d="M10 6h1.5a1.2 1.2 0 0 1 0 2.4H10" strokeWidth="0.9" />
        </>
    );
}

function SwiftIcon() {
    return (
        <>
            <path
                d="M12 3.5c0 0-4 4-8 6.5 3-1 5.5-1 7 0 .5.3.8 1 .5 2-.5 1.5-2.5 2.5-5 2-3-.5-5-2.5-5-2.5"
                strokeWidth="1"
            />
            <path d="M3 9.5C5 11 8 12 10.5 11" strokeWidth="0.8" />
        </>
    );
}

function LuaIcon() {
    return (
        <>
            <circle cx="8" cy="8" r="5.5" strokeWidth="1" />
            <path d="M5 8a3.5 3.5 0 0 1 6.5-1.5" strokeWidth="0.8" />
            <circle cx="11" cy="4" r="1.2" fill="currentColor" stroke="none" />
        </>
    );
}

function GraphqlIcon() {
    return (
        <>
            <polygon
                points="8,2.5 13,5.5 13,10.5 8,13.5 3,10.5 3,5.5"
                strokeWidth="1"
            />
            <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        </>
    );
}

function ConfigIcon() {
    return (
        <>
            <circle cx="8" cy="8" r="2.5" strokeWidth="1" />
            <path d="M8 2v2.5" strokeWidth="0.9" />
            <path d="M8 11.5V14" strokeWidth="0.9" />
            <path d="M2 8h2.5" strokeWidth="0.9" />
            <path d="M11.5 8H14" strokeWidth="0.9" />
            <path d="M3.75 3.75l1.77 1.77" strokeWidth="0.9" />
            <path d="M10.48 10.48l1.77 1.77" strokeWidth="0.9" />
            <path d="M3.75 12.25l1.77-1.77" strokeWidth="0.9" />
            <path d="M10.48 5.52l1.77-1.77" strokeWidth="0.9" />
        </>
    );
}

function GitfileIcon() {
    return (
        <>
            <path d="M8 2v7" strokeWidth="1" />
            <path d="M8 9c-3 0-4.5 1-4.5 2.5S5 14 8 14" strokeWidth="1" />
            <path d="M8 9c3 0 4.5 1 4.5 2.5S11 14 8 14" strokeWidth="1" />
            <circle cx="8" cy="5" r="1.2" strokeWidth="0.8" />
        </>
    );
}

function PackageIcon() {
    return (
        <>
            <path d="M8 1.5L14 5v6l-6 3.5L2 11V5Z" strokeWidth="1" />
            <path d="M2 5l6 3.5L14 5" strokeWidth="0.8" />
            <path d="M8 8.5V14.5" strokeWidth="0.8" />
            <path d="M5 3.25L11 6.75" strokeWidth="0.7" />
        </>
    );
}

function LockfileIcon() {
    return (
        <>
            <rect x="4" y="7.5" width="8" height="6" rx="1" strokeWidth="1" />
            <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" strokeWidth="1" />
            <circle
                cx="8"
                cy="10.5"
                r="0.7"
                fill="currentColor"
                stroke="none"
            />
        </>
    );
}

function ImageIcon() {
    return (
        <>
            <rect x="2" y="3" width="12" height="10" rx="1.5" strokeWidth="1" />
            <circle cx="5.5" cy="6" r="1.2" strokeWidth="0.8" />
            <path d="M2 11l3.5-3.5L8 10l2.5-2.5L14 11" strokeWidth="0.8" />
        </>
    );
}

function DocumentIcon() {
    return (
        <>
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                strokeWidth="1"
            />
            <path d="M9.5 1.5V5H13" strokeWidth="0.8" />
        </>
    );
}

function VueIcon() {
    return (
        <>
            <path d="M1.5 3L8 14L14.5 3" strokeWidth="1" />
            <path d="M4.5 3L8 9L11.5 3" strokeWidth="1" />
        </>
    );
}

function SvelteIcon() {
    return (
        <>
            <path
                d="M12 4C10.5 2.5 8 2.5 6 4L5 5C3.5 6.5 3.5 9 5 10.5"
                strokeWidth="1"
            />
            <path
                d="M4 12C5.5 13.5 8 13.5 10 12L11 11C12.5 9.5 12.5 7 11 5.5"
                strokeWidth="1"
            />
        </>
    );
}

function AstroIcon() {
    return (
        <>
            <path d="M8 2L3 13L13 13Z" strokeWidth="1" />
            <path d="M5.5 10C6.5 11 9.5 11 10.5 10" strokeWidth="0.8" />
        </>
    );
}

function DartIcon() {
    return (
        <>
            <path d="M3.5 12.5L12.5 3.5" strokeWidth="1" />
            <path d="M12.5 3.5L9.5 3.5L12.5 6.5" strokeWidth="1" />
            <path
                d="M3.5 12.5L2 11L3.5 9.5L5 11L3.5 12.5Z"
                strokeWidth="0.8"
            />
        </>
    );
}

function PrismaIcon() {
    return (
        <>
            <path d="M8 2L13 12L3 13Z" strokeWidth="1" />
            <path d="M8 2L4.5 9.5L8 12" strokeWidth="0.7" />
        </>
    );
}

function ElixirIcon() {
    return (
        <>
            <path
                d="M8 2C5.5 4.5 4 7.5 4 10C4 12.2 5.8 14 8 14C10.2 14 12 12.2 12 10C12 7.5 10.5 4.5 8 2Z"
                strokeWidth="1"
            />
        </>
    );
}

function HaskellIcon() {
    return (
        <>
            <path d="M3 3L10 13" strokeWidth="1" />
            <path d="M6 9L3 13" strokeWidth="1" />
            <path d="M11 8H14" strokeWidth="0.8" />
            <path d="M11 11H14" strokeWidth="0.8" />
        </>
    );
}

function ZigIcon() {
    return (
        <>
            <path d="M3 3L13 3L3 13L13 13" strokeWidth="1" />
        </>
    );
}

function NixIcon() {
    return (
        <>
            <path d="M8 2L8 14" strokeWidth="0.9" />
            <path d="M3 5L13 11" strokeWidth="0.9" />
            <path d="M3 11L13 5" strokeWidth="0.9" />
            <circle cx="8" cy="8" r="1.3" strokeWidth="0.7" />
        </>
    );
}

function SolidityIcon() {
    return (
        <>
            <path d="M8 2L4 6L8 9L12 6Z" strokeWidth="1" />
            <path d="M8 7L4 10L8 14L12 10Z" strokeWidth="1" />
        </>
    );
}

function HclIcon() {
    return (
        <>
            <path d="M3 5.5L7 7.5L7 12.5L3 10.5Z" strokeWidth="1" />
            <path d="M7 7.5L11 5.5L11 10.5L7 12.5Z" strokeWidth="1" />
            <path d="M7 2.5L11 4.5L11 7.5L7 5.5Z" strokeWidth="1" />
        </>
    );
}

/* ─── Icon registry ─── */

const ICON_COMPONENTS: Record<FileTypeIconId, () => React.ReactNode> = {
    astro: AstroIcon,
    clang: ClangIcon,
    config: ConfigIcon,
    css: CssIcon,
    dart: DartIcon,
    document: DocumentIcon,
    elixir: ElixirIcon,
    gitfile: GitfileIcon,
    go: GoIcon,
    graphql: GraphqlIcon,
    haskell: HaskellIcon,
    hcl: HclIcon,
    html: HtmlIcon,
    image: ImageIcon,
    java: JavaIcon,
    javascript: JavaScriptIcon,
    json: JsonIcon,
    kotlin: KotlinIcon,
    lockfile: LockfileIcon,
    lua: LuaIcon,
    markdown: MarkdownIcon,
    nix: NixIcon,
    package: PackageIcon,
    php: PhpIcon,
    prisma: PrismaIcon,
    python: PythonIcon,
    ruby: RubyIcon,
    rust: RustIcon,
    shell: ShellIcon,
    solidity: SolidityIcon,
    sql: SqlIcon,
    svelte: SvelteIcon,
    swift: SwiftIcon,
    typescript: TypeScriptIcon,
    vue: VueIcon,
    yaml: YamlIcon,
    zig: ZigIcon,
};

/* ─── Component ─── */

export function FileTypeIcon({
    color: colorOverride,
    fileName,
    size = 13,
    scaled = false,
    opacity = 0.58,
    className,
}: {
    readonly color?: string;
    readonly fileName: string;
    readonly size?: number;
    readonly scaled?: boolean;
    readonly opacity?: number;
    readonly className?: string;
}) {
    const { iconId, color } = resolveFileTypeIcon(fileName);
    const IconContent = ICON_COMPONENTS[iconId];

    return (
        <SvgShell
            className={className}
            color={colorOverride ?? color}
            opacity={opacity}
            scaled={scaled}
            size={size}
        >
            <IconContent />
        </SvgShell>
    );
}
