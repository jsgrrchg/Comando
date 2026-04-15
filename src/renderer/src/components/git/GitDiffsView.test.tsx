import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitDiffsView } from "./GitDiffsView";
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
});
