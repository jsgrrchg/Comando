/** @vitest-environment jsdom */
import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const virtualizerCalls = vi.hoisted(() => ({
    cleanUp: vi.fn(),
    setup: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
    Virtualizer: class {
        cleanUp = virtualizerCalls.cleanUp;
        setup = virtualizerCalls.setup;
    },
}));

vi.mock("@pierre/diffs/react", () => ({
    VirtualizerContext: createContext(undefined),
}));

import { PierreGitDiffVirtualizerProvider } from "./PierreGitDiffVirtualizerProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
    disconnect() {}
    observe() {}
}

class TestIntersectionObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
}

afterEach(() => {
    vi.unstubAllGlobals();
    virtualizerCalls.cleanUp.mockReset();
    virtualizerCalls.setup.mockReset();
});

describe("PierreGitDiffVirtualizerProvider", () => {
    it("uses Comando's scroll container as Pierre's virtualization root", () => {
        vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
        vi.stubGlobal("ResizeObserver", TestResizeObserver);

        const scrollContainer = document.createElement("div");
        const scrollContainerRef = { current: scrollContainer };
        const container = document.createElement("div");
        const root = createRoot(container);

        act(() => {
            root.render(
                <PierreGitDiffVirtualizerProvider
                    scrollContainerRef={scrollContainerRef}
                >
                    <div>Git diff</div>
                </PierreGitDiffVirtualizerProvider>,
            );
        });

        expect(virtualizerCalls.setup).toHaveBeenCalledOnce();
        expect(virtualizerCalls.setup.mock.calls[0]?.[0]).toBe(
            scrollContainer,
        );
        expect(virtualizerCalls.setup.mock.calls[0]?.[1]).toBeInstanceOf(
            HTMLDivElement,
        );

        act(() => root.unmount());
        expect(virtualizerCalls.cleanUp).toHaveBeenCalledOnce();
    });
});
