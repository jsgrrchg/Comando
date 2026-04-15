import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";

import type { GitCommitDetail, GitHistoryCommitSummary } from "@shared/ipc";

import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import {
    buildGitHistoryGraphRows,
    formatGitCommitDateTime,
    formatGitHistoryDate,
    getRefPillStyle,
} from "@renderer/app/git/history-presentation";
import { summarizeGitRepository } from "@renderer/app/git/presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitTab } from "@renderer/app/workspace/tree";
import {
    GitActionButton,
    GitAuthorAvatar,
    GitEmptyState,
} from "@renderer/components/git";

const GRAPH_COLORS = [
    "var(--color-accent)",
    "#8db7ff",
    "#7fd1b9",
    "#f2c56f",
    "#d9a6ff",
    "#f39aa6",
    "#98d686",
] as const;
const EMPTY_HISTORY: readonly GitHistoryCommitSummary[] = [];
const DEFAULT_GIT_HISTORY_COLUMN_WIDTHS = {
    author: 132,
    commit: 92,
    date: 88,
    description: 320,
} as const;

type GitHistoryColumnKey =
    | "author"
    | "commit"
    | "date"
    | "description"
    | "graph";

type GitHistoryColumnWidths = Record<GitHistoryColumnKey, number>;

function getContextKey(projectId: string, worktreeId: string | null): string {
    return `${projectId}::${worktreeId ?? "primary"}`;
}

export function GitTabView({ tab }: { readonly tab: RuntimeWorkspaceGitTab }) {
    const [searchDraft, setSearchDraft] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [isCaseSensitive, setIsCaseSensitive] = useState(false);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const projects = useProjectsStore((state) => state.projects);
    const snapshots = useGitStore((state) => state.snapshots);
    const historyByContext = useGitStore((state) => state.historyByContext);
    const commitDetailsByContext = useGitStore(
        (state) => state.commitDetailsByContext,
    );
    const errors = useGitStore((state) => state.errors);
    const loadingContexts = useGitStore((state) => state.loadingContexts);
    const loadingHistoryContexts = useGitStore(
        (state) => state.loadingHistoryContexts,
    );
    const loadingCommitShas = useGitStore((state) => state.loadingCommitShas);
    const selectedCommitShas = useGitStore((state) => state.selectedCommitShas);
    const refreshProject = useGitStore((state) => state.refreshProject);
    const refreshHistory = useGitStore((state) => state.refreshHistory);
    const ensureCommitDetail = useGitStore((state) => state.ensureCommitDetail);
    const selectCommit = useGitStore((state) => state.selectCommit);
    const fetchRepository = useGitStore((state) => state.fetchRepository);
    const pullRepository = useGitStore((state) => state.pullRepository);
    const pushRepository = useGitStore((state) => state.pushRepository);
    const openGitCommitTab = useWorkspaceStore(
        (state) => state.openGitCommitTab,
    );

    const projectId = tab.projectId;
    const worktreeId = tab.worktreeId ?? null;
    const contextKey = projectId ? getContextKey(projectId, worktreeId) : null;
    const project = projectId
        ? (projects.find((candidate) => candidate.id === projectId) ?? null)
        : null;
    const snapshot = contextKey ? (snapshots[contextKey] ?? null) : null;
    const history = contextKey
        ? (historyByContext[contextKey] ?? EMPTY_HISTORY)
        : EMPTY_HISTORY;
    const error = contextKey ? (errors[contextKey] ?? null) : null;
    const isLoading = contextKey
        ? (loadingContexts[contextKey] ?? false)
        : false;
    const isHistoryLoading = contextKey
        ? (loadingHistoryContexts[contextKey] ?? false)
        : false;
    const rawSelectedCommitSha = contextKey
        ? selectedCommitShas[contextKey]
        : undefined;
    const summary = useMemo(
        () => summarizeGitRepository(project, snapshot),
        [project, snapshot],
    );

    useEffect(() => {
        if (!projectId || snapshot) {
            return;
        }

        void refreshProject(projectId, worktreeId);
    }, [projectId, refreshProject, snapshot, worktreeId]);

    useEffect(() => {
        if (!projectId || history.length > 0 || isHistoryLoading) {
            return;
        }

        void refreshHistory(projectId, worktreeId);
    }, [
        history.length,
        isHistoryLoading,
        projectId,
        refreshHistory,
        worktreeId,
    ]);

    useEffect(() => {
        if (
            !projectId ||
            history.length === 0 ||
            rawSelectedCommitSha !== undefined
        ) {
            return;
        }

        void selectCommit(projectId, history[0]?.sha ?? null, worktreeId);
    }, [history, projectId, rawSelectedCommitSha, selectCommit, worktreeId]);

    const graphRows = useMemo(
        () => buildGitHistoryGraphRows(history),
        [history],
    );
    const graphColumnMinWidth = useMemo(() => {
        const maxLaneCount = graphRows.reduce(
            (largest, row) =>
                Math.max(largest, row.topLanes.length, row.bottomLanes.length),
            1,
        );
        return Math.max(80, 22 + maxLaneCount * 14);
    }, [graphRows]);
    const [columnWidths, setColumnWidths] = useState<GitHistoryColumnWidths>(
        () => createGitHistoryColumnWidths(graphColumnMinWidth),
    );
    const resizeCleanupRef = useRef<(() => void) | null>(null);
    const effectiveColumnWidths = useMemo(
        () => coerceGitHistoryColumnWidths(columnWidths, graphColumnMinWidth),
        [columnWidths, graphColumnMinWidth],
    );
    const graphColumnWidth = effectiveColumnWidths.graph;
    const gitHistoryGridTemplate = useMemo(
        () => buildGitHistoryGridTemplate(effectiveColumnWidths),
        [effectiveColumnWidths],
    );
    const gitHistoryTableMinWidth = useMemo(
        () => getGitHistoryTableMinWidth(effectiveColumnWidths),
        [effectiveColumnWidths],
    );

    const matchedCommitShas = useMemo(
        () => findHistoryMatches(history, searchQuery, isCaseSensitive),
        [history, isCaseSensitive, searchQuery],
    );
    const matchedCommitSet = useMemo(
        () => new Set(matchedCommitShas),
        [matchedCommitShas],
    );
    const selectedMatchIndex =
        typeof rawSelectedCommitSha === "string"
            ? matchedCommitShas.findIndex((sha) => sha === rawSelectedCommitSha)
            : -1;

    useEffect(() => {
        return () => {
            resizeCleanupRef.current?.();
        };
    }, []);

    const handleColumnResizePointerDown = useCallback(
        (
            leftKey: GitHistoryColumnKey,
            rightKey: GitHistoryColumnKey,
            event: ReactPointerEvent<HTMLDivElement>,
        ) => {
            event.preventDefault();
            event.stopPropagation();

            resizeCleanupRef.current?.();

            const startX = event.clientX;
            const startLeftWidth = effectiveColumnWidths[leftKey];
            const startRightWidth = effectiveColumnWidths[rightKey];
            const minWidths = getGitHistoryColumnMinWidths(graphColumnMinWidth);
            const previousCursor = document.body.style.cursor;
            const previousUserSelect = document.body.style.userSelect;

            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            const handlePointerMove = (pointerEvent: PointerEvent) => {
                const delta = pointerEvent.clientX - startX;
                const totalWidth = startLeftWidth + startRightWidth;
                const nextLeftWidth = clampWidth(
                    startLeftWidth + delta,
                    minWidths[leftKey],
                    totalWidth - minWidths[rightKey],
                );

                setColumnWidths((currentWidths) => ({
                    ...currentWidths,
                    [leftKey]: Math.round(nextLeftWidth),
                    [rightKey]: Math.round(totalWidth - nextLeftWidth),
                }));
            };

            const cleanup = () => {
                document.body.style.cursor = previousCursor;
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerUp);
                resizeCleanupRef.current = null;
            };

            const handlePointerUp = () => {
                cleanup();
            };

            resizeCleanupRef.current = cleanup;

            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerUp);
        },
        [effectiveColumnWidths, graphColumnMinWidth],
    );

    useEffect(() => {
        if (!projectId) {
            return;
        }

        if (!searchQuery.trim() || matchedCommitShas.length === 0) {
            return;
        }

        const selectedMatch = matchedCommitShas.findIndex(
            (sha) => sha === rawSelectedCommitSha,
        );
        if (selectedMatch < 0) {
            void selectCommit(
                projectId,
                matchedCommitShas[0] ?? null,
                worktreeId,
            );
        }
    }, [
        matchedCommitShas,
        projectId,
        rawSelectedCommitSha,
        searchQuery,
        selectCommit,
        worktreeId,
    ]);

    const activeCommit =
        typeof rawSelectedCommitSha === "string"
            ? (history.find((commit) => commit.sha === rawSelectedCommitSha) ??
              null)
            : null;
    const activeCommitDetail =
        contextKey && activeCommit
            ? (commitDetailsByContext[contextKey]?.[activeCommit.sha] ?? null)
            : null;
    const activeCommitLoading =
        contextKey && activeCommit
            ? (loadingCommitShas[contextKey] ?? []).includes(activeCommit.sha)
            : false;
    const remoteLink = activeCommit
        ? buildGitRemoteCommitLink(snapshot?.remotes ?? [], activeCommit.sha)
        : null;

    useEffect(() => {
        if (!projectId || !activeCommit) {
            return;
        }

        void ensureCommitDetail(projectId, activeCommit.sha, worktreeId);
    }, [activeCommit, ensureCommitDetail, projectId, worktreeId]);

    const selectCommitSha = useCallback(
        (commitSha: string | null) => {
            if (!projectId) {
                return;
            }

            void selectCommit(projectId, commitSha, worktreeId);
        },
        [projectId, selectCommit, worktreeId],
    );

    const openActiveCommit = useCallback(() => {
        if (!activeCommit || !projectId) {
            return;
        }

        void openGitCommitTab({
            commitSha: activeCommit.sha,
            projectId,
            subject: activeCommit.subject,
            worktreeId,
        });
    }, [activeCommit, openGitCommitTab, projectId, worktreeId]);

    const confirmSearch = useCallback(() => {
        setSearchQuery(searchDraft);
    }, [searchDraft]);

    const selectRelativeCommit = useCallback(
        (direction: "next" | "previous") => {
            if (history.length === 0) {
                return;
            }

            const currentIndex =
                typeof rawSelectedCommitSha === "string"
                    ? history.findIndex(
                          (commit) => commit.sha === rawSelectedCommitSha,
                      )
                    : -1;

            const nextIndex =
                direction === "next"
                    ? currentIndex < history.length - 1
                        ? currentIndex + 1
                        : history.length - 1
                    : currentIndex > 0
                      ? currentIndex - 1
                      : 0;

            selectCommitSha(history[nextIndex]?.sha ?? null);
        },
        [history, rawSelectedCommitSha, selectCommitSha],
    );

    const selectSearchMatch = useCallback(
        (direction: "next" | "previous") => {
            if (matchedCommitShas.length === 0 || !projectId) {
                return;
            }

            const currentIndex =
                selectedMatchIndex >= 0 ? selectedMatchIndex : 0;
            const nextIndex =
                direction === "next"
                    ? (currentIndex + 1) % matchedCommitShas.length
                    : (currentIndex - 1 + matchedCommitShas.length) %
                      matchedCommitShas.length;

            void selectCommit(
                projectId,
                matchedCommitShas[nextIndex] ?? null,
                worktreeId,
            );
        },
        [
            matchedCommitShas,
            projectId,
            selectCommit,
            selectedMatchIndex,
            worktreeId,
        ],
    );

    const handleRootKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            const isInput =
                target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
                if (event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    searchInputRef.current?.focus();
                    searchInputRef.current?.select();
                    return;
                }
            }

            if (isInput) {
                return;
            }

            if (event.key === "ArrowDown") {
                event.preventDefault();
                selectRelativeCommit("next");
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                selectRelativeCommit("previous");
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                openActiveCommit();
            }
        },
        [openActiveCommit, selectRelativeCommit],
    );

    if (!projectId) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>
                    Git tabs need an attached project to render repository
                    history.
                </GitEmptyState>
            </div>
        );
    }

    const headerTitle =
        summary?.branchName != null
            ? `${summary.repositoryName ?? "Repository"} / ${summary.branchName}`
            : (summary?.repositoryName ?? project?.name ?? "Git");
    const headerSubtitle = [
        summary?.worktreeName,
        summary?.stateLabel,
        summary?.upstreamName ? `upstream ${summary.upstreamName}` : null,
        summary?.aheadBy ? `+${summary.aheadBy}` : null,
        summary?.behindBy ? `-${summary.behindBy}` : null,
    ]
        .filter(Boolean)
        .join("  ");
    const searchHasNoMatches =
        searchQuery.trim().length > 0 && matchedCommitShas.length === 0;

    return (
        <div
            className="flex h-full min-h-0 flex-col bg-bg-primary"
            onKeyDown={handleRootKeyDown}
            tabIndex={0}
        >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-secondary">
                        Git
                    </p>
                    <p className="truncate text-[13px] font-medium text-text-primary">
                        {headerTitle}
                    </p>
                    {headerSubtitle ? (
                        <p className="truncate text-[11px] text-text-secondary">
                            {headerSubtitle}
                        </p>
                    ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    <GitActionButton
                        action={{
                            disabled: !projectId,
                            id: "fetch",
                            label: "Fetch",
                            onClick: () =>
                                void fetchRepository(projectId, worktreeId),
                        }}
                    />
                    <GitActionButton
                        action={{
                            disabled: !projectId,
                            id: "pull",
                            label: "Pull",
                            onClick: () =>
                                void pullRepository(projectId, worktreeId),
                        }}
                    />
                    <GitActionButton
                        action={{
                            disabled: !projectId,
                            id: "push",
                            label: "Push",
                            onClick: () =>
                                void pushRepository(projectId, worktreeId),
                        }}
                    />
                </div>
            </header>

            {error ? (
                <div className="border-b border-border px-4 py-2 text-[11px] text-red-600 dark:text-red-300">
                    {error}
                </div>
            ) : null}

            <div className="border-b border-border px-4 py-2">
                <div className="flex items-center gap-2">
                    <div
                        className={[
                            "project-switcher-search mb-0 flex-1",
                            searchHasNoMatches ? "border-red-500/45" : "",
                        ].join(" ")}
                    >
                        <svg
                            fill="none"
                            height="12"
                            style={{ opacity: 0.4, flexShrink: 0 }}
                            viewBox="0 0 16 16"
                            width="12"
                        >
                            <circle
                                cx="7"
                                cy="7"
                                r="5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            />
                            <path
                                d="m13 13-2.5-2.5"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeWidth="1.5"
                            />
                        </svg>
                        <input
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="project-switcher-search-input"
                            onChange={(event) =>
                                setSearchDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    confirmSearch();
                                }
                            }}
                            placeholder="Search commits..."
                            ref={searchInputRef}
                            spellCheck={false}
                            value={searchDraft}
                        />
                        <button
                            className={[
                                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                                isCaseSensitive
                                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-elevated))] text-text-primary"
                                    : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary",
                            ].join(" ")}
                            onClick={() =>
                                setIsCaseSensitive((current) => !current)
                            }
                            type="button"
                        >
                            Aa
                        </button>
                    </div>

                    <button
                        className="ide-button px-2 py-1"
                        disabled={matchedCommitShas.length === 0}
                        onClick={() => selectSearchMatch("previous")}
                        type="button"
                    >
                        {"<"}
                    </button>
                    <button
                        className="ide-button px-2 py-1"
                        disabled={matchedCommitShas.length === 0}
                        onClick={() => selectSearchMatch("next")}
                        type="button"
                    >
                        {">"}
                    </button>
                    <span className="min-w-12 text-right font-mono text-[11px] text-text-secondary">
                        {selectedMatchIndex >= 0 && matchedCommitShas.length > 0
                            ? `${selectedMatchIndex + 1}/${matchedCommitShas.length}`
                            : `0/${matchedCommitShas.length}`}
                    </span>
                </div>
            </div>

            <div className="flex min-h-0 flex-1">
                <section className="min-h-0 flex-[1.6] overflow-hidden border-r border-border">
                    <div className="shell-scrollbar h-full overflow-auto">
                        <div
                            className="sticky top-0 z-10 grid border-b border-border bg-bg-primary px-3 py-2 text-[11px] text-text-secondary"
                            style={{
                                gridTemplateColumns: gitHistoryGridTemplate,
                                minWidth: gitHistoryTableMinWidth,
                            }}
                        >
                            <GitHistoryHeaderCell
                                label="Graph"
                                onResizePointerDown={(event) =>
                                    handleColumnResizePointerDown(
                                        "graph",
                                        "description",
                                        event,
                                    )
                                }
                            />
                            <GitHistoryHeaderCell
                                label="Description"
                                onResizePointerDown={(event) =>
                                    handleColumnResizePointerDown(
                                        "description",
                                        "date",
                                        event,
                                    )
                                }
                            />
                            <GitHistoryHeaderCell
                                label="Date"
                                onResizePointerDown={(event) =>
                                    handleColumnResizePointerDown(
                                        "date",
                                        "author",
                                        event,
                                    )
                                }
                            />
                            <GitHistoryHeaderCell
                                label="Author"
                                onResizePointerDown={(event) =>
                                    handleColumnResizePointerDown(
                                        "author",
                                        "commit",
                                        event,
                                    )
                                }
                            />
                            <GitHistoryHeaderCell label="Commit" />
                        </div>

                        {graphRows.length === 0 ? (
                            <div className="flex h-full items-center justify-center px-6">
                                <GitEmptyState>
                                    {isHistoryLoading || isLoading
                                        ? "Loading commit history..."
                                        : "No git history is available for this workspace."}
                                </GitEmptyState>
                            </div>
                        ) : (
                            graphRows.map((row) => (
                                <button
                                    className={[
                                        "grid w-full items-stretch px-3 text-left text-[12px] transition-colors",
                                        activeCommit?.sha === row.commit.sha
                                            ? "bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-primary))] text-text-primary"
                                            : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary",
                                    ].join(" ")}
                                    key={row.commit.sha}
                                    onClick={() => {
                                        selectCommitSha(row.commit.sha);
                                    }}
                                    style={{
                                        gridTemplateColumns:
                                            gitHistoryGridTemplate,
                                        minWidth: gitHistoryTableMinWidth,
                                    }}
                                    type="button"
                                >
                                    <GitHistoryGraphCell
                                        bottomLanes={row.bottomLanes}
                                        colorId={row.colorId}
                                        graphWidth={graphColumnWidth}
                                        laneIndex={row.laneIndex}
                                        parentColumns={row.parentColumns}
                                        topLanes={row.topLanes}
                                    />

                                    <div className="min-w-0 border-b border-border-subtle py-2.5 pr-4">
                                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                            {row.commit.refs.map(
                                                (reference) => (
                                                    <GitReferencePill
                                                        key={`${row.commit.sha}:${reference.label}`}
                                                        kind={reference.kind}
                                                        label={reference.label}
                                                    />
                                                ),
                                            )}
                                        </div>
                                        <div className="truncate text-[12px] text-text-primary">
                                            {renderHighlightedText(
                                                row.commit.subject,
                                                searchQuery,
                                                isCaseSensitive,
                                                matchedCommitSet.has(
                                                    row.commit.sha,
                                                ),
                                            )}
                                        </div>
                                    </div>

                                    <div className="min-w-0 border-b border-border-subtle py-2.5 pr-3 text-[11px]">
                                        {formatGitHistoryDate(
                                            row.commit.authoredAt,
                                        )}
                                    </div>

                                    <div className="min-w-0 truncate border-b border-border-subtle py-2.5 pr-3 text-[11px]">
                                        {row.commit.authorName}
                                    </div>

                                    <div
                                        className="min-w-0 truncate border-b border-border-subtle py-2.5 font-mono text-[11px]"
                                        title={row.commit.sha}
                                    >
                                        {row.commit.shortSha}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </section>

                <aside className="shell-scrollbar min-h-0 flex-1 overflow-y-auto">
                    <GitCommitDetailSidebar
                        commit={activeCommit}
                        detail={activeCommitDetail}
                        isLoading={activeCommitLoading}
                        onClearSelection={() => selectCommitSha(null)}
                        onOpenCommit={openActiveCommit}
                        remoteLink={remoteLink}
                    />
                </aside>
            </div>
        </div>
    );
}

function GitCommitDetailSidebar({
    commit,
    detail,
    isLoading,
    onClearSelection,
    onOpenCommit,
    remoteLink,
}: {
    readonly commit: GitHistoryCommitSummary | null;
    readonly detail: GitCommitDetail | null;
    readonly isLoading: boolean;
    readonly onClearSelection: () => void;
    readonly onOpenCommit: () => void;
    readonly remoteLink: ReturnType<typeof buildGitRemoteCommitLink>;
}) {
    if (!commit) {
        return (
            <div className="flex h-full items-center justify-center px-6">
                <GitEmptyState>Select a commit to inspect it.</GitEmptyState>
            </div>
        );
    }

    const activeDetail = detail ?? null;
    const changedFiles = [...(activeDetail?.files ?? [])].sort(
        (left, right) =>
            left.kind.localeCompare(right.kind) ||
            left.path.localeCompare(right.path),
    );

    return (
        <div className="flex min-h-full flex-col">
            <div className="border-b border-border px-5 py-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                        <GitAuthorAvatar
                            email={commit.authorEmail}
                            name={commit.authorName}
                            size={44}
                        />
                        <div className="min-w-0 flex-1">
                            <div className="text-[14px] font-medium text-text-primary">
                                {commit.authorName}
                            </div>
                            <div className="mt-1 text-[11px] text-text-secondary">
                                {formatGitCommitDateTime(commit.authoredAt)}
                            </div>
                        </div>
                    </div>

                    <button
                        className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        onClick={onClearSelection}
                        type="button"
                    >
                        x
                    </button>
                </div>

                <div className="space-y-2 text-[11px]">
                    <button
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        onClick={() => void copyToClipboard(commit.authorEmail)}
                        type="button"
                    >
                        <span className="shrink-0">@</span>
                        <span className="truncate">{commit.authorEmail}</span>
                    </button>
                    <button
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        onClick={() => void copyToClipboard(commit.sha)}
                        type="button"
                    >
                        <span className="shrink-0">#</span>
                        <span className="truncate font-mono">{commit.sha}</span>
                    </button>
                    {remoteLink ? (
                        <button
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                            onClick={() =>
                                window.open(remoteLink.url, "_blank")
                            }
                            type="button"
                        >
                            <span className="shrink-0">{"->"}</span>
                            <span className="truncate">{remoteLink.label}</span>
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="border-b border-border px-5 py-4">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {commit.refs.map((reference) => (
                        <GitReferencePill
                            key={`${commit.sha}:${reference.label}`}
                            kind={reference.kind}
                            label={reference.label}
                        />
                    ))}
                </div>
                <div className="text-[18px] leading-7 text-text-primary">
                    {commit.subject}
                </div>
                {commit.body ? (
                    <pre className="mt-3 whitespace-pre-wrap font-sans text-[12px] leading-6 text-text-secondary">
                        {commit.body}
                    </pre>
                ) : null}
            </div>

            <div className="border-b border-border px-5 py-3">
                <div className="flex items-center justify-between gap-3 text-[11px] text-text-secondary">
                    {activeDetail ? (
                        <span className="flex items-center gap-1.5 truncate">
                            <span>
                                {activeDetail.changedFileCount}{" "}
                                {activeDetail.changedFileCount === 1
                                    ? "file"
                                    : "files"}
                            </span>
                            {activeDetail.insertions > 0 ? (
                                <span style={{ color: "var(--diff-add)" }}>
                                    +{activeDetail.insertions}
                                </span>
                            ) : null}
                            {activeDetail.deletions > 0 ? (
                                <span style={{ color: "var(--diff-remove)" }}>
                                    -{activeDetail.deletions}
                                </span>
                            ) : null}
                        </span>
                    ) : null}
                    <span className="shrink-0 font-mono" title={commit.sha}>
                        {commit.shortSha}
                    </span>
                </div>
            </div>

            <div className="flex-1 px-5 py-4">
                {isLoading && !activeDetail ? (
                    <GitEmptyState>Loading commit details...</GitEmptyState>
                ) : (
                    <>
                        {changedFiles.length > 0 ? (
                            <div className="mb-4 space-y-1">
                                <div className="mb-2 flex items-center gap-2 text-[11px] text-text-secondary">
                                    <span>
                                        {changedFiles.length} Changed Files
                                    </span>
                                    {activeDetail &&
                                    activeDetail.insertions > 0 ? (
                                        <span
                                            style={{ color: "var(--diff-add)" }}
                                        >
                                            +{activeDetail.insertions}
                                        </span>
                                    ) : null}
                                    {activeDetail &&
                                    activeDetail.deletions > 0 ? (
                                        <span
                                            style={{
                                                color: "var(--diff-remove)",
                                            }}
                                        >
                                            -{activeDetail.deletions}
                                        </span>
                                    ) : null}
                                </div>

                                {changedFiles.map((file) => (
                                    <div
                                        className="flex items-center justify-between gap-3 text-[11px]"
                                        key={`${commit.sha}:${file.path}`}
                                    >
                                        <div className="min-w-0 truncate font-mono text-text-primary">
                                            {file.path}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5 text-text-secondary">
                                            {file.additions ? (
                                                <span
                                                    style={{
                                                        color: "var(--diff-add)",
                                                    }}
                                                >
                                                    +{file.additions}
                                                </span>
                                            ) : null}
                                            {file.deletions ? (
                                                <span
                                                    style={{
                                                        color: "var(--diff-remove)",
                                                    }}
                                                >
                                                    -{file.deletions}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        <button
                            className="ide-button w-full"
                            onClick={onOpenCommit}
                            type="button"
                        >
                            View Commit
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function GitHistoryHeaderCell({
    label,
    onResizePointerDown,
}: {
    readonly label: string;
    readonly onResizePointerDown?:
        | ((event: ReactPointerEvent<HTMLDivElement>) => void)
        | undefined;
}) {
    return (
        <div className="relative min-w-0 pr-3">
            <span className="block truncate">{label}</span>
            {onResizePointerDown ? (
                <div
                    aria-label={`Resize ${label} column`}
                    className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none"
                    onPointerDown={onResizePointerDown}
                    role="separator"
                >
                    <div className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-border-strong" />
                </div>
            ) : null}
        </div>
    );
}

function GitHistoryGraphCell({
    bottomLanes,
    colorId,
    graphWidth,
    laneIndex,
    parentColumns,
    topLanes,
}: {
    readonly bottomLanes: readonly number[];
    readonly colorId: number;
    readonly graphWidth: number;
    readonly laneIndex: number;
    readonly parentColumns: readonly number[];
    readonly topLanes: readonly number[];
}) {
    const laneCount = Math.max(topLanes.length, bottomLanes.length, 1);
    const laneXs = Array.from(
        { length: laneCount },
        (_, index) => 16 + index * 14,
    );
    const currentX = laneXs[laneIndex] ?? laneXs.at(-1) ?? 16;
    const rowHeight = 32;
    const middleY = rowHeight / 2;

    return (
        <div
            className="border-b border-border-subtle py-1 pr-2"
            style={{ width: graphWidth }}
        >
            <svg
                aria-hidden="true"
                height={rowHeight}
                viewBox={`0 0 ${graphWidth} ${rowHeight}`}
                width={graphWidth}
            >
                {topLanes.map((laneColorId, index) => {
                    const x = laneXs[index] ?? 16;
                    return (
                        <line
                            key={`top:${laneColorId}:${index}`}
                            stroke={getGraphColor(laneColorId)}
                            strokeLinecap="round"
                            strokeWidth="1.6"
                            x1={x}
                            x2={x}
                            y1={0}
                            y2={middleY}
                        />
                    );
                })}

                {bottomLanes.map((laneColorId, index) => {
                    const x = laneXs[index] ?? 16;
                    return (
                        <line
                            key={`bottom:${laneColorId}:${index}`}
                            stroke={getGraphColor(laneColorId)}
                            strokeLinecap="round"
                            strokeWidth="1.6"
                            x1={x}
                            x2={x}
                            y1={middleY}
                            y2={rowHeight}
                        />
                    );
                })}

                {parentColumns.map((column, index) => {
                    const targetX = laneXs[column] ?? currentX;
                    if (targetX === currentX) {
                        return null;
                    }

                    return (
                        <path
                            d={`M ${currentX} ${middleY} C ${currentX} ${middleY + 5} ${targetX} ${middleY + 5} ${targetX} ${rowHeight}`}
                            fill="none"
                            key={`edge:${column}:${index}`}
                            stroke={getGraphColor(
                                bottomLanes[column] ?? colorId,
                            )}
                            strokeLinecap="round"
                            strokeWidth="1.6"
                        />
                    );
                })}

                <circle
                    cx={currentX}
                    cy={middleY}
                    fill={getGraphColor(colorId)}
                    r="3.6"
                    stroke="var(--color-bg-primary)"
                    strokeWidth="1.4"
                />
            </svg>
        </div>
    );
}

function GitReferencePill({
    kind,
    label,
}: {
    readonly kind: string;
    readonly label: string;
}) {
    const tone = getRefPillStyle(kind);

    return (
        <span
            className={[
                "inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
                tone.className,
            ].join(" ")}
            style={tone.style}
        >
            {label}
        </span>
    );
}

function getGraphColor(colorId: number): string {
    return GRAPH_COLORS[colorId % GRAPH_COLORS.length] ?? GRAPH_COLORS[0];
}

function createGitHistoryColumnWidths(
    graphColumnMinWidth: number,
): GitHistoryColumnWidths {
    return {
        author: DEFAULT_GIT_HISTORY_COLUMN_WIDTHS.author,
        commit: DEFAULT_GIT_HISTORY_COLUMN_WIDTHS.commit,
        date: DEFAULT_GIT_HISTORY_COLUMN_WIDTHS.date,
        description: DEFAULT_GIT_HISTORY_COLUMN_WIDTHS.description,
        graph: graphColumnMinWidth,
    };
}

function getGitHistoryColumnMinWidths(
    graphColumnMinWidth: number,
): GitHistoryColumnWidths {
    return {
        author: 108,
        commit: 84,
        date: 72,
        description: 180,
        graph: graphColumnMinWidth,
    };
}

function coerceGitHistoryColumnWidths(
    widths: GitHistoryColumnWidths,
    graphColumnMinWidth: number,
): GitHistoryColumnWidths {
    const minWidths = getGitHistoryColumnMinWidths(graphColumnMinWidth);

    return {
        author: Math.max(widths.author, minWidths.author),
        commit: Math.max(widths.commit, minWidths.commit),
        date: Math.max(widths.date, minWidths.date),
        description: Math.max(widths.description, minWidths.description),
        graph: Math.max(widths.graph, minWidths.graph),
    };
}

function buildGitHistoryGridTemplate(widths: GitHistoryColumnWidths): string {
    return [
        widths.graph,
        widths.description,
        widths.date,
        widths.author,
        widths.commit,
    ]
        .map((width) => `${width}px`)
        .join(" ");
}

function getGitHistoryTableMinWidth(widths: GitHistoryColumnWidths): number {
    return (
        widths.graph +
        widths.description +
        widths.date +
        widths.author +
        widths.commit
    );
}

function clampWidth(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function findHistoryMatches(
    commits: readonly GitHistoryCommitSummary[],
    query: string,
    caseSensitive: boolean,
): readonly string[] {
    const normalizedQuery = caseSensitive
        ? query.trim()
        : query.trim().toLowerCase();
    if (!normalizedQuery) {
        return [];
    }

    return commits
        .filter((commit) => {
            const haystack = [
                commit.sha,
                commit.shortSha,
                commit.subject,
                commit.body,
                commit.authorName,
                commit.authorEmail,
                ...commit.refs.map((reference) => reference.label),
            ].join("\n");
            const text = caseSensitive ? haystack : haystack.toLowerCase();
            return text.includes(normalizedQuery);
        })
        .map((commit) => commit.sha);
}

function renderHighlightedText(
    text: string,
    query: string,
    caseSensitive: boolean,
    isMatched: boolean,
): ReactNode {
    const normalizedQuery = caseSensitive
        ? query.trim()
        : query.trim().toLowerCase();
    if (!isMatched || !normalizedQuery) {
        return text;
    }

    const source = caseSensitive ? text : text.toLowerCase();
    const parts: ReactNode[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const index = source.indexOf(normalizedQuery, cursor);
        if (index < 0) {
            parts.push(text.slice(cursor));
            break;
        }

        if (index > cursor) {
            parts.push(text.slice(cursor, index));
        }

        parts.push(
            <span
                className="rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-text-primary"
                key={`${index}:${normalizedQuery.length}`}
            >
                {text.slice(index, index + normalizedQuery.length)}
            </span>,
        );
        cursor = index + normalizedQuery.length;
    }

    return parts;
}

async function copyToClipboard(value: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(value);
    } catch (error) {
        console.error(error);
    }
}
