import { describe, expect, it } from "vitest";

import type { GitHistoryCommitSummary } from "@shared/ipc";

import { buildGitHistoryGraphRows } from "./history-presentation";

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
});
