import {
    cloneElement,
    isValidElement,
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
    type RefObject,
} from "react";

import {
    MeasuredVirtualList,
    type MeasuredVirtualRange,
} from "../virtual/MeasuredVirtualList";

const DEFAULT_TABLE_ROW_OVERSCAN = 6;
const DEFAULT_TABLE_VIEWPORT_HEIGHT = 720;

interface TableRowLayoutProps {
    readonly className?: string;
    readonly style?: CSSProperties;
}

export interface GitHubVirtualizedTableBodyProps<T> {
    readonly defaultViewportHeight?: number;
    readonly estimateRowHeight: (item: T, index: number) => number;
    readonly getRowKey: (item: T, index: number) => string;
    readonly gridTemplateColumns: string;
    readonly items: readonly T[];
    readonly minWidth: number;
    readonly onRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly overscan?: number;
    readonly renderRow: (item: T, index: number) => ReactNode;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
    readonly threshold: number;
}

export function GitHubVirtualizedTableBody<T>({
    defaultViewportHeight = DEFAULT_TABLE_VIEWPORT_HEIGHT,
    estimateRowHeight,
    getRowKey,
    gridTemplateColumns,
    items,
    minWidth,
    onRangeChange,
    overscan = DEFAULT_TABLE_ROW_OVERSCAN,
    renderRow,
    scrollContainerRef,
    threshold,
}: GitHubVirtualizedTableBodyProps<T>) {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [scrollMarginTop, setScrollMarginTop] = useState(0);
    const shouldVirtualize = items.length >= threshold;

    const renderLaidOutRow = useCallback(
        (item: T, index: number) =>
            applyGitHubVirtualizedTableRowLayout({
                gridTemplateColumns,
                minWidth,
                row: renderRow(item, index),
            }),
        [gridTemplateColumns, minWidth, renderRow],
    );

    useEffect(() => {
        if (!shouldVirtualize) {
            return;
        }

        const bodyElement = bodyRef.current;
        const scrollContainer = scrollContainerRef.current;
        if (!bodyElement || !scrollContainer) {
            return;
        }

        const syncScrollMarginTop = () => {
            const bodyRect = bodyElement.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            const nextScrollMarginTop = Math.max(
                0,
                Math.round(
                    bodyRect.top - containerRect.top + scrollContainer.scrollTop,
                ),
            );

            setScrollMarginTop((current) =>
                current === nextScrollMarginTop
                    ? current
                    : nextScrollMarginTop,
            );
        };

        syncScrollMarginTop();
        window.addEventListener("resize", syncScrollMarginTop);

        let resizeObserver: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(syncScrollMarginTop);
            resizeObserver.observe(bodyElement);
            resizeObserver.observe(scrollContainer);
        }

        return () => {
            window.removeEventListener("resize", syncScrollMarginTop);
            resizeObserver?.disconnect();
        };
    }, [scrollContainerRef, shouldVirtualize]);

    if (items.length === 0) {
        return null;
    }

    if (!shouldVirtualize) {
        return (
            <div className="relative w-full" ref={bodyRef}>
                {items.map((item, index) => (
                    <div key={getRowKey(item, index)}>
                        {renderLaidOutRow(item, index)}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="relative w-full" ref={bodyRef}>
            <MeasuredVirtualList
                defaultViewportHeight={defaultViewportHeight}
                enabled
                estimateSize={estimateRowHeight}
                getItemKey={getRowKey}
                items={items}
                onRangeChange={onRangeChange}
                overscan={overscan}
                renderItem={({ index, item }) => renderLaidOutRow(item, index)}
                scrollContainerRef={scrollContainerRef}
                scrollMarginTop={scrollMarginTop}
            />
        </div>
    );
}

export function applyGitHubVirtualizedTableRowLayout({
    gridTemplateColumns,
    minWidth,
    row,
}: {
    readonly gridTemplateColumns: string;
    readonly minWidth: number;
    readonly row: ReactNode;
}): ReactNode {
    const layoutStyle: CSSProperties = {
        gridTemplateColumns,
        minWidth,
    };

    if (!isValidElement<TableRowLayoutProps>(row)) {
        return (
            <div className="grid" style={layoutStyle}>
                {row}
            </div>
        );
    }

    return cloneElement(row, {
        className: mergeGridClassName(row.props.className),
        style: {
            ...row.props.style,
            ...layoutStyle,
        },
    });
}

function mergeGridClassName(className: string | undefined): string {
    if (!className) {
        return "grid";
    }

    return className.split(/\s+/).includes("grid")
        ? className
        : `grid ${className}`;
}
