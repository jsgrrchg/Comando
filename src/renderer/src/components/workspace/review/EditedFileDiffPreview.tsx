import { useMemo } from "react";

import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";

import { DiffLineView } from "./DiffLineView";
import { HunkActionBar } from "./HunkActionBar";
import {
    computeDecisionHunks,
    computeDiffLines,
    computeVisualDiffBlocks,
    type DiffLine,
} from "./reviewDiff";

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
    lineWrapping = true,
    onKeepHunk,
    onRejectHunk,
    showWhenEmpty = true,
    testId,
}: EditedFileDiffPreviewProps) {
    const lines = useMemo(
        () => (expanded ? computeDiffLines(diff) : []),
        [diff, expanded],
    );
    const visualBlocks = useMemo(
        () => (expanded ? computeVisualDiffBlocks(diff) : []),
        [diff, expanded],
    );
    const decisionHunks = useMemo(
        () => (expanded ? computeDecisionHunks(diff) : []),
        [diff, expanded],
    );
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

    if (!expanded) {
        return null;
    }

    if (lines.length === 0 && !showWhenEmpty) {
        return null;
    }

    return (
        <div
            style={{
                borderTop: "1px solid color-mix(in srgb, var(--color-border) 35%, transparent)",
            }}
        >
            <div
                data-line-wrapping={String(lineWrapping)}
                data-testid={testId}
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--color-bg-primary) 60%, var(--color-bg-elevated))",
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    fontSize: `${diffZoom}em`,
                    lineHeight: 1.55,
                    overflowX: lineWrapping ? "hidden" : "auto",
                    overflowY: "hidden",
                }}
            >
                <div
                    style={{
                        minWidth: "100%",
                        width: lineWrapping ? "100%" : "max-content",
                    }}
                >
                    {lines.length > 0 ? (
                        <div style={{ padding: "4px 0" }}>
                            {renderBlocks.map((block) => {
                                if (block.kind === "separator") {
                                    return (
                                        <DiffLineView
                                            compactLineNumbers={
                                                compactLineNumbers
                                            }
                                            filePath={file?.path ?? diff.path}
                                            key={block.key}
                                            line={block.line}
                                            lineWrapping={lineWrapping}
                                        />
                                    );
                                }

                                if (
                                    block.kind !== "visual" ||
                                    !visualBlockSet.has(block.visualBlockIndex)
                                ) {
                                    return (
                                        <div key={block.key}>
                                            {renderDiffLines(block.lines, {
                                                compactLineNumbers,
                                                filePath:
                                                    file?.path ?? diff.path,
                                                lineWrapping,
                                            })}
                                        </div>
                                    );
                                }

                                const segments = buildVisualSegments(
                                    block.lines,
                                );

                                return (
                                    <div
                                        key={block.key}
                                        style={{
                                            backgroundColor:
                                                "color-mix(in srgb, var(--color-bg-primary) 40%, var(--color-bg-elevated))",
                                            border: "1px solid color-mix(in srgb, var(--color-border) 40%, transparent)",
                                            borderRadius: 8,
                                            margin: "4px 6px",
                                            overflow: "hidden",
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
                                                    !interactiveHunksEnabled ||
                                                    !file
                                                ) {
                                                    return (
                                                        <div
                                                            key={segment.key}
                                                        >
                                                            {renderDiffLines(
                                                                segment.lines,
                                                                {
                                                                    compactLineNumbers,
                                                                    filePath:
                                                                        file?.path ??
                                                                        diff.path,
                                                                    lineWrapping,
                                                                },
                                                            )}
                                                        </div>
                                                    );
                                                }

                                                const trackedHunk =
                                                    file.hunks[
                                                        segment.decisionHunkIndex
                                                    ] ?? null;
                                                const hunkId =
                                                    trackedHunk?.id ??
                                                    decisionHunks[
                                                        segment.decisionHunkIndex
                                                    ]?.index.toString() ??
                                                    null;

                                                return (
                                                    <div
                                                        className="group"
                                                        data-review-file-key={
                                                            file.identityKey
                                                        }
                                                        data-review-file-updated-at={
                                                            file.updatedAt
                                                        }
                                                        data-review-hunk-key={
                                                            hunkId ?? undefined
                                                        }
                                                        key={segment.key}
                                                        style={{
                                                            backgroundColor:
                                                                "color-mix(in srgb, var(--color-bg-elevated) 72%, transparent)",
                                                            border: "1px solid color-mix(in srgb, var(--color-border) 32%, transparent)",
                                                            borderRadius: 4,
                                                            margin: "4px 0",
                                                            overflow: "hidden",
                                                            position:
                                                                "relative",
                                                        }}
                                                    >
                                                        {hunkId ? (
                                                            <HunkActionBar
                                                                hunkIndex={
                                                                    segment.decisionHunkIndex
                                                                }
                                                                onAccept={() =>
                                                                    onKeepHunk?.(
                                                                        hunkId,
                                                                    )
                                                                }
                                                                onReject={() =>
                                                                    onRejectHunk?.(
                                                                        hunkId,
                                                                    )
                                                                }
                                                            />
                                                        ) : null}
                                                        <div
                                                            style={{
                                                                paddingRight:
                                                                    4,
                                                                paddingTop: 4,
                                                            }}
                                                        >
                                                            {renderDiffLines(
                                                                segment.lines,
                                                                {
                                                                    compactLineNumbers,
                                                                    filePath:
                                                                        file.path,
                                                                    lineWrapping,
                                                                },
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
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
