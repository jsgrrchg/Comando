/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SplitHandle } from "./SplitHandle";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    if (root) {
        act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
});

describe("SplitHandle", () => {
    it("exposes its range and supports Home and End", () => {
        const onMinimum = vi.fn();
        const onMaximum = vi.fn();
        const separator = renderHandle({ onMaximum, onMinimum });

        expect(separator.getAttribute("aria-valuemin")).toBe("220");
        expect(separator.getAttribute("aria-valuemax")).toBe("420");
        expect(separator.getAttribute("aria-valuenow")).toBe("280");

        pressKey(separator, "Home");
        pressKey(separator, "End");
        expect(onMinimum).toHaveBeenCalledOnce();
        expect(onMaximum).toHaveBeenCalledOnce();
    });

    it("maps horizontal arrows to the physical right panel edge", () => {
        const onDecrease = vi.fn();
        const onIncrease = vi.fn();
        const separator = renderHandle({
            onDecrease,
            onIncrease,
            side: "right",
        });

        pressKey(separator, "ArrowLeft");
        pressKey(separator, "ArrowRight");
        expect(onIncrease).toHaveBeenCalledOnce();
        expect(onDecrease).toHaveBeenCalledOnce();
    });
});

function renderHandle(
    overrides: Partial<Parameters<typeof SplitHandle>[0]>,
): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root?.render(
            createElement(SplitHandle, {
                label: "Resize navigator",
                max: 420,
                min: 220,
                onDecrease: vi.fn(),
                onIncrease: vi.fn(),
                onMaximum: vi.fn(),
                onMinimum: vi.fn(),
                onPointerDown: vi.fn(),
                side: "left",
                value: 280,
                ...overrides,
            }),
        );
    });
    const separator = container.querySelector<HTMLDivElement>(
        '[role="separator"]',
    );
    if (!separator) {
        throw new Error("Expected the split handle separator.");
    }
    return separator;
}

function pressKey(element: HTMLElement, key: string): void {
    act(() => {
        element.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key }),
        );
    });
}
