import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";

import type { GitCommitDetail, GitHistoryCommitSummary } from "@shared/ipc";

import {
    buildCheckoutPath,
    buildMergePath,
    COMMIT_RADIUS,
    COMMIT_STROKE,
    computeGraphWidth,
    laneX,
    LINE_WIDTH,
} from "@renderer/app/git/graph-lines";
import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import {
    buildGitHistoryGraphRows,
    formatGitCommitDateTime,
    formatGitHistoryDate,
    getRefPillStyle,
    getTemporalGroupLabel,
} from "@renderer/app/git/history-presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitTab } from "@renderer/app/workspace/tree";
import { GitAuthorAvatar, GitEmptyState } from "@renderer/components/git";

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
const EMPTY_LOADING_SHAS: readonly string[] = [];
const DEFAULT_GIT_HISTORY_COLUMN_WIDTHS = {
    author: 132,
    commit: 92,
    date: 88,
    description: 320,
} as const;
const DEFAULT_GIT_DETAIL_SIDEBAR_WIDTH = 280;
const MIN_GIT_DETAIL_SIDEBAR_WIDTH = 280;
const MIN_GIT_HISTORY_PANE_WIDTH = 420;

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
    const [detailSidebarWidth, setDetailSidebarWidth] = useState(
        DEFAULT_GIT_DETAIL_SIDEBAR_WIDTH,
    );
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const splitContainerRef = useRef<HTMLDivElement | null>(null);

    const projectId = tab.projectId;
    const worktreeId = tab.worktreeId ?? null;
    const contextKey = projectId ? getContextKey(projectId, worktreeId) : null;

    const snapshot = useGitStore((state) =>
        contextKey ? (state.snapshots[contextKey] ?? null) : null,
    );
    const history = useGitStore((state) =>
        contextKey
            ? (state.historyByContext[contextKey] ?? EMPTY_HISTORY)
            : EMPTY_HISTORY,
    );
    const error = useGitStore((state) =>
        contextKey ? (state.errors[contextKey] ?? null) : null,
    );
    const isLoading = useGitStore((state) =>
        contextKey ? (state.loadingContexts[contextKey] ?? false) : false,
    );
    const isHistoryLoading = useGitStore((state) =>
        contextKey
            ? (state.loadingHistoryContexts[contextKey] ?? false)
            : false,
    );
    const rawSelectedCommitSha = useGitStore((state) =>
        contextKey ? state.selectedCommitShas[contextKey] : undefined,
    );
    const refreshProject = useGitStore((state) => state.refreshProject);
    const refreshHistory = useGitStore((state) => state.refreshHistory);
    const ensureCommitDetail = useGitStore((state) => state.ensureCommitDetail);
    const selectCommit = useGitStore((state) => state.selectCommit);
    const openGitCommitTab = useWorkspaceStore(
        (state) => state.openGitCommitTab,
    );
    const openFileTab = useWorkspaceStore((state) => state.openFileTab);
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
        return computeGraphWidth(maxLaneCount);
    }, [graphRows]);
    const [columnWidths, setColumnWidths] = useState<GitHistoryColumnWidths>(
        () => createGitHistoryColumnWidths(graphColumnMinWidth),
    );
    const resizeCleanupRef = useRef<(() => void) | null>(null);
    const detailResizeCleanupRef = useRef<(() => void) | null>(null);
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

    const graphWrapperRef = useRef<HTMLDivElement>(null);
    const rowRefsMap = useRef<Map<string, HTMLButtonElement>>(new Map());
    const [rowPositions, setRowPositions] = useState<
        Map<string, { top: number; height: number }>
    >(new Map());

    useLayoutEffect(() => {
        if (!graphWrapperRef.current || graphRows.length === 0) return;
        const next = new Map<string, { top: number; height: number }>();
        for (const [sha, el] of rowRefsMap.current) {
            next.set(sha, { top: el.offsetTop, height: el.offsetHeight });
        }
        setRowPositions(next);
    }, [graphRows]);

    useEffect(() => {
        return () => {
            resizeCleanupRef.current?.();
            detailResizeCleanupRef.current?.();
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
    const activeCommitSha = activeCommit?.sha ?? null;
    const activeCommitDetail = useGitStore((state) =>
        contextKey && activeCommitSha
            ? (state.commitDetailsByContext[contextKey]?.[activeCommitSha] ??
              null)
            : null,
    );
    const activeCommitLoading = useGitStore((state) =>
        contextKey && activeCommitSha
            ? (
                  state.loadingCommitShas[contextKey] ?? EMPTY_LOADING_SHAS
              ).includes(activeCommitSha)
            : false,
    );
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

    const openProjectFile = useCallback(
        (relativePath: string) => {
            if (!projectId) {
                return;
            }

            void openFileTab(projectId, relativePath, worktreeId);
        },
        [openFileTab, projectId, worktreeId],
    );

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

    const handleDetailSidebarResizePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.stopPropagation();

            detailResizeCleanupRef.current?.();

            const startX = event.clientX;
            const startWidth = detailSidebarWidth;
            const previousCursor = document.body.style.cursor;
            const previousUserSelect = document.body.style.userSelect;

            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            const handlePointerMove = (pointerEvent: PointerEvent) => {
                const containerWidth =
                    splitContainerRef.current?.getBoundingClientRect().width ??
                    0;

                if (containerWidth <= 0) {
                    return;
                }

                const delta = pointerEvent.clientX - startX;
                const maxSidebarWidth = Math.max(
                    MIN_GIT_DETAIL_SIDEBAR_WIDTH,
                    containerWidth - MIN_GIT_HISTORY_PANE_WIDTH,
                );

                setDetailSidebarWidth(
                    Math.round(
                        clampWidth(
                            startWidth - delta,
                            MIN_GIT_DETAIL_SIDEBAR_WIDTH,
                            maxSidebarWidth,
                        ),
                    ),
                );
            };

            const cleanup = () => {
                document.body.style.cursor = previousCursor;
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerUp);
                detailResizeCleanupRef.current = null;
            };

            const handlePointerUp = () => {
                cleanup();
            };

            detailResizeCleanupRef.current = cleanup;

            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerUp);
        },
        [detailSidebarWidth],
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

    const searchHasNoMatches =
        searchQuery.trim().length > 0 && matchedCommitShas.length === 0;

    return (
        <div
            className="flex h-full min-h-0 flex-col bg-bg-primary"
            onKeyDown={handleRootKeyDown}
            tabIndex={0}
        >
            {error ? (
                <div
                    className="border-b border-border px-4 py-2 text-[11px]"
                    style={{ color: "var(--diff-remove)" }}
                >
                    {error}
                </div>
            ) : null}

            <div className="border-b border-border px-4 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div
                            className={[
                                "project-switcher-search mb-0 flex-1",
                                searchHasNoMatches
                                    ? "border-[color-mix(in_srgb,var(--diff-remove)_45%,transparent)]"
                                    : "",
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
                            {selectedMatchIndex >= 0 &&
                            matchedCommitShas.length > 0
                                ? `${selectedMatchIndex + 1}/${matchedCommitShas.length}`
                                : `0/${matchedCommitShas.length}`}
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex min-h-0 flex-1" ref={splitContainerRef}>
                <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
                            <div
                                ref={graphWrapperRef}
                                style={{ position: "relative" }}
                            >
                                <GitHistoryGraphSVG
                                    graphRows={graphRows}
                                    graphWidth={graphColumnWidth}
                                    rowPositions={rowPositions}
                                />
                                {graphRows.map((row, rowIndex) => {
                                    const groupLabel = getTemporalGroupLabel(
                                        row.commit.authoredAt,
                                    );
                                    const prevLabel =
                                        rowIndex > 0
                                            ? getTemporalGroupLabel(
                                                  graphRows[rowIndex - 1].commit
                                                      .authoredAt,
                                              )
                                            : null;
                                    const showSeparator =
                                        groupLabel !== prevLabel;

                                    return (
                                        <Fragment key={row.commit.sha}>
                                            {showSeparator && (
                                                <div className="flex items-center justify-center py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                                                    <div className="h-px flex-1 bg-border-subtle" />
                                                    <span className="shrink-0 px-3">
                                                        {groupLabel}
                                                    </span>
                                                    <div className="h-px flex-1 bg-border-subtle" />
                                                </div>
                                            )}
                                            <button
                                                ref={(el) => {
                                                    if (el)
                                                        rowRefsMap.current.set(
                                                            row.commit.sha,
                                                            el,
                                                        );
                                                    else
                                                        rowRefsMap.current.delete(
                                                            row.commit.sha,
                                                        );
                                                }}
                                                className={[
                                                    "group/row grid w-full items-stretch border-l-[3px] border-l-transparent pl-[9px] pr-3 text-left text-[12px] transition-[color,background-color,border-color] duration-120",
                                                    activeCommit?.sha ===
                                                    row.commit.sha
                                                        ? "!border-l-[--row-branch-color] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-primary))] text-text-primary"
                                                        : "text-text-secondary hover:border-l-[--row-branch-color] hover:bg-bg-secondary hover:text-text-primary",
                                                ].join(" ")}
                                                onClick={() => {
                                                    selectCommitSha(
                                                        row.commit.sha,
                                                    );
                                                }}
                                                style={
                                                    {
                                                        gridTemplateColumns:
                                                            gitHistoryGridTemplate,
                                                        minWidth:
                                                            gitHistoryTableMinWidth,
                                                        "--row-branch-color":
                                                            GRAPH_COLORS[
                                                                row.colorId %
                                                                    GRAPH_COLORS.length
                                                            ],
                                                    } as React.CSSProperties
                                                }
                                                type="button"
                                            >
                                                <div
                                                    className="border-b border-border-subtle"
                                                    style={{
                                                        width: graphColumnWidth,
                                                    }}
                                                />

                                                <div className="min-w-0 border-b border-border-subtle py-2.5 pr-4">
                                                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                                        {row.commit.refs.map(
                                                            (reference) => (
                                                                <GitReferencePill
                                                                    key={`${row.commit.sha}:${reference.label}`}
                                                                    kind={
                                                                        reference.kind
                                                                    }
                                                                    label={
                                                                        reference.label
                                                                    }
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

                                                <div className="flex min-w-0 items-center gap-1.5 border-b border-border-subtle py-2.5 pr-3 text-[11px]">
                                                    <GitAuthorAvatar
                                                        email={
                                                            row.commit
                                                                .authorEmail
                                                        }
                                                        name={
                                                            row.commit
                                                                .authorName
                                                        }
                                                        size={20}
                                                    />
                                                    <span className="truncate">
                                                        {row.commit.authorName}
                                                    </span>
                                                </div>

                                                <div className="min-w-0 truncate border-b border-border-subtle py-2.5 font-mono text-[11px]">
                                                    <CopyableHash
                                                        as="span"
                                                        className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-bg-secondary hover:text-text-primary"
                                                        display={
                                                            row.commit.shortSha
                                                        }
                                                        sha={row.commit.sha}
                                                        stopPropagation
                                                    />
                                                </div>
                                            </button>
                                        </Fragment>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

                {activeCommit ? (
                    <>
                        <div
                            aria-label="Resize commit details sidebar"
                            aria-orientation="vertical"
                            className="group relative z-10 flex w-[7px] cursor-col-resize touch-none items-center justify-center bg-transparent"
                            onDoubleClick={() =>
                                setDetailSidebarWidth(
                                    DEFAULT_GIT_DETAIL_SIDEBAR_WIDTH,
                                )
                            }
                            onPointerDown={handleDetailSidebarResizePointerDown}
                            role="separator"
                            title="Drag to resize"
                        >
                            <div className="workspace-divider h-full w-px bg-border transition-colors duration-100 group-hover:bg-accent" />
                        </div>

                        <aside
                            className="shell-scrollbar min-h-0 overflow-y-auto"
                            style={{
                                minWidth: MIN_GIT_DETAIL_SIDEBAR_WIDTH,
                                width: detailSidebarWidth,
                            }}
                        >
                            <GitCommitDetailSidebar
                                commit={activeCommit}
                                detail={activeCommitDetail}
                                isLoading={activeCommitLoading}
                                onClearSelection={() => selectCommitSha(null)}
                                onOpenCommit={openActiveCommit}
                                onOpenFile={openProjectFile}
                                remoteLink={remoteLink}
                            />
                        </aside>
                    </>
                ) : null}
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
    onOpenFile,
    remoteLink,
}: {
    readonly commit: GitHistoryCommitSummary | null;
    readonly detail: GitCommitDetail | null;
    readonly isLoading: boolean;
    readonly onClearSelection: () => void;
    readonly onOpenCommit: () => void;
    readonly onOpenFile: (relativePath: string) => void;
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
                    <CopyableHash
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        display={commit.sha}
                        mono
                        prefix="#"
                        sha={commit.sha}
                    />
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
                    <CopyableHash
                        className="shrink-0 cursor-pointer rounded px-1 py-0.5 font-mono transition-colors hover:bg-bg-secondary hover:text-text-primary"
                        display={commit.shortSha}
                        sha={commit.sha}
                    />
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

                                {changedFiles.map((file) => {
                                    const lastSlash =
                                        file.path.lastIndexOf("/");
                                    const fileName =
                                        lastSlash >= 0
                                            ? file.path.slice(lastSlash + 1)
                                            : file.path;
                                    const dirPath =
                                        lastSlash >= 0
                                            ? file.path.slice(0, lastSlash)
                                            : "";
                                    const canOpenFile = file.kind !== "delete";
                                    const rowContent = (
                                        <>
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span className="shrink-0 font-mono text-text-primary transition-colors duration-150 group-hover/file:text-text-primary">
                                                    {fileName}
                                                </span>
                                                {dirPath ? (
                                                    <span className="truncate text-text-tertiary transition-colors duration-150 group-hover/file:text-text-secondary">
                                                        {dirPath}
                                                    </span>
                                                ) : null}
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
                                        </>
                                    );

                                    if (canOpenFile) {
                                        return (
                                            <button
                                                aria-label={`Open file ${file.path}`}
                                                className="group/file flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_82%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--color-bg-secondary)_82%,transparent)] focus-visible:outline-none"
                                                key={`${commit.sha}:${file.path}`}
                                                onClick={() =>
                                                    onOpenFile(file.path)
                                                }
                                                title={file.path}
                                                type="button"
                                            >
                                                {rowContent}
                                            </button>
                                        );
                                    }

                                    return (
                                        <div
                                            className="group/file flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[11px] opacity-85"
                                            key={`${commit.sha}:${file.path}`}
                                            title={`${file.path} is not available in the current workspace`}
                                        >
                                            {rowContent}
                                        </div>
                                    );
                                })}
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

function GitHistoryGraphSVG({
    graphRows,
    graphWidth,
    rowPositions,
}: {
    readonly graphRows: readonly import("@renderer/app/git/history-presentation").GitHistoryGraphRow[];
    readonly graphWidth: number;
    readonly rowPositions: Map<string, { top: number; height: number }>;
}) {
    if (rowPositions.size === 0) return null;

    const getYCenter = (sha: string): number | null => {
        const pos = rowPositions.get(sha);
        if (!pos) return null;
        return pos.top + pos.height / 2;
    };

    let totalHeight = 0;
    for (const pos of rowPositions.values()) {
        totalHeight = Math.max(totalHeight, pos.top + pos.height);
    }

    const colorPaths = new Map<number, string[]>();
    const addPath = (colorId: number, d: string) => {
        let paths = colorPaths.get(colorId);
        if (!paths) {
            paths = [];
            colorPaths.set(colorId, paths);
        }
        paths.push(d);
    };

    for (let i = 0; i < graphRows.length; i++) {
        const row = graphRows[i];
        const pos = rowPositions.get(row.commit.sha);
        if (!pos) continue;
        const yCenter = pos.top + pos.height / 2;
        const yBottom = pos.top + pos.height;

        const nextRow = graphRows[i + 1];
        const nextPos = nextRow ? rowPositions.get(nextRow.commit.sha) : null;
        const nextYCenter = nextPos ? nextPos.top + nextPos.height / 2 : null;

        if (nextYCenter !== null) {
            const maxLanes = Math.max(
                row.bottomLanes.length,
                nextRow!.topLanes.length,
            );
            for (let lane = 0; lane < maxLanes; lane++) {
                const bottomColorId = row.bottomLanes[lane];
                const topColorId = nextRow!.topLanes[lane];
                if (bottomColorId !== undefined && topColorId !== undefined) {
                    const x = laneX(lane);
                    addPath(
                        bottomColorId,
                        `M ${x} ${yCenter} L ${x} ${nextYCenter}`,
                    );
                }
            }
        }

        if (i === graphRows.length - 1) {
            for (let lane = 0; lane < row.bottomLanes.length; lane++) {
                const laneColorId = row.bottomLanes[lane];
                if (laneColorId !== undefined) {
                    const x = laneX(lane);
                    addPath(laneColorId, `M ${x} ${yCenter} L ${x} ${yBottom}`);
                }
            }
        }

        const { parentColumns, laneIndex, colorId } = row;
        const fromX = laneX(laneIndex);

        for (let p = 0; p < parentColumns.length; p++) {
            const parentCol = parentColumns[p];
            if (parentCol === laneIndex) continue;

            const toX = laneX(parentCol);
            const curveTargetY = Math.min(yBottom, yCenter + 40);
            const edgeColorId = row.bottomLanes[parentCol] ?? colorId;

            if (p === 0) {
                addPath(
                    edgeColorId,
                    buildCheckoutPath(fromX, yCenter, toX, curveTargetY),
                );
            } else {
                addPath(
                    edgeColorId,
                    buildMergePath(fromX, yCenter, toX, curveTargetY),
                );
            }
        }
    }

    const sortedColorGroups = [...colorPaths.entries()].sort(
        (a, b) => a[0] - b[0],
    );

    return (
        <svg
            aria-hidden="true"
            height={totalHeight}
            style={{
                left: 12,
                pointerEvents: "none",
                position: "absolute",
                top: 0,
            }}
            width={graphWidth}
        >
            {sortedColorGroups.map(([colorId, paths]) => (
                <g
                    fill="none"
                    key={colorId}
                    stroke={getGraphColor(colorId)}
                    strokeLinecap="round"
                    strokeWidth={LINE_WIDTH}
                >
                    {paths.map((d, i) => (
                        <path d={d} key={i} />
                    ))}
                </g>
            ))}
            <g>
                {graphRows.map((row) => {
                    const yCenter = getYCenter(row.commit.sha);
                    if (yCenter === null) return null;
                    return (
                        <circle
                            cx={laneX(row.laneIndex)}
                            cy={yCenter}
                            fill={getGraphColor(row.colorId)}
                            key={row.commit.sha}
                            r={COMMIT_RADIUS}
                            stroke="var(--color-bg-primary)"
                            strokeWidth={COMMIT_STROKE}
                        />
                    );
                })}
            </g>
        </svg>
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
    } catch {
        return;
    }
}

function CopyableHash({
    sha,
    display,
    className,
    prefix,
    mono,
    as: Tag = "button",
    stopPropagation,
}: {
    sha: string;
    display: string;
    className?: string;
    prefix?: string;
    mono?: boolean;
    as?: "button" | "span";
    stopPropagation?: boolean;
}) {
    const [copied, setCopied] = useState(false);

    const handleClick = (e: React.MouseEvent) => {
        if (stopPropagation) e.stopPropagation();
        void copyToClipboard(sha).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };

    if (copied) {
        return (
            <Tag
                className={className}
                onClick={handleClick}
                title={sha}
                type={Tag === "button" ? "button" : undefined}
            >
                Copied
            </Tag>
        );
    }

    return (
        <Tag
            className={className}
            onClick={handleClick}
            title={sha}
            type={Tag === "button" ? "button" : undefined}
        >
            {prefix ? <span className="shrink-0">{prefix}</span> : null}
            <span className={mono ? "truncate font-mono" : "truncate"}>
                {display}
            </span>
        </Tag>
    );
}
