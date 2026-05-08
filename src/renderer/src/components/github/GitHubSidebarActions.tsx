import { useEffect, useMemo } from "react";

import type {
    GitHubAuthStatus,
    GitHubRepositoryRef,
    GitRepositorySnapshot,
} from "@shared/ipc";

import { countCurrentBranchPullRequests } from "@renderer/app/github/current-branch-pr";
import { resolveGitHubRepositoryRef } from "@renderer/app/git/remote-link";
import {
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useGitStore } from "@renderer/app/store/git-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";

interface GitHubSidebarActionsProps {
    readonly className?: string;
    readonly onOpenSettings: () => void;
    readonly projectId: string | null;
    readonly worktreeId: string | null;
}

type GitHubSidebarActionKind = "issues" | "pull_requests";

interface GitHubSidebarAction {
    readonly kind: GitHubSidebarActionKind;
    readonly label: string;
    readonly title: string;
}

const ACTIONS: readonly GitHubSidebarAction[] = [
    {
        kind: "issues",
        label: "Issues",
        title: "Open GitHub issues",
    },
    {
        kind: "pull_requests",
        label: "Pull Requests",
        title: "Open GitHub pull requests",
    },
];

export function GitHubSidebarActions({
    className,
    onOpenSettings,
    projectId,
    worktreeId,
}: GitHubSidebarActionsProps) {
    const snapshot = useGitStore((state) =>
        projectId
            ? getProjectSnapshot(state.snapshots, projectId, worktreeId)
            : null,
    );
    const repoRef = useMemo(
        () => resolveGitHubRepositoryRef(snapshot?.remotes ?? []),
        [snapshot?.remotes],
    );
    const authStatus = useGitHubStore((state) =>
        repoRef ? state.authStatusByHost[repoRef.host] : null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const issueCount = useGitHubStore((state) =>
        repoRef
            ? (state.issuesByRepo[getGitHubRepoKey(repoRef)]?.length ?? null)
            : null,
    );
    const pullRequestCount = useGitHubStore((state) =>
        repoRef
            ? (state.pullRequestsByRepo[getGitHubRepoKey(repoRef)]?.length ??
              null)
            : null,
    );
    const currentBranchName = snapshot?.branch?.isDetached
        ? null
        : (snapshot?.branch?.name ?? null);
    const currentBranchPullRequestCount = useGitHubStore((state) => {
        if (!repoRef) {
            return 0;
        }

        return countCurrentBranchPullRequests(
            state.pullRequestsByRepo[getGitHubRepoKey(repoRef)] ?? [],
            currentBranchName,
            repoRef,
        );
    });
    const openGitHubIssuesTab = useWorkspaceStore(
        (state) => state.openGitHubIssuesTab,
    );
    const openGitHubPullRequestsTab = useWorkspaceStore(
        (state) => state.openGitHubPullRequestsTab,
    );

    useEffect(() => {
        if (!repoRef || authStatus) {
            return;
        }

        void refreshAuthStatus(repoRef);
    }, [authStatus, refreshAuthStatus, repoRef]);

    const disabledReason = getDisabledReason({
        authStatus,
        projectId,
        repoRef,
        snapshot,
    });
    const needsConnection = repoRef != null && !hasUsableGitHubAuth(authStatus);

    const handleOpenAction = (kind: GitHubSidebarActionKind) => {
        if (!projectId || !repoRef || disabledReason) {
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
    };

    return (
        <div
            className={["app-no-drag flex items-center gap-1", className]
                .filter(Boolean)
                .join(" ")}
            style={{ fontFamily: "var(--font-mono)" }}
        >
            <div className="flex min-w-0 flex-1 items-center gap-1">
                {ACTIONS.map((action) => {
                    const count =
                        action.kind === "issues"
                            ? issueCount
                            : action.kind === "pull_requests"
                              ? pullRequestCount
                              : null;
                    const isDisabled = disabledReason != null;
                    const title = isDisabled
                        ? disabledReason
                        : action.kind === "pull_requests" &&
                            currentBranchPullRequestCount > 0
                          ? `${action.title} for ${repoRef?.owner}/${repoRef?.repo} (${currentBranchPullRequestCount} current branch)`
                          : `${action.title} for ${repoRef?.owner}/${repoRef?.repo}`;

                    return (
                        <button
                            className="review-action-btn flex min-w-0 flex-1 items-center justify-center gap-1.5"
                            disabled={isDisabled}
                            key={action.kind}
                            onClick={() => handleOpenAction(action.kind)}
                            style={{
                                background: "transparent",
                                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                borderRadius: 3,
                                color: "var(--color-text-secondary)",
                                cursor: isDisabled ? "not-allowed" : "pointer",
                                fontSize: "10px",
                                fontWeight: 500,
                                height: 22,
                                opacity: isDisabled ? 0.4 : 1,
                                padding: "0 8px",
                            }}
                            title={title}
                            type="button"
                        >
                            <span className="truncate">{action.label}</span>
                            {count != null && count > 0 ? (
                                <span className="inline-flex shrink-0 items-center rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-tertiary px-1 font-mono text-[9px] text-text-secondary">
                                    {count > 99 ? "99+" : count}
                                </span>
                            ) : null}
                            {action.kind === "pull_requests" &&
                            currentBranchPullRequestCount > 0 ? (
                                <span className="inline-flex shrink-0 items-center rounded-md border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1 font-mono text-[9px] text-text-primary">
                                    branch
                                </span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
            {needsConnection ? (
                <button
                    className="review-action-btn shrink-0"
                    onClick={onOpenSettings}
                    style={{
                        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                        borderRadius: 3,
                        color: "var(--color-text-primary)",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontWeight: 500,
                        height: 22,
                        padding: "0 8px",
                    }}
                    title="Connect GitHub in Settings"
                    type="button"
                >
                    Connect
                </button>
            ) : null}
        </div>
    );
}

function getDisabledReason({
    authStatus,
    projectId,
    repoRef,
    snapshot,
}: {
    readonly authStatus: GitHubAuthStatus | null;
    readonly projectId: string | null;
    readonly repoRef: GitHubRepositoryRef | null;
    readonly snapshot: GitRepositorySnapshot | null;
}): string | null {
    if (!projectId) {
        return "Open a project first";
    }

    if (!snapshot || snapshot.repositoryState !== "ready") {
        return "Open a Git repository";
    }

    if (!repoRef) {
        return "No GitHub remote detected";
    }

    if (!hasUsableGitHubAuth(authStatus)) {
        return "Connect GitHub to browse repository data";
    }

    return null;
}

function hasUsableGitHubAuth(authStatus: GitHubAuthStatus | null): boolean {
    return authStatus?.state === "authenticated";
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
