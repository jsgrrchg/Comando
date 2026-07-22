import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "@shared/ipc";

import {
    canResolveFileHunks,
    deriveReviewItems,
    deriveReviewSummary,
    getFileSummary,
    getFileTone,
} from "./editedFilesPresentationModel";

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    return {
        identityKey: "tracked-file",
        hunks: [],
        isText: true,
        kind: "update",
        newText: "after",
        oldText: "before",
        path: "src/example.ts",
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T12:00:00.000Z",
        ...overrides,
    };
}

describe("editedFilesPresentationModel", () => {
    it("maps move, partial and openability into review items", () => {
        const movedFile = createTrackedFile({
            identityKey: "move",
            kind: "move",
            path: "src/next/location.ts",
            previousPath: "src/prev/location.ts",
            updatedAt: "2026-04-14T13:00:00.000Z",
        });
        const partialFile = createTrackedFile({
            identityKey: "partial",
            isText: false,
            path: "assets/logo.png",
            reversible: false,
            updatedAt: "2026-04-14T11:00:00.000Z",
        });

        const items = deriveReviewItems(
            [partialFile, movedFile],
            new Set(["src/next/location.ts"]),
        );

        expect(items.map((item) => item.file.identityKey)).toEqual([
            "move",
            "partial",
        ]);
        expect(items[0]).toEqual(
            expect.objectContaining({
                canOpen: true,
                canReject: true,
                openRelativePath: "src/next/location.ts",
                summary: "Moved from location.ts",
                tone: {
                    accent: "var(--diff-move)",
                    badge: null,
                },
            }),
        );
        expect(items[1]).toEqual(
            expect.objectContaining({
                canOpen: false,
                canReject: false,
                openRelativePath: null,
                summary: "Modified",
                tone: {
                    accent: "var(--diff-warn)",
                    badge: "Partial",
                },
            }),
        );
    });

    it("derives canResolveHunks only for reversible text updates with hunks", () => {
        const resolvable = createTrackedFile({
            hunks: [
                {
                    id: "hunk-1",
                    lines: [{ id: "line-1", text: "hello", type: "add" }],
                    newCount: 1,
                    newStart: 1,
                    oldCount: 0,
                    oldStart: 1,
                },
            ],
        });

        expect(canResolveFileHunks(resolvable)).toBe(true);
        expect(
            canResolveFileHunks(
                createTrackedFile({
                    hunks: resolvable.hunks,
                    kind: "create",
                }),
            ),
        ).toBe(false);
        expect(
            canResolveFileHunks(
                createTrackedFile({
                    hunks: resolvable.hunks,
                    reversible: false,
                }),
            ),
        ).toBe(false);
    });

    it("summarizes review items and keeps partial count in scope", () => {
        const items = deriveReviewItems([
            createTrackedFile({
                identityKey: "create",
                kind: "create",
                newText: "one\ntwo",
                oldText: null,
            }),
            createTrackedFile({
                identityKey: "delete",
                kind: "delete",
                newText: null,
                oldText: "three",
            }),
            createTrackedFile({
                identityKey: "partial",
                isText: false,
                reversible: false,
            }),
        ]);

        expect(deriveReviewSummary(items)).toEqual({
            additions: 2,
            approximate: true,
            deletions: 1,
            fileCount: 3,
            partialCount: 1,
        });
    });

    it("accepts a resolver callback for openable paths", () => {
        const absoluteFile = createTrackedFile({
            identityKey: "absolute",
            path: "/workspace/comando/src/absolute.ts",
        });

        const items = deriveReviewItems([absoluteFile], (file) =>
            file.path === "/workspace/comando/src/absolute.ts"
                ? "src/absolute.ts"
                : null,
        );

        expect(items[0]).toEqual(
            expect.objectContaining({
                canOpen: true,
                openRelativePath: "src/absolute.ts",
            }),
        );
    });

    it("exposes tone and summary helpers directly", () => {
        expect(
            getFileTone(
                createTrackedFile({
                    kind: "delete",
                }),
            ),
        ).toEqual({
            accent: "var(--diff-remove)",
            badge: null,
        });
        expect(
            getFileSummary(
                createTrackedFile({
                    kind: "create",
                }),
            ),
        ).toBe("New file");
    });

    it("labels provisional native review files while their hunks are prepared", () => {
        const preparing = createTrackedFile({
            nativeReviewState: "preparing",
        });

        expect(getFileTone(preparing)).toEqual({
            accent: "var(--text-muted)",
            badge: "Preparing",
        });
        expect(getFileSummary(preparing)).toBe("Preparing diff…");
    });
});
