import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

const DEFAULT_OVERSCAN = 4;
const DEFAULT_VIEWPORT_HEIGHT = 720;

export interface MeasuredVirtualListHandle {
    readonly scrollToIndex: (
        index: number,
        options?: {
            readonly align?: "center" | "end" | "start";
            readonly offset?: number;
        },
    ) => void;
}

export interface MeasuredVirtualListProps<T> {
    readonly items: readonly T[];
    readonly enabled?: boolean;
    readonly overscan?: number;
    readonly defaultViewportHeight?: number;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
    readonly estimateSize: (item: T, index: number) => number;
    readonly getItemKey: (item: T, index: number) => string;
    readonly onReady?: (handle: MeasuredVirtualListHandle | null) => void;
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
    readonly size: number;
    readonly start: number;
}

interface LayoutSnapshot<T> {
    readonly totalSize: number;
    readonly virtualItems: readonly MeasuredVirtualItem<T>[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
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

export function MeasuredVirtualList<T>({
    items,
    enabled = true,
    overscan = DEFAULT_OVERSCAN,
    defaultViewportHeight = DEFAULT_VIEWPORT_HEIGHT,
    scrollContainerRef,
    estimateSize,
    getItemKey,
    onReady,
    renderItem,
}: MeasuredVirtualListProps<T>) {
    const isBrowser = typeof window !== "undefined";
    const [measuredSizes, setMeasuredSizes] = useState<Map<string, number>>(
        () => new Map(),
    );
    const [scrollState, setScrollState] = useState(() => ({
        scrollTop: 0,
        viewportHeight: isBrowser
            ? defaultViewportHeight
            : Number.POSITIVE_INFINITY,
    }));
    const elementByKeyRef = useRef(new Map<string, HTMLDivElement>());
    const keyByElementRef = useRef(new WeakMap<Element, string>());
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const itemKeys = useMemo(
        () => items.map((item, index) => getItemKey(item, index)),
        [getItemKey, items],
    );
    const virtualizationEnabled = enabled && isBrowser;

    const updateMeasuredSize = useCallback((key: string, nextSize: number) => {
        const normalizedSize = Math.max(1, Math.ceil(nextSize));
        setMeasuredSizes((current) => {
            const previousSize = current.get(key);

            if (previousSize === normalizedSize) {
                return current;
            }

            const next = new Map(current);
            next.set(key, normalizedSize);
            return next;
        });
    }, []);

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
        const validKeys = new Set(itemKeys);

        for (const [key, element] of elementByKeyRef.current.entries()) {
            if (validKeys.has(key)) {
                continue;
            }

            resizeObserverRef.current?.unobserve(element);
            elementByKeyRef.current.delete(key);
        }
    }, [itemKeys]);

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
            const key = itemKeys[index];
            return measuredSizes.get(key) ?? estimateSize(item, index);
        });
        const offsets = new Array<number>(items.length);
        let totalSize = 0;

        for (let index = 0; index < items.length; index += 1) {
            offsets[index] = totalSize;
            totalSize += sizes[index];
        }

        if (!virtualizationEnabled || items.length === 0) {
            return {
                totalSize,
                virtualItems: items.map((item, index) => ({
                    index,
                    isVisible: true,
                    item,
                    key: itemKeys[index],
                    size: sizes[index],
                    start: offsets[index],
                })),
            };
        }

        const scrollBottom =
            scrollState.scrollTop + Math.max(1, scrollState.viewportHeight);
        const firstVisibleIndex = findFirstVisibleIndex(
            offsets,
            sizes,
            scrollState.scrollTop,
        );
        const lastVisibleIndex = findLastVisibleIndex(offsets, scrollBottom);
        const visibleStartIndex =
            firstVisibleIndex >= items.length
                ? items.length - 1
                : firstVisibleIndex;
        const visibleEndIndex = clamp(
            lastVisibleIndex,
            visibleStartIndex,
            items.length - 1,
        );
        const startIndex = Math.max(0, visibleStartIndex - overscan);
        const endIndex = Math.min(items.length - 1, visibleEndIndex + overscan);
        const virtualItems: MeasuredVirtualItem<T>[] = [];

        for (let index = startIndex; index <= endIndex; index += 1) {
            virtualItems.push({
                index,
                isVisible:
                    index >= visibleStartIndex && index <= visibleEndIndex,
                item: items[index],
                key: itemKeys[index],
                size: sizes[index],
                start: offsets[index],
            });
        }

        return {
            totalSize,
            virtualItems,
        };
    }, [
        estimateSize,
        itemKeys,
        items,
        measuredSizes,
        overscan,
        scrollState.scrollTop,
        scrollState.viewportHeight,
        virtualizationEnabled,
    ]);

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
            const targetItem =
                layout.virtualItems.find((item) => item.index === index) ??
                null;
            const itemStart = targetItem
                ? targetItem.start
                : (() => {
                      let total = 0;
                      for (let cursor = 0; cursor < index; cursor += 1) {
                          total +=
                              measuredSizes.get(itemKeys[cursor]) ??
                              estimateSize(items[cursor], cursor);
                      }
                      return total;
                  })();
            const itemSize =
                targetItem?.size ??
                measuredSizes.get(itemKeys[index]) ??
                estimateSize(items[index], index);
            const maxScrollTop = Math.max(
                0,
                layout.totalSize - container.clientHeight,
            );

            let nextScrollTop = itemStart + offset;

            if (align === "center") {
                nextScrollTop =
                    itemStart -
                    container.clientHeight / 2 +
                    itemSize / 2 +
                    offset;
            } else if (align === "end") {
                nextScrollTop =
                    itemStart - container.clientHeight + itemSize + offset;
            }

            container.scrollTop = clamp(nextScrollTop, 0, maxScrollTop);
        },
        [
            estimateSize,
            itemKeys,
            items,
            layout,
            measuredSizes,
            scrollContainerRef,
        ],
    );

    useEffect(() => {
        onReady?.({ scrollToIndex });

        return () => {
            onReady?.(null);
        };
    }, [onReady, scrollToIndex]);

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
                                itemKeys[index],
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
                        setMeasuredElement(virtualItem.key, node);
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
