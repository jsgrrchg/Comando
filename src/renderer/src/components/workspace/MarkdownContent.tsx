import { memo, useCallback, useState, type ReactElement } from "react";

interface MarkdownContentProps {
    readonly content: string;
}

interface Block {
    readonly content: string;
    readonly info: string;
    readonly type: "code" | "text";
}

const BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function parseBlocks(text: string): Block[] {
    const blocks: Block[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(BLOCK_RE)) {
        const before = text.slice(lastIndex, match.index);
        if (before) {
            blocks.push({ content: before, info: "", type: "text" });
        }
        blocks.push({
            content: match[2] ?? "",
            info: (match[1] ?? "").trim().toLowerCase(),
            type: "code",
        });
        lastIndex = (match.index ?? 0) + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        blocks.push({ content: tail, info: "", type: "text" });
    }

    return blocks;
}

function renderInline(text: string): Array<ReactElement | string> {
    const parts: Array<ReactElement | string> = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    let key = 0;

    for (const match of text.matchAll(re)) {
        const before = text.slice(lastIndex, match.index);
        if (before) parts.push(before);

        if (match[1]) {
            parts.push(
                <code
                    key={key++}
                    style={{
                        backgroundColor: "var(--color-bg-tertiary)",
                        borderRadius: 4,
                        fontSize: "0.9em",
                        padding: "1px 5px",
                    }}
                >
                    {match[1].slice(1, -1)}
                </code>,
            );
        } else if (match[2]) {
            parts.push(<strong key={key++}>{match[2].slice(2, -2)}</strong>);
        } else if (match[3]) {
            parts.push(<em key={key++}>{match[3].slice(1, -1)}</em>);
        } else if (match[4]) {
            const linkMatch = match[4].match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (linkMatch) {
                parts.push(
                    <a
                        key={key++}
                        href={linkMatch[2]}
                        rel="noopener noreferrer"
                        style={{ color: "var(--color-accent)" }}
                        target="_blank"
                    >
                        {linkMatch[1]}
                    </a>,
                );
            }
        }
        lastIndex = (match.index ?? 0) + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (tail) parts.push(tail);

    return parts;
}

function CodeBlock({ block }: { readonly block: Block }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(() => {
        void navigator.clipboard.writeText(block.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        });
    }, [block.content]);

    return (
        <div
            className="relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
            }}
        >
            {block.info ? (
                <div
                    className="flex items-center justify-between px-3 py-1.5"
                    style={{
                        borderBottom: "1px solid var(--color-border)",
                        color: "var(--color-text-secondary)",
                        fontSize: "0.7em",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                    }}
                >
                    <span>{block.info}</span>
                    <button
                        onClick={handleCopy}
                        style={{
                            background: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "0.85em",
                            opacity: 0.7,
                            padding: "0 2px",
                        }}
                        type="button"
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            ) : (
                <button
                    className="absolute right-2 top-2"
                    onClick={handleCopy}
                    style={{
                        background: "none",
                        color: "var(--color-text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.7em",
                        opacity: 0.7,
                    }}
                    type="button"
                >
                    {copied ? "Copied" : "Copy"}
                </button>
            )}
            <pre
                className="overflow-x-auto p-3"
                style={{
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.85em",
                    lineHeight: 1.6,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {block.content}
            </pre>
        </div>
    );
}

function TextBlock({ block }: { readonly block: Block }) {
    const lines = block.content.split("\n");
    const elements: ReactElement[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trimStart();

        if (!trimmed) {
            elements.push(<div key={i} style={{ height: 4 }} />);
            i++;
            continue;
        }

        const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const level = headerMatch[1]!.length;
            const sizes = [
                "1.35em",
                "1.2em",
                "1.08em",
                "1em",
                "0.92em",
                "0.85em",
            ];
            elements.push(
                <div
                    key={i}
                    style={{
                        fontSize: sizes[level - 1],
                        fontWeight: 600,
                        marginBottom: 2,
                        marginTop: 8,
                    }}
                >
                    {renderInline(headerMatch[2]!)}
                </div>,
            );
            i++;
            continue;
        }

        if (/^---+\s*$/.test(trimmed)) {
            elements.push(
                <hr
                    key={i}
                    style={{
                        border: "none",
                        borderTop: "1px solid var(--color-border)",
                        margin: "8px 0",
                    }}
                />,
            );
            i++;
            continue;
        }

        if (/^>\s/.test(trimmed)) {
            const quoteLines: string[] = [];
            while (
                i < lines.length &&
                /^>\s?/.test(lines[i]?.trimStart() ?? "")
            ) {
                quoteLines.push(
                    (lines[i] ?? "").trimStart().replace(/^>\s?/, ""),
                );
                i++;
            }
            elements.push(
                <blockquote
                    key={`bq-${i}`}
                    className="my-1 pl-3 italic"
                    style={{
                        borderLeft: "2px solid var(--color-accent)",
                        color: "var(--color-text-secondary)",
                    }}
                >
                    {quoteLines.map((ql, qi) => (
                        <div key={qi}>{renderInline(ql)}</div>
                    ))}
                </blockquote>,
            );
            continue;
        }

        if (/^[-*+]\s+/.test(trimmed)) {
            const items: string[] = [];
            while (
                i < lines.length &&
                /^[-*+]\s+/.test(lines[i]?.trimStart() ?? "")
            ) {
                items.push(
                    (lines[i] ?? "").trimStart().replace(/^[-*+]\s+/, ""),
                );
                i++;
            }
            elements.push(
                <ul
                    key={`ul-${i}`}
                    style={{
                        listStyleType: "disc",
                        margin: "4px 0",
                        paddingLeft: 20,
                    }}
                >
                    {items.map((item, idx) => (
                        <li key={idx} style={{ lineHeight: 1.6 }}>
                            {renderInline(item)}
                        </li>
                    ))}
                </ul>,
            );
            continue;
        }

        if (/^\d+[.)]\s+/.test(trimmed)) {
            const items: string[] = [];
            while (
                i < lines.length &&
                /^\d+[.)]\s+/.test(lines[i]?.trimStart() ?? "")
            ) {
                items.push(
                    (lines[i] ?? "").trimStart().replace(/^\d+[.)]\s+/, ""),
                );
                i++;
            }
            elements.push(
                <ol
                    key={`ol-${i}`}
                    style={{
                        listStyleType: "decimal",
                        margin: "4px 0",
                        paddingLeft: 20,
                    }}
                >
                    {items.map((item, idx) => (
                        <li key={idx} style={{ lineHeight: 1.6 }}>
                            {renderInline(item)}
                        </li>
                    ))}
                </ol>,
            );
            continue;
        }

        elements.push(
            <div key={i} style={{ lineHeight: 1.6 }}>
                {renderInline(line)}
            </div>,
        );
        i++;
    }

    return <>{elements}</>;
}

export const MarkdownContent = memo(function MarkdownContent({
    content,
}: MarkdownContentProps) {
    const blocks = parseBlocks(content);

    return (
        <div
            className="chat-assistant-content min-w-0 max-w-full"
            style={{
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {blocks.map((block, index) =>
                block.type === "code" ? (
                    <CodeBlock block={block} key={index} />
                ) : (
                    <TextBlock block={block} key={index} />
                ),
            )}
        </div>
    );
});
