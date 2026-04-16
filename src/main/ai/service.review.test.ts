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
    it("accumulates consecutive updates for the same file", () => {
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

    it("accumulates even when the next diff does not chain with the previous newText", () => {
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

    it("keeps the pending base when hunks were already accepted", () => {
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

    it("removes tracked file if the net sequence leaves no diff", () => {
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

    it("anchors hunks to the current document even when previous changes exist", () => {
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

    it("keeps a visible anchor for deletions at end of file", () => {
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

    it("normalizes tool diff paths back into project-relative paths", () => {
        expect(
            __testing.normalizeTrackedDiffPath(
                {
                    cwd: "/workspace/comando",
                    projectRoot: "/workspace/comando",
                },
                "/workspace/comando/src/app.ts",
            ),
        ).toBe("src/app.ts");

        expect(
            __testing.diffToAiFileDiff(
                {
                    _meta: {
                        neverwritePreviousPath:
                            "/workspace/comando/src/previous.ts",
                    },
                    newText: "export const value = 2;\n",
                    oldText: "export const value = 1;\n",
                    path: "/workspace/comando/src/app.ts",
                } as never,
                "edit",
                (candidatePath) =>
                    __testing.normalizeTrackedDiffPath(
                        {
                            cwd: "/workspace/comando",
                            projectRoot: "/workspace/comando",
                        },
                        candidatePath,
                    ),
            ),
        ).toMatchObject({
            path: "src/app.ts",
            previousPath: "src/previous.ts",
        });
    });

    it("recomputes text hunks instead of trusting external diff metadata", () => {
        const oldText = "alpha\nbeta\ngamma";
        const newText = "alpha\nBETA\ngamma";

        expect(
            __testing.diffToAiFileDiff(
                {
                    _meta: {
                        neverwriteHunks: [
                            {
                                lines: [
                                    { text: "alpha", type: "remove" },
                                    { text: "beta", type: "remove" },
                                    { text: "gamma", type: "remove" },
                                    { text: "alpha", type: "add" },
                                    { text: "BETA", type: "add" },
                                    { text: "gamma", type: "add" },
                                ],
                                newCount: 3,
                                newStart: 1,
                                oldCount: 3,
                                oldStart: 1,
                                visualEndLine: 3,
                                visualStartLine: 1,
                            },
                        ],
                    },
                    newText,
                    oldText,
                    path: "notes/example.md",
                } as never,
                "edit",
            ).hunks,
        ).toEqual(
            __testing.computeDiffHunks(oldText, newText, "notes/example.md"),
        );
    });

    it("suppresses duplicate Codex turn item activities for user and agent messages", () => {
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        neverwriteEventType: "status",
                    },
                    toolCallId: "neverwrite:status:item:msg-1",
                } as never,
                "Preparing input",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        neverwriteEventType: "status",
                    },
                    toolCallId: "neverwrite:status:item:msg-2",
                } as never,
                "Drafting response",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        neverwriteEventType: "status",
                    },
                    toolCallId: "neverwrite:status:item:msg-3",
                } as never,
                "Reasoning",
            ),
        ).toBe(false);
    });

    it("suppresses the tool_call_update completion that codex-acp emits without meta", () => {
        // codex-acp omits meta on send_status_tool_call_update, which caused
        // the "Drafting response" activity to reappear on turn completion.
        // The stable toolCallId prefix lets us suppress it anyway.
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "neverwrite:status:item:agent-msg-42",
                } as never,
                "Drafting response",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "neverwrite:status:item:user-msg-7",
                } as never,
                "Preparing input",
            ),
        ).toBe(true);
    });

    it("keeps turn-started status tool calls so they render as dividers", () => {
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        neverwriteEventType: "status",
                    },
                    toolCallId: "neverwrite:status:turn:turn-1",
                } as never,
                "New turn",
            ),
        ).toBe(false);
    });

    it("does not suppress real tools whose title accidentally collides", () => {
        // A legitimate tool call unrelated to codex-acp status events must
        // not be silently dropped just because its title happens to match.
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "normal-agent-tool-id",
                } as never,
                "Drafting response",
            ),
        ).toBe(false);
    });
});
