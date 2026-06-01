import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiFileDiff, AiTrackedFile } from "@shared/ipc";

vi.mock("@renderer/components/virtual/MeasuredVirtualList", () => ({
    MeasuredVirtualList: <T,>({
        enabled = true,
        estimateSize,
        getItemKey,
        items,
        renderItem,
        scrollMarginTop = 0,
    }: {
        readonly enabled?: boolean;
        readonly estimateSize: (item: T, index: number) => number;
        readonly getItemKey: (item: T, index: number) => string;
        readonly items: readonly T[];
        readonly renderItem: (params: {
            readonly index: number;
            readonly isVisible: boolean;
            readonly item: T;
        }) => ReactNode;
        readonly scrollMarginTop?: number;
    }) => {
        const renderedItems = enabled ? items.slice(0, 8) : items;

        return (
            <div
                data-measured-virtual-list="true"
                data-scroll-margin-top={scrollMarginTop}
            >
                {renderedItems.map((item, index) => (
                    <div
                        data-estimated-size={estimateSize(item, index)}
                        key={getItemKey(item, index)}
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
    },
}));

import {
    EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD,
    EditedFileDiffPreview,
} from "./EditedFileDiffPreview";

function createDiff(): AiFileDiff {
    return {
        hunks: [
            {
                id: "hunk-1",
                lines: [
                    {
                        id: "hunk-1:remove",
                        text: "const firstBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-1:add",
                        text: "const firstAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 3,
                oldCount: 1,
                oldStart: 3,
            },
            {
                id: "hunk-2",
                lines: [
                    {
                        id: "hunk-2:remove",
                        text: "const secondBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-2:add",
                        text: "const secondAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 12,
                oldCount: 1,
                oldStart: 12,
            },
        ],
        isText: true,
        kind: "update",
        newText: "const firstAfter = true;\nconst secondAfter = true;\n",
        oldText: "const firstBefore = true;\nconst secondBefore = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reversible: true,
    };
}

function createTrackedFile(): AiTrackedFile {
    return {
        hunks: [
            {
                id: "hunk-2",
                lines: [
                    {
                        id: "hunk-2:remove",
                        text: "const secondBefore = true;",
                        type: "remove",
                    },
                    {
                        id: "hunk-2:add",
                        text: "const secondAfter = true;",
                        type: "add",
                    },
                ],
                newCount: 1,
                newStart: 12,
                oldCount: 1,
                oldStart: 12,
            },
        ],
        identityKey: "file-1",
        isText: true,
        kind: "update",
        newText: "const firstAfter = true;\nconst secondAfter = true;\n",
        oldText: "const firstBefore = true;\nconst secondBefore = true;\n",
        path: "src/app.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T12:00:00.000Z",
    };
}

function createLargeExactDiff(): AiFileDiff {
    return {
        ...createDiff(),
        hunks: [
            {
                id: "large-hunk",
                lines: Array.from(
                    {
                        length: EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD,
                    },
                    (_, index) => ({
                        id: `large-line-${index + 1}`,
                        text: `large-preview-line-${index + 1}`,
                        type: "add" as const,
                    }),
                ),
                newCount: EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD,
                newStart: 1,
                oldCount: 0,
                oldStart: 1,
            },
        ],
        newText: null,
        oldText: null,
        path: "src/large-preview.ts",
    };
}

function createLargeTrackedFile(): AiTrackedFile {
    return {
        ...createTrackedFile(),
        hunks: [
            {
                id: "large-hunk",
                lines: Array.from(
                    {
                        length: EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD,
                    },
                    (_, index) => ({
                        id: `large-line-${index + 1}`,
                        text: `large-preview-line-${index + 1}`,
                        type: "add" as const,
                    }),
                ),
                newCount: EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD,
                newStart: 1,
                oldCount: 0,
                oldStart: 1,
            },
        ],
        path: "src/large-preview.ts",
    };
}

describe("EditedFileDiffPreview", () => {
    it("keeps hunk actions bound to the tracked hunk id after partial resolution", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createDiff()}
                diffZoom={0.72}
                expanded
                file={createTrackedFile()}
                onKeepHunk={() => {}}
                onRejectHunk={() => {}}
                testId="preview-test"
            />,
        );

        expect(markup).toContain('data-review-hunk-key="hunk-2"');
        expect(markup).not.toContain('data-review-hunk-key="hunk-1"');
        expect(markup).toContain("Accept hunk 2");
        expect(markup).not.toContain("Accept hunk 1");
    });

    it("positions inline hunk actions on the right edge", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createDiff()}
                diffZoom={0.72}
                expanded
                file={createTrackedFile()}
                onKeepHunk={() => {}}
                onRejectHunk={() => {}}
            />,
        );

        expect(markup).toContain("right:8px");
        expect(markup).not.toContain("left:8px");
    });

    it("uses a compact single line-number gutter in review previews", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createDiff()}
                diffZoom={0.72}
                expanded
            />,
        );

        expect(markup).toContain("grid-template-columns:44px max-content");
        expect(markup).not.toContain("grid-template-columns:56px 56px");
    });

    it("disables wrapping for code files by default", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createDiff()}
                diffZoom={0.72}
                expanded
            />,
        );

        expect(markup).toContain('data-line-wrapping="false"');
        expect(markup).toContain("overflow-x:auto");
    });

    it("keeps wrapping enabled for markdown files", () => {
        const markdownDiff = {
            ...createDiff(),
            path: "docs/readme.md",
        };
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={markdownDiff}
                diffZoom={0.72}
                expanded
            />,
        );

        expect(markup).toContain('data-line-wrapping="true"');
        expect(markup).toContain("overflow-x:hidden");
    });

    it("virtualizes giant review previews against the shared scroll container", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createLargeExactDiff()}
                diffZoom={0.72}
                expanded
                scrollContainerRef={createRef<HTMLElement>()}
            />,
        );

        expect(markup).toContain('data-virtualized-edited-diff="true"');
        expect(markup).toContain('data-measured-virtual-list="true"');
        expect(markup).toContain("large-preview-line-1");
        expect(markup).not.toContain(
            `large-preview-line-${EDITED_DIFF_PREVIEW_LINE_VIRTUALIZATION_THRESHOLD}`,
        );
    });

    it("keeps hunk actions available in virtualized review previews", () => {
        const markup = renderToStaticMarkup(
            <EditedFileDiffPreview
                diff={createLargeExactDiff()}
                diffZoom={0.72}
                expanded
                file={createLargeTrackedFile()}
                onKeepHunk={() => {}}
                onRejectHunk={() => {}}
                scrollContainerRef={createRef<HTMLElement>()}
            />,
        );

        expect(markup).toContain('data-review-hunk-key="large-hunk"');
        expect(markup).toContain("Accept hunk 1");
        expect(markup).toContain("Reject hunk 1");
    });
});
