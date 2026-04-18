import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiTrackedFile } from "@shared/ipc";

import {
    forgetOpenFileBuffer,
    recordOpenFileBuffer,
} from "./openFileBuffers";
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

function createClaudeEditUpdateContext(toolCallId = "tool-1") {
    return {
        meta: {
            claudeCode: {
                toolName: "Edit",
            },
        },
        sessionUpdate: "tool_call_update" as const,
        toolCallId,
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

describe("resolveDiffToFullTexts", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "comando-diff-"));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("expands a first-edit snippet by reading the file from disk", () => {
        const fileContent = "alpha\nbeta\ngamma\ndelta\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, fileContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "beta\ngamma",
                newText: "BETA\nGAMMA",
            } as never,
            undefined,
            liveSession,
            "foo.ts",
        );

        expect(resolved.oldText).toBe(fileContent);
        expect(resolved.newText).toBe("alpha\nBETA\nGAMMA\ndelta\n");
    });

    it("splices a subsequent edit onto the cumulative text from the existing tracked file", () => {
        const existing = createTrackedFile({
            path: "foo.ts",
            oldText: "alpha\nbeta\ngamma\n",
            newText: "alpha\nBETA\ngamma\n",
            currentText: "alpha\nBETA\ngamma\n",
            diffBase: "alpha\nbeta\ngamma\n",
        });
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "gamma",
                newText: "GAMMA",
            } as never,
            existing,
            liveSession,
            "foo.ts",
        );

        expect(resolved.oldText).toBe("alpha\nbeta\ngamma\n");
        expect(resolved.newText).toBe("alpha\nBETA\nGAMMA\n");
    });

    it("falls back to the raw diff when the snippet is ambiguous", () => {
        const existing = createTrackedFile({
            path: "foo.ts",
            oldText: "dup\ndup\n",
            newText: "dup\ndup\n",
            currentText: "dup\ndup\n",
            diffBase: "dup\ndup\n",
        });
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "dup",
                newText: "DUP",
            } as never,
            existing,
            liveSession,
            "foo.ts",
        );

        expect(resolved.oldText).toBe("dup");
        expect(resolved.newText).toBe("DUP");
    });

    it("falls back when the file cannot be read from disk", () => {
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "missing.ts",
                oldText: "orig",
                newText: "new",
            } as never,
            undefined,
            liveSession,
            "missing.ts",
        );

        expect(resolved.oldText).toBe("orig");
        expect(resolved.newText).toBe("new");
    });

    it("prefers the in-editor buffer over the disk when the file is open with unsaved changes", () => {
        const diskContent = "alpha\nbeta\ngamma\n";
        const bufferContent = "alpha\nbeta-WIP\ngamma\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, diskContent, "utf8");
        recordOpenFileBuffer(absolutePath, bufferContent);

        try {
            const liveSession = { cwd: tempDir, projectRoot: tempDir };
            const resolved = __testing.resolveDiffToFullTexts(
                {
                    path: "foo.ts",
                    oldText: "beta-WIP",
                    newText: "beta-DONE",
                } as never,
                undefined,
                liveSession,
                "foo.ts",
            );

            expect(resolved.oldText).toBe(bufferContent);
            expect(resolved.newText).toBe("alpha\nbeta-DONE\ngamma\n");
        } finally {
            forgetOpenFileBuffer(absolutePath);
        }
    });

    it("treats Claude's post-hook re-emission of an already-applied edit as a no-op", () => {
        // Simulates the Claude PostToolUseHook emitting a structuredPatch
        // hunk AFTER the streaming tool_call already tracked the edit. By
        // that point the existing tracked file already reflects the change,
        // so the old snippet is no longer present in currentText but the new
        // one is.
        const originalFile =
            "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\n";
        const afterEdit =
            "alpha\nbeta\ngamma\nepsilon\nzeta\neta\n";
        const existing = createTrackedFile({
            path: "foo.ts",
            oldText: originalFile,
            newText: afterEdit,
            currentText: afterEdit,
            diffBase: originalFile,
        });
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        // Structured-patch style hunk with context lines, as Claude emits.
        const hunkOld = "beta\ngamma\ndelta\nepsilon\nzeta\n";
        const hunkNew = "beta\ngamma\nepsilon\nzeta\n";

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: hunkOld,
                newText: hunkNew,
                } as never,
            existing,
            liveSession,
            "foo.ts",
            createClaudeEditUpdateContext(),
        );

        expect(resolved.oldText).toBe(originalFile);
        expect(resolved.newText).toBe(afterEdit);
    });

    it("treats Claude's single-line post-hook re-emission as a no-op", () => {
        const originalFile = "alpha\nbeta\ngamma\n";
        const afterEdit = "alpha\nBETA\ngamma\n";
        const existing = createTrackedFile({
            path: "foo.ts",
            oldText: originalFile,
            newText: afterEdit,
            currentText: afterEdit,
            diffBase: originalFile,
        });
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "beta",
                newText: "BETA",
            } as never,
            existing,
            liveSession,
            "foo.ts",
            createClaudeEditUpdateContext(),
        );

        expect(resolved.oldText).toBe(originalFile);
        expect(resolved.newText).toBe(afterEdit);
    });

    it("does not collapse unmatched diffs when the toolCallId does not match", () => {
        const existing = createTrackedFile({
            path: "foo.ts",
            oldText: "alpha\nbeta\ngamma\n",
            newText: "alpha\nBETA\ngamma\n",
            currentText: "alpha\nBETA\ngamma\n",
            diffBase: "alpha\nbeta\ngamma\n",
            toolCallId: "tool-1",
        });
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "beta",
                newText: "BETA",
            } as never,
            existing,
            liveSession,
            "foo.ts",
            createClaudeEditUpdateContext("tool-2"),
        );

        expect(resolved.oldText).toBe("beta");
        expect(resolved.newText).toBe("BETA");
    });

    it("preserves the diff untouched for create (oldText null)", () => {
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "new-file.ts",
                oldText: null,
                newText: "hello\n",
            } as never,
            undefined,
            liveSession,
            "new-file.ts",
        );

        expect(resolved.oldText).toBeNull();
        expect(resolved.newText).toBe("hello\n");
    });
});
