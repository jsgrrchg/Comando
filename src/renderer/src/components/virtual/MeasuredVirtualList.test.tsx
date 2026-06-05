import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    calculateMeasuredVirtualScrollAnchorAdjustment,
    calculateMeasuredVirtualRange,
    calculateMeasuredVirtualScrollTop,
    MeasuredVirtualList,
    pruneMeasuredSizesToKeys,
    resolvePreviousMeasuredSize,
} from "./MeasuredVirtualList";

const ITEM_HEIGHT = 20;
const VIEWPORT_HEIGHT = 100;

function createItems(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `Item ${index}`);
}

function createOffsets(count: number): number[] {
    return Array.from({ length: count }, (_, index) => index * ITEM_HEIGHT);
}

function createSizes(count: number): number[] {
    return Array.from({ length: count }, () => ITEM_HEIGHT);
}

describe("MeasuredVirtualList", () => {
    it("keeps the existing visible range behavior without a scroll margin", () => {
        expect(
            calculateMeasuredVirtualRange({
                itemCount: 100,
                offsets: createOffsets(100),
                overscan: 0,
                scrollMarginTop: 0,
                scrollTop: 0,
                sizes: createSizes(100),
                viewportHeight: VIEWPORT_HEIGHT,
                virtualizationEnabled: true,
            }),
        ).toEqual({
            endIndex: 4,
            startIndex: 0,
            visibleEndIndex: 4,
            visibleStartIndex: 0,
        });

        expect(
            calculateMeasuredVirtualRange({
                itemCount: 100,
                offsets: createOffsets(100),
                overscan: 0,
                scrollMarginTop: 0,
                scrollTop: 60,
                sizes: createSizes(100),
                viewportHeight: VIEWPORT_HEIGHT,
                virtualizationEnabled: true,
            }),
        ).toEqual({
            endIndex: 7,
            startIndex: 3,
            visibleEndIndex: 7,
            visibleStartIndex: 3,
        });
    });

    it("subtracts scrollMarginTop when calculating the visible range", () => {
        expect(
            calculateMeasuredVirtualRange({
                itemCount: 100,
                offsets: createOffsets(100),
                overscan: 0,
                scrollMarginTop: 40,
                scrollTop: 60,
                sizes: createSizes(100),
                viewportHeight: VIEWPORT_HEIGHT,
                virtualizationEnabled: true,
            }),
        ).toEqual({
            endIndex: 5,
            startIndex: 1,
            visibleEndIndex: 5,
            visibleStartIndex: 1,
        });
    });

    it("positions scrollToIndex targets below the scroll margin", () => {
        expect(
            calculateMeasuredVirtualScrollTop({
                align: "start",
                itemSize: ITEM_HEIGHT,
                itemStart: 10 * ITEM_HEIGHT,
                offset: 0,
                scrollMarginTop: 40,
                totalSize: 100 * ITEM_HEIGHT,
                viewportHeight: VIEWPORT_HEIGHT,
            }),
        ).toBe(240);
    });

    it("clamps centered and end-aligned scroll targets to the virtual size", () => {
        expect(
            calculateMeasuredVirtualScrollTop({
                align: "center",
                itemSize: ITEM_HEIGHT,
                itemStart: 0,
                offset: 0,
                scrollMarginTop: 40,
                totalSize: 100 * ITEM_HEIGHT,
                viewportHeight: VIEWPORT_HEIGHT,
            }),
        ).toBe(0);

        expect(
            calculateMeasuredVirtualScrollTop({
                align: "end",
                itemSize: ITEM_HEIGHT,
                itemStart: 99 * ITEM_HEIGHT,
                offset: 0,
                scrollMarginTop: 40,
                totalSize: 100 * ITEM_HEIGHT,
                viewportHeight: VIEWPORT_HEIGHT,
            }),
        ).toBe(1940);
    });

    it("reports the full range when virtualization is disabled", () => {
        expect(
            calculateMeasuredVirtualRange({
                itemCount: 10,
                offsets: createOffsets(10),
                overscan: 0,
                scrollMarginTop: 40,
                scrollTop: 60,
                sizes: createSizes(10),
                viewportHeight: VIEWPORT_HEIGHT,
                virtualizationEnabled: false,
            }),
        ).toEqual({
            endIndex: 9,
            startIndex: 0,
            visibleEndIndex: 9,
            visibleStartIndex: 0,
        });
    });

    it("calculates scroll anchoring adjustments only for measured rows above the viewport", () => {
        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex: 3,
                nextSize: 52,
                preserveScrollAnchorOnMeasure: true,
                previousSize: 20,
                virtualizationEnabled: true,
                visibleStartIndex: 5,
            }),
        ).toBe(32);

        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex: 3,
                nextSize: 12,
                preserveScrollAnchorOnMeasure: true,
                previousSize: 20,
                virtualizationEnabled: true,
                visibleStartIndex: 5,
            }),
        ).toBe(-8);

        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex: 5,
                nextSize: 52,
                preserveScrollAnchorOnMeasure: true,
                previousSize: 20,
                virtualizationEnabled: true,
                visibleStartIndex: 5,
            }),
        ).toBe(0);

        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex: 3,
                nextSize: 52,
                preserveScrollAnchorOnMeasure: false,
                previousSize: 20,
                virtualizationEnabled: true,
                visibleStartIndex: 5,
            }),
        ).toBe(0);
    });

    it("renders every item during server rendering", () => {
        const markup = renderToStaticMarkup(
            <MeasuredVirtualList
                defaultViewportHeight={VIEWPORT_HEIGHT}
                estimateSize={() => ITEM_HEIGHT}
                getItemKey={(item) => item}
                items={createItems(5)}
                renderItem={({ index, item }) => (
                    <div data-row-index={index}>{item}</div>
                )}
                scrollContainerRef={{ current: null }}
            />,
        );

        expect(markup).toContain("Item 0");
        expect(markup).toContain("Item 4");
        expect(markup.match(/data-row-index=/g)).toHaveLength(5);
    });
});

describe("resolvePreviousMeasuredSize", () => {
    const items = createItems(10);
    const estimateSize = () => ITEM_HEIGHT;
    const indexByKey = new Map(
        items.map((_, index) => [`key-${index}`, index]),
    );

    it("uses the existing measured size when the key was already measured", () => {
        const { itemIndex, previousKnownSize } = resolvePreviousMeasuredSize({
            estimateSize,
            fallbackSize: 80,
            itemIndexByMeasurementKey: indexByKey,
            items,
            key: "key-3",
            previousMeasuredSize: 52,
        });

        expect(itemIndex).toBe(3);
        expect(previousKnownSize).toBe(52);
    });

    it("falls back to the row estimate for a freshly-keyed row the layout has not measured", () => {
        // This is the re-key case (expansion/font/resize): the new key is in the
        // current index map but not yet in measuredSizes, so the layout is
        // showing the row at its estimate. The estimate must be the baseline so
        // the caller computes a real anchor delta against the new measurement.
        const { itemIndex, previousKnownSize } = resolvePreviousMeasuredSize({
            estimateSize,
            fallbackSize: 90,
            itemIndexByMeasurementKey: indexByKey,
            items,
            key: "key-4",
            previousMeasuredSize: undefined,
        });

        expect(itemIndex).toBe(4);
        expect(previousKnownSize).toBe(ITEM_HEIGHT);

        // The resolved values feed a non-zero compensation for a row above the
        // viewport — exactly what a stale index map (itemIndex = -1) would drop.
        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex,
                nextSize: 90,
                preserveScrollAnchorOnMeasure: true,
                previousSize: previousKnownSize,
                virtualizationEnabled: true,
                visibleStartIndex: 6,
            }),
        ).toBe(90 - ITEM_HEIGHT);
    });

    it("prefers the last identity measurement over the estimate after a width re-key", () => {
        // The resize case: the row's measurement key churned (new width bucket),
        // so previousMeasuredSize is undefined, but the layout is showing the
        // row at its last real measurement carried over by identity. That height
        // — not the heuristic estimate — must be the compensation baseline.
        const { itemIndex, previousKnownSize } = resolvePreviousMeasuredSize({
            estimateSize,
            fallbackSize: 90,
            itemIndexByMeasurementKey: indexByKey,
            items,
            key: "key-4",
            previousMeasuredSize: undefined,
            previousIdentitySize: 130,
        });

        expect(itemIndex).toBe(4);
        expect(previousKnownSize).toBe(130);

        // The compensation is computed against the carried-over height, so a row
        // above the viewport that re-measures from 130 to 96 nudges the scroll by
        // the real delta rather than a spurious estimate-vs-measurement jump.
        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex,
                nextSize: 96,
                preserveScrollAnchorOnMeasure: true,
                previousSize: previousKnownSize,
                virtualizationEnabled: true,
                visibleStartIndex: 6,
            }),
        ).toBe(96 - 130);
    });

    it("degrades to the fallback size when the key is absent from the index map", () => {
        // A stale index map (the bug this guards against) makes the lookup miss:
        // itemIndex = -1 and previousKnownSize collapses onto the measurement, so
        // the anchor adjustment below is silently zeroed for the above-viewport
        // row that actually changed height.
        const { itemIndex, previousKnownSize } = resolvePreviousMeasuredSize({
            estimateSize,
            fallbackSize: 90,
            itemIndexByMeasurementKey: indexByKey,
            items,
            key: "key-unknown",
            previousMeasuredSize: undefined,
        });

        expect(itemIndex).toBe(-1);
        expect(previousKnownSize).toBe(90);

        expect(
            calculateMeasuredVirtualScrollAnchorAdjustment({
                itemIndex,
                nextSize: 90,
                preserveScrollAnchorOnMeasure: true,
                previousSize: previousKnownSize,
                virtualizationEnabled: true,
                visibleStartIndex: 6,
            }),
        ).toBe(0);
    });
});

describe("pruneMeasuredSizesToKeys", () => {
    it("drops entries whose keys are no longer valid", () => {
        const sizes = new Map([
            ["a", 10],
            ["b", 20],
            ["c", 30],
        ]);

        const result = pruneMeasuredSizesToKeys(sizes, new Set(["a", "c"]));

        expect([...result.entries()]).toEqual([
            ["a", 10],
            ["c", 30],
        ]);
    });

    it("returns the same reference when nothing is stale", () => {
        const sizes = new Map([
            ["a", 10],
            ["b", 20],
        ]);

        // Lets the caller skip the state update when there is nothing to prune.
        expect(pruneMeasuredSizesToKeys(sizes, new Set(["a", "b", "c"]))).toBe(
            sizes,
        );
    });

    it("never mutates the input map", () => {
        const sizes = new Map([
            ["a", 10],
            ["b", 20],
        ]);

        pruneMeasuredSizesToKeys(sizes, new Set(["a"]));

        expect([...sizes.entries()]).toEqual([
            ["a", 10],
            ["b", 20],
        ]);
    });

    it("returns a fresh empty map when no key survives", () => {
        const sizes = new Map([["a", 10]]);

        const result = pruneMeasuredSizesToKeys(sizes, new Set());

        expect(result.size).toBe(0);
        expect(result).not.toBe(sizes);
    });
});
