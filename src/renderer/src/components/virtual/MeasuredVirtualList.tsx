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
const MAX_CACHED_MEASUREMENT_SETS = 12;
const MAX_DYNAMIC_OVERSCAN_ROWS = 64;
const SCROLL_OVERSCAN_ROW_HEIGHT_PX = 72;

interface CachedMeasurements {
    readonly geometry: CachedGeometry | null;
    readonly measuredByIdentity: ReadonlyMap<string, number>;
    readonly measuredSizes: ReadonlyMap<string, number>;
}

interface CachedGeometry {
    readonly itemIdentityKeys: readonly string[];
    readonly itemKeys: readonly string[];
    readonly itemMeasurementKeys: readonly string[];
    readonly items: readonly unknown[];
    readonly offsets: readonly number[];
    readonly signature: string;
    readonly sizes: readonly number[];
    readonly totalSize: number;
}

const cachedMeasurementsByKey = new Map<string, CachedMeasurements>();

function getCachedMeasurements(cacheKey: string): CachedMeasurements | null {
    const cached = cachedMeasurementsByKey.get(cacheKey) ?? null;
    if (!cached) {
        return null;
    }

    cachedMeasurementsByKey.delete(cacheKey);
    cachedMeasurementsByKey.set(cacheKey, cached);
    return cached;
}

function cacheMeasurements(
    cacheKey: string,
    measurements: CachedMeasurements,
): void {
    cachedMeasurementsByKey.delete(cacheKey);
    cachedMeasurementsByKey.set(cacheKey, measurements);

    while (cachedMeasurementsByKey.size > MAX_CACHED_MEASUREMENT_SETS) {
        const oldestKey = cachedMeasurementsByKey.keys().next().value;
        if (!oldestKey) {
            return;
        }
        cachedMeasurementsByKey.delete(oldestKey);
    }
}

function cacheCurrentMeasurements(
    cacheKey: string,
    geometry: CachedGeometry | null,
    measuredSizesRef: Readonly<{
        readonly current: ReadonlyMap<string, number>;
    }>,
    measuredByIdentityRef: Readonly<{
        readonly current: ReadonlyMap<string, number>;
    }>,
): void {
    cacheMeasurements(cacheKey, {
        geometry,
        measuredByIdentity: new Map(measuredByIdentityRef.current),
        measuredSizes: new Map(measuredSizesRef.current),
    });
}

export function resetMeasuredVirtualListMeasurementsForTests(): void {
    cachedMeasurementsByKey.clear();
}

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
    /**
     * Keeps measurements across an unmount/remount of the same list. Item keys
     * still validate each entry, so stale rows are ignored after a change.
     */
    readonly measurementCacheKey?: string;
    /** Stable layout inputs. A changed value invalidates cached geometry. */
    readonly geometryCacheSignature?: string | null;
    readonly onRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onReady?: (handle: MeasuredVirtualListHandle | null) => void;
    readonly preserveScrollAnchorOnItemsChange?: boolean;
    readonly preserveScrollAnchorOnMeasure?: boolean;
    readonly shouldPreserveScrollAnchorOnItemsChange?: () => boolean;
    readonly shouldPreserveScrollAnchorOnMeasure?: () => boolean;
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
    readonly offsets: readonly number[];
    readonly range: MeasuredVirtualRange;
    readonly sizes: readonly number[];
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

function areItemKeysEqual(
    previous: readonly string[] | null,
    next: readonly string[],
): boolean {
    return (
        previous !== null &&
        previous.length === next.length &&
        previous.every((key, index) => key === next[index])
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
    measurementCacheKey,
    geometryCacheSignature = null,
    onRangeChange,
    onReady,
    preserveScrollAnchorOnItemsChange = false,
    preserveScrollAnchorOnMeasure = false,
    shouldPreserveScrollAnchorOnItemsChange,
    shouldPreserveScrollAnchorOnMeasure,
    renderItem,
}: MeasuredVirtualListProps<T>) {
    const isBrowser = typeof window !== "undefined";
    const normalizedScrollMarginTop = Math.max(0, scrollMarginTop);
    const initialMeasurementsRef = useRef<
        CachedMeasurements | null | undefined
    >(undefined);
    if (initialMeasurementsRef.current === undefined) {
        initialMeasurementsRef.current = measurementCacheKey
            ? getCachedMeasurements(measurementCacheKey)
            : null;
    }
    const initialMeasuredSizesRef = useRef(
        new Map(initialMeasurementsRef.current?.measuredSizes),
    );
    const [measuredSizes, setMeasuredSizes] = useState<Map<string, number>>(
        initialMeasuredSizesRef.current,
    );
    const measuredSizesRef = useRef(measuredSizes);
    const [scrollState, setScrollState] = useState(() => ({
        overscan,
        scrollTop: 0,
        viewportHeight: isBrowser
            ? defaultViewportHeight
            : Number.POSITIVE_INFINITY,
    }));
    // Element bookkeeping is keyed by the STABLE list key (getItemKey), not the
    // volatile measurement key: the wrapper's React key is the list key, so its
    // DOM node is reused across measurement-key churn (resize, content edits).
    // The live measurement key is resolved from the list key at measure time
    // (measurementKeyByListKey), which lets the row ref attach exactly once.
    const elementByListKeyRef = useRef(new Map<string, HTMLDivElement>());
    const listKeyByElementRef = useRef(new WeakMap<Element, string>());
    const layoutRangeRef = useRef<MeasuredVirtualRange | null>(null);
    const captureViewportAnchorRef = useRef<
        (() => MeasuredVirtualViewportAnchor | null) | null
    >(null);
    const pendingItemsChangeAnchorRef =
        useRef<MeasuredVirtualViewportAnchor | null>(null);
    const pendingScrollAnchorAdjustmentRef = useRef(0);
    const previousItemKeysRef = useRef<readonly string[] | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const previousRangeRef = useRef<MeasuredVirtualRange | null>(null);
    const previousScrollTopRef = useRef(0);
    const shouldPreserveScrollAnchorOnMeasureRef = useRef(
        shouldPreserveScrollAnchorOnMeasure,
    );
    const shouldPreserveScrollAnchorOnItemsChangeRef = useRef(
        shouldPreserveScrollAnchorOnItemsChange,
    );
    shouldPreserveScrollAnchorOnMeasureRef.current =
        shouldPreserveScrollAnchorOnMeasure;
    shouldPreserveScrollAnchorOnItemsChangeRef.current =
        shouldPreserveScrollAnchorOnItemsChange;
    const cachedGeometry = useMemo(() => {
        const geometry = initialMeasurementsRef.current?.geometry ?? null;
        if (!geometry || geometry.items !== items) {
            return null;
        }
        if (
            geometryCacheSignature !== null &&
            geometry.signature !== geometryCacheSignature
        ) {
            return null;
        }
        return geometry;
    }, [geometryCacheSignature, items]);
    const itemKeys = useMemo(
        () =>
            cachedGeometry
                ? cachedGeometry.itemKeys
                : items.map((item, index) => getItemKey(item, index)),
        [cachedGeometry, getItemKey, items],
    );
    const itemMeasurementKeys = useMemo(
        () =>
            cachedGeometry
                ? cachedGeometry.itemMeasurementKeys
                : items.map((item, index) =>
                      getItemMeasurementKey
                          ? getItemMeasurementKey(item, index)
                          : itemKeys[index],
                  ),
        [cachedGeometry, getItemMeasurementKey, itemKeys, items],
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
            cachedGeometry
                ? cachedGeometry.itemIdentityKeys
                : items.map((item, index) =>
                      getItemIdentityKey
                          ? getItemIdentityKey(item, index)
                          : itemMeasurementKeys[index],
                  ),
        [cachedGeometry, getItemIdentityKey, itemMeasurementKeys, items],
    );
    // Live list-key -> measurement-key map. The row ref is keyed by the stable
    // list key, so a measurement must resolve the row's CURRENT measurement key
    // here (it changes on resize/content edits while the DOM node is reused).
    const measurementKeyByListKey = useMemo(() => {
        const next = new Map<string, string>();

        itemKeys.forEach((listKey, index) => {
            next.set(listKey, itemMeasurementKeys[index]);
        });

        return next;
    }, [itemKeys, itemMeasurementKeys]);
    // Last measured height per width-invariant identity. Mutated in place (like
    // the element maps below) and read during layout to bridge a row's height
    // across a measurement-key churn; pruned to the live identities alongside
    // measuredSizes so it stays bounded.
    const measuredByIdentityRef = useRef(
        new Map(initialMeasurementsRef.current?.measuredByIdentity),
    );
    const geometryRef = useRef<CachedGeometry | null>(null);
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
    const measurementKeyByListKeyRef = useRef(measurementKeyByListKey);
    itemsRef.current = items;
    estimateSizeRef.current = estimateSize;
    itemIndexByMeasurementKeyRef.current = itemIndexByMeasurementKey;
    itemIdentityKeysRef.current = itemIdentityKeys;
    measurementKeyByListKeyRef.current = measurementKeyByListKey;

    useEffect(() => {
        if (!measurementCacheKey) {
            return;
        }

        return () => {
            cacheCurrentMeasurements(
                measurementCacheKey,
                geometryRef.current,
                measuredSizesRef,
                measuredByIdentityRef,
            );
        };
    }, [measurementCacheKey]);

    const shouldPreserveScrollAnchorOnMeasureNow = useCallback(() => {
        return (
            preserveScrollAnchorOnMeasure &&
            (shouldPreserveScrollAnchorOnMeasureRef.current?.() ?? true)
        );
    }, [preserveScrollAnchorOnMeasure]);

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
                preserveScrollAnchorOnMeasure:
                    shouldPreserveScrollAnchorOnMeasureNow(),
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
    }, [shouldPreserveScrollAnchorOnMeasureNow, virtualizationEnabled]);

    useEffect(() => {
        if (!virtualizationEnabled || typeof ResizeObserver === "undefined") {
            return;
        }

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const listKey = listKeyByElementRef.current.get(entry.target);
                if (listKey === undefined) {
                    continue;
                }

                // Resolve the row's CURRENT measurement key from its stable list
                // key, so a measurement-key churn on a reused node is reported
                // under the new key without re-attaching the ref.
                const measurementKey =
                    measurementKeyByListKeyRef.current.get(listKey);
                if (measurementKey === undefined) {
                    continue;
                }

                // Border-box to match the synchronous getBoundingClientRect
                // measurement on attach, so the two channels can never disagree
                // by the wrapper's padding/border.
                const height =
                    entry.borderBoxSize?.[0]?.blockSize ??
                    entry.contentRect.height;
                updateMeasuredSize(measurementKey, height);
            }
        });

        resizeObserverRef.current = observer;

        for (const element of elementByListKeyRef.current.values()) {
            observer.observe(element, { box: "border-box" });
        }

        return () => {
            observer.disconnect();
            resizeObserverRef.current = null;
        };
    }, [updateMeasuredSize, virtualizationEnabled]);

    useLayoutEffect(() => {
        if (!virtualizationEnabled) {
            return;
        }

        const currentSizes = measuredSizesRef.current;
        for (const [listKey, element] of elementByListKeyRef.current.entries()) {
            const measurementKey = measurementKeyByListKey.get(listKey);
            if (
                measurementKey === undefined ||
                currentSizes.has(measurementKey)
            ) {
                continue;
            }

            // A row can receive a new measurement key while React keeps the same
            // DOM node mounted. If its physical height did not change, the
            // ResizeObserver will not fire, so measure the mounted node once
            // under the new key instead of falling back to a rough estimate.
            updateMeasuredSize(
                measurementKey,
                element.getBoundingClientRect().height,
            );
        }
    }, [measurementKeyByListKey, updateMeasuredSize, virtualizationEnabled]);

    useEffect(() => {
        // Drop elements for rows that no longer exist. Elements are keyed by the
        // stable list key, so validate against itemKeys (not measurement keys).
        const validListKeys = new Set(itemKeys);

        for (const [listKey, element] of elementByListKeyRef.current.entries()) {
            if (validListKeys.has(listKey)) {
                continue;
            }

            resizeObserverRef.current?.unobserve(element);
            elementByListKeyRef.current.delete(listKey);
        }

        // Prune superseded measurements so the cache stays bounded to the
        // current rows. measuredSizes is keyed by measurement key (which churns
        // more often than the list key), so validate it against those; keys for
        // current rows always survive, only stale revisions get dropped.
        const validMeasurementKeys = new Set(itemMeasurementKeys);
        const currentSizes = measuredSizesRef.current;
        const prunedSizes = pruneMeasuredSizesToKeys(
            currentSizes,
            validMeasurementKeys,
        );

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
    }, [itemIdentityKeys, itemKeys, itemMeasurementKeys]);

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
            const scrollDelta = Math.abs(
                nextScrollTop - previousScrollTopRef.current,
            );
            previousScrollTopRef.current = nextScrollTop;
            const dynamicOverscan = Math.min(
                MAX_DYNAMIC_OVERSCAN_ROWS,
                overscan +
                    Math.ceil(scrollDelta / SCROLL_OVERSCAN_ROW_HEIGHT_PX),
            );

            setScrollState((current) => {
                if (
                    current.overscan === dynamicOverscan &&
                    current.scrollTop === nextScrollTop &&
                    current.viewportHeight === nextViewportHeight
                ) {
                    return current;
                }

                return {
                    overscan: dynamicOverscan,
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
    }, [overscan, scrollContainerRef, virtualizationEnabled]);

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
        const canReuseBaseGeometry =
            cachedGeometry !== null &&
            measuredSizes === initialMeasuredSizesRef.current;
        const sizes = canReuseBaseGeometry
            ? cachedGeometry.sizes
            : items.map((_item, index) => resolveItemSize(index));
        let offsets: readonly number[];
        let totalSize = canReuseBaseGeometry ? cachedGeometry.totalSize : 0;

        if (canReuseBaseGeometry) {
            offsets = cachedGeometry.offsets;
        } else {
            const nextOffsets = new Array<number>(items.length);
            for (let index = 0; index < items.length; index += 1) {
                nextOffsets[index] = totalSize;
                totalSize += sizes[index];
            }
            offsets = nextOffsets;
        }

        const range = calculateMeasuredVirtualRange({
            itemCount: items.length,
            offsets,
            overscan: scrollState.overscan,
            scrollMarginTop: normalizedScrollMarginTop,
            scrollTop: scrollState.scrollTop,
            sizes,
            viewportHeight: scrollState.viewportHeight,
            virtualizationEnabled,
        });

        if (items.length === 0) {
            return {
                offsets,
                range,
                sizes,
                totalSize,
                virtualItems: [],
            };
        }

        if (!virtualizationEnabled) {
            return {
                offsets,
                range,
                sizes,
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
            offsets,
            range,
            sizes,
            totalSize,
            virtualItems,
        };
    }, [
        cachedGeometry,
        itemMeasurementKeys,
        itemKeys,
        items,
        measuredSizes,
        normalizedScrollMarginTop,
        resolveItemSize,
        scrollState.scrollTop,
        scrollState.overscan,
        scrollState.viewportHeight,
        virtualizationEnabled,
    ]);

    geometryRef.current =
        geometryCacheSignature === null
            ? null
            : {
                  itemIdentityKeys,
                  itemKeys,
                  itemMeasurementKeys,
                  items,
                  offsets: layout.offsets,
                  signature: geometryCacheSignature,
                  sizes: layout.sizes,
                  totalSize: layout.totalSize,
              };

    layoutRangeRef.current = layout.range;

    useLayoutEffect(() => {
        if (!preserveScrollAnchorOnMeasure || !virtualizationEnabled) {
            pendingScrollAnchorAdjustmentRef.current = 0;
            return;
        }

        if (!shouldPreserveScrollAnchorOnMeasureNow()) {
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
        shouldPreserveScrollAnchorOnMeasureNow,
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

    // Stable ref for a measured row, keyed off the wrapper's data-list-key. Its
    // identity only changes when updateMeasuredSize does (rarely), so React
    // attaches it ONCE per row and runs the returned cleanup on unmount — rather
    // than re-running an inline closure (and forcing a synchronous reflow) on
    // every render. The ResizeObserver tracks every size change after attach, so
    // the single getBoundingClientRect here is just the immediate first paint.
    // Measurement-key churn on a reused node is handled by the layout effect
    // above, including the no-resize case where the observer will not fire.
    const registerMeasuredElement = useCallback(
        (node: HTMLDivElement | null) => {
            if (!node) {
                return;
            }

            const listKey = node.dataset.listKey;
            if (listKey === undefined) {
                return;
            }

            elementByListKeyRef.current.set(listKey, node);
            listKeyByElementRef.current.set(node, listKey);

            const measurementKey =
                measurementKeyByListKeyRef.current.get(listKey);
            if (measurementKey !== undefined) {
                updateMeasuredSize(
                    measurementKey,
                    node.getBoundingClientRect().height,
                );
            }
            resizeObserverRef.current?.observe(node, { box: "border-box" });

            return () => {
                resizeObserverRef.current?.unobserve(node);
                if (elementByListKeyRef.current.get(listKey) === node) {
                    elementByListKeyRef.current.delete(listKey);
                }
            };
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

    const previousItemKeys = previousItemKeysRef.current;
    if (!areItemKeysEqual(previousItemKeys, itemKeys)) {
        pendingItemsChangeAnchorRef.current =
            previousItemKeys !== null &&
            preserveScrollAnchorOnItemsChange &&
            virtualizationEnabled &&
            (shouldPreserveScrollAnchorOnItemsChangeRef.current?.() ?? true)
                ? (captureViewportAnchorRef.current?.() ?? null)
                : null;
    }
    previousItemKeysRef.current = itemKeys;
    captureViewportAnchorRef.current = captureViewportAnchor;

    useLayoutEffect(() => {
        const anchor = pendingItemsChangeAnchorRef.current;
        pendingItemsChangeAnchorRef.current = null;
        if (!anchor) {
            return;
        }

        scrollToViewportAnchor(anchor);
    }, [itemKeys, scrollToViewportAnchor]);

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
                    data-list-key={virtualItem.key}
                    ref={registerMeasuredElement}
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
