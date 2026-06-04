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
    /**
     * Width-invariant identity for a row revision. When a row's measurement key
     * churns (e.g. a resize re-buckets the width) the list reuses the row's last
     * measured height under this key as the estimate, instead of snapping back
     * to estimateSize. Defaults to the measurement key (no carry-over).
     */
    readonly getItemIdentityKey?: (item: T, index: number) => string;
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

interface ResolvePreviousMeasuredSizeOptions<T> {
    readonly estimateSize: (item: T, index: number) => number;
    readonly fallbackSize: number;
    readonly itemIndexByMeasurementKey: ReadonlyMap<string, number>;
    readonly items: readonly T[];
    readonly key: string;
    readonly previousMeasuredSize: number | undefined;
    // Last measured height for this row's width-invariant identity, if any. It
    // is what the layout is currently assuming after a measurement-key churn,
    // so it must take precedence over the estimate as the compensation baseline.
    readonly previousIdentitySize?: number | undefined;
}

/**
 * Resolves the row index for a measurement key and the size the layout is
 * currently assuming for it, so a fresh measurement can be compared against the
 * right baseline for scroll-anchor compensation.
 *
 * The index map MUST reflect the same render that produced the measured node.
 * A measurement key changes whenever a row could render at a new height (resize,
 * expansion toggle, content reconciliation); when it does, the new key has no
 * entry in measuredSizes yet, so the layout is showing the row at its ESTIMATE.
 * Returning that estimate as previousKnownSize lets updateMeasuredSize compute a
 * real delta. If the index map lagged a render behind, the lookup would miss
 * (itemIndex = -1) and fall back to the measured size — a zero delta — which
 * silently drops the compensation and lets an above-viewport row shift the
 * total height without adjusting scrollTop.
 */
export function resolvePreviousMeasuredSize<T>({
    estimateSize,
    fallbackSize,
    itemIndexByMeasurementKey,
    items,
    key,
    previousMeasuredSize,
    previousIdentitySize,
}: ResolvePreviousMeasuredSizeOptions<T>): {
    readonly itemIndex: number;
    readonly previousKnownSize: number;
} {
    const itemIndex = itemIndexByMeasurementKey.get(key) ?? -1;
    const previousKnownSize =
        previousMeasuredSize ??
        previousIdentitySize ??
        (itemIndex >= 0 && itemIndex < items.length
            ? estimateSize(items[itemIndex], itemIndex)
            : fallbackSize);

    return { itemIndex, previousKnownSize };
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
    getItemIdentityKey,
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
    const itemIdentityKeys = useMemo(
        () =>
            items.map((item, index) =>
                getItemIdentityKey
                    ? getItemIdentityKey(item, index)
                    : itemMeasurementKeys[index],
            ),
        [getItemIdentityKey, itemMeasurementKeys, items],
    );
    // Last measured height per width-invariant identity. Mutated in place (like
    // the element maps below) and read during layout to bridge a row's height
    // across a measurement-key churn; pruned to the live identities alongside
    // measuredSizes so it stays bounded.
    const measuredByIdentityRef = useRef(new Map<string, number>());
    const virtualizationEnabled = enabled && isBrowser;

    // Keep the latest values in refs so updateMeasuredSize — and therefore the
    // ResizeObserver effect that depends on it — stay referentially stable as
    // items change. The observer must keep observing the same nodes during
    // streaming; recreating it on every reconciliation would re-measure every
    // visible row needlessly.
    //
    // These are assigned during render (not in an effect) on purpose: a ref
    // callback measures a freshly-keyed node during the commit phase, BEFORE
    // passive effects run. If the index map lagged behind in an effect, that
    // first measurement would look the new measurementKey up against the
    // previous render's map, get -1, and skip the scroll-anchor compensation —
    // letting an above-viewport row change the total height without adjusting
    // scrollTop (a visible jump on expansion/font re-keys). Mirrors the
    // layoutRangeRef assignment below.
    const itemsRef = useRef(items);
    const estimateSizeRef = useRef(estimateSize);
    const itemIndexByMeasurementKeyRef = useRef(itemIndexByMeasurementKey);
    const itemIdentityKeysRef = useRef(itemIdentityKeys);
    itemsRef.current = items;
    estimateSizeRef.current = estimateSize;
    itemIndexByMeasurementKeyRef.current = itemIndexByMeasurementKey;
    itemIdentityKeysRef.current = itemIdentityKeys;

    const updateMeasuredSize = useCallback((key: string, nextSize: number) => {
        const normalizedSize = normalizeMeasuredVirtualSize(nextSize);
        const currentSizes = measuredSizesRef.current;
        const previousMeasuredSize = currentSizes.get(key);

        if (previousMeasuredSize === normalizedSize) {
            return;
        }

        const measuredByIdentity = measuredByIdentityRef.current;
        const itemIndexForKey =
            itemIndexByMeasurementKeyRef.current.get(key) ?? -1;
        const identityKey =
            itemIndexForKey >= 0
                ? itemIdentityKeysRef.current[itemIndexForKey]
                : undefined;
        const previousIdentitySize =
            identityKey !== undefined
                ? measuredByIdentity.get(identityKey)
                : undefined;

        const { itemIndex, previousKnownSize } = resolvePreviousMeasuredSize({
            estimateSize: estimateSizeRef.current,
            fallbackSize: normalizedSize,
            itemIndexByMeasurementKey: itemIndexByMeasurementKeyRef.current,
            items: itemsRef.current,
            key,
            previousMeasuredSize,
            previousIdentitySize,
        });
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

        // Record the height under the row's identity so a later measurement-key
        // churn (e.g. a resize re-buckets the width) can reuse it as the
        // estimate instead of snapping back to estimateSize.
        if (identityKey !== undefined) {
            measuredByIdentity.set(identityKey, normalizedSize);
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

        // Keep the identity-keyed estimate cache bounded the same way. Rows
        // still present (even if scrolled out of view) keep their identity in
        // validIdentityKeys; only removed rows get dropped. It is a pure
        // estimate cache mutated in place, so no re-render is needed.
        const validIdentityKeys = new Set(itemIdentityKeys);
        const measuredByIdentity = measuredByIdentityRef.current;
        for (const identityKey of measuredByIdentity.keys()) {
            if (!validIdentityKeys.has(identityKey)) {
                measuredByIdentity.delete(identityKey);
            }
        }
    }, [itemIdentityKeys, itemMeasurementKeys]);

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

    // Resolve a row's height: an exact measurement wins; otherwise the row's
    // last measurement under its width-invariant identity (so a resize doesn't
    // snap it back to the estimate); the heuristic estimate is the final
    // fallback for a never-measured row.
    const resolveItemSize = useCallback(
        (index: number): number => {
            const measured = measuredSizes.get(itemMeasurementKeys[index]);
            if (measured !== undefined) {
                return measured;
            }

            const byIdentity = measuredByIdentityRef.current.get(
                itemIdentityKeys[index],
            );
            if (byIdentity !== undefined) {
                return byIdentity;
            }

            return estimateSize(items[index], index);
        },
        [
            estimateSize,
            itemIdentityKeys,
            itemMeasurementKeys,
            items,
            measuredSizes,
        ],
    );

    const layout = useMemo((): LayoutSnapshot<T> => {
        const sizes = items.map((_item, index) => resolveItemSize(index));
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
        itemMeasurementKeys,
        itemKeys,
        items,
        normalizedScrollMarginTop,
        overscan,
        resolveItemSize,
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
                total += resolveItemSize(cursor);
            }
            return total;
        },
        [layout.virtualItems, resolveItemSize],
    );

    const getItemSize = useCallback(
        (index: number): number => {
            const targetItem =
                layout.virtualItems.find((item) => item.index === index) ??
                null;

            return targetItem?.size ?? resolveItemSize(index);
        },
        [layout.virtualItems, resolveItemSize],
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
