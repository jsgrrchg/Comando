import { describe, expect, it } from "vitest";

import type { GitHistoryCommitSummary } from "@shared/ipc";

import nativeBranchDiff from "../../../../../fixtures/native-backend/git/branch.diff.json";
import {
    buildGitHistoryGraphRows,
    convertRevisionFilesToDiffFiles,
} from "./history-presentation";

function createCommit(
    overrides: Partial<GitHistoryCommitSummary> = {},
): GitHistoryCommitSummary {
    return {
        authorEmail: "jose@example.com",
        authorName: "Jose",
        authoredAt: "2026-04-14T21:50:00.000Z",
        body: "",
        parentShas: ["parent-1"],
        refs: [],
        sha: "commit-1",
        shortSha: "commit-",
        subject: "Commit 1",
        ...overrides,
    };
}

describe("buildGitHistoryGraphRows", () => {
    it("keeps filtered history rows isolated", () => {
        const rows = buildGitHistoryGraphRows(
            [
                createCommit({
                    parentShas: ["missing-parent-1"],
                    sha: "commit-1",
                    subject: "Commit 1",
                }),
                createCommit({
                    parentShas: ["missing-parent-2"],
                    sha: "commit-2",
                    subject: "Commit 2",
                }),
            ],
            { connectHistory: false },
        );

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.laneIndex)).toEqual([0, 0]);
        expect(rows.map((row) => row.colorId)).toEqual([0, 1]);
        expect(rows.map((row) => row.parentColumns)).toEqual([[], []]);
        expect(rows.map((row) => row.bottomLanes)).toEqual([[], []]);
    });

    it("builds explicit lines for merge branches and keeps shared parents leftmost", () => {
        const rows = buildGitHistoryGraphRows([
            createCommit({
                parentShas: ["branch-a", "branch-b"],
                sha: "merge",
                subject: "Merge branch",
            }),
            createCommit({
                parentShas: ["base"],
                sha: "branch-a",
                subject: "Branch A",
            }),
            createCommit({
                parentShas: ["base"],
                sha: "branch-b",
                subject: "Branch B",
            }),
            createCommit({
                parentShas: [],
                sha: "base",
                subject: "Base",
            }),
        ]);

        expect(rows.map((row) => row.laneIndex)).toEqual([0, 0, 1, 0]);

        const lines = rows[0]?.graphLines ?? [];
        expect(
            lines.map((line) => [line.childSha, line.parentSha]),
        ).toEqual([
            ["merge", "branch-a"],
            ["merge", "branch-b"],
            ["branch-a", "base"],
            ["branch-b", "base"],
        ]);
        expect(lines[1]?.segments[0]).toMatchObject({
            curveKind: "merge",
            kind: "curve",
            onRow: 1,
            toColumn: 1,
        });
        expect(lines[3]?.segments.at(-1)).toMatchObject({
            curveKind: "checkout",
            kind: "curve",
            onRow: 3,
            toColumn: 0,
        });
    });

    it("keeps a drawable open line when the parent is outside the loaded history", () => {
        const rows = buildGitHistoryGraphRows([
            createCommit({
                parentShas: ["commit-2"],
                sha: "commit-1",
                subject: "Commit 1",
            }),
            createCommit({
                parentShas: ["commit-3"],
                sha: "commit-2",
                subject: "Commit 2",
            }),
        ]);

        const lines = rows[0]?.graphLines ?? [];
        expect(lines.map((line) => [line.childSha, line.parentSha])).toEqual([
            ["commit-1", "commit-2"],
            ["commit-2", "commit-3"],
        ]);
        expect(lines[1]?.segments.at(-1)).toEqual({
            kind: "straight",
            toRow: Number.MAX_SAFE_INTEGER,
        });
    });
});

describe("convertRevisionFilesToDiffFiles", () => {
    it("preserves a partial GitHub patch for the legacy diff fallback", () => {
        const nativeFile = nativeBranchDiff.files[0];
        const [file] = convertRevisionFilesToDiffFiles([
            {
                additions: nativeFile.additions,
                contentState: "unavailable",
                deletions: nativeFile.deletions,
                hunks: nativeFile.diff.hunks.map((hunk) => ({
                    id: hunk.id,
                    lines: hunk.lines.map((line) => ({
                        id: line.id,
                        text: line.text,
                        type:
                            line.type === "add"
                                ? "add"
                                : line.type === "remove"
                                  ? "remove"
                                  : "context",
                    })),
                    newCount: hunk.newCount,
                    newStart: hunk.newStart,
                    oldCount: hunk.oldCount,
                    oldStart: hunk.oldStart,
                })),
                isText: nativeFile.diff.isText,
                kind: "update",
                newText: nativeFile.diff.newText,
                oldText: nativeFile.diff.oldText,
                path: nativeFile.path,
                previousPath: nativeFile.previousPath,
                reversible: false,
                statusLabel: "modified",
            },
        ]);

        expect(file).toMatchObject({
            emptyState: "Diff content is unavailable from GitHub.",
            newText: null,
            oldText: null,
            path: nativeFile.path,
        });
        expect(file?.hunks[0]?.lines.map((line) => line.text)).toEqual([
            "old",
            "new",
        ]);
    });
});
