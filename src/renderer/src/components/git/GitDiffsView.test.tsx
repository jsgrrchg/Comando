import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockScrollToIndex = vi.hoisted(() => vi.fn());

vi.mock("@renderer/components/virtual/MeasuredVirtualList", () => ({
    MeasuredVirtualList: <T,>({
        enabled = true,
        estimateSize,
        getItemKey,
        items,
        onReady,
        renderItem,
        scrollMarginTop = 0,
    }: {
        readonly enabled?: boolean;
        readonly estimateSize: (item: T, index: number) => number;
        readonly getItemKey: (item: T, index: number) => string;
        readonly items: readonly T[];
        readonly onReady?: (
            handle: { readonly scrollToIndex: typeof mockScrollToIndex } | null,
        ) => void;
        readonly renderItem: (params: {
            readonly index: number;
            readonly isVisible: boolean;
            readonly item: T;
        }) => ReactNode;
        readonly scrollMarginTop?: number;
    }) => {
        onReady?.({ scrollToIndex: mockScrollToIndex });
        const renderedItems = enabled ? items.slice(0, 6) : items;

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
    GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD,
    GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD,
    GitDiffsView,
    estimateDiffFileSurfaceHeight,
} from "./GitDiffsView";
import type { GitDiffFile } from "./types";

function createDiffFile(overrides: Partial<GitDiffFile> = {}): GitDiffFile {
    return {
        hunks: [
            {
                header: "@@ -1,2 +1,2 @@",
                id: "hunk-1",
                lines: [
                    {
                        id: "line-1",
                        kind: "context",
                        newLineNumber: 1,
                        oldLineNumber: 1,
                        text: "const value = before();",
                    },
                    {
                        id: "line-2",
                        kind: "remove",
                        newLineNumber: null,
                        oldLineNumber: 2,
                        text: "const before = true;",
                    },
                    {
                        id: "line-3",
                        kind: "add",
                        newLineNumber: 2,
                        oldLineNumber: null,
                        text: "const after = true;",
                    },
                ],
                newCount: 2,
                newStart: 1,
                oldCount: 2,
                oldStart: 1,
            },
        ],
        id: "src/example.ts",
        isText: true,
        kind: "update",
        newText: null,
        oldText: null,
        path: "src/example.ts",
        previousPath: null,
        reversible: true,
        statusLabel: "modified",
        summary: "+1 -1",
        ...overrides,
    };
}

function createLargeDiffFile(index: number): GitDiffFile {
    return createDiffFile({
        hunks: [
            {
                header: "@@ -0,0 +1,1 @@",
                id: `hunk-${index}`,
                lines: [
                    {
                        id: `line-${index}`,
                        kind: "add",
                        newLineNumber: 1,
                        oldLineNumber: null,
                        text: `large-file-${index}-line`,
                    },
                ],
                newCount: 1,
                newStart: 1,
                oldCount: 0,
                oldStart: 0,
            },
        ],
        id: `src/large-file-${index}.ts`,
        path: `src/large-file-${index}.ts`,
        summary: "+1 -0",
    });
}

function createLargeLineDiffFile(
    overrides: Partial<GitDiffFile> = {},
): GitDiffFile {
    return createDiffFile({
        hunks: [
            {
                header: `@@ -1,0 +1,${GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD} @@`,
                id: "large-line-hunk",
                lines: Array.from(
                    { length: GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD },
                    (_, index) => ({
                        id: `large-line-${index + 1}`,
                        kind: "add",
                        newLineNumber: index + 1,
                        oldLineNumber: null,
                        text: `giant-diff-line-${index + 1}`,
                    }),
                ),
                newCount: GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD,
                newStart: 1,
                oldCount: 0,
                oldStart: 1,
            },
        ],
        id: "src/giant-diff.ts",
        path: "src/giant-diff.ts",
        summary: `+${GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD} -0`,
        ...overrides,
    });
}

describe("GitDiffsView", () => {
    it("delegates patch hunks to Pierre", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).not.toContain('data-virtualized-diff-lines="true"');
        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain('data-diff-line="true"');
        expect(markup).not.toContain("const before = true;");
        expect(markup).not.toContain("const after = true;");
    });

    it("applies configured editor typography to diff code", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                codeFontFamily="CustomMono"
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("font-family:CustomMono");
    });

    it("respects the configured line height for diff code", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                codeLineHeight={1.85}
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("line-height:1.85");
    });

    it("respects the configured font size for diff code", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                codeFontSize={17}
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("font-size:17px");
    });

    it("delegates non-wrapping patch layout to Pierre", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                lineWrapping={false}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain('data-diff-line="true"');
    });

    it("delegates giant patch files to Pierre's virtualizer", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createLargeLineDiffFile()]}
                lineWrapping={false}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain('data-virtualized-diff-lines="true"');
        expect(markup).not.toContain("giant-diff-line-1");
    });

    it("delegates complete large files to Pierre without legacy line virtualization", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[
                    createLargeLineDiffFile({
                        newText: "const value = 'after';\n",
                        oldText: "const value = 'before';\n",
                    }),
                ]}
                lineWrapping={false}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain('data-virtualized-diff-lines="true"');
        expect(markup).not.toContain("giant-diff-line-1");
    });

    it("does not render long patch lines through the legacy surface", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[
                    createLargeLineDiffFile({
                        hunks: [
                            {
                                header: `@@ -1,0 +1,${GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD} @@`,
                                id: "wide-line-hunk",
                                lines: Array.from(
                                    {
                                        length: GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD,
                                    },
                                    (_, index) => ({
                                        id: `wide-line-${index + 1}`,
                                        kind: "add",
                                        newLineNumber: index + 1,
                                        oldLineNumber: null,
                                        text:
                                            index ===
                                            GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD -
                                                1
                                                ? "x".repeat(220)
                                                : `short-line-${index + 1}`,
                                    }),
                                ),
                                newCount: GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD,
                                newStart: 1,
                                oldCount: 0,
                                oldStart: 1,
                            },
                        ],
                    }),
                ]}
                lineWrapping={false}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain("x".repeat(220));
    });

    it("keeps diff code selectable inside non-selectable commit UI", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("select-text");
        expect(markup).toContain("pierre-git-code-view");
    });

    it("owns vertical scroll when no external scroll container is provided", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain(
            "pierre-git-code-view shell-scrollbar min-h-0 flex-1 overflow-y-auto select-text",
        );
    });

    it("keeps CodeView as the scroll owner even when a legacy ref is supplied", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                scrollContainerRef={createRef<HTMLElement>()}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).toContain("overflow-y-auto");
    });

    it("keeps the message for binary files", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[
                    createDiffFile({
                        hunks: [],
                        id: "logo.png",
                        isText: false,
                        path: "assets/logo.png",
                    }),
                ]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("This file is binary");
    });

    it("renders every stacked diff file below the virtualization threshold", () => {
        const files = Array.from(
            { length: GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD - 1 },
            (_, index) => createLargeDiffFile(index + 1),
        );

        const markup = renderToStaticMarkup(
            <GitDiffsView
                displayMode="stack"
                files={files}
                showFileSelector={false}
            />,
        );

        expect(markup).not.toContain('data-measured-virtual-list="true"');
        expect(markup).toContain("pierre-git-code-view");
    });

    it("uses one CodeView for large stacked diffs", () => {
        const files = [
            ...Array.from(
                { length: GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD + 1 },
                (_, index) => createLargeDiffFile(index + 1),
            ),
            createLargeLineDiffFile(),
        ];

        const markup = renderToStaticMarkup(
            <GitDiffsView
                displayMode="stack"
                files={files}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain('data-measured-virtual-list="true"');
        expect(markup).not.toContain("giant-diff-line-1");
    });

    it("keeps collapse state authoritative in the large stacked diff baseline", () => {
        const collapsedFile = createLargeLineDiffFile();
        const files = [createLargeDiffFile(1), collapsedFile];

        const markup = renderToStaticMarkup(
            <GitDiffsView
                collapsedFileIds={[collapsedFile.id]}
                displayMode="stack"
                files={files}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("pierre-git-code-view");
        expect(markup).not.toContain("giant-diff-line-1");
        expect(markup).not.toContain('data-virtualized-diff-lines="true"');
    });

    it("estimates collapsed diff files smaller than expanded text files", () => {
        const file = createLargeLineDiffFile();

        expect(estimateDiffFileSurfaceHeight(file, true, 20)).toBeLessThan(
            estimateDiffFileSurfaceHeight(file, false, 20),
        );
    });

    it("caps extremely large initial diff file estimates", () => {
        expect(
            estimateDiffFileSurfaceHeight(createLargeLineDiffFile(), false, 20),
        ).toBe(1600);
    });
});
