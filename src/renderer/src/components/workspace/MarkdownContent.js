import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { memo, useCallback, useState } from "react";
const BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
function parseBlocks(text) {
    const blocks = [];
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
function renderInline(text) {
    const parts = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    let key = 0;
    for (const match of text.matchAll(re)) {
        const before = text.slice(lastIndex, match.index);
        if (before)
            parts.push(before);
        if (match[1]) {
            parts.push(_jsx("code", { style: {
                    backgroundColor: "var(--color-bg-tertiary)",
                    borderRadius: 4,
                    fontSize: "0.9em",
                    padding: "1px 5px",
                }, children: match[1].slice(1, -1) }, key++));
        }
        else if (match[2]) {
            parts.push(_jsx("strong", { children: match[2].slice(2, -2) }, key++));
        }
        else if (match[3]) {
            parts.push(_jsx("em", { children: match[3].slice(1, -1) }, key++));
        }
        else if (match[4]) {
            const linkMatch = match[4].match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (linkMatch) {
                parts.push(_jsx("a", { href: linkMatch[2], rel: "noopener noreferrer", style: { color: "var(--color-accent)" }, target: "_blank", children: linkMatch[1] }, key++));
            }
        }
        lastIndex = (match.index ?? 0) + match[0].length;
    }
    const tail = text.slice(lastIndex);
    if (tail)
        parts.push(tail);
    return parts;
}
function CodeBlock({ block }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        void navigator.clipboard.writeText(block.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        });
    }, [block.content]);
    return (_jsxs("div", { className: "relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg", style: {
            backgroundColor: "var(--color-bg-tertiary)",
            border: "1px solid var(--color-border)",
        }, children: [block.info ? (_jsxs("div", { className: "flex items-center justify-between px-3 py-1.5", style: {
                    borderBottom: "1px solid var(--color-border)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.7em",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                }, children: [_jsx("span", { children: block.info }), _jsx("button", { onClick: handleCopy, style: {
                            background: "none",
                            color: "var(--color-text-secondary)",
                            cursor: "pointer",
                            fontSize: "0.85em",
                            opacity: 0.7,
                            padding: "0 2px",
                        }, type: "button", children: copied ? "Copied" : "Copy" })] })) : (_jsx("button", { className: "absolute right-2 top-2", onClick: handleCopy, style: {
                    background: "none",
                    color: "var(--color-text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.7em",
                    opacity: 0.7,
                }, type: "button", children: copied ? "Copied" : "Copy" })), _jsx("pre", { className: "overflow-x-auto p-3", style: {
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.85em",
                    lineHeight: 1.6,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }, children: block.content })] }));
}
function TextBlock({ block }) {
    const lines = block.content.split("\n");
    const elements = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (!trimmed) {
            elements.push(_jsx("div", { style: { height: 4 } }, i));
            i++;
            continue;
        }
        const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const sizes = [
                "1.35em",
                "1.2em",
                "1.08em",
                "1em",
                "0.92em",
                "0.85em",
            ];
            elements.push(_jsx("div", { style: {
                    fontSize: sizes[level - 1],
                    fontWeight: 600,
                    marginBottom: 2,
                    marginTop: 8,
                }, children: renderInline(headerMatch[2]) }, i));
            i++;
            continue;
        }
        if (/^---+\s*$/.test(trimmed)) {
            elements.push(_jsx("hr", { style: {
                    border: "none",
                    borderTop: "1px solid var(--color-border)",
                    margin: "8px 0",
                } }, i));
            i++;
            continue;
        }
        if (/^>\s/.test(trimmed)) {
            const quoteLines = [];
            while (i < lines.length &&
                /^>\s?/.test(lines[i]?.trimStart() ?? "")) {
                quoteLines.push((lines[i] ?? "").trimStart().replace(/^>\s?/, ""));
                i++;
            }
            elements.push(_jsx("blockquote", { className: "my-1 pl-3 italic", style: {
                    borderLeft: "2px solid var(--color-accent)",
                    color: "var(--color-text-secondary)",
                }, children: quoteLines.map((ql, qi) => (_jsx("div", { children: renderInline(ql) }, qi))) }, `bq-${i}`));
            continue;
        }
        if (/^[-*+]\s+/.test(trimmed)) {
            const items = [];
            while (i < lines.length &&
                /^[-*+]\s+/.test(lines[i]?.trimStart() ?? "")) {
                items.push((lines[i] ?? "").trimStart().replace(/^[-*+]\s+/, ""));
                i++;
            }
            elements.push(_jsx("ul", { style: {
                    listStyleType: "disc",
                    margin: "4px 0",
                    paddingLeft: 20,
                }, children: items.map((item, idx) => (_jsx("li", { style: { lineHeight: 1.6 }, children: renderInline(item) }, idx))) }, `ul-${i}`));
            continue;
        }
        if (/^\d+[.)]\s+/.test(trimmed)) {
            const items = [];
            while (i < lines.length &&
                /^\d+[.)]\s+/.test(lines[i]?.trimStart() ?? "")) {
                items.push((lines[i] ?? "").trimStart().replace(/^\d+[.)]\s+/, ""));
                i++;
            }
            elements.push(_jsx("ol", { style: {
                    listStyleType: "decimal",
                    margin: "4px 0",
                    paddingLeft: 20,
                }, children: items.map((item, idx) => (_jsx("li", { style: { lineHeight: 1.6 }, children: renderInline(item) }, idx))) }, `ol-${i}`));
            continue;
        }
        elements.push(_jsx("div", { style: { lineHeight: 1.6 }, children: renderInline(line) }, i));
        i++;
    }
    return _jsx(_Fragment, { children: elements });
}
export const MarkdownContent = memo(function MarkdownContent({ content, }) {
    const blocks = parseBlocks(content);
    return (_jsx("div", { className: "chat-assistant-content min-w-0 max-w-full", style: {
            overflowWrap: "anywhere",
            wordBreak: "break-word",
        }, children: blocks.map((block, index) => block.type === "code" ? (_jsx(CodeBlock, { block: block }, index)) : (_jsx(TextBlock, { block: block }, index))) }));
});
