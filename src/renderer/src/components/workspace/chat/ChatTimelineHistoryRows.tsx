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
} from "@renderer/components/virtual/MeasuredVirtualList";

import type { ChatTimelineRow } from "./chatTimelineModel";
import {
    CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
    CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN,
    calculateChatTimelineVirtualScrollMarginTop,
    estimateChatTimelineRowHeight,
    getChatTimelineRowMeasurementKey,
    getChatTimelineRowKey,
    getChatTimelineVirtualRowGapPx,
    shouldVirtualizeChatTimeline,
} from "./chatTimelineVirtualization";

interface ChatTimelineHistoryRowsProps {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly latestStreamingEditedFileToolRowId: string | null;
    readonly onVirtualListReady?: (
        handle: MeasuredVirtualListHandle | null,
    ) => void;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly renderRow: (params: {
        readonly isLatestStreamingTool: boolean;
        readonly row: ChatTimelineRow;
    }) => ReactNode;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
}

export const ChatTimelineHistoryRows = memo(
    function ChatTimelineHistoryRows({
        chatFontFamily,
        chatFontSize,
        historyRows,
        latestStreamingEditedFileToolRowId,
        onVirtualListReady,
        onVirtualRangeChange,
        renderRow,
        scrollRef,
        toolCardExpansionMode,
    }: ChatTimelineHistoryRowsProps) {
        const historyRef = useRef<HTMLDivElement | null>(null);
        const [scrollMarginTop, setScrollMarginTop] = useState(0);
        const [scrollContainerWidth, setScrollContainerWidth] = useState(0);
        const shouldVirtualize = shouldVirtualizeChatTimeline(
            historyRows.length,
        );

        const syncLayoutMetrics = useCallback(() => {
            const historyElement = historyRef.current;
            const scrollContainer = scrollRef.current;

            setScrollMarginTop(
                calculateChatTimelineVirtualScrollMarginTop({
                    historyElement,
                    scrollContainer,
                }),
            );
            setScrollContainerWidth(scrollContainer?.clientWidth ?? 0);
        }, [scrollRef]);

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
                }),
            [
                chatFontSize,
                historyRows.length,
                latestStreamingEditedFileToolRowId,
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
                    onReady={onVirtualListReady}
                    overscan={CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN}
                    scrollContainerRef={scrollRef}
                    scrollMarginTop={scrollMarginTop}
                    renderItem={renderVirtualItem}
                />
            </div>
        );
    },
);

ChatTimelineHistoryRows.displayName = "ChatTimelineHistoryRows";
