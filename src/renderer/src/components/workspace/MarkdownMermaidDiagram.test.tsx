/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    MarkdownMermaidDiagram,
    MERMAID_SOURCE_MAX_LENGTH,
    sanitizeMermaidSvg,
    type MermaidRenderer,
} from "./MarkdownMermaidDiagram";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];
const mermaidThemeTestVariables = [
    "--color-bg-primary",
    "--color-bg-secondary",
    "--color-bg-tertiary",
    "--color-border",
    "--color-danger-bg",
    "--color-danger",
    "--color-text-primary",
    "--color-text-secondary",
] as const;

type MockCallTracker = {
    readonly mock: {
        readonly calls: readonly (readonly unknown[])[];
    };
};

interface MermaidRendererInitializeConfig {
    readonly themeVariables: {
        readonly mainBkg: string;
        readonly primaryColor: string;
    };
}

interface DeferredRender {
    readonly promise: Promise<{ readonly svg: string }>;
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: { readonly svg: string }) => void;
    readonly source: string;
}

afterEach(() => {
    vi.unstubAllGlobals();
    for (const variableName of mermaidThemeTestVariables) {
        document.documentElement.style.removeProperty(variableName);
    }

    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }

    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function createMermaidRenderer(
    render: MermaidRenderer["render"] = vi.fn(() =>
        Promise.resolve({ svg: "<svg><text>Diagram</text></svg>" }),
    ),
): MermaidRenderer {
    return {
        initialize: vi.fn(),
        render,
    };
}

function renderMarkdownMermaidDiagram(
    overrides: Partial<ComponentProps<typeof MarkdownMermaidDiagram>> = {},
): {
    readonly container: HTMLElement;
    readonly rerender: (
        nextOverrides: Partial<ComponentProps<typeof MarkdownMermaidDiagram>>,
    ) => void;
} {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    const renderDiagram = (
        nextOverrides: Partial<ComponentProps<typeof MarkdownMermaidDiagram>>,
    ) => {
        root.render(
            createElement(MarkdownMermaidDiagram, {
                source: "flowchart TD\nA --> B",
                ...nextOverrides,
            }),
        );
    };

    act(() => {
        renderDiagram(overrides);
    });

    return {
        container,
        rerender: (nextOverrides) => {
            act(() => {
                renderDiagram(nextOverrides);
            });
        },
    };
}

async function waitForElement(
    container: HTMLElement,
    selector: string,
): Promise<Element> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const element = container.querySelector(selector);
        if (element) {
            return element;
        }

        await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
    }

    throw new Error(`Expected selector "${selector}" to render.`);
}

async function waitForText(
    container: HTMLElement,
    text: string,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (container.textContent?.includes(text)) {
            return;
        }

        await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
    }

    throw new Error(`Expected text "${text}" to render.`);
}

async function waitForMockCallCount(
    mockFn: MockCallTracker,
    callCount: number,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (mockFn.mock.calls.length >= callCount) {
            return;
        }

        await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
    }

    throw new Error(`Expected mock to be called ${callCount} times.`);
}

function createDeferredRender(source: string): DeferredRender {
    let resolveRender: DeferredRender["resolve"] | null = null;
    let rejectRender: DeferredRender["reject"] | null = null;
    const promise = new Promise<{ readonly svg: string }>((resolve, reject) => {
        resolveRender = resolve;
        rejectRender = reject;
    });

    if (!resolveRender || !rejectRender) {
        throw new Error("Could not create deferred Mermaid render.");
    }

    return {
        promise,
        reject: rejectRender,
        resolve: resolveRender,
        source,
    };
}

describe("MarkdownMermaidDiagram", () => {
    it("renders a valid diagram with sanitized SVG output", async () => {
        document.documentElement.style.setProperty("--color-bg-primary", "#101820");
        document.documentElement.style.setProperty("--color-bg-secondary", "#152030");
        document.documentElement.style.setProperty("--color-bg-tertiary", "#1b2838");
        document.documentElement.style.setProperty("--color-border", "#3b4c61");
        document.documentElement.style.setProperty("--color-danger", "#ff6677");
        document.documentElement.style.setProperty("--color-text-primary", "#f6f8fb");
        document.documentElement.style.setProperty(
            "--color-text-secondary",
            "#aeb7c5",
        );
        const mermaid = createMermaidRenderer(
            vi.fn(() =>
                Promise.resolve({
                    svg: "<svg><script>alert('x')</script><text>Unsafe</text></svg>",
                }),
            ),
        );
        const loadMermaid = vi.fn(() => Promise.resolve(mermaid));
        const sanitizeSvg = vi.fn(() => "<svg><text>Safe</text></svg>");
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid,
            sanitizeSvg,
        });

        const renderedSvg = await waitForElement(
            container,
            ".markdown-file-preview__mermaid-svg",
        );

        expect(loadMermaid).toHaveBeenCalledTimes(1);
        expect(mermaid.initialize).toHaveBeenCalledWith(
            {
                deterministicIds: true,
                logLevel: "error",
                maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
                secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize"],
                securityLevel: "strict",
                startOnLoad: false,
                theme: "base",
                themeVariables: {
                    background: "transparent",
                    errorBkgColor: "#3b1d24",
                    errorTextColor: "#ff6677",
                    lineColor: "#aeb7c5",
                    mainBkg: "#1b2838",
                    nodeBorder: "#3b4c61",
                    primaryBorderColor: "#3b4c61",
                    primaryColor: "#1b2838",
                    primaryTextColor: "#f6f8fb",
                    secondaryBorderColor: "#3b4c61",
                    secondaryColor: "#152030",
                    tertiaryColor: "#101820",
                },
            },
        );
        expect(mermaid.render).toHaveBeenCalledWith(
            expect.stringMatching(/^markdown-mermaid-/),
            "flowchart TD\nA --> B",
        );
        expect(sanitizeSvg).toHaveBeenCalledWith(
            "<svg><script>alert('x')</script><text>Unsafe</text></svg>",
        );
        expect(renderedSvg.innerHTML).toContain("<text>Safe</text>");
        expect(renderedSvg.innerHTML).not.toContain("<script");
    });

    it("reinitializes Mermaid and rerenders diagrams when theme variables change", async () => {
        document.documentElement.style.setProperty("--color-bg-tertiary", "#101820");
        document.documentElement.style.setProperty("--color-border", "#3b4c61");
        document.documentElement.style.setProperty("--color-text-primary", "#f6f8fb");
        const renderDiagram = vi.fn(() =>
            Promise.resolve({ svg: "<svg><text>Themed diagram</text></svg>" }),
        );
        const mermaid = createMermaidRenderer(renderDiagram);
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
        });

        await waitForElement(container, ".markdown-file-preview__mermaid-svg");

        expect(mermaid.initialize).toHaveBeenCalledTimes(1);
        expect(renderDiagram).toHaveBeenCalledTimes(1);

        act(() => {
            document.documentElement.style.setProperty(
                "--color-bg-tertiary",
                "#223344",
            );
        });

        await waitForMockCallCount(renderDiagram, 2);

        expect(mermaid.initialize).toHaveBeenCalledTimes(2);
        const initializeCalls = (mermaid.initialize as unknown as MockCallTracker)
            .mock.calls;
        const lastInitializeConfig = initializeCalls.at(-1)?.[0] as
            | MermaidRendererInitializeConfig
            | undefined;

        expect(lastInitializeConfig?.themeVariables.mainBkg).toBe("#223344");
        expect(lastInitializeConfig?.themeVariables.primaryColor).toBe("#223344");
    });

    it("shows a stable error state when Mermaid rejects invalid syntax", async () => {
        const mermaid = createMermaidRenderer(
            vi.fn(() => Promise.reject(new Error("Parse error"))),
        );
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
        });

        await waitForText(container, "Could not render Mermaid diagram");

        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        expect(container.textContent).toContain(
            "Could not render Mermaid diagram",
        );
    });

    it("does not apply stale render results after the source changes", async () => {
        const pendingRenders: DeferredRender[] = [];
        const renderDiagram: MermaidRenderer["render"] = vi.fn(
            (_id: string, source: string) => {
                const deferred = createDeferredRender(source);
                pendingRenders.push(deferred);
                return deferred.promise;
            },
        );
        const mermaid = createMermaidRenderer(renderDiagram);
        const { container, rerender } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
            source: "flowchart TD\nA --> B",
        });

        await waitForText(container, "Rendering diagram...");
        expect(pendingRenders).toHaveLength(1);

        rerender({
            loadMermaid: () => Promise.resolve(mermaid),
            source: "flowchart TD\nB --> C",
        });

        await waitForText(container, "Rendering diagram...");
        expect(pendingRenders).toHaveLength(2);

        await act(async () => {
            pendingRenders[1]?.resolve({
                svg: "<svg><text>Second diagram</text></svg>",
            });
            await pendingRenders[1]?.promise;
        });

        await waitForText(container, "Second diagram");

        await act(async () => {
            pendingRenders[0]?.resolve({
                svg: "<svg><text>First diagram</text></svg>",
            });
            await pendingRenders[0]?.promise;
        });

        expect(container.textContent).toContain("Second diagram");
        expect(container.textContent).not.toContain("First diagram");
    });

    it("blocks sources over the Mermaid text limit before loading Mermaid", async () => {
        const loadMermaid = vi.fn(() =>
            Promise.resolve(createMermaidRenderer()),
        );
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid,
            source: "x".repeat(MERMAID_SOURCE_MAX_LENGTH + 1),
        });

        await waitForText(container, "Diagram source is too large to preview");

        expect(loadMermaid).not.toHaveBeenCalled();
    });

    it("removes dangerous SVG nodes and attributes from Mermaid output", () => {
        const sanitizedSvg = sanitizeMermaidSvg(
            [
                "<svg>",
                "<script>alert('x')</script>",
                '<a href="javascript:alert(1)">',
                '<text onclick="alert(2)">Label</text>',
                "</a>",
                "</svg>",
            ].join(""),
        );

        expect(sanitizedSvg).toContain("Label");
        expect(sanitizedSvg).not.toContain("<script");
        expect(sanitizedSvg).not.toContain("javascript:");
        expect(sanitizedSvg).not.toContain("onclick");
    });
});
