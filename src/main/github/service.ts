import type { SecretStoreGateway } from "@main/ai/secret-store";
import { GitHubAuthStore, normalizeGitHubHost } from "@main/github/auth";
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
    GitHubCheckRunAnnotationsInput,
    GitHubCheckRunAnnotationsResult,
    GitHubWorkflowJobLogsInput,
    GitHubWorkflowJobLogsResult,
    GitHubWorkflowRunArtifactsInput,
    GitHubWorkflowRunArtifactsResult,
    GitHubWorkflowRunJobsInput,
    GitHubWorkflowRunJobsResult,
    GitHubWorkflowRunMutationInput,
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
    convertPullRequestToDraft(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail>;
    createIssue(input: GitHubCreateIssueInput): Promise<GitHubIssueDetail>;
    createPullRequest(
        input: GitHubCreatePullRequestInput,
    ): Promise<GitHubPullRequestDetail>;
    getAuthStatus(input: GitHubAuthStatusInput): Promise<GitHubAuthStatus>;
    getIssue(input: GitHubGetIssueInput): Promise<GitHubIssueDetail | null>;
    getPullRequest(
        input: GitHubGetPullRequestInput,
    ): Promise<GitHubPullRequestDetail | null>;
    listIssues(input: GitHubListIssuesInput): Promise<GitHubListIssuesResult>;
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
        const token = this.#authStore.loadToken(host);
        if (!token) {
            return createMissingAuthStatus(host);
        }

        return await new GitHubApiClient({
            fetch: this.#fetch,
            token,
        }).getAuthStatus(host);
    }

    async saveToken(input: GitHubSaveTokenInput): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(input.host);
        await this.#authStore.saveToken(host, input.token);

        return await this.getAuthStatus({ host });
    }

    async clearToken(input: GitHubClearTokenInput): Promise<GitHubAuthStatus> {
        const host = normalizeGitHubHost(input.host);
        await this.#authStore.clearToken(host);

        return createMissingAuthStatus(host);
    }

    async listIssues(
        input: GitHubListIssuesInput,
    ): Promise<GitHubListIssuesResult> {
        return await this.#createClient(input.repository.host).listIssues(input);
    }

    async getIssue(
        input: GitHubGetIssueInput,
    ): Promise<GitHubIssueDetail | null> {
        return await this.#createClient(input.repository.host).getIssue(input);
    }

    async createIssue(
        input: GitHubCreateIssueInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).createIssue(input),
        );
    }

    async commentIssue(
        input: GitHubCommentIssueInput,
    ): Promise<GitHubCommentSummary> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).commentIssue(input),
        );
    }

    async closeIssue(
        input: GitHubSetIssueStateInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).setIssueState({
                ...input,
                state: "closed",
            }),
        );
    }

    async reopenIssue(
        input: GitHubSetIssueStateInput,
    ): Promise<GitHubIssueDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).setIssueState({
                ...input,
                state: "open",
            }),
        );
    }

    async listPullRequests(
        input: GitHubListPullRequestsInput,
    ): Promise<GitHubListPullRequestsResult> {
        return await this.#createClient(input.repository.host).listPullRequests(
            input,
        );
    }

    async getPullRequest(
        input: GitHubGetPullRequestInput,
    ): Promise<GitHubPullRequestDetail | null> {
        return await this.#createClient(input.repository.host).getPullRequest(
            input,
        );
    }

    async listPullRequestChecks(
        input: GitHubPullRequestChecksInput,
    ): Promise<GitHubPullRequestChecksResult> {
        return await this.#createClient(
            input.repository.host,
        ).listPullRequestChecks(input);
    }

    async listWorkflowRuns(
        input: GitHubWorkflowRunsInput,
    ): Promise<GitHubWorkflowRunsResult> {
        return await this.#createClient(input.repository.host).listWorkflowRuns(
            input,
        );
    }

    async listWorkflowRunJobs(
        input: GitHubWorkflowRunJobsInput,
    ): Promise<GitHubWorkflowRunJobsResult> {
        return await this.#createClient(
            input.repository.host,
        ).listWorkflowRunJobs(input);
    }

    async getWorkflowJobLogs(
        input: GitHubWorkflowJobLogsInput,
    ): Promise<GitHubWorkflowJobLogsResult> {
        return await this.#createClient(input.repository.host).getWorkflowJobLogs(
            input,
        );
    }

    async listWorkflowRunArtifacts(
        input: GitHubWorkflowRunArtifactsInput,
    ): Promise<GitHubWorkflowRunArtifactsResult> {
        return await this.#createClient(
            input.repository.host,
        ).listWorkflowRunArtifacts(input);
    }

    async listCheckRunAnnotations(
        input: GitHubCheckRunAnnotationsInput,
    ): Promise<GitHubCheckRunAnnotationsResult> {
        return await this.#createClient(
            input.repository.host,
        ).listCheckRunAnnotations(input);
    }

    async createPullRequest(
        input: GitHubCreatePullRequestInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).createPullRequest(input),
        );
    }

    async commentPullRequest(
        input: GitHubCommentPullRequestInput,
    ): Promise<GitHubCommentSummary> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).commentPullRequest(input),
        );
    }

    async markPullRequestReady(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).setPullRequestDraftState({
                ...input,
                draft: false,
            }),
        );
    }

    async convertPullRequestToDraft(
        input: GitHubSetPullRequestDraftStateInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).setPullRequestDraftState({
                ...input,
                draft: true,
            }),
        );
    }

    async requestPullRequestReviewers(
        input: GitHubRequestPullRequestReviewInput,
    ): Promise<GitHubPullRequestDetail> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).requestPullRequestReviewers(
                input,
            ),
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
        return await this.#createClient(input.host).listNotifications(input);
    }

    async listReleases(
        input: GitHubListReleasesInput,
    ): Promise<GitHubListReleasesResult> {
        return await this.#createClient(input.repository.host).listReleases(
            input,
        );
    }

    async generateReleaseNotes(
        input: GitHubGenerateReleaseNotesInput,
    ): Promise<GitHubGeneratedReleaseNotes> {
        return await this.#createClient(
            input.repository.host,
        ).generateReleaseNotes(input);
    }

    async createRelease(
        input: GitHubCreateReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).createRelease(input),
        );
    }

    async publishRelease(
        input: GitHubPublishReleaseInput,
    ): Promise<GitHubReleaseSummary> {
        return await this.#dedupeMutation(input.clientRequestId, () =>
            this.#createClient(input.repository.host).publishRelease(input),
        );
    }

    async listMilestones(
        input: GitHubListMilestonesInput,
    ): Promise<GitHubListMilestonesResult> {
        return await this.#createClient(input.repository.host).listMilestones(
            input,
        );
    }

    #createClient(hostInput: string | null | undefined): GitHubApiClient {
        const host = normalizeGitHubHost(hostInput);
        const token = this.#authStore.loadToken(host);
        if (!token) {
            throw new GitHubApiError(
                "GitHub token is missing.",
                "missing_auth",
                null,
            );
        }

        return new GitHubApiClient({
            fetch: this.#fetch,
            token,
        });
    }

    async #withActionsWritePermission<T>(
        hostInput: string | null | undefined,
        run: (client: GitHubApiClient) => Promise<T>,
    ): Promise<T> {
        const host = normalizeGitHubHost(hostInput);
        const token = this.#authStore.loadToken(host);
        if (!token) {
            throw new GitHubApiError(
                "GitHub token is missing.",
                "missing_auth",
                null,
            );
        }
        const client = new GitHubApiClient({
            fetch: this.#fetch,
            token,
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
        user: null,
    };
}
