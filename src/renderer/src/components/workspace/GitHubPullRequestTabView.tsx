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

    const { isLoading, isLoadingChecks, isLoadingLabels } = useGitHubStore(
        useShallow((state) => ({
            isLoading:
                state.loadingKeys[
                    `${repoKey}:pr:${pullRequestNumber}`
                ] ?? false,
            isLoadingChecks: checksKey
                ? (state.loadingKeys[checksKey] ?? false)
                : false,
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
        })),
    );

    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const ensurePullRequestDetail = useGitHubStore(
        (state) => state.ensurePullRequestDetail,
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
            <div className="space-y-4 p-4">
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
                        <section
                            className="space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3"
                        >
                            {isEditingDescription ? (
                                <input
                                    className="h-9 w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 text-[18px] font-semibold leading-7 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] disabled:cursor-not-allowed disabled:opacity-50"
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
                                <h1 className="text-[18px] font-semibold leading-7 text-text-primary">
                                    {detail.title}
                                </h1>
                            )}
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
                            <div className="flex flex-wrap items-center gap-1.5">
                                {detail.labels.map((label) => (
                                    <GitHubLabelPill
                                        key={label.id}
                                        label={label}
                                    />
                                ))}
                                <span ref={labelPickerTriggerRef}>
                                    <IdeActionButton
                                        disabled={!canEditLabels}
                                        onClick={handleOpenLabelPicker}
                                        title={
                                            canEditLabels
                                                ? undefined
                                                : labelPermissionLabel
                                        }
                                    >
                                        Edit labels
                                    </IdeActionButton>
                                </span>
                            </div>
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
                                    ? "space-y-3 px-4 py-4"
                                    : "px-4 py-4 text-[13px] leading-6 text-text-secondary"
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
                                    <div className="rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2">
                                        <GitHubSectionLabel>
                                            Preview
                                        </GitHubSectionLabel>
                                        <div className="mt-2 max-h-72 overflow-y-auto text-[12px] leading-5 text-text-secondary">
                                            <MarkdownContent
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
                            bodyClassName="space-y-1 px-2 py-2"
                            count={commits.length}
                            title="Commits"
                            tone="info"
                        >
                            <>
                                {visibleCommits.map((commit) => (
                                    <button
                                        className="flex w-full items-center justify-between gap-3 rounded-md border-l-[3px] border-l-transparent px-2 py-1 text-left text-[11px] transition hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-tertiary"
                                        key={commit.sha}
                                        onClick={() =>
                                            void openGitCommitTab({
                                                commitSha: commit.sha,
                                                projectId,
                                                subject:
                                                    commit.message.split(
                                                        "\n",
                                                    )[0] ?? commit.shortSha,
                                                worktreeId:
                                                    worktreeId ?? null,
                                            })
                                        }
                                        type="button"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-text-primary">
                                            {commit.message.split("\n")[0]}
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
                                ))}
                                {commits.length === 0 ? (
                                    <div className="px-2 py-3 text-[11px] text-text-secondary">
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
                            <div className="space-y-3">
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

function PullRequestOverviewSkeleton() {
    return (
        <div className="animate-pulse space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3">
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
