import {
    Fragment,
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
import { useShellStore } from "@renderer/app/store/shell-store";
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
    getChatTimelineEffectiveContentWidth,
    getChatTimelineRowIdentityKey,
    getChatTimelineRowMeasurementKey,
    getChatTimelineRowKey,
    getChatTimelineVirtualMeasurementWidth,
    getChatTimelineVirtualRowGapPx,
    shouldVirtualizeChatTimeline,
    type ChatTimelineRowMeasurementContext,
} from "./chatTimelineVirtualization";

const MIN_FREEZABLE_CHAT_TIMELINE_WIDTH_PX = 240;

interface ChatTimelineHistoryRowsProps {
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly ChatTimelineRow[];
    readonly latestStreamingEditedFileToolRowId: string | null;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onVirtualResizeEnd?: () => void;
    readonly onVirtualResizeAutoFollow?: () => void;
    readonly onVirtualResizeStart?: () => void;
    readonly renderRow: (params: {
        readonly isLatestStreamingTool: boolean;
        readonly row: ChatTimelineRow;
    }) => ReactNode;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
    readonly toolCardExpansionMode: AiToolCardExpansionMode;
}

export function resolveChatTimelineFrozenContentWidth(input: {
    readonly measuredWidth: number;
    readonly scrollContainerWidth: number;
}): number | null {
    if (
        Number.isFinite(input.measuredWidth) &&
        input.measuredWidth >= MIN_FREEZABLE_CHAT_TIMELINE_WIDTH_PX
    ) {
        return input.measuredWidth;
    }

    const fallbackWidth = getChatTimelineEffectiveContentWidth(
        input.scrollContainerWidth,
    );
    return fallbackWidth >= MIN_FREEZABLE_CHAT_TIMELINE_WIDTH_PX
        ? fallbackWidth
        : null;
}

export const ChatTimelineHistoryRows = memo(
    function ChatTimelineHistoryRows({
        chatFontFamily,
        chatFontSize,
        historyRows,
        latestStreamingEditedFileToolRowId,
        onVirtualRangeChange,
        onVirtualResizeEnd,
        onVirtualResizeAutoFollow,
        onVirtualResizeStart,
        renderRow,
        scrollRef,
        shouldPreserveVirtualMeasureAnchor,
        shouldPreserveVirtualResizeAnchor,
        toolCardExpansionMode,
    }: ChatTimelineHistoryRowsProps) {
        const historyRef = useRef<HTMLDivElement | null>(null);
        const pendingResizeAnchorFrameRef = useRef<number | null>(null);
        const pendingResizeAnchorRef =
            useRef<MeasuredVirtualViewportAnchor | null>(null);
        const pendingVirtualResizeEndRef = useRef(false);
        const previousContentMeasurementWidthRef = useRef<number | null>(null);
        const virtualListHandleRef = useRef<MeasuredVirtualListHandle | null>(
            null,
        );
        const virtualResizeActiveRef = useRef(false);
        const [scrollMarginTop, setScrollMarginTop] = useState(0);
        const [contentMeasurementWidth, setContentMeasurementWidth] =
            useState(0);
        // While the pane splitter is being dragged we freeze the timeline: the
        // content keeps its pre-drag width (so rows don't reflow) and all metric
        // updates are skipped, then we re-sync once on release. frozenContentWidth
        // is the pinned width (null = not frozen); the ref mirrors it for the
        // synchronous early-return inside syncLayoutMetrics.
        const isResizingPanel = useShellStore((state) => state.isResizingPanel);
        const [frozenContentWidth, setFrozenContentWidth] = useState<
            number | null
        >(null);
        const isFreezeActiveRef = useRef(false);
        isFreezeActiveRef.current = frozenContentWidth !== null;
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
            // Frozen during an active splitter drag: skip every metric/anchor
            // update so the scroll stays put. The single re-sync happens when the
            // freeze lifts (see the freeze effects below).
            if (isFreezeActiveRef.current) {
                return;
            }

            const historyElement = historyRef.current;
            const scrollContainer = scrollRef.current;
            const nextContentWidth =
                historyElement?.getBoundingClientRect().width ??
                getChatTimelineEffectiveContentWidth(
                    scrollContainer?.clientWidth ?? 0,
                );
            const nextContentMeasurementWidth =
                getChatTimelineVirtualMeasurementWidth(nextContentWidth);
            const previousContentMeasurementWidth =
                previousContentMeasurementWidthRef.current;
            previousContentMeasurementWidthRef.current =
                nextContentMeasurementWidth;

            if (
                shouldVirtualize &&
                previousContentMeasurementWidth !== null &&
                previousContentMeasurementWidth !==
                    nextContentMeasurementWidth
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
            setContentMeasurementWidth(nextContentMeasurementWidth);
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
        }, [contentMeasurementWidth, restorePendingResizeAnchor]);

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

        // Engage/lift the freeze as the splitter drag starts/ends. Captured
        // before the first width change lands (pointerdown precedes pointermove),
        // so the pinned width matches the pre-drag layout exactly.
        useLayoutEffect(() => {
            if (!shouldVirtualize) {
                if (virtualResizeActiveRef.current) {
                    virtualResizeActiveRef.current = false;
                    pendingVirtualResizeEndRef.current = false;
                    onVirtualResizeEnd?.();
                }
                return;
            }

            if (isResizingPanel) {
                if (!virtualResizeActiveRef.current) {
                    virtualResizeActiveRef.current = true;
                    pendingVirtualResizeEndRef.current = false;
                    onVirtualResizeStart?.();
                }

                setFrozenContentWidth(
                    resolveChatTimelineFrozenContentWidth({
                        measuredWidth:
                            historyRef.current?.getBoundingClientRect().width ??
                            0,
                        scrollContainerWidth: scrollRef.current?.clientWidth ?? 0,
                    }),
                );
            } else {
                if (virtualResizeActiveRef.current) {
                    pendingVirtualResizeEndRef.current = true;
                }

                setFrozenContentWidth(null);
            }
        }, [
            isResizingPanel,
            onVirtualResizeEnd,
            onVirtualResizeStart,
            shouldVirtualize,
        ]);

        // Once the freeze lifts the DOM holds the real width again, so adopt it
        // and re-anchor exactly once — instead of on every drag frame.
        useLayoutEffect(() => {
            if (!shouldVirtualize || frozenContentWidth !== null) {
                return;
            }

            syncLayoutMetrics();

            if (pendingVirtualResizeEndRef.current) {
                pendingVirtualResizeEndRef.current = false;
                virtualResizeActiveRef.current = false;
                onVirtualResizeEnd?.();
            }
        }, [
            frozenContentWidth,
            onVirtualResizeEnd,
            shouldVirtualize,
            syncLayoutMetrics,
        ]);

        // The gap below a row depends only on its position in the list, so it is
        // resolved once here and shared by the row context and the rendered
        // wrapper — keeping it off buildRowContext's dependency churn so the row
        // renderer stays as stable as historyRows.length.
        const resolveRowGapPx = useCallback(
            (index: number) =>
                getChatTimelineVirtualRowGapPx({
                    index,
                    rowCount: historyRows.length,
                }),
            [historyRows.length],
        );

        // The estimate, the measurement key and the width-invariant identity key
        // all derive from the same per-row layout inputs and must stay in
        // lockstep — a divergence would key a fresh measurement against the wrong
        // estimate. Build that context once. ChatTimelineRowMeasurementContext
        // extends the estimate context, so one object satisfies all three; the
        // identity key simply ignores the width bucket it carries.
        const buildRowContext = useCallback(
            (
                row: ChatTimelineRow,
                index: number,
            ): ChatTimelineRowMeasurementContext => ({
                chatFontFamily,
                chatFontSize,
                gapPx: resolveRowGapPx(index),
                isLatestStreamingTool:
                    row.id === latestStreamingEditedFileToolRowId,
                toolCardExpansionMode,
                width: contentMeasurementWidth,
            }),
            [
                chatFontFamily,
                contentMeasurementWidth,
                chatFontSize,
                latestStreamingEditedFileToolRowId,
                resolveRowGapPx,
                toolCardExpansionMode,
            ],
        );

        const estimateSize = useCallback(
            (row: ChatTimelineRow, index: number) =>
                estimateChatTimelineRowHeight(row, buildRowContext(row, index)),
            [buildRowContext],
        );

        const getItemMeasurementKey = useCallback(
            (row: ChatTimelineRow, index: number) =>
                getChatTimelineRowMeasurementKey(
                    row,
                    buildRowContext(row, index),
                ),
            [buildRowContext],
        );

        const getItemIdentityKey = useCallback(
            (row: ChatTimelineRow, index: number) =>
                getChatTimelineRowIdentityKey(row, buildRowContext(row, index)),
            [buildRowContext],
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
                const gapPx = resolveRowGapPx(index);

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
                latestStreamingEditedFileToolRowId,
                renderRow,
                resolveRowGapPx,
            ],
        );

        if (!shouldVirtualize) {
            return (
                <>
                    {historyRows.map((row) => (
                        <Fragment key={row.id}>
                            {renderRow({
                                isLatestStreamingTool:
                                    row.id ===
                                    latestStreamingEditedFileToolRowId,
                                row,
                            })}
                        </Fragment>
                    ))}
                </>
            );
        }

        return (
            <div
                ref={historyRef}
                className="relative w-full"
                // Pin the content width while dragging the splitter so rows keep
                // their pre-drag layout (no reflow); clip any overhang instead of
                // letting it spill. Released to fluid width on drag end.
                style={
                    frozenContentWidth !== null
                        ? { width: frozenContentWidth, overflowX: "clip" }
                        : undefined
                }
            >
                <MeasuredVirtualList
                    defaultViewportHeight={
                        CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
                    }
                    estimateSize={estimateSize}
                    getItemKey={getChatTimelineRowKey}
                    getItemIdentityKey={getItemIdentityKey}
                    getItemMeasurementKey={getItemMeasurementKey}
                    items={historyRows}
                    onRangeChange={onVirtualRangeChange}
                    onReady={handleVirtualListReady}
                    overscan={CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN}
                    preserveScrollAnchorOnMeasure
                    shouldPreserveScrollAnchorOnMeasure={
                        shouldPreserveVirtualMeasureAnchor
                    }
                    scrollContainerRef={scrollRef}
                    scrollMarginTop={scrollMarginTop}
                    renderItem={renderVirtualItem}
                />
            </div>
        );
    },
);

ChatTimelineHistoryRows.displayName = "ChatTimelineHistoryRows";
