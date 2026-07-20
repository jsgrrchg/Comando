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

import { useSettingsStore } from "@renderer/app/store/settings-store";
import { useShellStore } from "@renderer/app/store/shell-store";
import {
    hashChatPerformanceLabel,
    isChatPerformanceProbeEnabled,
    recordChatPerformanceMetric,
} from "@renderer/app/debug/chatPerformanceProbe";
import {
    MeasuredVirtualList,
    type MeasuredVirtualListHandle,
    type MeasuredVirtualRange,
    type MeasuredVirtualViewportAnchor,
} from "@renderer/components/virtual/MeasuredVirtualList";

import { ChatPresentationErrorBoundary } from "./ChatPresentationErrorBoundary";
import {
    isChatTimelineRowItem,
    isTranscriptActivitySummaryItem,
    isTranscriptBlockSpacerItem,
    isTranscriptStreamingIndicatorItem,
    type TranscriptTimelineItem,
    type TranscriptTimelineVirtualRow,
    type TranscriptStreamingIndicatorItem,
} from "./transcriptBlockVirtualization";
import {
    CHAT_TIMELINE_VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
    CHAT_TIMELINE_ESTIMATE_CALIBRATION_ALPHA,
    CHAT_TIMELINE_ESTIMATE_CALIBRATION_MAX_MULTIPLIER,
    CHAT_TIMELINE_ESTIMATE_CALIBRATION_MIN_MULTIPLIER,
    CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN,
    calculateChatTimelineVirtualScrollMarginTop,
    estimateChatTimelineRowBaseHeight,
    estimateChatTimelineRowHeight,
    getChatTimelineEffectiveContentWidth,
    getChatTimelineRowEstimateBucket,
    getChatTimelineRowIdentityKey,
    getChatTimelineRowMeasurementKey,
    getChatTimelineVirtualMeasurementWidth,
    getChatTimelineVirtualRowGapPx,
    type ChatTimelineRowMeasurementContext,
} from "./chatTimelineVirtualization";

const MIN_FREEZABLE_CHAT_TIMELINE_WIDTH_PX = 240;
const NEW_TURN_ANCHOR_OFFSET_PX = 20;
const MAX_ESTIMATE_CALIBRATION_BUCKETS = 96;

interface ChatTimelineHistoryRowsProps {
    readonly active?: boolean;
    readonly chatFontFamily?: string;
    readonly chatFontSize?: number;
    readonly historyRows: readonly TranscriptTimelineItem[];
    readonly sessionId?: string;
    readonly onVirtualRangeChange?: (range: MeasuredVirtualRange) => void;
    readonly onVirtualResizeEnd?: () => void;
    readonly onVirtualResizeAutoFollow?: () => void;
    readonly onVirtualResizeStart?: () => void;
    readonly onNewTurnScrollTarget?: (target: number) => void;
    readonly liveTailRowId?: string | null;
    readonly newTurnAnchorRowId?: string | null;
    readonly renderRow: (params: {
        readonly isCurrentTurnTail: boolean;
        readonly row: TranscriptTimelineVirtualRow;
    }) => ReactNode;
    readonly renderStreamingIndicator: (
        item: TranscriptStreamingIndicatorItem,
    ) => ReactNode;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly shouldDeferTrailingUserMeasurementAnchor?: () => boolean;
    readonly shouldPreserveVirtualMeasureAnchor?: () => boolean;
    readonly shouldPreserveVirtualResizeAnchor?: () => boolean;
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

function getTrailingUserRowId(
    rows: readonly TranscriptTimelineItem[],
): string | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (!row || !isChatTimelineRowItem(row)) {
            continue;
        }

        return row.kind === "message" && row.message.kind === "user"
            ? row.id
            : null;
    }

    return null;
}

export const ChatTimelineHistoryRows = memo(
    function ChatTimelineHistoryRows({
        active = true,
        chatFontFamily,
        chatFontSize,
        historyRows,
        sessionId,
        onVirtualRangeChange,
        onVirtualResizeEnd,
        onVirtualResizeAutoFollow,
        onVirtualResizeStart,
        onNewTurnScrollTarget,
        liveTailRowId,
        newTurnAnchorRowId,
        renderRow,
        renderStreamingIndicator,
        scrollRef,
        shouldDeferTrailingUserMeasurementAnchor,
        shouldPreserveVirtualMeasureAnchor,
        shouldPreserveVirtualResizeAnchor,
    }: ChatTimelineHistoryRowsProps) {
        const historyRef = useRef<HTMLDivElement | null>(null);
        const toolActivityDefaultExpansion = useSettingsStore(
            (state) => state.aiChat.toolActivityDefaultExpansion,
        );
        const pendingResizeAnchorFrameRef = useRef<number | null>(null);
        const pendingResizeAnchorRef =
            useRef<MeasuredVirtualViewportAnchor | null>(null);
        const pendingVirtualResizeEndRef = useRef(false);
        const previousContentMeasurementWidthRef = useRef<number | null>(null);
        const virtualListHandleRef = useRef<MeasuredVirtualListHandle | null>(
            null,
        );
        const virtualResizeActiveRef = useRef(false);
        const handledTrailingUserMeasurementRef = useRef<string | null>(null);
        // This is intentionally local to the mounted timeline: measurements are
        // only a rendering hint and must never become persisted chat state.
        const estimateCalibrationRef = useRef(new Map<string, number>());
        const [scrollMarginTop, setScrollMarginTop] = useState(0);
        const [contentMeasurementWidth, setContentMeasurementWidth] =
            useState(0);
        const trailingUserRowId = getTrailingUserRowId(historyRows);
        const shouldPreserveVirtualMeasureAnchorForItem = useCallback(
            (row: TranscriptTimelineItem) => {
                if (
                    !shouldDeferTrailingUserMeasurementAnchor?.() ||
                    row.id !== trailingUserRowId ||
                    handledTrailingUserMeasurementRef.current === row.id
                ) {
                    return true;
                }

                // The newest prompt is entering at the followed edge. Let the
                // final bottom-follow pass absorb its first real measurement.
                handledTrailingUserMeasurementRef.current = row.id;
                return false;
            },
            [shouldDeferTrailingUserMeasurementAnchor, trailingUserRowId],
        );
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
        const isActiveRef = useRef(active);
        isFreezeActiveRef.current = frozenContentWidth !== null;
        isActiveRef.current = active;
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
            if (!isActiveRef.current || isFreezeActiveRef.current) {
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
                previousContentMeasurementWidth !== null &&
                previousContentMeasurementWidth !== nextContentMeasurementWidth
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
        ]);

        const handleVirtualListReady = useCallback(
            (handle: MeasuredVirtualListHandle | null) => {
                virtualListHandleRef.current = handle;
            },
            [],
        );

        useLayoutEffect(() => {
            if (!active || !newTurnAnchorRowId) {
                return;
            }

            const handle = virtualListHandleRef.current;
            const scrollContainer = scrollRef.current;
            const anchorIndex = historyRows.findIndex(
                (row) => row.id === newTurnAnchorRowId,
            );
            if (!handle || !scrollContainer || anchorIndex < 0) {
                return;
            }

            const anchor = handle.getItemGeometry?.(anchorIndex);
            if (!anchor) {
                return;
            }

            const tailIndex = liveTailRowId
                ? historyRows.findIndex((row) => row.id === liveTailRowId)
                : historyRows.length - 1;
            const tail = handle.getItemGeometry?.(
                tailIndex >= anchorIndex ? tailIndex : anchorIndex,
            );
            if (!tail) {
                return;
            }

            // The composer already reduces the scroll viewport in this flex layout.
            // Keep the prompt visible until the active turn needs more room below it.
            const requiredEnd = Math.max(
                0,
                tail.start + tail.size -
                    (anchor.start + scrollContainer.clientHeight),
            );
            // The parent serializes every scroll write against navigation intent.
            onNewTurnScrollTarget?.(
                Math.max(
                    0,
                    anchor.start + scrollMarginTop - NEW_TURN_ANCHOR_OFFSET_PX +
                        requiredEnd,
                ),
            );
        }, [
            active,
            historyRows,
            liveTailRowId,
            newTurnAnchorRowId,
            onNewTurnScrollTarget,
            scrollMarginTop,
            scrollRef,
        ]);

        useLayoutEffect(() => {
            if (!active) {
                return;
            }

            syncLayoutMetrics();
        }, [active, historyRows.length, syncLayoutMetrics]);

        useEffect(() => {
            if (
                !active || typeof ResizeObserver === "undefined"
            ) {
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
        }, [active, scrollRef, syncLayoutMetrics]);

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
            if (!active) {
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
            active,
            isResizingPanel,
            onVirtualResizeEnd,
            onVirtualResizeStart,
            scrollRef,
        ]);

        // Once the freeze lifts the DOM holds the real width again, so adopt it
        // and re-anchor exactly once — instead of on every drag frame.
        useLayoutEffect(() => {
            if (!active || frozenContentWidth !== null) {
                return;
            }

            syncLayoutMetrics();

            if (pendingVirtualResizeEndRef.current) {
                pendingVirtualResizeEndRef.current = false;
                virtualResizeActiveRef.current = false;
                onVirtualResizeEnd?.();
            }
        }, [
            active,
            frozenContentWidth,
            onVirtualResizeEnd,
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
                _row: TranscriptTimelineVirtualRow,
                index: number,
            ): ChatTimelineRowMeasurementContext => ({
                chatFontFamily,
                chatFontSize,
                estimateCalibration: estimateCalibrationRef.current,
                gapPx: resolveRowGapPx(index),
                toolActivityDefaultExpansion,
                width: contentMeasurementWidth,
            }),
            [
                chatFontFamily,
                contentMeasurementWidth,
                chatFontSize,
                resolveRowGapPx,
                toolActivityDefaultExpansion,
            ],
        );

        const handleVirtualItemMeasured = useCallback(
            (
                item: TranscriptTimelineItem,
                index: number,
                measurement: {
                    readonly height: number;
                    readonly previousHeight: number | undefined;
                },
            ) => {
                if (!isChatTimelineRowItem(item)) {
                    return;
                }
                const context = buildRowContext(item, index);
                if (isChatPerformanceProbeEnabled()) {
                    recordChatPerformanceMetric("virtual_measure", {
                        sessionId,
                        values: {
                            height: measurement.height,
                            index,
                            measurementKeyRevision: hashChatPerformanceLabel(
                                getChatTimelineRowMeasurementKey(item, context),
                            ),
                            previousHeight: measurement.previousHeight,
                            rowRevision: hashChatPerformanceLabel(
                                getChatTimelineRowIdentityKey(item, context),
                            ),
                        },
                    });
                }
                if (
                    item.kind === "message" &&
                    item.message.status === "streaming"
                ) {
                    // A moving stream is not representative training data for
                    // future stable rows; it will be measured again on completion.
                    return;
                }

                const baseHeight = estimateChatTimelineRowBaseHeight(
                    item,
                    context,
                );
                if (!Number.isFinite(baseHeight) || baseHeight <= 0) {
                    return;
                }

                const observedMultiplier = Math.min(
                    CHAT_TIMELINE_ESTIMATE_CALIBRATION_MAX_MULTIPLIER,
                    Math.max(
                        CHAT_TIMELINE_ESTIMATE_CALIBRATION_MIN_MULTIPLIER,
                        measurement.height / baseHeight,
                    ),
                );
                const bucket = getChatTimelineRowEstimateBucket(item, context);
                const previousMultiplier = estimateCalibrationRef.current.get(
                    bucket,
                );
                const nextMultiplier =
                    previousMultiplier === undefined
                        ? observedMultiplier
                        : previousMultiplier +
                          (observedMultiplier - previousMultiplier) *
                              CHAT_TIMELINE_ESTIMATE_CALIBRATION_ALPHA;

                // Keep the calibration bounded while retaining recently seen
                // width/type combinations for a long-lived chat view.
                estimateCalibrationRef.current.delete(bucket);
                estimateCalibrationRef.current.set(bucket, nextMultiplier);
                if (
                    estimateCalibrationRef.current.size >
                    MAX_ESTIMATE_CALIBRATION_BUCKETS
                ) {
                    const oldestBucket = estimateCalibrationRef.current.keys().next()
                        .value;
                    if (oldestBucket) {
                        estimateCalibrationRef.current.delete(oldestBucket);
                    }
                }
            },
            [buildRowContext, sessionId],
        );

        const estimateSize = useCallback(
            (row: TranscriptTimelineItem, index: number) =>
                isTranscriptBlockSpacerItem(row)
                    ? row.estimatedHeight
                    : isTranscriptStreamingIndicatorItem(row)
                      ? 28
                    : estimateChatTimelineRowHeight(
                          row,
                          buildRowContext(row, index),
                      ),
            [buildRowContext],
        );

        const getItemMeasurementKey = useCallback(
            (row: TranscriptTimelineItem, index: number) =>
                isTranscriptBlockSpacerItem(row)
                    ? `${row.id}:${row.estimatedHeight}`
                    : isTranscriptStreamingIndicatorItem(row)
                      ? row.id
                    : getChatTimelineRowMeasurementKey(
                          row,
                          buildRowContext(row, index),
                      ),
            [buildRowContext],
        );

        const getItemIdentityKey = useCallback(
            (row: TranscriptTimelineItem, index: number) =>
                isTranscriptBlockSpacerItem(row)
                    ? row.id
                    : isTranscriptStreamingIndicatorItem(row)
                      ? row.id
                    : getChatTimelineRowIdentityKey(
                          row,
                          buildRowContext(row, index),
                      ),
            [buildRowContext],
        );

        const renderVirtualItem = useCallback(
            ({
                index,
                item,
            }: {
                readonly index: number;
                readonly isVisible: boolean;
                readonly item: TranscriptTimelineItem;
            }) => {
                if (isTranscriptBlockSpacerItem(item)) {
                    return (
                        <div
                            aria-hidden="true"
                            data-transcript-block-spacer={item.blockId}
                            style={{ height: `${item.estimatedHeight}px` }}
                        />
                    );
                }
                const gapPx = resolveRowGapPx(index);

                if (isTranscriptStreamingIndicatorItem(item)) {
                    return (
                        <div
                            style={
                                gapPx > 0
                                    ? { paddingBottom: `${gapPx}px` }
                                    : undefined
                            }
                        >
                            {renderStreamingIndicator(item)}
                        </div>
                    );
                }

                return (
                    <div
                        data-current-turn-tail={
                            item.id === liveTailRowId ? "true" : undefined
                        }
                        style={
                            gapPx > 0
                                ? { paddingBottom: `${gapPx}px` }
                                : undefined
                        }
                    >
                        <ChatPresentationErrorBoundary
                            fallbackKind="row"
                            identity={getChatTimelineRowIdentityKey(
                                item,
                                buildRowContext(item, index),
                            )}
                        >
                            {renderRow({
                                isCurrentTurnTail:
                                    item.id === liveTailRowId ||
                                    (isTranscriptActivitySummaryItem(item) &&
                                        item.groupId === liveTailRowId),
                                row: item,
                            })}
                        </ChatPresentationErrorBoundary>
                    </div>
                );
            },
            [
                renderRow,
                renderStreamingIndicator,
                liveTailRowId,
                resolveRowGapPx,
                buildRowContext,
            ],
        );

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
                    getItemKey={getTranscriptTimelineItemKey}
                    getItemIdentityKey={getItemIdentityKey}
                    getItemMeasurementKey={getItemMeasurementKey}
                    geometryCacheSignature={
                        contentMeasurementWidth > 0
                            ? [
                                  chatFontFamily ?? "default",
                                  chatFontSize ?? "default",
                                  toolActivityDefaultExpansion,
                                  contentMeasurementWidth,
                              ].join(":")
                            : null
                    }
                    items={historyRows}
                    observeMeasurements={active}
                    measurementCacheKey={
                        sessionId ? `chat-timeline:${sessionId}` : undefined
                    }
                    onRangeChange={onVirtualRangeChange}
                    onItemMeasured={handleVirtualItemMeasured}
                    onReady={handleVirtualListReady}
                    overscan={CHAT_TIMELINE_VIRTUALIZATION_OVERSCAN}
                    preserveScrollAnchorOnItemsChange
                    preserveScrollAnchorOnMeasure
                    shouldPreserveScrollAnchorOnItemsChange={
                        shouldPreserveVirtualResizeAnchor
                    }
                    shouldPreserveScrollAnchorOnMeasure={
                        shouldPreserveVirtualMeasureAnchor
                    }
                    shouldPreserveScrollAnchorForItemMeasurement={
                        shouldPreserveVirtualMeasureAnchorForItem
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

function getTranscriptTimelineItemKey(
    row: TranscriptTimelineItem,
): string {
    return row.id;
}
