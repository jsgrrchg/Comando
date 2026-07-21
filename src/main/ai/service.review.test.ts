import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiReviewDeltaSummary, AiTrackedFile } from "@shared/ipc";

import {
    forgetOpenFileBuffer,
    recordOpenFileBuffer,
} from "./openFileBuffers";
import {
    mapImageGenerationToolUpdate,
    reconcilePendingTrackedFiles,
} from "./review-core";
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

function createSnapshot(): import("@shared/ipc").AiSessionSnapshot {
    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: null,
        runtimeId: "claude",
        runtimeSessionId: null,
        sessionId: "session-1",
        status: "idle",
        title: "Test",
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: "2026-04-20T12:00:00.000Z",
        worktreeId: null,
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
    it("supersedes only overlapping paths from a native review delta", () => {
        const firstDelta: AiReviewDeltaSummary = {
            deltaId: "delta-1",
            files: ["a.ts", "b.ts"].map((path) => ({
                path,
                state: "ready" as const,
            })),
            inputRevision: 1,
            revision: 1,
            sessionId: "session-1",
            state: "ready",
            toolCallId: "tool-1",
            updatedAt: "2026-04-14T12:00:00.000Z",
            workCycleId: "cycle-1",
        };
        const nextDelta: AiReviewDeltaSummary = {
            ...firstDelta,
            deltaId: "delta-2",
            files: [{ path: "a.ts", state: "ready" }],
            inputRevision: 2,
            revision: 2,
            toolCallId: "tool-2",
        };
        const snapshot = {
            ...createSnapshot(),
            reviewDeltas: [firstDelta],
            trackedFiles: ["a.ts", "b.ts"].map((path) =>
                createTrackedFile({
                    identityKey: `native-review:${path}`,
                    nativeReviewDeltaId: firstDelta.deltaId,
                    path,
                    version: firstDelta.revision,
                }),
            ),
        };

        const updated = __testing.applyNativeReviewDeltaSnapshot(
            snapshot,
            nextDelta,
        );

        expect(updated.reviewDeltas).toEqual([
            expect.objectContaining({
                deltaId: firstDelta.deltaId,
                files: [{ path: "b.ts", state: "ready" }],
            }),
            expect.objectContaining({
                deltaId: nextDelta.deltaId,
                files: [{ path: "a.ts", state: "ready" }],
            }),
        ]);
        expect(
            updated.trackedFiles.map((file) => [
                file.path,
                file.nativeReviewDeltaId,
            ]),
        ).toEqual([
            ["b.ts", firstDelta.deltaId],
            ["a.ts", nextDelta.deltaId],
        ]);
    });

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
                        codexAcpPreviousPath:
                            "/workspace/comando/src/previous.ts",
                    },
                    newText: "export const value = 2;\n",
                    oldText: "export const value = 1;\n",
                    path: "/workspace/comando/src/app.ts",
                },
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

    it("normalizes Windows absolute diff paths with different root casing", () => {
        expect(
            __testing.normalizeTrackedDiffPath(
                {
                    cwd: "C:\\Repo",
                    projectRoot: "C:\\Repo",
                },
                "c:\\repo\\src\\app.ts",
                { platform: "win32" },
            ),
        ).toBe("src/app.ts");
    });

    it("recomputes text hunks instead of trusting external diff metadata", () => {
        const oldText = "alpha\nbeta\ngamma";
        const newText = "alpha\nBETA\ngamma";

        expect(
            __testing.diffToAiFileDiff(
                {
                    _meta: {
                        codexAcpHunks: [
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
                },
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
                        codexAcpEventType: "status",
                    },
                    toolCallId: "codex-acp:status:item:msg-1",
                },
                "Preparing input",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        codexAcpEventType: "status",
                    },
                    toolCallId: "codex-acp:status:item:msg-2",
                },
                "Drafting response",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        codexAcpEventType: "status",
                    },
                    toolCallId: "codex-acp:status:item:msg-3",
                },
                "Reasoning",
            ),
        ).toBe(true);
    });

    it("suppresses the tool_call_update completion that codex-acp emits without meta", () => {
        // codex-acp omits meta on send_status_tool_call_update, which caused
        // the "Drafting response" activity to reappear on turn completion.
        // The stable toolCallId prefix lets us suppress it anyway.
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "codex-acp:status:item:agent-msg-42",
                },
                "Drafting response",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "codex-acp:status:item:user-msg-7",
                },
                "Preparing input",
            ),
        ).toBe(true);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "codex-acp:status:item:reasoning-msg-9",
                },
                "Reasoning",
            ),
        ).toBe(true);
    });

    it("keeps turn-started status tool calls so they render as dividers", () => {
        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: {
                        codexAcpEventType: "status",
                    },
                    toolCallId: "codex-acp:status:turn:turn-1",
                },
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
                },
                "Drafting response",
            ),
        ).toBe(false);

        expect(
            __testing.shouldSuppressToolActivityUpdate(
                {
                    _meta: null,
                    toolCallId: "normal-reasoning-tool-id",
                },
                "Reasoning",
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
            },
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
            },
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
            },
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
            },
            undefined,
            liveSession,
            "missing.ts",
        );

        expect(resolved.oldText).toBe("orig");
        expect(resolved.newText).toBe("new");
    });

    it("uses a pre-edit snapshot when a snippet diff was already applied externally", () => {
        const originalContent = "alpha\nremove me\nomega\n";
        const nextContent = "alpha\nomega\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "remove me\n",
                newText: "",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                preEditSnapshot: originalContent,
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("reconstructs full texts when an anchored snippet was already applied", () => {
        const originalContent =
            "title\nbefore\nremove one\nremove two\nafter\nfooter\n";
        const nextContent = "title\nbefore\nafter\nfooter\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "before\nremove one\nremove two\nafter\n",
                newText: "before\nafter\n",
            },
            undefined,
            liveSession,
            "foo.ts",
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("reconstructs full texts for an already-applied pure deletion hunk", () => {
        const originalContent = "alpha\nbeta\ngamma\n";
        const nextContent = "alpha\ngamma\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                hunks: [
                    {
                        id: "foo.ts:2:2:0",
                        lines: [],
                        newCount: 0,
                        newStart: 2,
                        oldCount: 1,
                        oldStart: 2,
                    },
                ],
                path: "foo.ts",
                oldText: "beta",
                newText: "",
            },
            undefined,
            liveSession,
            "foo.ts",
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("uses OpenCode filediff patches when a snippet diff was already applied externally", () => {
        const originalContent = "alpha\nbeta\nremove me\nomega\n";
        const nextContent = "alpha\nbeta\nomega\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "remove me\n",
                newText: "",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                rawOutput: {
                    metadata: {
                        filediff: {
                            file: absolutePath,
                            patch: [
                                `Index: ${absolutePath}`,
                                "===================================================================",
                                `--- ${absolutePath}`,
                                `+++ ${absolutePath}`,
                                "@@ -1,4 +1,3 @@",
                                " alpha",
                                " beta",
                                "-remove me",
                                " omega",
                                "",
                            ].join("\n"),
                        },
                    },
                },
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("uses OpenCode filediff patches for already-applied insertions that keep the old snippet", () => {
        const originalContent = "alpha\nanchor\nomega\n";
        const nextContent = "alpha\nanchor\ninserted\nomega\n";
        const duplicatedContent = "alpha\nanchor\ninserted\ninserted\nomega\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "anchor\n",
                newText: "anchor\ninserted\n",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                rawOutput: {
                    metadata: {
                        filediff: {
                            file: absolutePath,
                            patch: [
                                `Index: ${absolutePath}`,
                                "===================================================================",
                                `--- ${absolutePath}`,
                                `+++ ${absolutePath}`,
                                "@@ -1,3 +1,4 @@",
                                " alpha",
                                " anchor",
                                "+inserted",
                                " omega",
                                "",
                            ].join("\n"),
                        },
                    },
                },
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
        expect(resolved.newText).not.toBe(duplicatedContent);
    });

    it("uses pre-edit snapshots for already-applied insertions that keep the old snippet", () => {
        const originalContent = "alpha\nanchor\nomega\n";
        const nextContent = "alpha\nanchor\ninserted\nomega\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "anchor\n",
                newText: "anchor\ninserted\n",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                preEditSnapshot: originalContent,
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("preserves trailing newline changes from OpenCode filediff patches", () => {
        const originalContent = "alpha\nbeta\n";
        const nextContent = "alpha\nbeta";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "beta\n",
                newText: "beta",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                rawOutput: {
                    metadata: {
                        filediff: {
                            file: absolutePath,
                            patch: [
                                `Index: ${absolutePath}`,
                                "===================================================================",
                                `--- ${absolutePath}`,
                                `+++ ${absolutePath}`,
                                "@@ -1,2 +1,2 @@",
                                " alpha",
                                "-beta",
                                "+beta",
                                "\\ No newline at end of file",
                                "",
                            ].join("\n"),
                        },
                    },
                },
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe(originalContent);
        expect(resolved.newText).toBe(nextContent);
    });

    it("does not use an ambiguous pre-edit snapshot for external snippet diffs", () => {
        const originalContent = "alpha\nremove me\nomega\nremove me\nend\n";
        const nextContent = "alpha\nomega\nend\n";
        const absolutePath = path.join(tempDir, "foo.ts");
        fs.writeFileSync(absolutePath, nextContent, "utf8");
        const liveSession = { cwd: tempDir, projectRoot: tempDir };

        const resolved = __testing.resolveDiffToFullTexts(
            {
                path: "foo.ts",
                oldText: "remove me\n",
                newText: "",
            },
            undefined,
            liveSession,
            "foo.ts",
            {
                meta: null,
                preEditSnapshot: originalContent,
                sessionUpdate: "tool_call_update",
                toolCallId: "opencode-edit",
            },
        );

        expect(resolved.oldText).toBe("remove me\n");
        expect(resolved.newText).toBe("");
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
                },
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
                },
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
            },
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
            },
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
            },
            undefined,
            liveSession,
            "new-file.ts",
        );

        expect(resolved.oldText).toBeNull();
        expect(resolved.newText).toBe("hello\n");
    });
});

describe("tracked file reconciliation", () => {
    it("drops pending tracked files when only disk line endings differ", async () => {
        const baseText = "alpha\nbeta\ngamma\n";
        const trackedFile = createTrackedFile({
            currentText: "alpha\nBETA\ngamma\n",
            diffBase: baseText,
            hunks: __testing.computeDiffHunks(
                baseText,
                "alpha\nBETA\ngamma\n",
                "notes/example.md",
            ),
            newText: "alpha\nBETA\ngamma\n",
            oldText: baseText,
            path: "notes/example.md",
        });

        const result = await reconcilePendingTrackedFiles({
            readTrackedFileText: () =>
                Promise.resolve("alpha\r\nbeta\r\ngamma\r\n"),
            trackedFiles: [trackedFile],
        });

        expect(result).toMatchObject({
            changed: true,
            trackedFiles: [],
        });
    });

    it("drops pending tracked files when disk already matches the accepted text", async () => {
        const baseText = "alpha\nbeta\ngamma\n";
        const acceptedText = "alpha\nBETA\ngamma\n";
        const trackedFile = createTrackedFile({
            currentText: acceptedText,
            diffBase: baseText,
            hunks: __testing.computeDiffHunks(
                baseText,
                acceptedText,
                "notes/example.md",
            ),
            newText: acceptedText,
            oldText: baseText,
            path: "notes/example.md",
        });

        const result = await reconcilePendingTrackedFiles({
            readTrackedFileText: () => Promise.resolve(acceptedText),
            trackedFiles: [trackedFile],
        });

        expect(result).toMatchObject({
            changed: true,
            trackedFiles: [],
        });
    });

    it("drops pending delete files when disk already reflects the deletion", async () => {
        const trackedFile = createTrackedFile({
            currentText: "",
            diffBase: "removed\n",
            kind: "delete",
            newText: null,
            oldText: "removed\n",
            path: "notes/example.md",
        });

        const result = await reconcilePendingTrackedFiles({
            readTrackedFileText: () => Promise.resolve(null),
            trackedFiles: [trackedFile],
        });

        expect(result).toMatchObject({
            changed: true,
            trackedFiles: [],
        });
    });

    it("drops pending delete files when disk restored the base text", async () => {
        const trackedFile = createTrackedFile({
            currentText: "",
            diffBase: "removed\n",
            kind: "delete",
            newText: null,
            oldText: "removed\n",
            path: "notes/example.md",
        });

        const result = await reconcilePendingTrackedFiles({
            readTrackedFileText: () => Promise.resolve("removed\n"),
            trackedFiles: [trackedFile],
        });

        expect(result).toMatchObject({
            changed: true,
            trackedFiles: [],
        });
    });
});

describe("mapImageGenerationToolUpdate", () => {
    it("upserts Codex image generation updates as a single image message", () => {
        const started = mapImageGenerationToolUpdate(
            createSnapshot(),
            {
                _meta: {
                    codexAcpEventType: "image_generation",
                },
                kind: "other",
                rawInput: {
                    status: "in_progress",
                },
                status: "in_progress",
                title: "Generating image",
                toolCallId: "codex-acp:image:image-1",
            } as never,
            "2026-04-20T12:00:10.000Z",
        );

        expect(started.messages).toHaveLength(1);
        expect(started.messages[0]).toMatchObject({
            content: "Generating image...",
            id: "image:codex-acp:image:image-1",
            kind: "image",
            status: "streaming",
        });
        expect(started.messages[0]?.generatedImage).toMatchObject({
            path: null,
            status: "in_progress",
            title: "Generating image",
        });

        const completed = mapImageGenerationToolUpdate(
            started,
            {
                _meta: {
                    codexAcpEventType: "image_generation",
                },
                kind: "other",
                rawInput: {
                    path: "/Users/example/.codex/generated_images/image.png",
                    result: "created image",
                    revised_prompt: "A tiny brass robot",
                    status: "completed",
                },
                status: "completed",
                title: "Generated image",
                toolCallId: "codex-acp:image:image-1",
            } as never,
            "2026-04-20T12:00:11.000Z",
        );

        expect(completed.messages).toHaveLength(1);
        expect(completed.toolActivity).toHaveLength(0);
        expect(completed.messages[0]).toMatchObject({
            content: "Generated image",
            createdAt: "2026-04-20T12:00:10.000Z",
            id: "image:codex-acp:image:image-1",
            kind: "image",
            status: "completed",
        });
        expect(completed.messages[0]?.generatedImage).toMatchObject({
            mimeType: "image/png",
            path: "/Users/example/.codex/generated_images/image.png",
            result: "created image",
            revisedPrompt: "A tiny brass robot",
            status: "completed",
            title: "Generated image",
        });
    });

    it("maps failed image generation updates to completed error messages", () => {
        const snapshot = mapImageGenerationToolUpdate(
            createSnapshot(),
            {
                _meta: {
                    codexAcpEventType: "image_generation",
                },
                kind: "other",
                rawInput: {
                    error: "policy denied",
                    result: "policy denied",
                    status: "failed",
                },
                status: "failed",
                title: "Image generation failed",
                toolCallId: "codex-acp:image:image-2",
            } as never,
            "2026-04-20T12:00:12.000Z",
        );

        expect(snapshot.messages[0]).toMatchObject({
            content: "Image generation failed",
            kind: "image",
            status: "completed",
        });
        expect(snapshot.messages[0]?.generatedImage).toMatchObject({
            error: "policy denied",
            status: "failed",
            title: "Image generation failed",
        });
    });
});

describe("parseCompleteNumberedFileOutput", () => {
    function buildOpenCodeReadOutput(
        body: readonly string[],
        footer: string,
    ): string {
        return ["<content>", ...body, footer, "</content>"].join("\n");
    }

    it("parses a single-line file body with singular footer wording", () => {
        const output = buildOpenCodeReadOutput(
            ["1: only line"],
            "(End of file - total 1 line)",
        );

        expect(__testing.parseCompleteNumberedFileOutput(output)).toBe(
            "only line",
        );
    });

    it("accepts a rawOutput record whose `output` field carries the body", () => {
        const output = buildOpenCodeReadOutput(
            ["1: alpha", "2: beta"],
            "(End of file - total 2 lines)",
        );

        expect(
            __testing.parseCompleteNumberedFileOutput({ output }),
        ).toBe("alpha\nbeta");
    });

    it("returns null when the <content> wrapper tags are missing", () => {
        const output = [
            "1: alpha",
            "2: beta",
            "(End of file - total 2 lines)",
        ].join("\n");

        expect(__testing.parseCompleteNumberedFileOutput(output)).toBeNull();
    });

    it("returns null when the footer line count is missing", () => {
        const output = ["<content>", "1: alpha", "2: beta", "</content>"].join(
            "\n",
        );

        expect(__testing.parseCompleteNumberedFileOutput(output)).toBeNull();
    });

    it("returns null when the declared line count does not match the body", () => {
        const output = buildOpenCodeReadOutput(
            ["1: alpha", "2: beta"],
            "(End of file - total 5 lines)",
        );

        expect(__testing.parseCompleteNumberedFileOutput(output)).toBeNull();
    });

    it("returns null when the line numbering skips a value", () => {
        const output = buildOpenCodeReadOutput(
            ["1: alpha", "3: gamma"],
            "(End of file - total 2 lines)",
        );

        expect(__testing.parseCompleteNumberedFileOutput(output)).toBeNull();
    });
});
