/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from "vitest";

import {
    MeasuredVirtualList,
    resetMeasuredVirtualListMeasurementsForTests,
} from "./MeasuredVirtualList";

// Integration coverage for the virtualized measurement path under react-dom:
// the scroll-anchor compensation (a row above the viewport re-measures → scroll
// stays put), that a row attaches/measures exactly once instead of on every
// render, that the ResizeObserver's border-box size is the one used, and that a
// measurement-key churn on a reused node re-routes to the new key. The pure math
// is unit-tested elsewhere; this exercises the real effect ordering, the
// ResizeObserver wiring, and the actual scrollTop / layout mutations.

const ITEM_HEIGHT = 20;
const VIEWPORT_HEIGHT = 100;

// jsdom has no layout engine and no ResizeObserver, so we drive measurements by
// hand: a fake observer records the elements the list observes and lets a test
// fire a size for any of them. The list reads the border-box size (with a
// content-box fallback), so an entry carries both.
interface FakeResizeEntry {
    readonly target: Element;
    readonly borderBoxSize: readonly { readonly blockSize: number }[];
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

    // The list observes with { box: "border-box" }; the fake ignores the option
    // (extra call args are harmless at runtime), so it takes only the element.
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

    fire(element: Element, borderBoxHeight: number, contentHeight: number) {
        if (this.elements.has(element)) {
            this.callback([
                {
                    target: element,
                    borderBoxSize: [{ blockSize: borderBoxHeight }],
                    contentRect: { height: contentHeight },
                },
            ]);
        }
    }
}

// A real browser keeps an element's measured height (getBoundingClientRect, used
// once on attach) and its ResizeObserver report in sync. The stub backs
// getBoundingClientRect off this map so a fired resize stays reflected if the row
// is ever re-measured; fireRowResize updates it alongside firing the observer.
const heightByElement = new WeakMap<Element, number>();
const heightByListKey = new Map<string, number>();

function fireRowResize(
    element: Element,
    height: number,
    options?: { readonly contentHeight?: number },
) {
    heightByElement.set(element, height);
    const listKey = (element as HTMLElement).dataset.listKey;
    if (listKey) {
        heightByListKey.set(listKey, height);
    }
    const contentHeight = options?.contentHeight ?? height;
    for (const observer of observers) {
        observer.fire(element, height, contentHeight);
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

interface MountConfig {
    readonly estimateSize?: (item: Item, index: number) => number;
    readonly geometryCacheSignature?: string;
    readonly items: readonly Item[];
    readonly measurementCacheKey?: string;
    readonly observeMeasurements?: boolean;
    readonly overscan: number;
    readonly preserveScrollAnchorOnItemsChange?: boolean;
    readonly preserveScrollAnchorOnMeasure: boolean;
    readonly getItemMeasurementKey?: (item: Item, index: number) => string;
    readonly getItemIdentityKey?: (item: Item, index: number) => string;
    readonly shouldPreserveScrollAnchorOnMeasure?: () => boolean;
    readonly shouldPreserveScrollAnchorOnItemsChange?: () => boolean;
}

interface MountedList {
    readonly scrollContainer: HTMLElement;
    readonly mountNode: HTMLElement;
    readonly root: Root;
    readonly rerender: (next?: {
        readonly items?: readonly Item[];
        readonly getItemMeasurementKey?: (item: Item, index: number) => string;
        readonly observeMeasurements?: boolean;
    }) => void;
}

function mountList(config: MountConfig): MountedList {
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

    let currentItems = config.items;
    let currentMeasurementKey = config.getItemMeasurementKey;
    let currentObserveMeasurements = config.observeMeasurements;

    const element = () => (
        <MeasuredVirtualList
            defaultViewportHeight={VIEWPORT_HEIGHT}
            estimateSize={config.estimateSize ?? (() => ITEM_HEIGHT)}
            getItemIdentityKey={config.getItemIdentityKey}
            getItemKey={(item) => item.id}
            getItemMeasurementKey={currentMeasurementKey}
            geometryCacheSignature={config.geometryCacheSignature}
            items={currentItems}
            measurementCacheKey={config.measurementCacheKey}
            observeMeasurements={currentObserveMeasurements}
            overscan={config.overscan}
            preserveScrollAnchorOnItemsChange={
                config.preserveScrollAnchorOnItemsChange
            }
            preserveScrollAnchorOnMeasure={config.preserveScrollAnchorOnMeasure}
            shouldPreserveScrollAnchorOnItemsChange={
                config.shouldPreserveScrollAnchorOnItemsChange
            }
            shouldPreserveScrollAnchorOnMeasure={
                config.shouldPreserveScrollAnchorOnMeasure
            }
            scrollContainerRef={scrollContainerRef}
            scrollMarginTop={0}
            renderItem={({ index, item }) => (
                <div data-idx={index}>{item.id}</div>
            )}
        />
    );

    act(() => {
        root.render(element());
    });

    const rerender: MountedList["rerender"] = (next) => {
        if (next?.items) {
            currentItems = next.items;
        }
        if (next?.getItemMeasurementKey) {
            currentMeasurementKey = next.getItemMeasurementKey;
        }
        if (next?.observeMeasurements !== undefined) {
            currentObserveMeasurements = next.observeMeasurements;
        }
        act(() => {
            root.render(element());
        });
    };

    return { scrollContainer, mountNode, root, rerender };
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

function totalHeightPx(list: MountedList): string | undefined {
    const listRoot = list.mountNode.firstElementChild as HTMLElement | null;
    return listRoot?.style.height;
}

// Spy captured each test so call counts can be read without referencing the
// (unbound) prototype method.
let getBoundingClientRectSpy: MockInstance<() => DOMRect>;

// Number of getBoundingClientRect calls made against row wrappers (they carry a
// data-list-key). Equal to the number of attach measurements the list has done.
function rowMeasureCount(): number {
    return getBoundingClientRectSpy.mock.contexts.filter(
        (context) =>
            context instanceof HTMLElement &&
            context.dataset.listKey !== undefined,
    ).length;
}

beforeEach(() => {
    (
        globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetMeasuredVirtualListMeasurementsForTests();
    heightByListKey.clear();
    (
        globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }
    ).ResizeObserver = FakeResizeObserver;

    // jsdom has no layout, so getBoundingClientRect() reports 0 — but the list
    // measures each row's height that way on attach. Back it with heightByElement
    // so the initial layout matches a real render and a fired resize stays
    // reflected if the row is re-measured.
    getBoundingClientRectSpy = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function getBoundingClientRect(
        this: Element,
    ): DOMRect {
            const height =
                heightByElement.get(this) ??
                heightByListKey.get(
                    (this as HTMLElement).dataset.listKey ?? "",
                ) ??
                ITEM_HEIGHT;
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
        });
});

afterEach(() => {
    vi.restoreAllMocks();
    observers.length = 0;
    document.body.innerHTML = "";
});

describe("MeasuredVirtualList scroll anchoring (integration)", () => {
    it("expands the rendered buffer after a large scroll jump", () => {
        const list = mountList({
            items: createItems(500),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 3600);

        // A fixed overscan of 10 would keep roughly 25 rows mounted. The
        // velocity-aware buffer covers the next paint while momentum scrolling.
        expect(renderedIndexes(list.mountNode).length).toBeGreaterThan(80);

        list.root.unmount();
    });

    it("preserves a keyed viewport anchor when rows split above it", () => {
        const initialItems = createItems(60);
        const list = mountList({
            items: initialItems,
            overscan: 10,
            preserveScrollAnchorOnItemsChange: true,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);
        list.rerender({
            items: [
                { id: "group-before" },
                { id: "late-diff" },
                { id: "group-after" },
                ...initialItems.slice(1),
            ],
        });

        expect(list.scrollContainer.scrollTop).toBe(340);

        list.root.unmount();
    });

    it("leaves structural item changes to auto-follow when preservation is disabled", () => {
        const initialItems = createItems(60);
        const list = mountList({
            items: initialItems,
            overscan: 10,
            preserveScrollAnchorOnItemsChange: true,
            preserveScrollAnchorOnMeasure: true,
            shouldPreserveScrollAnchorOnItemsChange: () => false,
        });

        scrollTo(list, 300);
        list.rerender({
            items: [
                { id: "group-before" },
                { id: "late-diff" },
                { id: "group-after" },
                ...initialItems.slice(1),
            ],
        });

        expect(list.scrollContainer.scrollTop).toBe(300);

        list.root.unmount();
    });

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

    it("preserves the viewport through an expand-collapse cycle above it", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);
        const aboveIndex = renderedIndexes(list.mountNode)[0];

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 80);
        });
        expect(list.scrollContainer.scrollTop).toBe(360);

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), ITEM_HEIGHT);
        });
        expect(list.scrollContainer.scrollTop).toBe(300);

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

    it("leaves scrollTop untouched when the live preserve predicate is off", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
            shouldPreserveScrollAnchorOnMeasure: () => false,
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

describe("MeasuredVirtualList measurement wiring (integration)", () => {
    it("disconnects row measurement observers while a retained view is hidden", () => {
        const list = mountList({
            items: createItems(60),
            observeMeasurements: false,
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });
        const firstRow = rowWrapper(list.mountNode, 0);

        expect(
            observers.some((observer) => observer.elements.has(firstRow)),
        ).toBe(false);

        list.rerender({ observeMeasurements: true });

        expect(
            observers.some((observer) => observer.elements.has(firstRow)),
        ).toBe(true);
        list.root.unmount();
    });

    it("recomputes long-chat geometry when returning to an already open tab", () => {
        const items = createItems(5000);
        const estimateSize = vi.fn(() => ITEM_HEIGHT);
        const config = {
            estimateSize,
            geometryCacheSignature: "default",
            items,
            measurementCacheKey: "chat-timeline:session-a",
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        };
        const firstTab = mountList(config);

        act(() => {
            firstTab.root.unmount();
        });
        const otherTab = mountList({
            items: createItems(20),
            measurementCacheKey: "chat-timeline:session-b",
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });
        act(() => {
            otherTab.root.unmount();
        });

        estimateSize.mockClear();
        const returnedTab = mountList(config);

        // Returning to an already open tab reuses the base layout instead of
        // estimating every off-screen row before calculating the range.
        expect(estimateSize.mock.calls.length).toBeLessThan(100);

        act(() => {
            returnedTab.root.unmount();
        });
    });

    it("reuses measured row heights after remounting the same list", () => {
        const config = {
            items: createItems(60),
            measurementCacheKey: "chat-timeline:session-1",
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        };
        const firstMount = mountList(config);

        act(() => {
            fireRowResize(rowWrapper(firstMount.mountNode, 0), 60);
        });
        expect(totalHeightPx(firstMount)).toBe("1240px");
        act(() => {
            firstMount.root.unmount();
        });

        const secondMount = mountList(config);

        // The cached measurement is applied before the newly mounted rows are
        // observed, avoiding the estimate → measured layout correction.
        expect(totalHeightPx(secondMount)).toBe("1240px");
        act(() => {
            secondMount.root.unmount();
        });
    });

    it("measures each row once on attach, not on every render", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);
        const afterScroll = rowMeasureCount();
        expect(afterScroll).toBeGreaterThan(0); // rows attached and measured

        // Re-render with no row changes. The row ref is stable, so React must not
        // detach/reattach it, and no row is re-measured. An inline-closure ref
        // (the pre-fix behavior) would re-measure every visible row per render.
        list.rerender();
        list.rerender();

        expect(rowMeasureCount()).toBe(afterScroll);

        list.root.unmount();
    });

    it("uses the ResizeObserver border-box size, not the content-box rect", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
        });

        scrollTo(list, 300);
        const aboveIndex = renderedIndexes(list.mountNode)[0];

        // Border-box 60 but a divergent content-box 999. The list must use the
        // border-box value so it matches its getBoundingClientRect channel.
        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 60, {
                contentHeight: 999,
            });
        });

        // Compensation uses 60 (border-box): 300 + (60 - 20) = 340. A content-box
        // read would have moved it to 300 + (999 - 20).
        expect(list.scrollContainer.scrollTop).toBe(340);

        list.root.unmount();
    });

    it("re-routes measurements to the new key when a reused row's measurement key churns", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
            getItemMeasurementKey: (item) => `${item.id}:v1`,
            // Width-invariant identity, stable across the churn, so the row keeps
            // its measured height via carry-over instead of snapping to estimate.
            getItemIdentityKey: (item) => item.id,
        });

        scrollTo(list, 300);
        const aboveIndex = renderedIndexes(list.mountNode)[0];

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 60);
        });
        // One row measured 20 → 60 grows the total by 40 (60 rows × 20 = 1200).
        expect(totalHeightPx(list)).toBe("1240px");

        // Churn every row's measurement key while reusing the same DOM nodes.
        list.rerender({ getItemMeasurementKey: (item) => `${item.id}:v2` });
        // Carry-over keeps the row at 60 across the churn.
        expect(totalHeightPx(list)).toBe("1240px");

        // A resize after the churn must land on the new key (:v2). If the
        // observer were still keyed to :v1, this 80 would be dropped and the
        // total would stay 1240.
        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 80);
        });
        expect(totalHeightPx(list)).toBe("1260px");

        list.root.unmount();
    });

    it("measures mounted rows under a fresh key even without a resize event", () => {
        const list = mountList({
            items: createItems(60),
            overscan: 10,
            preserveScrollAnchorOnMeasure: true,
            getItemMeasurementKey: (item) => `${item.id}:running`,
        });

        scrollTo(list, 300);
        const aboveIndex = renderedIndexes(list.mountNode)[0];

        act(() => {
            fireRowResize(rowWrapper(list.mountNode, aboveIndex), 8);
        });
        expect(totalHeightPx(list)).toBe("1188px");

        // This mirrors a chat tool moving from in_progress to completed: the row
        // object/key changes, React reuses the same list-keyed DOM node, and the
        // compact card's physical height stays unchanged. Without an explicit
        // mounted-node re-measure, the new key falls back to the rough estimate
        // and leaves blank space until a later scroll remounts the row.
        list.rerender({
            getItemMeasurementKey: (item) => `${item.id}:completed`,
        });

        expect(totalHeightPx(list)).toBe("1188px");

        list.root.unmount();
    });
});
