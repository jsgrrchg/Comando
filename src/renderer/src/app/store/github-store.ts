import { create } from "zustand";

import type {
    GitHubAuthStatus,
    GitHubCommentSummary,
    GitHubCreateIssueInput,
    GitHubCreatePullRequestInput,
    GitHubGetIssueInput,
    GitHubGetPullRequestInput,
    GitHubIssueDetail,
    GitHubIssueSummary,
    GitHubListIssuesInput,
    GitHubMilestoneSummary,
    GitHubNotificationSummary,
    GitHubListPullRequestsInput,
    GitHubCreateReleaseInput,
    GitHubGenerateReleaseNotesInput,
    GitHubReleaseSummary,
    GitHubPullRequestChecksResult,
    GitHubPullRequestDetail,
    GitHubPullRequestSummary,
    GitHubRequestPullRequestReviewInput,
    GitHubRepositoryRef,
    GitHubCheckRunAnnotationSummary,
    GitHubWorkflowArtifactSummary,
    GitHubWorkflowJobSummary,
    GitHubWorkflowRunSummary,
} from "@shared/ipc";

type GitHubListIssuesOptions = Omit<
    GitHubListIssuesInput,
    "repository"
>;
type GitHubListPullRequestsOptions = Omit<
    GitHubListPullRequestsInput,
    "repository"
>;
type GitHubIssueListState = NonNullable<GitHubListIssuesInput["state"]>;
type GitHubPullRequestListState = NonNullable<
    GitHubListPullRequestsInput["state"]
>;
type GitHubCreateIssueOptions = Omit<
    GitHubCreateIssueInput,
    "clientRequestId" | "repository"
>;
type GitHubCreatePullRequestOptions = Omit<
    GitHubCreatePullRequestInput,
    "clientRequestId" | "repository"
>;
type GitHubCreateReleaseOptions = Omit<
    GitHubCreateReleaseInput,
    "clientRequestId" | "repository"
>;
type GitHubGenerateReleaseNotesOptions = Omit<
    GitHubGenerateReleaseNotesInput,
    "repository"
>;
type GitHubRequestPullRequestReviewOptions = Omit<
    GitHubRequestPullRequestReviewInput,
    "clientRequestId" | "number" | "repository"
>;

export interface GitHubStoreState {
    readonly authStatusByHost: Record<string, GitHubAuthStatus>;
    readonly errors: Record<string, string | null>;
    readonly issueDetailsByRepo: Record<
        string,
        Record<number, GitHubIssueDetail | null>
    >;
    readonly issueListStateByRepo: Record<string, GitHubIssueListState>;
    readonly issuesByRepo: Record<string, readonly GitHubIssueSummary[]>;
    readonly loadingKeys: Record<string, boolean>;
    readonly mutatingKeys: Record<string, boolean>;
    readonly pullRequestDetailsByRepo: Record<
        string,
        Record<number, GitHubPullRequestDetail | null>
    >;
    readonly pullRequestChecksByRepo: Record<
        string,
        Record<string, GitHubPullRequestChecksResult | null>
    >;
    readonly pullRequestsByRepo: Record<
        string,
        readonly GitHubPullRequestSummary[]
    >;
    readonly pullRequestListStateByRepo: Record<
        string,
        GitHubPullRequestListState
    >;
    readonly workflowRunsByRepo: Record<
        string,
        Record<string, readonly GitHubWorkflowRunSummary[]>
    >;
    readonly workflowRunJobsByRepo: Record<
        string,
        Record<number, readonly GitHubWorkflowJobSummary[]>
    >;
    readonly workflowJobLogsByRepo: Record<string, Record<number, string>>;
    readonly workflowRunArtifactsByRepo: Record<
        string,
        Record<number, readonly GitHubWorkflowArtifactSummary[]>
    >;
    readonly checkRunAnnotationsByRepo: Record<
        string,
        Record<number, readonly GitHubCheckRunAnnotationSummary[]>
    >;
    readonly notificationsByHost: Record<
        string,
        readonly GitHubNotificationSummary[]
    >;
    readonly releasesByRepo: Record<string, readonly GitHubReleaseSummary[]>;
    readonly generatedReleaseNotesByRepo: Record<
        string,
        Record<string, { readonly body: string; readonly name: string }>
    >;
    readonly milestonesByRepo: Record<string, readonly GitHubMilestoneSummary[]>;
    clearRepoCache: (ref: GitHubRepositoryRef) => void;
    closeIssue: (
        ref: GitHubRepositoryRef,
        number: number,
    ) => Promise<GitHubIssueDetail>;
    commentIssue: (
        ref: GitHubRepositoryRef,
        number: number,
        body: string,
    ) => Promise<GitHubCommentSummary>;
    commentPullRequest: (
        ref: GitHubRepositoryRef,
        number: number,
        body: string,
    ) => Promise<GitHubCommentSummary>;
    convertPullRequestToDraft: (
        ref: GitHubRepositoryRef,
        number: number,
    ) => Promise<GitHubPullRequestDetail>;
    createIssue: (
        ref: GitHubRepositoryRef,
        input: GitHubCreateIssueOptions,
    ) => Promise<GitHubIssueDetail>;
    createPullRequest: (
        ref: GitHubRepositoryRef,
        input: GitHubCreatePullRequestOptions,
    ) => Promise<GitHubPullRequestDetail>;
    ensureIssueDetail: (
        ref: GitHubRepositoryRef,
        number: number,
        options?: { readonly force?: boolean },
    ) => Promise<GitHubIssueDetail | null>;
    ensurePullRequestDetail: (
        ref: GitHubRepositoryRef,
        number: number,
        options?: { readonly force?: boolean },
    ) => Promise<GitHubPullRequestDetail | null>;
    markPullRequestReady: (
        ref: GitHubRepositoryRef,
        number: number,
    ) => Promise<GitHubPullRequestDetail>;
    refreshAuthStatus: (
        refOrHost: GitHubRepositoryRef | string,
    ) => Promise<GitHubAuthStatus>;
    refreshIssues: (
        ref: GitHubRepositoryRef,
        options?: GitHubListIssuesOptions,
    ) => Promise<readonly GitHubIssueSummary[]>;
    refreshPullRequests: (
        ref: GitHubRepositoryRef,
        options?: GitHubListPullRequestsOptions,
    ) => Promise<readonly GitHubPullRequestSummary[]>;
    refreshPullRequestChecks: (
        ref: GitHubRepositoryRef,
        input: {
            readonly headSha: string;
            readonly pullRequestNumber: number;
        },
        options?: { readonly force?: boolean },
    ) => Promise<GitHubPullRequestChecksResult | null>;
    refreshWorkflowRuns: (
        ref: GitHubRepositoryRef,
        input: {
            readonly branch?: string | null;
            readonly headSha: string;
            readonly limit?: number | null;
        },
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubWorkflowRunSummary[]>;
    refreshWorkflowRunJobs: (
        ref: GitHubRepositoryRef,
        runId: number,
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubWorkflowJobSummary[]>;
    refreshWorkflowJobLogs: (
        ref: GitHubRepositoryRef,
        jobId: number,
        options?: { readonly force?: boolean },
    ) => Promise<string>;
    refreshWorkflowRunArtifacts: (
        ref: GitHubRepositoryRef,
        runId: number,
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubWorkflowArtifactSummary[]>;
    refreshCheckRunAnnotations: (
        ref: GitHubRepositoryRef,
        checkRunId: number,
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubCheckRunAnnotationSummary[]>;
    rerunWorkflowRunFailedJobs: (
        ref: GitHubRepositoryRef,
        runId: number,
    ) => Promise<void>;
    cancelWorkflowRun: (
        ref: GitHubRepositoryRef,
        runId: number,
    ) => Promise<void>;
    refreshNotifications: (
        refOrHost: GitHubRepositoryRef | string,
        options?: { readonly all?: boolean | null; readonly participating?: boolean | null },
    ) => Promise<readonly GitHubNotificationSummary[]>;
    refreshReleases: (
        ref: GitHubRepositoryRef,
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubReleaseSummary[]>;
    generateReleaseNotes: (
        ref: GitHubRepositoryRef,
        input: GitHubGenerateReleaseNotesOptions,
    ) => Promise<{ readonly body: string; readonly name: string }>;
    createRelease: (
        ref: GitHubRepositoryRef,
        input: GitHubCreateReleaseOptions,
    ) => Promise<GitHubReleaseSummary>;
    publishRelease: (
        ref: GitHubRepositoryRef,
        releaseId: number,
    ) => Promise<GitHubReleaseSummary>;
    refreshMilestones: (
        ref: GitHubRepositoryRef,
        options?: { readonly force?: boolean },
    ) => Promise<readonly GitHubMilestoneSummary[]>;
    reopenIssue: (
        ref: GitHubRepositoryRef,
        number: number,
    ) => Promise<GitHubIssueDetail>;
    requestPullRequestReviewers: (
        ref: GitHubRepositoryRef,
        number: number,
        input: GitHubRequestPullRequestReviewOptions,
    ) => Promise<GitHubPullRequestDetail>;
}

type SetGitHubState = (
    partial:
        | Partial<GitHubStoreState>
        | ((state: GitHubStoreState) => Partial<GitHubStoreState>),
) => void;

const inFlightMutations = new Map<string, Promise<unknown>>();

export const EMPTY_GITHUB_LIST: readonly never[] = Object.freeze([]);
export const EMPTY_GITHUB_RECORD: Readonly<Record<string, never>> =
    Object.freeze({});

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
    authStatusByHost: {},
    errors: {},
    issueDetailsByRepo: {},
    issueListStateByRepo: {},
    issuesByRepo: {},
    loadingKeys: {},
    mutatingKeys: {},
    pullRequestDetailsByRepo: {},
    pullRequestChecksByRepo: {},
    pullRequestListStateByRepo: {},
    pullRequestsByRepo: {},
    workflowRunsByRepo: {},
    workflowRunJobsByRepo: {},
    workflowJobLogsByRepo: {},
    workflowRunArtifactsByRepo: {},
    checkRunAnnotationsByRepo: {},
    notificationsByHost: {},
    releasesByRepo: {},
    generatedReleaseNotesByRepo: {},
    milestonesByRepo: {},

    clearRepoCache: (ref) => {
        const repoKey = getRepoKey(ref);
        set((state) => ({
            errors: omitKeysWithPrefix(state.errors, repoKey),
            issueDetailsByRepo: omitKey(state.issueDetailsByRepo, repoKey),
            issueListStateByRepo: omitKey(
                state.issueListStateByRepo,
                repoKey,
            ),
            issuesByRepo: omitKey(state.issuesByRepo, repoKey),
            loadingKeys: omitKeysWithPrefix(state.loadingKeys, repoKey),
            mutatingKeys: omitKeysWithPrefix(state.mutatingKeys, repoKey),
            pullRequestDetailsByRepo: omitKey(
                state.pullRequestDetailsByRepo,
                repoKey,
            ),
            pullRequestChecksByRepo: omitKey(
                state.pullRequestChecksByRepo,
                repoKey,
            ),
            pullRequestListStateByRepo: omitKey(
                state.pullRequestListStateByRepo,
                repoKey,
            ),
            pullRequestsByRepo: omitKey(state.pullRequestsByRepo, repoKey),
            workflowRunsByRepo: omitKey(state.workflowRunsByRepo, repoKey),
            workflowRunJobsByRepo: omitKey(
                state.workflowRunJobsByRepo,
                repoKey,
            ),
            workflowJobLogsByRepo: omitKey(
                state.workflowJobLogsByRepo,
                repoKey,
            ),
            workflowRunArtifactsByRepo: omitKey(
                state.workflowRunArtifactsByRepo,
                repoKey,
            ),
            checkRunAnnotationsByRepo: omitKey(
                state.checkRunAnnotationsByRepo,
                repoKey,
            ),
            generatedReleaseNotesByRepo: omitKey(
                state.generatedReleaseNotesByRepo,
                repoKey,
            ),
            milestonesByRepo: omitKey(state.milestonesByRepo, repoKey),
            releasesByRepo: omitKey(state.releasesByRepo, repoKey),
        }));
    },

    closeIssue: async (ref, number) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `issue:${number}:close`,
            async (clientRequestId) => {
                const detail = await getComandoApi().closeGitHubIssue({
                    clientRequestId,
                    number,
                    repository: ref,
                    state: "closed",
                });
                setIssueDetail(set, ref, detail);
                return detail;
            },
        ),

    commentIssue: async (ref, number, body) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `issue:${number}:comment`,
            async (clientRequestId) => {
                const comment = await getComandoApi().commentGitHubIssue({
                    body,
                    clientRequestId,
                    number,
                    repository: ref,
                });
                appendIssueComment(set, ref, number, comment);
                return comment;
            },
        ),

    commentPullRequest: async (ref, number, body) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `pr:${number}:comment`,
            async (clientRequestId) => {
                const comment = await getComandoApi().commentGitHubPullRequest({
                    body,
                    clientRequestId,
                    number,
                    repository: ref,
                });
                appendPullRequestComment(set, ref, number, comment);
                return comment;
            },
        ),

    convertPullRequestToDraft: async (ref, number) =>
        updatePullRequestDraftState(set, ref, number, true),

    createIssue: async (ref, input) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            "issue:create",
            async (clientRequestId) => {
                const detail = await getComandoApi().createGitHubIssue({
                    ...input,
                    clientRequestId,
                    repository: ref,
                });
                upsertIssue(set, ref, detail);
                setIssueDetail(set, ref, detail);
                return detail;
            },
        ),

    createPullRequest: async (ref, input) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            "pr:create",
            async (clientRequestId) => {
                const detail = await getComandoApi().createGitHubPullRequest({
                    ...input,
                    clientRequestId,
                    repository: ref,
                });
                upsertPullRequest(set, ref, detail);
                setPullRequestDetail(set, ref, detail);
                return detail;
            },
        ),

    ensureIssueDetail: async (ref, number, options = {}) => {
        const repoKey = getRepoKey(ref);
        const cached = get().issueDetailsByRepo[repoKey]?.[number];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(
            set,
            `${repoKey}:issue:${number}`,
            async () => {
                const detail = await getComandoApi().getGitHubIssue({
                    number,
                    repository: ref,
                } satisfies GitHubGetIssueInput);
                set((state) => ({
                    issueDetailsByRepo: {
                        ...state.issueDetailsByRepo,
                        [repoKey]: {
                            ...(state.issueDetailsByRepo[repoKey] ?? {}),
                            [number]: detail,
                        },
                    },
                }));
                if (detail) {
                    upsertIssue(set, ref, detail);
                }
                return detail;
            },
        );
    },

    ensurePullRequestDetail: async (ref, number, options = {}) => {
        const repoKey = getRepoKey(ref);
        const cached = get().pullRequestDetailsByRepo[repoKey]?.[number];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, `${repoKey}:pr:${number}`, async () => {
            const detail = await getComandoApi().getGitHubPullRequest({
                number,
                repository: ref,
            } satisfies GitHubGetPullRequestInput);
            set((state) => ({
                pullRequestDetailsByRepo: {
                    ...state.pullRequestDetailsByRepo,
                    [repoKey]: {
                        ...(state.pullRequestDetailsByRepo[repoKey] ?? {}),
                        [number]: detail,
                    },
                },
            }));
            if (detail) {
                upsertPullRequest(set, ref, detail);
            }
            return detail;
        });
    },

    markPullRequestReady: async (ref, number) =>
        updatePullRequestDraftState(set, ref, number, false),

    refreshAuthStatus: async (refOrHost) => {
        const host =
            typeof refOrHost === "string" ? refOrHost : normalizeHost(refOrHost.host);
        return await withLoading(set, `auth:${host}`, async () => {
            const status = await getComandoApi().getGitHubAuthStatus({ host });
            set((state) => ({
                authStatusByHost: {
                    ...state.authStatusByHost,
                    [host]: status,
                },
            }));
            return status;
        });
    },

    refreshIssues: async (ref, options = {}) => {
        const repoKey = getRepoKey(ref);
        const listState = normalizeGitHubIssueListState(options.state);
        return await withLoading(set, `${repoKey}:issues`, async () => {
            const result = await getComandoApi().listGitHubIssues({
                ...options,
                repository: ref,
            });
            set((state) => ({
                issueListStateByRepo: {
                    ...state.issueListStateByRepo,
                    [repoKey]: listState,
                },
                issuesByRepo: {
                    ...state.issuesByRepo,
                    [repoKey]: result.issues,
                },
            }));
            return result.issues;
        });
    },

    refreshPullRequests: async (ref, options = {}) => {
        const repoKey = getRepoKey(ref);
        const listState = normalizeGitHubPullRequestListState(options.state);
        return await withLoading(set, `${repoKey}:prs`, async () => {
            const result = await getComandoApi().listGitHubPullRequests({
                ...options,
                repository: ref,
            });
            set((state) => ({
                pullRequestListStateByRepo: {
                    ...state.pullRequestListStateByRepo,
                    [repoKey]: listState,
                },
                pullRequestsByRepo: {
                    ...state.pullRequestsByRepo,
                    [repoKey]: result.pullRequests,
                },
            }));
            return result.pullRequests;
        });
    },

    refreshPullRequestChecks: async (ref, input, options = {}) => {
        const repoKey = getRepoKey(ref);
        const checksKey = getPullRequestChecksKey(repoKey, input.headSha);
        const cached = get().pullRequestChecksByRepo[repoKey]?.[input.headSha];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, checksKey, async () => {
            const result = await getComandoApi().listGitHubPullRequestChecks({
                ...input,
                repository: ref,
            });
            set((state) => ({
                pullRequestChecksByRepo: {
                    ...state.pullRequestChecksByRepo,
                    [repoKey]: {
                        ...(state.pullRequestChecksByRepo[repoKey] ?? {}),
                        [input.headSha]: result,
                    },
                },
            }));
            return result;
        });
    },

    refreshWorkflowRuns: async (ref, input, options = {}) => {
        const repoKey = getRepoKey(ref);
        const runsKey = getWorkflowRunsKey(repoKey, input.headSha);
        const cached = get().workflowRunsByRepo[repoKey]?.[input.headSha];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, runsKey, async () => {
            const result = await getComandoApi().listGitHubWorkflowRuns({
                branch: input.branch ?? null,
                headSha: input.headSha,
                limit: input.limit ?? 20,
                repository: ref,
            });
            set((state) => ({
                workflowRunsByRepo: {
                    ...state.workflowRunsByRepo,
                    [repoKey]: {
                        ...(state.workflowRunsByRepo[repoKey] ?? {}),
                        [input.headSha]: result.runs,
                    },
                },
            }));
            return result.runs;
        });
    },

    refreshWorkflowRunJobs: async (ref, runId, options = {}) => {
        const repoKey = getRepoKey(ref);
        const jobsKey = getWorkflowRunJobsKey(repoKey, runId);
        const cached = get().workflowRunJobsByRepo[repoKey]?.[runId];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, jobsKey, async () => {
            const result = await getComandoApi().listGitHubWorkflowRunJobs({
                limit: 100,
                repository: ref,
                runId,
            });
            set((state) => ({
                workflowRunJobsByRepo: {
                    ...state.workflowRunJobsByRepo,
                    [repoKey]: {
                        ...(state.workflowRunJobsByRepo[repoKey] ?? {}),
                        [runId]: result.jobs,
                    },
                },
            }));
            return result.jobs;
        });
    },

    refreshWorkflowJobLogs: async (ref, jobId, options = {}) => {
        const repoKey = getRepoKey(ref);
        const logsKey = getWorkflowJobLogsKey(repoKey, jobId);
        const cached = get().workflowJobLogsByRepo[repoKey]?.[jobId];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, logsKey, async () => {
            const result = await getComandoApi().getGitHubWorkflowJobLogs({
                jobId,
                repository: ref,
            });
            set((state) => ({
                workflowJobLogsByRepo: {
                    ...state.workflowJobLogsByRepo,
                    [repoKey]: {
                        ...(state.workflowJobLogsByRepo[repoKey] ?? {}),
                        [jobId]: result.logs,
                    },
                },
            }));
            return result.logs;
        });
    },

    refreshWorkflowRunArtifacts: async (ref, runId, options = {}) => {
        const repoKey = getRepoKey(ref);
        const artifactsKey = getWorkflowRunArtifactsKey(repoKey, runId);
        const cached = get().workflowRunArtifactsByRepo[repoKey]?.[runId];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, artifactsKey, async () => {
            const result = await getComandoApi().listGitHubWorkflowRunArtifacts({
                limit: 100,
                repository: ref,
                runId,
            });
            set((state) => ({
                workflowRunArtifactsByRepo: {
                    ...state.workflowRunArtifactsByRepo,
                    [repoKey]: {
                        ...(state.workflowRunArtifactsByRepo[repoKey] ?? {}),
                        [runId]: result.artifacts,
                    },
                },
            }));
            return result.artifacts;
        });
    },

    refreshCheckRunAnnotations: async (ref, checkRunId, options = {}) => {
        const repoKey = getRepoKey(ref);
        const annotationsKey = getCheckRunAnnotationsKey(repoKey, checkRunId);
        const cached =
            get().checkRunAnnotationsByRepo[repoKey]?.[checkRunId];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, annotationsKey, async () => {
            const result = await getComandoApi().listGitHubCheckRunAnnotations({
                checkRunId,
                limit: 100,
                repository: ref,
            });
            set((state) => ({
                checkRunAnnotationsByRepo: {
                    ...state.checkRunAnnotationsByRepo,
                    [repoKey]: {
                        ...(state.checkRunAnnotationsByRepo[repoKey] ?? {}),
                        [checkRunId]: result.annotations,
                    },
                },
            }));
            return result.annotations;
        });
    },

    rerunWorkflowRunFailedJobs: async (ref, runId) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `actions:${runId}:rerun-failed`,
            async (clientRequestId) => {
                await getComandoApi().rerunGitHubWorkflowRunFailedJobs({
                    clientRequestId,
                    repository: ref,
                    runId,
                });
            },
        ),

    cancelWorkflowRun: async (ref, runId) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `actions:${runId}:cancel`,
            async (clientRequestId) => {
                await getComandoApi().cancelGitHubWorkflowRun({
                    clientRequestId,
                    repository: ref,
                    runId,
                });
            },
        ),

    refreshNotifications: async (refOrHost, options = {}) => {
        const host =
            typeof refOrHost === "string" ? normalizeHost(refOrHost) : normalizeHost(refOrHost.host);
        return await withLoading(set, `notifications:${host}`, async () => {
            const result = await getComandoApi().listGitHubNotifications({
                all: options.all ?? false,
                host,
                limit: 50,
                participating: options.participating ?? null,
            });
            set((state) => ({
                notificationsByHost: {
                    ...state.notificationsByHost,
                    [host]: result.notifications,
                },
            }));
            return result.notifications;
        });
    },

    refreshReleases: async (ref, options = {}) => {
        const repoKey = getRepoKey(ref);
        const cached = get().releasesByRepo[repoKey];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, `${repoKey}:releases`, async () => {
            const result = await getComandoApi().listGitHubReleases({
                limit: 50,
                repository: ref,
            });
            set((state) => ({
                releasesByRepo: {
                    ...state.releasesByRepo,
                    [repoKey]: result.releases,
                },
            }));
            return result.releases;
        });
    },

    generateReleaseNotes: async (ref, input) => {
        const repoKey = getRepoKey(ref);
        const notesKey = `${repoKey}:release-notes:${input.tagName}`;
        return await withLoading(set, notesKey, async () => {
            const result = await getComandoApi().generateGitHubReleaseNotes({
                ...input,
                repository: ref,
            });
            const notes = { body: result.body, name: result.name };
            set((state) => ({
                generatedReleaseNotesByRepo: {
                    ...state.generatedReleaseNotesByRepo,
                    [repoKey]: {
                        ...(state.generatedReleaseNotesByRepo[repoKey] ?? {}),
                        [input.tagName]: notes,
                    },
                },
            }));
            return notes;
        });
    },

    createRelease: async (ref, input) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `release:create:${input.tagName}`,
            async (clientRequestId) => {
                const release = await getComandoApi().createGitHubRelease({
                    ...input,
                    clientRequestId,
                    repository: ref,
                });
                upsertRelease(set, ref, release);
                return release;
            },
        ),

    publishRelease: async (ref, releaseId) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `release:${releaseId}:publish`,
            async (clientRequestId) => {
                const release = await getComandoApi().publishGitHubRelease({
                    clientRequestId,
                    releaseId,
                    repository: ref,
                });
                upsertRelease(set, ref, release);
                return release;
            },
        ),

    refreshMilestones: async (ref, options = {}) => {
        const repoKey = getRepoKey(ref);
        const cached = get().milestonesByRepo[repoKey];
        if (!options.force && cached !== undefined) {
            return cached;
        }

        return await withLoading(set, `${repoKey}:milestones`, async () => {
            const result = await getComandoApi().listGitHubMilestones({
                limit: 100,
                repository: ref,
                state: "all",
            });
            set((state) => ({
                milestonesByRepo: {
                    ...state.milestonesByRepo,
                    [repoKey]: result.milestones,
                },
            }));
            return result.milestones;
        });
    },

    reopenIssue: async (ref, number) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `issue:${number}:reopen`,
            async (clientRequestId) => {
                const detail = await getComandoApi().reopenGitHubIssue({
                    clientRequestId,
                    number,
                    repository: ref,
                    state: "open",
                });
                setIssueDetail(set, ref, detail);
                return detail;
            },
        ),

    requestPullRequestReviewers: async (ref, number, input) =>
        dedupeMutation(
            set,
            getRepoKey(ref),
            `pr:${number}:request-review`,
            async (clientRequestId) => {
                const detail =
                    await getComandoApi().requestGitHubPullRequestReviewers({
                        ...input,
                        clientRequestId,
                        number,
                        repository: ref,
                    });
                setPullRequestDetail(set, ref, detail);
                return detail;
            },
        ),
}));

export function getGitHubRepoKey(ref: GitHubRepositoryRef): string {
    return getRepoKey(ref);
}

export function resetGitHubStoreForTests(): void {
    inFlightMutations.clear();
    useGitHubStore.setState({
        authStatusByHost: {},
        errors: {},
        issueDetailsByRepo: {},
        issueListStateByRepo: {},
        issuesByRepo: {},
        loadingKeys: {},
        mutatingKeys: {},
        pullRequestDetailsByRepo: {},
        pullRequestChecksByRepo: {},
        pullRequestListStateByRepo: {},
        pullRequestsByRepo: {},
        workflowRunsByRepo: {},
        workflowRunJobsByRepo: {},
        workflowJobLogsByRepo: {},
        workflowRunArtifactsByRepo: {},
        checkRunAnnotationsByRepo: {},
        notificationsByHost: {},
        releasesByRepo: {},
        generatedReleaseNotesByRepo: {},
        milestonesByRepo: {},
    });
}

export function getGitHubPullRequestChecksKey(
    ref: GitHubRepositoryRef,
    headSha: string,
): string {
    return getPullRequestChecksKey(getRepoKey(ref), headSha);
}

export function getGitHubWorkflowRunsKey(
    ref: GitHubRepositoryRef,
    headSha: string,
): string {
    return getWorkflowRunsKey(getRepoKey(ref), headSha);
}

export function getGitHubWorkflowRunJobsKey(
    ref: GitHubRepositoryRef,
    runId: number,
): string {
    return getWorkflowRunJobsKey(getRepoKey(ref), runId);
}

export function getGitHubWorkflowJobLogsKey(
    ref: GitHubRepositoryRef,
    jobId: number,
): string {
    return getWorkflowJobLogsKey(getRepoKey(ref), jobId);
}

export function getGitHubWorkflowRunArtifactsKey(
    ref: GitHubRepositoryRef,
    runId: number,
): string {
    return getWorkflowRunArtifactsKey(getRepoKey(ref), runId);
}

export function getGitHubCheckRunAnnotationsKey(
    ref: GitHubRepositoryRef,
    checkRunId: number,
): string {
    return getCheckRunAnnotationsKey(getRepoKey(ref), checkRunId);
}

async function withLoading<T>(
    set: SetGitHubState,
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    set((state) => ({
        errors: { ...state.errors, [key]: null },
        loadingKeys: { ...state.loadingKeys, [key]: true },
    }));

    try {
        return await run();
    } catch (error) {
        set((state) => ({
            errors: {
                ...state.errors,
                [key]: getErrorMessage(error),
            },
        }));
        throw error;
    } finally {
        set((state) => ({
            loadingKeys: { ...state.loadingKeys, [key]: false },
        }));
    }
}

async function dedupeMutation<T>(
    set: SetGitHubState,
    repoKey: string,
    actionKey: string,
    run: (clientRequestId: string) => Promise<T>,
): Promise<T> {
    const key = `${repoKey}:${actionKey}`;
    const existing = inFlightMutations.get(key);
    if (existing) {
        return (await existing) as T;
    }

    const clientRequestId = createClientRequestId(key);
    set((state) => ({
        errors: { ...state.errors, [key]: null },
        mutatingKeys: { ...state.mutatingKeys, [key]: true },
    }));

    const promise = run(clientRequestId);
    inFlightMutations.set(key, promise);

    try {
        return await promise;
    } catch (error) {
        set((state) => ({
            errors: {
                ...state.errors,
                [key]: getErrorMessage(error),
            },
        }));
        throw error;
    } finally {
        inFlightMutations.delete(key);
        set((state) => ({
            mutatingKeys: { ...state.mutatingKeys, [key]: false },
        }));
    }
}

async function updatePullRequestDraftState(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    number: number,
    draft: boolean,
): Promise<GitHubPullRequestDetail> {
    return await dedupeMutation(
        set,
        getRepoKey(ref),
        `pr:${number}:${draft ? "draft" : "ready"}`,
        async (clientRequestId) => {
            const detail = draft
                ? await getComandoApi().convertGitHubPullRequestToDraft({
                      clientRequestId,
                      draft,
                      number,
                      repository: ref,
                  })
                : await getComandoApi().markGitHubPullRequestReady({
                      clientRequestId,
                      draft,
                      number,
                      repository: ref,
                  });
            setPullRequestDetail(set, ref, detail);
            return detail;
        },
    );
}

function upsertIssue(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    issue: GitHubIssueSummary,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => ({
        issuesByRepo: {
            ...state.issuesByRepo,
            [repoKey]: upsertByNumber(state.issuesByRepo[repoKey] ?? [], issue),
        },
    }));
}

function setIssueDetail(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    detail: GitHubIssueDetail,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => ({
        issueDetailsByRepo: {
            ...state.issueDetailsByRepo,
            [repoKey]: {
                ...(state.issueDetailsByRepo[repoKey] ?? {}),
                [detail.number]: detail,
            },
        },
        issuesByRepo: {
            ...state.issuesByRepo,
            [repoKey]: upsertByNumber(
                state.issuesByRepo[repoKey] ?? [],
                detail,
            ),
        },
    }));
}

function appendIssueComment(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    number: number,
    comment: GitHubCommentSummary,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => {
        const detail = state.issueDetailsByRepo[repoKey]?.[number];

        return {
            issueDetailsByRepo: detail
                ? {
                      ...state.issueDetailsByRepo,
                      [repoKey]: {
                          ...(state.issueDetailsByRepo[repoKey] ?? {}),
                          [number]: {
                              ...detail,
                              commentCount: detail.commentCount + 1,
                              comments: [...detail.comments, comment],
                          },
                      },
                  }
                : state.issueDetailsByRepo,
            issuesByRepo: {
                ...state.issuesByRepo,
                [repoKey]: incrementCommentCount(
                    state.issuesByRepo[repoKey] ?? [],
                    number,
                ),
            },
        };
    });
}

function upsertPullRequest(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    pullRequest: GitHubPullRequestSummary,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => ({
        pullRequestsByRepo: {
            ...state.pullRequestsByRepo,
            [repoKey]: upsertByNumber(
                state.pullRequestsByRepo[repoKey] ?? [],
                pullRequest,
            ),
        },
    }));
}

function setPullRequestDetail(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    detail: GitHubPullRequestDetail,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => ({
        pullRequestDetailsByRepo: {
            ...state.pullRequestDetailsByRepo,
            [repoKey]: {
                ...(state.pullRequestDetailsByRepo[repoKey] ?? {}),
                [detail.number]: detail,
            },
        },
        pullRequestsByRepo: {
            ...state.pullRequestsByRepo,
            [repoKey]: upsertByNumber(
                state.pullRequestsByRepo[repoKey] ?? [],
                detail,
            ),
        },
    }));
}

function appendPullRequestComment(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    number: number,
    comment: GitHubCommentSummary,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => {
        const detail = state.pullRequestDetailsByRepo[repoKey]?.[number];

        return {
            pullRequestDetailsByRepo: detail
                ? {
                      ...state.pullRequestDetailsByRepo,
                      [repoKey]: {
                          ...(state.pullRequestDetailsByRepo[repoKey] ?? {}),
                          [number]: {
                              ...detail,
                              commentCount: detail.commentCount + 1,
                              comments: [...detail.comments, comment],
                          },
                      },
                  }
                : state.pullRequestDetailsByRepo,
            pullRequestsByRepo: {
                ...state.pullRequestsByRepo,
                [repoKey]: incrementCommentCount(
                    state.pullRequestsByRepo[repoKey] ?? [],
                    number,
                ),
            },
        };
    });
}

function upsertRelease(
    set: SetGitHubState,
    ref: GitHubRepositoryRef,
    release: GitHubReleaseSummary,
): void {
    const repoKey = getRepoKey(ref);
    set((state) => ({
        releasesByRepo: {
            ...state.releasesByRepo,
            [repoKey]: upsertById(state.releasesByRepo[repoKey] ?? [], release),
        },
    }));
}

function upsertByNumber<T extends { readonly number: number }>(
    entries: readonly T[],
    nextEntry: T,
): readonly T[] {
    const existingIndex = entries.findIndex(
        (entry) => entry.number === nextEntry.number,
    );
    if (existingIndex < 0) {
        return [nextEntry, ...entries];
    }

    return entries.map((entry, index) =>
        index === existingIndex ? nextEntry : entry,
    );
}

function upsertById<T extends { readonly id: number }>(
    entries: readonly T[],
    nextEntry: T,
): readonly T[] {
    const existingIndex = entries.findIndex((entry) => entry.id === nextEntry.id);
    if (existingIndex < 0) {
        return [nextEntry, ...entries];
    }

    return entries.map((entry, index) =>
        index === existingIndex ? nextEntry : entry,
    );
}

function incrementCommentCount<T extends { readonly commentCount: number; readonly number: number }>(
    entries: readonly T[],
    number: number,
): readonly T[] {
    return entries.map((entry) =>
        entry.number === number
            ? { ...entry, commentCount: entry.commentCount + 1 }
            : entry,
    );
}

function normalizeGitHubIssueListState(
    state: GitHubListIssuesOptions["state"],
): GitHubIssueListState {
    return state ?? "open";
}

function normalizeGitHubPullRequestListState(
    state: GitHubListPullRequestsOptions["state"],
): GitHubPullRequestListState {
    return state ?? "open";
}

function getRepoKey(ref: GitHubRepositoryRef): string {
    return `${normalizeHost(ref.host)}/${ref.owner}/${ref.repo}`;
}

function getPullRequestChecksKey(repoKey: string, headSha: string): string {
    return `${repoKey}:pr-checks:${headSha}`;
}

function getWorkflowRunsKey(repoKey: string, headSha: string): string {
    return `${repoKey}:actions:runs:${headSha}`;
}

function getWorkflowRunJobsKey(repoKey: string, runId: number): string {
    return `${repoKey}:actions:runs:${runId}:jobs`;
}

function getWorkflowJobLogsKey(repoKey: string, jobId: number): string {
    return `${repoKey}:actions:jobs:${jobId}:logs`;
}

function getWorkflowRunArtifactsKey(repoKey: string, runId: number): string {
    return `${repoKey}:actions:runs:${runId}:artifacts`;
}

function getCheckRunAnnotationsKey(repoKey: string, checkRunId: number): string {
    return `${repoKey}:actions:check-runs:${checkRunId}:annotations`;
}

function normalizeHost(host: string): string {
    return host.trim().toLowerCase() || "github.com";
}

function createClientRequestId(key: string): string {
    const randomId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);

    return `${key}:${randomId}`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "GitHub request failed.";
}

function getComandoApi() {
    if (!("comando" in window)) {
        throw new Error("The renderer bridge is not available.");
    }

    return window.comando;
}

function omitKey<T>(
    record: Record<string, T>,
    key: string,
): Record<string, T> {
    const rest = { ...record };
    delete rest[key];
    return rest;
}

function omitKeysWithPrefix<T>(
    record: Record<string, T>,
    prefix: string,
): Record<string, T> {
    return Object.fromEntries(
        Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
    );
}
