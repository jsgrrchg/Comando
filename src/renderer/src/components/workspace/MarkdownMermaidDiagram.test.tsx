/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    calculateMermaidFitScale,
    calculateNextMermaidZoom,
    clampMermaidZoom,
    createMermaidFitViewportState,
    MarkdownMermaidDiagram,
    MERMAID_SOURCE_MAX_LENGTH,
    MERMAID_VIEWPORT_MAX_ZOOM,
    MERMAID_VIEWPORT_MIN_ZOOM,
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
    "--color-bg-elevated",
    "--color-border",
    "--color-border-strong",
    "--color-accent",
    "--color-accent-strong",
    "--color-danger-bg",
    "--color-danger",
    "--color-text-primary",
    "--color-text-secondary",
    "--diff-add",
    "--diff-remove",
    "--diff-update",
    "--diff-warn",
] as const;

type MockCallTracker = {
    readonly mock: {
        readonly calls: readonly (readonly unknown[])[];
    };
};

interface MermaidRendererInitializeConfig {
    readonly deterministicIds: boolean;
    readonly flowchart: {
        readonly htmlLabels: boolean;
        readonly useMaxWidth: boolean;
    };
    readonly htmlLabels: boolean;
    readonly logLevel: "error";
    readonly maxEdges: number;
    readonly maxTextSize: number;
    readonly secure: readonly string[];
    readonly securityLevel: "strict";
    readonly startOnLoad: boolean;
    readonly suppressErrorRendering: boolean;
    readonly theme: "base";
    readonly themeVariables: {
        readonly mainBkg: string;
        readonly primaryColor: string;
        readonly [key: string]: unknown;
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

async function waitForElementStyle(
    container: HTMLElement,
    selector: string,
    expectedStyleText: string,
): Promise<HTMLElement> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const element = container.querySelector<HTMLElement>(selector);
        if (element?.getAttribute("style")?.includes(expectedStyleText)) {
            return element;
        }

        await act(async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
    }

    throw new Error(
        `Expected selector "${selector}" to include style "${expectedStyleText}".`,
    );
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
    it("clamps Mermaid viewport zoom to the supported range", () => {
        expect(clampMermaidZoom(0)).toBe(MERMAID_VIEWPORT_MIN_ZOOM);
        expect(clampMermaidZoom(0.5)).toBe(0.5);
        expect(clampMermaidZoom(Number.NaN)).toBe(1);
        expect(clampMermaidZoom(9)).toBe(MERMAID_VIEWPORT_MAX_ZOOM);
    });

    it("calculates the next Mermaid viewport zoom step", () => {
        expect(calculateNextMermaidZoom({ direction: 1, scale: 0.5 })).toBe(0.7);
        expect(calculateNextMermaidZoom({ direction: -1, scale: 0.7 })).toBe(0.5);
        expect(calculateNextMermaidZoom({ direction: -1, scale: 0.3 })).toBe(
            MERMAID_VIEWPORT_MIN_ZOOM,
        );
        expect(calculateNextMermaidZoom({ direction: 1, scale: 2.9 })).toBe(
            MERMAID_VIEWPORT_MAX_ZOOM,
        );
    });

    it("calculates a fit scale without enlarging small diagrams", () => {
        expect(
            calculateMermaidFitScale({
                diagram: { height: 600, width: 1200 },
                viewport: { height: 300, width: 600 },
            }),
        ).toBe(0.5);
        expect(
            calculateMermaidFitScale({
                diagram: { height: 120, width: 220 },
                viewport: { height: 300, width: 600 },
            }),
        ).toBe(1);
    });

    it("creates a fitted viewport state with a reset offset", () => {
        expect(
            createMermaidFitViewportState({
                diagram: { height: 600, width: 1200 },
                viewport: { height: 300, width: 600 },
            }),
        ).toEqual({
            fitScale: 0.5,
            isDragging: false,
            offsetX: 0,
            offsetY: 0,
            scale: 0.5,
        });
    });

    it("renders a valid diagram with sanitized SVG output", async () => {
        document.documentElement.style.setProperty("--color-bg-primary", "#101820");
        document.documentElement.style.setProperty("--color-bg-secondary", "#152030");
        document.documentElement.style.setProperty("--color-bg-tertiary", "#1b2838");
        document.documentElement.style.setProperty("--color-bg-elevated", "#243244");
        document.documentElement.style.setProperty("--color-border", "#3b4c61");
        document.documentElement.style.setProperty("--color-border-strong", "#4d617a");
        document.documentElement.style.setProperty("--color-accent", "#8aa4ff");
        document.documentElement.style.setProperty("--color-accent-strong", "#a9bcff");
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
        const initializeCalls = (mermaid.initialize as unknown as MockCallTracker)
            .mock.calls;
        const initializeConfig = initializeCalls[0]?.[0] as
            | MermaidRendererInitializeConfig
            | undefined;

        expect(initializeConfig).toMatchObject({
            deterministicIds: true,
            flowchart: {
                htmlLabels: false,
                useMaxWidth: true,
            },
            htmlLabels: false,
            logLevel: "error",
            maxEdges: 500,
            maxTextSize: MERMAID_SOURCE_MAX_LENGTH,
            secure: [
                "flowchart",
                "htmlLabels",
                "maxEdges",
                "maxTextSize",
                "secure",
                "securityLevel",
                "startOnLoad",
                "suppressErrorRendering",
                "theme",
                "themeCSS",
                "themeVariables",
            ],
            securityLevel: "strict",
            startOnLoad: false,
            suppressErrorRendering: false,
            theme: "base",
        });
        expect(initializeConfig?.themeVariables).toMatchObject({
            actorBkg: "#243244",
            actorTextColor: "#f6f8fb",
            background: "transparent",
            classText: "#f6f8fb",
            errorBkgColor: "#fee2e2",
            errorTextColor: "#ff6677",
            lineColor: "#aeb7c5",
            mainBkg: "#243244",
            nodeBorder: "#3b4c61",
            nodeBkg: "#243244",
            nodeTextColor: "#f6f8fb",
            primaryBorderColor: "#3b4c61",
            primaryColor: "#243244",
            primaryTextColor: "#f6f8fb",
            secondaryBorderColor: "#3b4c61",
            secondaryColor: "#152030",
            tertiaryColor: "#1b2838",
            textColor: "#f6f8fb",
        });
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
        document.documentElement.style.setProperty("--color-bg-elevated", "#101820");
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
                "--color-bg-elevated",
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

    it("fits rendered SVGs to the viewport and resets fit after source changes", async () => {
        const getBoundingClientRect = vi
            .spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function getMockBounds(this: HTMLElement) {
                if (
                    this.classList.contains(
                        "markdown-file-preview__mermaid-viewport",
                    )
                ) {
                    return {
                        bottom: 250,
                        height: 250,
                        left: 0,
                        right: 500,
                        toJSON: () => ({}),
                        top: 0,
                        width: 500,
                        x: 0,
                        y: 0,
                    };
                }

                return {
                    bottom: 0,
                    height: 0,
                    left: 0,
                    right: 0,
                    toJSON: () => ({}),
                    top: 0,
                    width: 0,
                    x: 0,
                    y: 0,
                };
            });
        const renderDiagram: MermaidRenderer["render"] = vi.fn(
            (_id: string, source: string) =>
                Promise.resolve({
                    svg: source.includes("B --> C")
                        ? '<svg viewBox="0 0 200 100"><text>Small diagram</text></svg>'
                        : '<svg viewBox="0 0 1000 400"><text>Large diagram</text></svg>',
                }),
        );
        const mermaid = createMermaidRenderer(renderDiagram);
        const { container, rerender } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
            source: "flowchart TD\nA --> B",
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.5)",
        );

        rerender({
            loadMermaid: () => Promise.resolve(mermaid),
            source: "flowchart TD\nB --> C",
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(1)",
        );

        expect(renderDiagram).toHaveBeenCalledTimes(2);
        getBoundingClientRect.mockRestore();
    });

    it("shows zoom controls only after rendering a diagram", async () => {
        const deferredRender = createDeferredRender("flowchart TD\nA --> B");
        const mermaid = createMermaidRenderer(() => deferredRender.promise);
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
        });

        await waitForText(container, "Rendering diagram...");

        expect(
            container.querySelector('[aria-label="Mermaid zoom controls"]'),
        ).toBeNull();
        expect(container.querySelector('[aria-label="Zoom in"]')).toBeNull();

        await act(async () => {
            deferredRender.resolve({
                svg: "<svg><text>Rendered diagram</text></svg>",
            });
            await deferredRender.promise;
        });

        await waitForElement(container, ".markdown-file-preview__mermaid-svg");

        expect(
            container.querySelector('[aria-label="Mermaid zoom controls"]'),
        ).not.toBeNull();
        expect(
            container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')
                ?.title,
        ).toBe("Zoom out");
        expect(
            container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
                ?.title,
        ).toBe("Zoom in");
        expect(
            container.querySelector<HTMLButtonElement>(
                '[aria-label="Fit diagram"]',
            )?.title,
        ).toBe("Fit diagram");
        expect(container.textContent).toContain("100%");
    });

    it("updates Mermaid viewport scale from zoom controls", async () => {
        const getBoundingClientRect = vi
            .spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function getMockBounds(this: HTMLElement) {
                if (
                    this.classList.contains(
                        "markdown-file-preview__mermaid-viewport",
                    )
                ) {
                    return {
                        bottom: 250,
                        height: 250,
                        left: 0,
                        right: 500,
                        toJSON: () => ({}),
                        top: 0,
                        width: 500,
                        x: 0,
                        y: 0,
                    };
                }

                return {
                    bottom: 0,
                    height: 0,
                    left: 0,
                    right: 0,
                    toJSON: () => ({}),
                    top: 0,
                    width: 0,
                    x: 0,
                    y: 0,
                };
            });
        const mermaid = createMermaidRenderer(() =>
            Promise.resolve({
                svg: '<svg viewBox="0 0 1000 400"><text>Large diagram</text></svg>',
            }),
        );
        const { container } = renderMarkdownMermaidDiagram({
            loadMermaid: () => Promise.resolve(mermaid),
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.5)",
        );

        const zoomInButton = container.querySelector<HTMLButtonElement>(
            '[aria-label="Zoom in"]',
        );
        const zoomOutButton = container.querySelector<HTMLButtonElement>(
            '[aria-label="Zoom out"]',
        );
        const fitButton = container.querySelector<HTMLButtonElement>(
            '[aria-label="Fit diagram"]',
        );

        expect(zoomInButton).not.toBeNull();
        expect(zoomOutButton).not.toBeNull();
        expect(fitButton).not.toBeNull();
        expect(container.textContent).toContain("50%");

        act(() => {
            zoomInButton?.click();
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.7)",
        );
        expect(container.textContent).toContain("70%");

        act(() => {
            zoomOutButton?.click();
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.5)",
        );
        expect(container.textContent).toContain("50%");

        act(() => {
            zoomInButton?.click();
        });
        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.7)",
        );

        act(() => {
            fitButton?.click();
        });

        await waitForElementStyle(
            container,
            ".markdown-file-preview__mermaid-svg",
            "scale(0.5)",
        );
        expect(container.textContent).toContain("50%");
        getBoundingClientRect.mockRestore();
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

    it("removes foreignObject labels from sanitized SVG output", () => {
        const sanitizedSvg = sanitizeMermaidSvg(
            [
                "<svg>",
                "<foreignObject>",
                "<div>HTML label</div>",
                "</foreignObject>",
                "<text>SVG label</text>",
                "</svg>",
            ].join(""),
        );

        expect(sanitizedSvg).toContain("SVG label");
        expect(sanitizedSvg).not.toContain("foreignObject");
        expect(sanitizedSvg).not.toContain("HTML label");
    });
});
