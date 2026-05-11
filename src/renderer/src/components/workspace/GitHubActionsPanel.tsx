import { useEffect, useMemo, useState } from "react";

import type {
    GitHubAuthStatus,
    GitHubCheckRunAnnotationSummary,
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
    GitHubSectionLabel,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { IdeActionButton } from "./ide-bar";

type ActionTone = "failure" | "neutral" | "pending" | "skipped" | "success";

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
    headSha,
    ref,
}: {
    readonly authStatus: GitHubAuthStatus | null;
    readonly branch: string | null;
    readonly headSha: string;
    readonly ref: GitHubRepositoryRef;
}) {
    const repoKey = getGitHubRepoKey(ref);
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
    const runsKey = getGitHubWorkflowRunsKey(ref, headSha);
    const selectedRun = useMemo(
        () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
        [runs, selectedRunId],
    );
    const jobs = selectedRun ? (jobsByRun[selectedRun.id] ?? []) : [];
    const selectedJob = useMemo(
        () =>
            jobs.find((job) => job.id === selectedJobId) ??
            jobs.find((job) => job.conclusion === "failure") ??
            jobs[0] ??
            null,
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
        ? getGitHubWorkflowRunJobsKey(ref, selectedRun.id)
        : null;
    const artifactsKey = selectedRun
        ? getGitHubWorkflowRunArtifactsKey(ref, selectedRun.id)
        : null;
    const logsKey = selectedJob
        ? getGitHubWorkflowJobLogsKey(ref, selectedJob.id)
        : null;
    const annotationsKey =
        selectedJob?.checkRunId != null
            ? getGitHubCheckRunAnnotationsKey(ref, selectedJob.checkRunId)
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

        void refreshWorkflowRuns(ref, {
            branch,
            headSha,
            limit: 20,
        }).catch(() => undefined);
    }, [
        branch,
        canReadActions,
        headSha,
        isAuthenticated,
        ref,
        refreshWorkflowRuns,
    ]);

    useEffect(() => {
        if (!selectedRun || jobsByRun[selectedRun.id] !== undefined) {
            return;
        }

        void refreshWorkflowRunJobs(ref, selectedRun.id).catch(() => undefined);
        void refreshWorkflowRunArtifacts(ref, selectedRun.id).catch(
            () => undefined,
        );
    }, [
        jobsByRun,
        ref,
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

        void refreshCheckRunAnnotations(ref, selectedJob.checkRunId).catch(
            () => undefined,
        );
    }, [
        annotationsByCheckRun,
        ref,
        refreshCheckRunAnnotations,
        selectedJob?.checkRunId,
    ]);

    const handleRefresh = async () => {
        await refreshWorkflowRuns(
            ref,
            {
                branch,
                headSha,
                limit: 20,
            },
            { force: true },
        );
        if (selectedRun) {
            await Promise.all([
                refreshWorkflowRunJobs(ref, selectedRun.id, { force: true }),
                refreshWorkflowRunArtifacts(ref, selectedRun.id, {
                    force: true,
                }),
            ]);
        }
    };

    const handleLoadLogs = async (job: GitHubWorkflowJobSummary) => {
        await refreshWorkflowJobLogs(ref, job.id);
    };

    const handleRerunFailedJobs = async (run: GitHubWorkflowRunSummary) => {
        if (!window.confirm(`Re-run failed jobs for "${run.name}"?`)) {
            return;
        }

        await rerunWorkflowRunFailedJobs(ref, run.id);
        await Promise.all([
            refreshWorkflowRuns(
                ref,
                {
                    branch,
                    headSha,
                    limit: 20,
                },
                { force: true },
            ),
            refreshWorkflowRunJobs(ref, run.id, { force: true }),
            refreshWorkflowRunArtifacts(ref, run.id, { force: true }),
        ]);
    };

    const handleCancelRun = async (run: GitHubWorkflowRunSummary) => {
        if (!window.confirm(`Cancel workflow run "${run.name}"?`)) {
            return;
        }

        await cancelWorkflowRun(ref, run.id);
        await Promise.all([
            refreshWorkflowRuns(
                ref,
                {
                    branch,
                    headSha,
                    limit: 20,
                },
                { force: true },
            ),
            refreshWorkflowRunJobs(ref, run.id, { force: true }),
            refreshWorkflowRunArtifacts(ref, run.id, { force: true }),
        ]);
    };

    return (
        <section className="space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <GitHubSectionLabel>Actions</GitHubSectionLabel>
                    <span className="font-mono text-[10px] text-text-secondary">
                        {headSha.slice(0, 7)}
                    </span>
                </div>
                <IdeActionButton
                    disabled={loadingKeys[runsKey]}
                    onClick={() => void handleRefresh()}
                >
                    {loadingKeys[runsKey] ? "Refreshing..." : "Refresh"}
                </IdeActionButton>
            </div>
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
                <div className="space-y-3">
                    {runs.length > 1 ? (
                        <div className="flex flex-wrap gap-1.5">
                            {runs.map((run) => (
                                <button
                                    className={[
                                        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition",
                                        selectedRun?.id === run.id
                                            ? "border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-text-primary"
                                            : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary text-text-secondary hover:border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:text-text-primary",
                                    ].join(" ")}
                                    key={run.id}
                                    onClick={() => {
                                        setSelectedRunId(run.id);
                                        setSelectedJobId(null);
                                    }}
                                    title={`${run.event} · ${formatGitHubDateTime(run.updatedAt)}`}
                                    type="button"
                                >
                                    <ActionStatusDot
                                        tone={deriveActionTone(
                                            run.conclusion,
                                            run.status,
                                        )}
                                    />
                                    <span className="truncate">{run.name}</span>
                                    <ActionStatusPill
                                        conclusion={run.conclusion}
                                        status={run.status}
                                    />
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {selectedRun ? (
                        <RunDetail
                            artifacts={artifacts}
                            canMutateActions={canWriteActions}
                            cancelRun={() => void handleCancelRun(selectedRun)}
                            isCanceling={
                                mutatingKeys[
                                    `${repoKey}:actions:${selectedRun.id}:cancel`
                                ] ?? false
                            }
                            isLoadingArtifacts={
                                artifactsKey
                                    ? (loadingKeys[artifactsKey] ?? false)
                                    : false
                            }
                            isLoadingJobs={
                                jobsKey ? (loadingKeys[jobsKey] ?? false) : false
                            }
                            isLoadingLogs={
                                logsKey ? (loadingKeys[logsKey] ?? false) : false
                            }
                            isRerunning={
                                mutatingKeys[
                                    `${repoKey}:actions:${selectedRun.id}:rerun-failed`
                                ] ?? false
                            }
                            jobs={jobs}
                            loadLogs={(job) => void handleLoadLogs(job)}
                            logs={logs}
                            annotations={annotations}
                            rerunFailedJobs={() =>
                                void handleRerunFailedJobs(selectedRun)
                            }
                            run={selectedRun}
                            selectedJob={selectedJob}
                            selectJob={setSelectedJobId}
                        />
                    ) : null}
                </div>
            ) : null}
        </section>
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
        <div className="space-y-3 rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <ActionStatusDot
                        tone={deriveActionTone(run.conclusion, run.status)}
                    />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[12px] font-semibold text-text-primary">
                                {run.name}
                            </span>
                            <ActionStatusPill
                                conclusion={run.conclusion}
                                status={run.status}
                            />
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-secondary">
                            <span>{run.event}</span>
                            <span aria-hidden="true">·</span>
                            <span title={formatGitHubDateTime(run.updatedAt)}>
                                updated{" "}
                                {formatGitHubRelativeTime(run.updatedAt)}
                            </span>
                        </div>
                    </div>
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
                <div className="text-[11px] text-text-secondary">
                    Loading jobs...
                </div>
            ) : null}
            {jobs.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {jobs.map((job) => (
                        <button
                            className={[
                                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition",
                                selectedJob?.id === job.id
                                    ? "border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-text-primary"
                                    : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary text-text-secondary hover:border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:text-text-primary",
                            ].join(" ")}
                            key={job.id}
                            onClick={() => selectJob(job.id)}
                            type="button"
                        >
                            <ActionStatusDot
                                tone={deriveActionTone(
                                    job.conclusion,
                                    job.status,
                                )}
                            />
                            <span className="truncate">{job.name}</span>
                            <ActionStatusPill
                                conclusion={job.conclusion}
                                status={job.status}
                            />
                        </button>
                    ))}
                </div>
            ) : null}
            {jobs.length === 0 && !isLoadingJobs ? (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-3 py-2 text-[11px] text-text-secondary">
                    No jobs available for this run.
                </div>
            ) : null}
            <div className="space-y-3">
                {selectedJob ? (
                    <>
                        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-2">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                    <GitHubSectionLabel>Logs</GitHubSectionLabel>
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
                                <div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-editor p-2 font-mono text-[10px] leading-4 text-text-secondary">
                                    {logs}
                                </div>
                            ) : (
                                <div className="mt-2 rounded-md border border-dashed border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] px-3 py-3 text-center text-[10px] text-text-secondary">
                                    Logs load on demand.
                                </div>
                            )}
                        </div>
                        <AnnotationsList annotations={annotations} />
                        <StepsList steps={selectedJob.steps} />
                    </>
                ) : null}
                <ArtifactsList
                    artifacts={artifacts}
                    isLoading={isLoadingArtifacts}
                />
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
    const useTwoColumns = steps.length > 8;

    return (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-2">
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
                className={
                    useTwoColumns
                        ? "grid gap-x-3 gap-y-0.5 sm:grid-cols-2"
                        : "space-y-0.5"
                }
            >
                {steps.map((step) => {
                    const tone = deriveActionTone(
                        step.conclusion,
                        step.status,
                    );
                    return (
                        <div
                            className="flex items-center gap-2 px-1 py-0.5 text-[11px]"
                            key={`${step.number}:${step.name}`}
                        >
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
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-2">
            <div className="mb-2 flex items-center gap-2">
                <GitHubSectionLabel>Annotations</GitHubSectionLabel>
                <span className="text-[10px] text-text-secondary">
                    {annotations.length}
                </span>
            </div>
            <div className="space-y-1.5">
                {visible.map((annotation, index) => (
                    <div
                        className="rounded-md border-l-[2px] border-l-[color-mix(in_srgb,var(--diff-warn)_60%,transparent)] bg-bg-primary px-2 py-1 text-[10px] leading-4"
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
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-2">
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

function ActionStatusPill({
    conclusion,
    status,
}: {
    readonly conclusion: GitHubWorkflowConclusion | null;
    readonly status: GitHubWorkflowRunStatus;
}) {
    const tone = deriveActionTone(conclusion, status);
    const colors: Record<ActionTone, string> = {
        failure:
            "border-[color-mix(in_srgb,var(--diff-remove)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-remove)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-remove)_84%,var(--color-text-primary))]",
        neutral:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        pending:
            "border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-text-primary",
        skipped:
            "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary text-text-secondary",
        success:
            "border-[color-mix(in_srgb,var(--diff-add)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--diff-add)_8%,transparent)] text-[color-mix(in_srgb,var(--diff-add)_78%,var(--color-text-primary))]",
    };

    return (
        <span
            className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px] font-medium ${colors[tone]}`}
        >
            {formatActionLabel(conclusion, status)}
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
