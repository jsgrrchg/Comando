import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

import type { MeasuredVirtualListHandle } from "./MeasuredVirtualList";

const DEFAULT_OVERSCAN = 8;

export interface FixedVirtualListProps<T> {
    readonly enabled?: boolean;
    readonly getItemKey: (item: T, index: number) => string;
    readonly itemHeight: number;
    readonly items: readonly T[];
    readonly onReady?: (handle: MeasuredVirtualListHandle | null) => void;
    readonly overscan?: number;
    readonly renderItem: (params: {
        readonly index: number;
        readonly item: T;
    }) => ReactNode;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
}

/**
 * Fixed-height lists deliberately do not observe row layout. They are intended
 * for dense tree/table surfaces where a stable row contract is cheaper and
 * more reliable than a generic measured virtualizer.
 */
export function FixedVirtualList<T>({
    enabled = true,
    getItemKey,
    itemHeight,
    items,
    onReady,
    overscan = DEFAULT_OVERSCAN,
    renderItem,
    scrollContainerRef,
}: FixedVirtualListProps<T>) {
    const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });
    const normalizedItemHeight = Math.max(1, Math.ceil(itemHeight));
    const virtualizationEnabled = enabled && typeof window !== "undefined";

    useEffect(() => {
        if (!virtualizationEnabled) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const sync = () => {
            const next = {
                height: container.clientHeight,
                scrollTop: container.scrollTop,
            };
            setViewport((current) =>
                current.height === next.height &&
                current.scrollTop === next.scrollTop
                    ? current
                    : next,
            );
        };

        sync();
        container.addEventListener("scroll", sync, { passive: true });
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(sync);
        observer?.observe(container);

        return () => {
            container.removeEventListener("scroll", sync);
            observer?.disconnect();
        };
    }, [scrollContainerRef, virtualizationEnabled]);

    const range = useMemo(() => {
        if (!virtualizationEnabled) {
            return { end: items.length - 1, start: 0 };
        }
        const firstVisible = Math.max(
            0,
            Math.floor(viewport.scrollTop / normalizedItemHeight),
        );
        const visibleCount = Math.max(
            1,
            Math.ceil(viewport.height / normalizedItemHeight),
        );
        return {
            end: Math.min(items.length - 1, firstVisible + visibleCount + overscan),
            start: Math.max(0, firstVisible - overscan),
        };
    }, [items.length, normalizedItemHeight, overscan, viewport, virtualizationEnabled]);

    const scrollToIndex = useCallback<MeasuredVirtualListHandle["scrollToIndex"]>(
        (index, options) => {
            const container = scrollContainerRef.current;
            if (!container || index < 0 || index >= items.length) {
                return;
            }
            const align = options?.align ?? "start";
            const offset = options?.offset ?? 0;
            const start = index * normalizedItemHeight;
            const viewportHeight = Math.max(1, container.clientHeight);
            const target =
                align === "center"
                    ? start - viewportHeight / 2 + normalizedItemHeight / 2
                    : align === "end"
                      ? start - viewportHeight + normalizedItemHeight
                      : start;
            container.scrollTop = Math.max(0, target + offset);
        },
        [items.length, normalizedItemHeight, scrollContainerRef],
    );

    useEffect(() => {
        onReady?.({ scrollToIndex });
        return () => onReady?.(null);
    }, [onReady, scrollToIndex]);

    if (items.length === 0) {
        return null;
    }

    if (!virtualizationEnabled) {
        return <div className="relative w-full">{items.map((item, index) => renderItem({ index, item }))}</div>;
    }

    const visibleItems = [];
    for (let index = range.start; index <= range.end; index += 1) {
        const item = items[index];
        visibleItems.push(
            <div
                data-fixed-list-key={getItemKey(item, index)}
                key={getItemKey(item, index)}
                style={{
                    height: `${normalizedItemHeight}px`,
                    left: 0,
                    position: "absolute",
                    right: 0,
                    top: `${index * normalizedItemHeight}px`,
                }}
            >
                {renderItem({ index, item })}
            </div>,
        );
    }

    return (
        <div
            className="relative w-full"
            style={{ height: `${items.length * normalizedItemHeight}px` }}
        >
            {visibleItems}
        </div>
    );
}
