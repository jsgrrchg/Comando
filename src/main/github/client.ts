import {
    buildGitHubApiBaseUrl,
    buildGitHubGraphQlUrl,
    normalizeGitHubHost,
} from "@main/github/auth";
import type {
    GitHubAuthStatus,
    GitHubCommentSummary,
    GitHubCommitSummary,
    GitHubCreateIssueInput,
    GitHubCreatePullRequestInput,
    GitHubErrorCode,
    GitHubGetIssueInput,
    GitHubGetPullRequestInput,
    GitHubIssueDetail,
    GitHubIssueState,
    GitHubIssueStateReason,
    GitHubIssueSummary,
    GitHubLabelSummary,
    GitHubListLabelsInput,
    GitHubListLabelsResult,
    GitHubListIssuesInput,
    GitHubListIssuesResult,
    GitHubListMilestonesInput,
    GitHubListMilestonesResult,
    GitHubListReleasesInput,
    GitHubListReleasesResult,
    GitHubListPullRequestsInput,
    GitHubListPullRequestsResult,
    GitHubCheckRunAnnotationSummary,
    GitHubCheckRunAnnotationsInput,
    GitHubCheckRunAnnotationsResult,
    GitHubPullRequestCheckConclusion,
    GitHubPullRequestCheckStatus,
    GitHubPullRequestChecksInput,
    GitHubPullRequestCheckSummary,
    GitHubPullRequestChecksResult,
    GitHubPullRequestChecksState,
    GitHubMilestoneSummary,
    GitHubNotificationSummary,
    GitHubNotificationsInput,
    GitHubNotificationsResult,
    GitHubPullRequestBranchRef,
    GitHubPullRequestDetail,
    GitHubPullRequestState,
    GitHubPullRequestSummary,
    GitHubRequestPullRequestReviewInput,
    GitHubRepositoryRef,
    GitHubCreateReleaseInput,
    GitHubGeneratedReleaseNotes,
    GitHubGenerateReleaseNotesInput,
    GitHubPublishReleaseInput,
    GitHubReleaseSummary,
    GitHubSetIssueStateInput,
    GitHubSetPullRequestDraftStateInput,
    GitHubUpdateCommentInput,
    GitHubUpdateIssueInput,
    GitHubUserSummary,
    GitHubWorkflowArtifactSummary,
    GitHubWorkflowConclusion,
    GitHubWorkflowJobLogsInput,
    GitHubWorkflowJobLogsResult,
    GitHubWorkflowJobStepSummary,
    GitHubWorkflowJobSummary,
    GitHubWorkflowRunArtifactsInput,
    GitHubWorkflowRunArtifactsResult,
    GitHubWorkflowRunJobsInput,
    GitHubWorkflowRunJobsResult,
    GitHubWorkflowRunMutationInput,
    GitHubWorkflowRunsInput,
    GitHubWorkflowRunsResult,
    GitHubWorkflowRunStatus,
    GitHubWorkflowRunSummary,
} from "@shared/ipc";

// Skip per-commit stats enrichment for PRs above this size to avoid
// flooding the GitHub API with N detail requests for very large PRs.
const PR_COMMIT_STATS_LIMIT = 50;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export type GitHubFetch = (
    input: string | URL,
    init?: RequestInit,
) => Promise<Response>;

interface GitHubApiClientOptions {
    readonly fetch?: GitHubFetch;
    readonly requestTimeoutMs?: number;
    readonly token: string;
}

interface GitHubRequestOptions {
    readonly body?: unknown;
    readonly method?: string;
    readonly query?: Record<
        string,
        readonly string[] | boolean | number | string | null | undefined
    >;
}

interface GitHubJsonResponse<T> {
    readonly data: T;
    readonly headers: Headers;
}

interface RawGitHubUser {
    readonly avatar_url?: string | null;
    readonly html_url?: string | null;
    readonly id?: number;
    readonly login?: string;
}

interface RawGitHubLabel {
    readonly color?: string;
    readonly description?: string | null;
    readonly id?: number;
    readonly name?: string;
}

interface RawGitHubMilestone {
    readonly due_on?: string | null;
    readonly id?: number;
    readonly number?: number;
    readonly state?: GitHubIssueState;
    readonly title?: string;
}

interface RawGitHubNotification {
    readonly id?: string;
    readonly last_read_at?: string | null;
    readonly reason?: string;
    readonly repository?: {
        readonly full_name?: string;
        readonly html_url?: string;
        readonly name?: string;
        readonly owner?: RawGitHubUser | null;
    } | null;
    readonly subject?: {
        readonly latest_comment_url?: string | null;
        readonly title?: string;
        readonly type?: string;
        readonly url?: string | null;
    };
    readonly unread?: boolean;
    readonly updated_at?: string;
    readonly url?: string;
}

interface RawGitHubRelease {
    readonly author?: RawGitHubUser | null;
    readonly body?: string | null;
    readonly created_at?: string;
    readonly draft?: boolean;
    readonly html_url?: string;
    readonly id?: number;
    readonly name?: string | null;
    readonly prerelease?: boolean;
    readonly published_at?: string | null;
    readonly tag_name?: string;
    readonly target_commitish?: string;
    readonly updated_at?: string;
}

interface RawGitHubGeneratedReleaseNotes {
    readonly body?: string;
    readonly name?: string;
}

interface RawGitHubIssue {
    readonly assignees?: readonly RawGitHubUser[];
    readonly body?: string | null;
    readonly closed_at?: string | null;
    readonly comments?: number;
    readonly created_at?: string;
    readonly html_url?: string;
    readonly id?: number;
    readonly labels?: readonly RawGitHubLabel[];
    readonly locked?: boolean;
    readonly milestone?: RawGitHubMilestone | null;
    readonly node_id?: string;
    readonly number?: number;
    readonly pull_request?: unknown;
    readonly state?: GitHubIssueState;
    readonly state_reason?: GitHubIssueStateReason | null;
    readonly title?: string;
    readonly updated_at?: string;
    readonly user?: RawGitHubUser | null;
}

interface RawGitHubComment {
    readonly body?: string | null;
    readonly created_at?: string;
    readonly html_url?: string;
    readonly id?: number;
    readonly updated_at?: string;
    readonly user?: RawGitHubUser | null;
}

interface RawGitHubPullRequestRef {
    readonly label?: string;
    readonly ref?: string;
    readonly repo?: {
        readonly full_name?: string;
        readonly html_url?: string;
        readonly name?: string;
        readonly owner?: RawGitHubUser | null;
    } | null;
    readonly sha?: string;
}

interface RawGitHubPullRequest {
    readonly additions?: number;
    readonly base?: RawGitHubPullRequestRef;
    readonly body?: string | null;
    readonly changed_files?: number;
    readonly closed_at?: string | null;
    readonly comments?: number;
    readonly commits?: number;
    readonly created_at?: string;
    readonly deletions?: number;
    readonly draft?: boolean;
    readonly head?: RawGitHubPullRequestRef;
    readonly html_url?: string;
    readonly id?: number;
    readonly labels?: readonly RawGitHubLabel[];
    readonly mergeable?: boolean | null;
    readonly merged_at?: string | null;
    readonly node_id?: string;
    readonly number?: number;
    readonly state?: "closed" | "open";
    readonly title?: string;
    readonly updated_at?: string;
    readonly user?: RawGitHubUser | null;
}

interface RawGitHubCommitStatus {
    readonly context?: string;
    readonly created_at?: string | null;
    readonly description?: string | null;
    readonly id?: number;
    readonly state?: string;
    readonly target_url?: string | null;
    readonly updated_at?: string | null;
}

interface RawGitHubCombinedStatus {
    readonly state?: string;
    readonly statuses?: readonly RawGitHubCommitStatus[];
}

interface RawGitHubCheckRun {
    readonly completed_at?: string | null;
    readonly conclusion?: string | null;
    readonly details_url?: string | null;
    readonly html_url?: string | null;
    readonly id?: number;
    readonly name?: string;
    readonly started_at?: string | null;
    readonly status?: string;
}

interface RawGitHubCheckRunsResult {
    readonly check_runs?: readonly RawGitHubCheckRun[];
    readonly total_count?: number;
}

interface RawGitHubWorkflowRun {
    readonly check_suite_id?: number | null;
    readonly conclusion?: string | null;
    readonly created_at?: string;
    readonly event?: string;
    readonly head_branch?: string | null;
    readonly head_sha?: string;
    readonly html_url?: string;
    readonly id?: number;
    readonly name?: string | null;
    readonly run_attempt?: number;
    readonly run_number?: number;
    readonly status?: string;
    readonly updated_at?: string;
    readonly workflow_id?: number;
}

interface RawGitHubWorkflowRunsResult {
    readonly total_count?: number;
    readonly workflow_runs?: readonly RawGitHubWorkflowRun[];
}

interface RawGitHubWorkflowJobStep {
    readonly completed_at?: string | null;
    readonly conclusion?: string | null;
    readonly name?: string;
    readonly number?: number;
    readonly started_at?: string | null;
    readonly status?: string;
}

interface RawGitHubWorkflowJob {
    readonly check_run_url?: string | null;
    readonly completed_at?: string | null;
    readonly conclusion?: string | null;
    readonly html_url?: string;
    readonly id?: number;
    readonly name?: string;
    readonly runner_name?: string | null;
    readonly started_at?: string | null;
    readonly status?: string;
    readonly steps?: readonly RawGitHubWorkflowJobStep[];
}

interface RawGitHubWorkflowRunJobsResult {
    readonly jobs?: readonly RawGitHubWorkflowJob[];
    readonly total_count?: number;
}

interface RawGitHubWorkflowArtifact {
    readonly archive_download_url?: string;
    readonly created_at?: string;
    readonly expired?: boolean;
    readonly expires_at?: string | null;
    readonly id?: number;
    readonly name?: string;
    readonly size_in_bytes?: number;
    readonly updated_at?: string;
    readonly url?: string;
}

interface RawGitHubWorkflowRunArtifactsResult {
    readonly artifacts?: readonly RawGitHubWorkflowArtifact[];
    readonly total_count?: number;
}

interface RawGitHubCheckRunAnnotation {
    readonly annotation_level?: string;
    readonly blob_href?: string | null;
    readonly end_column?: number | null;
    readonly end_line?: number | null;
    readonly message?: string;
    readonly path?: string;
    readonly raw_details?: string | null;
    readonly start_column?: number | null;
    readonly start_line?: number;
    readonly title?: string | null;
}

interface RawGitHubCommit {
    readonly author?: RawGitHubUser | null;
    readonly commit?: {
        readonly author?: {
            readonly date?: string;
            readonly email?: string | null;
            readonly name?: string | null;
        } | null;
        readonly committer?: {
            readonly date?: string;
            readonly email?: string | null;
            readonly name?: string | null;
        } | null;
        readonly message?: string;
    };
    readonly committer?: RawGitHubUser | null;
    readonly html_url?: string;
    readonly parents?: readonly { readonly sha?: string }[];
    readonly sha?: string;
    readonly stats?: {
        readonly additions?: number;
        readonly deletions?: number;
        readonly total?: number;
    };
}

interface RawGraphQlResponse {
    readonly errors?: readonly { readonly message?: string }[];
}

export class GitHubApiError extends Error {
    readonly code: GitHubErrorCode;
    readonly status: number | null;

    constructor(
        message: string,
        code: GitHubErrorCode,
        status: number | null = null,
    ) {
        super(message);
        this.name = "GitHubApiError";
        this.code = code;
        this.status = status;
    }
}

export class GitHubApiClient {
    readonly #fetch: GitHubFetch;
    readonly #requestTimeoutMs: number;
    readonly #token: string;

    constructor(options: GitHubApiClientOptions) {
        this.#fetch = options.fetch ?? fetch;
        this.#requestTimeoutMs =
            options.requestTimeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
        this.#token = options.token;
    }

    async getAuthStatus(hostInput?: string | null): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(hostInput);
        try {
            const response = await this.#requestJson<RawGitHubUser>(host, "/user");
            const scopes = parseScopes(
                response.headers.get("x-oauth-scopes"),
            );
            const hasUnknownFineGrainedPermissions = scopes.size === 0;
            const hasBroadRepoScope =
                scopes.has("repo") || scopes.has("public_repo");
            const canWriteIssues =
                hasUnknownFineGrainedPermissions ||
                hasBroadRepoScope ||
                scopes.has("issues") ||
                scopes.has("write:issues");
            const canWritePullRequests =
                hasUnknownFineGrainedPermissions ||
                hasBroadRepoScope ||
                scopes.has("pull_request") ||
                scopes.has("write:pull_requests");
            const canReadActions =
                hasUnknownFineGrainedPermissions ||
                hasBroadRepoScope ||
                scopes.has("workflow") ||
                scopes.has("actions:read");
            const canWriteActions =
                hasUnknownFineGrainedPermissions ||
                hasBroadRepoScope ||
                scopes.has("workflow") ||
                scopes.has("actions:write");

            return {
                canReadActions,
                canWriteActions,
                canWriteIssues,
                canWritePullRequests,
                checkedAt: new Date().toISOString(),
                errorCode: null,
                host,
                readOnly: !canWriteIssues && !canWritePullRequests,
                state: "authenticated",
                tokenSource: null,
                user: mapUser(response.data),
            };
        } catch (error) {
            if (error instanceof GitHubApiError) {
                return {
                    canReadActions: false,
                    canWriteActions: false,
                    canWriteIssues: false,
                    canWritePullRequests: false,
                    checkedAt: new Date().toISOString(),
                    errorCode: error.code,
                    host,
                    readOnly: true,
                    state:
                        error.code === "invalid_auth" ? "invalid" : "unknown",
                    tokenSource: null,
                    user: null,
                };
            }

            throw error;
        }
    }

    async listIssues(
        input: GitHubListIssuesInput,
    ): Promise<GitHubListIssuesResult> {
        const response = await this.#requestJson<readonly RawGitHubIssue[]>(
            input.repository.host,
            repoPath(input.repository, "/issues"),
            {
                query: {
                    assignee: input.assignee,
                    labels: input.labels?.join(","),
                    page: parseCursor(input.cursor),
                    per_page: clampPageLimit(input.limit),
                    state: input.state ?? "open",
                },
            },
        );
        const query = normalizeSearchQuery(input.query);
        const issues = response.data
            .filter((issue) => issue.pull_request === undefined)
            .filter((issue) => matchesIssueQuery(issue, query))
            .map(mapIssueSummary);

        return {
            issues,
            nextCursor: readNextPageCursor(response.headers),
            totalCount: null,
        };
    }

    async getIssue(
        input: GitHubGetIssueInput,
    ): Promise<GitHubIssueDetail | null> {
        const issue = await this.#requestJson<RawGitHubIssue>(
            input.repository.host,
            repoPath(input.repository, `/issues/${input.number}`),
        );
        if (issue.data.pull_request !== undefined) {
            return null;
        }

        const comments = await this.#listIssueComments(
            input.repository,
            input.number,
        );

        return mapIssueDetail(issue.data, comments);
    }

    async createIssue(
        input: GitHubCreateIssueInput,
    ): Promise<GitHubIssueDetail> {
        const response = await this.#requestJson<RawGitHubIssue>(
            input.repository.host,
            repoPath(input.repository, "/issues"),
            {
                body: {
                    assignees: input.assignees ?? undefined,
                    body: input.body ?? undefined,
                    labels: input.labels ?? undefined,
                    milestone: input.milestoneNumber ?? undefined,
                    title: input.title,
                },
                method: "POST",
            },
        );

        return mapIssueDetail(response.data, []);
    }

    async updateIssue(
        input: GitHubUpdateIssueInput,
    ): Promise<GitHubIssueDetail> {
        const body: {
            body?: string;
            labels?: readonly string[];
            title?: string;
        } = {};
        if (Object.hasOwn(input, "body")) {
            body.body = input.body ?? "";
        }
        if (Object.hasOwn(input, "labels")) {
            body.labels = input.labels ?? [];
        }
        if (input.title != null) {
            body.title = input.title;
        }

        await this.#requestJson<RawGitHubIssue>(
            input.repository.host,
            repoPath(input.repository, `/issues/${input.number}`),
            {
                body,
                method: "PATCH",
            },
        );
        const updated = await this.getIssue(input);
        if (!updated) {
            throw new GitHubApiError(
                "GitHub issue could not be loaded after updating.",
                "not_found",
                404,
            );
        }

        return updated;
    }

    async commentIssue(input: {
        readonly body: string;
        readonly number: number;
        readonly repository: GitHubRepositoryRef;
    }): Promise<GitHubCommentSummary> {
        const response = await this.#requestJson<RawGitHubComment>(
            input.repository.host,
            repoPath(input.repository, `/issues/${input.number}/comments`),
            {
                body: { body: input.body },
                method: "POST",
            },
        );

        return mapComment(response.data);
    }

    async updateComment(
        input: GitHubUpdateCommentInput,
    ): Promise<GitHubCommentSummary> {
        const response = await this.#requestJson<RawGitHubComment>(
            input.repository.host,
            repoPath(input.repository, `/issues/comments/${input.commentId}`),
            {
                body: { body: input.body },
                method: "PATCH",
            },
        );

        return mapComment(response.data);
    }

    async setIssueState(
        input: GitHubSetIssueStateInput,
    ): Promise<GitHubIssueDetail> {
        await this.#requestJson<RawGitHubIssue>(
            input.repository.host,
            repoPath(input.repository, `/issues/${input.number}`),
            {
                body: {
                    state: input.state,
                    state_reason: input.stateReason ?? undefined,
                },
                method: "PATCH",
            },
        );
        const updated = await this.getIssue(input);
        if (!updated) {
            throw new GitHubApiError(
                "GitHub issue could not be loaded after updating its state.",
                "not_found",
                404,
            );
        }

        return updated;
    }

    async listPullRequests(
        input: GitHubListPullRequestsInput,
    ): Promise<GitHubListPullRequestsResult> {
        const response = await this.#requestJson<readonly RawGitHubPullRequest[]>(
            input.repository.host,
            repoPath(input.repository, "/pulls"),
            {
                query: {
                    base: input.base,
                    head: input.head,
                    page: parseCursor(input.cursor),
                    per_page: clampPageLimit(input.limit),
                    state: input.state ?? "open",
                },
            },
        );
        const query = normalizeSearchQuery(input.query);

        return {
            nextCursor: readNextPageCursor(response.headers),
            pullRequests: response.data
                .filter((pullRequest) =>
                    matchesPullRequestQuery(pullRequest, query),
                )
                .map((pullRequest) =>
                    mapPullRequestSummary(pullRequest, input.repository),
                ),
            totalCount: null,
        };
    }

    async getPullRequest(
        input: GitHubGetPullRequestInput,
    ): Promise<GitHubPullRequestDetail | null> {
        const pullRequest = await this.#requestJson<RawGitHubPullRequest>(
            input.repository.host,
            repoPath(input.repository, `/pulls/${input.number}`),
        );
        const [comments, commits] = await Promise.all([
            this.#listIssueComments(input.repository, input.number),
            this.#listPullRequestCommits(input.repository, input.number),
        ]);

        return mapPullRequestDetail(
            pullRequest.data,
            input.repository,
            comments,
            commits,
        );
    }

    async listPullRequestChecks(
        input: GitHubPullRequestChecksInput,
    ): Promise<GitHubPullRequestChecksResult> {
        const sha = encodeURIComponent(input.headSha);
        const [combinedStatus, checkRuns] = await Promise.all([
            this.#requestJson<RawGitHubCombinedStatus>(
                input.repository.host,
                repoPath(input.repository, `/commits/${sha}/status`),
            ),
            this.#requestJson<RawGitHubCheckRunsResult>(
                input.repository.host,
                repoPath(input.repository, `/commits/${sha}/check-runs`),
                {
                    query: { per_page: 50 },
                },
            ),
        ]);
        const checks = [
            ...(combinedStatus.data.statuses ?? []).map(mapCommitStatusCheck),
            ...(checkRuns.data.check_runs ?? []).map(mapCheckRun),
        ].sort(compareChecks);

        return {
            checkedAt: new Date().toISOString(),
            checks,
            headSha: input.headSha,
            pullRequestNumber: input.pullRequestNumber,
            state: aggregateChecksState(checks),
            url: buildPullRequestChecksUrl(input.repository, input.pullRequestNumber),
        };
    }

    async createPullRequest(
        input: GitHubCreatePullRequestInput,
    ): Promise<GitHubPullRequestDetail> {
        const response = await this.#requestJson<RawGitHubPullRequest>(
            input.repository.host,
            repoPath(input.repository, "/pulls"),
            {
                body: {
                    base: input.base,
                    body: input.body ?? undefined,
                    draft: input.draft ?? undefined,
                    head: input.head,
                    maintainer_can_modify:
                        input.maintainerCanModify ?? undefined,
                    title: input.title,
                },
                method: "POST",
            },
        );

        return mapPullRequestDetail(response.data, input.repository, [], []);
    }

    async updatePullRequest(input: {
        readonly body?: string | null;
        readonly number: number;
        readonly repository: GitHubRepositoryRef;
        readonly title?: string | null;
    }): Promise<GitHubPullRequestDetail> {
        const body: { body?: string; title?: string } = {};
        if (Object.hasOwn(input, "body")) {
            body.body = input.body ?? "";
        }
        if (input.title != null) {
            body.title = input.title;
        }

        await this.#requestJson<RawGitHubPullRequest>(
            input.repository.host,
            repoPath(input.repository, `/pulls/${input.number}`),
            {
                body,
                method: "PATCH",
            },
        );
        const updated = await this.getPullRequest(input);
        if (!updated) {
            throw new GitHubApiError(
                "GitHub pull request could not be loaded after updating.",
                "not_found",
                404,
            );
        }

        return updated;
    }

    async commentPullRequest(input: {
        readonly body: string;
        readonly number: number;
        readonly repository: GitHubRepositoryRef;
    }): Promise<GitHubCommentSummary> {
        return this.commentIssue(input);
    }

    async setPullRequestDraftState(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail> {
        const pullRequest = await this.getPullRequest(input);
        if (!pullRequest) {
            throw new GitHubApiError(
                "GitHub pull request was not found.",
                "not_found",
                404,
            );
        }

        const mutation = input.draft
            ? `
                mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
                    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
                        pullRequest { id }
                    }
                }
            `
            : `
                mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
                    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
                        pullRequest { id }
                    }
                }
            `;

        await this.#requestGraphQl(input.repository.host, mutation, {
            pullRequestId: pullRequest.nodeId,
        });
        const updated = await this.getPullRequest(input);
        if (!updated) {
            throw new GitHubApiError(
                "GitHub pull request could not be loaded after updating draft state.",
                "not_found",
                404,
            );
        }

        return updated;
    }

    async requestPullRequestReviewers(
        input: GitHubRequestPullRequestReviewInput,
    ): Promise<GitHubPullRequestDetail> {
        await this.#requestJson<RawGitHubPullRequest>(
            input.repository.host,
            repoPath(input.repository, `/pulls/${input.number}/requested_reviewers`),
            {
                body: {
                    reviewers: normalizeStringList(input.reviewers),
                    team_reviewers: normalizeStringList(input.teamReviewers),
                },
                method: "POST",
            },
        );
        const updated = await this.getPullRequest(input);
        if (!updated) {
            throw new GitHubApiError(
                "GitHub pull request could not be loaded after requesting review.",
                "not_found",
                404,
            );
        }

        return updated;
    }

    async listWorkflowRuns(
        input: GitHubWorkflowRunsInput,
    ): Promise<GitHubWorkflowRunsResult> {
        const response =
            await this.#requestJson<RawGitHubWorkflowRunsResult>(
                input.repository.host,
                repoPath(input.repository, "/actions/runs"),
                {
                    query: {
                        branch: input.branch,
                        head_sha: input.headSha,
                        page: parseCursor(input.cursor),
                        per_page: clampPageLimit(input.limit),
                    },
                },
            );

        return {
            nextCursor: readNextPageCursor(response.headers),
            runs: (response.data.workflow_runs ?? []).map(mapWorkflowRun),
            totalCount: response.data.total_count ?? null,
        };
    }

    async listWorkflowRunJobs(
        input: GitHubWorkflowRunJobsInput,
    ): Promise<GitHubWorkflowRunJobsResult> {
        const response =
            await this.#requestJson<RawGitHubWorkflowRunJobsResult>(
                input.repository.host,
                repoPath(input.repository, `/actions/runs/${input.runId}/jobs`),
                {
                    query: {
                        page: parseCursor(input.cursor),
                        per_page: clampPageLimit(input.limit),
                    },
                },
            );

        return {
            jobs: (response.data.jobs ?? []).map(mapWorkflowJob),
            nextCursor: readNextPageCursor(response.headers),
            runId: input.runId,
            totalCount: response.data.total_count ?? null,
        };
    }

    async getWorkflowJobLogs(
        input: GitHubWorkflowJobLogsInput,
    ): Promise<GitHubWorkflowJobLogsResult> {
        const logs = await this.#requestText(
            input.repository.host,
            repoPath(input.repository, `/actions/jobs/${input.jobId}/logs`),
        );
        const maxLogLength = 80_000;

        return {
            jobId: input.jobId,
            logs:
                logs.length > maxLogLength
                    ? logs.slice(0, maxLogLength)
                    : logs,
            truncated: logs.length > maxLogLength,
        };
    }

    async listWorkflowRunArtifacts(
        input: GitHubWorkflowRunArtifactsInput,
    ): Promise<GitHubWorkflowRunArtifactsResult> {
        const response =
            await this.#requestJson<RawGitHubWorkflowRunArtifactsResult>(
                input.repository.host,
                repoPath(
                    input.repository,
                    `/actions/runs/${input.runId}/artifacts`,
                ),
                {
                    query: {
                        page: parseCursor(input.cursor),
                        per_page: clampPageLimit(input.limit),
                    },
                },
            );

        return {
            artifacts: (response.data.artifacts ?? []).map(mapWorkflowArtifact),
            nextCursor: readNextPageCursor(response.headers),
            runId: input.runId,
            totalCount: response.data.total_count ?? null,
        };
    }

    async listCheckRunAnnotations(
        input: GitHubCheckRunAnnotationsInput,
    ): Promise<GitHubCheckRunAnnotationsResult> {
        const response =
            await this.#requestJson<readonly RawGitHubCheckRunAnnotation[]>(
                input.repository.host,
                repoPath(
                    input.repository,
                    `/check-runs/${input.checkRunId}/annotations`,
                ),
                {
                    query: {
                        page: parseCursor(input.cursor),
                        per_page: clampPageLimit(input.limit),
                    },
                },
            );

        return {
            annotations: response.data.map(mapCheckRunAnnotation),
            checkRunId: input.checkRunId,
            nextCursor: readNextPageCursor(response.headers),
        };
    }

    async rerunWorkflowRunFailedJobs(
        input: GitHubWorkflowRunMutationInput,
    ): Promise<void> {
        await this.#requestJson<unknown>(
            input.repository.host,
            repoPath(
                input.repository,
                `/actions/runs/${input.runId}/rerun-failed-jobs`,
            ),
            {
                method: "POST",
            },
        );
    }

    async cancelWorkflowRun(
        input: GitHubWorkflowRunMutationInput,
    ): Promise<void> {
        await this.#requestJson<unknown>(
            input.repository.host,
            repoPath(input.repository, `/actions/runs/${input.runId}/cancel`),
            {
                method: "POST",
            },
        );
    }

    async listNotifications(
        input: GitHubNotificationsInput,
    ): Promise<GitHubNotificationsResult> {
        const host = normalizeGitHubHost(input.host);
        const response = await this.#requestJson<readonly RawGitHubNotification[]>(
            host,
            "/notifications",
            {
                query: {
                    all: input.all,
                    page: parseCursor(input.cursor),
                    participating: input.participating,
                    per_page: clampPageLimit(input.limit),
                },
            },
        );

        return {
            nextCursor: readNextPageCursor(response.headers),
            notifications: response.data.map((notification) =>
                mapNotification(notification, host),
            ),
            totalCount: null,
        };
    }

    async listReleases(
        input: GitHubListReleasesInput,
    ): Promise<GitHubListReleasesResult> {
        const response = await this.#requestJson<readonly RawGitHubRelease[]>(
            input.repository.host,
            repoPath(input.repository, "/releases"),
            {
                query: {
                    page: parseCursor(input.cursor),
                    per_page: clampPageLimit(input.limit),
                },
            },
        );

        return {
            nextCursor: readNextPageCursor(response.headers),
            releases: response.data.map(mapRelease),
            totalCount: null,
        };
    }

    async generateReleaseNotes(
        input: GitHubGenerateReleaseNotesInput,
    ): Promise<GitHubGeneratedReleaseNotes> {
        const response =
            await this.#requestJson<RawGitHubGeneratedReleaseNotes>(
                input.repository.host,
                repoPath(input.repository, "/releases/generate-notes"),
                {
                    body: {
                        previous_tag_name: input.previousTagName ?? undefined,
                        tag_name: input.tagName,
                        target_commitish: input.targetCommitish ?? undefined,
                    },
                    method: "POST",
                },
            );

        return {
            body: response.data.body ?? "",
            name: response.data.name ?? input.tagName,
            tagName: input.tagName,
        };
    }

    async createRelease(
        input: GitHubCreateReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        const response = await this.#requestJson<RawGitHubRelease>(
            input.repository.host,
            repoPath(input.repository, "/releases"),
            {
                body: {
                    body: input.body ?? undefined,
                    draft: input.draft,
                    name: input.name ?? undefined,
                    prerelease: input.prerelease ?? undefined,
                    tag_name: input.tagName,
                    target_commitish: input.targetCommitish ?? undefined,
                },
                method: "POST",
            },
        );

        return mapRelease(response.data);
    }

    async publishRelease(
        input: GitHubPublishReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        const response = await this.#requestJson<RawGitHubRelease>(
            input.repository.host,
            repoPath(input.repository, `/releases/${input.releaseId}`),
            {
                body: { draft: false },
                method: "PATCH",
            },
        );

        return mapRelease(response.data);
    }

    async listLabels(
        input: GitHubListLabelsInput,
    ): Promise<GitHubListLabelsResult> {
        const response = await this.#requestJson<readonly RawGitHubLabel[]>(
            input.repository.host,
            repoPath(input.repository, "/labels"),
            {
                query: {
                    page: parseCursor(input.cursor),
                    per_page: clampPageLimit(input.limit),
                },
            },
        );

        return {
            labels: response.data.map(mapLabel),
            nextCursor: readNextPageCursor(response.headers),
            totalCount: null,
        };
    }

    async listMilestones(
        input: GitHubListMilestonesInput,
    ): Promise<GitHubListMilestonesResult> {
        const response = await this.#requestJson<readonly RawGitHubMilestone[]>(
            input.repository.host,
            repoPath(input.repository, "/milestones"),
            {
                query: {
                    page: parseCursor(input.cursor),
                    per_page: clampPageLimit(input.limit),
                    state: input.state ?? "open",
                },
            },
        );

        return {
            milestones: response.data.map(mapMilestone).filter(isPresent),
            nextCursor: readNextPageCursor(response.headers),
            totalCount: null,
        };
    }

    async #listIssueComments(
        repository: GitHubRepositoryRef,
        number: number,
    ): Promise<readonly GitHubCommentSummary[]> {
        const response = await this.#requestJson<readonly RawGitHubComment[]>(
            repository.host,
            repoPath(repository, `/issues/${number}/comments`),
            {
                query: { per_page: 100 },
            },
        );

        return response.data.map(mapComment);
    }

    async #listPullRequestCommits(
        repository: GitHubRepositoryRef,
        number: number,
    ): Promise<readonly GitHubCommitSummary[]> {
        const response = await this.#requestJson<readonly RawGitHubCommit[]>(
            repository.host,
            repoPath(repository, `/pulls/${number}/commits`),
            {
                query: { per_page: 100 },
            },
        );
        const commits = response.data.map(mapCommit);

        // The pull-request commits endpoint omits per-commit stats; enrich
        // each commit with additions/deletions from /commits/{sha}. Skip
        // for very large PRs to avoid a request flood.
        if (commits.length === 0 || commits.length > PR_COMMIT_STATS_LIMIT) {
            return commits;
        }

        const enriched = await Promise.allSettled(
            commits.map((commit) =>
                this.#requestJson<RawGitHubCommit>(
                    repository.host,
                    repoPath(
                        repository,
                        `/commits/${encodeURIComponent(commit.sha)}`,
                    ),
                ),
            ),
        );

        return commits.map((commit, index) => {
            const result = enriched[index];
            if (result?.status !== "fulfilled") {
                return commit;
            }
            const stats = result.value.data.stats;
            return {
                ...commit,
                additions: stats?.additions ?? commit.additions,
                deletions: stats?.deletions ?? commit.deletions,
            };
        });
    }

    async #requestGraphQl(
        hostInput: string | null | undefined,
        query: string,
        variables: Record<string, unknown>,
    ): Promise<void> {
        const host = normalizeGitHubHost(hostInput);
        const url = buildGitHubGraphQlUrl(host);
        try {
            const { data, response } = await this.#withRequestTimeout(
                async (signal) => {
                    const response = await this.#fetch(url, {
                        body: JSON.stringify({ query, variables }),
                        headers: this.#buildHeaders({ contentType: true }),
                        method: "POST",
                        signal,
                    });
                    return {
                        data: await readJsonResponse<RawGraphQlResponse>(response),
                        response,
                    };
                },
            );
            if (!response.ok) {
                throw buildGitHubApiError(response, data);
            }
            if (data?.errors?.length) {
                throw new GitHubApiError(
                    data.errors
                        .map((error) => error.message ?? "GraphQL error")
                        .join("; "),
                    "forbidden",
                    response.status,
                );
            }
        } catch (error) {
            throw normalizeGitHubFetchError(error);
        }
    }

    async #requestJson<T>(
        hostInput: string | null | undefined,
        path: string,
        options: GitHubRequestOptions = {},
    ): Promise<GitHubJsonResponse<T>> {
        const host = normalizeGitHubHost(hostInput);
        const url = new URL(`${buildGitHubApiBaseUrl(host)}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value === undefined || value === null || value === "") {
                continue;
            }
            if (Array.isArray(value)) {
                for (const entry of value) {
                    url.searchParams.append(key, String(entry));
                }
                continue;
            }
            url.searchParams.set(key, String(value));
        }

        try {
            const { data, response } = await this.#withRequestTimeout(
                async (signal) => {
                    const response = await this.#fetch(url, {
                        body:
                            options.body === undefined
                                ? undefined
                                : JSON.stringify(options.body),
                        headers: this.#buildHeaders({
                            contentType: options.body !== undefined,
                        }),
                        method: options.method ?? "GET",
                        signal,
                    });
                    return {
                        data: (await readJsonResponse<T>(response)) as T,
                        response,
                    };
                },
            );
            if (!response.ok) {
                throw buildGitHubApiError(response, data);
            }

            return { data, headers: response.headers };
        } catch (error) {
            if (error instanceof GitHubApiError) {
                throw error;
            }
            throw normalizeGitHubFetchError(error);
        }
    }

    async #requestText(
        hostInput: string | null | undefined,
        path: string,
        options: GitHubRequestOptions = {},
    ): Promise<string> {
        const host = normalizeGitHubHost(hostInput);
        const url = new URL(`${buildGitHubApiBaseUrl(host)}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value === undefined || value === null || value === "") {
                continue;
            }
            url.searchParams.set(key, String(value));
        }

        try {
            const { response, text } = await this.#withRequestTimeout(
                async (signal) => {
                    const response = await this.#fetch(url, {
                        body:
                            options.body === undefined
                                ? undefined
                                : JSON.stringify(options.body),
                        headers: this.#buildHeaders({
                            contentType: options.body !== undefined,
                        }),
                        method: options.method ?? "GET",
                        signal,
                    });
                    return {
                        response,
                        text: await readTextResponse(response),
                    };
                },
            );
            if (!response.ok) {
                throw buildGitHubApiError(response, text);
            }

            return text;
        } catch (error) {
            if (error instanceof GitHubApiError) {
                throw error;
            }
            throw normalizeGitHubFetchError(error);
        }
    }

    async #withRequestTimeout<T>(
        run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, this.#requestTimeoutMs);
        timeout.unref?.();

        try {
            return await run(controller.signal);
        } finally {
            clearTimeout(timeout);
        }
    }

    #buildHeaders(options: { readonly contentType: boolean }): HeadersInit {
        const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "User-Agent": "Comando",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (options.contentType) {
            headers["Content-Type"] = "application/json";
        }

        return headers;
    }
}

function buildGitHubApiError(response: Response, body: unknown): GitHubApiError {
    const message = readGitHubErrorMessage(body);
    if (response.status === 401) {
        return new GitHubApiError(message, "invalid_auth", response.status);
    }
    if (response.status === 403) {
        const normalizedMessage = message.toLowerCase();
        const isRateLimited =
            response.headers.get("x-ratelimit-remaining") === "0" ||
            normalizedMessage.includes("rate limit") ||
            normalizedMessage.includes("secondary rate");
        return new GitHubApiError(
            message,
            isRateLimited ? "rate_limited" : "forbidden",
            response.status,
        );
    }
    if (response.status === 404) {
        return new GitHubApiError(message, "not_found", response.status);
    }

    return new GitHubApiError(message, "unknown", response.status);
}

function normalizeGitHubFetchError(error: unknown): GitHubApiError {
    if (error instanceof GitHubApiError) {
        return error;
    }

    if (isAbortError(error)) {
        return new GitHubApiError("GitHub request timed out.", "timeout", null);
    }

    return new GitHubApiError(
        "GitHub could not be reached.",
        "network_error",
        null,
    );
}

async function readJsonResponse<T>(response: Response): Promise<T | null> {
    try {
        return (await response.json()) as T;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        return null;
    }
}

async function readTextResponse(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        return "";
    }
}

function isAbortError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
    );
}

function readGitHubErrorMessage(body: unknown): string {
    if (typeof body === "object" && body !== null && "message" in body) {
        const message = (body as { readonly message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
            return message;
        }
    }

    return "GitHub request failed.";
}

function repoPath(repository: GitHubRepositoryRef, suffix: string): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
        repository.repo,
    )}${suffix}`;
}

function parseScopes(headerValue: string | null): Set<string> {
    return new Set(
        (headerValue ?? "")
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean),
    );
}

function clampPageLimit(limit: number | null | undefined): number {
    if (limit === undefined || limit === null) {
        return 30;
    }

    return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function parseCursor(cursor: string | null | undefined): number | undefined {
    if (!cursor) {
        return undefined;
    }
    const parsed = Number.parseInt(cursor, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeStringList(
    values: readonly string[] | null | undefined,
): readonly string[] | undefined {
    const normalized = (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean);

    return normalized.length > 0 ? normalized : undefined;
}

function readNextPageCursor(headers: Headers): string | null {
    const linkHeader = headers.get("link");
    if (!linkHeader) {
        return null;
    }
    const nextLink = linkHeader
        .split(",")
        .map((entry) => entry.trim())
        .find((entry) => entry.includes('rel="next"'));
    const match = nextLink?.match(/[?&]page=(\d+)/u);

    return match?.[1] ?? null;
}

function normalizeSearchQuery(query: string | null | undefined): string {
    return (query ?? "").trim().toLowerCase();
}

function matchesIssueQuery(
    issue: RawGitHubIssue,
    normalizedQuery: string,
): boolean {
    if (!normalizedQuery) {
        return true;
    }

    return `${issue.title ?? ""}\n${issue.body ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
}

function matchesPullRequestQuery(
    pullRequest: RawGitHubPullRequest,
    normalizedQuery: string,
): boolean {
    if (!normalizedQuery) {
        return true;
    }

    return `${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
}

function mapUser(user: RawGitHubUser | null | undefined): GitHubUserSummary | null {
    if (!user?.login || user.id === undefined) {
        return null;
    }

    return {
        avatarUrl: user.avatar_url ?? null,
        id: user.id,
        login: user.login,
        url: user.html_url ?? `https://github.com/${user.login}`,
    };
}

function mapLabel(label: RawGitHubLabel): GitHubLabelSummary {
    return {
        color: label.color ?? "ededed",
        description: label.description ?? null,
        id: label.id ?? 0,
        name: label.name ?? "",
    };
}

function mapMilestone(
    milestone: RawGitHubMilestone | null | undefined,
): GitHubMilestoneSummary | null {
    if (!milestone) {
        return null;
    }

    return {
        dueOn: milestone.due_on ?? null,
        id: milestone.id ?? 0,
        number: milestone.number ?? 0,
        state: milestone.state ?? "open",
        title: milestone.title ?? "",
    };
}

function mapNotification(
    notification: RawGitHubNotification,
    host: string,
): GitHubNotificationSummary {
    const repository = mapRepositoryFromFullName(
        host,
        notification.repository?.full_name,
    );

    return {
        id: notification.id ?? "",
        lastReadAt: notification.last_read_at ?? null,
        reason: notification.reason ?? "",
        repository,
        subject: {
            latestCommentUrl: notification.subject?.latest_comment_url ?? null,
            title: notification.subject?.title ?? "",
            type: notification.subject?.type ?? "",
            url: notification.subject?.url ?? null,
        },
        unread: notification.unread ?? false,
        updatedAt: notification.updated_at ?? "",
        url: notification.url ?? "",
    };
}

function mapRelease(release: RawGitHubRelease): GitHubReleaseSummary {
    return {
        author: mapUser(release.author),
        body: release.body ?? "",
        createdAt: release.created_at ?? "",
        draft: release.draft ?? false,
        id: release.id ?? 0,
        name: release.name ?? null,
        prerelease: release.prerelease ?? false,
        publishedAt: release.published_at ?? null,
        tagName: release.tag_name ?? "",
        targetCommitish: release.target_commitish ?? "",
        updatedAt: release.updated_at ?? "",
        url: release.html_url ?? "",
    };
}

function mapRepositoryFromFullName(
    host: string,
    fullName: string | null | undefined,
): GitHubRepositoryRef {
    const [owner, repo] = (fullName ?? "").split("/");

    return {
        host,
        owner: owner ?? "",
        repo: repo ?? "",
    };
}

function mapIssueSummary(issue: RawGitHubIssue): GitHubIssueSummary {
    return {
        assignees: (issue.assignees ?? []).map(mapUser).filter(isPresent),
        author: mapUser(issue.user),
        closedAt: issue.closed_at ?? null,
        commentCount: issue.comments ?? 0,
        createdAt: issue.created_at ?? "",
        id: issue.id ?? 0,
        isLocked: issue.locked ?? false,
        labels: (issue.labels ?? []).map(mapLabel),
        milestone: mapMilestone(issue.milestone),
        nodeId: issue.node_id ?? "",
        number: issue.number ?? 0,
        state: issue.state ?? "open",
        stateReason: issue.state_reason ?? null,
        title: issue.title ?? "",
        updatedAt: issue.updated_at ?? "",
        url: issue.html_url ?? "",
    };
}

function mapIssueDetail(
    issue: RawGitHubIssue,
    comments: readonly GitHubCommentSummary[],
): GitHubIssueDetail {
    return {
        ...mapIssueSummary(issue),
        body: issue.body ?? "",
        comments,
    };
}

function mapComment(comment: RawGitHubComment): GitHubCommentSummary {
    return {
        author: mapUser(comment.user),
        body: comment.body ?? "",
        createdAt: comment.created_at ?? "",
        id: comment.id ?? 0,
        updatedAt: comment.updated_at ?? "",
        url: comment.html_url ?? "",
    };
}

function mapPullRequestSummary(
    pullRequest: RawGitHubPullRequest,
    fallbackRepository: GitHubRepositoryRef,
): GitHubPullRequestSummary {
    const mergedAt = pullRequest.merged_at ?? null;
    const rawState = pullRequest.state ?? "open";

    return {
        additions: pullRequest.additions ?? null,
        author: mapUser(pullRequest.user),
        base: mapPullRequestBranchRef(pullRequest.base, fallbackRepository),
        changedFileCount: pullRequest.changed_files ?? null,
        closedAt: pullRequest.closed_at ?? null,
        commentCount: pullRequest.comments ?? 0,
        commitCount: pullRequest.commits ?? null,
        createdAt: pullRequest.created_at ?? "",
        deletions: pullRequest.deletions ?? null,
        draft: pullRequest.draft ?? false,
        head: mapPullRequestBranchRef(pullRequest.head, fallbackRepository),
        id: pullRequest.id ?? 0,
        labels: (pullRequest.labels ?? []).map(mapLabel),
        mergedAt,
        nodeId: pullRequest.node_id ?? "",
        number: pullRequest.number ?? 0,
        state: mapPullRequestState(rawState, mergedAt),
        title: pullRequest.title ?? "",
        updatedAt: pullRequest.updated_at ?? "",
        url: pullRequest.html_url ?? "",
    };
}

function mapPullRequestDetail(
    pullRequest: RawGitHubPullRequest,
    fallbackRepository: GitHubRepositoryRef,
    comments: readonly GitHubCommentSummary[],
    commits: readonly GitHubCommitSummary[],
): GitHubPullRequestDetail {
    return {
        ...mapPullRequestSummary(pullRequest, fallbackRepository),
        body: pullRequest.body ?? "",
        comments,
        commits,
        mergeable: pullRequest.mergeable ?? null,
    };
}

function mapPullRequestBranchRef(
    ref: RawGitHubPullRequestRef | null | undefined,
    fallbackRepository: GitHubRepositoryRef,
): GitHubPullRequestBranchRef {
    return {
        label: ref?.label ?? ref?.ref ?? "",
        ref: ref?.ref ?? "",
        repository: mapRepositoryRef(ref, fallbackRepository),
        sha: ref?.sha ?? "",
    };
}

function mapRepositoryRef(
    ref: RawGitHubPullRequestRef | null | undefined,
    fallbackRepository: GitHubRepositoryRef,
): GitHubRepositoryRef {
    const fullName = ref?.repo?.full_name;
    if (!fullName) {
        return fallbackRepository;
    }
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
        return fallbackRepository;
    }

    return {
        host: fallbackRepository.host,
        owner,
        repo,
    };
}

function mapPullRequestState(
    state: "closed" | "open",
    mergedAt: string | null,
): GitHubPullRequestState {
    if (state === "closed" && mergedAt) {
        return "merged";
    }

    return state;
}

function mapCommit(commit: RawGitHubCommit): GitHubCommitSummary {
    const sha = commit.sha ?? "";

    return {
        additions: commit.stats?.additions ?? null,
        author: mapUser(commit.author),
        authoredAt: commit.commit?.author?.date ?? "",
        committer: mapUser(commit.committer),
        committedAt: commit.commit?.committer?.date ?? "",
        deletions: commit.stats?.deletions ?? null,
        message: commit.commit?.message ?? "",
        parentShas: (commit.parents ?? [])
            .map((parent) => parent.sha)
            .filter(isPresent),
        sha,
        shortSha: sha.slice(0, 7),
        url: commit.html_url ?? "",
    };
}

function mapWorkflowRun(run: RawGitHubWorkflowRun): GitHubWorkflowRunSummary {
    return {
        branch: run.head_branch ?? "",
        checkSuiteId: run.check_suite_id ?? null,
        conclusion: mapWorkflowConclusion(run.conclusion),
        createdAt: run.created_at ?? "",
        event: run.event ?? "",
        headSha: run.head_sha ?? "",
        id: run.id ?? 0,
        name: run.name ?? "Workflow run",
        runAttempt: run.run_attempt ?? 1,
        runNumber: run.run_number ?? 0,
        status: mapWorkflowStatus(run.status),
        updatedAt: run.updated_at ?? "",
        url: run.html_url ?? "",
        workflowName: run.name ?? `Workflow ${run.workflow_id ?? ""}`.trim(),
    };
}

function mapWorkflowJob(job: RawGitHubWorkflowJob): GitHubWorkflowJobSummary {
    return {
        checkRunId: parseCheckRunId(job.check_run_url),
        completedAt: job.completed_at ?? null,
        conclusion: mapWorkflowConclusion(job.conclusion),
        id: job.id ?? 0,
        name: job.name ?? "Job",
        runnerName: job.runner_name ?? null,
        startedAt: job.started_at ?? null,
        status: mapWorkflowStatus(job.status),
        steps: (job.steps ?? []).map(mapWorkflowJobStep),
        url: job.html_url ?? "",
    };
}

function mapWorkflowJobStep(
    step: RawGitHubWorkflowJobStep,
): GitHubWorkflowJobStepSummary {
    return {
        completedAt: step.completed_at ?? null,
        conclusion: mapWorkflowConclusion(step.conclusion),
        name: step.name ?? "Step",
        number: step.number ?? 0,
        startedAt: step.started_at ?? null,
        status: mapWorkflowStatus(step.status),
    };
}

function mapWorkflowArtifact(
    artifact: RawGitHubWorkflowArtifact,
): GitHubWorkflowArtifactSummary {
    return {
        archiveDownloadUrl: artifact.archive_download_url ?? "",
        createdAt: artifact.created_at ?? "",
        expired: artifact.expired ?? false,
        expiresAt: artifact.expires_at ?? null,
        id: artifact.id ?? 0,
        name: artifact.name ?? "Artifact",
        sizeInBytes: artifact.size_in_bytes ?? 0,
        updatedAt: artifact.updated_at ?? "",
        url: artifact.url ?? "",
    };
}

function mapCheckRunAnnotation(
    annotation: RawGitHubCheckRunAnnotation,
): GitHubCheckRunAnnotationSummary {
    return {
        annotationLevel: mapAnnotationLevel(annotation.annotation_level),
        blobHref: annotation.blob_href ?? null,
        endColumn: annotation.end_column ?? null,
        endLine: annotation.end_line ?? null,
        message: annotation.message ?? "",
        path: annotation.path ?? "",
        rawDetails: annotation.raw_details ?? null,
        startColumn: annotation.start_column ?? null,
        startLine: annotation.start_line ?? 0,
        title: annotation.title ?? null,
    };
}

function mapWorkflowStatus(
    status: string | null | undefined,
): GitHubWorkflowRunStatus {
    switch (status) {
        case "completed":
        case "in_progress":
        case "queued":
        case "requested":
        case "waiting":
            return status;
        default:
            return "unknown";
    }
}

function mapWorkflowConclusion(
    conclusion: string | null | undefined,
): GitHubWorkflowConclusion | null {
    switch (conclusion) {
        case null:
        case undefined:
        case "":
            return null;
        case "action_required":
        case "cancelled":
        case "failure":
        case "neutral":
        case "skipped":
        case "stale":
        case "success":
        case "timed_out":
            return conclusion;
        default:
            return "unknown";
    }
}

function mapAnnotationLevel(
    level: string | null | undefined,
): GitHubCheckRunAnnotationSummary["annotationLevel"] {
    switch (level) {
        case "failure":
        case "notice":
        case "warning":
            return level;
        default:
            return "notice";
    }
}

function parseCheckRunId(checkRunUrl: string | null | undefined): number | null {
    const match = checkRunUrl?.match(/\/check-runs\/(\d+)$/u);
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);

    return Number.isFinite(parsed) ? parsed : null;
}

function mapCommitStatusCheck(
    status: RawGitHubCommitStatus,
): GitHubPullRequestCheckSummary {
    const name = status.context?.trim() || "Commit status";
    const conclusion = mapCommitStatusConclusion(status.state);

    return {
        completedAt: status.updated_at ?? null,
        conclusion,
        detailsUrl: status.target_url ?? null,
        id: `status:${status.id ?? name}`,
        name,
        source: "status",
        startedAt: status.created_at ?? null,
        status: status.state === "pending" ? "pending" : "completed",
    };
}

function mapCheckRun(
    checkRun: RawGitHubCheckRun,
): GitHubPullRequestCheckSummary {
    return {
        completedAt: checkRun.completed_at ?? null,
        conclusion: mapCheckRunConclusion(checkRun.conclusion),
        detailsUrl: checkRun.details_url ?? checkRun.html_url ?? null,
        id: `check-run:${checkRun.id ?? checkRun.name ?? "unknown"}`,
        name: checkRun.name?.trim() || "Check run",
        source: "check_run",
        startedAt: checkRun.started_at ?? null,
        status: mapCheckRunStatus(checkRun.status),
    };
}

function mapCheckRunStatus(
    status: string | null | undefined,
): GitHubPullRequestCheckStatus {
    switch (status) {
        case "completed":
        case "in_progress":
        case "queued":
            return status;
        case "pending":
        case "requested":
        case "waiting":
            return "pending";
        default:
            return "unknown";
    }
}

function mapCommitStatusConclusion(
    state: string | null | undefined,
): GitHubPullRequestCheckConclusion | null {
    switch (state) {
        case "success":
            return "success";
        case "failure":
        case "error":
            return "failure";
        case "pending":
            return null;
        default:
            return "unknown";
    }
}

function mapCheckRunConclusion(
    conclusion: string | null | undefined,
): GitHubPullRequestCheckConclusion | null {
    switch (conclusion) {
        case null:
        case undefined:
        case "":
            return null;
        case "action_required":
        case "cancelled":
        case "failure":
        case "neutral":
        case "skipped":
        case "startup_failure":
        case "success":
        case "timed_out":
            return conclusion;
        default:
            return "unknown";
    }
}

function aggregateChecksState(
    checks: readonly GitHubPullRequestCheckSummary[],
): GitHubPullRequestChecksState {
    if (checks.length === 0) {
        return "unknown";
    }

    if (checks.some(isFailedCheck)) {
        return "failure";
    }

    if (checks.some(isPendingCheck)) {
        return "pending";
    }

    if (checks.every(isSuccessfulCheck)) {
        return "success";
    }

    return "unknown";
}

function isFailedCheck(check: GitHubPullRequestCheckSummary): boolean {
    return (
        check.conclusion === "action_required" ||
        check.conclusion === "cancelled" ||
        check.conclusion === "failure" ||
        check.conclusion === "startup_failure" ||
        check.conclusion === "timed_out"
    );
}

function isPendingCheck(check: GitHubPullRequestCheckSummary): boolean {
    return (
        check.status === "in_progress" ||
        check.status === "pending" ||
        check.status === "queued" ||
        (check.status !== "completed" && check.conclusion === null)
    );
}

function isSuccessfulCheck(check: GitHubPullRequestCheckSummary): boolean {
    return (
        check.status === "completed" &&
        (check.conclusion === "neutral" ||
            check.conclusion === "skipped" ||
            check.conclusion === "success")
    );
}

function compareChecks(
    left: GitHubPullRequestCheckSummary,
    right: GitHubPullRequestCheckSummary,
): number {
    if (left.source !== right.source) {
        return left.source === "check_run" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
}

function buildPullRequestChecksUrl(
    repository: GitHubRepositoryRef,
    number: number,
): string {
    const host = normalizeGitHubHost(repository.host);

    return `https://${host}/${repository.owner}/${repository.repo}/pull/${number}/checks`;
}

function isPresent<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
}
