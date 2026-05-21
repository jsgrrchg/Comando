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
import {
    getGitContextKey,
    normalizeGitWorktreeIdForContext,
} from "@renderer/app/git/context-key";
import { buildGitRemoteCommitLink } from "@renderer/app/git/remote-link";
import {
    buildGitHistoryGraphRows,
    formatGitCommitDateTime,
    formatGitHistoryDate,
    getRefPillStyle,
    getTemporalGroupLabel,
} from "@renderer/app/git/history-presentation";
import { useGitStore } from "@renderer/app/store/git-store";
import { openExternalUrl } from "@renderer/app/utils/external-url";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type { RuntimeWorkspaceGitTab } from "@renderer/app/workspace/tree";
import { GitAuthorAvatar, GitEmptyState } from "@renderer/components/git";
import { usePersistedWorkspaceScroll } from "@renderer/components/workspace/usePersistedWorkspaceScroll";

import {
    IdeActionButton,
    IdeBarDotSeparator,
    IdeBarHeader,
    IdeBarLabel,
    IdeBarSearchIcon,
    IdeIconButton,
} from "./ide-bar";

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
    return getGitContextKey(projectId, worktreeId);
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
    const { handleScroll: handleGitScroll, scrollRef: gitScrollRef } =
        usePersistedWorkspaceScroll<HTMLDivElement>({
            projectId,
            surface: tab.kind,
            worktreeId,
        });

    const snapshot = useGitStore((state) =>
        contextKey ? (state.snapshots[contextKey] ?? null) : null,
    );
    const history = useGitStore((state) =>
        contextKey
            ? (state.historyByContext[contextKey] ?? EMPTY_HISTORY)
            : EMPTY_HISTORY,
    );
    const historyMatchedCount = useGitStore((state) =>
        contextKey
            ? (state.historyMatchedCountsByContext[contextKey] ??
              history.length)
            : history.length,
    );
    const historyTotalCount = useGitStore((state) =>
        contextKey
            ? (state.historyTotalsByContext[contextKey] ?? history.length)
            : history.length,
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
    const loadMoreHistory = useGitStore((state) => state.loadMoreHistory);
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
        const timeoutId = window.setTimeout(() => {
            setSearchQuery(searchDraft);
        }, 200);

        return () => window.clearTimeout(timeoutId);
    }, [searchDraft]);

    const lastHistorySearchKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (!projectId || isHistoryLoading) {
            return;
        }

        const query = searchQuery.trim();
        const searchKey = `${normalizeGitWorktreeIdForContext(
            projectId,
            worktreeId,
        )}\u0000${query}\u0000${isCaseSensitive ? "case" : "nocase"}`;

        if (lastHistorySearchKeyRef.current === null) {
            lastHistorySearchKeyRef.current = searchKey;
            if (!query && history.length > 0) {
                return;
            }
        } else if (lastHistorySearchKeyRef.current === searchKey) {
            return;
        } else {
            lastHistorySearchKeyRef.current = searchKey;
        }

        void refreshHistory(projectId, worktreeId, {
            caseSensitive: isCaseSensitive,
            query,
            resetLimit: true,
        });
    }, [
        history.length,
        isCaseSensitive,
        isHistoryLoading,
        projectId,
        refreshHistory,
        searchQuery,
        worktreeId,
    ]);

    const hasActiveSearch = searchQuery.trim().length > 0;
    const canConnectGraphHistory =
        !hasActiveSearch && historyMatchedCount === historyTotalCount;
    const graphRows = useMemo(
        () =>
            buildGitHistoryGraphRows(history, {
                connectHistory: canConnectGraphHistory,
            }),
        [canConnectGraphHistory, history],
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
        // DOM measurement: positions feed the SVG graph lines. Bail out when
        // unchanged so this doesn't cause cascading renders.
        setRowPositions((prev) => {
            if (prev.size === next.size) {
                let same = true;
                for (const [sha, pos] of next) {
                    const existing = prev.get(sha);
                    if (
                        !existing ||
                        existing.top !== pos.top ||
                        existing.height !== pos.height
                    ) {
                        same = false;
                        break;
                    }
                }
                if (same) return prev;
            }
            return next;
        });
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

    const handleRefreshHistory = useCallback(() => {
        if (!projectId) {
            return;
        }
        void refreshHistory(projectId, worktreeId);
    }, [projectId, refreshHistory, worktreeId]);

    const handleLoadMoreHistory = useCallback(() => {
        if (!projectId) {
            return;
        }

        void loadMoreHistory(projectId, worktreeId);
    }, [loadMoreHistory, projectId, worktreeId]);

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
    const canLoadMoreHistory =
        history.length > 0 && history.length < historyMatchedCount;
    const historyCountLabel = hasActiveSearch
        ? `${historyMatchedCount} ${
              historyMatchedCount === 1 ? "match" : "matches"
          } / ${historyTotalCount} ${
              historyTotalCount === 1 ? "commit" : "commits"
          }`
        : historyTotalCount === 1
          ? "1 commit"
          : `${historyTotalCount} commits`;

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

            <IdeBarHeader>
                <IdeBarLabel>Git</IdeBarLabel>
                <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-text-secondary">
                    <span className="shrink-0">
                        {historyCountLabel}
                    </span>
                    {isHistoryLoading ? (
                        <>
                            <IdeBarDotSeparator />
                            <span className="shrink-0">Loading...</span>
                        </>
                    ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <IdeActionButton
                        disabled={isHistoryLoading}
                        onClick={handleRefreshHistory}
                        title="Refresh history"
                    >
                        refresh
                    </IdeActionButton>
                </div>
            </IdeBarHeader>

            <div
                className="shrink-0 px-2 py-1.5"
                style={{
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                }}
            >
                <div className="flex w-full items-center gap-1.5">
                    <div className="relative min-w-0 flex-1">
                        <input
                            aria-label="Search commits"
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="w-full min-w-0 rounded-[3px] bg-transparent pl-6 pr-6 text-[11px] text-text-primary placeholder:text-text-secondary focus:bg-[color-mix(in_srgb,var(--color-bg-primary)_70%,transparent)] focus:outline-none"
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
                            style={{
                                border: searchHasNoMatches
                                    ? "1px solid color-mix(in srgb, var(--diff-remove) 45%, transparent)"
                                    : "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
                                fontFamily: "var(--font-mono)",
                                height: 22,
                                lineHeight: "20px",
                            }}
                            type="text"
                            value={searchDraft}
                        />
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
                        >
                            <IdeBarSearchIcon />
                        </span>
                        {searchDraft.length > 0 ? (
                            <button
                                aria-label="Clear search"
                                className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                                onClick={() => {
                                    setSearchDraft("");
                                    setSearchQuery("");
                                }}
                                type="button"
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                    <IdeActionButton
                        active={isCaseSensitive}
                        onClick={() =>
                            setIsCaseSensitive((current) => !current)
                        }
                        title="Match case"
                    >
                        Aa
                    </IdeActionButton>
                    <IdeIconButton
                        aria-label="Previous match"
                        disabled={matchedCommitShas.length === 0}
                        onClick={() => selectSearchMatch("previous")}
                        title="Previous match"
                    >
                        {"<"}
                    </IdeIconButton>
                    <IdeIconButton
                        aria-label="Next match"
                        disabled={matchedCommitShas.length === 0}
                        onClick={() => selectSearchMatch("next")}
                        title="Next match"
                    >
                        {">"}
                    </IdeIconButton>
                    <span
                        className="shrink-0 text-right text-[10.5px] text-text-secondary"
                        style={{
                            fontFamily: "var(--font-mono)",
                            minWidth: 36,
                        }}
                    >
                        {selectedMatchIndex >= 0 &&
                        matchedCommitShas.length > 0
                            ? `${selectedMatchIndex + 1}/${matchedCommitShas.length}`
                            : `0/${matchedCommitShas.length}`}
                    </span>
                </div>
            </div>

            <div className="flex min-h-0 flex-1" ref={splitContainerRef}>
                <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
                    <div
                        className="shell-scrollbar h-full overflow-auto"
                        onScroll={handleGitScroll}
                        ref={gitScrollRef}
                    >
                        <div
                            className="sticky top-0 z-10 grid px-3 py-1.5"
                            style={{
                                backgroundColor: "var(--color-bg-secondary)",
                                borderBottom:
                                    "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                fontFamily: "var(--font-mono)",
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
                                                    "group/row grid w-full items-stretch border-l-[3px] border-l-transparent pl-2.25 pr-3 text-left text-[12px] transition-[color,background-color,border-color] duration-120",
                                                    activeCommit?.sha ===
                                                    row.commit.sha
                                                        ? "border-l-[--row-branch-color]! bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-primary))] text-text-primary"
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
                                {canLoadMoreHistory ? (
                                    <div
                                        className="flex items-center justify-center border-b border-border-subtle px-3 py-3"
                                        style={{
                                            minWidth: gitHistoryTableMinWidth,
                                        }}
                                    >
                                        <IdeActionButton
                                            disabled={isHistoryLoading}
                                            onClick={handleLoadMoreHistory}
                                            title="Load more commits"
                                        >
                                            {isHistoryLoading
                                                ? "loading..."
                                                : "load more"}
                                        </IdeActionButton>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>
                </section>

                {activeCommit ? (
                    <>
                        <div
                            aria-label="Resize commit details sidebar"
                            aria-orientation="vertical"
                            className="group relative z-10 flex w-1.75 cursor-col-resize touch-none items-center justify-center bg-transparent"
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
        <div className="flex min-h-full select-none flex-col">
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

                    <IdeIconButton
                        aria-label="Clear selection"
                        onClick={onClearSelection}
                        title="Close"
                    >
                        ×
                    </IdeIconButton>
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
                            onClick={() => openExternalUrl(remoteLink.url)}
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
                    <pre className="mt-3 select-text whitespace-pre-wrap font-sans text-[12px] leading-6 text-text-secondary">
                        {commit.body}
                    </pre>
                ) : null}
            </div>

            <div
                className="px-5 py-1.5"
                style={{
                    backgroundColor: "var(--color-bg-secondary)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    fontFamily: "var(--font-mono)",
                }}
            >
                <div className="flex items-center justify-between gap-3 text-[10.5px] text-text-secondary">
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
                        className="shrink-0 cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-bg-secondary hover:text-text-primary"
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
                                <div
                                    className="mb-2 flex items-center gap-2"
                                    style={{ fontFamily: "var(--font-mono)" }}
                                >
                                    <IdeBarLabel>
                                        {changedFiles.length} Changed Files
                                    </IdeBarLabel>
                                    {activeDetail &&
                                    activeDetail.insertions > 0 ? (
                                        <span
                                            className="text-[10px]"
                                            style={{ color: "var(--diff-add)" }}
                                        >
                                            +{activeDetail.insertions}
                                        </span>
                                    ) : null}
                                    {activeDetail &&
                                    activeDetail.deletions > 0 ? (
                                        <span
                                            className="text-[10px]"
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

                        <div className="flex justify-center">
                            <button
                                className="review-action-btn"
                                onClick={onOpenCommit}
                                style={{
                                    background: "transparent",
                                    border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                    borderRadius: 3,
                                    color: "var(--color-text-secondary)",
                                    cursor: "pointer",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    lineHeight: "24px",
                                    padding: "0 10px",
                                }}
                                title="Open this commit in a new tab"
                                type="button"
                            >
                                view commit
                            </button>
                        </div>
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
            <span
                className="block truncate"
                style={{
                    color: "var(--color-text-secondary)",
                    fontSize: "10px",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                }}
            >
                {label}
            </span>
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
                nextRow.topLanes.length,
            );
            for (let lane = 0; lane < maxLanes; lane++) {
                const bottomColorId = row.bottomLanes[lane];
                const topColorId = nextRow.topLanes[lane];
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
