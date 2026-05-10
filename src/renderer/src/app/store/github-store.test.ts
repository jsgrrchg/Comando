import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    GitHubCommentSummary,
    GitHubCreateIssueInput,
    GitHubIssueDetail,
    GitHubIssueSummary,
    GitHubMilestoneSummary,
    GitHubNotificationSummary,
    GitHubPullRequestChecksResult,
    GitHubPullRequestDetail,
    GitHubReleaseSummary,
    GitHubRequestPullRequestReviewInput,
    GitHubRepositoryRef,
    GitHubWorkflowJobSummary,
    GitHubWorkflowRunSummary,
} from "@shared/ipc";

import {
    getGitHubRepoKey,
    resetGitHubStoreForTests,
    useGitHubStore,
} from "./github-store";

const repository: GitHubRepositoryRef = {
    host: "github.com",
    owner: "octocat",
    repo: "hello-world",
};
const repoKey = getGitHubRepoKey(repository);

describe("github-store", () => {
    afterEach(() => {
        resetGitHubStoreForTests();
        vi.unstubAllGlobals();
    });

    it("refreshes and caches issues by repository", async () => {
        const issue = createIssueSummary({ number: 1, title: "Cached issue" });
        const listGitHubIssues = vi.fn().mockResolvedValue({
            issues: [issue],
            nextCursor: null,
            totalCount: null,
        });
        stubComando({ listGitHubIssues });

        const result = await useGitHubStore
            .getState()
            .refreshIssues(repository, { state: "open" });

        expect(result).toEqual([issue]);
        expect(listGitHubIssues).toHaveBeenCalledWith({
            repository,
            state: "open",
        });
        expect(useGitHubStore.getState().issuesByRepo[repoKey]).toEqual([
            issue,
        ]);
        expect(useGitHubStore.getState().issueListStateByRepo[repoKey]).toBe(
            "open",
        );
        expect(useGitHubStore.getState().loadingKeys[`${repoKey}:issues`]).toBe(
            false,
        );
    });

    it("tracks the cached list state for issues and pull requests", async () => {
        const issue = createIssueSummary({ number: 2, state: "closed" });
        const pullRequest = createPullRequestDetail({
            number: 3,
            state: "closed",
        });
        const listGitHubIssues = vi.fn().mockResolvedValue({
            issues: [issue],
            nextCursor: null,
            totalCount: null,
        });
        const listGitHubPullRequests = vi.fn().mockResolvedValue({
            nextCursor: null,
            pullRequests: [pullRequest],
            totalCount: null,
        });
        stubComando({ listGitHubIssues, listGitHubPullRequests });

        await useGitHubStore.getState().refreshIssues(repository, {
            state: "closed",
        });
        await useGitHubStore.getState().refreshPullRequests(repository, {
            state: "all",
        });

        const state = useGitHubStore.getState();
        expect(state.issueListStateByRepo[repoKey]).toBe("closed");
        expect(state.pullRequestListStateByRepo[repoKey]).toBe("all");
        expect(state.issuesByRepo[repoKey]).toEqual([issue]);
        expect(state.pullRequestsByRepo[repoKey]).toEqual([pullRequest]);
    });

    it("loads issue details once unless forced", async () => {
        const detail = createIssueDetail({ number: 7 });
        const getGitHubIssue = vi.fn().mockResolvedValue(detail);
        stubComando({ getGitHubIssue });

        const first = await useGitHubStore
            .getState()
            .ensureIssueDetail(repository, 7);
        const second = await useGitHubStore
            .getState()
            .ensureIssueDetail(repository, 7);

        expect(first).toBe(detail);
        expect(second).toBe(detail);
        expect(getGitHubIssue).toHaveBeenCalledTimes(1);
        expect(
            useGitHubStore.getState().issueDetailsByRepo[repoKey]?.[7],
        ).toBe(detail);
    });

    it("deduplicates issue creation and updates list and detail caches", async () => {
        const created = createIssueDetail({ number: 8, title: "New issue" });
        const createResolvers: Array<(value: GitHubIssueDetail) => void> = [];
        const createGitHubIssue = vi.fn<
            (input: GitHubCreateIssueInput) => Promise<GitHubIssueDetail>
        >(
            () =>
                new Promise<GitHubIssueDetail>((resolve) => {
                    createResolvers.push(resolve);
                }),
        );
        stubComando({ createGitHubIssue });

        const first = useGitHubStore.getState().createIssue(repository, {
            body: "Body",
            title: "New issue",
        });
        const second = useGitHubStore.getState().createIssue(repository, {
            body: "Body",
            title: "New issue",
        });
        createResolvers[0]?.(created);

        await expect(Promise.all([first, second])).resolves.toEqual([
            created,
            created,
        ]);
        expect(createGitHubIssue).toHaveBeenCalledTimes(1);
        const createInput = createGitHubIssue.mock.calls[0]?.[0];
        expect(createInput).toMatchObject({
            body: "Body",
            repository,
            title: "New issue",
        });
        expect(createInput?.clientRequestId).toEqual(
            expect.stringContaining(`${repoKey}:issue:create:`),
        );
        expect(useGitHubStore.getState().issuesByRepo[repoKey]?.[0]).toEqual(
            created,
        );
        expect(
            useGitHubStore.getState().issueDetailsByRepo[repoKey]?.[8],
        ).toBe(created);
        expect(
            useGitHubStore.getState().mutatingKeys[`${repoKey}:issue:create`],
        ).toBe(false);
    });

    it("keeps local drafts outside the store when a write mutation fails", async () => {
        const error = new Error("Resource not accessible by token");
        const createGitHubIssue = vi.fn().mockRejectedValue(error);
        stubComando({ createGitHubIssue });

        await expect(
            useGitHubStore.getState().createIssue(repository, {
                body: "Local draft remains in the caller",
                title: "Denied",
            }),
        ).rejects.toThrow("Resource not accessible by token");

        expect(useGitHubStore.getState().issuesByRepo[repoKey]).toBeUndefined();
        expect(useGitHubStore.getState().errors[`${repoKey}:issue:create`]).toBe(
            "Resource not accessible by token",
        );
    });

    it("appends comments to cached issue details and summaries", async () => {
        const issue = createIssueDetail({ commentCount: 1, number: 4 });
        const comment = createComment({ body: "Follow-up" });
        useGitHubStore.setState({
            issueDetailsByRepo: { [repoKey]: { 4: issue } },
            issuesByRepo: { [repoKey]: [issue] },
        });
        stubComando({
            commentGitHubIssue: vi.fn().mockResolvedValue(comment),
        });

        await useGitHubStore
            .getState()
            .commentIssue(repository, 4, "Follow-up");

        const state = useGitHubStore.getState();
        expect(state.issueDetailsByRepo[repoKey]?.[4]?.comments).toEqual([
            comment,
        ]);
        expect(state.issueDetailsByRepo[repoKey]?.[4]?.commentCount).toBe(2);
        expect(state.issuesByRepo[repoKey]?.[0]?.commentCount).toBe(2);
    });

    it("updates pull request caches from draft state mutations", async () => {
        const pullRequest = createPullRequestDetail({
            draft: false,
            number: 12,
        });
        const markGitHubPullRequestReady = vi.fn().mockResolvedValue(pullRequest);
        stubComando({ markGitHubPullRequestReady });

        const result = await useGitHubStore
            .getState()
            .markPullRequestReady(repository, 12);

        expect(result).toBe(pullRequest);
        expect(useGitHubStore.getState().pullRequestsByRepo[repoKey]).toEqual([
            pullRequest,
        ]);
        expect(
            useGitHubStore.getState().pullRequestDetailsByRepo[repoKey]?.[12],
        ).toBe(pullRequest);
    });

    it("refreshes pull request checks by head SHA", async () => {
        const checks = createPullRequestChecks({ headSha: "head123" });
        const listGitHubPullRequestChecks = vi.fn().mockResolvedValue(checks);
        stubComando({ listGitHubPullRequestChecks });

        const result = await useGitHubStore
            .getState()
            .refreshPullRequestChecks(repository, {
                headSha: "head123",
                pullRequestNumber: 12,
            });

        expect(result).toBe(checks);
        expect(listGitHubPullRequestChecks).toHaveBeenCalledWith({
            headSha: "head123",
            pullRequestNumber: 12,
            repository,
        });
        expect(
            useGitHubStore.getState().pullRequestChecksByRepo[repoKey]?.head123,
        ).toBe(checks);
        expect(
            useGitHubStore.getState().loadingKeys[
                `${repoKey}:pr-checks:head123`
            ],
        ).toBe(false);
    });

    it("requests pull request reviews and preserves drafts in the caller", async () => {
        const pullRequest = createPullRequestDetail({
            number: 12,
        });
        const requestGitHubPullRequestReviewers = vi.fn<
            (
                input: GitHubRequestPullRequestReviewInput,
            ) => Promise<GitHubPullRequestDetail>
        >().mockResolvedValue(pullRequest);
        stubComando({ requestGitHubPullRequestReviewers });

        const result = await useGitHubStore
            .getState()
            .requestPullRequestReviewers(repository, 12, {
                reviewers: ["monalisa"],
                teamReviewers: ["frontend"],
            });

        expect(result).toBe(pullRequest);
        const requestInput =
            requestGitHubPullRequestReviewers.mock.calls[0]?.[0];
        expect(requestInput).toMatchObject({
            number: 12,
            repository,
            reviewers: ["monalisa"],
            teamReviewers: ["frontend"],
        });
        expect(requestInput?.clientRequestId).toEqual(
            expect.stringContaining(`${repoKey}:pr:12:request-review:`),
        );
        expect(
            useGitHubStore.getState().pullRequestDetailsByRepo[repoKey]?.[12],
        ).toBe(pullRequest);
        expect(
            useGitHubStore.getState().mutatingKeys[
                `${repoKey}:pr:12:request-review`
            ],
        ).toBe(false);
    });

    it("loads workflow runs, jobs, and logs into Actions caches", async () => {
        const run = createWorkflowRun();
        const job = createWorkflowJob();
        const listGitHubWorkflowRuns = vi.fn().mockResolvedValue({
            nextCursor: null,
            runs: [run],
            totalCount: 1,
        });
        const listGitHubWorkflowRunJobs = vi.fn().mockResolvedValue({
            jobs: [job],
            nextCursor: null,
            runId: run.id,
            totalCount: 1,
        });
        const getGitHubWorkflowJobLogs = vi.fn().mockResolvedValue({
            jobId: job.id,
            logs: "job logs",
            truncated: false,
        });
        stubComando({
            getGitHubWorkflowJobLogs,
            listGitHubWorkflowRunJobs,
            listGitHubWorkflowRuns,
        });

        const runs = await useGitHubStore
            .getState()
            .refreshWorkflowRuns(repository, {
                branch: "feature",
                headSha: "head123",
            });
        const jobs = await useGitHubStore
            .getState()
            .refreshWorkflowRunJobs(repository, run.id);
        const logs = await useGitHubStore
            .getState()
            .refreshWorkflowJobLogs(repository, job.id);

        expect(runs).toEqual([run]);
        expect(jobs).toEqual([job]);
        expect(logs).toBe("job logs");
        expect(
            useGitHubStore.getState().workflowRunsByRepo[repoKey]?.head123,
        ).toEqual([run]);
        expect(
            useGitHubStore.getState().workflowRunJobsByRepo[repoKey]?.[run.id],
        ).toEqual([job]);
        expect(
            useGitHubStore.getState().workflowJobLogsByRepo[repoKey]?.[job.id],
        ).toBe("job logs");
    });

    it("loads coordination data into repo and host caches", async () => {
        const notification = createNotification();
        const release = createRelease({ draft: true });
        const milestone = createMilestone();
        stubComando({
            listGitHubMilestones: vi.fn().mockResolvedValue({
                milestones: [milestone],
                nextCursor: null,
                totalCount: null,
            }),
            listGitHubNotifications: vi.fn().mockResolvedValue({
                nextCursor: null,
                notifications: [notification],
                totalCount: null,
            }),
            listGitHubReleases: vi.fn().mockResolvedValue({
                nextCursor: null,
                releases: [release],
                totalCount: null,
            }),
        });

        const notifications = await useGitHubStore
            .getState()
            .refreshNotifications(repository);
        const releases = await useGitHubStore
            .getState()
            .refreshReleases(repository);
        const milestones = await useGitHubStore
            .getState()
            .refreshMilestones(repository);

        expect(notifications).toEqual([notification]);
        expect(releases).toEqual([release]);
        expect(milestones).toEqual([milestone]);
        expect(
            useGitHubStore.getState().notificationsByHost["github.com"],
        ).toEqual([notification]);
        expect(useGitHubStore.getState().releasesByRepo[repoKey]).toEqual([
            release,
        ]);
        expect(useGitHubStore.getState().milestonesByRepo[repoKey]).toEqual([
            milestone,
        ]);
    });

    it("clears a repository cache without touching auth status", () => {
        const authStatus = {
            canReadActions: false,
            canWriteActions: false,
            canWriteIssues: true,
            canWritePullRequests: false,
            checkedAt: "2026-05-07T00:00:00Z",
            errorCode: null,
            host: "github.com",
            readOnly: false,
            state: "authenticated" as const,
            user: null,
        };
        useGitHubStore.setState({
            authStatusByHost: { "github.com": authStatus },
            errors: { [`${repoKey}:issues`]: "Nope" },
            issuesByRepo: { [repoKey]: [createIssueSummary()] },
            loadingKeys: { [`${repoKey}:issues`]: true },
        });

        useGitHubStore.getState().clearRepoCache(repository);

        expect(useGitHubStore.getState().authStatusByHost["github.com"]).toBe(
            authStatus,
        );
        expect(useGitHubStore.getState().issuesByRepo[repoKey]).toBeUndefined();
        expect(useGitHubStore.getState().errors[`${repoKey}:issues`]).toBeUndefined();
        expect(
            useGitHubStore.getState().loadingKeys[`${repoKey}:issues`],
        ).toBeUndefined();
    });
});

function stubComando(api: Record<string, unknown>): void {
    vi.stubGlobal("window", {
        comando: api,
    });
}

function createIssueSummary(
    overrides: Partial<GitHubIssueSummary> = {},
): GitHubIssueSummary {
    return {
        assignees: [],
        author: null,
        closedAt: null,
        commentCount: 0,
        createdAt: "2026-05-07T00:00:00Z",
        id: overrides.number ?? 1,
        isLocked: false,
        labels: [],
        milestone: null,
        nodeId: `ISSUE_${overrides.number ?? 1}`,
        number: 1,
        state: "open",
        stateReason: null,
        title: "Issue",
        updatedAt: "2026-05-07T00:00:00Z",
        url: "https://github.com/octocat/hello-world/issues/1",
        ...overrides,
    };
}

function createIssueDetail(
    overrides: Partial<GitHubIssueDetail> = {},
): GitHubIssueDetail {
    return {
        ...createIssueSummary(overrides),
        body: "",
        comments: [],
        ...overrides,
    };
}

function createPullRequestDetail(
    overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
    return {
        additions: null,
        author: null,
        base: {
            label: "octocat:main",
            ref: "main",
            repository,
            sha: "base123",
        },
        body: "",
        changedFileCount: null,
        closedAt: null,
        commentCount: 0,
        comments: [],
        commitCount: null,
        commits: [],
        createdAt: "2026-05-07T00:00:00Z",
        deletions: null,
        draft: true,
        head: {
            label: "octocat:feature",
            ref: "feature",
            repository,
            sha: "head123",
        },
        id: overrides.number ?? 1,
        labels: [],
        mergeable: null,
        mergedAt: null,
        nodeId: `PR_${overrides.number ?? 1}`,
        number: 1,
        state: "open",
        title: "Pull request",
        updatedAt: "2026-05-07T00:00:00Z",
        url: "https://github.com/octocat/hello-world/pull/1",
        ...overrides,
    };
}

function createPullRequestChecks(
    overrides: Partial<GitHubPullRequestChecksResult> = {},
): GitHubPullRequestChecksResult {
    return {
        checkedAt: "2026-05-07T00:00:00Z",
        checks: [
            {
                completedAt: "2026-05-07T00:00:00Z",
                conclusion: "success",
                detailsUrl:
                    "https://github.com/octocat/hello-world/actions/runs/1",
                id: "check-run:1",
                name: "CI",
                source: "check_run",
                startedAt: "2026-05-07T00:00:00Z",
                status: "completed",
            },
        ],
        headSha: "head123",
        pullRequestNumber: 12,
        state: "success",
        url: "https://github.com/octocat/hello-world/pull/12/checks",
        ...overrides,
    };
}

function createWorkflowRun(
    overrides: Partial<GitHubWorkflowRunSummary> = {},
): GitHubWorkflowRunSummary {
    return {
        branch: "feature",
        checkSuiteId: 1,
        conclusion: "failure",
        createdAt: "2026-05-07T00:00:00Z",
        event: "pull_request",
        headSha: "head123",
        id: 101,
        name: "CI",
        runAttempt: 1,
        runNumber: 7,
        status: "completed",
        updatedAt: "2026-05-07T00:10:00Z",
        url: "https://github.com/octocat/hello-world/actions/runs/101",
        workflowName: "CI",
        ...overrides,
    };
}

function createWorkflowJob(
    overrides: Partial<GitHubWorkflowJobSummary> = {},
): GitHubWorkflowJobSummary {
    return {
        checkRunId: 303,
        completedAt: "2026-05-07T00:10:00Z",
        conclusion: "failure",
        id: 202,
        name: "lint",
        runnerName: "GitHub Actions 1",
        startedAt: "2026-05-07T00:00:00Z",
        status: "completed",
        steps: [],
        url: "https://github.com/octocat/hello-world/actions/runs/101/job/202",
        ...overrides,
    };
}

function createNotification(
    overrides: Partial<GitHubNotificationSummary> = {},
): GitHubNotificationSummary {
    return {
        id: "notification-1",
        lastReadAt: null,
        reason: "review_requested",
        repository,
        subject: {
            latestCommentUrl:
                "https://api.github.com/repos/octocat/hello-world/issues/comments/1",
            title: "Review requested",
            type: "PullRequest",
            url: "https://api.github.com/repos/octocat/hello-world/pulls/1",
        },
        unread: true,
        updatedAt: "2026-05-07T00:00:00Z",
        url: "https://api.github.com/notifications/threads/1",
        ...overrides,
    };
}

function createRelease(
    overrides: Partial<GitHubReleaseSummary> = {},
): GitHubReleaseSummary {
    return {
        author: null,
        body: "Release notes",
        createdAt: "2026-05-07T00:00:00Z",
        draft: true,
        id: 99,
        name: "v1.0.0",
        prerelease: false,
        publishedAt: null,
        tagName: "v1.0.0",
        targetCommitish: "main",
        updatedAt: "2026-05-07T00:00:00Z",
        url: "https://github.com/octocat/hello-world/releases/tag/v1.0.0",
        ...overrides,
    };
}

function createMilestone(
    overrides: Partial<GitHubMilestoneSummary> = {},
): GitHubMilestoneSummary {
    return {
        dueOn: "2026-06-01T00:00:00Z",
        id: 1,
        number: 1,
        state: "open",
        title: "MVP",
        ...overrides,
    };
}

function createComment(
    overrides: Partial<GitHubCommentSummary> = {},
): GitHubCommentSummary {
    return {
        author: null,
        body: "Comment",
        createdAt: "2026-05-07T00:00:00Z",
        id: 1,
        updatedAt: "2026-05-07T00:00:00Z",
        url: "https://github.com/octocat/hello-world/issues/1#comment",
        ...overrides,
    };
}
