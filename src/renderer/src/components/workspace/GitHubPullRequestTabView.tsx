import { useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import type { GitHubPullRequestChecksState } from "@shared/ipc";

import {
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
    GitHubChecksPill,
    GitHubChecksTable,
    GitHubCommentComposer,
    GitHubCommentList,
    GitHubConfirmActionButton,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubInput,
    GitHubMergeablePill,
    GitHubSectionLabel,
    GitHubStatePill,
    GitHubTabHeader,
    GitHubTabShell,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { GitHubActionsPanel } from "./GitHubActionsPanel";
import { MarkdownContent } from "./MarkdownContent";
import { IdeActionButton } from "./ide-bar";

const COMMITS_PREVIEW_LIMIT = 12;

export function GitHubPullRequestTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitHubPullRequestTab;
}) {
    const repoKey = getGitHubRepoKey(tab.ref);
    const [commentDraft, setCommentDraft] = useState("");
    const [reviewerDraft, setReviewerDraft] = useState("");
    const [teamReviewerDraft, setTeamReviewerDraft] = useState("");
    const [showAllCommits, setShowAllCommits] = useState(false);

    const detail = useGitHubStore(
        (state) =>
            state.pullRequestDetailsByRepo[repoKey]?.[
                tab.pullRequestNumber
            ] ?? null,
    );
    const checks = useGitHubStore((state) =>
        detail?.head.sha
            ? (state.pullRequestChecksByRepo[repoKey]?.[detail.head.sha] ??
              null)
            : null,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[tab.ref.host] ?? null,
    );

    const checksKey = detail?.head.sha
        ? getGitHubPullRequestChecksKey(tab.ref, detail.head.sha)
        : null;

    const { isLoading, isLoadingChecks } = useGitHubStore(
        useShallow((state) => ({
            isLoading:
                state.loadingKeys[
                    `${repoKey}:pr:${tab.pullRequestNumber}`
                ] ?? false,
            isLoadingChecks: checksKey
                ? (state.loadingKeys[checksKey] ?? false)
                : false,
        })),
    );

    const {
        isCommenting,
        isMarkingReady,
        isConvertingDraft,
        isRequestingReview,
    } = useGitHubStore(
        useShallow((state) => ({
            isCommenting:
                state.mutatingKeys[
                    `${repoKey}:pr:${tab.pullRequestNumber}:comment`
                ] ?? false,
            isConvertingDraft:
                state.mutatingKeys[
                    `${repoKey}:pr:${tab.pullRequestNumber}:draft`
                ] ?? false,
            isMarkingReady:
                state.mutatingKeys[
                    `${repoKey}:pr:${tab.pullRequestNumber}:ready`
                ] ?? false,
            isRequestingReview:
                state.mutatingKeys[
                    `${repoKey}:pr:${tab.pullRequestNumber}:request-review`
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
    } = useGitHubStore(
        useShallow((state) => ({
            checksError: checksKey ? (state.errors[checksKey] ?? null) : null,
            commentError:
                state.errors[
                    `${repoKey}:pr:${tab.pullRequestNumber}:comment`
                ] ?? null,
            detailError:
                state.errors[`${repoKey}:pr:${tab.pullRequestNumber}`] ??
                null,
            draftError:
                state.errors[
                    `${repoKey}:pr:${tab.pullRequestNumber}:draft`
                ] ?? null,
            readyError:
                state.errors[
                    `${repoKey}:pr:${tab.pullRequestNumber}:ready`
                ] ?? null,
            requestReviewError:
                state.errors[
                    `${repoKey}:pr:${tab.pullRequestNumber}:request-review`
                ] ?? null,
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
    const markPullRequestReady = useGitHubStore(
        (state) => state.markPullRequestReady,
    );
    const convertPullRequestToDraft = useGitHubStore(
        (state) => state.convertPullRequestToDraft,
    );
    const requestPullRequestReviewers = useGitHubStore(
        (state) => state.requestPullRequestReviewers,
    );
    const openGitCommitTab = useWorkspaceStore(
        (state) => state.openGitCommitTab,
    );

    const canWritePullRequests = hasGitHubWritePermission(
        authStatus,
        "pull_requests",
    );
    const canCommentPullRequests =
        hasGitHubWritePermission(authStatus, "issues") ||
        canWritePullRequests;
    const writePermissionLabel = getGitHubWritePermissionLabel("pull_requests");
    const commentPermissionLabel =
        "Your GitHub token cannot write PR conversation comments.";

    useEffect(() => {
        let cancelled = false;

        async function refreshInitialData() {
            const status = await refreshAuthStatus(tab.ref);
            if (!cancelled && status.state === "authenticated") {
                await ensurePullRequestDetail(tab.ref, tab.pullRequestNumber);
            }
        }

        void refreshInitialData();

        return () => {
            cancelled = true;
        };
    }, [
        ensurePullRequestDetail,
        refreshAuthStatus,
        tab.pullRequestNumber,
        tab.ref,
    ]);

    useEffect(() => {
        if (
            authStatus?.state !== "authenticated" ||
            !detail?.head.sha ||
            checks !== null ||
            isLoadingChecks ||
            checksError
        ) {
            return;
        }

        void refreshPullRequestChecks(tab.ref, {
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
        tab.ref,
    ]);

    const handleRefresh = async () => {
        const status = await refreshAuthStatus(tab.ref);
        if (status.state === "authenticated") {
            const refreshedDetail = await ensurePullRequestDetail(
                tab.ref,
                tab.pullRequestNumber,
                {
                    force: true,
                },
            );
            const checksTarget = refreshedDetail ?? detail;
            if (checksTarget?.head.sha) {
                await refreshPullRequestChecks(
                    tab.ref,
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

        await commentPullRequest(tab.ref, tab.pullRequestNumber, body);
        setCommentDraft("");
    };

    const handleMarkReady = async () => {
        if (!canWritePullRequests) {
            return;
        }
        await markPullRequestReady(tab.ref, tab.pullRequestNumber);
    };

    const handleConvertToDraft = async () => {
        if (!canWritePullRequests) {
            return;
        }
        await convertPullRequestToDraft(tab.ref, tab.pullRequestNumber);
    };

    const handleRequestReview = async () => {
        const reviewers = parseCsv(reviewerDraft);
        const teamReviewers = parseCsv(teamReviewerDraft);
        if (
            !canWritePullRequests ||
            (reviewers.length === 0 && teamReviewers.length === 0)
        ) {
            return;
        }

        await requestPullRequestReviewers(tab.ref, tab.pullRequestNumber, {
            reviewers: reviewers.length > 0 ? reviewers : null,
            teamReviewers: teamReviewers.length > 0 ? teamReviewers : null,
        });
        setReviewerDraft("");
        setTeamReviewerDraft("");
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
    const requestReviewDisabled =
        !canWritePullRequests ||
        isRequestingReview ||
        (parseCsv(reviewerDraft).length === 0 &&
            parseCsv(teamReviewerDraft).length === 0);

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
                                                tab.ref,
                                                `/pull/${tab.pullRequestNumber}`,
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
                            <>
                                <span
                                    className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-primary"
                                    title={detail.title}
                                >
                                    {detail.title}
                                </span>
                                <GitHubStatePill tone={stateTone}>
                                    {stateLabel}
                                </GitHubStatePill>
                                <GitHubChecksPill state={checksState} />
                                {showMergeable ? (
                                    <GitHubMergeablePill
                                        state={mergeableState}
                                    />
                                ) : null}
                            </>
                        ) : null
                    }
                    repo={tab.ref}
                    title={`PR #${tab.pullRequestNumber}`}
                />
            }
        >
            <div className="space-y-4 p-4">
                <GitHubAuthNotice authStatus={authStatus} />
                {detailError ? (
                    <GitHubErrorState>{detailError}</GitHubErrorState>
                ) : null}
                {isLoading && !detail ? <PullRequestOverviewSkeleton /> : null}
                {!isLoading && !detail ? (
                    <GitHubEmptyState>
                        PR #{tab.pullRequestNumber} could not be loaded.
                    </GitHubEmptyState>
                ) : null}
                {detail ? (
                    <>
                        <section
                            className="space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <GitHubStatePill tone={stateTone}>
                                    {stateLabel}
                                </GitHubStatePill>
                                <GitHubChecksPill state={checksState} />
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
                                        {detail.commitCount ??
                                            detail.commits.length}
                                    </span>{" "}
                                    commits
                                </span>
                                <span aria-hidden="true">·</span>
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

                        <section className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary">
                            <div className="border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-4 py-2">
                                <GitHubSectionLabel>
                                    Description
                                </GitHubSectionLabel>
                            </div>
                            <div className="px-4 py-4 text-[13px] leading-6 text-text-secondary">
                                <MarkdownContent
                                    content={detail.body || "_No description._"}
                                />
                            </div>
                        </section>

                        <section className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary">
                            <div className="flex items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] px-4 py-2">
                                <div className="flex items-center gap-2">
                                    <GitHubSectionLabel>
                                        Commits
                                    </GitHubSectionLabel>
                                    <span className="text-[10px] text-text-secondary">
                                        {commits.length}
                                    </span>
                                </div>
                                {hiddenCommitsCount > 0 ? (
                                    <IdeActionButton
                                        onClick={() =>
                                            setShowAllCommits((prev) => !prev)
                                        }
                                    >
                                        {showAllCommits
                                            ? "Collapse"
                                            : `Show all ${commits.length}`}
                                    </IdeActionButton>
                                ) : null}
                            </div>
                            <div className="space-y-1 px-2 py-2">
                                {visibleCommits.map((commit) => (
                                    <button
                                        className="flex w-full items-center justify-between gap-3 rounded-md border-l-[3px] border-l-transparent px-2 py-1 text-left text-[11px] transition hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-tertiary"
                                        key={commit.sha}
                                        onClick={() =>
                                            void openGitCommitTab({
                                                commitSha: commit.sha,
                                                projectId: tab.projectId,
                                                subject:
                                                    commit.message.split(
                                                        "\n",
                                                    )[0] ?? commit.shortSha,
                                                worktreeId:
                                                    tab.worktreeId ?? null,
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
                            </div>
                        </section>

                        <section className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3">
                            <GitHubChecksTable
                                checks={checks?.checks ?? []}
                                error={checksError}
                                isLoading={isLoadingChecks}
                                state={checksState}
                                url={checks?.url ?? null}
                            />
                        </section>

                        <section className="space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3">
                            <GitHubSectionLabel>CI Actions</GitHubSectionLabel>
                            <GitHubActionsPanel
                                authStatus={authStatus}
                                branch={detail.head.ref}
                                headSha={detail.head.sha}
                                ref={tab.ref}
                            />
                        </section>

                        <section className="space-y-3 rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary px-4 py-3">
                            <GitHubSectionLabel>
                                Request review
                            </GitHubSectionLabel>
                            <div className="grid gap-2 md:grid-cols-2">
                                <GitHubInput
                                    disabled={
                                        !canWritePullRequests ||
                                        isRequestingReview
                                    }
                                    onChange={setReviewerDraft}
                                    placeholder="Reviewers, comma separated"
                                    value={reviewerDraft}
                                />
                                <GitHubInput
                                    disabled={
                                        !canWritePullRequests ||
                                        isRequestingReview
                                    }
                                    onChange={setTeamReviewerDraft}
                                    placeholder="Team slugs, comma separated"
                                    value={teamReviewerDraft}
                                />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <div className="text-[10px] text-text-secondary">
                                    Click the button twice to send the review
                                    request.
                                </div>
                                <GitHubConfirmActionButton
                                    armedLabel="Click again to request"
                                    disabled={requestReviewDisabled}
                                    onConfirm={() => void handleRequestReview()}
                                    title={
                                        canWritePullRequests
                                            ? undefined
                                            : writePermissionLabel
                                    }
                                >
                                    {isRequestingReview
                                        ? "Requesting..."
                                        : "Request Review"}
                                </GitHubConfirmActionButton>
                            </div>
                            {requestReviewError ? (
                                <div className="text-[11px] text-[color:var(--diff-remove)]">
                                    {requestReviewError}
                                </div>
                            ) : null}
                        </section>

                        <section className="space-y-3">
                            <GitHubSectionLabel>
                                Conversation
                            </GitHubSectionLabel>
                            <GitHubCommentList comments={detail.comments} />
                            <GitHubCommentComposer
                                disabled={!canCommentPullRequests}
                                error={commentError}
                                isSubmitting={isCommenting}
                                onChange={setCommentDraft}
                                onSubmit={() => void handleComment()}
                                permissionLabel={commentPermissionLabel}
                                value={commentDraft}
                            />
                        </section>
                    </>
                ) : null}
            </div>
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
