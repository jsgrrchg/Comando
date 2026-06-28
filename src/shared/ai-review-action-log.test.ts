import { describe, expect, it } from "vitest";

import type { AiFileDiff, AiTrackedFile } from "./ipc";
import type {
    AiReviewActionLogState,
    AiReviewDiffConsolidationContext,
} from "./ai-review-action-log";
import * as reviewActionLog from "./ai-review-action-log";

const {
    beginReviewWorkCycle,
    consolidateReviewDiffs,
    createEmptyReviewActionLog,
    createReviewActionLogFromTrackedFiles,
    deriveTrackedFilesFromActionLog,
    isReviewTargetVersionCurrent,
    keepReviewFile,
    keepReviewRanges,
    markReviewFileConflict,
    mergeReviewFilesFromMirror,
    rejectReviewFile,
    rejectReviewRanges,
    resolveReviewTarget,
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

describe("AiReviewActionLog single-store review state", () => {
    it("tracks a live diff as a pending file", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const file = deriveOnlyTrackedFile(state);
        expect(file).toMatchObject({
            currentText: "after\n",
            diffBase: "before\n",
            path: "src/app.ts",
            reviewState: "pending",
        });
        expect(file.hunks.length).toBeGreaterThan(0);
    });

    it("ignores non-live (historical) diffs", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext({ origin: "replay" }),
        );
        expect(deriveTrackedFilesFromActionLog(state)).toEqual([]);
    });

    it("tracks create, update, delete and move diffs", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    kind: "create",
                    oldText: null,
                    newText: "new\n",
                    path: "src/created.ts",
                }),
                createDiff({
                    kind: "delete",
                    oldText: "gone\n",
                    newText: null,
                    path: "src/deleted.ts",
                }),
                createDiff({
                    kind: "move",
                    oldText: "moved\n",
                    newText: "moved\n",
                    path: "src/new-name.ts",
                    previousPath: "src/old-name.ts",
                }),
            ],
            liveContext(),
        );
        const paths = deriveTrackedFilesFromActionLog(state)
            .map((file) => file.path)
            .sort();
        // A pure move with identical content is still visible (pending rename).
        expect(paths).toEqual([
            "src/created.ts",
            "src/deleted.ts",
            "src/new-name.ts",
        ]);
    });

    it("accumulates consecutive diffs for the same file into one entry", () => {
        let state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ oldText: "before\n", newText: "after\n" })],
            liveContext(),
        );
        state = consolidateReviewDiffs(
            state,
            [createDiff({ oldText: "before\n", newText: "after\nmore\n" })],
            liveContext({ toolCallId: "tool-2" }),
        );
        const file = deriveOnlyTrackedFile(state);
        expect(file.currentText).toBe("after\nmore\n");
        expect(file.diffBase).toBe("before\n");
    });

    it("consolidates by explicit identity key before path fallback", () => {
        let state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiffWithIdentity("review:custom", { newText: "after\n" })],
            liveContext(),
        );
        state = consolidateReviewDiffs(
            state,
            [createDiffWithIdentity("review:custom", { newText: "after2\n" })],
            liveContext({ toolCallId: "tool-2" }),
        );
        const file = deriveOnlyTrackedFile(state);
        expect(file.identityKey).toBe("review:custom");
        expect(file.currentText).toBe("after2\n");
    });

    it("hides a file when a later diff returns it to the baseline", () => {
        let state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ oldText: "before\n", newText: "after\n" })],
            liveContext(),
        );
        state = consolidateReviewDiffs(
            state,
            [createDiff({ oldText: "before\n", newText: "before\n" })],
            liveContext({ toolCallId: "tool-2" }),
        );
        expect(deriveTrackedFilesFromActionLog(state)).toEqual([]);
    });

    it("starts a new work cycle without clearing unresolved files", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const nextCycle = beginReviewWorkCycle(firstTurn, "cycle-2");
        expect(nextCycle.activeWorkCycleId).toBe("cycle-2");
        expect(deriveTrackedFilesFromActionLog(nextCycle)).toHaveLength(1);
    });
});

describe("AiReviewActionLog accept/reject never re-proposes resolved work", () => {
    it("drops an accepted file re-emitted whole on a later turn", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext(),
        );
        const accepted = keepReviewFile(
            firstTurn,
            reviewTarget(deriveOnlyTrackedFile(firstTurn)),
        );
        // Accepting settles the file: it leaves the visible set but is retained
        // (hidden) as the baseline for later reconciliation.
        expect(deriveTrackedFilesFromActionLog(accepted)).toEqual([]);

        // The runtime re-emits the whole file against its session-start
        // baseline. The accepted change must not come back as pending.
        const laterTurn = consolidateReviewDiffs(
            accepted,
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        expect(deriveTrackedFilesFromActionLog(laterTurn)).toEqual([]);
    });

    it("shows only new work when an accepted file changes again", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext(),
        );
        const accepted = keepReviewFile(
            firstTurn,
            reviewTarget(deriveOnlyTrackedFile(firstTurn)),
        );

        // A later turn adds a genuinely new line on top of the accepted text.
        const laterTurn = consolidateReviewDiffs(
            accepted,
            [createDiff({ newText: "after\nmore\n", oldText: "before\n" })],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        const file = deriveOnlyTrackedFile(laterTurn);
        expect(file.diffBase).toBe("after\n");
        expect(file.currentText).toBe("after\nmore\n");
    });

    it("shows later edits to an accepted create as updates", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    kind: "create",
                    newText: "created\n",
                    oldText: null,
                    path: "src/created.ts",
                }),
            ],
            liveContext(),
        );
        const created = deriveOnlyTrackedFile(firstTurn);
        expect(created.kind).toBe("create");

        const accepted = keepReviewFile(firstTurn, reviewTarget(created));
        const retained =
            accepted.trackedFilesByIdentityKey[created.identityKey];
        expect(retained).toMatchObject({
            currentText: "created\n",
            diffBase: "created\n",
            kind: "update",
            newText: "created\n",
            oldText: "created\n",
        });
        expect(deriveTrackedFilesFromActionLog(accepted)).toEqual([]);

        const laterTurn = consolidateReviewDiffs(
            accepted,
            [
                createDiff({
                    kind: "create",
                    newText: "created\nedited\n",
                    oldText: null,
                    path: "src/created.ts",
                }),
            ],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        const file = deriveOnlyTrackedFile(laterTurn);
        expect(file).toMatchObject({
            currentText: "created\nedited\n",
            diffBase: "created\n",
            kind: "update",
            newText: "created\nedited\n",
            oldText: "created\n",
        });
    });

    it("keeps later work after a rejected create as a create", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createDiff({
                    kind: "create",
                    newText: "created\n",
                    oldText: null,
                    path: "src/created.ts",
                }),
            ],
            liveContext(),
        );
        const created = deriveOnlyTrackedFile(firstTurn);

        const rejected = rejectReviewFile(firstTurn, reviewTarget(created));
        const retained =
            rejected.trackedFilesByIdentityKey[created.identityKey];
        expect(retained).toMatchObject({
            currentText: "",
            diffBase: "",
            kind: "create",
            newText: null,
            oldText: null,
        });
        expect(deriveTrackedFilesFromActionLog(rejected)).toEqual([]);

        const laterTurn = consolidateReviewDiffs(
            rejected,
            [
                createDiff({
                    kind: "create",
                    newText: "created again\n",
                    oldText: null,
                    path: "src/created.ts",
                }),
            ],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        const file = deriveOnlyTrackedFile(laterTurn);
        expect(file).toMatchObject({
            currentText: "created again\n",
            diffBase: "",
            kind: "create",
            newText: "created again\n",
            oldText: null,
        });
    });

    it("hides a rejected file and stays hidden once reverted on disk", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext(),
        );
        const rejected = rejectReviewFile(
            firstTurn,
            reviewTarget(deriveOnlyTrackedFile(firstTurn)),
        );
        expect(deriveTrackedFilesFromActionLog(rejected)).toEqual([]);

        // Reject reverts the file to its base on disk; the runtime's next read
        // sees that reverted content, so a re-emission carries no change.
        const laterTurn = consolidateReviewDiffs(
            rejected,
            [createDiff({ newText: "before\n", oldText: "before\n" })],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        expect(deriveTrackedFilesFromActionLog(laterTurn)).toEqual([]);
    });

    it("does not recreate a kept file when historical tool diffs replay", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const accepted = keepReviewFile(
            firstTurn,
            reviewTarget(deriveOnlyTrackedFile(firstTurn)),
        );
        const replay = consolidateReviewDiffs(accepted, [createDiff()], {
            ...liveContext(),
            origin: "replay",
        });
        expect(deriveTrackedFilesFromActionLog(replay)).toEqual([]);
    });
});

describe("AiReviewActionLog per-hunk keep/reject", () => {
    const multiHunkDiff = createDiff({
        oldText: "one\ntwo\nthree\nfour\n",
        newText: "ONE\ntwo\nTHREE\nfour\n",
    });

    it("keeps a hunk and leaves the remaining change pending", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [multiHunkDiff],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);
        expect(trackedFile.hunks.length).toBe(2);
        const [firstHunk] = trackedFile.hunks;

        const next = keepReviewRanges(state, reviewTarget(trackedFile), [
            firstHunk?.id ?? "",
        ]);
        const pending = deriveOnlyTrackedFile(next);
        // The accepted hunk folded into the base; only the other change remains.
        expect(pending.diffBase).toBe("ONE\ntwo\nthree\nfour\n");
        expect(pending.currentText).toBe("ONE\ntwo\nTHREE\nfour\n");
        expect(pending.hunks.length).toBe(1);
    });

    it("rejects a hunk and reverts only that change", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [multiHunkDiff],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);
        const [firstHunk] = trackedFile.hunks;

        const next = rejectReviewRanges(state, reviewTarget(trackedFile), [
            firstHunk?.id ?? "",
        ]);
        const pending = deriveOnlyTrackedFile(next);
        expect(pending.diffBase).toBe("one\ntwo\nthree\nfour\n");
        expect(pending.currentText).toBe("one\ntwo\nTHREE\nfour\n");
        expect(pending.hunks.length).toBe(1);
    });
});

describe("AiReviewActionLog target resolution", () => {
    it("rejects a stale expected version", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);
        const file = resolveReviewTarget(state, reviewTarget(trackedFile));
        expect(file).not.toBeNull();
        expect(
            isReviewTargetVersionCurrent(file!, { expectedVersion: 999 }),
        ).toBe(false);
    });

    it("rejects non-integer expected versions", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const file = deriveOnlyTrackedFile(state);
        expect(
            isReviewTargetVersionCurrent(file, { expectedVersion: 1.5 }),
        ).toBe(false);
    });

    it("does not fall back to path when an explicit tracked file id is stale", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);
        const resolved = resolveReviewTarget(state, {
            expectedVersion: trackedFile.version ?? 1,
            path: trackedFile.path,
            sessionId: SESSION_ID,
            trackedFileId: "review:session-1:does-not-exist",
        });
        expect(resolved).toBeNull();
    });

    it("marks a target as conflict and keeps it visible", () => {
        const state = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff()],
            liveContext(),
        );
        const trackedFile = deriveOnlyTrackedFile(state);
        const next = markReviewFileConflict(state, reviewTarget(trackedFile));
        const conflicted = deriveOnlyTrackedFile(next);
        expect(conflicted.reviewState).toBe("conflict");
        expect(conflicted.version).toBe((trackedFile.version ?? 1) + 1);
    });
});

describe("createReviewActionLogFromTrackedFiles", () => {
    it("bootstraps the log from existing tracked files", () => {
        const state = createReviewActionLogFromTrackedFiles(SESSION_ID, [
            createTrackedFile(),
        ]);
        const file = deriveOnlyTrackedFile(state);
        expect(file.path).toBe("src/app.ts");
        expect(file.currentText).toBe("after\n");
    });
});

describe("mergeReviewFilesFromMirror is additive only", () => {
    // The native turn-end reconcile must never resurrect work the user already
    // resolved. A runtime that re-emits the accepted file against its stale
    // session-start baseline shows up in the mirror as a "pending" change; the
    // merge must recognise the resolved log entry and ignore it.
    it("does not un-resolve an accepted file echoed back by the mirror", () => {
        const firstTurn = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext(),
        );
        const accepted = keepReviewFile(
            firstTurn,
            reviewTarget(deriveOnlyTrackedFile(firstTurn)),
        );
        expect(deriveTrackedFilesFromActionLog(accepted)).toEqual([]);

        const merged = mergeReviewFilesFromMirror(
            accepted,
            [
                createTrackedFile({
                    newText: "after\n",
                    oldText: "before\n",
                    version: 9,
                }),
            ],
            liveContext({ toolCallId: "tool-2", workCycleId: "cycle-2" }),
        );
        expect(deriveTrackedFilesFromActionLog(merged)).toEqual([]);
    });

    it("keeps the canonical pending entry and ignores a mirror echo", () => {
        const live = consolidateReviewDiffs(
            createEmptyReviewActionLog(SESSION_ID),
            [createDiff({ newText: "after\n", oldText: "before\n" })],
            liveContext(),
        );
        const livePending = deriveOnlyTrackedFile(live);

        const merged = mergeReviewFilesFromMirror(
            live,
            [
                createTrackedFile({
                    currentText: "mirror-recomputed\n",
                    newText: "mirror-recomputed\n",
                    oldText: "before\n",
                    version: 1,
                }),
            ],
            liveContext(),
        );

        const pending = deriveOnlyTrackedFile(merged);
        expect(pending.currentText).toBe(livePending.currentText);
        expect(pending.identityKey).toBe(livePending.identityKey);
    });

    it("adds a changed file the live path never captured", () => {
        const merged = mergeReviewFilesFromMirror(
            createEmptyReviewActionLog(SESSION_ID),
            [
                createTrackedFile({
                    currentText: "added\n",
                    diffBase: "",
                    kind: "create",
                    newText: "added\n",
                    oldText: null,
                    path: "src/new.ts",
                }),
            ],
            liveContext(),
        );

        const pending = deriveOnlyTrackedFile(merged);
        expect(pending.path).toBe("src/new.ts");
        expect(pending.currentText).toBe("added\n");
    });
});
