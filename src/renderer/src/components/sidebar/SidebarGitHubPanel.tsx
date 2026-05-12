import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
    GitHubAuthStatus,
    GitHubIssueState,
    GitHubIssueSummary,
    GitHubPullRequestSummary,
    GitHubRepositoryRef,
    GitRepositorySnapshot,
} from "@shared/ipc";

import {
    countCurrentBranchPullRequests,
    isPullRequestForCurrentBranch,
    sortPullRequestsNewestFirst,
} from "@renderer/app/github/current-branch-pr";
import { resolveGitHubRepositoryRef } from "@renderer/app/git/remote-link";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    EMPTY_GITHUB_LIST,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    formatGitHubRelativeTime,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubLabelPill,
    GitHubUsers,
} from "@renderer/components/workspace/GitHubWorkspacePrimitives";

import {
    emitSidebarGitHubDrag,
    type SidebarGitHubDragItemKind,
} from "./sidebarGitHubDragEvents";

type SidebarGitHubPanelKind = "issues" | "pull_requests";
type SidebarIssueFilter = GitHubIssueState | "all" | "assigned";
type SidebarPullRequestFilter = "all" | "branch" | "closed" | "draft" | "open";

type SidebarGitHubDragPreview = {
    readonly kindLabel: string;
    readonly meta: string;
    readonly title: string;
    readonly x: number;
    readonly y: number;
};

const SIDEBAR_GITHUB_DRAG_THRESHOLD_PX = 6;

export function SidebarGitHubPanel({
    filter,
    kind,
    onOpenSettings,
    projectId,
    worktreeId,
}: {
    readonly filter?: string;
    readonly kind: SidebarGitHubPanelKind;
    readonly onOpenSettings: () => void;
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}) {
    const snapshot = useGitStore((state) =>
        projectId
            ? getProjectSnapshot(state.snapshots, projectId, worktreeId)
            : null,
    );
    const repoRef = useMemo(
        () => resolveGitHubRepositoryRef(snapshot?.remotes ?? []),
        [snapshot?.remotes],
    );
    const repoKey = repoRef ? getGitHubRepoKey(repoRef) : null;
    const authStatus = useGitHubStore((state) =>
        repoRef ? (state.authStatusByHost[repoRef.host] ?? null) : null,
    );
    const [issueFilter, setIssueFilter] =
        useState<SidebarIssueFilter>("open");
    const [pullRequestFilter, setPullRequestFilter] =
        useState<SidebarPullRequestFilter>("open");
    const currentBranch = snapshot?.branch?.isDetached
        ? null
        : (snapshot?.branch?.name ?? null);
    const requiredIssueListState = getIssueListState(issueFilter);
    const requiredPullRequestListState =
        getPullRequestListState(pullRequestFilter);
    const issues = useGitHubStore((state): readonly GitHubIssueSummary[] =>
        repoKey
            ? (state.issuesByRepoAndState[repoKey]?.[
                  requiredIssueListState
              ] ??
              (state.issueListStateByRepo[repoKey] === requiredIssueListState
                  ? (state.issuesByRepo[repoKey] ?? EMPTY_GITHUB_LIST)
                  : EMPTY_GITHUB_LIST))
            : EMPTY_GITHUB_LIST,
    );
    const hasIssueCache = useGitHubStore((state) =>
        repoKey
            ? state.issuesByRepoAndState[repoKey]?.[
                  requiredIssueListState
              ] !== undefined
            : false,
    );
    const pullRequests = useGitHubStore(
        (state): readonly GitHubPullRequestSummary[] =>
            repoKey
                ? (state.pullRequestsByRepoAndState[repoKey]?.[
                      requiredPullRequestListState
                  ] ??
                  (state.pullRequestListStateByRepo[repoKey] ===
                  requiredPullRequestListState
                      ? (state.pullRequestsByRepo[repoKey] ??
                        EMPTY_GITHUB_LIST)
                      : EMPTY_GITHUB_LIST))
                : EMPTY_GITHUB_LIST,
    );
    const hasPullRequestCache = useGitHubStore((state) =>
        repoKey
            ? state.pullRequestsByRepoAndState[repoKey]?.[
                  requiredPullRequestListState
              ] !== undefined
            : false,
    );
    const isCheckingAuth = useGitHubStore((state) =>
        repoRef ? (state.loadingKeys[`auth:${repoRef.host}`] ?? false) : false,
    );
    const isLoadingIssues = useGitHubStore((state) =>
        repoKey ? (state.loadingKeys[`${repoKey}:issues`] ?? false) : false,
    );
    const isLoadingPullRequests = useGitHubStore((state) =>
        repoKey ? (state.loadingKeys[`${repoKey}:prs`] ?? false) : false,
    );
    const issueError = useGitHubStore((state) =>
        repoKey ? (state.errors[`${repoKey}:issues`] ?? null) : null,
    );
    const pullRequestError = useGitHubStore((state) =>
        repoKey ? (state.errors[`${repoKey}:prs`] ?? null) : null,
    );
    const authError = useGitHubStore((state) =>
        repoRef ? (state.errors[`auth:${repoRef.host}`] ?? null) : null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const refreshIssues = useGitHubStore((state) => state.refreshIssues);
    const refreshPullRequests = useGitHubStore(
        (state) => state.refreshPullRequests,
    );
    const openGitHubIssuesTab = useWorkspaceStore(
        (state) => state.openGitHubIssuesTab,
    );
    const openGitHubIssueTab = useWorkspaceStore(
        (state) => state.openGitHubIssueTab,
    );
    const openGitHubPullRequestsTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestsTab,
    );
    const openGitHubPullRequestTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestTab,
    );
    const normalizedSearch = (filter ?? "").trim().toLowerCase();
    const disabledReason = getDisabledReason({
        authError,
        authStatus,
        isCheckingAuth,
        projectId,
        repoRef,
        snapshot,
    });

    useEffect(() => {
        if (!repoRef || authStatus) {
            return;
        }

        void refreshAuthStatus(repoRef).catch(() => undefined);
    }, [authStatus, refreshAuthStatus, repoRef]);

    useEffect(() => {
        if (kind !== "issues" || !repoRef || !repoKey) {
            return;
        }
        if (hasIssueCache) {
            return;
        }

        const activeRepoKey = repoKey;
        const activeRepoRef = repoRef;
        const activeListState = requiredIssueListState;
        let cancelled = false;

        async function loadIssues() {
            if (
                useGitHubStore.getState().issuesByRepoAndState[
                    activeRepoKey
                ]?.[activeListState] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[
                    activeRepoRef.host
                ] ?? (await refreshAuthStatus(activeRepoRef));
            if (!cancelled && status.state === "authenticated") {
                await refreshIssues(activeRepoRef, {
                    state: activeListState,
                });
            }
        }

        void loadIssues().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [
        hasIssueCache,
        kind,
        refreshAuthStatus,
        refreshIssues,
        repoKey,
        repoRef,
        requiredIssueListState,
    ]);

    useEffect(() => {
        if (kind !== "pull_requests" || !repoRef || !repoKey) {
            return;
        }
        if (hasPullRequestCache) {
            return;
        }

        const activeRepoKey = repoKey;
        const activeRepoRef = repoRef;
        const activeListState = requiredPullRequestListState;
        let cancelled = false;

        async function loadPullRequests() {
            if (
                useGitHubStore.getState().pullRequestsByRepoAndState[
                    activeRepoKey
                ]?.[activeListState] !== undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[
                    activeRepoRef.host
                ] ?? (await refreshAuthStatus(activeRepoRef));
            if (!cancelled && status.state === "authenticated") {
                await refreshPullRequests(activeRepoRef, {
                    state: activeListState,
                });
            }
        }

        void loadPullRequests().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [
        hasPullRequestCache,
        kind,
        refreshAuthStatus,
        refreshPullRequests,
        repoKey,
        repoRef,
        requiredPullRequestListState,
    ]);

    const visibleIssues = useMemo(() => {
        const login = authStatus?.user?.login ?? null;

        return issues.filter((issue) => {
            if (
                issueFilter === "assigned" &&
                (!login ||
                    !issue.assignees.some(
                        (assignee) => assignee.login === login,
                    ))
            ) {
                return false;
            }

            if (
                issueFilter !== "all" &&
                issueFilter !== "assigned" &&
                issue.state !== issueFilter
            ) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            return issueMatchesSearch(issue, normalizedSearch);
        });
    }, [authStatus?.user?.login, issueFilter, issues, normalizedSearch]);

    const visiblePullRequests = useMemo(() => {
        const filteredPullRequests = pullRequests.filter((pullRequest) => {
            if (pullRequestFilter === "draft" && !pullRequest.draft) {
                return false;
            }

            if (
                pullRequestFilter === "branch" &&
                (!repoRef ||
                    !isPullRequestForCurrentBranch(
                        pullRequest,
                        currentBranch,
                        repoRef,
                    ))
            ) {
                return false;
            }

            if (
                pullRequestFilter === "closed" &&
                pullRequest.state !== "closed" &&
                pullRequest.state !== "merged"
            ) {
                return false;
            }

            if (
                pullRequestFilter !== "all" &&
                pullRequestFilter !== "branch" &&
                pullRequestFilter !== "closed" &&
                pullRequestFilter !== "draft" &&
                pullRequest.state !== pullRequestFilter
            ) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            return pullRequestMatchesSearch(pullRequest, normalizedSearch);
        });

        return sortPullRequestsNewestFirst(filteredPullRequests);
    }, [
        currentBranch,
        normalizedSearch,
        pullRequestFilter,
        pullRequests,
        repoRef,
    ]);

    const currentBranchPullRequestCount = useMemo(
        () =>
            repoRef
                ? countCurrentBranchPullRequests(
                      pullRequests,
                      currentBranch,
                      repoRef,
                  )
                : 0,
        [currentBranch, pullRequests, repoRef],
    );

    const handleRefresh = useCallback(async () => {
        if (!repoRef) {
            return;
        }

        try {
            const status = await refreshAuthStatus(repoRef);
            if (status.state !== "authenticated") {
                return;
            }

            if (kind === "issues") {
                await refreshIssues(repoRef, {
                    state: requiredIssueListState,
                });
                return;
            }

            await refreshPullRequests(repoRef, {
                state: requiredPullRequestListState,
            });
        } catch {
            // The store records the displayable error for this request.
        }
    }, [
        kind,
        refreshAuthStatus,
        refreshIssues,
        refreshPullRequests,
        repoRef,
        requiredIssueListState,
        requiredPullRequestListState,
    ]);

    const handleOpenList = useCallback(() => {
        if (!projectId || !repoRef) {
            return;
        }

        const input = {
            projectId,
            ref: repoRef,
            worktreeId,
        };

        if (kind === "issues") {
            void openGitHubIssuesTab(input);
            return;
        }

        void openGitHubPullRequestsTab(input);
    }, [
        kind,
        openGitHubIssuesTab,
        openGitHubPullRequestsTab,
        projectId,
        repoRef,
        worktreeId,
    ]);

    const panelTitle = kind === "issues" ? "Issues" : "Pull Requests";
    const isLoading =
        isCheckingAuth ||
        (kind === "issues" ? isLoadingIssues : isLoadingPullRequests);
    const error =
        authError ?? (kind === "issues" ? issueError : pullRequestError);
    const visibleCount =
        kind === "issues" ? visibleIssues.length : visiblePullRequests.length;
    const totalCount = kind === "issues" ? issues.length : pullRequests.length;

    if (disabledReason) {
        return (
            <SidebarGitHubStatus
                action={
                    repoRef &&
                    !isCheckingAuth &&
                    authStatus?.state !== "authenticated" ? (
                        <button
                            className="review-action-btn"
                            onClick={onOpenSettings}
                            type="button"
                        >
                            Connect
                        </button>
                    ) : null
                }
                title={panelTitle}
            >
                {disabledReason}
            </SidebarGitHubStatus>
        );
    }

    if (!repoRef) {
        return null;
    }

    const activeRepoRef = repoRef;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border/50 px-2 py-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-text-primary">
                            {panelTitle}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            className="review-action-btn"
                            disabled={isLoading}
                            onClick={() => void handleRefresh()}
                            type="button"
                        >
                            Refresh
                        </button>
                        <button
                            className="review-action-btn"
                            onClick={handleOpenList}
                            type="button"
                        >
                            Open
                        </button>
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    {kind === "issues" ? (
                        <>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "open"}
                                onClick={() => setIssueFilter("open")}
                            >
                                Open
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "closed"}
                                onClick={() => setIssueFilter("closed")}
                            >
                                Closed
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "assigned"}
                                onClick={() => setIssueFilter("assigned")}
                            >
                                Assigned
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={issueFilter === "all"}
                                onClick={() => setIssueFilter("all")}
                            >
                                All
                            </SidebarGitHubFilterButton>
                        </>
                    ) : (
                        <>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "open"}
                                onClick={() => setPullRequestFilter("open")}
                            >
                                Open
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "branch"}
                                onClick={() => setPullRequestFilter("branch")}
                            >
                                {currentBranchPullRequestCount > 0
                                    ? `Branch ${currentBranchPullRequestCount}`
                                    : "Branch"}
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "draft"}
                                onClick={() => setPullRequestFilter("draft")}
                            >
                                Draft
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "closed"}
                                onClick={() => setPullRequestFilter("closed")}
                            >
                                Closed
                            </SidebarGitHubFilterButton>
                            <SidebarGitHubFilterButton
                                active={pullRequestFilter === "all"}
                                onClick={() => setPullRequestFilter("all")}
                            >
                                All
                            </SidebarGitHubFilterButton>
                        </>
                    )}
                </div>
                <div className="mt-2 text-[10px] text-text-secondary">
                    {normalizedSearch
                        ? `${visibleCount} of ${totalCount}`
                        : `${visibleCount} ${visibleCount === 1 ? "item" : "items"}`}
                </div>
            </div>

            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-2">
                {error ? (
                    <div className="px-1 pb-2">
                        <GitHubErrorState>{error}</GitHubErrorState>
                    </div>
                ) : null}
                {isLoading ? (
                    <div className="px-3 py-3 text-[12px] text-text-secondary">
                        Loading {kind === "issues" ? "issues" : "pull requests"}
                        ...
                    </div>
                ) : null}
                {!isLoading && visibleCount === 0 ? (
                    <GitHubEmptyState>
                        No {kind === "issues" ? "issues" : "pull requests"} match
                        this view.
                    </GitHubEmptyState>
                ) : null}
                {kind === "issues" && visibleIssues.length > 0 ? (
                    <ul className="space-y-1">
                        {visibleIssues.map((issue) => (
                            <li key={issue.id}>
                                <SidebarGitHubIssueRow
                                    issue={issue}
                                    onOpen={() =>
                                        void openGitHubIssueTab({
                                            issueNumber: issue.number,
                                            projectId,
                                            ref: activeRepoRef,
                                            worktreeId,
                                        })
                                    }
                                    projectId={projectId}
                                    repoRef={activeRepoRef}
                                    worktreeId={worktreeId}
                                />
                            </li>
                        ))}
                    </ul>
                ) : null}
                {kind === "pull_requests" && visiblePullRequests.length > 0 ? (
                    <ul className="space-y-1">
                        {visiblePullRequests.map((pullRequest) => (
                            <li key={pullRequest.id}>
                                <SidebarGitHubPullRequestRow
                                    currentBranch={currentBranch}
                                    onOpen={() =>
                                        void openGitHubPullRequestTab({
                                            projectId,
                                            pullRequestNumber:
                                                pullRequest.number,
                                            ref: activeRepoRef,
                                            worktreeId,
                                        })
                                    }
                                    pullRequest={pullRequest}
                                    projectId={projectId}
                                    repoRef={activeRepoRef}
                                    worktreeId={worktreeId}
                                />
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </div>
    );
}

function SidebarGitHubIssueRow({
    issue,
    onOpen,
    projectId,
    repoRef,
    worktreeId,
}: {
    readonly issue: GitHubIssueSummary;
    readonly onOpen: () => void;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef;
    readonly worktreeId: string | null;
}) {
    return (
        <SidebarGitHubDraggableRow
            itemKind="issue"
            meta={`#${issue.number} - ${issue.commentCount} comments`}
            number={issue.number}
            onOpen={onOpen}
            projectId={projectId}
            repoRef={repoRef}
            title={issue.title}
            worktreeId={worktreeId}
        >
            <div className="flex w-full min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-primary">
                    {issue.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-text-secondary">
                    #{issue.number}
                </span>
            </div>
            {issue.labels.length > 0 ? (
                <div className="mt-1 flex w-full flex-wrap gap-1">
                    {issue.labels.slice(0, 3).map((label) => (
                        <GitHubLabelPill key={label.id} label={label} />
                    ))}
                </div>
            ) : null}
            <div className="mt-1 flex w-full min-w-0 items-center gap-1.5 text-[10px] text-text-secondary">
                <span className="shrink-0">
                    updated {formatGitHubRelativeTime(issue.updatedAt)}
                </span>
                <span aria-hidden="true" className="shrink-0">
                    -
                </span>
                <span className="shrink-0">{issue.commentCount} comments</span>
                <span aria-hidden="true" className="shrink-0">
                    -
                </span>
                <div className="min-w-0">
                    <GitHubUsers users={issue.assignees} />
                </div>
            </div>
        </SidebarGitHubDraggableRow>
    );
}

function SidebarGitHubPullRequestRow({
    currentBranch,
    onOpen,
    projectId,
    pullRequest,
    repoRef,
    worktreeId,
}: {
    readonly currentBranch: string | null;
    readonly onOpen: () => void;
    readonly projectId: string | null;
    readonly pullRequest: GitHubPullRequestSummary;
    readonly repoRef: GitHubRepositoryRef;
    readonly worktreeId: string | null;
}) {
    const isCurrentBranchPullRequest = isPullRequestForCurrentBranch(
        pullRequest,
        currentBranch,
        repoRef,
    );
    return (
        <SidebarGitHubDraggableRow
            itemKind="pull_request"
            meta={`PR #${pullRequest.number} - ${pullRequest.head.ref}`}
            number={pullRequest.number}
            onOpen={onOpen}
            projectId={projectId}
            repoRef={repoRef}
            title={pullRequest.title}
            worktreeId={worktreeId}
        >
            <div className="flex w-full min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-primary">
                    {pullRequest.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-text-secondary">
                    #{pullRequest.number}
                </span>
            </div>
            <div className="mt-1 flex w-full min-w-0 items-center gap-1.5 font-mono text-[10px] text-text-secondary">
                <span className="min-w-0 truncate">{pullRequest.head.label}</span>
                <span aria-hidden="true" className="shrink-0">
                    -&gt;
                </span>
                <span className="min-w-0 truncate">{pullRequest.base.label}</span>
            </div>
            <div className="mt-1 flex w-full min-w-0 items-center gap-1.5 text-[10px] text-text-secondary">
                <span className="shrink-0">
                    updated {formatGitHubRelativeTime(pullRequest.updatedAt)}
                </span>
                <span aria-hidden="true" className="shrink-0">
                    -
                </span>
                <span className="shrink-0">
                    {pullRequest.author?.login ?? "ghost"}
                </span>
                {isCurrentBranchPullRequest ? (
                    <>
                        <span aria-hidden="true" className="shrink-0">
                            -
                        </span>
                        <span className="shrink-0 rounded-[3px] border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] px-1 text-[9px] text-text-primary">
                            Branch
                        </span>
                    </>
                ) : null}
            </div>
        </SidebarGitHubDraggableRow>
    );
}

function SidebarGitHubDraggableRow({
    children,
    itemKind,
    meta,
    number,
    onOpen,
    projectId,
    repoRef,
    title,
    worktreeId,
}: {
    readonly children: ReactNode;
    readonly itemKind: SidebarGitHubDragItemKind;
    readonly meta: string;
    readonly number: number;
    readonly onOpen: () => void;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef;
    readonly title: string;
    readonly worktreeId: string | null;
}) {
    const dragStateRef = useRef<{
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        active: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);
    const [dragPreview, setDragPreview] =
        useState<SidebarGitHubDragPreview | null>(null);
    const kindLabel = itemKind === "issue" ? "Issue" : "Pull Request";

    const emitDrag = useCallback(
        (
            phase: "cancel" | "end" | "move" | "start",
            event?: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">,
        ) => {
            emitSidebarGitHubDrag({
                itemKind,
                number,
                phase,
                projectId,
                ref: repoRef,
                title,
                worktreeId,
                x: event?.clientX ?? 0,
                y: event?.clientY ?? 0,
            });
        },
        [itemKind, number, projectId, repoRef, title, worktreeId],
    );

    const updateDragPreview = useCallback(
        (event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">) => {
            setDragPreview({
                kindLabel,
                meta,
                title,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [kindLabel, meta, title],
    );

    return (
        <>
            <div
                className="sidebar-agents-row app-no-drag w-full"
                data-active="false"
                onClick={() => {
                    if (suppressClickRef.current) return;
                    onOpen();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen();
                    }
                }}
                onPointerCancel={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    dragStateRef.current = null;
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                    setDragPreview(null);
                    emitDrag("cancel", event);
                }}
                onPointerDown={(event) => {
                    if (
                        event.button !== 0 ||
                        isInteractiveSidebarGitHubDragTarget(
                            event.target,
                            event.currentTarget,
                        )
                    ) {
                        return;
                    }

                    dragStateRef.current = {
                        active: false,
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startY: event.clientY,
                    };
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    if (!dragState.active) {
                        const deltaX = event.clientX - dragState.startX;
                        const deltaY = event.clientY - dragState.startY;
                        if (
                            Math.hypot(deltaX, deltaY) <
                            SIDEBAR_GITHUB_DRAG_THRESHOLD_PX
                        ) {
                            return;
                        }

                        dragState.active = true;
                        updateDragPreview(event);
                        emitDrag("start", event);
                    } else {
                        updateDragPreview(event);
                        emitDrag("move", event);
                    }

                    event.preventDefault();
                }}
                onPointerUp={(event) => {
                    const dragState = dragStateRef.current;
                    if (!dragState || dragState.pointerId !== event.pointerId) {
                        return;
                    }

                    dragStateRef.current = null;
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                    if (!dragState.active) {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    setDragPreview(null);
                    suppressClickRef.current = true;
                    window.requestAnimationFrame(() => {
                        suppressClickRef.current = false;
                    });
                    emitDrag("end", event);
                }}
                role="button"
                tabIndex={0}
                title={title}
            >
                {children}
            </div>
            {dragPreview && typeof document !== "undefined"
                ? createPortal(
                      <SidebarGitHubDragGhost preview={dragPreview} />,
                      document.body,
                  )
                : null}
        </>
    );
}

function SidebarGitHubDragGhost({
    preview,
}: {
    readonly preview: SidebarGitHubDragPreview;
}) {
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed min-w-44 max-w-72 rounded-lg border border-accent/30 bg-bg-panel/96 px-2.5 py-2 text-text-primary shadow-[0_14px_34px_rgba(15,23,42,0.28)] backdrop-blur-sm"
            style={{
                left: preview.x + 14,
                top: preview.y + 14,
                transform: "translate3d(0, 0, 0) scale(1.02)",
                zIndex: 10050,
            }}
        >
            <div className="flex min-w-0 items-center gap-2">
                <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-[10px] font-semibold text-accent"
                >
                    GH
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] font-medium leading-tight">
                        {preview.title}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] leading-tight text-text-secondary">
                        Drag to open in pane - {preview.kindLabel} -{" "}
                        {preview.meta}
                    </div>
                </div>
            </div>
        </div>
    );
}

function SidebarGitHubFilterButton({
    active,
    children,
    onClick,
}: {
    readonly active?: boolean;
    readonly children: ReactNode;
    readonly onClick: () => void;
}) {
    return (
        <button
            className={[
                "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                active
                    ? "border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-text-primary"
                    : "border-border/70 text-text-secondary hover:bg-bg-elevated hover:text-text-primary",
            ].join(" ")}
            onClick={onClick}
            type="button"
        >
            {children}
        </button>
    );
}

function SidebarGitHubStatus({
    action,
    children,
    title,
}: {
    readonly action?: ReactNode;
    readonly children: ReactNode;
    readonly title: string;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border/50 px-2 py-2">
                <div className="text-[12px] font-semibold text-text-primary">
                    {title}
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-[12px] leading-5 text-text-secondary">
                <p>{children}</p>
                {action}
            </div>
        </div>
    );
}

function getDisabledReason({
    authError,
    authStatus,
    isCheckingAuth,
    projectId,
    repoRef,
    snapshot,
}: {
    readonly authError: string | null;
    readonly authStatus: GitHubAuthStatus | null;
    readonly isCheckingAuth: boolean;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef | null;
    readonly snapshot: GitRepositorySnapshot | null;
}): string | null {
    if (!projectId) {
        return "Open a project first.";
    }

    if (!snapshot || snapshot.repositoryState !== "ready") {
        return "Open a Git repository to browse GitHub data.";
    }

    if (!repoRef) {
        return "No GitHub remote detected for this repository.";
    }

    if (!authStatus && isCheckingAuth) {
        return "Checking GitHub authentication...";
    }

    if (authError) {
        return `GitHub authentication failed: ${authError}`;
    }

    if (authStatus?.state !== "authenticated") {
        return "Connect GitHub in Settings to browse repository data.";
    }

    return null;
}

function issueMatchesSearch(
    issue: GitHubIssueSummary,
    normalizedSearch: string,
): boolean {
    return (
        issue.title.toLowerCase().includes(normalizedSearch) ||
        String(issue.number).includes(normalizedSearch) ||
        issue.labels.some((label) =>
            label.name.toLowerCase().includes(normalizedSearch),
        ) ||
        issue.assignees.some((assignee) =>
            assignee.login.toLowerCase().includes(normalizedSearch),
        ) ||
        (issue.author?.login.toLowerCase().includes(normalizedSearch) ?? false)
    );
}

function pullRequestMatchesSearch(
    pullRequest: GitHubPullRequestSummary,
    normalizedSearch: string,
): boolean {
    return (
        pullRequest.title.toLowerCase().includes(normalizedSearch) ||
        String(pullRequest.number).includes(normalizedSearch) ||
        pullRequest.head.label.toLowerCase().includes(normalizedSearch) ||
        pullRequest.head.ref.toLowerCase().includes(normalizedSearch) ||
        pullRequest.base.label.toLowerCase().includes(normalizedSearch) ||
        pullRequest.base.ref.toLowerCase().includes(normalizedSearch) ||
        (pullRequest.author?.login.toLowerCase().includes(normalizedSearch) ??
            false)
    );
}

function getIssueListState(filter: SidebarIssueFilter): GitHubIssueState | "all" {
    return filter === "assigned" ? "all" : filter;
}

function getPullRequestListState(
    filter: SidebarPullRequestFilter,
): "all" | "closed" | "open" {
    return filter === "draft" || filter === "branch" ? "all" : filter;
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

function getProjectSnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
    worktreeId: string | null,
): GitRepositorySnapshot | null {
    const directMatch = snapshots[getContextKey(projectId, worktreeId)] ?? null;
    if (directMatch) {
        return directMatch;
    }

    if (worktreeId !== null) {
        return null;
    }

    return (
        Object.values(snapshots).find(
            (snapshot) =>
                snapshot?.projectId === projectId &&
                snapshot.currentWorktreeId === null,
        ) ?? null
    );
}

function isInteractiveSidebarGitHubDragTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    const interactive = target.closest(
        "button,input,textarea,select,a,[role='button']",
    );
    return Boolean(interactive && interactive !== currentTarget);
}
