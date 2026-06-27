import { describe, expect, it } from "vitest";

import type { AiFileDiff, AiTrackedFile } from "./ipc";
import type {
    AiReviewActionLogState,
    AiReviewDiffConsolidationContext,
} from "./ai-review-action-log";
import * as reviewActionLog from "./ai-review-action-log";

const {
    consolidateReviewDiffs,
    createEmptyReviewActionLog,
    createReviewActionLogFromTrackedFiles,
    deriveTrackedFilesFromActionLog,
    keepReviewFile,
    keepReviewRanges,
} = reviewActionLog;

const SESSION_ID = "session-1";

function createDiff(overrides: Partial<AiFileDiff> = {}): AiFileDiff {
    return {
        hunks: [],
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path: "src/app.ts",
        previousPath: null,
        reversible: true,
        ...overrides,
    };
}

function createDiffWithIdentity(
    identityKey: string,
    overrides: Partial<AiFileDiff> = {},
): AiFileDiff {
    return {
        ...createDiff(overrides),
        identityKey,
    } as AiFileDiff;
}

function liveContext(
    overrides: Partial<AiReviewDiffConsolidationContext> = {},
): AiReviewDiffConsolidationContext {
    return {
        origin: "live",
        sessionId: SESSION_ID,
        toolCallId: "tool-1",
        updatedAt: "2026-06-26T00:00:00.000Z",
        workCycleId: "cycle-1",
        ...overrides,
    };
}

function reviewTarget(trackedFile: AiTrackedFile) {
    return {
        expectedVersion: trackedFile.version ?? 1,
        path: trackedFile.path,
        sessionId: trackedFile.sessionId,
        trackedFileId: trackedFile.identityKey,
    };
}

function deriveOnlyTrackedFile(state: AiReviewActionLogState): AiTrackedFile {
    const trackedFiles = deriveTrackedFilesFromActionLog(state);
    expect(trackedFiles).toHaveLength(1);
    const [trackedFile] = trackedFiles;
    if (!trackedFile) {
        throw new Error("Expected one tracked file.");
    }
    return trackedFile;
}

function createTrackedFile(
    overrides: Partial<AiTrackedFile> = {},
): AiTrackedFile {
    const path = overrides.path ?? "src/app.ts";
    return {
        currentText: "after\n",
        diffBase: "before\n",
        hunks: [],
        identityKey: `native:${SESSION_ID}:${path}`,
        isText: true,
        kind: "update",
        newText: "after\n",
        oldText: "before\n",
        path,
        previousPath: null,
        reviewState: "pending",
        reversible: true,
        sessionId: SESSION_ID,
        toolCallId: "tool-1",
        updatedAt: "2026-06-26T00:00:00.000Z",
        version: 4,
        ...overrides,
    };
}

describe("AiReviewActionLog canonical review state", () => {
    it("migrates unresolved legacy tracked files into canonical state", () => {
        const pendingFile = createTrackedFile({
            path: "src/pending.ts",
        });
        const keptFile = createTrackedFile({
            identityKey: `native:${SESSION_ID}:src/kept.ts`,
            path: "src/kept.ts",
            reviewState: "kept",
        });
        const wrongSessionFile = createTrackedFile({
            identityKey: "native:other:src/app.ts",
            sessionId: "other-session",
        });
        const binaryFile = createTrackedFile({
            identityKey: `native:${SESSION_ID}:assets/image.png`,
            isText: false,
            path: "assets/image.png",
        });

        const state = createReviewActionLogFromTrackedFiles(
            SESSION_ID,
            [pendingFile, keptFile, wrongSessionFile, binaryFile],
            { updatedAt: "2026-06-26T00:01:00.000Z" },
        );

        expect(state.fileOrder).toEqual([pendingFile.identityKey]);
        expect(state.versionClockByIdentityKey).toEqual({
            [pendingFile.identityKey]: 4,
        });
        expect(deriveTrackedFilesFromActionLog(state)).toEqual([
            expect.objectContaining({
                identityKey: pendingFile.identityKey,
                path: "src/pending.ts",
                reviewState: "pending",
                version: 4,
            }),
        ]);
    });

    it("tracks create, update, delete, and move diffs as pending files", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    kind: "create",
                    newText: "created\n",
                    oldText: null,
                    path: "src/created.ts",
                }),
                createDiff({
                    kind: "update",
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/updated.ts",
                }),
                createDiff({
                    kind: "delete",
                    newText: null,
                    oldText: "deleted\n",
                    path: "src/deleted.ts",
                }),
                createDiff({
                    kind: "move",
                    newText: "same\n",
                    oldText: "same\n",
                    path: "src/new.ts",
                    previousPath: "src/old.ts",
                }),
            ],
            liveContext(),
        );

        expect(deriveTrackedFilesFromActionLog(state)).toEqual([
            expect.objectContaining({
                identityKey: `review:${SESSION_ID}:src/created.ts`,
                kind: "create",
                newText: "created\n",
                oldText: null,
                path: "src/created.ts",
                reviewState: "pending",
            }),
            expect.objectContaining({
                identityKey: `review:${SESSION_ID}:src/updated.ts`,
                kind: "update",
                newText: "after\n",
                oldText: "before\n",
                path: "src/updated.ts",
                reviewState: "pending",
            }),
            expect.objectContaining({
                identityKey: `review:${SESSION_ID}:src/deleted.ts`,
                kind: "delete",
                newText: null,
                oldText: "deleted\n",
                path: "src/deleted.ts",
                reviewState: "pending",
            }),
            expect.objectContaining({
                identityKey: `review:${SESSION_ID}:src/old.ts->src/new.ts`,
                kind: "move",
                path: "src/new.ts",
                previousPath: "src/old.ts",
                reviewState: "pending",
            }),
        ]);
    });

    it("accumulates consecutive diffs for the same file", () => {
        const firstState = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    newText: "one\nTWO\nthree\nfour\n",
                    oldText: "one\ntwo\nthree\nfour\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const secondState = consolidateReviewDiffs(
            firstState,
            [
                createDiff({
                    newText: "FOUR",
                    oldText: "four",
                    path: "src/app.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:01:00.000Z",
            }),
        );
        const trackedFile = deriveOnlyTrackedFile(secondState);

        expect(trackedFile).toMatchObject({
            currentText: "one\nTWO\nthree\nFOUR\n",
            diffBase: "one\ntwo\nthree\nfour\n",
            newText: "one\nTWO\nthree\nFOUR\n",
            oldText: "one\ntwo\nthree\nfour\n",
            path: "src/app.ts",
            version: 2,
        });
        expect(trackedFile.hunks).toHaveLength(2);
    });

    it("consolidates by explicit identity key before path fallback", () => {
        const identityKey = "native:session-1:src/app.ts";
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiffWithIdentity(identityKey, {
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const nextState = consolidateReviewDiffs(
            state,
            [
                createDiffWithIdentity(identityKey, {
                    newText: "AFTER\n",
                    oldText: "after\n",
                    path: "src/renamed.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:02:00.000Z",
            }),
        );
        const trackedFile = deriveOnlyTrackedFile(nextState);

        expect(trackedFile).toMatchObject({
            identityKey,
            path: "src/renamed.ts",
            version: 2,
        });
    });

    it("does not merge an explicit missing diff identity through path fallback", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiffWithIdentity("native:session-1:src/app.ts:1", {
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const nextState = consolidateReviewDiffs(
            state,
            [
                createDiffWithIdentity("native:session-1:src/app.ts:2", {
                    newText: "next\n",
                    oldText: "after\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:02:30.000Z",
            }),
        );

        expect(
            deriveTrackedFilesFromActionLog(nextState).map((trackedFile) => ({
                identityKey: trackedFile.identityKey,
                newText: trackedFile.newText,
                oldText: trackedFile.oldText,
                version: trackedFile.version,
            })),
        ).toEqual([
            {
                identityKey: "native:session-1:src/app.ts:1",
                newText: "after\n",
                oldText: "before\n",
                version: 1,
            },
            {
                identityKey: "native:session-1:src/app.ts:2",
                newText: "next\n",
                oldText: "after\n",
                version: 1,
            },
        ]);
    });

    it("updates an explicit existing diff identity without merging by shared path", () => {
        const firstState = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiffWithIdentity("native:session-1:src/app.ts:1", {
                    newText: "after one\n",
                    oldText: "before one\n",
                    path: "src/app.ts",
                }),
                createDiffWithIdentity("native:session-1:src/app.ts:2", {
                    newText: "after two\n",
                    oldText: "before two\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const nextState = consolidateReviewDiffs(
            firstState,
            [
                createDiffWithIdentity("native:session-1:src/app.ts:2", {
                    newText: "after two\nand more\n",
                    oldText: "after two\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:02:45.000Z",
            }),
        );

        expect(
            deriveTrackedFilesFromActionLog(nextState).map((trackedFile) => ({
                identityKey: trackedFile.identityKey,
                newText: trackedFile.newText,
                oldText: trackedFile.oldText,
                version: trackedFile.version,
            })),
        ).toEqual([
            {
                identityKey: "native:session-1:src/app.ts:1",
                newText: "after one\n",
                oldText: "before one\n",
                version: 1,
            },
            {
                identityKey: "native:session-1:src/app.ts:2",
                newText: "after two\nand more\n",
                oldText: "before two\n",
                version: 2,
            },
        ]);
    });

    it("removes a pending file when a later diff returns it to the baseline", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    newText: "after\n",
                    oldText: "before\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const cleanState = consolidateReviewDiffs(
            state,
            [
                createDiff({
                    newText: "before\n",
                    oldText: "after\n",
                    path: "src/app.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:03:00.000Z",
            }),
        );

        expect(deriveTrackedFilesFromActionLog(cleanState)).toEqual([]);
    });

    it("removes a file from the canonical state when it is kept", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        const keptState = keepReviewFile(state, reviewTarget(trackedFile));

        expect(keptState.filesByIdentityKey).toEqual({});
        expect(keptState.fileOrder).toEqual([]);
        expect(deriveTrackedFilesFromActionLog(keptState)).toEqual([]);
    });

    it("does not recreate a kept file when historical tool diffs replay", () => {
        const diff = createDiff({
            newText: "export const value = 2;\n",
            oldText: "export const value = 1;\n",
            path: "src/app.ts",
        });
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [diff],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        expect(trackedFile).toMatchObject({
            newText: "export const value = 2;\n",
            oldText: "export const value = 1;\n",
            path: "src/app.ts",
            reviewState: "pending",
        });

        const keptState = keepReviewFile(state, reviewTarget(trackedFile));
        const replayedState = consolidateReviewDiffs(
            keptState,
            [diff],
            liveContext({
                origin: "replay",
                toolCallId: "tool-replayed",
                updatedAt: "2026-06-26T00:01:00.000Z",
            }),
        );

        expect(deriveTrackedFilesFromActionLog(replayedState)).toEqual([]);
    });

    it("rebases kept ranges and leaves only the unaccepted span pending", () => {
        const originalText = "one\ntwo\nthree\nfour\n";
        const editedText = "ONE\ntwo\nTHREE\nfour\n";
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    newText: editedText,
                    oldText: originalText,
                    path: "src/app.ts",
                }),
            ],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        expect(trackedFile.hunks).toHaveLength(2);
        const firstHunk = trackedFile.hunks[0];
        if (!firstHunk) {
            throw new Error("Expected the first pending hunk.");
        }

        const afterFirstKeep = keepReviewRanges(
            state,
            reviewTarget(trackedFile),
            [firstHunk.id],
        );
        const remainingFile = deriveOnlyTrackedFile(afterFirstKeep);

        expect(remainingFile).toMatchObject({
            currentText: editedText,
            diffBase: "ONE\ntwo\nthree\nfour\n",
            path: "src/app.ts",
            reviewState: "pending",
        });
        expect(remainingFile.hunks).toHaveLength(1);
        expect(
            remainingFile.hunks.flatMap((hunk) =>
                hunk.lines
                    .filter((line) => line.type === "add")
                    .map((line) => line.text),
            ),
        ).toEqual(["THREE"]);

        const afterSecondTurn = consolidateReviewDiffs(
            afterFirstKeep,
            [
                createDiff({
                    newText: "ONE\ntwo\nTHREE!\nfour\n",
                    oldText: editedText,
                    path: "src/app.ts",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:02:00.000Z",
                workCycleId: "cycle-2",
            }),
        );
        const pendingFile = deriveOnlyTrackedFile(afterSecondTurn);

        expect(pendingFile).toMatchObject({
            currentText: "ONE\ntwo\nTHREE!\nfour\n",
            diffBase: "ONE\ntwo\nthree\nfour\n",
            path: "src/app.ts",
            reviewState: "pending",
        });
        expect(
            pendingFile.hunks.flatMap((hunk) =>
                hunk.lines
                    .filter((line) => line.type === "add")
                    .map((line) => line.text),
            ),
        ).toEqual(["THREE!"]);
    });

    it("rejects stale targets without mutating canonical pending state", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        expect(() =>
            keepReviewFile(state, {
                ...reviewTarget(trackedFile),
                expectedVersion: (trackedFile.version ?? 1) - 1,
            }),
        ).toThrow(/version|stale/i);
        expect(deriveTrackedFilesFromActionLog(state)).toEqual([trackedFile]);
    });

    it("does not fall back to path when an explicit tracked file id is stale", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        const nextState = keepReviewFile(state, {
            ...reviewTarget(trackedFile),
            trackedFileId: "review:session-1:missing.ts",
        });

        expect(deriveTrackedFilesFromActionLog(nextState)).toEqual([
            trackedFile,
        ]);
    });

    it("keeps versions monotonic when a kept identity receives new pending work", () => {
        const firstState = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const firstTrackedFile = deriveOnlyTrackedFile(firstState);
        const keptState = keepReviewFile(
            firstState,
            reviewTarget(firstTrackedFile),
        );

        const secondState = consolidateReviewDiffs(
            keptState,
            [
                createDiff({
                    newText: "new after\n",
                    oldText: "new before\n",
                }),
            ],
            liveContext({
                toolCallId: "tool-2",
                updatedAt: "2026-06-26T00:04:00.000Z",
            }),
        );
        const secondTrackedFile = deriveOnlyTrackedFile(secondState);

        expect(secondTrackedFile).toMatchObject({
            identityKey: firstTrackedFile.identityKey,
            version: 2,
        });
        expect(() =>
            keepReviewFile(secondState, {
                ...reviewTarget(firstTrackedFile),
                expectedVersion: firstTrackedFile.version,
            }),
        ).toThrow(/version|stale/i);
        expect(deriveTrackedFilesFromActionLog(secondState)).toEqual([
            secondTrackedFile,
        ]);
    });

    it("rejects non-integer expected versions", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);

        expect(() =>
            keepReviewFile(state, {
                ...reviewTarget(trackedFile),
                expectedVersion: 1.9,
            }),
        ).toThrow(/version|stale/i);
        expect(deriveTrackedFilesFromActionLog(state)).toEqual([trackedFile]);
    });
});
