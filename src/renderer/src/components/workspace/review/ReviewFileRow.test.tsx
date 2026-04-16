import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewFileItem } from "./editedFilesPresentationModel";
import { ReviewFileRow } from "./ReviewFileRow";

function createItem(): ReviewFileItem {
    return {
        canOpen: true,
        canReject: true,
        canResolveHunks: true,
        openRelativePath: "src/app.ts",
        diff: {
            hunks: [
                {
                    id: "hunk-1",
                    lines: [
                        {
                            id: "line-1",
                            text: "const before = true;",
                            type: "remove",
                        },
                        {
                            id: "line-2",
                            text: "const after = true;",
                            type: "add",
                        },
                    ],
                    newCount: 1,
                    newStart: 8,
                    oldCount: 1,
                    oldStart: 8,
                },
            ],
            isText: true,
            kind: "update",
            newText: "const after = true;\n",
            oldText: "const before = true;\n",
            path: "src/app.ts",
            previousPath: null,
            reversible: true,
        },
        file: {
            hunks: [
                {
                    id: "hunk-1",
                    lines: [
                        {
                            id: "line-1",
                            text: "const before = true;",
                            type: "remove",
                        },
                        {
                            id: "line-2",
                            text: "const after = true;",
                            type: "add",
                        },
                    ],
                    newCount: 1,
                    newStart: 8,
                    oldCount: 1,
                    oldStart: 8,
                },
            ],
            identityKey: "file-1",
            isText: true,
            kind: "update",
            newText: "const after = true;\n",
            oldText: "const before = true;\n",
            path: "src/app.ts",
            previousPath: null,
            reviewState: "pending",
            reversible: true,
            sessionId: "session-1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T12:00:00.000Z",
        },
        stats: {
            additions: 1,
            approximate: false,
            deletions: 1,
        },
        summary: "Modified",
        tone: {
            accent: "var(--diff-add)",
            badge: null,
        },
    };
}

describe("ReviewFileRow", () => {
    it("renders the full variant with actions and diff preview", () => {
        const markup = renderToStaticMarkup(
            <ReviewFileRow
                diffZoom={0.72}
                expanded
                item={createItem()}
                onKeep={() => {}}
                onKeepHunk={() => {}}
                onOpen={() => {}}
                onReject={() => {}}
                onRejectHunk={() => {}}
                onToggle={() => {}}
                variant="full"
            />,
        );

        expect(markup).toContain("src/app.ts");
        expect(markup).toContain("Modified");
        expect(markup).toContain("open");
        expect(markup).toContain("accept");
        expect(markup).toContain("reject");
        expect(markup).toContain("review-file-diff:file-1");
        expect(markup).toContain('data-line-wrapping="false"');
    });

    it("renders the compact variant with the smaller summary layout", () => {
        const markup = renderToStaticMarkup(
            <ReviewFileRow
                diffZoom={0.72}
                expanded={false}
                item={createItem()}
                onKeep={() => {}}
                onReject={() => {}}
                onToggle={() => {}}
                variant="compact"
            />,
        );

        expect(markup).toContain("app.ts");
        expect(markup).toContain("Open File");
        expect(markup).toContain("not-allowed");
        expect(markup).not.toContain("review-file-diff:file-1");
    });
});
