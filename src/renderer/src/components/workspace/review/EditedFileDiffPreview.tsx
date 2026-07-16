import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type RefObject,
} from "react";

import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";
import { MeasuredVirtualList } from "@renderer/components/virtual/MeasuredVirtualList";

import { DiffLineView } from "./DiffLineView";
import { HunkActionBar } from "./HunkActionBar";
import {
    computeDecisionHunks,
    computeDiffLines,
    computeVisualDiffBlocks,
    shouldWrapDiffPreview,
    type DiffLine,
} from "./reviewDiff";
import {
    prepareDiffPreview,
    type PreparedDiffPreview,
} from "./reviewDiffWorkerClient";

export const EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD = 1_000;

const VIRTUAL_DIFF_LINE_OVERSCAN = 32;
const EMPTY_DIFF_LINES: readonly DiffLine[] = [];
const EMPTY_VISUAL_BLOCKS: ReturnType<typeof computeVisualDiffBlocks> = [];
const EMPTY_DECISION_HUNKS: ReturnType<typeof computeDecisionHunks> = [];

type RenderBlock =
    | {
          readonly key: string;
          readonly kind: "plain";
          readonly lines: readonly DiffLine[];
      }
    | {
          readonly key: string;
          readonly kind: "separator";
          readonly line: DiffLine;
      }
    | {
          readonly decisionHunkIndexes: readonly number[];
          readonly key: string;
          readonly kind: "visual";
          readonly lines: readonly DiffLine[];
          readonly visualBlockIndex: number;
      };

type VisualSegment =
    | {
          readonly key: string;
          readonly kind: "plain";
          readonly lines: readonly DiffLine[];
      }
    | {
          readonly decisionHunkIndex: number;
          readonly key: string;
          readonly kind: "decision";
          readonly lines: readonly DiffLine[];
      };

type VirtualPreviewItem =
    | {
          readonly key: string;
          readonly kind: "line";
          readonly line: DiffLine;
      }
    | {
          readonly key: string;
          readonly kind: "separator";
          readonly line: DiffLine;
      }
    | {
          readonly key: string;
          readonly kind: "visualLabel";
      }
    | {
          readonly dataReviewFileKey?: string;
          readonly dataReviewFileUpdatedAt?: string;
          readonly dataReviewHunkKey?: string;
          readonly decisionHunkIndex?: number;
          readonly isFirstInDecision: boolean;
          readonly isFirstInVisualBlock: boolean;
          readonly isLastInVisualBlock: boolean;
          readonly key: string;
          readonly kind: "visualLine";
          readonly line: DiffLine;
      };

interface RenderPreviewContext {
    readonly compactLineNumbers: boolean;
    readonly decisionHunks: readonly {
        readonly lines: readonly DiffLine[];
        readonly newEnd: number;
        readonly newStart: number;
        readonly oldEnd: number;
        readonly oldStart: number;
    }[];
    readonly diff: AiFileDiff;
    readonly file: AiTrackedFile | null;
    readonly interactiveHunksEnabled: boolean;
    readonly lineWrapping: boolean;
    readonly onKeepHunk?: (hunkId: string) => void;
    readonly onRejectHunk?: (hunkId: string) => void;
    readonly visualBlockSet: ReadonlySet<number>;
}

function getDecisionHunkFingerprint(hunk: {
    readonly lines: readonly DiffLine[];
    readonly newEnd: number;
    readonly newStart: number;
    readonly oldEnd: number;
    readonly oldStart: number;
}): string {
    return [
        hunk.oldStart,
        hunk.oldEnd,
        hunk.newStart,
        hunk.newEnd,
        hunk.lines.map((line) => `${line.type}:${line.text}`).join("\u001f"),
    ].join("|");
}

function getTrackedHunkFingerprint(hunk: {
    readonly lines: readonly {
        readonly text: string;
        readonly type: DiffLine["type"];
    }[];
    readonly newCount: number;
    readonly newStart: number;
    readonly oldCount: number;
    readonly oldStart: number;
}): string {
    return [
        hunk.oldStart,
        hunk.oldStart + hunk.oldCount,
        hunk.newStart,
        hunk.newStart + hunk.newCount,
        hunk.lines.map((line) => `${line.type}:${line.text}`).join("\u001f"),
    ].join("|");
}

function resolveTrackedHunkId(
    file: AiTrackedFile | null,
    diff: AiFileDiff,
    decisionHunks: readonly {
        readonly lines: readonly DiffLine[];
        readonly newEnd: number;
        readonly newStart: number;
        readonly oldEnd: number;
        readonly oldStart: number;
    }[],
    decisionHunkIndex: number,
): string | null {
    if (!file) {
        return null;
    }

    const diffHunk = diff.hunks[decisionHunkIndex] ?? null;
    if (diffHunk) {
        const trackedById = file.hunks.find((hunk) => hunk.id === diffHunk.id);
        if (trackedById) {
            return trackedById.id;
        }
    }

    const decisionHunk = decisionHunks[decisionHunkIndex];
    if (!decisionHunk) {
        return null;
    }

    const decisionFingerprint = getDecisionHunkFingerprint(decisionHunk);
    const trackedByFingerprint = file.hunks.find(
        (hunk) => getTrackedHunkFingerprint(hunk) === decisionFingerprint,
    );

    return trackedByFingerprint?.id ?? null;
}

function buildRenderBlocks(lines: readonly DiffLine[]): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    let pendingPlain: DiffLine[] = [];
    let pendingVisual: { lines: DiffLine[]; visualBlockIndex: number } | null =
        null;

    const flushPlain = () => {
        if (pendingPlain.length === 0) {
            return;
        }
        blocks.push({
            key: `plain:${blocks.length}`,
            kind: "plain",
            lines: pendingPlain,
        });
        pendingPlain = [];
    };

    const flushVisual = () => {
        if (!pendingVisual) {
            return;
        }

        const decisionHunkIndexes = [
            ...new Set(
                pendingVisual.lines
                    .map((line) => line.decisionHunkIndex)
                    .filter(
                        (index): index is number => typeof index === "number",
                    ),
            ),
        ];

        blocks.push({
            decisionHunkIndexes,
            key: `visual:${pendingVisual.visualBlockIndex}`,
            kind: "visual",
            lines: pendingVisual.lines,
            visualBlockIndex: pendingVisual.visualBlockIndex,
        });
        pendingVisual = null;
    };

    for (const line of lines) {
        if (line.type === "separator") {
            flushPlain();
            flushVisual();
            blocks.push({
                key: `separator:${blocks.length}`,
                kind: "separator",
                line,
            });
            continue;
        }

        if (typeof line.visualBlockIndex === "number") {
            flushPlain();
            if (
                pendingVisual &&
                pendingVisual.visualBlockIndex !== line.visualBlockIndex
            ) {
                flushVisual();
            }
            if (!pendingVisual) {
                pendingVisual = {
                    lines: [],
                    visualBlockIndex: line.visualBlockIndex,
                };
            }
            pendingVisual.lines.push(line);
            continue;
        }

        flushVisual();
        pendingPlain.push(line);
    }

    flushPlain();
    flushVisual();

    return blocks;
}

function buildVisualSegments(lines: readonly DiffLine[]): VisualSegment[] {
    const segments: VisualSegment[] = [];
    let pendingPlain: DiffLine[] = [];
    let pendingDecisionIndex: number | null = null;
    let pendingDecision: DiffLine[] = [];

    const flushPlain = () => {
        if (pendingPlain.length === 0) {
            return;
        }
        segments.push({
            key: `plain:${segments.length}`,
            kind: "plain",
            lines: pendingPlain,
        });
        pendingPlain = [];
    };

    const flushDecision = () => {
        if (pendingDecisionIndex == null || pendingDecision.length === 0) {
            pendingDecisionIndex = null;
            pendingDecision = [];
            return;
        }

        segments.push({
            decisionHunkIndex: pendingDecisionIndex,
            key: `decision:${pendingDecisionIndex}:${segments.length}`,
            kind: "decision",
            lines: pendingDecision,
        });
        pendingDecisionIndex = null;
        pendingDecision = [];
    };

    for (const line of lines) {
        if (typeof line.decisionHunkIndex === "number") {
            flushPlain();
            if (
                pendingDecisionIndex !== null &&
                pendingDecisionIndex !== line.decisionHunkIndex
            ) {
                flushDecision();
            }
            pendingDecisionIndex = line.decisionHunkIndex;
            pendingDecision.push(line);
            continue;
        }

        flushDecision();
        pendingPlain.push(line);
    }

    flushPlain();
    flushDecision();

    return segments;
}

function renderDiffLines(
    lines: readonly DiffLine[],
    options: {
        readonly compactLineNumbers: boolean;
        readonly filePath: string | null;
        readonly lineWrapping: boolean;
    },
) {
    return lines.map((line, index) => (
        <DiffLineView
            compactLineNumbers={options.compactLineNumbers}
            filePath={options.filePath}
            key={`${line.type}:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${index}`}
            line={line}
            lineWrapping={options.lineWrapping}
        />
    ));
}

function countPreviewLines(lines: readonly DiffLine[]): number {
    return lines.filter((line) => line.type !== "separator").length;
}

function shouldVirtualizePreviewLines({
    hasScrollContainer,
    lineWrapping,
    lines,
}: {
    readonly hasScrollContainer: boolean;
    readonly lineWrapping: boolean;
    readonly lines: readonly DiffLine[];
}): boolean {
    return (
        hasScrollContainer &&
        !lineWrapping &&
        countPreviewLines(lines) >=
            EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD
    );
}

function calculateScrollMarginTop(
    element: HTMLElement | null,
    scrollContainer: HTMLElement | null,
): number {
    if (!element || !scrollContainer || element === scrollContainer) {
        return 0;
    }

    const elementRect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    return Math.max(
        0,
        elementRect.top - containerRect.top + scrollContainer.scrollTop,
    );
}

function getDiffLineKey(line: DiffLine, index: number): string {
    return `${line.type}:${line.oldLineNumber ?? "n"}:${line.newLineNumber ?? "n"}:${index}`;
}

function getPreviewMaxLineWidthCh(lines: readonly DiffLine[]): number {
    const maxTextLength = lines.reduce(
        (maxLength, line) => Math.max(maxLength, line.text.length),
        0,
    );
    return Math.max(80, maxTextLength + 18);
}

function estimateVirtualPreviewItemHeight(
    item: VirtualPreviewItem,
    diffZoom: number,
): number {
    const lineHeight = Math.max(16, Math.ceil(18 * diffZoom));

    if (item.kind === "visualLabel") {
        return 22;
    }

    if (item.kind === "visualLine") {
        return (
            lineHeight +
            (item.isFirstInVisualBlock ? 8 : 0) +
            (item.isFirstInDecision ? 12 : 0) +
            (item.isLastInVisualBlock ? 8 : 0)
        );
    }

    return lineHeight;
}

function getVirtualPreviewItemKey(item: VirtualPreviewItem): string {
    return item.key;
}

function createVirtualLineItem(
    line: DiffLine,
    keyPrefix: string,
    index: number,
): VirtualPreviewItem {
    return {
        key: `${keyPrefix}:line:${getDiffLineKey(line, index)}`,
        kind: "line",
        line,
    };
}

function buildVirtualPreviewItems(
    renderBlocks: readonly RenderBlock[],
    context: RenderPreviewContext,
): readonly VirtualPreviewItem[] {
    const items: VirtualPreviewItem[] = [];

    renderBlocks.forEach((block) => {
        if (block.kind === "separator") {
            items.push({
                key: block.key,
                kind: "separator",
                line: block.line,
            });
            return;
        }

        if (
            block.kind !== "visual" ||
            !context.visualBlockSet.has(block.visualBlockIndex)
        ) {
            block.lines.forEach((line, index) => {
                items.push(createVirtualLineItem(line, block.key, index));
            });
            return;
        }

        if (block.decisionHunkIndexes.length > 1) {
            items.push({
                key: `${block.key}:label`,
                kind: "visualLabel",
            });
        }

        const segments = buildVisualSegments(block.lines);
        const visualItems: Array<
            Extract<VirtualPreviewItem, { readonly kind: "visualLine" }>
        > = [];

        segments.forEach((segment) => {
            const hunkId =
                segment.kind === "decision" &&
                context.interactiveHunksEnabled &&
                context.file
                    ? resolveTrackedHunkId(
                          context.file,
                          context.diff,
                          context.decisionHunks,
                          segment.decisionHunkIndex,
                      )
                    : null;

            segment.lines.forEach((line, lineIndex) => {
                visualItems.push({
                    dataReviewFileKey:
                        segment.kind === "decision" && context.file
                            ? context.file.identityKey
                            : undefined,
                    dataReviewFileUpdatedAt:
                        segment.kind === "decision" && context.file
                            ? context.file.updatedAt
                            : undefined,
                    dataReviewHunkKey: hunkId ?? undefined,
                    decisionHunkIndex:
                        segment.kind === "decision"
                            ? segment.decisionHunkIndex
                            : undefined,
                    isFirstInDecision:
                        segment.kind === "decision" && lineIndex === 0,
                    isFirstInVisualBlock: false,
                    isLastInVisualBlock: false,
                    key: `${block.key}:${segment.key}:line:${getDiffLineKey(line, lineIndex)}`,
                    kind: "visualLine",
                    line,
                });
            });
        });

        visualItems.forEach((item, index) => {
            items.push({
                ...item,
                isFirstInVisualBlock: index === 0,
                isLastInVisualBlock: index === visualItems.length - 1,
            });
        });
    });

    return items;
}

function renderVisualBlock(
    block: Extract<RenderBlock, { readonly kind: "visual" }>,
    context: RenderPreviewContext,
) {
    const segments = buildVisualSegments(block.lines);

    return (
        <div
            key={block.key}
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-bg-primary) 40%, var(--color-bg-elevated))",
                border: "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)",
                borderRadius: 8,
                margin: "4px 6px",
            }}
        >
            {block.decisionHunkIndexes.length > 1 ? (
                <div
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.68em",
                        fontWeight: 500,
                        letterSpacing: "0.02em",
                        opacity: 0.55,
                        padding: "5px 10px 0",
                    }}
                >
                    Linked changes
                </div>
            ) : null}
            <div style={{ padding: 4 }}>
                {segments.map((segment) => {
                    if (
                        segment.kind === "plain" ||
                        !context.interactiveHunksEnabled ||
                        !context.file
                    ) {
                        return (
                            <div key={segment.key}>
                                {renderDiffLines(segment.lines, {
                                    compactLineNumbers:
                                        context.compactLineNumbers,
                                    filePath:
                                        context.file?.path ?? context.diff.path,
                                    lineWrapping: context.lineWrapping,
                                })}
                            </div>
                        );
                    }

                    const hunkId = resolveTrackedHunkId(
                        context.file,
                        context.diff,
                        context.decisionHunks,
                        segment.decisionHunkIndex,
                    );

                    return (
                        <div
                            className="group"
                            data-review-file-key={context.file.identityKey}
                            data-review-file-updated-at={
                                context.file.updatedAt
                            }
                            data-review-hunk-key={hunkId ?? undefined}
                            key={segment.key}
                            style={{
                                margin: "16px 0 4px",
                                position: "relative",
                            }}
                        >
                            {hunkId ? (
                                <HunkActionBar
                                    hunkIndex={segment.decisionHunkIndex}
                                    onAccept={() =>
                                        context.onKeepHunk?.(hunkId)
                                    }
                                    onReject={() =>
                                        context.onRejectHunk?.(hunkId)
                                    }
                                />
                            ) : null}
                            <div
                                style={{
                                    backgroundColor:
                                        "color-mix(in srgb, var(--color-bg-elevated) 72%, transparent)",
                                    border: "1px solid color-mix(in srgb, var(--color-border) 32%, transparent)",
                                    borderRadius: 4,
                                    overflow: "hidden",
                                    paddingRight: 4,
                                    paddingTop: 4,
                                }}
                            >
                                {renderDiffLines(segment.lines, {
                                    compactLineNumbers:
                                        context.compactLineNumbers,
                                    filePath: context.file.path,
                                    lineWrapping: context.lineWrapping,
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function renderPreviewBlock(block: RenderBlock, context: RenderPreviewContext) {
    if (block.kind === "separator") {
        return (
            <DiffLineView
                compactLineNumbers={context.compactLineNumbers}
                filePath={context.file?.path ?? context.diff.path}
                key={block.key}
                line={block.line}
                lineWrapping={context.lineWrapping}
            />
        );
    }

    if (
        block.kind !== "visual" ||
        !context.visualBlockSet.has(block.visualBlockIndex)
    ) {
        return (
            <div key={block.key}>
                {renderDiffLines(block.lines, {
                    compactLineNumbers: context.compactLineNumbers,
                    filePath: context.file?.path ?? context.diff.path,
                    lineWrapping: context.lineWrapping,
                })}
            </div>
        );
    }

    return renderVisualBlock(block, context);
}

export interface EditedFileDiffPreviewProps {
    readonly compactLineNumbers?: boolean;
    readonly diff: AiFileDiff;
    readonly diffZoom: number;
    readonly emptyLabel?: string;
    readonly expanded: boolean;
    readonly file?: AiTrackedFile | null;
    readonly lineWrapping?: boolean;
    readonly onKeepHunk?: (hunkId: string) => void;
    readonly onRejectHunk?: (hunkId: string) => void;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly showWhenEmpty?: boolean;
    readonly testId?: string;
}

export function EditedFileDiffPreview({
    compactLineNumbers = true,
    diff,
    diffZoom,
    emptyLabel = "Path-only change",
    expanded,
    file = null,
    lineWrapping,
    onKeepHunk,
    onRejectHunk,
    scrollContainerRef,
    showWhenEmpty = true,
    testId,
}: EditedFileDiffPreviewProps) {
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMarginTop, setScrollMarginTop] = useState(0);
    const resolvedLineWrapping =
        lineWrapping ?? shouldWrapDiffPreview(file?.path ?? diff.path);
    const diffLineCount = useMemo(
        () => diff.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
        [diff.hunks],
    );
    const shouldPrepareInWorker =
        expanded &&
        typeof Worker !== "undefined" &&
        diffLineCount >= EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD;
    const synchronouslyPreparedDiff = useMemo<PreparedDiffPreview | null>(
        () =>
            expanded && !shouldPrepareInWorker
                ? {
                      decisionHunks: computeDecisionHunks(diff),
                      lines: computeDiffLines(diff),
                      visualBlocks: computeVisualDiffBlocks(diff),
                  }
                : null,
        [diff, expanded, shouldPrepareInWorker],
    );
    const [workerPreparedDiff, setWorkerPreparedDiff] = useState<{
        readonly diff: AiFileDiff;
        readonly prepared: PreparedDiffPreview;
    } | null>(null);

    useEffect(() => {
        if (!shouldPrepareInWorker) {
            return;
        }

        const controller = new AbortController();
        void prepareDiffPreview(diff, controller.signal)
            .then((prepared) => {
                if (!controller.signal.aborted) {
                    setWorkerPreparedDiff({ diff, prepared });
                }
            })
            .catch(() => {
                // Cancellation is expected whenever a diff leaves the viewport.
            });
        return () => controller.abort();
    }, [diff, shouldPrepareInWorker]);

    const preparedDiff =
        synchronouslyPreparedDiff ??
        (workerPreparedDiff?.diff === diff
            ? workerPreparedDiff.prepared
            : null);
    const lines = preparedDiff?.lines ?? EMPTY_DIFF_LINES;
    const visualBlocks = preparedDiff?.visualBlocks ?? EMPTY_VISUAL_BLOCKS;
    const decisionHunks = preparedDiff?.decisionHunks ?? EMPTY_DECISION_HUNKS;
    const renderBlocks = useMemo(() => buildRenderBlocks(lines), [lines]);
    const visualBlockSet = useMemo(
        () => new Set(visualBlocks.map((block) => block.index)),
        [visualBlocks],
    );
    const interactiveHunksEnabled = Boolean(
        file &&
        onKeepHunk &&
        onRejectHunk &&
        file.isText &&
        file.reversible !== false &&
        file.hunks.length > 0 &&
        decisionHunks.length > 0,
    );
    const previewContext = useMemo<RenderPreviewContext>(
        () => ({
            compactLineNumbers,
            decisionHunks,
            diff,
            file,
            interactiveHunksEnabled,
            lineWrapping: resolvedLineWrapping,
            onKeepHunk,
            onRejectHunk,
            visualBlockSet,
        }),
        [
            compactLineNumbers,
            decisionHunks,
            diff,
            file,
            interactiveHunksEnabled,
            onKeepHunk,
            onRejectHunk,
            resolvedLineWrapping,
            visualBlockSet,
        ],
    );
    const shouldVirtualizeLines = shouldVirtualizePreviewLines({
        hasScrollContainer: scrollContainerRef !== undefined,
        lineWrapping: resolvedLineWrapping,
        lines,
    });
    const virtualItems = useMemo(
        () =>
            shouldVirtualizeLines
                ? buildVirtualPreviewItems(renderBlocks, previewContext)
                : [],
        [previewContext, renderBlocks, shouldVirtualizeLines],
    );
    const maxLineWidthCh = useMemo(
        () => getPreviewMaxLineWidthCh(lines),
        [lines],
    );
    const contentStyle = useMemo<CSSProperties>(
        () => ({
            minWidth: resolvedLineWrapping
                ? "100%"
                : shouldVirtualizeLines
                  ? `max(100%, ${maxLineWidthCh}ch)`
                  : "100%",
            width: resolvedLineWrapping ? "100%" : "max-content",
        }),
        [maxLineWidthCh, resolvedLineWrapping, shouldVirtualizeLines],
    );

    useEffect(() => {
        if (
            !shouldVirtualizeLines ||
            !scrollContainerRef ||
            typeof window === "undefined"
        ) {
            return;
        }

        const syncScrollMarginTop = () => {
            setScrollMarginTop(
                calculateScrollMarginTop(
                    listRef.current,
                    scrollContainerRef.current,
                ),
            );
        };

        syncScrollMarginTop();

        const scrollContainer = scrollContainerRef.current;
        let observer: ResizeObserver | null = null;

        if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(syncScrollMarginTop);
            if (listRef.current) {
                observer.observe(listRef.current);
            }
            if (scrollContainer) {
                observer.observe(scrollContainer);
            }
        }

        window.addEventListener("resize", syncScrollMarginTop);

        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", syncScrollMarginTop);
        };
    }, [scrollContainerRef, shouldVirtualizeLines]);

    const estimateVirtualItemSize = useCallback(
        (item: VirtualPreviewItem) =>
            estimateVirtualPreviewItemHeight(item, diffZoom),
        [diffZoom],
    );

    const renderVirtualItem = useCallback(
        ({ item }: { readonly item: VirtualPreviewItem }) => (
            <VirtualPreviewItemView
                compactLineNumbers={compactLineNumbers}
                diff={diff}
                file={file}
                item={item}
                lineWrapping={resolvedLineWrapping}
                onKeepHunk={onKeepHunk}
                onRejectHunk={onRejectHunk}
            />
        ),
        [
            compactLineNumbers,
            diff,
            file,
            onKeepHunk,
            onRejectHunk,
            resolvedLineWrapping,
        ],
    );

    if (!expanded) {
        return null;
    }

    if (lines.length === 0 && !showWhenEmpty) {
        return null;
    }

    return (
        <div
            style={{
                borderTop:
                    "1px solid color-mix(in srgb, var(--color-border) 35%, transparent)",
            }}
        >
            <div
                data-line-wrapping={String(resolvedLineWrapping)}
                data-testid={testId}
                data-virtualized-edited-diff={String(shouldVirtualizeLines)}
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--color-bg-primary) 60%, var(--color-bg-elevated))",
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    fontSize: `${diffZoom}em`,
                    lineHeight: 1.55,
                    overflowX: resolvedLineWrapping ? "hidden" : "auto",
                    overflowY: "hidden",
                }}
            >
                <div style={contentStyle}>
                    {lines.length > 0 ? (
                        <div ref={listRef} style={{ padding: "4px 0" }}>
                            {shouldVirtualizeLines && scrollContainerRef ? (
                                <MeasuredVirtualList
                                    enabled
                                    estimateSize={estimateVirtualItemSize}
                                    getItemKey={getVirtualPreviewItemKey}
                                    items={virtualItems}
                                    overscan={VIRTUAL_DIFF_LINE_OVERSCAN}
                                    renderItem={renderVirtualItem}
                                    scrollContainerRef={scrollContainerRef}
                                    scrollMarginTop={scrollMarginTop}
                                />
                            ) : (
                                renderBlocks.map((block) =>
                                    renderPreviewBlock(block, previewContext),
                                )
                            )}
                        </div>
                    ) : (
                        <div
                            style={{
                                color: "var(--color-text-secondary)",
                                opacity: 0.7,
                                padding: "12px 16px",
                                textAlign: "center",
                            }}
                        >
                            {emptyLabel}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function getVirtualVisualLineStyle(
    item: Extract<VirtualPreviewItem, { readonly kind: "visualLine" }>,
): CSSProperties {
    const style: CSSProperties = {
        backgroundColor:
            "color-mix(in srgb, var(--color-bg-primary) 40%, var(--color-bg-elevated))",
        borderLeft:
            "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)",
        borderRight:
            "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)",
        marginLeft: 6,
        marginRight: 6,
        paddingLeft: 4,
        paddingRight: 4,
        position: item.isFirstInDecision ? "relative" : undefined,
    };

    if (item.isFirstInVisualBlock) {
        style.borderTop =
            "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)";
        style.borderTopLeftRadius = 8;
        style.borderTopRightRadius = 8;
        style.marginTop = 4;
        style.paddingTop = item.isFirstInDecision ? 16 : 4;
    } else if (item.isFirstInDecision) {
        style.paddingTop = 16;
    }

    if (item.isLastInVisualBlock) {
        style.borderBottom =
            "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)";
        style.borderBottomLeftRadius = 8;
        style.borderBottomRightRadius = 8;
        style.marginBottom = 4;
        style.paddingBottom = 4;
    }

    return style;
}

function VirtualPreviewItemView({
    compactLineNumbers,
    diff,
    file,
    item,
    lineWrapping,
    onKeepHunk,
    onRejectHunk,
}: {
    readonly compactLineNumbers: boolean;
    readonly diff: AiFileDiff;
    readonly file: AiTrackedFile | null;
    readonly item: VirtualPreviewItem;
    readonly lineWrapping: boolean;
    readonly onKeepHunk?: (hunkId: string) => void;
    readonly onRejectHunk?: (hunkId: string) => void;
}) {
    if (item.kind === "visualLabel") {
        return (
            <div
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "0.68em",
                    fontWeight: 500,
                    letterSpacing: "0.02em",
                    margin: "4px 6px 0",
                    opacity: 0.55,
                    padding: "5px 10px 0",
                }}
            >
                Linked changes
            </div>
        );
    }

    if (item.kind === "separator") {
        return (
            <DiffLineView
                compactLineNumbers={compactLineNumbers}
                filePath={file?.path ?? diff.path}
                line={item.line}
                lineWrapping={lineWrapping}
            />
        );
    }

    if (item.kind === "line") {
        return (
            <DiffLineView
                compactLineNumbers={compactLineNumbers}
                filePath={file?.path ?? diff.path}
                line={item.line}
                lineWrapping={lineWrapping}
            />
        );
    }

    const hunkId = item.dataReviewHunkKey;

    return (
        <div
            className={hunkId && item.isFirstInDecision ? "group" : undefined}
            data-review-file-key={item.dataReviewFileKey}
            data-review-file-updated-at={item.dataReviewFileUpdatedAt}
            data-review-hunk-key={hunkId}
            style={getVirtualVisualLineStyle(item)}
        >
            {hunkId && item.isFirstInDecision ? (
                <HunkActionBar
                    hunkIndex={item.decisionHunkIndex ?? 0}
                    onAccept={() => onKeepHunk?.(hunkId)}
                    onReject={() => onRejectHunk?.(hunkId)}
                />
            ) : null}
            <DiffLineView
                compactLineNumbers={compactLineNumbers}
                filePath={file?.path ?? diff.path}
                line={item.line}
                lineWrapping={lineWrapping}
            />
        </div>
    );
}
