import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD,
    GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD,
    GitDiffsView,
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
                header: "@@ -1,1 +1,1 @@",
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
                oldStart: 1,
            },
        ],
        id: `src/large-file-${index}.ts`,
        path: `src/large-file-${index}.ts`,
        summary: "+1 -0",
    });
}

function createLargeLineDiffFile(): GitDiffFile {
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
    });
}

describe("GitDiffsView", () => {
    it("renders diff lines with the shared highlighted renderer", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain('data-diff-line="true"');
        expect(markup).toContain('data-line-exact="true"');
        expect(markup).toContain('data-line-type="context"');
        expect(markup).toContain('data-line-type="remove"');
        expect(markup).toContain('data-line-type="add"');
        expect(markup).toContain("cm-static-code");
        expect(markup).toContain("grid-template-columns:44px minmax(0, 1fr)");
        expect(markup).not.toContain("grid-template-columns:56px 56px");
        expect(markup).toContain("const before = true;");
        expect(markup).toContain("const after = true;");
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

    it("sizes non-wrapping hunks to their scrollable content", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                lineWrapping={false}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain('class="min-w-full w-max"');
        expect(markup).toContain("grid-template-columns:44px max-content");
    });

    it("keeps diff code selectable inside non-selectable commit UI", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain("select-text");
        expect(markup).toContain("user-select:text");
    });

    it("owns vertical scroll when no external scroll container is provided", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain(
            'class="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2"',
        );
    });

    it("uses the parent scroll container when an external ref is provided", () => {
        const markup = renderToStaticMarkup(
            <GitDiffsView
                files={[createDiffFile()]}
                scrollContainerRef={createRef<HTMLElement>()}
                showFileSelector={false}
            />,
        );

        expect(markup).toContain('class="min-h-0 flex-1 px-2 py-2"');
        expect(markup).not.toContain(
            'class="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2"',
        );
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

    it("renders the large stacked diff baseline without dropping files or lines", () => {
        const files = [
            ...Array.from(
                { length: GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD },
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

        expect(markup).toContain("large-file-1.ts");
        expect(markup).toContain(
            `large-file-${GIT_DIFF_FILE_VIRTUALIZATION_THRESHOLD}.ts`,
        );
        expect(markup).toContain("giant-diff-line-1");
        expect(markup).toContain(
            `giant-diff-line-${GIT_DIFF_LINE_VIRTUALIZATION_THRESHOLD}`,
        );
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

        expect(markup).toContain("giant-diff.ts");
        expect(markup).not.toContain("giant-diff-line-1");
        expect(markup).toContain("large-file-1-line");
    });
});
