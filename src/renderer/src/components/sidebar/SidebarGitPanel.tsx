import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import type { GitChangeEntry, GitRepositorySnapshot } from "@shared/ipc";

import {
    buildGitChangeGroups,
    summarizeGitRepository,
} from "@renderer/app/git/presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import {
    GitChangesView,
    GitCommitFooter,
    type GitChangeGroupId,
    type GitTreeNode,
} from "@renderer/components/git";
import { GitHubSidebarActions } from "@renderer/components/github/GitHubSidebarActions";

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

export function SidebarGitPanel({
    filter,
    onOpenSettings,
    projectId,
    worktreeId,
}: {
    readonly filter?: string;
    readonly onOpenSettings: () => void;
    readonly projectId: string;
    readonly worktreeId: string | null;
}) {
    const contextKey = getContextKey(projectId, worktreeId);
    const projects = useProjectsStore((s) => s.projects);
    const snapshot = useGitStore((s) => s.snapshots[contextKey] ?? null);
    const expandedGroupIds = useGitStore(
        (s) => s.expandedChangeGroups[contextKey],
    );
    const expandedPaths = useGitStore((s) => s.changeExpandedPaths[contextKey]);
    const commitMessage = useGitStore(
        (s) => s.commitMessages[contextKey] ?? "",
    );
    const error = useGitStore((s) => s.errors[contextKey] ?? null);

    const stagePaths = useGitStore((s) => s.stagePaths);
    const unstagePaths = useGitStore((s) => s.unstagePaths);
    const discardPaths = useGitStore((s) => s.discardPaths);
    const commitChanges = useGitStore((s) => s.commitChanges);
    const setCommitMessage = useGitStore((s) => s.setCommitMessage);
    const toggleChangeGroup = useGitStore((s) => s.toggleChangeGroup);
    const toggleChangePath = useGitStore((s) => s.toggleChangePath);
    const selectDiffPath = useGitStore((s) => s.selectDiffPath);
    const fetchRepository = useGitStore((s) => s.fetchRepository);
    const pullRepository = useGitStore((s) => s.pullRepository);
    const pushRepository = useGitStore((s) => s.pushRepository);

    const openFileTab = useWorkspaceStore((s) => s.openFileTab);
    const openGitTab = useWorkspaceStore((s) => s.openGitTab);

    const project = projects.find((p) => p.id === projectId) ?? null;

    const [syncStatus, setSyncStatus] = useState<{
        message: string;
        tone: "success" | "error";
    } | null>(null);
    const syncTimerRef = useRef<number>(0);

    const runSyncAction = useCallback(
        (label: string, action: () => Promise<GitRepositorySnapshot>) => {
            window.clearTimeout(syncTimerRef.current);
            setSyncStatus(null);
            action()
                .then((snap) => {
                    const msg = describeSyncResult(label, snap);
                    setSyncStatus({ message: msg, tone: "success" });
                })
                .catch(() => {
                    setSyncStatus({
                        message: `${label} failed`,
                        tone: "error",
                    });
                })
                .finally(() => {
                    syncTimerRef.current = window.setTimeout(
                        () => setSyncStatus(null),
                        2500,
                    );
                });
        },
        [],
    );

    const summary = useMemo(
        () => summarizeGitRepository(project, snapshot),
        [project, snapshot],
    );
    const defaultRemoteName = useMemo(
        () => resolveDefaultRemoteName(snapshot),
        [snapshot],
    );
    const currentBranchName = snapshot?.branch?.name ?? null;
    const canPublishBranch =
        currentBranchName !== null &&
        snapshot?.branch?.isDetached !== true &&
        defaultRemoteName !== null;
    const canForcePushWithLease =
        currentBranchName !== null && snapshot?.branch?.isDetached !== true;

    const allChanges = useMemo(
        () => snapshot?.changes ?? [],
        [snapshot?.changes],
    );
    const normalizedFilter = (filter ?? "").trim().toLowerCase();
    const hasFilter = normalizedFilter.length > 0;
    const changes = useMemo(() => {
        if (!hasFilter) {
            return allChanges;
        }

        return allChanges.filter((change) =>
            change.path.toLowerCase().includes(normalizedFilter),
        );
    }, [allChanges, hasFilter, normalizedFilter]);
    const totalChanges = allChanges.length;
    const filteredChangesCount = changes.length;

    const { totalAdded, totalDeleted } = useMemo(() => {
        let added = 0;
        let deleted = 0;
        for (const c of changes) {
            if (c.additions != null) added += c.additions;
            if (c.deletions != null) deleted += c.deletions;
        }
        return { totalAdded: added, totalDeleted: deleted };
    }, [changes]);

    const allStaged = useMemo(
        () => changes.length > 0 && changes.every((c) => c.scope === "staged"),
        [changes],
    );

    const actions = useMemo(
        () => ({
            onDiscardPath: (path: string) =>
                void discardPaths(projectId, [path], worktreeId),
            onOpenDiff: (path: string) =>
                selectDiffPath(projectId, path, worktreeId),
            onStagePath: (path: string) =>
                void stagePaths(projectId, [path], worktreeId),
            onUnstagePath: (path: string) =>
                void unstagePaths(projectId, [path], worktreeId),
        }),
        [
            discardPaths,
            projectId,
            selectDiffPath,
            stagePaths,
            unstagePaths,
            worktreeId,
        ],
    );

    const groups = useMemo(
        () => buildGitChangeGroups(changes, actions),
        [changes, actions],
    );

    const scopeByPath = useMemo(() => {
        const map = new Map<string, GitChangeEntry["scope"]>();
        for (const c of changes) {
            map.set(c.path, c.scope);
        }
        return map;
    }, [changes]);

    const handleStageAll = useCallback(() => {
        const paths = changes
            .filter((c) => c.scope !== "staged")
            .map((c) => c.path);
        if (paths.length > 0) {
            void stagePaths(projectId, paths, worktreeId);
        }
    }, [changes, projectId, stagePaths, worktreeId]);

    const handleUnstageAll = useCallback(() => {
        const paths = changes
            .filter((c) => c.scope === "staged")
            .map((c) => c.path);
        if (paths.length > 0) {
            void unstagePaths(projectId, paths, worktreeId);
        }
    }, [changes, projectId, unstagePaths, worktreeId]);

    const handleNodeClick = useCallback(
        (node: GitTreeNode) => {
            if (node.kind === "file") {
                void openFileTab(projectId, node.path, worktreeId);
            }
        },
        [openFileTab, projectId, worktreeId],
    );

    const handleToggleGroup = useCallback(
        (groupId: GitChangeGroupId) =>
            toggleChangeGroup(projectId, groupId, worktreeId),
        [projectId, toggleChangeGroup, worktreeId],
    );

    const handleToggleDirectory = useCallback(
        (node: GitTreeNode) =>
            toggleChangePath(projectId, node.path, worktreeId),
        [projectId, toggleChangePath, worktreeId],
    );

    const handleCommit = useCallback(() => {
        if (!commitMessage.trim()) return;
        void commitChanges({
            projectId,
            message: commitMessage,
            worktreeId,
        });
    }, [commitChanges, commitMessage, projectId, worktreeId]);

    const handleOpenHistory = useCallback(
        () => void openGitTab(projectId, worktreeId),
        [openGitTab, projectId, worktreeId],
    );

    const renderNodeMeta = useCallback(
        (node: GitTreeNode): ReactNode => {
            const scope = scopeByPath.get(node.path);
            const isFile = node.kind === "file" && scope != null;

            return (
                <>
                    {node.meta}
                    {isFile && (
                        <StagingCheckbox
                            checked={scope === "staged"}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (scope === "staged") {
                                    void unstagePaths(
                                        projectId,
                                        [node.path],
                                        worktreeId,
                                    );
                                } else {
                                    void stagePaths(
                                        projectId,
                                        [node.path],
                                        worktreeId,
                                    );
                                }
                            }}
                        />
                    )}
                </>
            );
        },
        [projectId, scopeByPath, stagePaths, unstagePaths, worktreeId],
    );

    const hasChanges = totalChanges > 0;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
                    <span>
                        {hasFilter
                            ? `${filteredChangesCount} of ${totalChanges}`
                            : `${totalChanges} ${totalChanges === 1 ? "Change" : "Changes"}`}
                    </span>
                    {(totalAdded > 0 || totalDeleted > 0) && (
                        <span className="font-mono text-[10px]">
                            <span
                                style={{
                                    color: "var(--diff-add)",
                                }}
                            >
                                +{totalAdded}
                            </span>{" "}
                            <span
                                style={{
                                    color: "var(--diff-remove)",
                                }}
                            >
                                -{totalDeleted}
                            </span>
                        </span>
                    )}
                </div>
                {hasChanges && (
                    <button
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                        onClick={allStaged ? handleUnstageAll : handleStageAll}
                        type="button"
                    >
                        {allStaged ? "Unstage All" : "Stage All"}
                    </button>
                )}
            </div>

            <div className="shell-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1">
                <GitChangesView
                    constrainWidth
                    expandedGroupIds={expandedGroupIds}
                    expandedPaths={expandedPaths}
                    groups={groups}
                    layout="tree"
                    onNodeClick={handleNodeClick}
                    onToggleDirectory={handleToggleDirectory}
                    onToggleGroup={handleToggleGroup}
                    renderNodeMeta={renderNodeMeta}
                />
            </div>

            <GitCommitFooter
                commit={{
                    disabled: !hasChanges,
                    error,
                    message: commitMessage,
                    onChange: (msg) =>
                        setCommitMessage(projectId, msg, worktreeId),
                    onCommit: handleCommit,
                }}
                gitHubActions={
                    <GitHubSidebarActions
                        onOpenSettings={onOpenSettings}
                        projectId={projectId}
                        worktreeId={worktreeId}
                    />
                }
                onOpenHistory={handleOpenHistory}
                summary={summary}
                syncActions={{
                    onFetch: () =>
                        runSyncAction("Fetch", () =>
                            fetchRepository(projectId, worktreeId),
                        ),
                    onFetchAll: () =>
                        runSyncAction("Fetch All", () =>
                            fetchRepository(projectId, worktreeId, {
                                all: true,
                            }),
                        ),
                    onFetchPrune: () =>
                        runSyncAction("Fetch Prune", () =>
                            fetchRepository(projectId, worktreeId, {
                                prune: true,
                            }),
                        ),
                    onPull: () =>
                        runSyncAction("Pull", () =>
                            pullRepository(projectId, worktreeId),
                        ),
                    onPullRebase: () =>
                        runSyncAction("Pull with Rebase", () =>
                            pullRepository(projectId, worktreeId, {
                                rebase: true,
                            }),
                        ),
                    onPush: () =>
                        runSyncAction("Push", () =>
                            pushRepository(projectId, worktreeId),
                        ),
                    onPublishBranch: () => {
                        if (!canPublishBranch || !currentBranchName) {
                            return;
                        }
                        runSyncAction("Publish Branch", () =>
                            pushRepository(projectId, worktreeId, {
                                remoteName: defaultRemoteName,
                                remoteRef: currentBranchName,
                                setUpstream: true,
                            }),
                        );
                    },
                    onForcePushWithLease: () => {
                        if (!canForcePushWithLease) {
                            return;
                        }
                        const confirmed = window.confirm(
                            `Force push "${currentBranchName}" with lease?\n\nThis can overwrite commits on the remote if your local branch is ahead. The lease prevents overwriting remote work that you have not fetched.`,
                        );
                        if (!confirmed) {
                            return;
                        }
                        runSyncAction("Force Push with Lease", () =>
                            pushRepository(projectId, worktreeId, {
                                forceWithLease: true,
                            }),
                        );
                    },
                    publishBranchDisabled: !canPublishBranch,
                    forcePushWithLeaseDisabled: !canForcePushWithLease,
                }}
                syncStatus={syncStatus}
            />
        </div>
    );
}

function describeSyncResult(
    label: string,
    snap: GitRepositorySnapshot,
): string {
    if (label.startsWith("Fetch") || label.startsWith("Pull")) {
        if (snap.syncStatus === "in_sync" && snap.aheadBy === 0) {
            return "Up to date";
        }
        if (label.startsWith("Pull") && snap.aheadBy > 0) {
            return `Pulled · ${snap.aheadBy} ahead`;
        }
    }
    if (label === "Publish Branch" && snap.syncStatus === "in_sync") {
        return "Published";
    }
    if (
        (label === "Push" || label === "Force Push with Lease") &&
        snap.syncStatus === "in_sync"
    ) {
        return "Pushed";
    }
    return `${label} done`;
}

function resolveDefaultRemoteName(
    snapshot: GitRepositorySnapshot | null,
): string | null {
    if (!snapshot) {
        return null;
    }

    return (
        snapshot.selectedRemoteName ??
        snapshot.remotes.find((remote) => remote.isDefault)?.name ??
        snapshot.remotes.find((remote) => remote.name === "origin")?.name ??
        snapshot.remotes[0]?.name ??
        null
    );
}

function StagingCheckbox({
    checked,
    onClick,
}: {
    readonly checked: boolean;
    readonly onClick: (event: React.MouseEvent) => void;
}) {
    return (
        <button
            className="flex items-center justify-center"
            onClick={onClick}
            style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                border: checked
                    ? "1.5px solid var(--color-accent)"
                    : "1.5px solid var(--color-border)",
                background: checked ? "var(--color-accent)" : "transparent",
                cursor: "pointer",
                flexShrink: 0,
                transition: "all 100ms ease",
                padding: 0,
            }}
            title={checked ? "Unstage" : "Stage"}
            type="button"
        >
            {checked && (
                <svg fill="none" height="10" viewBox="0 0 12 12" width="10">
                    <path
                        d="M2.5 6L5 8.5L9.5 3.5"
                        stroke="var(--color-bg-primary)"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.8"
                    />
                </svg>
            )}
        </button>
    );
}
