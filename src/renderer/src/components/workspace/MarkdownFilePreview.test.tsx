/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownFilePreview } from "./MarkdownFilePreview";

const mockOpenExternalUrl = vi.hoisted(() => vi.fn());

vi.mock("@renderer/app/utils/external-url", () => ({
    openExternalUrl: mockOpenExternalUrl,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

afterEach(() => {
    mockOpenExternalUrl.mockReset();

    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

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

        vi.unstubAllGlobals();
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
                "<img src=x onerror=alert('xss')>",
                "Safe text",
            ].join("\n"),
        });

        expect(markup).not.toContain("<script");
        expect(markup).not.toContain("<img");
        expect(markup).not.toContain("alert");
        expect(markup).toContain("Safe text");
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
