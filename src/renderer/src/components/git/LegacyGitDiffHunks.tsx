import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type RefObject,
} from "react";

import {
    MeasuredVirtualList,
} from "@renderer/components/virtual/MeasuredVirtualList";
import { DiffLineView } from "@renderer/components/workspace/review/DiffLineView";

import type { GitDiffFile, GitDiffHunk, GitDiffLine } from "./types";

const DIFF_LINE_LIST_OVERSCAN = 32;
const DIFF_HUNK_HEADER_HEIGHT_PX = 26;
const DIFF_HUNK_GAP_PX = 12;
const DEFAULT_DIFF_LINE_HEIGHT_PX = 20;

type DiffVisualBlock =
    | {
          readonly kind: "hunkHeader";
          readonly hasLeadingGap: boolean;
          readonly hunk: GitDiffHunk;
          readonly key: string;
      }
    | {
          readonly kind: "line";
          readonly filePath: string;
          readonly key: string;
          readonly line: GitDiffLine;
      };

function resolveDiffLineHeightPx(codeLineHeight: number | null): number {
    if (typeof codeLineHeight !== "number" || !Number.isFinite(codeLineHeight)) {
        return DEFAULT_DIFF_LINE_HEIGHT_PX;
    }

    return codeLineHeight > 4
        ? Math.max(1, codeLineHeight)
        : Math.max(1, Math.round(DEFAULT_DIFF_LINE_HEIGHT_PX * codeLineHeight));
}

function buildDiffVisualBlocks(file: GitDiffFile): readonly DiffVisualBlock[] {
    const blocks: DiffVisualBlock[] = [];

    file.hunks.forEach((hunk, hunkIndex) => {
        blocks.push({
            hasLeadingGap: hunkIndex > 0,
            hunk,
            key: `${hunk.id}:header`,
            kind: "hunkHeader",
        });

        hunk.lines.forEach((line) => {
            blocks.push({
                filePath: file.path,
                key: `${hunk.id}:line:${line.id}`,
                kind: "line",
                line,
            });
        });
    });

    return blocks;
}

function estimateDiffVisualBlockHeight(
    block: DiffVisualBlock,
    codeLineHeight: number | null,
): number {
    if (block.kind === "hunkHeader") {
        return (
            DIFF_HUNK_HEADER_HEIGHT_PX +
            (block.hasLeadingGap ? DIFF_HUNK_GAP_PX : 0)
        );
    }

    return resolveDiffLineHeightPx(codeLineHeight);
}

function getDiffVisualBlockKey(block: DiffVisualBlock): string {
    return block.key;
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

export const LegacyGitDiffHunks = memo(function LegacyGitDiffHunks({
    codeFontFamily = null,
    codeFontSize = null,
    codeLineHeight = null,
    file,
    lineWrapping = true,
    scrollContainerRef,
    virtualizeLines = false,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly file: GitDiffFile;
    readonly lineWrapping?: boolean;
    readonly scrollContainerRef?: RefObject<HTMLElement | null>;
    readonly virtualizeLines?: boolean;
}) {
    if (virtualizeLines && scrollContainerRef) {
        return (
            <VirtualizedDiffHunks
                codeFontFamily={codeFontFamily}
                codeFontSize={codeFontSize}
                codeLineHeight={codeLineHeight}
                file={file}
                lineWrapping={lineWrapping}
                scrollContainerRef={scrollContainerRef}
            />
        );
    }

    return (
        <div className="space-y-3 p-3">
            {file.hunks.map((hunk) => (
                <section
                    className="overflow-hidden rounded-lg border border-border bg-bg-primary"
                    key={hunk.id}
                >
                    <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] text-text-secondary/50">
                        {formatHunkHeader(hunk)}
                    </div>
                    <div className="select-text overflow-x-auto">
                        <div
                            className={
                                lineWrapping
                                    ? "min-w-160"
                                    : "min-w-full w-max"
                            }
                        >
                            {hunk.lines.map((line) => (
                                <DiffLineRow
                                    codeFontFamily={codeFontFamily}
                                    codeFontSize={codeFontSize}
                                    codeLineHeight={codeLineHeight}
                                    filePath={file.path}
                                    key={line.id}
                                    line={line}
                                    lineWrapping={lineWrapping}
                                />
                            ))}
                        </div>
                    </div>
                </section>
            ))}
        </div>
    );
});

function VirtualizedDiffHunks({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    file,
    lineWrapping,
    scrollContainerRef,
}: {
    readonly codeFontFamily: string | null;
    readonly codeFontSize: number | null;
    readonly codeLineHeight: number | null;
    readonly file: GitDiffFile;
    readonly lineWrapping: boolean;
    readonly scrollContainerRef: RefObject<HTMLElement | null>;
}) {
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMarginTop, setScrollMarginTop] = useState(0);
    const blocks = useMemo(() => buildDiffVisualBlocks(file), [file]);
    const maxLineWidthCh = useMemo(() => {
        const maxTextLength = file.hunks.reduce((maxLength, hunk) => {
            const hunkMaxLength = hunk.lines.reduce(
                (lineMaxLength, line) =>
                    Math.max(lineMaxLength, line.text.length),
                0,
            );
            return Math.max(maxLength, hunkMaxLength);
        }, 0);

        return Math.max(80, maxTextLength + 18);
    }, [file]);
    const contentStyle = lineWrapping
        ? undefined
        : { minWidth: `max(100%, ${maxLineWidthCh}ch)` };

    useEffect(() => {
        if (typeof window === "undefined") {
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
    }, [scrollContainerRef]);

    const estimateBlockSize = useCallback(
        (block: DiffVisualBlock) =>
            estimateDiffVisualBlockHeight(block, codeLineHeight),
        [codeLineHeight],
    );

    const renderBlock = useCallback(
        ({ item }: { readonly item: DiffVisualBlock }) => {
            if (item.kind === "hunkHeader") {
                return <VirtualizedDiffHunkHeader block={item} />;
            }

            return (
                <DiffLineRow
                    codeFontFamily={codeFontFamily}
                    codeFontSize={codeFontSize}
                    codeLineHeight={codeLineHeight}
                    filePath={item.filePath}
                    line={item.line}
                    lineWrapping={lineWrapping}
                />
            );
        },
        [codeFontFamily, codeFontSize, codeLineHeight, lineWrapping],
    );

    return (
        <div className="p-3">
            <div
                className="select-text overflow-x-auto"
                data-virtualized-diff-lines="true"
            >
                <div
                    className={lineWrapping ? "min-w-160" : "min-w-full w-max"}
                    style={contentStyle}
                >
                    <div
                        className="min-w-full overflow-hidden rounded-lg border border-border bg-bg-primary"
                        ref={listRef}
                    >
                        <MeasuredVirtualList
                            enabled
                            estimateSize={estimateBlockSize}
                            getItemKey={getDiffVisualBlockKey}
                            items={blocks}
                            overscan={DIFF_LINE_LIST_OVERSCAN}
                            renderItem={renderBlock}
                            scrollContainerRef={scrollContainerRef}
                            scrollMarginTop={scrollMarginTop}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

function VirtualizedDiffHunkHeader({
    block,
}: {
    readonly block: Extract<DiffVisualBlock, { readonly kind: "hunkHeader" }>;
}) {
    return (
        <div
            className={block.hasLeadingGap ? "pt-3" : undefined}
            data-diff-hunk-header="true"
        >
            <div
                className={[
                    "border-b border-border px-3 py-1.5 font-mono text-[10px] text-text-secondary/50",
                    block.hasLeadingGap ? "border-t" : "",
                ].join(" ")}
            >
                {formatHunkHeader(block.hunk)}
            </div>
        </div>
    );
}

function formatHunkHeader(hunk: GitDiffHunk): string {
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    const newEnd = hunk.newStart + hunk.newCount - 1;
    const oldRange =
        hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart}–${oldEnd}`;
    const newRange =
        hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart}–${newEnd}`;
    return `${oldRange} → ${newRange}`;
}

const DiffLineRow = memo(function DiffLineRow({
    codeFontFamily,
    codeFontSize,
    codeLineHeight,
    filePath,
    line,
    lineWrapping = true,
}: {
    readonly codeFontFamily?: string | null;
    readonly codeFontSize?: number | null;
    readonly codeLineHeight?: number | null;
    readonly filePath: string;
    readonly line: GitDiffLine;
    readonly lineWrapping?: boolean;
}) {
    const viewLine = useMemo(
        () => ({
            exact: true as const,
            newLineNumber: line.newLineNumber,
            oldLineNumber: line.oldLineNumber,
            prefix:
                line.kind === "add"
                    ? "+ "
                    : line.kind === "remove"
                      ? "- "
                      : "  ",
            text: line.text,
            type:
                line.kind === "add"
                    ? ("add" as const)
                    : line.kind === "remove"
                      ? ("remove" as const)
                      : ("context" as const),
        }),
        [line],
    );
    return (
        <DiffLineView
            compactLineNumbers
            filePath={filePath}
            fontFamily={codeFontFamily}
            fontSize={codeFontSize}
            lineHeight={codeLineHeight}
            line={viewLine}
            lineWrapping={lineWrapping}
        />
    );
});
