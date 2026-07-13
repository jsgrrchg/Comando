import { describe, expect, it } from "vitest";

import type {
    GitBranchSummary,
    GitHistoryCommitSummary,
} from "@shared/ipc";

import { buildGitScopeBranchTopology } from "./sidebarGitBranchTopology";

function createBranch(
    name: string,
    commitSha: string,
    isCurrent = false,
): GitBranchSummary {
    return {
        aheadBy: 0,
        behindBy: 0,
        commitSha,
        isCurrent,
        isDetached: false,
        isRemote: false,
        kind: "branch",
        name,
        upstreamName: null,
    };
}

function createCommit(sha: string): GitHistoryCommitSummary {
    return {
        authorEmail: "dev@example.com",
        authorName: "Dev",
        authoredAt: "2026-07-13T00:00:00.000Z",
        body: "",
        parentShas: [],
        refs: [],
        sha,
        shortSha: sha.slice(0, 7),
        subject: sha,
    };
}

describe("buildGitScopeBranchTopology", () => {
    it("orders local branches by their tips in date-ordered history", () => {
        const result = buildGitScopeBranchTopology(
            [
                createBranch("release", "commit-release"),
                createBranch("main", "commit-main", true),
                createBranch("feature", "commit-feature"),
            ],
            [
                createCommit("commit-feature"),
                createCommit("commit-main"),
                createCommit("commit-release"),
            ],
        );

        expect(result.orderedBranchNames).toEqual([
            "feature",
            "main",
            "release",
        ]);
        expect(result.byBranchName.get("feature")?.connected).toBe(true);
        expect(result.byBranchName.get("feature")?.historyIndex).toBe(0);
    });

    it("keeps refs sharing a tip adjacent and prefers the current branch", () => {
        const result = buildGitScopeBranchTopology(
            [
                createBranch("alias", "shared"),
                createBranch("main", "shared", true),
                createBranch("older", "older"),
            ],
            [createCommit("shared"), createCommit("older")],
        );

        expect(result.orderedBranchNames).toEqual(["main", "alias", "older"]);
        expect(result.byBranchName.get("main")?.historyIndex).toBe(
            result.byBranchName.get("alias")?.historyIndex,
        );
    });

    it("places refs outside the loaded history after connected refs", () => {
        const result = buildGitScopeBranchTopology(
            [
                createBranch("old", "missing"),
                createBranch("main", "visible", true),
            ],
            [createCommit("visible")],
        );

        expect(result.orderedBranchNames).toEqual(["main", "old"]);
        expect(result.byBranchName.get("old")?.connected).toBe(false);
        expect(result.byBranchName.get("old")?.historyIndex).toBeNull();
    });

    it("ignores remote refs in the local topology", () => {
        const remote = {
            ...createBranch("origin/main", "main"),
            isRemote: true,
            kind: "remote" as const,
        };
        const result = buildGitScopeBranchTopology(
            [remote, createBranch("main", "main", true)],
            [createCommit("main")],
        );

        expect(result.orderedBranchNames).toEqual(["main"]);
        expect(result.byBranchName.has("origin/main")).toBe(false);
    });
});
