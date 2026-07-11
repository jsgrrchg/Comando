import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";

const markdownCodeLanguageLabels: Record<string, string> = {
    bash: "Bash",
    c: "C",
    "c++": "C++",
    cpp: "C++",
    cs: "C#",
    csharp: "C#",
    css: "CSS",
    diff: "Diff",
    docker: "Dockerfile",
    dockerfile: "Dockerfile",
    gql: "GraphQL",
    graphql: "GraphQL",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsonc: "JSONC",
    jsx: "JSX",
    make: "Makefile",
    makefile: "Makefile",
    markdown: "Markdown",
    md: "Markdown",
    mdx: "MDX",
    php: "PHP",
    powershell: "PowerShell",
    ps1: "PowerShell",
    pwsh: "PowerShell",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    rs: "Rust",
    ruby: "Ruby",
    rust: "Rust",
    scss: "SCSS",
    sh: "Shell",
    shell: "Shell",
    sql: "SQL",
    text: "Text",
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zsh: "Zsh",
};

function formatMarkdownCodeLanguageLabel(language: string): string {
    const normalizedLanguage = language.trim().toLowerCase();
    const mappedLabel = markdownCodeLanguageLabels[normalizedLanguage];
    if (mappedLabel) {
        return mappedLabel;
    }

    return normalizedLanguage
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

async function writeCodeBlockClipboardText(text: string): Promise<void> {
    if (window.comando?.writeClipboardText) {
        try {
            await window.comando.writeClipboardText(text);
            return;
        } catch {
            // Fall through to the Web Clipboard API when the native bridge is unavailable.
        }
    }

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Copy actions should stay quiet if clipboard access is denied.
        }
    }
}

function MarkdownCodeCopyIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            viewBox="0 0 14 14"
            width="12"
        >
            <rect x="5" y="3" width="6" height="8" rx="1.2" />
            <path d="M3.5 9.5H3A1 1 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2H8" />
        </svg>
    );
}

function MarkdownCodeCheckIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 14 14"
            width="12"
        >
            <path d="M3 7l2.2 2.2L11 3.8" />
        </svg>
    );
}

function MarkdownCodeCopyButton({ codeText }: { readonly codeText: string }) {
    const [copied, setCopied] = useState(false);
    const resetTimeoutRef = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (resetTimeoutRef.current) {
                window.clearTimeout(resetTimeoutRef.current);
            }
        },
        [],
    );

    const handleCopy = useCallback(() => {
        void writeCodeBlockClipboardText(codeText).then(() => {
            setCopied(true);
            if (resetTimeoutRef.current) {
                window.clearTimeout(resetTimeoutRef.current);
            }
            resetTimeoutRef.current = window.setTimeout(() => {
                setCopied(false);
                resetTimeoutRef.current = null;
            }, 1200);
        });
    }, [codeText]);

    return (
        <button
            aria-label="Copy code block"
            className="markdown-code-copy-button"
            data-copied={copied ? "true" : undefined}
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy"}
            type="button"
        >
            {copied ? <MarkdownCodeCheckIcon /> : <MarkdownCodeCopyIcon />}
        </button>
    );
}

export function MarkdownCodeFrame({
    children,
    className,
    codeText,
    language,
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly codeText: string;
    readonly language?: string | null;
}) {
    const normalizedLanguage = language?.trim() || null;

    return (
        <div
            className={[
                "markdown-code-frame",
                normalizedLanguage ? null : "markdown-code-frame--unlabeled",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {normalizedLanguage ? (
                <div className="markdown-code-header">
                    <span>
                        {formatMarkdownCodeLanguageLabel(normalizedLanguage)}
                    </span>
                    <MarkdownCodeCopyButton codeText={codeText} />
                </div>
            ) : (
                <div className="markdown-code-copy-overlay">
                    <MarkdownCodeCopyButton codeText={codeText} />
                </div>
            )}
            {children}
        </div>
    );
}
