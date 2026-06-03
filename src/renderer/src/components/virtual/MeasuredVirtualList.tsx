import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

const DEFAULT_OVERSCAN = 4;
const DEFAULT_VIEWPORT_HEIGHT = 720;

export interface MeasuredVirtualRange {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly visibleStartIndex: number;
    readonly visibleEndIndex: number;
}

export interface MeasuredVirtualViewportAnchor {
    readonly index: number;
    readonly key: string;
    readonly offset: number;
}

export interface MeasuredVirtualListHandle {
    readonly captureViewportAnchor?: () => MeasuredVirtualViewportAnchor | null;
    readonly scrollToIndex: (
        index: number,
        options?: {
            readonly align?: "center" | "end" | "start";
            readonly offset?: number;
        },
    ) => void;
    readonly scrollToViewportAnchor?: (
        anchor: MeasuredVirtualViewportAnchor,
    ) => void;
}

export interface MeasuredVirtualListProps<T> {
    readonly items: readonly T[];
    readonly enabled?: boolean;
    readonly overscan?: number;
    readonly defaultViewportHeight?: number;
    readonly scrollMarginTop?: number;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
    readonly estimateSize: (item: T, index: number) => number;
    readonly getItemKey: (item: T, index: number) => string;
    readonly getItemMeasurementKey?: (item: T, index: number) => string;
    readonly onRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onReady?: (handle: MeasuredVirtualListHandle | null) => void;
    readonly preserveScrollAnchorOnMeasure?: boolean;
    readonly renderItem: (params: {
        readonly index: number;
        readonly isVisible: boolean;
        readonly item: T;
    }) => ReactNode;
}

interface MeasuredVirtualItem<T> {
    readonly index: number;
    readonly isVisible: boolean;
    readonly item: T;
    readonly key: string;
    readonly measurementKey: string;
    readonly size: number;
    readonly start: number;
}

interface LayoutSnapshot<T> {
    readonly range: MeasuredVirtualRange;
    readonly totalSize: number;
    readonly virtualItems: readonly MeasuredVirtualItem<T>[];
}

interface CalculateMeasuredVirtualRangeOptions {
    readonly itemCount: number;
    readonly offsets: readonly number[];
    readonly overscan: number;
    readonly scrollMarginTop: number;
    readonly scrollTop: number;
    readonly sizes: readonly number[];
    readonly viewportHeight: number;
    readonly virtualizationEnabled: boolean;
}

interface CalculateMeasuredVirtualScrollTopOptions {
    readonly align: "center" | "end" | "start";
    readonly itemSize: number;
    readonly itemStart: number;
    readonly offset: number;
    readonly scrollMarginTop: number;
    readonly totalSize: number;
    readonly viewportHeight: number;
}

interface CalculateMeasuredVirtualScrollAnchorAdjustmentOptions {
    readonly itemIndex: number;
    readonly nextSize: number;
    readonly preserveScrollAnchorOnMeasure: boolean;
    readonly previousSize: number;
    readonly virtualizationEnabled: boolean;
    readonly visibleStartIndex: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function normalizeMeasuredVirtualSize(value: number): number {
    if (!Number.isFinite(value)) {
        return 1;
    }

    return Math.max(1, Math.ceil(value));
}

function areRangesEqual(
    left: MeasuredVirtualRange | null,
    right: MeasuredVirtualRange,
): boolean {
    return (
        left !== null &&
        left.startIndex === right.startIndex &&
        left.endIndex === right.endIndex &&
        left.visibleStartIndex === right.visibleStartIndex &&
        left.visibleEndIndex === right.visibleEndIndex
    );
}

function findFirstVisibleIndex(
    offsets: readonly number[],
    sizes: readonly number[],
    scrollTop: number,
): number {
    let low = 0;
    let high = offsets.length - 1;
    let result = offsets.length;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const end = offsets[mid] + sizes[mid];

        if (end > scrollTop) {
            result = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return result;
}

function findLastVisibleIndex(
    offsets: readonly number[],
    scrollBottom: number,
): number {
    let low = 0;
    let high = offsets.length - 1;
    let result = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (offsets[mid] < scrollBottom) {
            result = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return result;
}

export function calculateMeasuredVirtualRange({
    itemCount,
    offsets,
    overscan,
    scrollMarginTop,
    scrollTop,
    sizes,
    viewportHeight,
    virtualizationEnabled,
}: CalculateMeasuredVirtualRangeOptions): MeasuredVirtualRange {
    if (itemCount === 0) {
        return {
            endIndex: -1,
            startIndex: 0,
            visibleEndIndex: -1,
            visibleStartIndex: 0,
        };
    }

    if (!virtualizationEnabled) {
        const endIndex = itemCount - 1;

        return {
            endIndex,
            startIndex: 0,
            visibleEndIndex: endIndex,
            visibleStartIndex: 0,
        };
    }

    const effectiveScrollTop = Math.max(0, scrollTop - scrollMarginTop);
    const scrollBottom = effectiveScrollTop + Math.max(1, viewportHeight);
    const firstVisibleIndex = findFirstVisibleIndex(
        offsets,
        sizes,
        effectiveScrollTop,
    );
    const lastVisibleIndex = findLastVisibleIndex(offsets, scrollBottom);
    const visibleStartIndex =
        firstVisibleIndex >= itemCount ? itemCount - 1 : firstVisibleIndex;
    const visibleEndIndex = clamp(
        lastVisibleIndex,
        visibleStartIndex,
        itemCount - 1,
    );
    const startIndex = Math.max(0, visibleStartIndex - overscan);
    const endIndex = Math.min(itemCount - 1, visibleEndIndex + overscan);

    return {
        endIndex,
        startIndex,
        visibleEndIndex,
        visibleStartIndex,
    };
}

export function calculateMeasuredVirtualScrollTop({
    align,
    itemSize,
    itemStart,
    offset,
    scrollMarginTop,
    totalSize,
    viewportHeight,
}: CalculateMeasuredVirtualScrollTopOptions): number {
    const normalizedViewportHeight = Math.max(1, viewportHeight);
    const maxScrollTop = Math.max(
        0,
        totalSize + scrollMarginTop - normalizedViewportHeight,
    );

    let nextScrollTop = itemStart + scrollMarginTop + offset;

    if (align === "center") {
        nextScrollTop =
            itemStart -
            normalizedViewportHeight / 2 +
            itemSize / 2 +
            scrollMarginTop +
            offset;
    } else if (align === "end") {
        nextScrollTop =
            itemStart -
            normalizedViewportHeight +
            itemSize +
            scrollMarginTop +
            offset;
    }

    return clamp(nextScrollTop, 0, maxScrollTop);
}

/**
 * Drops measured sizes whose keys are no longer valid, keeping the cache
 * bounded to the current rows. Measurement keys are derived from row content
 * and layout, so they churn over a long-lived session (resize, expansion
 * toggles, review-state changes); without pruning the map grows without bound
 * and each measurement clone gets progressively more expensive. Returns the
 * SAME map reference when nothing is stale, so the caller can skip the state
 * update; never mutates the input.
 */
export function pruneMeasuredSizesToKeys(
    sizes: Map<string, number>,
    validKeys: ReadonlySet<string>,
): Map<string, number> {
    let pruned: Map<string, number> | null = null;

    for (const key of sizes.keys()) {
        if (validKeys.has(key)) {
            continue;
        }

        if (!pruned) {
            pruned = new Map(sizes);
        }
        pruned.delete(key);
    }

    return pruned ?? sizes;
}

export function calculateMeasuredVirtualScrollAnchorAdjustment({
    itemIndex,
    nextSize,
    preserveScrollAnchorOnMeasure,
    previousSize,
    virtualizationEnabled,
    visibleStartIndex,
}: CalculateMeasuredVirtualScrollAnchorAdjustmentOptions): number {
    if (
        !preserveScrollAnchorOnMeasure ||
        !virtualizationEnabled ||
        itemIndex < 0 ||
        itemIndex >= visibleStartIndex
    ) {
        return 0;
    }

    const delta = nextSize - previousSize;

    if (!Number.isFinite(delta)) {
        return 0;
    }

    return delta;
}

export function MeasuredVirtualList<T>({
    items,
    enabled = true,
    overscan = DEFAULT_OVERSCAN,
    defaultViewportHeight = DEFAULT_VIEWPORT_HEIGHT,
    scrollMarginTop = 0,
    scrollContainerRef,
    estimateSize,
    getItemKey,
    getItemMeasurementKey,
    onRangeChange,
    onReady,
    preserveScrollAnchorOnMeasure = false,
    renderItem,
}: MeasuredVirtualListProps<T>) {
    const isBrowser = typeof window !== "undefined";
    const normalizedScrollMarginTop = Math.max(0, scrollMarginTop);
    const [measuredSizes, setMeasuredSizes] = useState<Map<string, number>>(
        () => new Map(),
    );
    const measuredSizesRef = useRef(measuredSizes);
    const [scrollState, setScrollState] = useState(() => ({
        scrollTop: 0,
        viewportHeight: isBrowser
            ? defaultViewportHeight
            : Number.POSITIVE_INFINITY,
    }));
    const elementByKeyRef = useRef(new Map<string, HTMLDivElement>());
    const keyByElementRef = useRef(new WeakMap<Element, string>());
    const layoutRangeRef = useRef<MeasuredVirtualRange | null>(null);
    const pendingScrollAnchorAdjustmentRef = useRef(0);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const previousRangeRef = useRef<MeasuredVirtualRange | null>(null);
    const itemKeys = useMemo(
        () => items.map((item, index) => getItemKey(item, index)),
        [getItemKey, items],
    );
    const itemMeasurementKeys = useMemo(
        () =>
            items.map((item, index) =>
                getItemMeasurementKey
                    ? getItemMeasurementKey(item, index)
                    : itemKeys[index],
            ),
        [getItemMeasurementKey, itemKeys, items],
    );
    const itemIndexByMeasurementKey = useMemo(() => {
        const next = new Map<string, number>();

        itemMeasurementKeys.forEach((key, index) => {
            next.set(key, index);
        });

        return next;
    }, [itemMeasurementKeys]);
    const virtualizationEnabled = enabled && isBrowser;

    // Keep the latest values in refs so updateMeasuredSize — and therefore the
    // ResizeObserver effect that depends on it — stay referentially stable as
    // items change. The observer must keep observing the same nodes during
    // streaming; recreating it on every reconciliation would re-measure every
    // visible row needlessly.
    const itemsRef = useRef(items);
    const estimateSizeRef = useRef(estimateSize);
    const itemIndexByMeasurementKeyRef = useRef(itemIndexByMeasurementKey);
    useEffect(() => {
        itemsRef.current = items;
        estimateSizeRef.current = estimateSize;
        itemIndexByMeasurementKeyRef.current = itemIndexByMeasurementKey;
    });

    const updateMeasuredSize = useCallback((key: string, nextSize: number) => {
        const normalizedSize = normalizeMeasuredVirtualSize(nextSize);
        const currentSizes = measuredSizesRef.current;
        const previousMeasuredSize = currentSizes.get(key);

        if (previousMeasuredSize === normalizedSize) {
            return;
        }

        const currentItems = itemsRef.current;
        const itemIndex = itemIndexByMeasurementKeyRef.current.get(key) ?? -1;
        const previousKnownSize =
            previousMeasuredSize ??
            (itemIndex >= 0 && itemIndex < currentItems.length
                ? estimateSizeRef.current(currentItems[itemIndex], itemIndex)
                : normalizedSize);
        const range = layoutRangeRef.current;
        const anchorAdjustment = calculateMeasuredVirtualScrollAnchorAdjustment(
            {
                itemIndex,
                nextSize: normalizedSize,
                preserveScrollAnchorOnMeasure,
                previousSize: previousKnownSize,
                virtualizationEnabled,
                visibleStartIndex: range?.visibleStartIndex ?? 0,
            },
        );

        if (anchorAdjustment !== 0) {
            pendingScrollAnchorAdjustmentRef.current += anchorAdjustment;
        }

        const nextSizes = new Map(currentSizes);
        nextSizes.set(key, normalizedSize);
        measuredSizesRef.current = nextSizes;
        setMeasuredSizes(nextSizes);
    }, [preserveScrollAnchorOnMeasure, virtualizationEnabled]);

    useEffect(() => {
        if (!virtualizationEnabled || typeof ResizeObserver === "undefined") {
            return;
        }

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const key = keyByElementRef.current.get(entry.target);
                if (!key) {
                    continue;
                }

                updateMeasuredSize(key, entry.contentRect.height);
            }
        });

        resizeObserverRef.current = observer;

        for (const [key, element] of elementByKeyRef.current.entries()) {
            keyByElementRef.current.set(element, key);
            observer.observe(element);
        }

        return () => {
            observer.disconnect();
            resizeObserverRef.current = null;
        };
    }, [updateMeasuredSize, virtualizationEnabled]);

    useEffect(() => {
        const validKeys = new Set(itemMeasurementKeys);

        for (const [key, element] of elementByKeyRef.current.entries()) {
            if (validKeys.has(key)) {
                continue;
            }

            resizeObserverRef.current?.unobserve(element);
            elementByKeyRef.current.delete(key);
        }

        // Prune superseded measurements so the cache stays bounded to the
        // current rows. Keys for current rows always live in validKeys, so
        // only stale revisions — never an in-use measurement — get dropped.
        const currentSizes = measuredSizesRef.current;
        const prunedSizes = pruneMeasuredSizesToKeys(currentSizes, validKeys);

        if (prunedSizes !== currentSizes) {
            measuredSizesRef.current = prunedSizes;
            setMeasuredSizes(prunedSizes);
        }
    }, [itemMeasurementKeys]);

    useEffect(() => {
        if (!virtualizationEnabled) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const syncScrollState = () => {
            const nextScrollTop = container.scrollTop;
            const nextViewportHeight = container.clientHeight;

            setScrollState((current) => {
                if (
                    current.scrollTop === nextScrollTop &&
                    current.viewportHeight === nextViewportHeight
                ) {
                    return current;
                }

                return {
                    scrollTop: nextScrollTop,
                    viewportHeight: nextViewportHeight,
                };
            });
        };

        syncScrollState();

        container.addEventListener("scroll", syncScrollState, {
            passive: true,
        });

        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(() => {
                syncScrollState();
            });
            observer.observe(container);
        }

        return () => {
            container.removeEventListener("scroll", syncScrollState);
            observer?.disconnect();
        };
    }, [scrollContainerRef, virtualizationEnabled]);

    const layout = useMemo((): LayoutSnapshot<T> => {
        const sizes = items.map((item, index) => {
            const key = itemMeasurementKeys[index];
            return measuredSizes.get(key) ?? estimateSize(item, index);
        });
        const offsets = new Array<number>(items.length);
        let totalSize = 0;

        for (let index = 0; index < items.length; index += 1) {
            offsets[index] = totalSize;
            totalSize += sizes[index];
        }

        const range = calculateMeasuredVirtualRange({
            itemCount: items.length,
            offsets,
            overscan,
            scrollMarginTop: normalizedScrollMarginTop,
            scrollTop: scrollState.scrollTop,
            sizes,
            viewportHeight: scrollState.viewportHeight,
            virtualizationEnabled,
        });

        if (items.length === 0) {
            return {
                range,
                totalSize,
                virtualItems: [],
            };
        }

        if (!virtualizationEnabled) {
            return {
                range,
                totalSize,
                virtualItems: items.map((item, index) => ({
                    index,
                    isVisible: true,
                    item,
                    key: itemKeys[index],
                    measurementKey: itemMeasurementKeys[index],
                    size: sizes[index],
                    start: offsets[index],
                })),
            };
        }

        const virtualItems: MeasuredVirtualItem<T>[] = [];

        for (
            let index = range.startIndex;
            index <= range.endIndex;
            index += 1
        ) {
            virtualItems.push({
                index,
                isVisible:
                    index >= range.visibleStartIndex &&
                    index <= range.visibleEndIndex,
                item: items[index],
                key: itemKeys[index],
                measurementKey: itemMeasurementKeys[index],
                size: sizes[index],
                start: offsets[index],
            });
        }

        return {
            range,
            totalSize,
            virtualItems,
        };
    }, [
        estimateSize,
        itemMeasurementKeys,
        itemKeys,
        items,
        measuredSizes,
        normalizedScrollMarginTop,
        overscan,
        scrollState.scrollTop,
        scrollState.viewportHeight,
        virtualizationEnabled,
    ]);

    layoutRangeRef.current = layout.range;

    useLayoutEffect(() => {
        if (!preserveScrollAnchorOnMeasure || !virtualizationEnabled) {
            pendingScrollAnchorAdjustmentRef.current = 0;
            return;
        }

        const adjustment = pendingScrollAnchorAdjustmentRef.current;
        pendingScrollAnchorAdjustmentRef.current = 0;

        if (adjustment === 0) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        container.scrollTop = Math.max(0, container.scrollTop + adjustment);
    }, [
        measuredSizes,
        preserveScrollAnchorOnMeasure,
        scrollContainerRef,
        virtualizationEnabled,
    ]);

    useEffect(() => {
        if (
            !onRangeChange ||
            areRangesEqual(previousRangeRef.current, layout.range)
        ) {
            return;
        }

        previousRangeRef.current = layout.range;
        onRangeChange(layout.range);
    }, [layout.range, onRangeChange]);

    const getItemStart = useCallback(
        (index: number): number => {
            const targetItem =
                layout.virtualItems.find((item) => item.index === index) ??
                null;

            if (targetItem) {
                return targetItem.start;
            }

            let total = 0;
            for (let cursor = 0; cursor < index; cursor += 1) {
                total +=
                    measuredSizes.get(itemMeasurementKeys[cursor]) ??
                    estimateSize(items[cursor], cursor);
            }
            return total;
        },
        [
            estimateSize,
            itemMeasurementKeys,
            items,
            layout.virtualItems,
            measuredSizes,
        ],
    );

    const getItemSize = useCallback(
        (index: number): number => {
            const targetItem =
                layout.virtualItems.find((item) => item.index === index) ??
                null;

            return (
                targetItem?.size ??
                measuredSizes.get(itemMeasurementKeys[index]) ??
                estimateSize(items[index], index)
            );
        },
        [
            estimateSize,
            itemMeasurementKeys,
            items,
            layout.virtualItems,
            measuredSizes,
        ],
    );

    const setMeasuredElement = useCallback(
        (key: string, node: HTMLDivElement | null) => {
            const previousElement = elementByKeyRef.current.get(key);

            if (previousElement === node) {
                return;
            }

            if (previousElement) {
                resizeObserverRef.current?.unobserve(previousElement);
                elementByKeyRef.current.delete(key);
            }

            if (!node) {
                return;
            }

            elementByKeyRef.current.set(key, node);
            keyByElementRef.current.set(node, key);
            updateMeasuredSize(key, node.getBoundingClientRect().height);
            resizeObserverRef.current?.observe(node);
        },
        [updateMeasuredSize],
    );

    const scrollToIndex = useCallback(
        (
            index: number,
            options?: {
                readonly align?: "center" | "end" | "start";
                readonly offset?: number;
            },
        ) => {
            const container = scrollContainerRef.current;

            if (!container || index < 0 || index >= items.length) {
                return;
            }

            const align = options?.align ?? "start";
            const offset = options?.offset ?? 0;
            container.scrollTop = calculateMeasuredVirtualScrollTop({
                align,
                itemSize: getItemSize(index),
                itemStart: getItemStart(index),
                offset,
                scrollMarginTop: normalizedScrollMarginTop,
                totalSize: layout.totalSize,
                viewportHeight: container.clientHeight,
            });
        },
        [
            getItemSize,
            getItemStart,
            items,
            layout.totalSize,
            normalizedScrollMarginTop,
            scrollContainerRef,
        ],
    );

    const captureViewportAnchor = useCallback(():
        | MeasuredVirtualViewportAnchor
        | null => {
        const container = scrollContainerRef.current;

        if (!container || items.length === 0) {
            return null;
        }

        const index = clamp(
            layout.range.visibleStartIndex,
            0,
            items.length - 1,
        );
        const effectiveScrollTop = Math.max(
            0,
            container.scrollTop - normalizedScrollMarginTop,
        );
        const itemStart = getItemStart(index);

        return {
            index,
            key: itemKeys[index],
            offset: Math.max(0, Math.round(effectiveScrollTop - itemStart)),
        };
    }, [
        getItemStart,
        itemKeys,
        items.length,
        layout.range.visibleStartIndex,
        normalizedScrollMarginTop,
        scrollContainerRef,
    ]);

    const scrollToViewportAnchor = useCallback(
        (anchor: MeasuredVirtualViewportAnchor) => {
            const keyedIndex = itemKeys.indexOf(anchor.key);
            const index =
                keyedIndex >= 0
                    ? keyedIndex
                    : clamp(anchor.index, 0, items.length - 1);

            scrollToIndex(index, {
                align: "start",
                offset: anchor.offset,
            });
        },
        [itemKeys, items.length, scrollToIndex],
    );

    useEffect(() => {
        onReady?.({
            captureViewportAnchor,
            scrollToIndex,
            scrollToViewportAnchor,
        });

        return () => {
            onReady?.(null);
        };
    }, [
        captureViewportAnchor,
        onReady,
        scrollToIndex,
        scrollToViewportAnchor,
    ]);

    if (items.length === 0) {
        return null;
    }

    if (!virtualizationEnabled) {
        return (
            <div className="relative w-full">
                {items.map((item, index) => (
                    <div
                        key={itemKeys[index]}
                        ref={(node) => {
                            if (!node) {
                                return;
                            }

                            updateMeasuredSize(
                                itemMeasurementKeys[index],
                                node.getBoundingClientRect().height,
                            );
                        }}
                    >
                        {renderItem({
                            index,
                            isVisible: true,
                            item,
                        })}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div
            className="relative w-full"
            style={{ height: `${layout.totalSize}px` }}
        >
            {layout.virtualItems.map((virtualItem) => (
                <div
                    key={virtualItem.key}
                    ref={(node) => {
                        setMeasuredElement(virtualItem.measurementKey, node);
                    }}
                    style={{
                        left: 0,
                        position: "absolute",
                        right: 0,
                        top: 0,
                        transform: `translateY(${virtualItem.start}px)`,
                    }}
                >
                    {renderItem({
                        index: virtualItem.index,
                        isVisible: virtualItem.isVisible,
                        item: virtualItem.item,
                    })}
                </div>
            ))}
        </div>
    );
}
