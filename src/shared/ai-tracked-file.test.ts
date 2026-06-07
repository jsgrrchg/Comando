import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "./ipc";

import {
    computeDiffHunks,
    resolveTrackedFileHunks,
    syncTrackedFile,
    upsertTrackedFile,
} from "./ai-tracked-file";

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    const path = overrides.path ?? "notes/example.md";
    const oldText = overrides.oldText ?? "alpha\nbeta\ngamma";
    const newText = overrides.newText ?? "alpha\nBETA\ngamma";

    return {
        currentText: newText,
        diffBase: oldText,
        hunks:
            overrides.hunks ??
            computeDiffHunks(oldText, newText, path),
        identityKey: path,
        isText: true,
        kind: "update",
        newText,
        oldText,
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-16T00:00:00.000Z",
        version: 1,
        ...overrides,
    };
}

describe("syncTrackedFile", () => {
    it("treats CRLF-only line ending changes as net-clean", () => {
        expect(
            computeDiffHunks(
                "alpha\nbeta\ngamma\n",
                "alpha\r\nbeta\r\ngamma\r\n",
                "notes/example.md",
            ),
        ).toEqual([]);
    });

    it("recomputes stale hunks from persisted text snapshots", () => {
        const oldText = "alpha\nbeta\ngamma";
        const newText = "alpha\nBETA\ngamma";
        const trackedFile = createTrackedFile({
            currentText: newText,
            diffBase: oldText,
            hunks: [
                {
                    id: "stale-hunk",
                    lines: [
                        { id: "line-1", text: "alpha", type: "remove" },
                        { id: "line-2", text: "beta", type: "remove" },
                        { id: "line-3", text: "gamma", type: "remove" },
                        { id: "line-4", text: "alpha", type: "add" },
                        { id: "line-5", text: "BETA", type: "add" },
                        { id: "line-6", text: "gamma", type: "add" },
                    ],
                    newCount: 3,
                    newStart: 1,
                    oldCount: 3,
                    oldStart: 1,
                    visualEndLine: 3,
                    visualStartLine: 1,
                },
            ],
            newText,
            oldText,
            path: "notes/example.md",
        });

        expect(syncTrackedFile(trackedFile).hunks).toEqual(
            computeDiffHunks(oldText, newText, trackedFile.path),
        );
    });
});

describe("resolveTrackedFileHunks", () => {
    it("recomputes pending hunks after resolving an anchored hunk", () => {
        const path = "src/foo.ts";
        const oldText = "one\ntwo\nthree\nfour";
        const newText = "ONE\ntwo\nTHREE\nfour";
        const trackedFile = createTrackedFile({
            currentText: newText,
            diffBase: oldText,
            hunks: computeDiffHunks(oldText, newText, path),
            hunksAreAnchored: true,
            identityKey: path,
            newText,
            oldText,
            path,
        });
        const firstHunk = trackedFile.hunks[0];

        if (!firstHunk) {
            throw new Error("Expected an anchored hunk.");
        }

        const resolved = resolveTrackedFileHunks(
            trackedFile,
            [firstHunk.id],
            "reject",
        );

        expect(resolved).not.toBeNull();
        expect(resolved?.currentText).toBe("one\ntwo\nTHREE\nfour");
        expect(resolved?.hunksAreAnchored).toBeUndefined();
        expect(resolved?.hunks).toEqual(
            computeDiffHunks(oldText, "one\ntwo\nTHREE\nfour", path),
        );
    });

    it("preserves CRLF line endings when resolving one pending hunk", () => {
        const path = "src/foo.ts";
        const oldText = "one\r\ntwo\r\nthree\r\nfour\r\n";
        const newText = "ONE\r\ntwo\r\nTHREE\r\nfour\r\n";
        const trackedFile = createTrackedFile({
            currentText: newText,
            diffBase: oldText,
            hunks: computeDiffHunks(oldText, newText, path),
            identityKey: path,
            newText,
            oldText,
            path,
        });
        const firstHunk = trackedFile.hunks[0];

        if (!firstHunk) {
            throw new Error("Expected a hunk.");
        }

        const resolved = resolveTrackedFileHunks(
            trackedFile,
            [firstHunk.id],
            "reject",
        );

        expect(resolved?.currentText).toBe(
            "one\r\ntwo\r\nTHREE\r\nfour\r\n",
        );
    });
});

describe("upsertTrackedFile multi-edit reconciliation", () => {
    const path = "src/foo.ts";
    const originalFile = "line-1\nline-2\nline-3\nline-4\nline-5\n";
    const afterFirstEdit = "line-1\nLINE-2\nline-3\nline-4\nline-5\n";

    function buildFirstEdit(): AiTrackedFile {
        return createTrackedFile({
            currentText: afterFirstEdit,
            diffBase: originalFile,
            hunks: computeDiffHunks(originalFile, afterFirstEdit, path),
            identityKey: path,
            newText: afterFirstEdit,
            oldText: originalFile,
            path,
        });
    }

    it("splices a second snippet edit onto the existing cumulative text", () => {
        const first = buildFirstEdit();
        const secondSnippetOld = "line-4";
        const secondSnippetNew = "LINE-4";
        const secondEdit = createTrackedFile({
            // Agent sends only the changed snippet — not the whole file.
            currentText: secondSnippetNew,
            diffBase: secondSnippetOld,
            hunks: computeDiffHunks(
                secondSnippetOld,
                secondSnippetNew,
                path,
            ),
            identityKey: path,
            newText: secondSnippetNew,
            oldText: secondSnippetOld,
            path,
            updatedAt: "2026-04-17T00:00:00.000Z",
        });

        const [merged] = upsertTrackedFile([first], secondEdit);

        const expectedFinal =
            "line-1\nLINE-2\nline-3\nLINE-4\nline-5\n";
        expect(merged.currentText).toBe(expectedFinal);
        expect(merged.newText).toBe(expectedFinal);
        expect(merged.diffBase).toBe(originalFile);
        // Hunks are recomputed from original → cumulative text and cover both
        // modifications.
        expect(merged.hunks.length).toBeGreaterThan(0);
        const addedLines = merged.hunks.flatMap((hunk) =>
            hunk.lines
                .filter((line) => line.type === "add")
                .map((line) => line.text),
        );
        expect(addedLines).toContain("LINE-2");
        expect(addedLines).toContain("LINE-4");
    });

    it("falls back to the raw next text when the snippet is ambiguous", () => {
        const repeatingFile = "dup\ndup\nend\n";
        const first = createTrackedFile({
            currentText: repeatingFile,
            diffBase: "dup\ndup\nstart\n",
            hunks: computeDiffHunks(
                "dup\ndup\nstart\n",
                repeatingFile,
                path,
            ),
            identityKey: path,
            newText: repeatingFile,
            oldText: "dup\ndup\nstart\n",
            path,
        });
        const ambiguousSnippet = createTrackedFile({
            currentText: "replaced\n",
            diffBase: "dup",
            hunks: computeDiffHunks("dup", "replaced", path),
            identityKey: path,
            newText: "replaced\n",
            oldText: "dup",
            path,
            updatedAt: "2026-04-17T00:00:00.000Z",
        });

        const [merged] = upsertTrackedFile([first], ambiguousSnippet);

        expect(merged.currentText).toBe("replaced\n");
    });

    it("removes the tracked file when the final text matches the diff base", () => {
        const first = buildFirstEdit();
        const revertingEdit = createTrackedFile({
            currentText: "line-2",
            diffBase: "LINE-2",
            hunks: computeDiffHunks("LINE-2", "line-2", path),
            identityKey: path,
            newText: "line-2",
            oldText: "LINE-2",
            path,
            updatedAt: "2026-04-17T00:00:00.000Z",
        });

        const result = upsertTrackedFile([first], revertingEdit);

        expect(result).toHaveLength(0);
    });
});
