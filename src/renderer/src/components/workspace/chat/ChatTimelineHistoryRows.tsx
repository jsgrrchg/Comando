import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from "react";

import type { AiToolCardExpansionMode } from "@shared/ipc";
import {
    MeasuredVirtualList,
    type MeasuredVirtualListHandle,
    type MeasuredVirtualRange,
    type MeasuredVirtualViewportAnchor,
} from "@renderer/components/virtual/MeasuredVirtualList";

import type { ChatTimelineRow } from "./chatTimelineModel";
import {
    CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
    CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN,
    calculateChatTimelineVirtualScrollMarginTop,
    estimateChatTimelineRowHeight,
    getChatTimelineRowMeasurementKey,
    getChatTimelineRowKey,
    getChatTimelineVirtualMeasurementWidth,
    getChatTimelineVirtualRowGapPx,
    shouldVirtualizeChatTimeline,
} from "./chatTimelineVirtualization";

interface ChatTimelineHistoryRowsProps {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly latestStreamingEditedFileToolRowId: string | null;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onVirtualResizeAutoFollow?: () => void;
    readonly renderRow: (params: {
        readonly isLatestStreamingTool: boolean;
        readonly row: ChatTimelineRow;
    }) => ReactNode;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
}

export const ChatTimelineHistoryRows = memo(
    function ChatTimelineHistoryRows({
        chatFontFamily,
        chatFontSize,
        historyRows,
        latestStreamingEditedFileToolRowId,
        onVirtualRangeChange,
        onVirtualResizeAutoFollow,
        renderRow,
        scrollRef,
        shouldPreserveVirtualResizeAnchor,
        toolCardExpansionMode,
    }: ChatTimelineHistoryRowsProps) {
        const historyRef = useRef<HTMLDivElement | null>(null);
        const pendingResizeAnchorFrameRef = useRef<number | null>(null);
        const pendingResizeAnchorRef =
            useRef<MeasuredVirtualViewportAnchor | null>(null);
        const previousScrollContainerWidthRef = useRef<number | null>(null);
        const virtualListHandleRef = useRef<MeasuredVirtualListHandle | null>(
            null,
        );
        const [scrollMarginTop, setScrollMarginTop] = useState(0);
        const [scrollContainerWidth, setScrollContainerWidth] = useState(0);
        const shouldVirtualize = shouldVirtualizeChatTimeline(
            historyRows.length,
        );

        const restorePendingResizeAnchor = useCallback(() => {
            const anchor = pendingResizeAnchorRef.current;
            pendingResizeAnchorRef.current = null;

            if (!anchor) {
                return;
            }

            virtualListHandleRef.current?.scrollToViewportAnchor?.(anchor);
        }, []);

        const scheduleResizeAnchorRestore = useCallback(() => {
            if (typeof window === "undefined") {
                restorePendingResizeAnchor();
                return;
            }

            if (pendingResizeAnchorFrameRef.current !== null) {
                window.cancelAnimationFrame(
                    pendingResizeAnchorFrameRef.current,
                );
            }

            pendingResizeAnchorFrameRef.current = window.requestAnimationFrame(
                () => {
                    pendingResizeAnchorFrameRef.current = null;
                    restorePendingResizeAnchor();
                },
            );
        }, [restorePendingResizeAnchor]);

        const syncLayoutMetrics = useCallback(() => {
            const historyElement = historyRef.current;
            const scrollContainer = scrollRef.current;
            const nextScrollContainerWidth = scrollContainer?.clientWidth ?? 0;
            const previousScrollContainerWidth =
                previousScrollContainerWidthRef.current;
            previousScrollContainerWidthRef.current = nextScrollContainerWidth;

            if (
                shouldVirtualize &&
                previousScrollContainerWidth !== null &&
                previousScrollContainerWidth !== nextScrollContainerWidth
            ) {
                if (shouldPreserveVirtualResizeAnchor?.() ?? true) {
                    pendingResizeAnchorRef.current =
                        virtualListHandleRef.current?.captureViewportAnchor?.() ??
                        null;
                    scheduleResizeAnchorRestore();
                } else {
                    pendingResizeAnchorRef.current = null;
                    onVirtualResizeAutoFollow?.();
                }
            }

            setScrollMarginTop(
                calculateChatTimelineVirtualScrollMarginTop({
                    historyElement,
                    scrollContainer,
                }),
            );
            setScrollContainerWidth(
                getChatTimelineVirtualMeasurementWidth(
                    nextScrollContainerWidth,
                ),
            );
        }, [
            onVirtualResizeAutoFollow,
            scheduleResizeAnchorRestore,
            scrollRef,
            shouldPreserveVirtualResizeAnchor,
            shouldVirtualize,
        ]);

        const handleVirtualListReady = useCallback(
            (handle: MeasuredVirtualListHandle | null) => {
                virtualListHandleRef.current = handle;
            },
            [],
        );

        useLayoutEffect(() => {
            if (!shouldVirtualize) {
                return;
            }

            syncLayoutMetrics();
        }, [historyRows.length, shouldVirtualize, syncLayoutMetrics]);

        useEffect(() => {
            if (!shouldVirtualize || typeof ResizeObserver === "undefined") {
                return;
            }

            const historyElement = historyRef.current;
            const scrollContainer = scrollRef.current;
            if (!historyElement || !scrollContainer) {
                return;
            }

            syncLayoutMetrics();

            const observer = new ResizeObserver(() => {
                syncLayoutMetrics();
            });

            observer.observe(historyElement);
            observer.observe(scrollContainer);
            window.addEventListener("resize", syncLayoutMetrics);

            return () => {
                observer.disconnect();
                window.removeEventListener("resize", syncLayoutMetrics);
            };
        }, [scrollRef, shouldVirtualize, syncLayoutMetrics]);

        useLayoutEffect(() => {
            restorePendingResizeAnchor();
        }, [restorePendingResizeAnchor, scrollContainerWidth]);

        useEffect(() => {
            return () => {
                if (pendingResizeAnchorFrameRef.current !== null) {
                    window.cancelAnimationFrame(
                        pendingResizeAnchorFrameRef.current,
                    );
                    pendingResizeAnchorFrameRef.current = null;
                }
            };
        }, []);

        const estimateSize = useCallback(
            (row: ChatTimelineRow, index: number) =>
                estimateChatTimelineRowHeight(row, {
                    chatFontSize,
                    gapPx: getChatTimelineVirtualRowGapPx({
                        index,
                        rowCount: historyRows.length,
                    }),
                    isLatestStreamingTool:
                        row.id === latestStreamingEditedFileToolRowId,
                    toolCardExpansionMode,
                    width: scrollContainerWidth,
                }),
            [
                chatFontSize,
                historyRows.length,
                latestStreamingEditedFileToolRowId,
                scrollContainerWidth,
                toolCardExpansionMode,
            ],
        );

        const getItemMeasurementKey = useCallback(
            (row: ChatTimelineRow, index: number) =>
                getChatTimelineRowMeasurementKey(row, {
                    chatFontFamily,
                    chatFontSize,
                    gapPx: getChatTimelineVirtualRowGapPx({
                        index,
                        rowCount: historyRows.length,
                    }),
                    isLatestStreamingTool:
                        row.id === latestStreamingEditedFileToolRowId,
                    toolCardExpansionMode,
                    width: scrollContainerWidth,
                }),
            [
                chatFontFamily,
                chatFontSize,
                historyRows.length,
                latestStreamingEditedFileToolRowId,
                scrollContainerWidth,
                toolCardExpansionMode,
            ],
        );

        const renderVirtualItem = useCallback(
            ({
                index,
                item,
            }: {
                readonly index: number;
                readonly isVisible: boolean;
                readonly item: ChatTimelineRow;
            }) => {
                const gapPx = getChatTimelineVirtualRowGapPx({
                    index,
                    rowCount: historyRows.length,
                });

                return (
                    <div
                        style={
                            gapPx > 0
                                ? { paddingBottom: `${gapPx}px` }
                                : undefined
                        }
                    >
                        {renderRow({
                            isLatestStreamingTool:
                                item.id === latestStreamingEditedFileToolRowId,
                            row: item,
                        })}
                    </div>
                );
            },
            [
                historyRows.length,
                latestStreamingEditedFileToolRowId,
                renderRow,
            ],
        );

        if (!shouldVirtualize) {
            return (
                <>
                    {historyRows.map((row) =>
                        renderRow({
                            isLatestStreamingTool:
                                row.id === latestStreamingEditedFileToolRowId,
                            row,
                        }),
                    )}
                </>
            );
        }

        return (
            <div ref={historyRef} className="relative w-full">
                <MeasuredVirtualList
                    defaultViewportHeight={
                        CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
                    }
                    estimateSize={estimateSize}
                    getItemKey={getChatTimelineRowKey}
                    getItemMeasurementKey={getItemMeasurementKey}
                    items={historyRows}
                    onRangeChange={onVirtualRangeChange}
                    onReady={handleVirtualListReady}
                    overscan={CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN}
                    preserveScrollAnchorOnMeasure
                    scrollContainerRef={scrollRef}
                    scrollMarginTop={scrollMarginTop}
                    renderItem={renderVirtualItem}
                />
            </div>
        );
    },
);

ChatTimelineHistoryRows.displayName = "ChatTimelineHistoryRows";
