/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownFilePreview } from "./MarkdownFilePreview";

const mockOpenExternalUrl = vi.hoisted(() => vi.fn());
const mockMermaidInitialize = vi.hoisted(() => vi.fn());
const mockMermaidRender = vi.hoisted(() =>
    vi.fn(() =>
        Promise.resolve({
            svg: "<svg><text>Rendered Mermaid SVG</text></svg>",
        }),
    ),
);

vi.mock("@renderer/app/utils/external-url", () => ({
    openExternalUrl: mockOpenExternalUrl,
}));

vi.mock("mermaid", () => ({
    default: {
        initialize: mockMermaidInitialize,
        render: mockMermaidRender,
    },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

afterEach(() => {
    mockOpenExternalUrl.mockReset();
    mockMermaidInitialize.mockClear();
    mockMermaidRender.mockClear();
    window.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();

    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function findTextNodeContaining(root: Node, text: string): Text {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    let node = walker.nextNode();
    while (node) {
        if (node.textContent?.includes(text)) {
            return node as Text;
        }
        node = walker.nextNode();
    }

    throw new Error(`Could not find text node containing "${text}".`);
}

function selectPreviewText(preview: HTMLElement, text: string): void {
    const textNode = findTextNodeContaining(preview, text);
    const startOffset = textNode.data.indexOf(text);
    if (startOffset < 0) {
        throw new Error(`Could not select text "${text}".`);
    }

    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, startOffset + text.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function openPreviewContextMenu(container: HTMLElement): HTMLElement {
    const preview = container.querySelector<HTMLElement>(".markdown-file-preview");
    if (!preview) {
        throw new Error("Could not find Markdown preview root.");
    }

    act(() => {
        preview.dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: 24,
                clientY: 32,
            }),
        );
    });

    return preview;
}

function queryContextMenuButton(label: string): HTMLButtonElement | null {
    return (
        Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent === label,
        ) ?? null
    );
}

function createPreviewProps(
    overrides: Partial<ComponentProps<typeof MarkdownFilePreview>> = {},
): ComponentProps<typeof MarkdownFilePreview> {
    return {
        content: "",
        filePath: "README.md",
        fontFamily: "Inter, sans-serif",
        fontSize: 14,
        ...overrides,
    };
}

function renderStaticMarkdownFilePreview(
    overrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
): string {
    return renderToStaticMarkup(
        createElement(MarkdownFilePreview, createPreviewProps(overrides)),
    );
}

function readMarkdownPreviewStyles(): string {
    return readFileSync(
        join(process.cwd(), "src/renderer/src/styles.css"),
        "utf8",
    );
}

function renderInteractiveMarkdownFilePreview(
    overrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
): HTMLElement {
    return mountInteractiveMarkdownFilePreview(overrides).container;
}

function mountInteractiveMarkdownFilePreview(
    overrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
): {
    readonly container: HTMLElement;
    readonly rerender: (
        nextOverrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
    ) => void;
} {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    const renderPreview = (
        nextOverrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
    ) => {
        root.render(
            createElement(
                MarkdownFilePreview,
                createPreviewProps(nextOverrides),
            ),
        );
    };

    act(() => {
        renderPreview(overrides);
    });

    return {
        container,
        rerender: (nextOverrides) => {
            act(() => {
                renderPreview(nextOverrides);
            });
        },
    };
}

async function waitForPreviewToken(
    container: HTMLElement,
    selector: string,
): Promise<Element> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const token = container.querySelector(selector);
        if (token) {
            return token;
        }

        await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
    }

    throw new Error(`Expected preview token "${selector}" to render.`);
}

describe("MarkdownFilePreview", () => {
    it("restores visible list markers inside the preview surface", () => {
        const styles = readMarkdownPreviewStyles();

        expect(styles).toContain(".markdown-file-preview ul");
        expect(styles).toContain("list-style-type: disc");
        expect(styles).toContain(".markdown-file-preview ol");
        expect(styles).toContain("list-style-type: decimal");
        expect(styles).toContain(
            ".markdown-file-preview li:has(> .markdown-file-preview__checkbox)",
        );
    });

    it("styles Mermaid diagrams as stable scrollable preview frames", () => {
        const styles = readMarkdownPreviewStyles();
        const mermaidBodyRule =
            styles.match(
                /\.markdown-file-preview__mermaid-body\s*\{[^}]*\}/,
            )?.[0] ?? "";
        const mermaidSvgRule =
            styles.match(
                /\.markdown-file-preview__mermaid-svg svg\s*\{[^}]*\}/,
            )?.[0] ?? "";
        const mermaidSvgWrapRule =
            styles.match(
                /\.markdown-file-preview__mermaid-svg\s*\{[^}]*\}/,
            )?.[0] ?? "";

        expect(styles).toContain(".markdown-file-preview__mermaid-frame");
        expect(styles).toContain(".markdown-file-preview__mermaid-header");
        expect(styles).toContain(".markdown-file-preview__mermaid-copy-button");
        expect(styles).toContain(".markdown-file-preview__mermaid-status");
        expect(styles).toContain(".markdown-file-preview__mermaid-error");
        expect(mermaidBodyRule).toContain("min-height: 180px");
        expect(mermaidBodyRule).toContain("overflow: auto");
        expect(mermaidSvgWrapRule).toContain("min-width: max-content");
        expect(mermaidSvgRule).toContain("max-width: 100%");
        expect(mermaidSvgRule).toContain("color: var(--color-text-primary)");
    });

    it("renders an empty Markdown file as a stable empty preview surface", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "",
        });

        expect(markup).toContain('class="markdown-file-preview"');
        expect(markup).not.toContain("<p>");
        expect(markup).not.toContain("<h1>");
    });

    it("renders headings, paragraphs and lists", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: [
                "# Project Notes",
                "",
                "A compact preview for Markdown files.",
                "",
                "- First item",
                "- Second item",
            ].join("\n"),
        });

        expect(markup).toContain("<h1>Project Notes</h1>");
        expect(markup).toContain("<p>A compact preview for Markdown files.</p>");
        expect(markup).toContain("<li>First item</li>");
        expect(markup).toContain("<li>Second item</li>");
    });

    it("colors Markdown headings with the code theme token palette", () => {
        const styles = readMarkdownPreviewStyles();
        const headingRule =
            styles.match(
                /\.markdown-file-preview h1,[\s\S]*?\.markdown-file-preview h6\s*\{[^}]*\}/,
            )?.[0] ?? "";

        expect(headingRule).toContain("--code-color-markup");
        expect(headingRule).not.toContain("--color-text-primary");
    });

    it("renders GFM tables and task lists", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: [
                "| Status | Count |",
                "| --- | ---: |",
                "| Done | 2 |",
                "",
                "- [x] Ship preview",
                "- [ ] Polish styles",
            ].join("\n"),
        });

        expect(markup).toContain("<table>");
        expect(markup).toContain("<th>Status</th>");
        expect(markup).toContain("<td>Done</td>");
        expect(markup).toContain('type="checkbox"');
        expect(markup).toContain("Ship preview");
        expect(markup).toContain("Polish styles");
    });

    it("opens safe external links through the app bridge", () => {
        const container = renderInteractiveMarkdownFilePreview({
            content: "[Docs](https://example.com/docs)",
        });
        const link = container.querySelector<HTMLAnchorElement>("a");

        expect(link).not.toBeNull();
        expect(link?.getAttribute("href")).toBe("https://example.com/docs");

        act(() => {
            link?.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
        });

        expect(mockOpenExternalUrl).toHaveBeenCalledWith(
            "https://example.com/docs",
        );
    });

    it("does not open unsafe link schemes", () => {
        const container = renderInteractiveMarkdownFilePreview({
            content: "[Bad](javascript:alert(1))",
        });
        const link = container.querySelector<HTMLAnchorElement>("a");

        expect(link).not.toBeNull();
        expect(link?.hasAttribute("href")).toBe(false);

        act(() => {
            link?.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
        });

        expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    });

    it("does not open invalid external URLs", () => {
        const container = renderInteractiveMarkdownFilePreview({
            content: "[Broken](https://)",
        });
        const link = container.querySelector<HTMLAnchorElement>("a");

        expect(link).not.toBeNull();
        expect(link?.hasAttribute("href")).toBe(false);

        act(() => {
            link?.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
        });

        expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    });

    it("renders fenced code blocks with the static code wrapper", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "```ts\nconst value = 1;\n```",
        });

        expect(markup).toContain('data-language="ts"');
        expect(markup).toContain("markdown-file-preview__code-frame");
        expect(markup).toContain("markdown-file-preview__code-header");
        expect(markup).toContain(">TypeScript</span>");
        expect(markup).toContain("markdown-file-preview__code-block");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("const value = 1;");
    });

    it("renders Mermaid fenced code blocks with the diagram renderer", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "```mermaid\nflowchart TD\n    A --> B\n```",
        });

        expect(markup).toContain("markdown-file-preview__mermaid-frame");
        expect(markup).toContain(">Mermaid</span>");
        expect(markup).toContain(">Copy source</button>");
        expect(markup).toContain("Rendering diagram...");
        expect(markup).not.toContain("markdown-file-preview__code-frame");
        expect(markup).not.toContain("markdown-file-preview__code-block");
    });

    it("renders tilde Mermaid fences with the diagram renderer", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "~~~mermaid\nsequenceDiagram\n    Alice->>Bob: Hello\n~~~",
        });

        expect(markup).toContain("markdown-file-preview__mermaid-frame");
        expect(markup).toContain(">Mermaid</span>");
        expect(markup).toContain(">Copy source</button>");
        expect(markup).not.toContain("markdown-file-preview__code-frame");
    });

    it("renders readable language labels for bash code fences", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "```bash\npnpm run lint\n```",
        });

        expect(markup).toContain('data-language="bash"');
        expect(markup).toContain(">Bash</span>");
        expect(markup).toContain('aria-label="Copy code block"');
        expect(markup).toContain('title="Copy"');
    });

    it("copies fenced code block text through the app clipboard bridge", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { writeClipboardText });
        const container = renderInteractiveMarkdownFilePreview({
            content: [
                "```bash",
                "pnpm add react-markdown remark-gfm rehype-sanitize",
                "```",
            ].join("\n"),
        });
        const copyButton = container.querySelector<HTMLButtonElement>(
            '[aria-label="Copy code block"]',
        );

        expect(copyButton).not.toBeNull();

        await act(async () => {
            copyButton?.click();
            await Promise.resolve();
        });

        expect(writeClipboardText).toHaveBeenCalledWith(
            "pnpm add react-markdown remark-gfm rehype-sanitize",
        );
        expect(copyButton?.getAttribute("title")).toBe("Copied");
    });

    it("copies Mermaid fence source instead of the rendered SVG", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { writeClipboardText });
        const mermaidSource = "flowchart TD\n    A --> B";
        const container = renderInteractiveMarkdownFilePreview({
            content: ["```mermaid", mermaidSource, "```"].join("\n"),
        });

        await waitForPreviewToken(
            container,
            ".markdown-file-preview__mermaid-svg",
        );

        const copyButton = container.querySelector<HTMLButtonElement>(
            ".markdown-file-preview__mermaid-copy-button",
        );
        expect(copyButton).not.toBeNull();

        await act(async () => {
            copyButton?.click();
            await Promise.resolve();
        });

        expect(writeClipboardText).toHaveBeenCalledWith(mermaidSource);
        expect(writeClipboardText).not.toHaveBeenCalledWith(
            expect.stringContaining("Rendered Mermaid SVG"),
        );
    });

    it("shows a read-only context menu that can copy the full Markdown source", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { writeClipboardText });
        const content = ["# Project Notes", "", "Copy this paragraph."].join("\n");
        const container = renderInteractiveMarkdownFilePreview({ content });

        openPreviewContextMenu(container);

        const copyMarkdownButton = queryContextMenuButton("Copy Markdown");
        expect(copyMarkdownButton).not.toBeNull();
        expect(queryContextMenuButton("Paste")).toBeNull();
        expect(queryContextMenuButton("Select all")).not.toBeNull();

        await act(async () => {
            copyMarkdownButton?.click();
            await Promise.resolve();
        });

        expect(writeClipboardText).toHaveBeenCalledWith(content);
    });

    it("keeps copying the full Markdown source for Mermaid previews", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { writeClipboardText });
        const content = ["# Diagram", "", "```mermaid", "flowchart TD", "```"].join(
            "\n",
        );
        const container = renderInteractiveMarkdownFilePreview({ content });

        openPreviewContextMenu(container);

        const copyMarkdownButton = queryContextMenuButton("Copy Markdown");
        expect(copyMarkdownButton).not.toBeNull();

        await act(async () => {
            copyMarkdownButton?.click();
            await Promise.resolve();
        });

        expect(writeClipboardText).toHaveBeenCalledWith(content);
    });

    it("copies selected Markdown preview text from the context menu", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { writeClipboardText });
        const container = renderInteractiveMarkdownFilePreview({
            content: ["# Project Notes", "", "Copy this paragraph."].join("\n"),
        });
        const preview = container.querySelector<HTMLElement>(
            ".markdown-file-preview",
        );

        expect(preview).not.toBeNull();
        selectPreviewText(preview as HTMLElement, "Copy this paragraph.");
        openPreviewContextMenu(container);

        const copySelectionButton = queryContextMenuButton("Copy selection");
        expect(copySelectionButton).not.toBeNull();

        await act(async () => {
            copySelectionButton?.click();
            await Promise.resolve();
        });

        expect(writeClipboardText).toHaveBeenCalledWith("Copy this paragraph.");
    });

    it("highlights bash fenced commands after loading language support", async () => {
        const container = renderInteractiveMarkdownFilePreview({
            content: [
                "```bash",
                "pnpm add react-markdown remark-gfm rehype-sanitize",
                "```",
            ].join("\n"),
        });

        const token = await waitForPreviewToken(
            container,
            ".cm-static-token-function",
        );

        expect(token.textContent).toBe("pnpm");
    });

    it("renders fenced code blocks without a language as plain code", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "```\nplain code\n```",
        });

        expect(markup).toContain("markdown-file-preview__code-block");
        expect(markup).not.toContain("markdown-file-preview__code-header");
        expect(markup).not.toContain("data-language=");
        expect(markup).not.toContain("cm-static-code");
        expect(markup).toContain("plain code");
    });

    it("skips raw HTML instead of rendering dangerous nodes", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: [
                "<script>alert('xss')</script>",
                '<img src="x" onerror="alert(\'xss\')">',
            ].join("\n"),
        });

        expect(markup).not.toContain("<script");
        expect(markup).not.toContain("<img");
        expect(markup).not.toContain("alert");
    });

    it("continues to render ordinary Markdown after skipping raw HTML", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: ["<script>alert('xss')</script>", "", "Safe text"].join(
                "\n",
            ),
        });

        expect(markup).not.toContain("<script");
        expect(markup).not.toContain("alert");
        expect(markup).toContain("Safe text");
    });

    it("escapes invalid raw HTML instead of creating executable elements", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "<img src=x onerror=alert('xss')>",
        });

        expect(markup).not.toContain("<img");
        expect(markup).toContain("&lt;img");
        expect(markup).toContain("onerror=");
        expect(markup).toContain("alert");
    });

    it("does not execute multiline raw HTML script blocks", () => {
        const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

        const container = renderInteractiveMarkdownFilePreview({
            content: [
                "Before",
                "<script>",
                "alert('xss')",
                "</script>",
                "After",
            ].join("\n"),
        });

        expect(alertSpy).not.toHaveBeenCalled();
        expect(container.innerHTML).not.toContain("<script");
        expect(container.innerHTML).not.toContain("alert");
        expect(container.innerHTML).toContain("Before");
        expect(container.innerHTML).toContain("After");

        alertSpy.mockRestore();
    });

    it("blocks Markdown images until the preview has an asset policy", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "![Diagram](https://example.com/diagram.png)",
        });

        expect(markup).not.toContain("<img");
        expect(markup).toContain("markdown-file-preview__blocked-image");
        expect(markup).toContain('aria-label="Diagram"');
    });

    it("wraps large tables in the horizontal overflow container", () => {
        const columns = Array.from({ length: 12 }, (_, index) => `Col ${index}`);
        const content = [
            `| ${columns.join(" | ")} |`,
            `| ${columns.map(() => "---").join(" | ")} |`,
            `| ${columns.map((column) => `${column} value`).join(" | ")} |`,
        ].join("\n");

        const markup = renderStaticMarkdownFilePreview({ content });

        expect(markup).toContain("markdown-file-preview__table-wrap");
        expect(markup).toContain("<table>");
        expect(markup).toContain("Col 11 value");
    });

    it("keeps rendered Markdown stable when large content rerenders with unchanged content", () => {
        const largeContent = Array.from(
            { length: 300 },
            (_, index) => `- Item ${index}`,
        ).join("\n");
        const { container, rerender } = mountInteractiveMarkdownFilePreview({
            content: largeContent,
            fontSize: 14,
        });
        const preview = container.querySelector(".markdown-file-preview");
        const initialMarkup = preview?.innerHTML;

        rerender({
            content: largeContent,
            fontSize: 16,
        });

        const nextPreview = container.querySelector<HTMLElement>(
            ".markdown-file-preview",
        );
        expect(nextPreview?.innerHTML).toBe(initialMarkup);
        expect(nextPreview?.style.fontSize).toBe("16px");
    });
});
