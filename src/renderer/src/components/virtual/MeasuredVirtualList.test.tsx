import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    calculateMeasuredVirtualScrollAnchorAdjustment,
    calculateMeasuredVirtualRange,
    calculateMeasuredVirtualScrollTop,
    MeasuredVirtualList,
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
