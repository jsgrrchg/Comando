import { useEffect, useMemo, useRef, useState } from "react";

import type { GitRepositorySnapshot } from "@shared/ipc";

import {
    countCurrentBranchPullRequests,
    isPullRequestForCurrentBranch,
    sortPullRequestsForCurrentBranch,
} from "@renderer/app/github/current-branch-pr";
import { useGitStore } from "@renderer/app/store/git-store";
import {
    EMPTY_GITHUB_LIST,
    EMPTY_GITHUB_RECORD,
    getGitHubPullRequestChecksKey,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitHubPullRequestsTab } from "@renderer/app/workspace/tree";

import {
    formatGitHubRelativeTime,
    getGitHubWritePermissionLabel,
    GitHubAuthNotice,
    GitHubChecksPill,
    GitHubDraftPreview,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubFilterButton,
    GitHubLabelPill,
    GitHubSearchBox,
    GitHubStatePill,
    GitHubTabHeader,
    GitHubTabShell,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { IdeActionButton } from "./ide-bar";

type PullRequestFilter = "all" | "branch" | "closed" | "draft" | "open";

export function GitHubPullRequestsTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitHubPullRequestsTab;
}) {
    const repoKey = getGitHubRepoKey(tab.ref);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<PullRequestFilter>("open");
    const [isCreating, setIsCreating] = useState(false);
    const snapshot = useGitStore((state) =>
        tab.projectId
            ? getProjectSnapshot(
                  state.snapshots,
                  tab.projectId,
                  tab.worktreeId ?? null,
              )
            : null,
    );
    const currentBranch = snapshot?.branch?.isDetached
        ? null
        : (snapshot?.branch?.name ?? null);
    const [newTitle, setNewTitle] = useState("");
    const [newBody, setNewBody] = useState("");
    const [newBase, setNewBase] = useState("main");
    const [newHead, setNewHead] = useState(currentBranch ?? "");
    const [newDraft, setNewDraft] = useState(true);
    const pullRequests = useGitHubStore(
        (state) => state.pullRequestsByRepo[repoKey] ?? EMPTY_GITHUB_LIST,
    );
    const pullRequestChecksByHeadSha = useGitHubStore(
        (state) => state.pullRequestChecksByRepo[repoKey] ?? EMPTY_GITHUB_RECORD,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[tab.ref.host] ?? null,
    );
    const isLoading = useGitHubStore(
        (state) => state.loadingKeys[`${repoKey}:prs`] ?? false,
    );
    const isCheckingAuth = useGitHubStore(
        (state) => state.loadingKeys[`auth:${tab.ref.host}`] ?? false,
    );
    const isCreatingPullRequest = useGitHubStore(
        (state) => state.mutatingKeys[`${repoKey}:pr:create`] ?? false,
    );
    const loadingKeys = useGitHubStore((state) => state.loadingKeys);
    const errors = useGitHubStore((state) => state.errors);
    const error = useGitHubStore(
        (state) =>
            state.errors[`${repoKey}:prs`] ??
            state.errors[`${repoKey}:pr:create`] ??
            null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const refreshPullRequests = useGitHubStore(
        (state) => state.refreshPullRequests,
    );
    const createPullRequest = useGitHubStore(
        (state) => state.createPullRequest,
    );
    const refreshPullRequestChecks = useGitHubStore(
        (state) => state.refreshPullRequestChecks,
    );
    const openGitHubPullRequestTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestTab,
    );
    const lastRequestedFilterRef = useRef(filter);

    useEffect(() => {
        if (!newHead && currentBranch) {
            setNewHead(currentBranch);
        }
    }, [currentBranch, newHead]);

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            if (
                useGitHubStore.getState().pullRequestsByRepo[repoKey] !==
                undefined
            ) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await refreshPullRequests(tab.ref, {
                    state: "open",
                });
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [refreshAuthStatus, refreshPullRequests, repoKey, tab.ref]);

    useEffect(() => {
        if (lastRequestedFilterRef.current === filter) {
            return;
        }
        lastRequestedFilterRef.current = filter;

        let cancelled = false;

        async function refreshFilterData() {
            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await refreshPullRequests(tab.ref, {
                    state: getPullRequestListState(filter),
                });
            }
        }

        void refreshFilterData();

        return () => {
            cancelled = true;
        };
    }, [filter, refreshAuthStatus, refreshPullRequests, tab.ref]);

    const visiblePullRequests = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();

        const filteredPullRequests = pullRequests.filter((pullRequest) => {
            if (filter === "draft" && !pullRequest.draft) {
                return false;
            }

            if (
                filter === "branch" &&
                !isPullRequestForCurrentBranch(
                    pullRequest,
                    currentBranch,
                    tab.ref,
                )
            ) {
                return false;
            }

            if (
                filter !== "all" &&
                filter !== "draft" &&
                filter !== "branch" &&
                pullRequest.state !== filter
            ) {
                return false;
            }

            if (!normalizedQuery) {
                return true;
            }

            return (
                pullRequest.title.toLowerCase().includes(normalizedQuery) ||
                String(pullRequest.number).includes(normalizedQuery) ||
                pullRequest.head.label.toLowerCase().includes(normalizedQuery) ||
                pullRequest.base.label.toLowerCase().includes(normalizedQuery)
            );
        });

        return sortPullRequestsForCurrentBranch(
            filteredPullRequests,
            currentBranch,
            tab.ref,
        );
    }, [currentBranch, filter, pullRequests, query, tab.ref]);

    const currentBranchPullRequestCount = useMemo(
        () =>
            countCurrentBranchPullRequests(
                pullRequests,
                currentBranch,
                tab.ref,
            ),
        [currentBranch, pullRequests, tab.ref],
    );
    const visiblePullRequestCheckTargets = useMemo(
        () =>
            visiblePullRequests
                .slice(0, 20)
                .map((pullRequest) => ({
                    headSha: pullRequest.head.sha,
                    number: pullRequest.number,
                }))
                .filter((target) => target.headSha.trim().length > 0),
        [visiblePullRequests],
    );

    useEffect(() => {
        if (authStatus?.state !== "authenticated") {
            return;
        }

        for (const target of visiblePullRequestCheckTargets) {
            const checksKey = getGitHubPullRequestChecksKey(
                tab.ref,
                target.headSha,
            );
            if (
                pullRequestChecksByHeadSha[target.headSha] !== undefined ||
                loadingKeys[checksKey] ||
                errors[checksKey]
            ) {
                continue;
            }

            void refreshPullRequestChecks(tab.ref, {
                headSha: target.headSha,
                pullRequestNumber: target.number,
            }).catch(() => undefined);
        }
    }, [
        authStatus?.state,
        errors,
        loadingKeys,
        pullRequestChecksByHeadSha,
        refreshPullRequestChecks,
        tab.ref,
        visiblePullRequestCheckTargets,
    ]);

    const canWritePullRequests = hasGitHubWritePermission(
        authStatus,
        "pull_requests",
    );
    const writePermissionLabel = getGitHubWritePermissionLabel("pull_requests");
    const branchNeedsPush = Boolean(currentBranch && !snapshot?.branch?.upstreamName);

    const handleRefresh = async () => {
        const status = await refreshAuthStatus(tab.ref);
        if (status.state === "authenticated") {
            await refreshPullRequests(tab.ref, {
                state: getPullRequestListState(filter),
            });
        }
    };

    const handleCreatePullRequest = async () => {
        const title = newTitle.trim();
        const base = newBase.trim();
        const head = newHead.trim();
        if (!title || !base || !head || !canWritePullRequests) {
            return;
        }
        if (!window.confirm(`Create pull request "${title}" on GitHub?`)) {
            return;
        }

        const detail = await createPullRequest(tab.ref, {
            base,
            body: newBody.trim() || null,
            draft: newDraft,
            head,
            title,
        });
        setNewTitle("");
        setNewBody("");
        setIsCreating(false);
        await openGitHubPullRequestTab({
            projectId: tab.projectId,
            pullRequestNumber: detail.number,
            ref: tab.ref,
            worktreeId: tab.worktreeId ?? null,
        });
    };

    return (
        <GitHubTabShell
            header={
                <GitHubTabHeader
                    actions={
                        <>
                            <IdeActionButton
                                disabled={!canWritePullRequests}
                                onClick={() => setIsCreating((value) => !value)}
                                title={
                                    canWritePullRequests
                                        ? undefined
                                        : writePermissionLabel
                                }
                            >
                                Create PR
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={isLoading || isCheckingAuth}
                                onClick={() => void handleRefresh()}
                            >
                                Refresh
                            </IdeActionButton>
                        </>
                    }
                    count={visiblePullRequests.length}
                    repo={tab.ref}
                    title="Pull Requests"
                />
            }
        >
            <div className="space-y-3 p-4">
                <GitHubAuthNotice authStatus={authStatus} />
                {error ? <GitHubErrorState>{error}</GitHubErrorState> : null}
                <div className="flex flex-wrap items-center gap-2">
                    <GitHubSearchBox
                        onChange={setQuery}
                        placeholder="Search pull requests..."
                        value={query}
                    />
                    <GitHubFilterButton
                        active={filter === "open"}
                        onClick={() => setFilter("open")}
                    >
                        Open
                    </GitHubFilterButton>
                    <GitHubFilterButton
                        active={filter === "closed"}
                        onClick={() => setFilter("closed")}
                    >
                        Closed
                    </GitHubFilterButton>
                    <GitHubFilterButton
                        active={filter === "draft"}
                        onClick={() => setFilter("draft")}
                    >
                        Draft
                    </GitHubFilterButton>
                    <GitHubFilterButton
                        active={filter === "branch"}
                        onClick={() => setFilter("branch")}
                    >
                        {currentBranchPullRequestCount > 0
                            ? `Current branch (${currentBranchPullRequestCount})`
                            : "Current branch"}
                    </GitHubFilterButton>
                    <GitHubFilterButton
                        active={filter === "all"}
                        onClick={() => setFilter("all")}
                    >
                        All
                    </GitHubFilterButton>
                </div>
                {isCreating ? (
                    <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-secondary p-3">
                        {branchNeedsPush ? (
                            <div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[11px] leading-5 text-text-secondary">
                                Current branch has no upstream. Push it before
                                creating a pull request if GitHub cannot find
                                the head ref.
                            </div>
                        ) : null}
                        <input
                            className="h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                            onChange={(event) =>
                                setNewTitle(event.currentTarget.value)
                            }
                            placeholder="Pull request title"
                            value={newTitle}
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            <input
                                className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                onChange={(event) =>
                                    setNewBase(event.currentTarget.value)
                                }
                                placeholder="base"
                                value={newBase}
                            />
                            <input
                                className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                onChange={(event) =>
                                    setNewHead(event.currentTarget.value)
                                }
                                placeholder="head"
                                value={newHead}
                            />
                        </div>
                        <textarea
                            className="mt-2 min-h-28 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                            onChange={(event) =>
                                setNewBody(event.currentTarget.value)
                            }
                            placeholder="Describe the pull request..."
                            value={newBody}
                        />
                        <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
                            <input
                                checked={newDraft}
                                onChange={(event) =>
                                    setNewDraft(event.currentTarget.checked)
                                }
                                type="checkbox"
                            />
                            Create as draft
                        </label>
                        <div className="mt-3">
                            <GitHubDraftPreview
                                body={newBody}
                                meta={`${newHead.trim() || "head"} into ${
                                    newBase.trim() || "base"
                                }${newDraft ? " · draft" : ""}`}
                                title={newTitle}
                            />
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                            <IdeActionButton
                                disabled={isCreatingPullRequest}
                                onClick={() => setIsCreating(false)}
                            >
                                Cancel
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={
                                    isCreatingPullRequest ||
                                    !canWritePullRequests ||
                                    newTitle.trim().length === 0 ||
                                    newBase.trim().length === 0 ||
                                    newHead.trim().length === 0
                                }
                                onClick={() =>
                                    void handleCreatePullRequest()
                                }
                            >
                                {isCreatingPullRequest
                                    ? "Creating..."
                                    : "Create Pull Request"}
                            </IdeActionButton>
                        </div>
                    </div>
                ) : null}
                {isLoading || isCheckingAuth ? (
                    <div className="text-[12px] text-text-secondary">
                        Loading pull requests...
                    </div>
                ) : null}
                {!isLoading && visiblePullRequests.length === 0 ? (
                    <GitHubEmptyState>
                        No pull requests match this view.
                    </GitHubEmptyState>
                ) : null}
            </div>
            {!isLoading && visiblePullRequests.length > 0 ? (
                <div>
                    <div
                        className="sticky top-0 z-10 grid items-center px-3 py-1.5 text-[10px] font-semibold uppercase text-text-secondary"
                        style={{
                            backgroundColor: "var(--color-bg-secondary)",
                            borderBottom:
                                "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            fontFamily: "var(--font-mono)",
                            gridTemplateColumns: PR_TABLE_GRID,
                            letterSpacing: "0.06em",
                        }}
                    >
                        <span>#</span>
                        <span>Description</span>
                        <span>Branch</span>
                        <span>Date</span>
                        <span className="text-right">Action</span>
                    </div>
                    {visiblePullRequests.map((pullRequest) => {
                        const isCurrentBranchPullRequest =
                            isPullRequestForCurrentBranch(
                                pullRequest,
                                currentBranch,
                                tab.ref,
                            );
                        const checksKey = getGitHubPullRequestChecksKey(
                            tab.ref,
                            pullRequest.head.sha,
                        );
                        const checks =
                            pullRequestChecksByHeadSha[pullRequest.head.sha] ??
                            null;
                        const checksState = loadingKeys[checksKey]
                            ? "loading"
                            : (checks?.state ?? "unknown");

                        return (
                            <div
                                className={[
                                    "group/row grid items-stretch border-l-[3px] pl-2.5 pr-3 text-left text-[11px] transition-[color,background-color,border-color] duration-120",
                                    isCurrentBranchPullRequest
                                        ? "border-l-[color-mix(in_srgb,var(--color-accent)_70%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-primary))] text-text-primary"
                                        : "border-l-transparent text-text-secondary hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary hover:text-text-primary",
                                ].join(" ")}
                                key={pullRequest.id}
                                style={{ gridTemplateColumns: PR_TABLE_GRID }}
                            >
                                <button
                                    className="contents text-left"
                                    onClick={() =>
                                        void openGitHubPullRequestTab({
                                            projectId: tab.projectId,
                                            pullRequestNumber:
                                                pullRequest.number,
                                            ref: tab.ref,
                                            worktreeId: tab.worktreeId ?? null,
                                        })
                                    }
                                    type="button"
                                >
                                    <div className="border-b border-border-subtle py-2.5 font-mono text-text-secondary">
                                        #{pullRequest.number}
                                    </div>
                                    <div className="min-w-0 border-b border-border-subtle py-2.5 pr-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <GitHubStatePill
                                                tone={
                                                    pullRequest.draft
                                                        ? "draft"
                                                        : pullRequest.mergedAt
                                                          ? "merged"
                                                          : pullRequest.state
                                                }
                                            >
                                                {pullRequest.draft
                                                    ? "draft"
                                                    : pullRequest.mergedAt
                                                      ? "merged"
                                                      : pullRequest.state}
                                            </GitHubStatePill>
                                            <span className="truncate text-[12px] text-text-primary">
                                                {pullRequest.title}
                                            </span>
                                            <GitHubChecksPill
                                                state={checksState}
                                            />
                                            {isCurrentBranchPullRequest ? (
                                                <span className="shrink-0 rounded-md border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-text-primary">
                                                    Current branch
                                                </span>
                                            ) : null}
                                        </div>
                                        {pullRequest.labels.length > 0 ? (
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                {pullRequest.labels
                                                    .slice(0, 4)
                                                    .map((label) => (
                                                        <GitHubLabelPill
                                                            key={label.id}
                                                            label={label}
                                                        />
                                                    ))}
                                            </div>
                                        ) : null}
                                    </div>
                                    <div
                                        className="min-w-0 border-b border-border-subtle py-2.5 pr-3 text-[11px] text-text-secondary"
                                        style={{
                                            fontFamily: "var(--font-mono)",
                                        }}
                                    >
                                        <div className="truncate">
                                            {pullRequest.head.label}
                                        </div>
                                        <div className="truncate">
                                            into {pullRequest.base.label}
                                        </div>
                                    </div>
                                    <div className="border-b border-border-subtle py-2.5 pr-3 text-[11px] text-text-secondary">
                                        <div>
                                            {pullRequest.commentCount} comments
                                        </div>
                                        <div className="mt-0.5">
                                            {formatGitHubRelativeTime(
                                                pullRequest.updatedAt,
                                            )}
                                        </div>
                                    </div>
                                </button>
                                <div className="flex items-center justify-end border-b border-border-subtle py-2.5">
                                    <IdeActionButton
                                        onClick={() =>
                                            openGitHubWebUrl(pullRequest.url)
                                        }
                                    >
                                        Open
                                    </IdeActionButton>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </GitHubTabShell>
    );
}

const PR_TABLE_GRID = "56px minmax(280px,1fr) 200px 110px 72px";

function getPullRequestListState(
    filter: PullRequestFilter,
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

    return (
        Object.values(snapshots).find(
            (snapshot) =>
                snapshot?.projectId === projectId &&
                (worktreeId == null ||
                    snapshot.worktrees.some(
                        (entry) => entry.id === worktreeId,
                    )),
        ) ?? null
    );
}
