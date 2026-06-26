import { describe, expect, it } from "vitest";

import type { AiFileDiff, AiTrackedFile } from "./ipc";

// @ts-expect-error The canonical review action log lands after this red contract.
import * as reviewActionLog from "./ai-review-action-log";

const {
    consolidateReviewDiffs,
    createEmptyReviewActionLog,
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

function liveContext(overrides: Record<string, unknown> = {}) {
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

function deriveOnlyTrackedFile(state: unknown): AiTrackedFile {
    const trackedFiles = deriveTrackedFilesFromActionLog(
        state,
    ) as readonly AiTrackedFile[];
    expect(trackedFiles).toHaveLength(1);
    const [trackedFile] = trackedFiles;
    if (!trackedFile) {
        throw new Error("Expected one tracked file.");
    }
    return trackedFile;
}

describe("AiReviewActionLog canonical review state", () => {
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
});
