/** @vitest-environment jsdom */
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

function renderInteractiveMarkdownFilePreview(
    overrides: Partial<ComponentProps<typeof MarkdownFilePreview>>,
): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    act(() => {
        root.render(
            createElement(MarkdownFilePreview, createPreviewProps(overrides)),
        );
    });

    return container;
}

describe("MarkdownFilePreview", () => {
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

    it("renders fenced code blocks with the static code wrapper", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "```ts\nconst value = 1;\n```",
        });

        expect(markup).toContain('data-language="ts"');
        expect(markup).toContain("markdown-file-preview__code-block");
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("const value = 1;");
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

    it("blocks Markdown images until the preview has an asset policy", () => {
        const markup = renderStaticMarkdownFilePreview({
            content: "![Diagram](https://example.com/diagram.png)",
        });

        expect(markup).not.toContain("<img");
        expect(markup).toContain("markdown-file-preview__blocked-image");
        expect(markup).toContain('aria-label="Diagram"');
    });
});
