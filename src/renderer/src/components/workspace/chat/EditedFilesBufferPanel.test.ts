import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
    ReviewFileItem,
    ReviewSummary,
} from "../review/editedFilesPresentationModel";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";

function createItem(
    overrides: Partial<ReviewFileItem> = {},
): ReviewFileItem {
    return {
        canOpen: true,
        canReject: true,
        canResolveHunks: true,
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
        lines: [],
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
        ...overrides,
    };
}

function createSummary(
    overrides: Partial<ReviewSummary> = {},
): ReviewSummary {
    return {
        additions: 1,
        approximate: false,
        deletions: 1,
        fileCount: 1,
        partialCount: 0,
        ...overrides,
    };
}

describe("EditedFilesBufferPanel", () => {
    it("renderiza el header, el resumen y las acciones principales", () => {
        const items = [
            createItem(),
            createItem({
                diff: {
                    hunks: [],
                    isText: true,
                    kind: "create",
                    newText: "export const secondary = true;\n",
                    oldText: "",
                    path: "src/secondary.ts",
                    previousPath: null,
                    reversible: true,
                },
                file: {
                    ...createItem().file,
                    hunks: [],
                    identityKey: "file-2",
                    kind: "create",
                    newText: "export const secondary = true;\n",
                    oldText: "",
                    path: "src/secondary.ts",
                    updatedAt: "2026-04-14T12:00:01.000Z",
                },
                stats: {
                    additions: 1,
                    approximate: false,
                    deletions: 0,
                },
                summary: "New file",
            }),
        ];

        const markup = renderToStaticMarkup(
            createElement(EditedFilesBufferPanel, {
                diffZoom: 0.72,
                items,
                onKeepAll: () => {},
                onKeepHunk: () => {},
                onKeepItem: () => {},
                onOpenItem: () => {},
                onOpenReview: () => {},
                onRejectAll: () => {},
                onRejectHunk: () => {},
                onRejectItem: () => {},
                summary: createSummary({
                    additions: 2,
                    deletions: 1,
                    fileCount: 2,
                }),
            }),
        );

        expect(markup).toContain("Edits");
        expect(markup).toContain("(2)");
        expect(markup).toContain("Review");
        expect(markup).toContain("Reject All");
        expect(markup).toContain("Keep All");
        expect(markup).toContain("src/app.ts");
        expect(markup).toContain("src/secondary.ts");
        expect(markup).toContain("Open File");
    });

    it("permite arrancar colapsado para mantener la sidebar compacta", () => {
        const markup = renderToStaticMarkup(
            createElement(EditedFilesBufferPanel, {
                defaultCollapsed: true,
                diffZoom: 0.72,
                items: [createItem()],
                onKeepAll: () => {},
                onKeepItem: () => {},
                onOpenItem: () => {},
                onOpenReview: () => {},
                onRejectAll: () => {},
                onRejectItem: () => {},
                summary: createSummary(),
            }),
        );

        expect(markup).toContain("Edits");
        expect(markup).not.toContain("edited-files-buffer-list");
        expect(markup).not.toContain("src/app.ts");
    });

    it("no renderiza nada cuando no hay archivos pendientes", () => {
        const markup = renderToStaticMarkup(
            createElement(EditedFilesBufferPanel, {
                diffZoom: 0.72,
                items: [],
                onKeepAll: () => {},
                onKeepItem: () => {},
                onOpenReview: () => {},
                onRejectAll: () => {},
                onRejectItem: () => {},
                summary: createSummary({
                    additions: 0,
                    deletions: 0,
                    fileCount: 0,
                }),
            }),
        );

        expect(markup).toBe("");
    });
});
