import type { SecretStoreGateway } from "@main/ai/secret-store";
import {
    GitHubAuthStore,
    loadGhCliToken,
    normalizeGitHubHost,
} from "@main/github/auth";
import {
    GitHubApiClient,
    GitHubApiError,
    type GitHubFetch,
} from "@main/github/client";
import type {
    GitHubAuthStatus,
    GitHubAuthStatusInput,
    GitHubClearTokenInput,
    GitHubCommentIssueInput,
    GitHubCommentPullRequestInput,
    GitHubCommentSummary,
    GitHubCreateIssueInput,
    GitHubCreatePullRequestInput,
    GitHubGetIssueInput,
    GitHubGetPullRequestInput,
    GitHubIssueDetail,
    GitHubListLabelsInput,
    GitHubListLabelsResult,
    GitHubListIssuesInput,
    GitHubListIssuesResult,
    GitHubListMilestonesInput,
    GitHubListMilestonesResult,
    GitHubListPullRequestsInput,
    GitHubListPullRequestsResult,
    GitHubListReleasesInput,
    GitHubListReleasesResult,
    GitHubNotificationsInput,
    GitHubNotificationsResult,
    GitHubPullRequestChecksInput,
    GitHubPullRequestChecksResult,
    GitHubPullRequestDetail,
    GitHubCreateReleaseInput,
    GitHubGeneratedReleaseNotes,
    GitHubGenerateReleaseNotesInput,
    GitHubPublishReleaseInput,
    GitHubReleaseSummary,
    GitHubRequestPullRequestReviewInput,
    GitHubSaveTokenInput,
    GitHubSetIssueStateInput,
    GitHubSetPullRequestDraftStateInput,
    GitHubUpdateCommentInput,
    GitHubUpdateIssueInput,
    GitHubUpdatePullRequestInput,
    GitHubCheckRunAnnotationsInput,
    GitHubCheckRunAnnotationsResult,
    GitHubWorkflowJobLogsInput,
    GitHubWorkflowJobLogsResult,
    GitHubWorkflowRunArtifactsInput,
    GitHubWorkflowRunArtifactsResult,
    GitHubWorkflowRunJobsInput,
    GitHubWorkflowRunJobsResult,
    GitHubWorkflowRunMutationInput,
    GitHubTokenSource,
    GitHubWorkflowRunsInput,
    GitHubWorkflowRunsResult,
} from "@shared/ipc";

export interface GitHubGateway {
    clearToken(input: GitHubClearTokenInput): Promise<GitHubAuthStatus>;
    closeIssue(input: GitHubSetIssueStateInput): Promise<GitHubIssueDetail>;
    commentIssue(
        input: GitHubCommentIssueInput,
    ): Promise<GitHubCommentSummary>;
    commentPullRequest(
        input: GitHubCommentPullRequestInput,
    ): Promise<GitHubCommentSummary>;
    updateComment(
        input: GitHubUpdateCommentInput,
    ): Promise<GitHubCommentSummary>;
    convertPullRequestToDraft(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail>;
    createIssue(input: GitHubCreateIssueInput): Promise<GitHubIssueDetail>;
    updateIssue(input: GitHubUpdateIssueInput): Promise<GitHubIssueDetail>;
    createPullRequest(
        input: GitHubCreatePullRequestInput,
    ): Promise<GitHubPullRequestDetail>;
    updatePullRequest(
        input: GitHubUpdatePullRequestInput,
    ): Promise<GitHubPullRequestDetail>;
    getAuthStatus(input: GitHubAuthStatusInput): Promise<GitHubAuthStatus>;
    getIssue(input: GitHubGetIssueInput): Promise<GitHubIssueDetail | null>;
    getPullRequest(
        input: GitHubGetPullRequestInput,
    ): Promise<GitHubPullRequestDetail | null>;
    listIssues(input: GitHubListIssuesInput): Promise<GitHubListIssuesResult>;
    listLabels(input: GitHubListLabelsInput): Promise<GitHubListLabelsResult>;
    listPullRequests(
        input: GitHubListPullRequestsInput,
    ): Promise<GitHubListPullRequestsResult>;
    listPullRequestChecks(
        input: GitHubPullRequestChecksInput,
    ): Promise<GitHubPullRequestChecksResult>;
    listWorkflowRuns(
        input: GitHubWorkflowRunsInput,
    ): Promise<GitHubWorkflowRunsResult>;
    listWorkflowRunJobs(
        input: GitHubWorkflowRunJobsInput,
    ): Promise<GitHubWorkflowRunJobsResult>;
    getWorkflowJobLogs(
        input: GitHubWorkflowJobLogsInput,
    ): Promise<GitHubWorkflowJobLogsResult>;
    listWorkflowRunArtifacts(
        input: GitHubWorkflowRunArtifactsInput,
    ): Promise<GitHubWorkflowRunArtifactsResult>;
    listCheckRunAnnotations(
        input: GitHubCheckRunAnnotationsInput,
    ): Promise<GitHubCheckRunAnnotationsResult>;
    rerunWorkflowRunFailedJobs(
        input: GitHubWorkflowRunMutationInput,
    ): Promise<void>;
    cancelWorkflowRun(input: GitHubWorkflowRunMutationInput): Promise<void>;
    listNotifications(
        input: GitHubNotificationsInput,
    ): Promise<GitHubNotificationsResult>;
    listReleases(input: GitHubListReleasesInput): Promise<GitHubListReleasesResult>;
    generateReleaseNotes(
        input: GitHubGenerateReleaseNotesInput,
    ): Promise<GitHubGeneratedReleaseNotes>;
    createRelease(input: GitHubCreateReleaseInput): Promise<GitHubReleaseSummary>;
    publishRelease(input: GitHubPublishReleaseInput): Promise<GitHubReleaseSummary>;
    listMilestones(
        input: GitHubListMilestonesInput,
    ): Promise<GitHubListMilestonesResult>;
    markPullRequestReady(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail>;
    reopenIssue(input: GitHubSetIssueStateInput): Promise<GitHubIssueDetail>;
    requestPullRequestReviewers(
        input: GitHubRequestPullRequestReviewInput,
    ): Promise<GitHubPullRequestDetail>;
    saveToken(input: GitHubSaveTokenInput): Promise<GitHubAuthStatus>;
}

interface GitHubServiceOptions {
    readonly fetch?: GitHubFetch;
    readonly secretStore: SecretStoreGateway;
}

export class GitHubService implements GitHubGateway {
    readonly #authStore: GitHubAuthStore;
    readonly #fetch?: GitHubFetch;
    readonly #mutationsByRequestId = new Map<string, Promise<unknown>>();

    constructor(options: GitHubServiceOptions) {
        this.#authStore = new GitHubAuthStore(options.secretStore);
        this.#fetch = options.fetch;
    }

    async getAuthStatus(
        input: GitHubAuthStatusInput,
    ): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(input.host);
        const resolved = await this.#resolveToken(host);
        if (!resolved) {
            return createMissingAuthStatus(host);
        }

        const status = await new GitHubApiClient({
            fetch: this.#fetch,
            token: resolved.token,
        }).getAuthStatus(host);
        return { ...status, tokenSource: resolved.source };
    }

    async saveToken(input: GitHubSaveTokenInput): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(input.host);
        await this.#authStore.saveToken(host, input.token);

        return await this.getAuthStatus({ host });
    }

    async clearToken(input: GitHubClearTokenInput): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(input.host);
        await this.#authStore.clearToken(host);

        return await this.getAuthStatus({ host });
    }

    async listIssues(
        input: GitHubListIssuesInput,
    ): Promise<GitHubListIssuesResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listIssues(input);
    }

    async listLabels(
        input: GitHubListLabelsInput,
    ): Promise<GitHubListLabelsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listLabels(input);
    }

    async getIssue(
        input: GitHubGetIssueInput,
    ): Promise<GitHubIssueDetail | null> {
        return await (await this.#createClient(input.repository.host)).getIssue(
            input,
        );
    }

    async createIssue(
        input: GitHubCreateIssueInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).createIssue(input),
        );
    }

    async updateIssue(
        input: GitHubUpdateIssueInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).updateIssue(input),
        );
    }

    async commentIssue(
        input: GitHubCommentIssueInput,
    ): Promise<GitHubCommentSummary> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).commentIssue(input),
        );
    }

    async closeIssue(
        input: GitHubSetIssueStateInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).setIssueState({
                ...input,
                state: "closed",
            }),
        );
    }

    async reopenIssue(
        input: GitHubSetIssueStateInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).setIssueState({
                ...input,
                state: "open",
            }),
        );
    }

    async listPullRequests(
        input: GitHubListPullRequestsInput,
    ): Promise<GitHubListPullRequestsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listPullRequests(input);
    }

    async getPullRequest(
        input: GitHubGetPullRequestInput,
    ): Promise<GitHubPullRequestDetail | null> {
        return await (
            await this.#createClient(input.repository.host)
        ).getPullRequest(input);
    }

    async listPullRequestChecks(
        input: GitHubPullRequestChecksInput,
    ): Promise<GitHubPullRequestChecksResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listPullRequestChecks(input);
    }

    async listWorkflowRuns(
        input: GitHubWorkflowRunsInput,
    ): Promise<GitHubWorkflowRunsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listWorkflowRuns(input);
    }

    async listWorkflowRunJobs(
        input: GitHubWorkflowRunJobsInput,
    ): Promise<GitHubWorkflowRunJobsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listWorkflowRunJobs(input);
    }

    async getWorkflowJobLogs(
        input: GitHubWorkflowJobLogsInput,
    ): Promise<GitHubWorkflowJobLogsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).getWorkflowJobLogs(input);
    }

    async listWorkflowRunArtifacts(
        input: GitHubWorkflowRunArtifactsInput,
    ): Promise<GitHubWorkflowRunArtifactsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listWorkflowRunArtifacts(input);
    }

    async listCheckRunAnnotations(
        input: GitHubCheckRunAnnotationsInput,
    ): Promise<GitHubCheckRunAnnotationsResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listCheckRunAnnotations(input);
    }

    async createPullRequest(
        input: GitHubCreatePullRequestInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).createPullRequest(
                input,
            ),
        );
    }

    async updatePullRequest(
        input: GitHubUpdatePullRequestInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).updatePullRequest(
                input,
            ),
        );
    }

    async commentPullRequest(
        input: GitHubCommentPullRequestInput,
    ): Promise<GitHubCommentSummary> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).commentPullRequest(
                input,
            ),
        );
    }

    async updateComment(
        input: GitHubUpdateCommentInput,
    ): Promise<GitHubCommentSummary> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).updateComment(input),
        );
    }

    async markPullRequestReady(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (
                await this.#createClient(input.repository.host)
            ).setPullRequestDraftState({
                ...input,
                draft: false,
            }),
        );
    }

    async convertPullRequestToDraft(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (
                await this.#createClient(input.repository.host)
            ).setPullRequestDraftState({
                ...input,
                draft: true,
            }),
        );
    }

    async requestPullRequestReviewers(
        input: GitHubRequestPullRequestReviewInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (
                await this.#createClient(input.repository.host)
            ).requestPullRequestReviewers(input),
        );
    }

    async rerunWorkflowRunFailedJobs(
        input: GitHubWorkflowRunMutationInput,
    ): Promise<void> {
        await this.#dedupeMutation(input.clientRequestId, () =>
            this.#withActionsWritePermission(input.repository.host, (client) =>
                client.rerunWorkflowRunFailedJobs(input),
            ),
        );
    }

    async cancelWorkflowRun(
        input: GitHubWorkflowRunMutationInput,
    ): Promise<void> {
        await this.#dedupeMutation(input.clientRequestId, () =>
            this.#withActionsWritePermission(input.repository.host, (client) =>
                client.cancelWorkflowRun(input),
            ),
        );
    }

    async listNotifications(
        input: GitHubNotificationsInput,
    ): Promise<GitHubNotificationsResult> {
        return await (await this.#createClient(input.host)).listNotifications(
            input,
        );
    }

    async listReleases(
        input: GitHubListReleasesInput,
    ): Promise<GitHubListReleasesResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listReleases(input);
    }

    async generateReleaseNotes(
        input: GitHubGenerateReleaseNotesInput,
    ): Promise<GitHubGeneratedReleaseNotes> {
        return await (
            await this.#createClient(input.repository.host)
        ).generateReleaseNotes(input);
    }

    async createRelease(
        input: GitHubCreateReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).createRelease(input),
        );
    }

    async publishRelease(
        input: GitHubPublishReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        return await this.#dedupeMutation(input.clientRequestId, async () =>
            (await this.#createClient(input.repository.host)).publishRelease(input),
        );
    }

    async listMilestones(
        input: GitHubListMilestonesInput,
    ): Promise<GitHubListMilestonesResult> {
        return await (
            await this.#createClient(input.repository.host)
        ).listMilestones(input);
    }

    async #resolveToken(
        host: string,
    ): Promise<{ token: string; source: GitHubTokenSource } | null> {
        const storedToken = this.#authStore.loadToken(host);
        if (storedToken) {
            return { token: storedToken, source: "stored_token" };
        }
        const ghCliToken = await loadGhCliToken(host);
        if (ghCliToken) {
            return { token: ghCliToken, source: "gh_cli" };
        }
        return null;
    }

    async #createClient(
        hostInput: string | null | undefined,
    ): Promise<GitHubApiClient> {
        const host = normalizeGitHubHost(hostInput);
        const resolved = await this.#resolveToken(host);
        if (!resolved) {
            throw new GitHubApiError(
                "GitHub token is missing.",
                "missing_auth",
                null,
            );
        }

        return new GitHubApiClient({
            fetch: this.#fetch,
            token: resolved.token,
        });
    }

    async #withActionsWritePermission<T>(
        hostInput: string | null | undefined,
        run: (client: GitHubApiClient) => Promise<T>,
    ): Promise<T> {
        const host = normalizeGitHubHost(hostInput);
        const resolved = await this.#resolveToken(host);
        if (!resolved) {
            throw new GitHubApiError(
                "GitHub token is missing.",
                "missing_auth",
                null,
            );
        }
        const client = new GitHubApiClient({
            fetch: this.#fetch,
            token: resolved.token,
        });
        const status = await client.getAuthStatus(host);
        if (status.state !== "authenticated" || !status.canWriteActions) {
            throw new GitHubApiError(
                "GitHub token cannot write Actions runs.",
                "forbidden",
                403,
            );
        }

        return await run(client);
    }

    async #dedupeMutation<T>(
        clientRequestId: string | null | undefined,
        run: () => Promise<T>,
    ): Promise<T> {
        if (!clientRequestId) {
            return await run();
        }

        const existing = this.#mutationsByRequestId.get(clientRequestId);
        if (existing) {
            return (await existing) as T;
        }

        const next = run();
        this.#mutationsByRequestId.set(clientRequestId, next);
        try {
            return await next;
        } finally {
            this.#mutationsByRequestId.delete(clientRequestId);
        }
    }
}

function createMissingAuthStatus(host: string): GitHubAuthStatus {
    return {
        canReadActions: false,
        canWriteActions: false,
        canWriteIssues: false,
        canWritePullRequests: false,
        checkedAt: new Date().toISOString(),
        errorCode: "missing_auth",
        host,
        readOnly: true,
        state: "missing",
        tokenSource: null,
        user: null,
    };
}
