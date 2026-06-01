import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type DragEvent as ReactDragEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import type { GitHubIssueState, GitHubIssueSummary } from "@shared/ipc";

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
import { GitHubVirtualizedTableBody } from "./GitHubVirtualizedTableBody";
import { IdeActionButton } from "./ide-bar";

type IssueFilter = GitHubIssueState | "all" | "assigned";
type IssueColumnId = (typeof ISSUE_TABLE_COLUMN_IDS)[number];
type IssueColumnWidths = Record<IssueColumnId, number>;

interface IssueTableLayout {
    readonly order: readonly IssueColumnId[];
    readonly widths: IssueColumnWidths;
}

const ISSUE_TABLE_COLUMN_IDS = [
    "number",
    "description",
    "assignees",
    "date",
    "action",
] as const;
const ISSUE_TABLE_LAYOUT_STORAGE_KEY = "comando.github.issues.table.layout";
const ISSUE_TABLE_LAYOUT_VERSION = 1;
// Baseline threshold for enabling GitHub issues table virtualization.
export const GITHUB_ISSUES_VIRTUALIZATION_THRESHOLD = 100;
export const GITHUB_ISSUES_ROW_VIRTUALIZATION_THRESHOLD =
    GITHUB_ISSUES_VIRTUALIZATION_THRESHOLD;
const DEFAULT_ISSUE_TABLE_COLUMN_ORDER: readonly IssueColumnId[] =
    ISSUE_TABLE_COLUMN_IDS;
const DEFAULT_ISSUE_TABLE_COLUMN_WIDTHS: IssueColumnWidths = {
    action: 128,
    assignees: 180,
    date: 140,
    description: 420,
    number: 56,
};
const ISSUE_TABLE_COLUMN_MIN_WIDTHS: IssueColumnWidths = {
    action: 112,
    assignees: 120,
    date: 96,
    description: 180,
    number: 44,
};
const ISSUE_TABLE_COLUMN_MAX_WIDTH = 900;
const ISSUE_TABLE_ROW_HEIGHT = 58;
const ISSUE_TABLE_COLUMN_LABELS: Record<IssueColumnId, string> = {
    action: "Action",
    assignees: "Assignees",
    date: "Date",
    description: "Description",
    number: "#",
};

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
    const requiredIssueListState = getIssueListState(filter);
    const issues = useGitHubStore((state) =>
        state.issuesByRepoAndState[repoKey]?.[requiredIssueListState] ??
        (state.issueListStateByRepo[repoKey] === requiredIssueListState
            ? (state.issuesByRepo[repoKey] ?? EMPTY_GITHUB_LIST)
            : EMPTY_GITHUB_LIST),
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
    const columnResizeCleanupRef = useRef<(() => void) | null>(null);
    const [tableLayout, setTableLayout] = useState<IssueTableLayout>(
        () => readPersistedIssueTableLayout(),
    );
    const [draggedColumnId, setDraggedColumnId] =
        useState<IssueColumnId | null>(null);
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

    const persistTableLayout = useCallback((layout: IssueTableLayout) => {
        setTableLayout(layout);
        persistIssueTableLayout(layout);
    }, []);

    const handleColumnResizePointerDown = useCallback(
        (
            columnId: IssueColumnId,
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
                    ISSUE_TABLE_COLUMN_MIN_WIDTHS[columnId],
                    ISSUE_TABLE_COLUMN_MAX_WIDTH,
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
                persistIssueTableLayout(nextLayout);
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
        (columnId: IssueColumnId, event: ReactDragEvent<HTMLDivElement>) => {
            setDraggedColumnId(columnId);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", columnId);
        },
        [],
    );

    const handleColumnDrop = useCallback(
        (targetColumnId: IssueColumnId, event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const sourceColumnId =
                draggedColumnId ??
                parseIssueColumnId(event.dataTransfer.getData("text/plain"));
            setDraggedColumnId(null);
            if (!sourceColumnId || sourceColumnId === targetColumnId) {
                return;
            }

            persistTableLayout({
                ...tableLayout,
                order: moveIssueColumn(
                    tableLayout.order,
                    sourceColumnId,
                    targetColumnId,
                ),
            });
        },
        [draggedColumnId, persistTableLayout, tableLayout],
    );

    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            const cachedIssues =
                useGitHubStore.getState().issuesByRepoAndState[repoKey]?.[
                    requiredIssueListState
                ];
            if (cachedIssues !== undefined) {
                return;
            }

            const status =
                useGitHubStore.getState().authStatusByHost[tab.ref.host] ??
                (await refreshAuthStatus(tab.ref));
            if (!cancelled && status.state === "authenticated") {
                await refreshIssues(tab.ref, {
                    state: requiredIssueListState,
                });
            }
        }

        void loadInitialData();

        return () => {
            cancelled = true;
        };
    }, [
        refreshAuthStatus,
        refreshIssues,
        repoKey,
        requiredIssueListState,
        tab.ref,
    ]);

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
    const handleOpenIssue = useCallback(
        (issueNumber: number) =>
            void openGitHubIssueTab({
                issueNumber,
                projectId: tab.projectId,
                ref: tab.ref,
                worktreeId: tab.worktreeId ?? null,
            }),
        [openGitHubIssueTab, tab.projectId, tab.ref, tab.worktreeId],
    );
    const renderIssueRow = useCallback(
        (issue: GitHubIssueSummary) => (
            <IssueTableRow
                issue={issue}
                onOpenIssue={handleOpenIssue}
                tableLayout={tableLayout}
            />
        ),
        [handleOpenIssue, tableLayout],
    );

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
            scrollScope={{
                entityId: repoKey,
                projectId: tab.projectId,
                surface: "github_issues",
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
                                        setNewTitle(
                                            event.currentTarget.value,
                                        )
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
                                        setNewLabels(
                                            event.currentTarget.value,
                                        )
                                    }
                                    placeholder="Labels, comma separated"
                                    value={newLabels}
                                />
                                <div className="mt-3">
                                    <GitHubDraftPreview
                                        body={newBody}
                                        collapsible
                                        defaultExpanded={false}
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
                            <GitHubEmptyState>
                                No issues match this view.
                            </GitHubEmptyState>
                        ) : null}
                    </div>
                    {!isLoading && visibleIssues.length > 0 ? (
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
                                    <IssueHeaderCell
                                        columnId={columnId}
                                        dragged={
                                            draggedColumnId === columnId
                                        }
                                        key={columnId}
                                        label={
                                            ISSUE_TABLE_COLUMN_LABELS[columnId]
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
                                    estimateIssueTableRowHeight
                                }
                                getRowKey={(issue) => String(issue.id)}
                                gridTemplateColumns={tableGridTemplate}
                                items={visibleIssues}
                                minWidth={tableMinWidth}
                                renderRow={renderIssueRow}
                                scrollContainerRef={scrollContainerRef}
                                threshold={
                                    GITHUB_ISSUES_VIRTUALIZATION_THRESHOLD
                                }
                            />
                        </div>
                    ) : null}
                </>
            )}
        </GitHubTabShell>
    );
}

function IssueTableRow({
    className,
    issue,
    onOpenIssue,
    style,
    tableLayout,
}: {
    readonly className?: string;
    readonly issue: GitHubIssueSummary;
    readonly onOpenIssue: (issueNumber: number) => void;
    readonly style?: CSSProperties;
    readonly tableLayout: IssueTableLayout;
}) {
    const handleOpenIssue = () => {
        onOpenIssue(issue.number);
    };

    return (
        <div
            className={[
                "group/row w-full items-stretch overflow-hidden border-l-[3px] border-l-transparent pl-2.5 pr-3 text-left text-[11px] text-text-secondary transition-[color,background-color,border-color] duration-120 hover:border-l-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:bg-bg-secondary hover:text-text-primary",
                className,
            ]
                .filter(Boolean)
                .join(" ")}
            style={{
                ...style,
                height: ISSUE_TABLE_ROW_HEIGHT,
            }}
        >
            {tableLayout.order.map((columnId) => (
                <IssueTableCell
                    columnId={columnId}
                    issue={issue}
                    key={columnId}
                    onOpen={handleOpenIssue}
                />
            ))}
        </div>
    );
}

function IssueHeaderCell({
    columnId,
    dragged,
    label,
    onDragEnd,
    onDragOver,
    onDragStart,
    onDrop,
    onResizePointerDown,
}: {
    readonly columnId: IssueColumnId;
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

function IssueTableCell({
    columnId,
    issue,
    onOpen,
}: {
    readonly columnId: IssueColumnId;
    readonly issue: GitHubIssueSummary;
    readonly onOpen: () => void;
}) {
    if (columnId === "action") {
        return (
            <div className="flex min-w-0 items-center justify-end border-b border-border-subtle py-1.5">
                <IdeActionButton onClick={() => openGitHubWebUrl(issue.url)}>
                    Open in GitHub
                </IdeActionButton>
            </div>
        );
    }

    return (
        <button
            className="min-w-0 overflow-hidden border-b border-border-subtle py-1.5 pr-3 text-left"
            onClick={onOpen}
            type="button"
        >
            {renderIssueColumnContent({ columnId, issue })}
        </button>
    );
}

function renderIssueColumnContent({
    columnId,
    issue,
}: {
    readonly columnId: Exclude<IssueColumnId, "action">;
    readonly issue: GitHubIssueSummary;
}) {
    if (columnId === "number") {
        return (
            <div className="truncate font-mono text-text-secondary">
                #{issue.number}
            </div>
        );
    }

    if (columnId === "assignees") {
        return (
            <div className="flex min-w-0 items-center">
                <GitHubUsers users={issue.assignees} />
            </div>
        );
    }

    if (columnId === "date") {
        return (
            <div className="min-w-0 text-[11px] leading-4 text-text-secondary">
                <div>{issue.commentCount} comments</div>
                <div className="mt-0.5">
                    {formatGitHubRelativeTime(issue.updatedAt)}
                </div>
            </div>
        );
    }

    return (
        <div className="min-w-0 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <GitHubStatePill tone={issue.state}>
                    {issue.state}
                </GitHubStatePill>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                    {issue.title}
                </span>
            </div>
            {issue.labels.length > 0 ? (
                <div className="mt-0.5 flex min-w-0 gap-1 overflow-hidden">
                    {issue.labels.slice(0, 4).map((label) => (
                        <GitHubLabelPill key={label.id} label={label} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function clampWidth(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function createDefaultIssueTableLayout(): IssueTableLayout {
    return {
        order: DEFAULT_ISSUE_TABLE_COLUMN_ORDER,
        widths: DEFAULT_ISSUE_TABLE_COLUMN_WIDTHS,
    };
}

function readPersistedIssueTableLayout(): IssueTableLayout {
    const storage = getStorage();
    if (!storage) {
        return createDefaultIssueTableLayout();
    }

    const rawValue = storage.getItem(ISSUE_TABLE_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
        return createDefaultIssueTableLayout();
    }

    try {
        return normalizeIssueTableLayout(JSON.parse(rawValue));
    } catch {
        return createDefaultIssueTableLayout();
    }
}

function persistIssueTableLayout(layout: IssueTableLayout): void {
    const storage = getStorage();
    if (!storage) {
        return;
    }

    storage.setItem(
        ISSUE_TABLE_LAYOUT_STORAGE_KEY,
        JSON.stringify({
            ...layout,
            updatedAt: Date.now(),
            version: ISSUE_TABLE_LAYOUT_VERSION,
        }),
    );
}

function normalizeIssueTableLayout(raw: unknown): IssueTableLayout {
    if (!raw || typeof raw !== "object") {
        return createDefaultIssueTableLayout();
    }

    const version = (raw as { version?: unknown }).version;
    const rawOrder = (raw as { order?: unknown }).order;
    const rawWidths = (raw as { widths?: unknown }).widths;
    if (version !== ISSUE_TABLE_LAYOUT_VERSION || !Array.isArray(rawOrder)) {
        return createDefaultIssueTableLayout();
    }

    const order = normalizeIssueColumnOrder(rawOrder);
    const widths = { ...DEFAULT_ISSUE_TABLE_COLUMN_WIDTHS };
    if (rawWidths && typeof rawWidths === "object") {
        for (const columnId of ISSUE_TABLE_COLUMN_IDS) {
            const width = (rawWidths as Record<string, unknown>)[columnId];
            if (typeof width !== "number" || !Number.isFinite(width)) {
                continue;
            }

            widths[columnId] = Math.round(
                clampWidth(
                    width,
                    ISSUE_TABLE_COLUMN_MIN_WIDTHS[columnId],
                    ISSUE_TABLE_COLUMN_MAX_WIDTH,
                ),
            );
        }
    }

    return { order, widths };
}

function normalizeIssueColumnOrder(
    rawOrder: readonly unknown[],
): readonly IssueColumnId[] {
    const seen = new Set<IssueColumnId>();
    const order: IssueColumnId[] = [];
    for (const item of rawOrder) {
        const columnId = parseIssueColumnId(item);
        if (!columnId || seen.has(columnId)) {
            continue;
        }

        seen.add(columnId);
        order.push(columnId);
    }

    for (const columnId of DEFAULT_ISSUE_TABLE_COLUMN_ORDER) {
        if (!seen.has(columnId)) {
            order.push(columnId);
        }
    }

    return order;
}

function parseIssueColumnId(value: unknown): IssueColumnId | null {
    return typeof value === "string" &&
        (ISSUE_TABLE_COLUMN_IDS as readonly string[]).includes(value)
        ? (value as IssueColumnId)
        : null;
}

function moveIssueColumn(
    order: readonly IssueColumnId[],
    sourceColumnId: IssueColumnId,
    targetColumnId: IssueColumnId,
): readonly IssueColumnId[] {
    const nextOrder = order.filter((columnId) => columnId !== sourceColumnId);
    const targetIndex = nextOrder.indexOf(targetColumnId);
    if (targetIndex < 0) {
        return order;
    }

    nextOrder.splice(targetIndex, 0, sourceColumnId);
    return nextOrder;
}

function estimateIssueTableRowHeight(): number {
    return ISSUE_TABLE_ROW_HEIGHT;
}

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

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
