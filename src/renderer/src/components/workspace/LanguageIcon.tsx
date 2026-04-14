const LANGUAGE_COLORS: Record<string, string> = {
    c: "#555555",
    cpp: "#f34b7d",
    csharp: "#239120",
    css: "#264de4",
    dockerfile: "#384d54",
    go: "#00add8",
    graphql: "#e535ab",
    html: "#e44d26",
    java: "#b07219",
    javascript: "#f7df1e",
    json: "#6d6d6d",
    kotlin: "#7f52ff",
    lua: "#000080",
    markdown: "#083fa1",
    php: "#777bb4",
    python: "#3776ab",
    ruby: "#cc342d",
    rust: "#ce422b",
    scss: "#c6538c",
    shell: "#4eaa25",
    sql: "#e38c00",
    swift: "#f05138",
    typescript: "#3178c6",
    xml: "#0060ac",
    yaml: "#cb171e",
};

const LANGUAGE_ABBREVIATIONS: Record<string, string> = {
    c: "C",
    cpp: "C++",
    csharp: "C#",
    css: "CSS",
    dockerfile: "DK",
    go: "Go",
    graphql: "GQL",
    html: "HTML",
    java: "JV",
    javascript: "JS",
    json: "{ }",
    kotlin: "KT",
    lua: "Lua",
    markdown: "MD",
    php: "PHP",
    python: "PY",
    ruby: "RB",
    rust: "RS",
    scss: "SC",
    shell: "$_",
    sql: "SQL",
    swift: "SW",
    typescript: "TS",
    xml: "XML",
    yaml: "YML",
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
    const needsDarkText = languageId === "javascript" || languageId === "json";

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
