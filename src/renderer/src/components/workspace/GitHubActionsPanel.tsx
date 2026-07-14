import { useEffect, useMemo, useState } from "react";

import type {
    GitHubAuthStatus,
    GitHubCheckRunAnnotationSummary,
    GitHubPullRequestChecksState,
    GitHubRepositoryRef,
    GitHubWorkflowArtifactSummary,
    GitHubWorkflowConclusion,
    GitHubWorkflowJobSummary,
    GitHubWorkflowRunStatus,
    GitHubWorkflowRunSummary,
} from "@shared/ipc";

import {
    EMPTY_GITHUB_LIST,
    EMPTY_GITHUB_RECORD,
    getGitHubCheckRunAnnotationsKey,
    getGitHubRepoKey,
    getGitHubWorkflowJobLogsKey,
    getGitHubWorkflowRunArtifactsKey,
    getGitHubWorkflowRunJobsKey,
    getGitHubWorkflowRunsKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";

import {
    formatGitHubDateTime,
    formatGitHubRelativeTime,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubSection,
    GitHubSectionLabel,
    openGitHubWebUrl,
    type GitHubSectionTone,
} from "./GitHubWorkspacePrimitives";
import { IdeActionButton } from "./ide-bar";

type ActionTone = "failure" | "neutral" | "pending" | "skipped" | "success";

interface ChecksSummaryPresentation {
    readonly detail: string;
    readonly title: string;
    readonly tone: ActionTone;
}

function deriveActionTone(
    conclusion: GitHubWorkflowConclusion | null,
    status: GitHubWorkflowRunStatus,
): ActionTone {
    if (
        conclusion === "failure" ||
        conclusion === "timed_out" ||
        conclusion === "action_required" ||
        conclusion === "cancelled"
    ) {
        return "failure";
    }
    if (conclusion === "success") {
        return "success";
    }
    if (conclusion === "skipped") {
        return "skipped";
    }
    if (status === "completed") {
        return "neutral";
    }
    return "pending";
}

function formatActionLabel(
    conclusion: GitHubWorkflowConclusion | null,
    status: GitHubWorkflowRunStatus,
): string {
    return (conclusion ?? status).replaceAll("_", " ");
}

export function getChecksSummaryPresentation(
    state: GitHubPullRequestChecksState | "loading" | undefined,
    checksCount: number | null | undefined,
): ChecksSummaryPresentation {
    const countLabel =
        checksCount == null
            ? "Check details are loading"
            : `${checksCount} ${checksCount === 1 ? "check" : "checks"}`;

    switch (state) {
        case "success":
            return {
                detail:
                    checksCount == null
                        ? "All reported checks succeeded"
                        : `${checksCount} successful ${checksCount === 1 ? "check" : "checks"}`,
                title: "All checks have passed",
                tone: "success",
            };
        case "failure":
            return {
                detail: countLabel,
                title: "Some checks have failed",
                tone: "failure",
            };
        case "pending":
            return {
                detail: countLabel,
                title: "Checks are still running",
                tone: "pending",
            };
        case "loading":
            return {
                detail: "Refreshing the latest status",
                title: "Loading checks",
                tone: "pending",
            };
        default:
            return {
                detail: countLabel,
                title: "Check status is unavailable",
                tone: "neutral",
            };
    }
}

function formatActionDuration(
    startedAt: string | null | undefined,
    completedAt: string | null | undefined,
): string | null {
    if (!startedAt || !completedAt) {
        return null;
    }

    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return null;
    }

    const seconds = Math.max(1, Math.round(durationMs / 1_000));
    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${hours}h`;
}

function formatActionResult(
    conclusion: GitHubWorkflowConclusion | null,
    status: GitHubWorkflowRunStatus,
    startedAt?: string | null,
    completedAt?: string | null,
): string {
    const tone = deriveActionTone(conclusion, status);
    const duration = formatActionDuration(startedAt, completedAt);

    if (tone === "success") {
        return duration ? `Successful in ${duration}` : "Successful";
    }
    if (tone === "failure") {
        return duration ? `Failed after ${duration}` : "Failed";
    }
    if (tone === "skipped") {
        return "Skipped";
    }

    const label = formatActionLabel(conclusion, status);
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function cleanRunnerName(name: string | null | undefined): string | null {
    if (!name) {
        return null;
    }
    if (/^GitHub[\s-]Actions[\s-]?\d+$/i.test(name)) {
        return "GitHub-hosted";
    }
    return name;
}

export function GitHubActionsPanel({
    authStatus,
    branch,
    checksCount,
    checksState,
    checksUrl,
    headSha,
    repo,
}: {
    readonly authStatus: GitHubAuthStatus | null;
    readonly branch: string | null;
    readonly checksCount?: number | null;
    readonly checksState?: GitHubPullRequestChecksState | "loading";
    readonly checksUrl?: string | null;
    readonly headSha: string;
    readonly repo: GitHubRepositoryRef;
}) {
    const repoKey = getGitHubRepoKey(repo);
    const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
    const runs = useGitHubStore(
        (state) =>
            state.workflowRunsByRepo[repoKey]?.[headSha] ?? EMPTY_GITHUB_LIST,
    );
    const jobsByRun = useGitHubStore(
        (state) => state.workflowRunJobsByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const logsByJob = useGitHubStore(
        (state) => state.workflowJobLogsByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const artifactsByRun = useGitHubStore(
        (state) =>
            state.workflowRunArtifactsByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const annotationsByCheckRun = useGitHubStore(
        (state) =>
            state.checkRunAnnotationsByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const loadingKeys = useGitHubStore((state) => state.loadingKeys);
    const mutatingKeys = useGitHubStore((state) => state.mutatingKeys);
    const errors = useGitHubStore((state) => state.errors);
    const refreshWorkflowRuns = useGitHubStore(
        (state) => state.refreshWorkflowRuns,
    );
    const refreshWorkflowRunJobs = useGitHubStore(
        (state) => state.refreshWorkflowRunJobs,
    );
    const refreshWorkflowJobLogs = useGitHubStore(
        (state) => state.refreshWorkflowJobLogs,
    );
    const refreshWorkflowRunArtifacts = useGitHubStore(
        (state) => state.refreshWorkflowRunArtifacts,
    );
    const refreshCheckRunAnnotations = useGitHubStore(
        (state) => state.refreshCheckRunAnnotations,
    );
    const rerunWorkflowRunFailedJobs = useGitHubStore(
        (state) => state.rerunWorkflowRunFailedJobs,
    );
    const cancelWorkflowRun = useGitHubStore(
        (state) => state.cancelWorkflowRun,
    );
    const runsKey = getGitHubWorkflowRunsKey(repo, headSha);
    const selectedRun = useMemo(
        () => runs.find((run) => run.id === selectedRunId) ?? null,
        [runs, selectedRunId],
    );
    const jobs = useMemo(
        () => (selectedRun ? (jobsByRun[selectedRun.id] ?? []) : []),
        [jobsByRun, selectedRun],
    );
    const selectedJob = useMemo(
        () =>
            jobs.find((job) => job.id === selectedJobId) ?? null,
        [jobs, selectedJobId],
    );
    const artifacts = selectedRun
        ? (artifactsByRun[selectedRun.id] ?? [])
        : [];
    const logs = selectedJob ? (logsByJob[selectedJob.id] ?? null) : null;
    const annotations =
        selectedJob?.checkRunId != null
            ? (annotationsByCheckRun[selectedJob.checkRunId] ?? [])
            : [];
    const jobsKey = selectedRun
        ? getGitHubWorkflowRunJobsKey(repo, selectedRun.id)
        : null;
    const artifactsKey = selectedRun
        ? getGitHubWorkflowRunArtifactsKey(repo, selectedRun.id)
        : null;
    const logsKey = selectedJob
        ? getGitHubWorkflowJobLogsKey(repo, selectedJob.id)
        : null;
    const annotationsKey =
        selectedJob?.checkRunId != null
            ? getGitHubCheckRunAnnotationsKey(repo, selectedJob.checkRunId)
            : null;
    const actionsError =
        errors[runsKey] ??
        (jobsKey ? errors[jobsKey] : null) ??
        (artifactsKey ? errors[artifactsKey] : null) ??
        (logsKey ? errors[logsKey] : null) ??
        (annotationsKey ? errors[annotationsKey] : null) ??
        null;
    const isAuthenticated = authStatus?.state === "authenticated";
    const canReadActions = Boolean(authStatus?.canReadActions);
    const canWriteActions = Boolean(authStatus?.canWriteActions);

    useEffect(() => {
        if (!isAuthenticated || !canReadActions || !headSha) {
            return;
        }

        void refreshWorkflowRuns(repo, {
            branch,
            headSha,
            limit: 20,
        }).catch(() => undefined);
    }, [
        branch,
        canReadActions,
        headSha,
        isAuthenticated,
        repo,
        refreshWorkflowRuns,
    ]);

    useEffect(() => {
        if (!selectedRun || jobsByRun[selectedRun.id] !== undefined) {
            return;
        }

        void refreshWorkflowRunJobs(repo, selectedRun.id).catch(() => undefined);
        void refreshWorkflowRunArtifacts(repo, selectedRun.id).catch(
            () => undefined,
        );
    }, [
        jobsByRun,
        repo,
        refreshWorkflowRunArtifacts,
        refreshWorkflowRunJobs,
        selectedRun,
    ]);

    useEffect(() => {
        if (
            !selectedJob?.checkRunId ||
            annotationsByCheckRun[selectedJob.checkRunId] !== undefined
        ) {
            return;
        }

        void refreshCheckRunAnnotations(repo, selectedJob.checkRunId).catch(
            () => undefined,
        );
    }, [
        annotationsByCheckRun,
        repo,
        refreshCheckRunAnnotations,
        selectedJob?.checkRunId,
    ]);

    const handleRefresh = async () => {
        await refreshWorkflowRuns(
            repo,
            {
                branch,
                headSha,
                limit: 20,
            },
            { force: true },
        );
        if (selectedRun) {
            await Promise.all([
                refreshWorkflowRunJobs(repo, selectedRun.id, { force: true }),
                refreshWorkflowRunArtifacts(repo, selectedRun.id, {
                    force: true,
                }),
            ]);
        }
    };

    const handleLoadLogs = async (job: GitHubWorkflowJobSummary) => {
        await refreshWorkflowJobLogs(repo, job.id);
    };

    const handleRerunFailedJobs = async (run: GitHubWorkflowRunSummary) => {
        if (!window.confirm(`Re-run failed jobs for "${run.name}"?`)) {
            return;
        }

        await rerunWorkflowRunFailedJobs(repo, run.id);
        await Promise.all([
            refreshWorkflowRuns(
                repo,
                {
                    branch,
                    headSha,
                    limit: 20,
                },
                { force: true },
            ),
            refreshWorkflowRunJobs(repo, run.id, { force: true }),
            refreshWorkflowRunArtifacts(repo, run.id, { force: true }),
        ]);
    };

    const handleCancelRun = async (run: GitHubWorkflowRunSummary) => {
        if (!window.confirm(`Cancel workflow run "${run.name}"?`)) {
            return;
        }

        await cancelWorkflowRun(repo, run.id);
        await Promise.all([
            refreshWorkflowRuns(
                repo,
                {
                    branch,
                    headSha,
                    limit: 20,
                },
                { force: true },
            ),
            refreshWorkflowRunJobs(repo, run.id, { force: true }),
            refreshWorkflowRunArtifacts(repo, run.id, { force: true }),
        ]);
    };

    const sectionTone: GitHubSectionTone = checksState
        ? deriveChecksSectionTone(checksState)
        : "accent";
    const checksSummary = getChecksSummaryPresentation(
        checksState,
        checksCount,
    );

    return (
        <GitHubSection
            actions={
                <>
                    {checksUrl ? (
                        <IdeActionButton
                            onClick={() => openGitHubWebUrl(checksUrl)}
                        >
                            Open Checks
                        </IdeActionButton>
                    ) : null}
                    <IdeActionButton
                        disabled={loadingKeys[runsKey]}
                        onClick={() => void handleRefresh()}
                    >
                        {loadingKeys[runsKey] ? "Refreshing..." : "Refresh"}
                    </IdeActionButton>
                </>
            }
            bodyClassName="space-y-3 pt-4"
            title="CI Actions"
            tone={sectionTone}
        >
            {!isAuthenticated ? (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px] text-text-secondary">
                    Actions load after GitHub authentication is verified.
                </div>
            ) : null}
            {isAuthenticated && !canReadActions ? (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px] text-text-secondary">
                    Your GitHub token cannot read Actions data for this host.
                    Add Actions read access or a repo/workflow scope, then
                    refresh auth.
                </div>
            ) : null}
            {actionsError ? <GitHubErrorState>{actionsError}</GitHubErrorState> : null}
            {isAuthenticated &&
            canReadActions &&
            loadingKeys[runsKey] &&
            runs.length === 0 ? (
                <div className="text-[11px] text-text-secondary">
                    Loading workflow runs...
                </div>
            ) : null}
            {isAuthenticated &&
            canReadActions &&
            !loadingKeys[runsKey] &&
            runs.length === 0 ? (
                <GitHubEmptyState>
                    No workflow runs found for this PR head yet.
                </GitHubEmptyState>
            ) : null}
            {runs.length > 0 ? (
                <div>
                    <div className="flex items-center gap-3 pb-4">
                        <ActionStatusIcon
                            size="large"
                            tone={checksSummary.tone}
                        />
                        <div className="min-w-0">
                            <div className="text-[15px] font-semibold text-text-primary">
                                {checksSummary.title}
                            </div>
                            <div className="mt-0.5 text-[12px] text-text-secondary">
                                {checksSummary.detail}
                            </div>
                        </div>
                    </div>
                    <div
                        className="ci-activity-tree flex min-w-0 flex-col gap-1"
                        data-ci-activity-rail="workflows"
                        role="list"
                    >
                        {runs.map((run) => {
                            const expanded = selectedRun?.id === run.id;
                            const runTone = deriveActionTone(
                                run.conclusion,
                                run.status,
                            );

                            return (
                                <div
                                    className="ci-activity-branch min-w-0"
                                    data-activity-rail-decoration="branch"
                                    data-ci-workflow-id={run.id}
                                    key={run.id}
                                    role="listitem"
                                >
                                    <button
                                        aria-expanded={expanded}
                                        className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left transition hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_45%,transparent)]"
                                        onClick={() => {
                                            setSelectedRunId((current) =>
                                                current === run.id
                                                    ? null
                                                    : run.id,
                                            );
                                            setSelectedJobId(null);
                                        }}
                                        title={`${run.event} · ${formatGitHubDateTime(run.updatedAt)}`}
                                        type="button"
                                    >
                                        <ActionStatusIcon tone={runTone} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[13px] font-medium text-text-primary">
                                                {run.name}
                                            </div>
                                            <div className="mt-0.5 truncate text-[11px] text-text-secondary">
                                                {run.workflowName !== run.name
                                                    ? `${run.workflowName} · `
                                                    : ""}
                                                {run.event}
                                            </div>
                                        </div>
                                        <span
                                            className="shrink-0 text-[11px] text-text-secondary"
                                            title={formatGitHubDateTime(
                                                run.updatedAt,
                                            )}
                                        >
                                            {formatActionResult(
                                                run.conclusion,
                                                run.status,
                                                run.createdAt,
                                                run.updatedAt,
                                            )}
                                        </span>
                                        <span
                                            aria-hidden="true"
                                            className="w-4 shrink-0 text-center text-[14px] text-text-secondary"
                                        >
                                            {expanded ? "⌃" : "⌄"}
                                        </span>
                                    </button>
                                    {expanded && selectedRun ? (
                                        <RunDetail
                                            artifacts={artifacts}
                                            canMutateActions={canWriteActions}
                                            cancelRun={() =>
                                                void handleCancelRun(selectedRun)
                                            }
                                            isCanceling={
                                                mutatingKeys[
                                                    `${repoKey}:actions:${selectedRun.id}:cancel`
                                                ] ?? false
                                            }
                                            isLoadingArtifacts={
                                                artifactsKey
                                                    ? (loadingKeys[
                                                          artifactsKey
                                                      ] ?? false)
                                                    : false
                                            }
                                            isLoadingJobs={
                                                jobsKey
                                                    ? (loadingKeys[jobsKey] ??
                                                      false)
                                                    : false
                                            }
                                            isLoadingLogs={
                                                logsKey
                                                    ? (loadingKeys[logsKey] ??
                                                      false)
                                                    : false
                                            }
                                            isRerunning={
                                                mutatingKeys[
                                                    `${repoKey}:actions:${selectedRun.id}:rerun-failed`
                                                ] ?? false
                                            }
                                            jobs={jobs}
                                            loadLogs={(job) =>
                                                void handleLoadLogs(job)
                                            }
                                            logs={logs}
                                            annotations={annotations}
                                            rerunFailedJobs={() =>
                                                void handleRerunFailedJobs(
                                                    selectedRun,
                                                )
                                            }
                                            run={selectedRun}
                                            selectedJob={selectedJob}
                                            selectJob={(jobId) =>
                                                setSelectedJobId((current) =>
                                                    current === jobId
                                                        ? null
                                                        : jobId,
                                                )
                                            }
                                        />
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </GitHubSection>
    );
}

function RunDetail({
    annotations,
    artifacts,
    canMutateActions,
    cancelRun,
    isCanceling,
    isLoadingArtifacts,
    isLoadingJobs,
    isLoadingLogs,
    isRerunning,
    jobs,
    loadLogs,
    logs,
    rerunFailedJobs,
    run,
    selectedJob,
    selectJob,
}: {
    readonly annotations: readonly GitHubCheckRunAnnotationSummary[];
    readonly artifacts: readonly GitHubWorkflowArtifactSummary[];
    readonly canMutateActions: boolean;
    readonly cancelRun: () => void;
    readonly isCanceling: boolean;
    readonly isLoadingArtifacts: boolean;
    readonly isLoadingJobs: boolean;
    readonly isLoadingLogs: boolean;
    readonly isRerunning: boolean;
    readonly jobs: readonly GitHubWorkflowJobSummary[];
    readonly loadLogs: (job: GitHubWorkflowJobSummary) => void;
    readonly logs: string | null;
    readonly rerunFailedJobs: () => void;
    readonly run: GitHubWorkflowRunSummary;
    readonly selectedJob: GitHubWorkflowJobSummary | null;
    readonly selectJob: (jobId: number) => void;
}) {
    const canCancel =
        canMutateActions &&
        (run.status === "in_progress" ||
            run.status === "queued" ||
            run.status === "requested" ||
            run.status === "waiting");
    const canRerunFailed =
        canMutateActions &&
        (run.conclusion === "failure" ||
            run.conclusion === "timed_out" ||
            run.conclusion === "action_required");

    const selectedJobRunner = selectedJob
        ? cleanRunnerName(selectedJob.runnerName)
        : null;

    return (
        <div className="space-y-4 pb-2 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-text-secondary">
                    <span>Run #{run.runNumber}</span>
                    {run.runAttempt > 1 ? (
                        <>
                            <span aria-hidden="true">·</span>
                            <span>attempt {run.runAttempt}</span>
                        </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <span title={formatGitHubDateTime(run.updatedAt)}>
                        updated {formatGitHubRelativeTime(run.updatedAt)}
                    </span>
                </div>
                <div className="flex flex-wrap gap-2">
                    <IdeActionButton onClick={() => openGitHubWebUrl(run.url)}>
                        Open Run
                    </IdeActionButton>
                    <IdeActionButton
                        disabled={!canRerunFailed || isRerunning}
                        onClick={rerunFailedJobs}
                        title={
                            canMutateActions
                                ? undefined
                                : "Your GitHub token may not be able to mutate Actions runs."
                        }
                    >
                        {isRerunning ? "Re-running..." : "Re-run Failed"}
                    </IdeActionButton>
                    <IdeActionButton
                        disabled={!canCancel || isCanceling}
                        onClick={cancelRun}
                        title={
                            canMutateActions
                                ? undefined
                                : "Your GitHub token may not be able to mutate Actions runs."
                        }
                    >
                        {isCanceling ? "Canceling..." : "Cancel Run"}
                    </IdeActionButton>
                </div>
            </div>
            {isLoadingJobs && jobs.length === 0 ? (
                <div className="py-2 text-[12px] text-text-secondary">
                    Loading jobs...
                </div>
            ) : null}
            {jobs.length > 0 ? (
                <div
                    className="ci-activity-tree flex min-w-0 flex-col gap-1"
                    data-ci-activity-rail="jobs"
                    role="list"
                >
                    {jobs.map((job) => (
                        <div
                            className="ci-activity-branch min-w-0"
                            data-activity-rail-decoration="branch"
                            data-ci-job-id={job.id}
                            key={job.id}
                            role="listitem"
                        >
                            <button
                                aria-expanded={selectedJob?.id === job.id}
                                className="flex w-full items-center gap-3 rounded-md py-1.5 pl-1 text-left transition hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_45%,transparent)]"
                                onClick={() => selectJob(job.id)}
                                type="button"
                            >
                                <ActionStatusIcon
                                    tone={deriveActionTone(
                                        job.conclusion,
                                        job.status,
                                    )}
                                />
                                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">
                                    {job.name}
                                </span>
                                <span className="shrink-0 text-[11px] text-text-secondary">
                                    {formatActionResult(
                                        job.conclusion,
                                        job.status,
                                        job.startedAt,
                                        job.completedAt,
                                    )}
                                </span>
                                <span
                                    aria-hidden="true"
                                    className="w-4 shrink-0 text-center text-[13px] text-text-secondary"
                                >
                                    {selectedJob?.id === job.id ? "⌃" : "⌄"}
                                </span>
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            {jobs.length === 0 && !isLoadingJobs ? (
                <div className="py-2 text-[12px] text-text-secondary">
                    No jobs available for this run.
                </div>
            ) : null}
            <div
                className="ci-activity-tree flex min-w-0 flex-col gap-2"
                data-ci-activity-rail="details"
                role="list"
            >
                {selectedJob ? (
                    <>
                        <div
                            className="ci-activity-branch min-w-0"
                            data-activity-rail-decoration="branch"
                            role="listitem"
                        >
                            <div className="py-1">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <GitHubSectionLabel>
                                            Logs
                                        </GitHubSectionLabel>
                                        {selectedJobRunner ? (
                                            <span className="truncate text-[10px] text-text-secondary">
                                                {selectedJobRunner}
                                            </span>
                                        ) : null}
                                    </div>
                                    <IdeActionButton
                                        disabled={isLoadingLogs}
                                        onClick={() => loadLogs(selectedJob)}
                                    >
                                        {isLoadingLogs
                                            ? "Loading..."
                                            : logs
                                              ? "Reload"
                                              : "Load"}
                                    </IdeActionButton>
                                </div>
                                {logs ? (
                                    <div className="mt-2 max-h-72 select-text overflow-y-auto rounded-md bg-editor p-2 font-mono text-[10px] leading-4 text-text-secondary">
                                        {logs}
                                    </div>
                                ) : (
                                    <div className="mt-2 text-[11px] text-text-secondary">
                                        Logs load on demand.
                                    </div>
                                )}
                            </div>
                        </div>
                        {annotations.length > 0 ? (
                            <div
                                className="ci-activity-branch min-w-0"
                                data-activity-rail-decoration="branch"
                                role="listitem"
                            >
                                <AnnotationsList annotations={annotations} />
                            </div>
                        ) : null}
                        {selectedJob.steps.length > 0 ? (
                            <div
                                className="ci-activity-branch min-w-0"
                                data-activity-rail-decoration="branch"
                                role="listitem"
                            >
                                <StepsList steps={selectedJob.steps} />
                            </div>
                        ) : null}
                    </>
                ) : null}
                {isLoadingArtifacts || artifacts.length > 0 ? (
                    <div
                        className="ci-activity-branch min-w-0"
                        data-activity-rail-decoration="branch"
                        role="listitem"
                    >
                        <ArtifactsList
                            artifacts={artifacts}
                            isLoading={isLoadingArtifacts}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function StepsList({
    steps,
}: {
    readonly steps: GitHubWorkflowJobSummary["steps"];
}) {
    if (steps.length === 0) {
        return null;
    }

    const failedCount = steps.filter(
        (step) => deriveActionTone(step.conclusion, step.status) === "failure",
    ).length;
    const skippedCount = steps.filter(
        (step) => deriveActionTone(step.conclusion, step.status) === "skipped",
    ).length;
    return (
        <div className="py-1">
            <div className="mb-2 flex items-center gap-2">
                <GitHubSectionLabel>Steps</GitHubSectionLabel>
                <span className="text-[10px] text-text-secondary">
                    {steps.length}
                </span>
                {failedCount > 0 ? (
                    <span className="text-[10px] text-[color:var(--diff-remove)]">
                        {failedCount} failed
                    </span>
                ) : null}
                {skippedCount > 0 ? (
                    <span className="text-[10px] text-text-secondary">
                        {skippedCount} skipped
                    </span>
                ) : null}
            </div>
            <div
                className="ci-activity-tree flex min-w-0 flex-col gap-0.5"
                data-ci-activity-rail="steps"
                role="list"
            >
                {steps.map((step) => {
                    const tone = deriveActionTone(
                        step.conclusion,
                        step.status,
                    );
                    return (
                        <div
                            className="ci-activity-branch min-w-0"
                            data-activity-rail-decoration="branch"
                            key={`${step.number}:${step.name}`}
                            role="listitem"
                        >
                            <div className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                                <ActionStatusDot tone={tone} />
                                <span
                                    className={
                                        tone === "skipped"
                                            ? "min-w-0 flex-1 truncate text-text-secondary line-through decoration-text-secondary/40"
                                            : "min-w-0 flex-1 truncate text-text-primary"
                                    }
                                >
                                    {step.name}
                                </span>
                                {tone !== "success" && tone !== "skipped" ? (
                                    <span className="shrink-0 font-mono text-[10px] text-text-secondary">
                                        {formatActionLabel(
                                            step.conclusion,
                                            step.status,
                                        )}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function AnnotationsList({
    annotations,
}: {
    readonly annotations: readonly GitHubCheckRunAnnotationSummary[];
}) {
    if (annotations.length === 0) {
        return null;
    }

    const visible = annotations.slice(0, 8);
    const hidden = annotations.length - visible.length;

    return (
        <div className="py-1">
            <div className="mb-2 flex items-center gap-2">
                <GitHubSectionLabel>Annotations</GitHubSectionLabel>
                <span className="text-[10px] text-text-secondary">
                    {annotations.length}
                </span>
            </div>
            <div className="space-y-1.5">
                {visible.map((annotation, index) => (
                    <div
                        className="border-l-[2px] border-l-[color-mix(in_srgb,var(--diff-warn)_60%,transparent)] py-1 pl-3 text-[10px] leading-4"
                        key={`${annotation.path}:${annotation.startLine}:${index}`}
                    >
                        <div className="font-mono text-text-primary">
                            {annotation.path}
                            <span className="text-text-secondary">
                                :{annotation.startLine}
                            </span>
                        </div>
                        <div className="mt-0.5 text-text-secondary">
                            {annotation.title ?? annotation.message}
                        </div>
                    </div>
                ))}
                {hidden > 0 ? (
                    <div className="px-2 text-[10px] text-text-secondary">
                        +{hidden} more
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function ArtifactsList({
    artifacts,
    isLoading,
}: {
    readonly artifacts: readonly GitHubWorkflowArtifactSummary[];
    readonly isLoading: boolean;
}) {
    if (isLoading && artifacts.length === 0) {
        return (
            <div className="text-[11px] text-text-secondary">
                Loading artifacts...
            </div>
        );
    }
    if (artifacts.length === 0) {
        return null;
    }

    return (
        <div className="py-1">
            <div className="mb-2">
                <GitHubSectionLabel>Artifacts</GitHubSectionLabel>
            </div>
            <div className="space-y-1">
                {artifacts.map((artifact) => (
                    <div
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px]"
                        key={artifact.id}
                    >
                        <span className="min-w-0 truncate text-text-primary">
                            {artifact.name}
                        </span>
                        <span className="shrink-0 text-right text-[10px] text-text-secondary">
                            {formatBytes(artifact.sizeInBytes)}
                            <span className="ml-2">Open run to download</span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ActionStatusIcon({
    size = "small",
    tone,
}: {
    readonly size?: "large" | "small";
    readonly tone: ActionTone;
}) {
    const colors: Record<ActionTone, string> = {
        failure: "var(--diff-remove)",
        neutral: "var(--color-text-secondary)",
        pending: "var(--color-accent)",
        skipped: "var(--color-text-secondary)",
        success: "var(--diff-add)",
    };
    const labels: Record<ActionTone, string> = {
        failure: "Failed",
        neutral: "Unknown",
        pending: "In progress",
        skipped: "Skipped",
        success: "Passed",
    };
    const symbols: Record<ActionTone, string> = {
        failure: "×",
        neutral: "?",
        pending: "•",
        skipped: "–",
        success: "✓",
    };

    return (
        <span
            aria-label={labels[tone]}
            className={[
                "inline-flex shrink-0 items-center justify-center rounded-full border font-semibold",
                size === "large"
                    ? "h-8 w-8 text-[16px]"
                    : "h-5 w-5 text-[11px]",
            ].join(" ")}
            role="img"
            style={{
                borderColor: `color-mix(in srgb, ${colors[tone]} 48%, transparent)`,
                color: colors[tone],
            }}
        >
            {symbols[tone]}
        </span>
    );
}

function ActionStatusDot({ tone }: { readonly tone: ActionTone }) {
    const colors: Record<ActionTone, string> = {
        failure: "var(--diff-remove)",
        neutral: "color-mix(in srgb, var(--color-text-secondary) 50%, transparent)",
        pending: "var(--color-accent)",
        skipped: "color-mix(in srgb, var(--color-text-secondary) 35%, transparent)",
        success: "color-mix(in srgb, var(--diff-add) 78%, transparent)",
    };

    return (
        <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: colors[tone] }}
        />
    );
}

function formatBytes(value: number): string {
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${Math.round(value / 1024)} KB`;
    }

    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function deriveChecksSectionTone(
    state: GitHubPullRequestChecksState | "loading",
): GitHubSectionTone {
    switch (state) {
        case "failure":
            return "danger";
        case "pending":
        case "loading":
            return "warn";
        case "success":
            return "success";
        default:
            return "accent";
    }
}
