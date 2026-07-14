import {
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import type {
    GitHubCommentSummary,
    GitHubPullRequestChecksResult,
    GitHubPullRequestChecksState,
} from "@shared/ipc";

import {
    EMPTY_GITHUB_LIST,
    getGitHubPullRequestChecksKey,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitHubPullRequestTab } from "@renderer/app/workspace/tree";

import {
    buildGitHubWebUrl,
    deriveGitHubMergeableState,
    formatGitHubDateTime,
    getGitHubWritePermissionLabel,
    GitHubAuthNotice,
    GitHubCommentComposer,
    GitHubCommentList,
    GitHubConfirmActionButton,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubInput,
    GitHubLabelPill,
    GitHubMergeablePill,
    GitHubSection,
    GitHubSectionLabel,
    GitHubStatePill,
    GitHubTabHeader,
    GitHubTabShell,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { GitRevisionDiffView } from "./GitRevisionDiffView";
import { GitHubActionsPanel } from "./GitHubActionsPanel";
import { GitHubLabelPicker } from "./GitHubLabelPicker";
import { MarkdownContent } from "./MarkdownContent";
import { IdeActionButton } from "./ide-bar";

const COMMITS_PREVIEW_LIMIT = 12;

export function GitHubPullRequestTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitHubPullRequestTab;
}) {
    const {
        projectId,
        pullRequestNumber,
        ref: repo,
        worktreeId,
    } = tab;
    const repoKey = getGitHubRepoKey(repo);
    const [commentDraft, setCommentDraft] = useState("");
    const [showAllCommits, setShowAllCommits] = useState(false);
    const [showChanges, setShowChanges] = useState(false);
    const [isEditingDescription, setIsEditingDescription] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [descriptionDraft, setDescriptionDraft] = useState("");
    const [labelPickerAnchor, setLabelPickerAnchor] = useState<{
        readonly x: number;
        readonly y: number;
    } | null>(null);
    const labelPickerTriggerRef = useRef<HTMLSpanElement | null>(null);

    const detail = useGitHubStore(
        (state) =>
            state.pullRequestDetailsByRepo[repoKey]?.[pullRequestNumber] ??
            null,
    );
    const checks = useGitHubStore(
        (state): GitHubPullRequestChecksResult | null | undefined =>
            detail?.head.sha
                ? state.pullRequestChecksByRepo[repoKey]?.[detail.head.sha]
                : undefined,
    );
    const pullRequestDiff = useGitHubStore(
        (state) =>
            state.pullRequestDiffsByRepo[repoKey]?.[pullRequestNumber] ?? null,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[repo.host] ?? null,
    );
    const labels = useGitHubStore(
        (state) => state.labelsByRepo[repoKey] ?? EMPTY_GITHUB_LIST,
    );
    const commentMutatingKeys = useGitHubStore((state) => state.mutatingKeys);
    const commentErrors = useGitHubStore((state) => state.errors);

    const checksKey = detail?.head.sha
        ? getGitHubPullRequestChecksKey(repo, detail.head.sha)
        : null;

    const { isLoading, isLoadingChanges, isLoadingChecks, isLoadingLabels } = useGitHubStore(
        useShallow((state) => ({
            isLoading:
                state.loadingKeys[
                    `${repoKey}:pr:${pullRequestNumber}`
                ] ?? false,
            isLoadingChecks: checksKey
                ? (state.loadingKeys[checksKey] ?? false)
                : false,
            isLoadingChanges:
                state.loadingKeys[`${repoKey}:pr:${pullRequestNumber}:diff`] ?? false,
            isLoadingLabels: state.loadingKeys[`${repoKey}:labels`] ?? false,
        })),
    );

    const {
        isCommenting,
        isMarkingReady,
        isConvertingDraft,
        isRequestingReview,
        isUpdatingPullRequest,
        isUpdatingLabels,
    } = useGitHubStore(
        useShallow((state) => ({
            isCommenting:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:comment`
                ] ?? false,
            isConvertingDraft:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:draft`
                ] ?? false,
            isMarkingReady:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:ready`
                ] ?? false,
            isRequestingReview:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:request-review`
                ] ?? false,
            isUpdatingPullRequest:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:update`
                ] ?? false,
            isUpdatingLabels:
                state.mutatingKeys[
                    `${repoKey}:pr:${pullRequestNumber}:labels`
                ] ?? false,
        })),
    );

    const {
        detailError,
        commentError,
        readyError,
        draftError,
        requestReviewError,
        checksError,
        updateError,
        labelMutationError,
        labelsError,
        changesError,
    } = useGitHubStore(
        useShallow((state) => ({
            checksError: checksKey ? (state.errors[checksKey] ?? null) : null,
            commentError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:comment`
                ] ?? null,
            detailError:
                state.errors[`${repoKey}:pr:${pullRequestNumber}`] ?? null,
            draftError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:draft`
                ] ?? null,
            readyError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:ready`
                ] ?? null,
            requestReviewError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:request-review`
                ] ?? null,
            updateError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:update`
                ] ?? null,
            labelMutationError:
                state.errors[
                    `${repoKey}:pr:${pullRequestNumber}:labels`
                ] ?? null,
            labelsError: state.errors[`${repoKey}:labels`] ?? null,
            changesError:
                state.errors[`${repoKey}:pr:${pullRequestNumber}:diff`] ?? null,
        })),
    );

    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const ensurePullRequestDetail = useGitHubStore(
        (state) => state.ensurePullRequestDetail,
    );
    const ensurePullRequestDiff = useGitHubStore(
        (state) => state.ensurePullRequestDiff,
    );
    const refreshPullRequestChecks = useGitHubStore(
        (state) => state.refreshPullRequestChecks,
    );
    const commentPullRequest = useGitHubStore(
        (state) => state.commentPullRequest,
    );
    const updateComment = useGitHubStore((state) => state.updateComment);
    const markPullRequestReady = useGitHubStore(
        (state) => state.markPullRequestReady,
    );
    const convertPullRequestToDraft = useGitHubStore(
        (state) => state.convertPullRequestToDraft,
    );
    const requestPullRequestReviewers = useGitHubStore(
        (state) => state.requestPullRequestReviewers,
    );
    const updatePullRequest = useGitHubStore(
        (state) => state.updatePullRequest,
    );
    const refreshLabels = useGitHubStore((state) => state.refreshLabels);
    const setPullRequestLabels = useGitHubStore(
        (state) => state.setPullRequestLabels,
    );
    const openGitCommitTab = useWorkspaceStore(
        (state) => state.openGitCommitTab,
    );

    const canWritePullRequests = hasGitHubWritePermission(
        authStatus,
        "pull_requests",
    );
    const canEditLabels =
        canWritePullRequests || hasGitHubWritePermission(authStatus, "issues");
    const canCommentPullRequests =
        hasGitHubWritePermission(authStatus, "issues") ||
        canWritePullRequests;
    const writePermissionLabel = getGitHubWritePermissionLabel("pull_requests");
    const commentPermissionLabel =
        "Your GitHub token cannot write PR conversation comments.";
    const labelPermissionLabel =
        "Your GitHub token cannot edit pull request labels.";

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            if (
                useGitHubStore.getState().pullRequestDetailsByRepo[repoKey]?.[
                    pullRequestNumber
                ] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[repo.host] ??
                (await refreshAuthStatus(repo));
            if (!cancelled && status.state === "authenticated") {
                await ensurePullRequestDetail(repo, pullRequestNumber);
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [
        ensurePullRequestDetail,
        pullRequestNumber,
        refreshAuthStatus,
        repo,
        repoKey,
    ]);

    useEffect(() => {
        if (!showChanges || pullRequestDiff || isLoadingChanges) return;
        void ensurePullRequestDiff(repo, pullRequestNumber).catch(() => undefined);
    }, [
        ensurePullRequestDiff,
        isLoadingChanges,
        pullRequestDiff,
        pullRequestNumber,
        repo,
        showChanges,
    ]);

    useEffect(() => {
        if (
            authStatus?.state !== "authenticated" ||
            !detail?.head.sha ||
            checks !== undefined ||
            isLoadingChecks ||
            checksError
        ) {
            return;
        }

        void refreshPullRequestChecks(repo, {
            headSha: detail.head.sha,
            pullRequestNumber: detail.number,
        }).catch(() => undefined);
    }, [
        authStatus?.state,
        checks,
        checksError,
        detail?.head.sha,
        detail?.number,
        isLoadingChecks,
        refreshPullRequestChecks,
        repo,
    ]);

    const handleRefresh = async () => {
        const status = await refreshAuthStatus(repo);
        if (status.state === "authenticated") {
            const refreshedDetail = await ensurePullRequestDetail(
                repo,
                pullRequestNumber,
                {
                    force: true,
                },
            );
            const checksTarget = refreshedDetail ?? detail;
            if (checksTarget?.head.sha) {
                await refreshPullRequestChecks(
                    repo,
                    {
                        headSha: checksTarget.head.sha,
                        pullRequestNumber: checksTarget.number,
                    },
                    {
                        force: true,
                    },
                ).catch(() => undefined);
            }
            if (showChanges || pullRequestDiff) {
                await ensurePullRequestDiff(repo, pullRequestNumber, {
                    force: true,
                }).catch(() => undefined);
            }
        }
    };

    const handleComment = async () => {
        const body = commentDraft.trim();
        if (!body || !canCommentPullRequests) {
            return;
        }

        await commentPullRequest(repo, pullRequestNumber, body);
        setCommentDraft("");
    };

    const handleUpdateComment = async (
        comment: GitHubCommentSummary,
        body: string,
    ) => {
        await updateComment(repo, {
            body,
            commentId: comment.id,
        });
    };

    const handleMarkReady = async () => {
        if (!canWritePullRequests) {
            return;
        }
        await markPullRequestReady(repo, pullRequestNumber);
    };

    const handleConvertToDraft = async () => {
        if (!canWritePullRequests) {
            return;
        }
        await convertPullRequestToDraft(repo, pullRequestNumber);
    };

    const handleRequestReview = async (
        reviewers: readonly string[],
        teamReviewers: readonly string[],
    ) => {
        if (
            !canWritePullRequests ||
            (reviewers.length === 0 && teamReviewers.length === 0)
        ) {
            return;
        }

        await requestPullRequestReviewers(repo, pullRequestNumber, {
            reviewers: reviewers.length > 0 ? reviewers : null,
            teamReviewers: teamReviewers.length > 0 ? teamReviewers : null,
        });
    };

    const handleStartEditingDescription = () => {
        if (!canWritePullRequests || !detail) {
            return;
        }

        setTitleDraft(detail.title);
        setDescriptionDraft(detail.body ?? "");
        setIsEditingDescription(true);
    };

    const handleCancelEditingDescription = () => {
        setTitleDraft(detail?.title ?? "");
        setDescriptionDraft(detail?.body ?? "");
        setIsEditingDescription(false);
    };

    const handleSaveDescription = async () => {
        const title = titleDraft.trim();
        if (!canWritePullRequests || !detail || !title) {
            return;
        }

        await updatePullRequest(repo, pullRequestNumber, {
            body: descriptionDraft,
            title,
        });
        setIsEditingDescription(false);
    };

    const handleOpenLabelPicker = () => {
        if (!detail || !canEditLabels) {
            return;
        }

        const rect = labelPickerTriggerRef.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }

        setLabelPickerAnchor({ x: rect.left, y: rect.bottom + 6 });
        void refreshLabels(repo).catch(() => undefined);
    };

    const handleSaveLabels = async (labelNames: readonly string[]) => {
        if (!detail || !canEditLabels) {
            return;
        }

        try {
            await setPullRequestLabels(repo, pullRequestNumber, labelNames);
            setLabelPickerAnchor(null);
        } catch {
            // The store exposes the mutation error while the picker remains open.
        }
    };

    const stateTone = detail?.draft
        ? "draft"
        : detail?.mergedAt
          ? "merged"
          : (detail?.state ?? "neutral");
    const stateLabel = detail?.draft
        ? "draft"
        : detail?.mergedAt
          ? "merged"
          : detail?.state;
    const checksState: GitHubPullRequestChecksState | "loading" =
        isLoadingChecks ? "loading" : (checks?.state ?? "unknown");
    const showMergeable =
        detail?.state === "open" && !detail?.mergedAt;
    const mergeableState = deriveGitHubMergeableState(detail?.mergeable);
    const showLifecycleCta =
        detail?.state === "open" && !detail?.mergedAt;
    const titleChanged = titleDraft.trim() !== (detail?.title ?? "").trim();
    const descriptionChanged = descriptionDraft !== (detail?.body ?? "");
    const saveDescriptionDisabled =
        !canWritePullRequests ||
        isUpdatingPullRequest ||
        titleDraft.trim().length === 0 ||
        (!titleChanged && !descriptionChanged);

    const commits = detail?.commits ?? [];
    const visibleCommits = showAllCommits
        ? commits
        : commits.slice(0, COMMITS_PREVIEW_LIMIT);
    const hiddenCommitsCount = Math.max(
        0,
        commits.length - COMMITS_PREVIEW_LIMIT,
    );

    return (
        <GitHubTabShell
            header={
                <GitHubTabHeader
                    actions={
                        <>
                            <IdeActionButton
                                onClick={() => setShowChanges((current) => !current)}
                            >
                                {showChanges
                                    ? "Overview"
                                    : `Changes ${detail?.changedFileCount ?? ""}`.trim()}
                            </IdeActionButton>
                            <IdeActionButton
                                onClick={() =>
                                    openGitHubWebUrl(
                                        detail?.url ??
                                            buildGitHubWebUrl(
                                                repo,
                                                `/pull/${pullRequestNumber}`,
                                            ),
                                    )
                                }
                            >
                                Open in GitHub
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={isLoading}
                                onClick={() => void handleRefresh()}
                            >
                                Refresh
                            </IdeActionButton>
                        </>
                    }
                    meta={
                        detail ? (
                            <span
                                className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-primary"
                                title={detail.title}
                            >
                                {detail.title}
                            </span>
                        ) : null
                    }
                    repo={repo}
                    title={`PR #${pullRequestNumber}`}
                />
            }
            scrollScope={{
                entityId: `${repoKey}/pulls/${pullRequestNumber}`,
                projectId,
                surface: "github_pull_request",
                worktreeId: worktreeId ?? null,
            }}
        >
            <div className="github-document space-y-8">
                <GitHubAuthNotice authStatus={authStatus} />
                {detailError ? (
                    <GitHubErrorState>{detailError}</GitHubErrorState>
                ) : null}
                {isLoading && !detail ? <PullRequestOverviewSkeleton /> : null}
                {!isLoading && !detail ? (
                    <GitHubEmptyState>
                        PR #{pullRequestNumber} could not be loaded.
                    </GitHubEmptyState>
                ) : null}
                {detail ? (
                    <>
                        <section className="space-y-4">
                            <div className="flex min-w-0 items-start gap-1.5">
                                <div className="min-w-0 flex-1">
                                    {isEditingDescription ? (
                                        <input
                                            className="h-11 w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 text-[22px] font-bold leading-7 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                                            disabled={isUpdatingPullRequest}
                                            onChange={(event) =>
                                                setTitleDraft(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            placeholder="Pull request title"
                                            value={titleDraft}
                                        />
                                    ) : (
                                        <h1 className="github-document-title">
                                            {detail.title}
                                        </h1>
                                    )}
                                </div>
                                <span
                                    className="shrink-0"
                                    ref={labelPickerTriggerRef}
                                >
                                    <button
                                        aria-label="Edit labels"
                                        className="review-icon-btn"
                                        disabled={!canEditLabels}
                                        onClick={handleOpenLabelPicker}
                                        title={
                                            canEditLabels
                                                ? "Edit labels"
                                                : labelPermissionLabel
                                        }
                                        type="button"
                                    >
                                        <PencilIcon />
                                    </button>
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <GitHubStatePill tone={stateTone}>
                                    {stateLabel}
                                </GitHubStatePill>
                                {showMergeable ? (
                                    <GitHubMergeablePill
                                        state={mergeableState}
                                    />
                                ) : null}
                                <span className="text-[11px] text-text-secondary">
                                    by{" "}
                                    <span className="text-text-primary">
                                        {detail.author?.login ?? "ghost"}
                                    </span>
                                </span>
                                <span className="text-[11px] text-text-secondary">
                                    updated{" "}
                                    {formatGitHubDateTime(detail.updatedAt)}
                                </span>
                            </div>
                            {detail.labels.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {detail.labels.map((label) => (
                                        <GitHubLabelPill
                                            key={label.id}
                                            label={label}
                                        />
                                    ))}
                                </div>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                <BranchChip>{detail.head.label}</BranchChip>
                                <span className="text-text-secondary">
                                    into
                                </span>
                                <BranchChip>{detail.base.label}</BranchChip>
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-secondary">
                                <span>
                                    <span className="text-text-primary">
                                        {detail.changedFileCount ?? "?"}
                                    </span>{" "}
                                    files
                                </span>
                                <span aria-hidden="true">·</span>
                                <span style={{ color: "var(--diff-add)" }}>
                                    +{detail.additions ?? 0}
                                </span>
                                <span style={{ color: "var(--diff-remove)" }}>
                                    -{detail.deletions ?? 0}
                                </span>
                            </div>
                            {showMergeable && mergeableState === "conflicts" ? (
                                <div className="text-[11px] text-[color:var(--diff-remove)]">
                                    Resolve conflicts before merging.
                                </div>
                            ) : null}
                            {showLifecycleCta ? (
                                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                                    <RequestReviewerPopover
                                        canWrite={canWritePullRequests}
                                        error={requestReviewError}
                                        isRequesting={isRequestingReview}
                                        onRequest={handleRequestReview}
                                        permissionLabel={writePermissionLabel}
                                    />
                                    {detail.draft ? (
                                        <GitHubConfirmActionButton
                                            armedLabel="Click again to mark ready"
                                            disabled={
                                                !canWritePullRequests ||
                                                isMarkingReady
                                            }
                                            onConfirm={() =>
                                                void handleMarkReady()
                                            }
                                            title={
                                                canWritePullRequests
                                                    ? undefined
                                                    : writePermissionLabel
                                            }
                                        >
                                            {isMarkingReady
                                                ? "Updating..."
                                                : "Mark Ready for Review"}
                                        </GitHubConfirmActionButton>
                                    ) : (
                                        <GitHubConfirmActionButton
                                            armedLabel="Click again to convert"
                                            disabled={
                                                !canWritePullRequests ||
                                                isConvertingDraft
                                            }
                                            onConfirm={() =>
                                                void handleConvertToDraft()
                                            }
                                            title={
                                                canWritePullRequests
                                                    ? undefined
                                                    : writePermissionLabel
                                            }
                                        >
                                            {isConvertingDraft
                                                ? "Updating..."
                                                : "Convert to Draft"}
                                        </GitHubConfirmActionButton>
                                    )}
                                </div>
                            ) : null}
                            {readyError ? (
                                <div className="text-[11px] text-[color:var(--diff-remove)]">
                                    {readyError}
                                </div>
                            ) : null}
                            {draftError ? (
                                <div className="text-[11px] text-[color:var(--diff-remove)]">
                                    {draftError}
                                </div>
                            ) : null}
                        </section>

                        {showChanges ? (
                            <GitHubSection
                                title="Changes"
                                tone="info"
                            >
                                {isLoadingChanges ? (
                                    <div className="py-6 text-[12px] text-text-secondary">
                                        Loading pull request changes...
                                    </div>
                                ) : changesError ? (
                                    <div className="space-y-3 py-3">
                                        <GitHubErrorState>
                                            {changesError}
                                        </GitHubErrorState>
                                        <IdeActionButton
                                            onClick={() =>
                                                void ensurePullRequestDiff(
                                                    repo,
                                                    pullRequestNumber,
                                                    { force: true },
                                                )
                                            }
                                        >
                                            Retry
                                        </IdeActionButton>
                                    </div>
                                ) : pullRequestDiff ? (
                                    <div className="-mx-5 flex min-h-[360px] flex-col">
                                        {pullRequestDiff.incompleteReason ? (
                                            <div className="px-5 py-2 text-[11px] text-[color:var(--diff-warn)]">
                                                {pullRequestDiff.incompleteReason}
                                            </div>
                                        ) : null}
                                        <GitRevisionDiffView
                                            additions={pullRequestDiff.additions}
                                            deletions={pullRequestDiff.deletions}
                                            files={pullRequestDiff.files}
                                            totalFileCount={pullRequestDiff.totalFileCount}
                                        />
                                    </div>
                                ) : null}
                            </GitHubSection>
                        ) : null}

                        <GitHubSection
                            actions={
                                !isEditingDescription ? (
                                    <IdeActionButton
                                        disabled={!canWritePullRequests}
                                        onClick={handleStartEditingDescription}
                                        title={
                                            canWritePullRequests
                                                ? undefined
                                                : writePermissionLabel
                                        }
                                    >
                                        Edit details
                                    </IdeActionButton>
                                ) : null
                            }
                            bodyClassName={
                                isEditingDescription
                                    ? "space-y-3 pt-4"
                                    : "github-document-markdown pt-4"
                            }
                            title="Description"
                            tone="accent"
                        >
                            {isEditingDescription ? (
                                <>
                                    <textarea
                                        className="min-h-56 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={isUpdatingPullRequest}
                                        onChange={(event) =>
                                            setDescriptionDraft(
                                                event.currentTarget.value,
                                            )
                                        }
                                        placeholder="Describe this pull request..."
                                        value={descriptionDraft}
                                    />
                                    {updateError ? (
                                        <div className="text-[11px] text-[color:var(--diff-remove)]">
                                            {updateError}
                                        </div>
                                    ) : null}
                                    <div className="border-t border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] pt-3">
                                        <GitHubSectionLabel>
                                            Preview
                                        </GitHubSectionLabel>
                                        <div className="github-document-markdown mt-3 max-h-72 overflow-y-auto">
                                            <MarkdownContent
                                                chatFontSize={14}
                                                content={
                                                    descriptionDraft.trim() ||
                                                    "_No description._"
                                                }
                                            />
                                        </div>
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <IdeActionButton
                                            disabled={isUpdatingPullRequest}
                                            onClick={
                                                handleCancelEditingDescription
                                            }
                                        >
                                            Cancel
                                        </IdeActionButton>
                                        <IdeActionButton
                                            disabled={saveDescriptionDisabled}
                                            onClick={() =>
                                                void handleSaveDescription()
                                            }
                                            title={
                                                canWritePullRequests
                                                    ? undefined
                                                    : writePermissionLabel
                                            }
                                        >
                                            {isUpdatingPullRequest
                                                ? "Saving..."
                                                : "Save changes"}
                                        </IdeActionButton>
                                    </div>
                                </>
                            ) : (
                                <MarkdownContent
                                    chatFontSize={14}
                                    content={
                                        detail.body || "_No description._"
                                    }
                                />
                            )}
                        </GitHubSection>

                        <GitHubSection
                            actions={
                                hiddenCommitsCount > 0 ? (
                                    <IdeActionButton
                                        onClick={() =>
                                            setShowAllCommits((prev) => !prev)
                                        }
                                    >
                                        {showAllCommits
                                            ? "Collapse"
                                            : `Show all ${commits.length}`}
                                    </IdeActionButton>
                                ) : null
                            }
                            bodyClassName="divide-y divide-[color-mix(in_srgb,var(--color-border)_55%,transparent)] pt-2"
                            count={commits.length}
                            title="Commits"
                            tone="info"
                        >
                            <>
                                {visibleCommits.map((commit) => {
                                    const subject =
                                        commit.message.split("\n")[0] ??
                                        commit.shortSha;
                                    const handleOpenCommit = () =>
                                        void openGitCommitTab({
                                            commitSha: commit.sha,
                                            projectId,
                                            subject,
                                            worktreeId: worktreeId ?? null,
                                        });

                                    return (
                                        <div
                                            className="group/commit -mx-2 flex items-center rounded-md px-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_55%,transparent)] focus-within:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_55%,transparent)]"
                                            key={commit.sha}
                                        >
                                            <button
                                                className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 text-left text-[12px]"
                                                onClick={handleOpenCommit}
                                                title={`Open commit ${commit.shortSha}`}
                                                type="button"
                                            >
                                                <span className="min-w-0 flex-1 truncate text-text-primary">
                                                    {subject}
                                                </span>
                                                {commit.additions != null ||
                                                commit.deletions != null ? (
                                                    <span
                                                        className="shrink-0 text-[10.5px]"
                                                        style={{
                                                            fontFamily:
                                                                "var(--font-mono)",
                                                        }}
                                                    >
                                                        {commit.additions != null ? (
                                                            <span
                                                                style={{
                                                                    color: "var(--diff-add)",
                                                                }}
                                                            >
                                                                +{commit.additions}
                                                            </span>
                                                        ) : null}
                                                        {commit.additions != null &&
                                                        commit.deletions != null ? (
                                                            <span> </span>
                                                        ) : null}
                                                        {commit.deletions != null ? (
                                                            <span
                                                                style={{
                                                                    color: "var(--diff-remove)",
                                                                }}
                                                            >
                                                                -{commit.deletions}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                ) : null}
                                                <span className="shrink-0 font-mono text-text-secondary">
                                                    {commit.shortSha}
                                                </span>
                                            </button>
                                            <div className="ml-3 shrink-0">
                                                <IdeActionButton
                                                    onClick={handleOpenCommit}
                                                    title={`Open commit ${commit.shortSha}`}
                                                >
                                                    Open
                                                </IdeActionButton>
                                            </div>
                                        </div>
                                    );
                                })}
                                {commits.length === 0 ? (
                                    <div className="py-3 text-[12px] text-text-secondary">
                                        No commit details available yet.
                                    </div>
                                ) : null}
                            </>
                        </GitHubSection>

                        <GitHubSection
                            count={detail.comments.length}
                            title="Conversation"
                            tone="neutral"
                        >
                            <div className="space-y-5">
                                <GitHubCommentList
                                    canEdit={canCommentPullRequests}
                                    comments={detail.comments}
                                    getUpdateError={(comment) =>
                                        commentErrors[
                                            `${repoKey}:comment:${comment.id}:update`
                                        ] ?? null
                                    }
                                    isUpdatingComment={(comment) =>
                                        commentMutatingKeys[
                                            `${repoKey}:comment:${comment.id}:update`
                                        ] ?? false
                                    }
                                    onUpdateComment={(comment, body) =>
                                        handleUpdateComment(comment, body)
                                    }
                                    permissionLabel={commentPermissionLabel}
                                />
                                <GitHubCommentComposer
                                    disabled={!canCommentPullRequests}
                                    error={commentError}
                                    isSubmitting={isCommenting}
                                    onChange={setCommentDraft}
                                    onSubmit={() => void handleComment()}
                                    permissionLabel={commentPermissionLabel}
                                    value={commentDraft}
                                />
                            </div>
                        </GitHubSection>

                        <GitHubActionsPanel
                            authStatus={authStatus}
                            branch={detail.head.ref}
                            checksCount={checks?.checks?.length ?? null}
                            checksState={checksState}
                            checksUrl={checks?.url ?? null}
                            headSha={detail.head.sha}
                            repo={repo}
                        />
                        {checksError ? (
                            <GitHubErrorState>
                                Checks could not be loaded. {checksError}
                            </GitHubErrorState>
                        ) : null}
                    </>
                ) : null}
            </div>
            {detail && labelPickerAnchor ? (
                <GitHubLabelPicker
                    anchor={labelPickerAnchor}
                    error={labelMutationError ?? labelsError}
                    isLoading={isLoadingLabels}
                    isSaving={isUpdatingLabels}
                    item={detail}
                    key={detail.number}
                    labels={labels}
                    onClose={() => setLabelPickerAnchor(null)}
                    onSave={(labelNames) => void handleSaveLabels(labelNames)}
                />
            ) : null}
        </GitHubTabShell>
    );
}

function BranchChip({ children }: { readonly children: ReactNode }) {
    return (
        <span
            className="inline-flex max-w-[260px] items-center truncate rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-primary"
            title={typeof children === "string" ? children : undefined}
        >
            {children}
        </span>
    );
}

function PencilIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
            width="14"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
}

function PullRequestOverviewSkeleton() {
    return (
        <div className="animate-pulse space-y-3 py-2">
            <div className="flex gap-2">
                <div className="h-4 w-16 rounded bg-bg-tertiary" />
                <div className="h-4 w-24 rounded bg-bg-tertiary" />
                <div className="h-4 w-28 rounded bg-bg-tertiary" />
            </div>
            <div className="h-3 w-2/3 rounded bg-bg-tertiary" />
            <div className="h-3 w-1/3 rounded bg-bg-tertiary" />
        </div>
    );
}

function parseCsv(value: string): readonly string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function RequestReviewerPopover({
    canWrite,
    error,
    isRequesting,
    onRequest,
    permissionLabel,
}: {
    readonly canWrite: boolean;
    readonly error: string | null;
    readonly isRequesting: boolean;
    readonly onRequest: (
        reviewers: readonly string[],
        teamReviewers: readonly string[],
    ) => Promise<void>;
    readonly permissionLabel: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [reviewers, setReviewers] = useState("");
    const [teams, setTeams] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        const handlePointerDown = (event: PointerEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [isOpen]);

    const parsedReviewers = parseCsv(reviewers);
    const parsedTeams = parseCsv(teams);
    const submitDisabled =
        !canWrite ||
        isRequesting ||
        (parsedReviewers.length === 0 && parsedTeams.length === 0);

    const handleSubmit = async () => {
        if (submitDisabled) {
            return;
        }
        await onRequest(parsedReviewers, parsedTeams);
        setReviewers("");
        setTeams("");
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={containerRef}>
            <IdeActionButton
                disabled={!canWrite}
                onClick={() => setIsOpen((prev) => !prev)}
                title={canWrite ? undefined : permissionLabel}
            >
                Request reviewers
            </IdeActionButton>
            {isOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 w-[320px] space-y-2 rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-3 shadow-lg">
                    <GitHubInput
                        disabled={!canWrite || isRequesting}
                        onChange={setReviewers}
                        placeholder="Reviewers, comma separated"
                        value={reviewers}
                    />
                    <GitHubInput
                        disabled={!canWrite || isRequesting}
                        onChange={setTeams}
                        placeholder="Team slugs, comma separated"
                        value={teams}
                    />
                    {error ? (
                        <div className="text-[11px] text-[color:var(--diff-remove)]">
                            {error}
                        </div>
                    ) : null}
                    <div className="flex justify-end">
                        <IdeActionButton
                            disabled={submitDisabled}
                            onClick={() => void handleSubmit()}
                        >
                            {isRequesting ? "Requesting..." : "Send request"}
                        </IdeActionButton>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
