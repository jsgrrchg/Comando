import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent as ReactDragEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type {
    GitHubPullRequestChecksState,
    GitHubPullRequestSummary,
    GitRepositorySnapshot,
} from "@shared/ipc";

import {
    countCurrentBranchPullRequests,
    isPullRequestForCurrentBranch,
    sortPullRequestsNewestFirst,
} from "@renderer/app/github/current-branch-pr";
import { getGitContextKey } from "@renderer/app/git/context-key";
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
import type { MeasuredVirtualRange } from "../virtual/MeasuredVirtualList";

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
import { GitHubVirtualizedTableBody } from "./GitHubVirtualizedTableBody";
import { IdeActionButton } from "./ide-bar";

type PullRequestFilter = "all" | "branch" | "closed" | "draft" | "open";
type PullRequestColumnId = (typeof PR_TABLE_COLUMN_IDS)[number];
type PullRequestColumnWidths = Record<PullRequestColumnId, number>;

interface PullRequestTableLayout {
    readonly order: readonly PullRequestColumnId[];
    readonly widths: PullRequestColumnWidths;
}

const PR_TABLE_COLUMN_IDS = [
    "number",
    "description",
    "branch",
    "date",
    "action",
] as const;
const PR_TABLE_LAYOUT_STORAGE_KEY = "comando.github.pull-requests.table.layout";
const PR_TABLE_LAYOUT_VERSION = 1;
// Baseline threshold for enabling GitHub pull requests table virtualization.
export const GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD = 100;
export const GITHUB_PULL_REQUESTS_ROW_VIRTUALIZATION_THRESHOLD =
    GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD;
const PULL_REQUEST_CHECK_DATA_OVERSCAN = 10;
const PULL_REQUEST_INITIAL_CHECK_TARGET_COUNT = 20;
const DEFAULT_PR_TABLE_COLUMN_ORDER: readonly PullRequestColumnId[] =
    PR_TABLE_COLUMN_IDS;
const DEFAULT_PR_TABLE_COLUMN_WIDTHS: PullRequestColumnWidths = {
    action: 84,
    branch: 220,
    date: 140,
    description: 420,
    number: 56,
};
const PR_TABLE_COLUMN_MIN_WIDTHS: PullRequestColumnWidths = {
    action: 72,
    branch: 120,
    date: 96,
    description: 180,
    number: 44,
};
const PR_TABLE_COLUMN_MAX_WIDTH = 900;
const PR_TABLE_COLUMN_LABELS: Record<PullRequestColumnId, string> = {
    action: "Action",
    branch: "Branch",
    date: "Date",
    description: "Description",
    number: "#",
};

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
    const [virtualPullRequestRange, setVirtualPullRequestRange] =
        useState<MeasuredVirtualRange | null>(null);
    const requiredPullRequestListState = getPullRequestListState(filter);
    const pullRequests = useGitHubStore((state) =>
        state.pullRequestsByRepoAndState[repoKey]?.[
            requiredPullRequestListState
        ] ??
        (state.pullRequestListStateByRepo[repoKey] ===
        requiredPullRequestListState
            ? (state.pullRequestsByRepo[repoKey] ?? EMPTY_GITHUB_LIST)
            : EMPTY_GITHUB_LIST),
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
    const columnResizeCleanupRef = useRef<(() => void) | null>(null);
    const [tableLayout, setTableLayout] = useState<PullRequestTableLayout>(
        () => readPersistedPullRequestTableLayout(),
    );
    const [draggedColumnId, setDraggedColumnId] =
        useState<PullRequestColumnId | null>(null);
    const tableGridTemplate = useMemo(
        () =>
            tableLayout.order
                .map((columnId) => `${tableLayout.widths[columnId]}px`)
                .join(" "),
        [tableLayout],
    );
    const tableMinWidth = useMemo(
        () =>
            tableLayout.order.reduce(
                (total, columnId) => total + tableLayout.widths[columnId],
                0,
            ),
        [tableLayout],
    );

    useEffect(() => {
        return () => {
            columnResizeCleanupRef.current?.();
        };
    }, []);

    const persistTableLayout = useCallback((layout: PullRequestTableLayout) => {
        setTableLayout(layout);
        persistPullRequestTableLayout(layout);
    }, []);

    const handleColumnResizePointerDown = useCallback(
        (
            columnId: PullRequestColumnId,
            event: ReactPointerEvent<HTMLDivElement>,
        ) => {
            event.preventDefault();
            event.stopPropagation();

            columnResizeCleanupRef.current?.();

            const startX = event.clientX;
            const startWidth = tableLayout.widths[columnId];
            const previousCursor = document.body.style.cursor;
            const previousUserSelect = document.body.style.userSelect;
            let nextLayout = tableLayout;

            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            const handlePointerMove = (pointerEvent: PointerEvent) => {
                const nextWidth = clampWidth(
                    startWidth + pointerEvent.clientX - startX,
                    PR_TABLE_COLUMN_MIN_WIDTHS[columnId],
                    PR_TABLE_COLUMN_MAX_WIDTH,
                );
                nextLayout = {
                    ...tableLayout,
                    widths: {
                        ...tableLayout.widths,
                        [columnId]: Math.round(nextWidth),
                    },
                };
                setTableLayout(nextLayout);
            };

            const cleanup = () => {
                document.body.style.cursor = previousCursor;
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerUp);
                columnResizeCleanupRef.current = null;
                persistPullRequestTableLayout(nextLayout);
            };

            const handlePointerUp = () => {
                cleanup();
            };

            columnResizeCleanupRef.current = cleanup;
            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerUp);
        },
        [tableLayout],
    );

    const handleColumnDragStart = useCallback(
        (
            columnId: PullRequestColumnId,
            event: ReactDragEvent<HTMLDivElement>,
        ) => {
            setDraggedColumnId(columnId);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", columnId);
        },
        [],
    );

    const handleColumnDrop = useCallback(
        (
            targetColumnId: PullRequestColumnId,
            event: ReactDragEvent<HTMLDivElement>,
        ) => {
            event.preventDefault();
            const sourceColumnId =
                draggedColumnId ??
                parsePullRequestColumnId(
                    event.dataTransfer.getData("text/plain"),
                );
            setDraggedColumnId(null);
            if (!sourceColumnId || sourceColumnId === targetColumnId) {
                return;
            }

            persistTableLayout({
                ...tableLayout,
                order: movePullRequestColumn(
                    tableLayout.order,
                    sourceColumnId,
                    targetColumnId,
                ),
            });
        },
        [draggedColumnId, persistTableLayout, tableLayout],
    );

    useEffect(() => {
        if (!newHead && currentBranch) {
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) {
                    setNewHead(currentBranch);
                }
            });
            return () => {
                cancelled = true;
            };
        }
    }, [currentBranch, newHead]);

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            const cachedPullRequests =
                useGitHubStore.getState().pullRequestsByRepoAndState[repoKey]?.[
                    requiredPullRequestListState
                ];
            if (cachedPullRequests !== undefined) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await refreshPullRequests(tab.ref, {
                    state: requiredPullRequestListState,
                });
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [
        refreshAuthStatus,
        refreshPullRequests,
        repoKey,
        requiredPullRequestListState,
        tab.ref,
    ]);

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

        return sortPullRequestsNewestFirst(filteredPullRequests);
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
            getVisiblePullRequestCheckTargets({
                pullRequests: visiblePullRequests,
                range:
                    visiblePullRequests.length >=
                    GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD
                        ? virtualPullRequestRange
                        : null,
            }),
        [visiblePullRequests, virtualPullRequestRange],
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
    const handleOpenPullRequest = useCallback(
        (pullRequestNumber: number) =>
            void openGitHubPullRequestTab({
                projectId: tab.projectId,
                pullRequestNumber,
                ref: tab.ref,
                worktreeId: tab.worktreeId ?? null,
            }),
        [
            openGitHubPullRequestTab,
            tab.projectId,
            tab.ref,
            tab.worktreeId,
        ],
    );
    const handlePullRequestRangeChange = useCallback(
        (range: MeasuredVirtualRange) => {
            setVirtualPullRequestRange((current) =>
                areMeasuredVirtualRangesEqual(current, range)
                    ? current
                    : range,
            );
        },
        [],
    );
    const renderPullRequestRow = useCallback(
        (pullRequest: GitHubPullRequestSummary) => {
            const checksKey = getGitHubPullRequestChecksKey(
                tab.ref,
                pullRequest.head.sha,
            );
            const checks =
                pullRequestChecksByHeadSha[pullRequest.head.sha] ?? null;
            const checksState = loadingKeys[checksKey]
                ? "loading"
                : (checks?.state ?? "unknown");

            return (
                <PullRequestTableRow
                    checksState={checksState}
                    isCurrentBranchPullRequest={isPullRequestForCurrentBranch(
                        pullRequest,
                        currentBranch,
                        tab.ref,
                    )}
                    onOpenPullRequest={handleOpenPullRequest}
                    pullRequest={pullRequest}
                    tableLayout={tableLayout}
                />
            );
        },
        [
            currentBranch,
            handleOpenPullRequest,
            loadingKeys,
            pullRequestChecksByHeadSha,
            tab.ref,
            tableLayout,
        ],
    );

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
            scrollScope={{
                entityId: repoKey,
                projectId: tab.projectId,
                surface: "github_pull_requests",
                worktreeId: tab.worktreeId ?? null,
            }}
        >
            {({ scrollContainerRef }) => (
                <>
                    <div className="space-y-3 p-4">
                        <GitHubAuthNotice authStatus={authStatus} />
                        {error ? (
                            <GitHubErrorState>{error}</GitHubErrorState>
                        ) : null}
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
                                        Current branch has no upstream. Push it
                                        before creating a pull request if GitHub
                                        cannot find the head ref.
                                    </div>
                                ) : null}
                                <input
                                    className="h-[22px] w-full rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                    onChange={(event) =>
                                        setNewTitle(
                                            event.currentTarget.value,
                                        )
                                    }
                                    placeholder="Pull request title"
                                    value={newTitle}
                                />
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                    <input
                                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                        onChange={(event) =>
                                            setNewBase(
                                                event.currentTarget.value,
                                            )
                                        }
                                        placeholder="base"
                                        value={newBase}
                                    />
                                    <input
                                        className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-2 font-mono text-[12px] text-text-primary outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                        onChange={(event) =>
                                            setNewHead(
                                                event.currentTarget.value,
                                            )
                                        }
                                        placeholder="head"
                                        value={newHead}
                                    />
                                </div>
                                <textarea
                                    className="mt-2 min-h-28 w-full resize-y rounded-md border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-bg-primary px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))]"
                                    onChange={(event) =>
                                        setNewBody(
                                            event.currentTarget.value,
                                        )
                                    }
                                    placeholder="Describe the pull request..."
                                    value={newBody}
                                />
                                <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
                                    <input
                                        checked={newDraft}
                                        onChange={(event) =>
                                            setNewDraft(
                                                event.currentTarget.checked,
                                            )
                                        }
                                        type="checkbox"
                                    />
                                    Create as draft
                                </label>
                                <div className="mt-3">
                                    <GitHubDraftPreview
                                        body={newBody}
                                        meta={`${
                                            newHead.trim() || "head"
                                        } into ${
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
                        <div className="shell-scrollbar overflow-x-auto">
                            <div
                                className="sticky top-0 z-10 grid items-center px-3 py-1.5 text-[10px] font-semibold uppercase text-text-secondary"
                                style={{
                                    backgroundColor:
                                        "var(--color-bg-secondary)",
                                    borderBottom:
                                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                    fontFamily: "var(--font-mono)",
                                    gridTemplateColumns: tableGridTemplate,
                                    letterSpacing: "0.06em",
                                    minWidth: tableMinWidth,
                                }}
                            >
                                {tableLayout.order.map((columnId) => (
                                    <PullRequestHeaderCell
                                        columnId={columnId}
                                        dragged={
                                            draggedColumnId === columnId
                                        }
                                        key={columnId}
                                        label={
                                            PR_TABLE_COLUMN_LABELS[columnId]
                                        }
                                        onDragEnd={() =>
                                            setDraggedColumnId(null)
                                        }
                                        onDragOver={(event) => {
                                            event.preventDefault();
                                            event.dataTransfer.dropEffect =
                                                "move";
                                        }}
                                        onDragStart={(event) =>
                                            handleColumnDragStart(
                                                columnId,
                                                event,
                                            )
                                        }
                                        onDrop={(event) =>
                                            handleColumnDrop(columnId, event)
                                        }
                                        onResizePointerDown={(event) =>
                                            handleColumnResizePointerDown(
                                                columnId,
                                                event,
                                            )
                                        }
                                    />
                                ))}
                            </div>
                            <GitHubVirtualizedTableBody
                                estimateRowHeight={
                                    estimatePullRequestTableRowHeight
                                }
                                getRowKey={(pullRequest) =>
                                    String(pullRequest.id)
                                }
                                gridTemplateColumns={tableGridTemplate}
                                items={visiblePullRequests}
                                minWidth={tableMinWidth}
                                onRangeChange={handlePullRequestRangeChange}
                                renderRow={renderPullRequestRow}
                                scrollContainerRef={scrollContainerRef}
                                threshold={
                                    GITHUB_PULL_REQUESTS_VIRTUALIZATION_THRESHOLD
                                }
                            />
                        </div>
                    ) : null}
                </>
            )}
        </GitHubTabShell>
    );
}

function PullRequestTableRow({
    checksState,
    isCurrentBranchPullRequest,
    onOpenPullRequest,
    pullRequest,
    tableLayout,
}: {
    readonly checksState: GitHubPullRequestChecksState | "loading";
    readonly isCurrentBranchPullRequest: boolean;
    readonly onOpenPullRequest: (pullRequestNumber: number) => void;
    readonly pullRequest: GitHubPullRequestSummary;
    readonly tableLayout: PullRequestTableLayout;
}) {
    const handleOpenPullRequest = () => {
        onOpenPullRequest(pullRequest.number);
    };

    return (
        <div
            className={[
                "group/row items-stretch border-b border-l-[3px] border-b-border-subtle pl-2.5 pr-3 text-left text-[11px] transition-[color,background-color,border-color] duration-120",
                isCurrentBranchPullRequest
                    ? "border-l-[color-mix(in_srgb,var(--color-accent)_70%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-primary))] text-text-primary"
                    : "border-l-transparent text-text-secondary hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary hover:text-text-primary",
            ].join(" ")}
            style={{
                minHeight: estimatePullRequestTableRowHeight(pullRequest),
            }}
        >
            {tableLayout.order.map((columnId) => (
                <PullRequestTableCell
                    checksState={checksState}
                    columnId={columnId}
                    isCurrentBranchPullRequest={isCurrentBranchPullRequest}
                    key={columnId}
                    onOpen={handleOpenPullRequest}
                    pullRequest={pullRequest}
                />
            ))}
        </div>
    );
}

function PullRequestHeaderCell({
    columnId,
    dragged,
    label,
    onDragEnd,
    onDragOver,
    onDragStart,
    onDrop,
    onResizePointerDown,
}: {
    readonly columnId: PullRequestColumnId;
    readonly dragged: boolean;
    readonly label: string;
    readonly onDragEnd: () => void;
    readonly onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
    readonly onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
    readonly onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
    readonly onResizePointerDown: (
        event: ReactPointerEvent<HTMLDivElement>,
    ) => void;
}) {
    return (
        <div
            className={[
                "relative min-w-0 pr-3",
                columnId === "action" ? "text-right" : "",
                dragged ? "opacity-55" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            draggable
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragStart={onDragStart}
            onDrop={onDrop}
            title="Drag to reorder. Drag the edge to resize."
        >
            <span className="block cursor-grab truncate active:cursor-grabbing">
                {label}
            </span>
            <div
                aria-label={`Resize ${label} column`}
                className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none"
                onPointerDown={onResizePointerDown}
                role="separator"
                title={`Resize ${label}`}
            >
                <div className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-border-strong" />
            </div>
        </div>
    );
}

function PullRequestTableCell({
    checksState,
    columnId,
    isCurrentBranchPullRequest,
    onOpen,
    pullRequest,
}: {
    readonly checksState: GitHubPullRequestChecksState | "loading";
    readonly columnId: PullRequestColumnId;
    readonly isCurrentBranchPullRequest: boolean;
    readonly onOpen: () => void;
    readonly pullRequest: GitHubPullRequestSummary;
}) {
    if (columnId === "action") {
        return (
            <div className="flex h-full min-w-0 items-start justify-end py-2.5">
                <IdeActionButton
                    onClick={() => openGitHubWebUrl(pullRequest.url)}
                >
                    Open
                </IdeActionButton>
            </div>
        );
    }

    return (
        <button
            className="block h-full min-w-0 overflow-hidden py-2.5 pr-3 text-left"
            onClick={onOpen}
            type="button"
        >
            {renderPullRequestColumnContent({
                checksState,
                columnId,
                isCurrentBranchPullRequest,
                pullRequest,
            })}
        </button>
    );
}

function renderPullRequestColumnContent({
    checksState,
    columnId,
    isCurrentBranchPullRequest,
    pullRequest,
}: {
    readonly checksState: GitHubPullRequestChecksState | "loading";
    readonly columnId: Exclude<PullRequestColumnId, "action">;
    readonly isCurrentBranchPullRequest: boolean;
    readonly pullRequest: GitHubPullRequestSummary;
}) {
    if (columnId === "number") {
        return (
            <div className="truncate font-mono text-text-secondary">
                #{pullRequest.number}
            </div>
        );
    }

    if (columnId === "branch") {
        return (
            <div
                className="min-w-0 overflow-hidden text-[11px] text-text-secondary"
                style={{
                    fontFamily: "var(--font-mono)",
                }}
            >
                <div className="truncate">{pullRequest.head.label}</div>
                <div className="truncate">into {pullRequest.base.label}</div>
            </div>
        );
    }

    if (columnId === "date") {
        return (
            <div className="min-w-0 text-[11px] text-text-secondary">
                <div>{pullRequest.commentCount} comments</div>
                <div className="mt-0.5">
                    {formatGitHubRelativeTime(pullRequest.updatedAt)}
                </div>
            </div>
        );
    }

    return (
        <div className="min-w-0 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
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
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                    {pullRequest.title}
                </span>
                <GitHubChecksPill state={checksState} />
                {isCurrentBranchPullRequest ? (
                    <span className="shrink-0 rounded-md border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-text-primary">
                        Current branch
                    </span>
                ) : null}
            </div>
            {pullRequest.labels.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                    {pullRequest.labels.slice(0, 4).map((label) => (
                        <GitHubLabelPill key={label.id} label={label} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

interface PullRequestCheckTarget {
    readonly headSha: string;
    readonly number: number;
}

export function getVisiblePullRequestCheckTargets({
    pullRequests,
    range,
}: {
    readonly pullRequests: readonly GitHubPullRequestSummary[];
    readonly range: MeasuredVirtualRange | null;
}): readonly PullRequestCheckTarget[] {
    const hasVisibleRange =
        range !== null &&
        range.visibleEndIndex >= range.visibleStartIndex &&
        range.visibleStartIndex < pullRequests.length;
    const startIndex =
        hasVisibleRange
            ? Math.max(
                  0,
                  range.visibleStartIndex - PULL_REQUEST_CHECK_DATA_OVERSCAN,
              )
            : 0;
    const endIndex =
        hasVisibleRange
            ? Math.min(
                  pullRequests.length,
                  range.visibleEndIndex + PULL_REQUEST_CHECK_DATA_OVERSCAN + 1,
              )
            : Math.min(
                  pullRequests.length,
                  PULL_REQUEST_INITIAL_CHECK_TARGET_COUNT,
              );
    const seenHeadShas = new Set<string>();
    const targets: PullRequestCheckTarget[] = [];

    for (const pullRequest of pullRequests.slice(startIndex, endIndex)) {
        const headSha = pullRequest.head.sha.trim();
        if (!headSha || seenHeadShas.has(headSha)) {
            continue;
        }

        seenHeadShas.add(headSha);
        targets.push({
            headSha,
            number: pullRequest.number,
        });
    }

    return targets;
}

function areMeasuredVirtualRangesEqual(
    left: MeasuredVirtualRange | null,
    right: MeasuredVirtualRange,
): boolean {
    return (
        left !== null &&
        left.startIndex === right.startIndex &&
        left.endIndex === right.endIndex &&
        left.visibleStartIndex === right.visibleStartIndex &&
        left.visibleEndIndex === right.visibleEndIndex
    );
}

function estimatePullRequestTableRowHeight(
    pullRequest: GitHubPullRequestSummary,
): number {
    return pullRequest.labels.length > 0 ? 72 : 58;
}

function clampWidth(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function createDefaultPullRequestTableLayout(): PullRequestTableLayout {
    return {
        order: DEFAULT_PR_TABLE_COLUMN_ORDER,
        widths: DEFAULT_PR_TABLE_COLUMN_WIDTHS,
    };
}

function readPersistedPullRequestTableLayout(): PullRequestTableLayout {
    const storage = getStorage();
    if (!storage) {
        return createDefaultPullRequestTableLayout();
    }

    const rawValue = storage.getItem(PR_TABLE_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
        return createDefaultPullRequestTableLayout();
    }

    try {
        return normalizePullRequestTableLayout(JSON.parse(rawValue));
    } catch {
        return createDefaultPullRequestTableLayout();
    }
}

function persistPullRequestTableLayout(layout: PullRequestTableLayout): void {
    const storage = getStorage();
    if (!storage) {
        return;
    }

    storage.setItem(
        PR_TABLE_LAYOUT_STORAGE_KEY,
        JSON.stringify({
            ...layout,
            updatedAt: Date.now(),
            version: PR_TABLE_LAYOUT_VERSION,
        }),
    );
}

function normalizePullRequestTableLayout(raw: unknown): PullRequestTableLayout {
    if (!raw || typeof raw !== "object") {
        return createDefaultPullRequestTableLayout();
    }

    const version = (raw as { version?: unknown }).version;
    const rawOrder = (raw as { order?: unknown }).order;
    const rawWidths = (raw as { widths?: unknown }).widths;
    if (version !== PR_TABLE_LAYOUT_VERSION || !Array.isArray(rawOrder)) {
        return createDefaultPullRequestTableLayout();
    }

    const order = normalizePullRequestColumnOrder(rawOrder);
    const widths = { ...DEFAULT_PR_TABLE_COLUMN_WIDTHS };
    if (rawWidths && typeof rawWidths === "object") {
        for (const columnId of PR_TABLE_COLUMN_IDS) {
            const width = (rawWidths as Record<string, unknown>)[columnId];
            if (typeof width !== "number" || !Number.isFinite(width)) {
                continue;
            }

            widths[columnId] = Math.round(
                clampWidth(
                    width,
                    PR_TABLE_COLUMN_MIN_WIDTHS[columnId],
                    PR_TABLE_COLUMN_MAX_WIDTH,
                ),
            );
        }
    }

    return { order, widths };
}

function normalizePullRequestColumnOrder(
    rawOrder: readonly unknown[],
): readonly PullRequestColumnId[] {
    const seen = new Set<PullRequestColumnId>();
    const order: PullRequestColumnId[] = [];
    for (const item of rawOrder) {
        const columnId = parsePullRequestColumnId(item);
        if (!columnId || seen.has(columnId)) {
            continue;
        }

        seen.add(columnId);
        order.push(columnId);
    }

    for (const columnId of DEFAULT_PR_TABLE_COLUMN_ORDER) {
        if (!seen.has(columnId)) {
            order.push(columnId);
        }
    }

    return order;
}

function parsePullRequestColumnId(
    value: unknown,
): PullRequestColumnId | null {
    return typeof value === "string" &&
        (PR_TABLE_COLUMN_IDS as readonly string[]).includes(value)
        ? (value as PullRequestColumnId)
        : null;
}

function movePullRequestColumn(
    order: readonly PullRequestColumnId[],
    sourceColumnId: PullRequestColumnId,
    targetColumnId: PullRequestColumnId,
): readonly PullRequestColumnId[] {
    const nextOrder = order.filter((columnId) => columnId !== sourceColumnId);
    const targetIndex = nextOrder.indexOf(targetColumnId);
    if (targetIndex < 0) {
        return order;
    }

    nextOrder.splice(targetIndex, 0, sourceColumnId);
    return nextOrder;
}

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function getPullRequestListState(
    filter: PullRequestFilter,
): "all" | "closed" | "open" {
    return filter === "draft" || filter === "branch" ? "all" : filter;
}

function getContextKey(projectId: string, worktreeId: string | null): string {
    return getGitContextKey(projectId, worktreeId);
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
