import { describe, expect, it } from "vitest";

import type { AiTrackedFile } from "@shared/ipc";

import { __testing } from "./service";

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    const path = overrides.path ?? "notes/example.md";
    const oldText =
        overrides.oldText === undefined ? "before line" : overrides.oldText;
    const newText =
        overrides.newText === undefined
            ? "before line\nafter line"
            : overrides.newText;
    const previousPath =
        overrides.previousPath === undefined ? null : overrides.previousPath;
    const kind =
        overrides.kind ??
        (previousPath
            ? "move"
            : oldText === null
              ? "create"
              : newText === null
                ? "delete"
                : "update");

    return {
        identityKey: previousPath ? `${previousPath}->${path}` : path,
        hunks:
            overrides.hunks ??
            __testing.computeDiffHunks(oldText ?? "", newText ?? "", path),
        isText: true,
        kind,
        newText,
        oldText,
        path,
        previousPath,
        reviewState: "pending",
        reversible: kind === "create" || oldText !== null,
        sessionId: "session-1",
        toolCallId: "tool-1",
        updatedAt: "2026-04-14T12:00:00.000Z",
        ...overrides,
    };
}

describe("AiService tracked file review merging", () => {
    it("acumula cambios consecutivos sobre el mismo archivo", () => {
        const firstTrackedFile = createTrackedFile({
            newText: "line 1\nline 2",
            oldText: "line 1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const secondTrackedFile = createTrackedFile({
            newText: "line 1\nline 2\nline 3",
            oldText: "line 1\nline 2",
            toolCallId: "tool-2",
            updatedAt: "2026-04-14T12:01:00.000Z",
        });

        const trackedFiles = __testing.upsertTrackedFile(
            [firstTrackedFile],
            secondTrackedFile,
        );

        expect(trackedFiles).toHaveLength(1);
        expect(trackedFiles[0]).toMatchObject({
            newText: "line 1\nline 2\nline 3",
            oldText: "line 1",
            reviewState: "pending",
            toolCallId: "tool-2",
        });
        expect(trackedFiles[0]?.hunks).toEqual(
            __testing.computeDiffHunks(
                "line 1",
                "line 1\nline 2\nline 3",
                "notes/example.md",
            ),
        );
    });

    it("acumula aunque el siguiente diff no encadene con el newText previo", () => {
        const firstTrackedFile = createTrackedFile({
            newText: "line 1\nline 2",
            oldText: "line 1",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T12:00:00.000Z",
        });
        const secondTrackedFile = createTrackedFile({
            newText: "line 1\nline 2\nline 3",
            oldText: "line 1",
            toolCallId: "tool-2",
            updatedAt: "2026-04-14T12:01:00.000Z",
        });

        const trackedFiles = __testing.upsertTrackedFile(
            [firstTrackedFile],
            secondTrackedFile,
        );

        expect(trackedFiles).toHaveLength(1);
        expect(trackedFiles[0]).toMatchObject({
            newText: "line 1\nline 2\nline 3",
            oldText: "line 1",
            toolCallId: "tool-2",
        });
        expect(trackedFiles[0]?.hunks).toEqual(
            __testing.computeDiffHunks(
                "line 1",
                "line 1\nline 2\nline 3",
                "notes/example.md",
            ),
        );
    });

    it("mantiene la base pendiente cuando ya habia hunks aceptados", () => {
        const originalTrackedFile = createTrackedFile({
            newText: "A\nb\nC\nd",
            oldText: "a\nb\nc\nd",
        });
        const firstHunk = originalTrackedFile.hunks[0];

        expect(firstHunk).toBeDefined();
        if (!firstHunk) {
            throw new Error(
                "Expected the tracked file to have at least one hunk.",
            );
        }

        const partiallyKeptTrackedFile = __testing.resolveTrackedFileHunks(
            originalTrackedFile,
            [firstHunk.id],
            "keep",
        );

        expect(partiallyKeptTrackedFile).not.toBeNull();

        const nextTrackedFile = createTrackedFile({
            newText: "A\nb\nC\nD",
            oldText: "A\nb\nC\nd",
            toolCallId: "tool-2",
            updatedAt: "2026-04-14T12:02:00.000Z",
        });
        if (!partiallyKeptTrackedFile) {
            throw new Error("Expected a partially kept tracked file.");
        }

        const trackedFiles = __testing.upsertTrackedFile(
            [partiallyKeptTrackedFile],
            nextTrackedFile,
        );

        expect(trackedFiles).toHaveLength(1);
        expect(trackedFiles[0]).toMatchObject({
            newText: "A\nb\nC\nD",
            oldText: "A\nb\nc\nd",
        });
        expect(trackedFiles[0]?.hunks).toEqual(
            __testing.computeDiffHunks(
                "A\nb\nc\nd",
                "A\nb\nC\nD",
                "notes/example.md",
            ),
        );
    });

    it("elimina el tracked file si la secuencia neta no deja diff", () => {
        const createdTrackedFile = createTrackedFile({
            kind: "create",
            newText: "temporary content",
            oldText: null,
        });
        const deletedTrackedFile = createTrackedFile({
            kind: "delete",
            newText: null,
            oldText: "temporary content",
            toolCallId: "tool-2",
            updatedAt: "2026-04-14T12:03:00.000Z",
        });

        const trackedFiles = __testing.upsertTrackedFile(
            [createdTrackedFile],
            deletedTrackedFile,
        );

        expect(trackedFiles).toEqual([]);
    });

    it("ancla los hunks al documento actual aunque existan cambios previos", () => {
        const hunks = __testing.computeDiffHunks(
            "alpha\nbeta\ngamma",
            "zero\nalpha\nBETA\ngamma",
            "notes/example.md",
        );

        expect(hunks).toHaveLength(2);
        expect(hunks[0]).toMatchObject({
            newStart: 1,
            oldStart: 1,
            visualEndLine: 1,
            visualStartLine: 1,
        });
        expect(hunks[1]).toMatchObject({
            newStart: 3,
            oldStart: 2,
            visualEndLine: 3,
            visualStartLine: 3,
        });
    });

    it("mantiene un ancla visible para borrados al final del archivo", () => {
        const hunks = __testing.computeDiffHunks(
            "alpha\nbeta",
            "alpha",
            "notes/example.md",
        );

        expect(hunks).toHaveLength(1);
        expect(hunks[0]).toMatchObject({
            newCount: 0,
            newStart: 2,
            oldCount: 1,
            oldStart: 2,
            visualEndLine: 1,
            visualStartLine: 1,
        });
    });
});
