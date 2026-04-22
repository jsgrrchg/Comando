export const LANGUAGE_COLORS: Record<string, string> = {
    astro: "#ff5d01",
    c: "#555555",
    clojure: "#5881d8",
    cmake: "#064f8c",
    cpp: "#f34b7d",
    csharp: "#239120",
    css: "#264de4",
    d: "#b03931",
    dart: "#0175c2",
    diff: "#6b7280",
    dockerfile: "#384d54",
    elixir: "#6e4a7e",
    erlang: "#b83998",
    go: "#00add8",
    graphql: "#e535ab",
    groovy: "#4298b8",
    haskell: "#5e5086",
    hcl: "#7b42bc",
    html: "#e44d26",
    java: "#b07219",
    javascript: "#f7df1e",
    jsx: "#61dafb",
    json: "#6d6d6d",
    jsonc: "#6d6d6d",
    julia: "#9558b2",
    kotlin: "#7f52ff",
    lua: "#000080",
    makefile: "#427819",
    markdown: "#083fa1",
    mdx: "#1f6feb",
    nix: "#5277c3",
    pascal: "#e3a400",
    perl: "#39457e",
    php: "#777bb4",
    powershell: "#5391fe",
    prisma: "#5a67d8",
    protobuf: "#f59e0b",
    python: "#3776ab",
    r: "#276dc3",
    ruby: "#cc342d",
    rust: "#ce422b",
    sass: "#cc6699",
    scala: "#dc322f",
    scss: "#c6538c",
    shell: "#4eaa25",
    solidity: "#aa6746",
    sql: "#e38c00",
    stylus: "#ff6347",
    svelte: "#ff3e00",
    swift: "#f05138",
    tcl: "#1f4b99",
    toml: "#9c4221",
    typescript: "#3178c6",
    tsx: "#3178c6",
    vb: "#5c2d91",
    vue: "#42b883",
    wast: "#654ff0",
    xml: "#0060ac",
    yaml: "#cb171e",
    zig: "#f7a41d",
};

const LANGUAGE_ABBREVIATIONS: Record<string, string> = {
    astro: "AST",
    c: "C",
    clojure: "CLJ",
    cmake: "CM",
    cpp: "C++",
    csharp: "C#",
    css: "CSS",
    d: "D",
    dart: "DT",
    diff: "DIF",
    dockerfile: "DK",
    elixir: "EL",
    erlang: "EX",
    go: "Go",
    graphql: "GQL",
    groovy: "GRV",
    haskell: "HS",
    hcl: "TF",
    html: "HTML",
    java: "JV",
    javascript: "JS",
    jsx: "JSX",
    json: "{ }",
    jsonc: "{ }",
    julia: "JL",
    kotlin: "KT",
    lua: "Lua",
    makefile: "MK",
    markdown: "MD",
    mdx: "MDX",
    nix: "NIX",
    pascal: "PAS",
    perl: "PL",
    php: "PHP",
    powershell: "PS",
    prisma: "PR",
    protobuf: "PB",
    python: "PY",
    r: "R",
    ruby: "RB",
    rust: "RS",
    sass: "SA",
    scala: "SC",
    scss: "SC",
    shell: "$_",
    solidity: "SOL",
    sql: "SQL",
    stylus: "ST",
    svelte: "SVL",
    swift: "SW",
    tcl: "TC",
    toml: "TOML",
    typescript: "TS",
    tsx: "TSX",
    vb: "VB",
    vue: "VUE",
    wast: "WASM",
    xml: "XML",
    yaml: "YML",
    zig: "ZIG",
};

export function LanguageIcon({
    languageId,
    size = 12,
}: {
    readonly languageId: string;
    readonly size?: number;
}) {
    const color = LANGUAGE_COLORS[languageId] ?? "#888888";
    const abbr =
        LANGUAGE_ABBREVIATIONS[languageId] ??
        languageId.charAt(0).toUpperCase();

    const fontSize = abbr.length > 2 ? size * 0.38 : size * 0.48;
    const needsDarkText =
        languageId === "javascript" ||
        languageId === "json" ||
        languageId === "jsx";

    return (
        <svg
            fill="none"
            height={size}
            viewBox="0 0 16 16"
            width={size}
            xmlns="http://www.w3.org/2000/svg"
        >
            <rect fill={color} height="14" rx="3" width="14" x="1" y="1" />
            <text
                dominantBaseline="central"
                fill={needsDarkText ? "#000000" : "#ffffff"}
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize={fontSize / (size / 16)}
                fontWeight="700"
                textAnchor="middle"
                x="8"
                y="8.5"
            >
                {abbr}
            </text>
        </svg>
    );
}
