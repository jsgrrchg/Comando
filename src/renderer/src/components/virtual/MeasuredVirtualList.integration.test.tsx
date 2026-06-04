/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MeasuredVirtualList } from "./MeasuredVirtualList";

// Integration coverage for the scroll-anchor compensation (mechanism B in the
// resize hardening): when a row ABOVE the viewport re-measures to a new height,
// the list must nudge scrollTop by the delta so the visible content stays put.
// The pure math is unit-tested elsewhere; this drives the real component under
// react-dom so the effect ordering, ResizeObserver wiring, and the actual
// scrollTop mutation are exercised end to end.

const ITEM_HEIGHT = 20;
const VIEWPORT_HEIGHT = 100;

// jsdom has no layout engine and no ResizeObserver, so we drive measurements by
// hand: a fake observer records the elements the list observes and lets a test
// fire a contentRect height for any of them — exactly the channel the list uses
// for the virtualized measurement path.
interface FakeResizeEntry {
    readonly target: Element;
    readonly contentRect: { readonly height: number };
}

const observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
    private readonly callback: (entries: FakeResizeEntry[]) => void;
    readonly elements = new Set<Element>();

    constructor(callback: (entries: FakeResizeEntry[]) => void) {
        this.callback = callback;
        observers.push(this);
    }

    observe(element: Element) {
        this.elements.add(element);
    }

    unobserve(element: Element) {
        this.elements.delete(element);
    }

    disconnect() {
        this.elements.clear();
        const index = observers.indexOf(this);
        if (index >= 0) {
            observers.splice(index, 1);
        }
    }

    fire(element: Element, height: number) {
        if (this.elements.has(element)) {
            this.callback([{ target: element, contentRect: { height } }]);
        }
    }
}

// A real browser keeps an element's measured height and its ResizeObserver
// report in sync. The list re-measures via getBoundingClientRect on every
// render (its ref callback is a fresh closure each time), so the stub MUST
// reflect the latest "resized" height — otherwise a constant stub would revert
// a just-reported resize on the next render. This map is the single source of
// truth for both channels.
const heightByElement = new WeakMap<Element, number>();

function fireRowResize(element: Element, height: number) {
    heightByElement.set(element, height);
    for (const observer of observers) {
        observer.fire(element, height);
    }
}

interface Item {
    readonly id: string;
}

function createItems(count: number): Item[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `row-${index}`,
    }));
}

interface MountedList {
    readonly scrollContainer: HTMLElement;
    readonly mountNode: HTMLElement;
    readonly root: Root;
}

function mountList({
    items,
    overscan,
    preserveScrollAnchorOnMeasure,
}: {
    readonly items: readonly Item[];
    readonly overscan: number;
    readonly preserveScrollAnchorOnMeasure: boolean;
}): MountedList {
    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "clientHeight", {
        configurable: true,
        get: () => VIEWPORT_HEIGHT,
    });
    scrollContainer.scrollTop = 0;
    document.body.appendChild(scrollContainer);

    const mountNode = document.createElement("div");
    scrollContainer.appendChild(mountNode);

    const root = createRoot(mountNode);
    const scrollContainerRef = { current: scrollContainer };

    act(() => {
        root.render(
            <MeasuredVirtualList
                defaultViewportHeight={VIEWPORT_HEIGHT}
                estimateSize={() => ITEM_HEIGHT}
                getItemKey={(item) => item.id}
                items={items}
                overscan={overscan}
                preserveScrollAnchorOnMeasure={preserveScrollAnchorOnMeasure}
                scrollContainerRef={scrollContainerRef}
                scrollMarginTop={0}
                renderItem={({ index, item }) => (
                    <div data-idx={index}>{item.id}</div>
                )}
            />,
        );
    });

    return { scrollContainer, mountNode, root };
}

function scrollTo(list: MountedList, scrollTop: number) {
    act(() => {
        list.scrollContainer.scrollTop = scrollTop;
        list.scrollContainer.dispatchEvent(new Event("scroll"));
    });
}

function renderedIndexes(mountNode: HTMLElement): number[] {
    return [...mountNode.querySelectorAll("[data-idx]")]
        .map((element) => Number(element.getAttribute("data-idx")))
        .sort((left, right) => left - right);
}

// The element the list observes is the absolute-positioned wrapper, i.e. the
// parent of the row content we render.
function rowWrapper(mountNode: HTMLElement, index: number): Element {
    const content = mountNode.querySelector(`[data-idx="${index}"]`);
    if (!content?.parentElement) {
        throw new Error(`row ${index} is not rendered`);
    }
    return content.parentElement;
}

beforeEach(() => {
    (
        globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    (
        globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }
    ).ResizeObserver = FakeResizeObserver;

    // jsdom has no layout, so getBoundingClientRect() reports 0 — but the list
    // measures each row's height that way on attach (setMeasuredElement). Back
    // it with heightByElement so the initial layout matches a real render and a
    // fired resize stays reflected on subsequent re-measures.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function getBoundingClientRect(this: Element): DOMRect {
            const height = heightByElement.get(this) ?? ITEM_HEIGHT;
            return {
                height,
                width: 0,
                top: 0,
                left: 0,
                bottom: height,
                right: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            };
        },
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    observers.length = 0;
    document.body.innerHTML = "";
});

describe("MeasuredVirtualList scroll anchoring (integration)", () => {
    it("nudges scrollTop when a row above the viewport grows", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        // Scroll into the middle so there are rows rendered ABOVE the viewport
        // (the overscan band) whose re-measure should compensate.
        scrollTo(list, 300);

        const rendered = renderedIndexes(list.mountNode);
        const aboveIndex = rendered[0]; // overscan start, strictly above the top
        // Guard the premise: the fired row must really sit above the viewport.
        expect(aboveIndex).toBeLessThan(300 / ITEM_HEIGHT);

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 60);
        });

        // The row grew from its estimate (20) to 60 → +40, so scrollTop must
        // move from 300 to 340 to keep the same content under the viewport.
        expect(list.scrollContainer.scrollTop).toBe(300 + (60 - ITEM_HEIGHT));

        list.root.unmount();
    });

    it("shrinks scrollTop when a row above the viewport gets smaller", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);

        const aboveIndex = renderedIndexes(list.mountNode)[0];

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 8);
        });

        // 20 → 8 is -12, so scrollTop drops from 300 to 288.
        expect(list.scrollContainer.scrollTop).toBe(300 + (8 - ITEM_HEIGHT));

        list.root.unmount();
    });

    it("does not move scrollTop when a row inside the viewport re-measures", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);

        const rendered = renderedIndexes(list.mountNode);
        const belowIndex = rendered[rendered.length - 1]; // overscan end, in/after view

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, belowIndex), 120);
        });

        // A row at or below the top anchor must not shift the viewport.
        expect(list.scrollContainer.scrollTop).toBe(300);

        list.root.unmount();
    });

    it("leaves scrollTop untouched when preserveScrollAnchorOnMeasure is off", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: false,
        });

        scrollTo(list, 300);

        const aboveIndex = renderedIndexes(list.mountNode)[0];

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 60);
        });

        expect(list.scrollContainer.scrollTop).toBe(300);

        list.root.unmount();
    });
});
