import { describe, expect, it } from "vitest";

import type {
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
} from "@shared/ipc";

import {
    countCurrentBranchPullRequests,
    isPullRequestForCurrentBranch,
    sortPullRequestsForCurrentBranch,
} from "./current-branch-pr";

const repository: GitHubRepositoryRef = {
    host: "github.com",
    owner: "comando",
    repo: "app",
};

function createPullRequest(
    overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary {
    return {
        additions: null,
        author: null,
        base: {
            label: "comando:main",
            ref: "main",
            repository,
            sha: "base-sha",
        },
        changedFileCount: null,
        closedAt: null,
        commentCount: 0,
        commitCount: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        deletions: null,
        draft: false,
        head: {
            label: "comando:feature/github-api",
            ref: "feature/github-api",
            repository,
            sha: "head-sha",
        },
        id: 1,
        labels: [],
        mergedAt: null,
        nodeId: "node-1",
        number: 12,
        state: "open",
        title: "Add GitHub API integration",
        updatedAt: "2026-05-03T00:00:00.000Z",
        url: "https://github.com/comando/app/pull/12",
        ...overrides,
    };
}

describe("current branch pull request helpers", () => {
    it("matches open pull requests from the same repository and branch", () => {
        expect(
            isPullRequestForCurrentBranch(
                createPullRequest(),
                "feature/github-api",
                repository,
            ),
        ).toBe(true);
    });

    it("does not match forks or closed pull requests", () => {
        expect(
            isPullRequestForCurrentBranch(
                createPullRequest({
                    head: {
                        label: "fork:feature/github-api",
                        ref: "feature/github-api",
                        repository: {
                            host: "github.com",
                            owner: "fork",
                            repo: "app",
                        },
                        sha: "fork-sha",
                    },
                }),
                "feature/github-api",
                repository,
            ),
        ).toBe(false);

        expect(
            isPullRequestForCurrentBranch(
                createPullRequest({ state: "closed" }),
                "feature/github-api",
                repository,
            ),
        ).toBe(false);
    });

    it("sorts current branch pull requests first", () => {
        const current = createPullRequest({ number: 1 });
        const other = createPullRequest({
            head: {
                label: "comando:feature/other",
                ref: "feature/other",
                repository,
                sha: "other-sha",
            },
            number: 2,
            updatedAt: "2026-05-06T00:00:00.000Z",
        });

        expect(
            sortPullRequestsForCurrentBranch(
                [other, current],
                "feature/github-api",
                repository,
            ).map((pullRequest) => pullRequest.number),
        ).toEqual([1, 2]);
    });

    it("counts current branch pull requests", () => {
        expect(
            countCurrentBranchPullRequests(
                [
                    createPullRequest({ number: 1 }),
                    createPullRequest({ number: 2, state: "closed" }),
                ],
                "feature/github-api",
                repository,
            ),
        ).toBe(1);
    });
});
