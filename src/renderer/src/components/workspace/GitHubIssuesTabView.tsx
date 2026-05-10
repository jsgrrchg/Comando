import { useEffect, useMemo, useRef, useState } from "react";

import type { GitHubIssueState } from "@shared/ipc";

import {
    EMPTY_GITHUB_LIST,
    getGitHubRepoKey,
    useGitHubStore,
} from "@renderer/app/store/github-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitHubIssuesTab } from "@renderer/app/workspace/tree";

import {
    formatGitHubRelativeTime,
    getGitHubWritePermissionLabel,
    GitHubAuthNotice,
    GitHubDraftPreview,
    GitHubEmptyState,
    GitHubErrorState,
    GitHubFilterButton,
    GitHubLabelPill,
    GitHubSearchBox,
    GitHubStatePill,
    GitHubTabHeader,
    GitHubTabShell,
    GitHubUsers,
    hasGitHubWritePermission,
    openGitHubWebUrl,
} from "./GitHubWorkspacePrimitives";
import { IdeActionButton } from "./ide-bar";

type IssueFilter = GitHubIssueState | "all" | "assigned";

export function GitHubIssuesTabView({
    tab,
}: {
    readonly tab: RuntimeWorkspaceGitHubIssuesTab;
}) {
    const repoKey = getGitHubRepoKey(tab.ref);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<IssueFilter>("open");
    const [isCreating, setIsCreating] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    const [newBody, setNewBody] = useState("");
    const [newLabels, setNewLabels] = useState("");
    const issues = useGitHubStore(
        (state) => state.issuesByRepo[repoKey] ?? EMPTY_GITHUB_LIST,
    );
    const authStatus = useGitHubStore(
        (state) => state.authStatusByHost[tab.ref.host] ?? null,
    );
    const isLoading = useGitHubStore(
        (state) => state.loadingKeys[`${repoKey}:issues`] ?? false,
    );
    const isCheckingAuth = useGitHubStore(
        (state) => state.loadingKeys[`auth:${tab.ref.host}`] ?? false,
    );
    const isCreatingIssue = useGitHubStore(
        (state) => state.mutatingKeys[`${repoKey}:issue:create`] ?? false,
    );
    const error = useGitHubStore(
        (state) =>
            state.errors[`${repoKey}:issues`] ??
            state.errors[`${repoKey}:issue:create`] ??
            null,
    );
    const refreshAuthStatus = useGitHubStore(
        (state) => state.refreshAuthStatus,
    );
    const refreshIssues = useGitHubStore((state) => state.refreshIssues);
    const createIssue = useGitHubStore((state) => state.createIssue);
    const openGitHubIssueTab = useWorkspaceStore(
        (state) => state.openGitHubIssueTab,
    );
    const lastRequestedFilterRef = useRef(filter);

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            if (useGitHubStore.getState().issuesByRepo[repoKey] !== undefined) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await refreshIssues(tab.ref, {
                    state: "open",
                });
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [refreshAuthStatus, refreshIssues, repoKey, tab.ref]);

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
                await refreshIssues(tab.ref, {
                    state: getIssueListState(filter),
                });
            }
        }

        void refreshFilterData();

        return () => {
            cancelled = true;
        };
    }, [filter, refreshAuthStatus, refreshIssues, tab.ref]);

    const visibleIssues = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        const login = authStatus?.user?.login ?? null;

        return issues.filter((issue) => {
            if (
                filter === "assigned" &&
                (!login ||
                    !issue.assignees.some(
                        (assignee) => assignee.login === login,
                    ))
            ) {
                return false;
            }

            if (
                filter !== "all" &&
                filter !== "assigned" &&
                issue.state !== filter
            ) {
                return false;
            }

            if (!normalizedQuery) {
                return true;
            }

            return (
                issue.title.toLowerCase().includes(normalizedQuery) ||
                String(issue.number).includes(normalizedQuery) ||
                issue.labels.some((label) =>
                    label.name.toLowerCase().includes(normalizedQuery),
                )
            );
        });
    }, [authStatus?.user?.login, filter, issues, query]);

    const canWriteIssues = hasGitHubWritePermission(authStatus, "issues");
    const writePermissionLabel = getGitHubWritePermissionLabel("issues");

    const handleRefresh = async () => {
        const status = await refreshAuthStatus(tab.ref);
        if (status.state === "authenticated") {
            await refreshIssues(tab.ref, {
                state: getIssueListState(filter),
            });
        }
    };

    const handleCreateIssue = async () => {
        const title = newTitle.trim();
        if (!title || !canWriteIssues) {
            return;
        }
        if (!window.confirm(`Create issue "${title}" on GitHub?`)) {
            return;
        }

        const detail = await createIssue(tab.ref, {
            body: newBody.trim() || null,
            labels: parseCsv(newLabels),
            title,
        });
        setNewTitle("");
        setNewBody("");
        setNewLabels("");
        setIsCreating(false);
        await openGitHubIssueTab({
            issueNumber: detail.number,
            projectId: tab.projectId,
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
                                disabled={!canWriteIssues}
                                onClick={() => setIsCreating((value) => !value)}
                                title={
                                    canWriteIssues
                                        ? undefined
                                        : writePermissionLabel
                                }
                            >
                                New Issue
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={isLoading || isCheckingAuth}
                                onClick={() => void handleRefresh()}
                            >
                                Refresh
                            </IdeActionButton>
                        </>
                    }
                    count={visibleIssues.length}
                    repo={tab.ref}
                    title="Issues"
                />
            }
        >
            <div className="space-y-3 p-4">
                <GitHubAuthNotice authStatus={authStatus} />
                {error ? <GitHubErrorState>{error}</GitHubErrorState> : null}
                <div className="flex flex-wrap items-center gap-2">
                    <GitHubSearchBox
                        onChange={setQuery}
                        placeholder="Search issues..."
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
                        active={filter === "assigned"}
                        onClick={() => setFilter("assigned")}
                    >
                        Assigned to me
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
                        <input
                            className="h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                            onChange={(event) =>
                                setNewTitle(event.currentTarget.value)
                            }
                            placeholder="Issue title"
                            value={newTitle}
                        />
                        <textarea
                            className="mt-2 min-h-28 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                            onChange={(event) =>
                                setNewBody(event.currentTarget.value)
                            }
                            placeholder="Describe the issue..."
                            value={newBody}
                        />
                        <input
                            className="mt-2 h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                            onChange={(event) =>
                                setNewLabels(event.currentTarget.value)
                            }
                            placeholder="Labels, comma separated"
                            value={newLabels}
                        />
                        <div className="mt-3">
                            <GitHubDraftPreview
                                body={newBody}
                                meta={
                                    parseCsv(newLabels)?.length
                                        ? `Labels: ${parseCsv(newLabels)?.join(", ")}`
                                        : "No labels"
                                }
                                title={newTitle}
                            />
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                            <IdeActionButton
                                disabled={isCreatingIssue}
                                onClick={() => setIsCreating(false)}
                            >
                                Cancel
                            </IdeActionButton>
                            <IdeActionButton
                                disabled={
                                    isCreatingIssue ||
                                    !canWriteIssues ||
                                    newTitle.trim().length === 0
                                }
                                onClick={() => void handleCreateIssue()}
                            >
                                {isCreatingIssue
                                    ? "Creating..."
                                    : "Create Issue"}
                            </IdeActionButton>
                        </div>
                    </div>
                ) : null}
                {isLoading || isCheckingAuth ? (
                    <div className="text-[12px] text-text-secondary">
                        Loading issues...
                    </div>
                ) : null}
                {!isLoading && visibleIssues.length === 0 ? (
                    <GitHubEmptyState>No issues match this view.</GitHubEmptyState>
                ) : null}
            </div>
            {!isLoading && visibleIssues.length > 0 ? (
                <div>
                    <div
                        className="sticky top-0 z-10 grid items-center px-3 py-1.5 text-[10px] font-semibold uppercase text-text-secondary"
                        style={{
                            backgroundColor: "var(--color-bg-secondary)",
                            borderBottom:
                                "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                            fontFamily: "var(--font-mono)",
                            gridTemplateColumns: ISSUE_TABLE_GRID,
                            letterSpacing: "0.06em",
                        }}
                    >
                        <span>#</span>
                        <span>Description</span>
                        <span>Assignees</span>
                        <span>Date</span>
                        <span className="text-right">Action</span>
                    </div>
                    {visibleIssues.map((issue) => (
                        <div
                            className="group/row grid items-stretch border-l-[3px] border-l-transparent pl-2.5 pr-3 text-left text-[11px] text-text-secondary transition-[color,background-color,border-color] duration-120 hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary hover:text-text-primary"
                            key={issue.id}
                            style={{ gridTemplateColumns: ISSUE_TABLE_GRID }}
                        >
                            <button
                                className="contents text-left"
                                onClick={() =>
                                    void openGitHubIssueTab({
                                        issueNumber: issue.number,
                                        projectId: tab.projectId,
                                        ref: tab.ref,
                                        worktreeId: tab.worktreeId ?? null,
                                    })
                                }
                                type="button"
                            >
                                <div className="border-b border-border-subtle py-2.5 font-mono text-text-secondary">
                                    #{issue.number}
                                </div>
                                <div className="min-w-0 border-b border-border-subtle py-2.5 pr-3">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <GitHubStatePill tone={issue.state}>
                                            {issue.state}
                                        </GitHubStatePill>
                                        <span className="truncate text-[12px] text-text-primary">
                                            {issue.title}
                                        </span>
                                    </div>
                                    {issue.labels.length > 0 ? (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {issue.labels
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
                                <div className="flex min-w-0 items-center border-b border-border-subtle py-2.5 pr-3">
                                    <GitHubUsers users={issue.assignees} />
                                </div>
                                <div className="border-b border-border-subtle py-2.5 pr-3 text-[11px] text-text-secondary">
                                    <div>{issue.commentCount} comments</div>
                                    <div className="mt-0.5">
                                        {formatGitHubRelativeTime(
                                            issue.updatedAt,
                                        )}
                                    </div>
                                </div>
                            </button>
                            <div className="flex items-center justify-end border-b border-border-subtle py-2.5">
                                <IdeActionButton
                                    onClick={() => openGitHubWebUrl(issue.url)}
                                >
                                    Open in GitHub
                                </IdeActionButton>
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
        </GitHubTabShell>
    );
}

const ISSUE_TABLE_GRID = "56px minmax(280px,1fr) 180px 110px 116px";

function parseCsv(value: string): readonly string[] | null {
    const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries.length > 0 ? entries : null;
}

function getIssueListState(filter: IssueFilter): GitHubIssueState | "all" {
    return filter === "assigned" ? "all" : filter;
}
