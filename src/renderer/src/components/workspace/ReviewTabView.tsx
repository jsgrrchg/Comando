import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSessionSnapshot } from "@shared/ipc";

import {
    AI_REVIEW_UNDO_ENABLED,
    DEFAULT_AI_DIFF_ZOOM,
} from "@renderer/app/ai/sessionReviewContracts";
import { getGitContextKey } from "@renderer/app/git/context-key";
import { useAiStore } from "@renderer/app/store/ai-store";
import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import type {
    RuntimeWorkspaceFileReviewContext,
    RuntimeWorkspaceReviewTab,
} from "@renderer/app/workspace/tree";
import {
    MeasuredVirtualList,
    type MeasuredVirtualListHandle,
} from "@renderer/components/virtual/MeasuredVirtualList";
import {
    collectProjectFileRoots,
    resolveProjectFileReference,
} from "./projectFileReferences";
import {
    deriveReviewItems,
    deriveReviewSummary,
    type ReviewFileItem,
} from "./review/editedFilesPresentationModel";
import {
    DiffStatBar,
    ReviewFileRow,
    ReviewKeepIcon,
    ReviewRejectIcon,
} from "./review/ReviewFileRow";
import { formatDiffStat } from "./review/reviewDiff";
import {
    createPersistedReviewAnchor,
    getReviewViewStorageKey,
    persistReviewViewState,
    readPersistedReviewViewState,
    resolvePersistedReviewAnchor,
    type PersistedReviewAnchor,
} from "./review/reviewTabPersistence";
import { getNeutralButtonStyle } from "./review/reviewStyles";

const REVIEW_VIRTUALIZATION_THRESHOLD = 12;
const REVIEW_VIRTUALIZATION_OVERSCAN = 4;
const REVIEW_FILE_ROW_GAP = 12;

interface ReviewTabViewProps {
    readonly onOpenFile: (
        projectId: string,
        relativePath: string,
        worktreeId?: string | null,
        reviewContext?: RuntimeWorkspaceFileReviewContext | null,
    ) => Promise<void>;
    readonly tab: RuntimeWorkspaceReviewTab;
}

interface ReviewExpansionState {
    readonly allExpanded: boolean;
    readonly collapseAll: () => void;
    readonly expandAll: () => void;
    readonly expandedKeys: ReadonlySet<string>;
    readonly toggleFile: (key: string) => void;
}

function createWriterId(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `review-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
}

function normalizeExpandedKeys(
    keys: Iterable<string>,
    availableKeys: Iterable<string>,
): Set<string> {
    const available = new Set(availableKeys);
    const next = new Set<string>();

    for (const key of keys) {
        if (available.has(key)) {
            next.add(key);
        }
    }

    return next;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
    if (left.size !== right.size) {
        return false;
    }

    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }

    return true;
}

function useReviewExpansion(
    items: readonly ReviewFileItem[],
    initialExpandedKeys: readonly string[] | null,
): ReviewExpansionState {
    const itemKeys = useMemo(
        () => items.map((item) => item.file.identityKey),
        [items],
    );
    const knownKeysRef = useRef<Set<string>>(new Set(itemKeys));
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
        if (!initialExpandedKeys) {
            return new Set(itemKeys);
        }

        return normalizeExpandedKeys(initialExpandedKeys, itemKeys);
    });

    useEffect(() => {
        setExpandedKeys((previous) => {
            const next = normalizeExpandedKeys(previous, itemKeys);
            const knownKeys = knownKeysRef.current;

            for (const key of itemKeys) {
                if (!knownKeys.has(key)) {
                    next.add(key);
                }
            }

            knownKeysRef.current = new Set(itemKeys);
            return setsEqual(previous, next) ? previous : next;
        });
    }, [itemKeys]);

    const toggleFile = useCallback((key: string) => {
        setExpandedKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    const expandAll = useCallback(() => {
        setExpandedKeys(new Set(itemKeys));
    }, [itemKeys]);

    const collapseAll = useCallback(() => {
        setExpandedKeys(new Set());
    }, []);

    return {
        allExpanded: items.length > 0 && expandedKeys.size === items.length,
        collapseAll,
        expandAll,
        expandedKeys,
        toggleFile,
    };
}

function estimateReviewFileRowHeight(
    item: ReviewFileItem,
    expanded: boolean,
    diffZoom: number,
): number {
    const baseHeight = 72;

    if (!expanded) {
        return baseHeight;
    }

    if (!item.diff.isText || item.diff.hunks.length === 0) {
        return baseHeight + 84;
    }

    const diffLineCount = item.diff.hunks.reduce(
        (total, hunk) => total + hunk.lines.length,
        0,
    );

    return Math.min(
        1800,
        baseHeight +
            96 +
            item.diff.hunks.length * 18 +
            diffLineCount * Math.max(16, 18 * diffZoom),
    );
}

function findElementByDatasetValue(
    elements: readonly HTMLElement[],
    key: "reviewFileKey" | "reviewHunkKey",
    value: string,
): HTMLElement | null {
    for (const element of elements) {
        if (element.dataset[key] === value) {
            return element;
        }
    }

    return null;
}

function createViewportPersistedAnchor(
    container: HTMLDivElement,
    itemsByIdentityKey: ReadonlyMap<string, ReviewFileItem>,
): PersistedReviewAnchor | null {
    const containerRect = container.getBoundingClientRect();
    const fileRows = Array.from(
        container.querySelectorAll<HTMLElement>("[data-review-file-key]"),
    );

    const anchorRow =
        fileRows.find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > containerRect.top + 1;
        }) ??
        fileRows[0] ??
        null;

    const identityKey = anchorRow?.dataset.reviewFileKey;
    if (!anchorRow || !identityKey) {
        return null;
    }

    const item = itemsByIdentityKey.get(identityKey);
    if (!item) {
        return null;
    }

    const rowRect = anchorRow.getBoundingClientRect();
    const itemStart = container.scrollTop + (rowRect.top - containerRect.top);
    const offsetWithinItem = Math.max(
        0,
        Math.round(container.scrollTop - itemStart),
    );
    const hunkRows = Array.from(
        anchorRow.querySelectorAll<HTMLElement>("[data-review-hunk-key]"),
    );
    const anchorHunk =
        hunkRows.find((hunk) => {
            const rect = hunk.getBoundingClientRect();
            return rect.bottom > containerRect.top + 1;
        }) ?? null;
    const anchorHunkId = anchorHunk?.dataset.reviewHunkKey;

    return createPersistedReviewAnchor(
        item,
        anchorHunkId ? [anchorHunkId] : [],
        {
            offsetWithinItem,
        },
    );
}

function restorePersistedAnchorInViewport(
    container: HTMLDivElement,
    anchor: PersistedReviewAnchor,
): boolean {
    const fileRows = Array.from(
        container.querySelectorAll<HTMLElement>("[data-review-file-key]"),
    );
    const fileRow = findElementByDatasetValue(
        fileRows,
        "reviewFileKey",
        anchor.identityKey,
    );

    if (!fileRow) {
        return false;
    }

    if (anchor.hunkIds.length > 0) {
        const hunkRows = Array.from(
            fileRow.querySelectorAll<HTMLElement>("[data-review-hunk-key]"),
        );

        for (const hunkId of anchor.hunkIds) {
            const hunkRow = findElementByDatasetValue(
                hunkRows,
                "reviewHunkKey",
                hunkId,
            );
            if (!hunkRow) {
                continue;
            }

            hunkRow.scrollIntoView({ block: "center" });
            return true;
        }
    }

    if (typeof anchor.offsetWithinItem === "number") {
        const containerRect = container.getBoundingClientRect();
        const rowRect = fileRow.getBoundingClientRect();
        const itemStart =
            container.scrollTop + (rowRect.top - containerRect.top);

        container.scrollTop = Math.max(0, itemStart + anchor.offsetWithinItem);
        return true;
    }

    fileRow.scrollIntoView({ block: "start" });
    return true;
}

function ReviewEmptyState({
    hasUndo,
    onUndo,
}: {
    readonly hasUndo?: boolean;
    readonly onUndo?: () => void;
}) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
            <svg
                fill="none"
                height="20"
                stroke="var(--color-text-secondary)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                style={{ opacity: 0.45 }}
                viewBox="0 0 24 24"
                width="20"
            >
                <path d="M9 12l2 2 4-4" />
                <circle cx="12" cy="12" r="10" />
            </svg>
            <div className="flex flex-col items-center gap-1 text-center">
                <div
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.85em",
                        fontWeight: 500,
                    }}
                >
                    No pending AI edits
                </div>
                <div
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.75em",
                        lineHeight: 1.5,
                        opacity: 0.6,
                    }}
                >
                    New edits will appear here automatically.
                </div>
            </div>
            {hasUndo && onUndo ? (
                <button
                    className="review-action-btn rounded-md px-3 py-1.5 text-xs"
                    onClick={onUndo}
                    style={{
                        fontWeight: 500,
                        ...getNeutralButtonStyle(),
                    }}
                    type="button"
                >
                    Undo Last Reject
                </button>
            ) : null}
        </div>
    );
}

function ReviewStatChips({
    summary,
}: {
    readonly summary: ReturnType<typeof deriveReviewSummary>;
}) {
    return (
        <div className="flex items-center gap-2" style={{ fontSize: "10px" }}>
            <span
                style={{
                    color: "var(--color-text-secondary)",
                    fontWeight: 500,
                }}
            >
                {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"}
            </span>
            {(summary.additions > 0 || summary.deletions > 0) && (
                <>
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            opacity: 0.4,
                        }}
                    >
                        ·
                    </span>
                    {summary.additions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-add)",
                                fontWeight: 600,
                            }}
                        >
                            +
                            {formatDiffStat(
                                summary.additions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    {summary.deletions > 0 ? (
                        <span
                            style={{
                                color: "var(--diff-remove)",
                                fontWeight: 600,
                            }}
                        >
                            −
                            {formatDiffStat(
                                summary.deletions,
                                summary.approximate,
                            )}
                        </span>
                    ) : null}
                    <DiffStatBar
                        additions={summary.additions}
                        deletions={summary.deletions}
                    />
                </>
            )}
            {summary.partialCount > 0 ? (
                <>
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            opacity: 0.4,
                        }}
                    >
                        ·
                    </span>
                    <span
                        style={{
                            color: "var(--diff-warn)",
                            fontWeight: 500,
                        }}
                    >
                        {summary.partialCount} partial
                    </span>
                </>
            ) : null}
        </div>
    );
}

export function ReviewTabView(props: ReviewTabViewProps) {
    return <ReviewTabContent key={props.tab.id} {...props} />;
}

function ReviewTabContent({ onOpenFile, tab }: ReviewTabViewProps) {
    const ensureSession = useAiStore((state) => state.ensureSession);
    const keepAllTrackedFiles = useAiStore(
        (state) => state.keepAllTrackedFiles,
    );
    const keepTrackedFile = useAiStore((state) => state.keepTrackedFile);
    const keepTrackedFileHunks = useAiStore(
        (state) => state.keepTrackedFileHunks,
    );
    const rejectAllTrackedFiles = useAiStore(
        (state) => state.rejectAllTrackedFiles,
    );
    const rejectTrackedFile = useAiStore((state) => state.rejectTrackedFile);
    const rejectTrackedFileHunks = useAiStore(
        (state) => state.rejectTrackedFileHunks,
    );
    const sessionState = useAiStore((state) => state.sessions[tab.sessionId]);

    const sessionTab = useMemo(
        () => ({
            createdAt: tab.createdAt,
            id: tab.id,
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            title: tab.title,
            worktreeId: tab.worktreeId ?? null,
        }),
        [
            tab.createdAt,
            tab.id,
            tab.kind,
            tab.projectId,
            tab.runtimeId,
            tab.sessionId,
            tab.title,
            tab.worktreeId,
        ],
    );

    useEffect(() => {
        void ensureSession(sessionTab);
    }, [ensureSession, sessionTab]);

    const snapshot = sessionState?.snapshot ?? createEmptySnapshot(tab);
    const currentError = sessionState?.localError ?? snapshot.lastError;
    const trackedFiles = useMemo(
        () =>
            snapshot.trackedFiles
                .filter((trackedFile) => trackedFile.reviewState === "pending")
                .sort((left, right) =>
                    right.updatedAt.localeCompare(left.updatedAt),
                ),
        [snapshot.trackedFiles],
    );
    const projectSummary = useProjectsStore((state) =>
        tab.projectId
            ? (state.projects.find((project) => project.id === tab.projectId) ??
              null)
            : null,
    );
    const gitSnapshot = useGitStore((state) => {
        if (!tab.projectId) {
            return null;
        }

        return (
            state.snapshots[
                getGitContextKey(tab.projectId, tab.worktreeId ?? null)
            ] ?? null
        );
    });
    const projectFileRoots = useMemo(() => {
        const activeWorktreeRootPath = tab.worktreeId
            ? (gitSnapshot?.worktrees.find(
                  (worktree) => worktree.id === tab.worktreeId,
              )?.rootPath ?? null)
            : (gitSnapshot?.worktrees.find((worktree) => worktree.isCurrent)
                  ?.rootPath ??
              gitSnapshot?.worktrees.find((worktree) => worktree.isPrimary)
                  ?.rootPath ??
              null);

        return collectProjectFileRoots({
            canonicalProjectRoot: projectSummary?.canonicalRootPath,
            currentWorktreeRoot: activeWorktreeRootPath,
            projectRoot: projectSummary?.rootPath,
            repositoryCanonicalRoot: gitSnapshot?.canonicalRootPath,
            repositoryRoot: gitSnapshot?.rootPath,
        });
    }, [
        gitSnapshot?.canonicalRootPath,
        gitSnapshot?.rootPath,
        gitSnapshot?.worktrees,
        projectSummary?.canonicalRootPath,
        projectSummary?.rootPath,
        tab.worktreeId,
    ]);
    const resolveTrackedFileOpenPath = useCallback(
        (trackedFile: ReviewFileItem["file"]) =>
            trackedFile.kind === "delete"
                ? null
                : (resolveProjectFileReference(trackedFile.path, {
                      projectRoots: projectFileRoots,
                  })?.relativePath ?? null),
        [projectFileRoots],
    );
    const items = useMemo(
        () => deriveReviewItems(trackedFiles, resolveTrackedFileOpenPath),
        [resolveTrackedFileOpenPath, trackedFiles],
    );
    const itemsByIdentityKey = useMemo(
        () =>
            new Map(
                items.map((item) => [item.file.identityKey, item] as const),
            ),
        [items],
    );
    const itemIndexByIdentityKey = useMemo(
        () =>
            new Map(
                items.map(
                    (item, index) => [item.file.identityKey, index] as const,
                ),
            ),
        [items],
    );
    const summary = useMemo(() => deriveReviewSummary(items), [items]);
    const rejectableCount = useMemo(
        () => items.filter((item) => item.canReject).length,
        [items],
    );
    const diffZoom = DEFAULT_AI_DIFF_ZOOM;
    const shouldVirtualizeItems =
        !currentError && items.length >= REVIEW_VIRTUALIZATION_THRESHOLD;

    const [persistVersion, setPersistVersion] = useState(0);
    const reviewStorageKey = useMemo(
        () =>
            getReviewViewStorageKey(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
            ),
        [tab.projectId, tab.sessionId, tab.worktreeId],
    );
    const persistedState = useMemo(
        () =>
            readPersistedReviewViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- persistVersion invalidates cached persisted state on storage events
        [persistVersion, tab.projectId, tab.sessionId, tab.worktreeId],
    );
    const initialAnchor = useMemo(
        () =>
            resolvePersistedReviewAnchor(persistedState?.anchor ?? null, items),
        [items, persistedState?.anchor],
    );
    const expansion = useReviewExpansion(
        items,
        (() => {
            if (!persistedState?.expandedIdentityKeys) {
                return null;
            }

            const expandedKeys = new Set(persistedState.expandedIdentityKeys);
            if (initialAnchor) {
                expandedKeys.add(initialAnchor.identityKey);
            }

            return [...expandedKeys];
        })(),
    );

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const persistedAnchorRef = useRef<PersistedReviewAnchor | null>(
        initialAnchor,
    );
    const pendingRestoreAnchorRef = useRef<PersistedReviewAnchor | null>(
        initialAnchor,
    );
    const reviewWriterIdRef = useRef(createWriterId());
    const lastSeenPersistedUpdatedAtRef = useRef<number>(0);
    const didRunPersistEffectRef = useRef(false);
    const restoreAppliedRef = useRef(false);
    const restoreCompletedRef = useRef(false);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const storageRefreshTimerRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const restoreAttemptFrameRef = useRef<number | null>(null);
    const restoreAttemptCountRef = useRef(0);
    const reviewVirtualListApiRef = useRef<MeasuredVirtualListHandle | null>(
        null,
    );
    const [isReviewVirtualListReady, setIsReviewVirtualListReady] =
        useState(false);
    const expandedKeysSignature = useMemo(
        () => [...expansion.expandedKeys].sort().join("\u0000"),
        [expansion.expandedKeys],
    );

    const persistViewState = useCallback(
        (
            nextScrollTop?: number,
            anchorOverride?: PersistedReviewAnchor | null,
        ) => {
            const derivedAnchor =
                anchorOverride ??
                (() => {
                    const container = scrollContainerRef.current;
                    if (!container) {
                        return persistedAnchorRef.current;
                    }

                    return (
                        createViewportPersistedAnchor(
                            container,
                            itemsByIdentityKey,
                        ) ?? persistedAnchorRef.current
                    );
                })();

            persistedAnchorRef.current = derivedAnchor;
            const persisted = persistReviewViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
                {
                    anchor: derivedAnchor,
                    expandedIdentityKeys: expansion.expandedKeys,
                    scrollTop:
                        nextScrollTop ??
                        scrollContainerRef.current?.scrollTop ??
                        persistedState?.scrollTop ??
                        0,
                },
                {
                    baseUpdatedAt: lastSeenPersistedUpdatedAtRef.current,
                    writerId: reviewWriterIdRef.current,
                },
            );

            if (persisted) {
                lastSeenPersistedUpdatedAtRef.current = persisted.updatedAt;
            }
        },
        [
            expansion.expandedKeys,
            itemsByIdentityKey,
            persistedState?.scrollTop,
            tab.projectId,
            tab.sessionId,
            tab.worktreeId,
        ],
    );

    const flushScheduledScrollPersist = useCallback(() => {
        if (scrollPersistTimerRef.current != null) {
            window.clearTimeout(scrollPersistTimerRef.current);
            scrollPersistTimerRef.current = null;
        }
        pendingScrollTopRef.current = null;
    }, []);

    const schedulePersistedStateRefresh = useCallback(() => {
        if (storageRefreshTimerRef.current != null) {
            return;
        }

        storageRefreshTimerRef.current = window.setTimeout(() => {
            storageRefreshTimerRef.current = null;
            setPersistVersion((current) => current + 1);
        }, 80);
    }, []);

    const flushScheduledRestoreAttempt = useCallback(() => {
        if (restoreAttemptFrameRef.current != null) {
            window.cancelAnimationFrame(restoreAttemptFrameRef.current);
            restoreAttemptFrameRef.current = null;
        }
        restoreAttemptCountRef.current = 0;
    }, []);

    const schedulePersistFromScroll = useCallback(
        (scrollTop: number) => {
            pendingScrollTopRef.current = scrollTop;
            if (scrollPersistTimerRef.current != null) {
                return;
            }

            scrollPersistTimerRef.current = window.setTimeout(() => {
                scrollPersistTimerRef.current = null;
                const nextScrollTop = pendingScrollTopRef.current;
                pendingScrollTopRef.current = null;
                persistViewState(nextScrollTop ?? scrollTop);
            }, 120);
        },
        [persistViewState],
    );

    const handleReviewVirtualListReady = useCallback(
        (handle: MeasuredVirtualListHandle | null) => {
            reviewVirtualListApiRef.current = handle;
            setIsReviewVirtualListReady(handle !== null);
        },
        [],
    );

    const scheduleRestoreAttempt = useCallback(function scheduleRestoreAttempt() {
        if (restoreAttemptFrameRef.current != null) {
            return;
        }

        restoreAttemptFrameRef.current = window.requestAnimationFrame(() => {
            restoreAttemptFrameRef.current = null;

            const anchor = pendingRestoreAnchorRef.current;
            const container = scrollContainerRef.current;

            if (
                restoreCompletedRef.current ||
                !restoreAppliedRef.current ||
                !anchor ||
                !container
            ) {
                restoreAttemptCountRef.current = 0;
                return;
            }

            if (restorePersistedAnchorInViewport(container, anchor)) {
                restoreCompletedRef.current = true;
                pendingRestoreAnchorRef.current = null;
                restoreAttemptCountRef.current = 0;
                return;
            }

            if (
                shouldVirtualizeItems &&
                restoreAttemptCountRef.current < REVIEW_VIRTUALIZATION_OVERSCAN
            ) {
                restoreAttemptCountRef.current += 1;
                scheduleRestoreAttempt();
            }
        });
    }, [shouldVirtualizeItems]);

    useEffect(() => {
        if (persistedState?.updatedAt) {
            lastSeenPersistedUpdatedAtRef.current = Math.max(
                lastSeenPersistedUpdatedAtRef.current,
                persistedState.updatedAt,
            );
        }
    }, [persistedState?.updatedAt]);

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== reviewStorageKey || !event.newValue) {
                return;
            }

            try {
                const parsed = JSON.parse(event.newValue) as {
                    readonly updatedAt?: number;
                    readonly writerId?: string;
                };

                if (parsed.writerId === reviewWriterIdRef.current) {
                    return;
                }
                if (typeof parsed.updatedAt !== "number") {
                    return;
                }
                if (parsed.updatedAt <= lastSeenPersistedUpdatedAtRef.current) {
                    return;
                }
                lastSeenPersistedUpdatedAtRef.current = parsed.updatedAt;
            } catch {
                return;
            }

            schedulePersistedStateRefresh();
        };

        window.addEventListener("storage", handleStorage);
        return () => {
            window.removeEventListener("storage", handleStorage);
        };
    }, [reviewStorageKey, schedulePersistedStateRefresh]);

    useEffect(() => {
        if (!didRunPersistEffectRef.current) {
            didRunPersistEffectRef.current = true;
            return;
        }

        persistViewState();
    }, [expandedKeysSignature, persistViewState]);

    useEffect(() => {
        flushScheduledRestoreAttempt();
        restoreAppliedRef.current = false;
        restoreCompletedRef.current = false;
        persistedAnchorRef.current = initialAnchor;
        pendingRestoreAnchorRef.current = initialAnchor;
    }, [
        flushScheduledRestoreAttempt,
        initialAnchor,
        persistedState?.scrollTop,
        shouldVirtualizeItems,
    ]);

    useEffect(() => {
        if (restoreAppliedRef.current || items.length === 0) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const anchor = pendingRestoreAnchorRef.current;
        if (shouldVirtualizeItems && anchor && !isReviewVirtualListReady) {
            return;
        }

        restoreAppliedRef.current = true;

        if (anchor) {
            const anchorIndex = itemIndexByIdentityKey.get(anchor.identityKey);
            if (shouldVirtualizeItems && typeof anchorIndex === "number") {
                reviewVirtualListApiRef.current?.scrollToIndex(anchorIndex, {
                    align: "start",
                    offset: anchor.offsetWithinItem ?? 0,
                });
                scheduleRestoreAttempt();
                return;
            }

            if (restorePersistedAnchorInViewport(container, anchor)) {
                restoreCompletedRef.current = true;
                pendingRestoreAnchorRef.current = null;
                return;
            }
        }

        if (persistedState?.scrollTop) {
            container.scrollTop = persistedState.scrollTop;
        }

        restoreCompletedRef.current = true;
        pendingRestoreAnchorRef.current = null;
    }, [
        isReviewVirtualListReady,
        itemIndexByIdentityKey,
        items.length,
        persistedState?.scrollTop,
        scheduleRestoreAttempt,
        shouldVirtualizeItems,
    ]);

    useEffect(() => {
        if (
            restoreCompletedRef.current ||
            !restoreAppliedRef.current ||
            !pendingRestoreAnchorRef.current
        ) {
            return;
        }

        scheduleRestoreAttempt();
    }, [
        expandedKeysSignature,
        items,
        scheduleRestoreAttempt,
        shouldVirtualizeItems,
    ]);

    useEffect(() => {
        if (persistedState?.anchor == null || items.length === 0) {
            return;
        }

        const anchor = resolvePersistedReviewAnchor(
            persistedState.anchor,
            items,
        );
        if (anchor) {
            return;
        }

        persistedAnchorRef.current = null;
        pendingRestoreAnchorRef.current = null;
        persistViewState();
    }, [items, persistViewState, persistedState?.anchor]);

    useEffect(
        () => () => {
            flushScheduledScrollPersist();
            flushScheduledRestoreAttempt();
            if (storageRefreshTimerRef.current != null) {
                window.clearTimeout(storageRefreshTimerRef.current);
                storageRefreshTimerRef.current = null;
            }
            persistViewState();
        },
        [
            flushScheduledRestoreAttempt,
            flushScheduledScrollPersist,
            persistViewState,
        ],
    );

    const handleOpenFile = useCallback(
        (item: ReviewFileItem) => {
            const openRelativePath = item.openRelativePath;
            if (!tab.projectId || !item.canOpen || !openRelativePath) {
                return;
            }

            void onOpenFile(
                tab.projectId,
                openRelativePath,
                tab.worktreeId ?? null,
                {
                    path: item.file.path,
                    sessionId: tab.sessionId,
                },
            );
        },
        [onOpenFile, tab.projectId, tab.sessionId, tab.worktreeId],
    );

    const handleKeepFile = useCallback(
        (item: ReviewFileItem) => {
            persistedAnchorRef.current = createPersistedReviewAnchor(item);
            persistViewState();
            void keepTrackedFile({
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [keepTrackedFile, persistViewState, tab.sessionId],
    );

    const handleRejectFile = useCallback(
        (item: ReviewFileItem) => {
            persistedAnchorRef.current = createPersistedReviewAnchor(item);
            persistViewState();
            void rejectTrackedFile({
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [persistViewState, rejectTrackedFile, tab.sessionId],
    );

    const handleKeepHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            persistedAnchorRef.current = createPersistedReviewAnchor(item, [
                hunkId,
            ]);
            persistViewState();
            void keepTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [keepTrackedFileHunks, persistViewState, tab.sessionId],
    );

    const handleRejectHunk = useCallback(
        (item: ReviewFileItem, hunkId: string) => {
            persistedAnchorRef.current = createPersistedReviewAnchor(item, [
                hunkId,
            ]);
            persistViewState();
            void rejectTrackedFileHunks({
                hunkIds: [hunkId],
                path: item.file.path,
                sessionId: tab.sessionId,
            });
        },
        [persistViewState, rejectTrackedFileHunks, tab.sessionId],
    );

    if (items.length === 0 && !currentError) {
        return <ReviewEmptyState hasUndo={AI_REVIEW_UNDO_ENABLED} />;
    }

    return (
        <div
            className="flex h-full select-none flex-col overflow-hidden"
            style={{ backgroundColor: "var(--color-bg-primary)" }}
        >
            <div
                className="shrink-0 px-4 py-1.5"
                style={{
                    backgroundColor: "var(--color-bg-secondary)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                    fontFamily: "var(--font-mono)",
                }}
            >
                <div className="flex w-full items-center gap-3">
                    <span
                        className="shrink-0"
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: "10px",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                        }}
                    >
                        Pending Changes
                    </span>
                    <ReviewStatChips summary={summary} />
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        <button
                            aria-label={
                                expansion.allExpanded
                                    ? "Collapse all files"
                                    : "Expand all files"
                            }
                            className="review-action-btn review-text-btn"
                            onClick={
                                expansion.allExpanded
                                    ? expansion.collapseAll
                                    : expansion.expandAll
                            }
                            style={{
                                background: "transparent",
                                border: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                                borderRadius: 3,
                                color: "var(--color-text-secondary)",
                                cursor: "pointer",
                                fontSize: "10px",
                                fontWeight: 500,
                                lineHeight: "20px",
                                padding: "0 8px",
                            }}
                            title={
                                expansion.allExpanded
                                    ? "Collapse all files"
                                    : "Expand all files"
                            }
                            type="button"
                        >
                            {expansion.allExpanded ? "collapse" : "expand"}
                        </button>
                        <button
                            aria-label="Reject all changes"
                            className="review-action-btn review-text-btn"
                            disabled={rejectableCount === 0}
                            onClick={() => {
                                persistedAnchorRef.current = null;
                                persistViewState();
                                void rejectAllTrackedFiles(tab.sessionId);
                            }}
                            style={{
                                alignItems: "center",
                                background: "transparent",
                                border: "none",
                                color: "var(--diff-remove)",
                                cursor:
                                    rejectableCount === 0
                                        ? "not-allowed"
                                        : "pointer",
                                display: "inline-flex",
                                fontSize: "11px",
                                fontWeight: 600,
                                gap: 4,
                                opacity: rejectableCount === 0 ? 0.3 : 0.7,
                                padding: "4px 6px",
                            }}
                            title="Reject all changes"
                            type="button"
                        >
                            <ReviewRejectIcon size={12} />
                            reject all
                        </button>
                        <button
                            aria-label="Keep all changes"
                            className="review-action-btn review-text-btn"
                            disabled={items.length === 0}
                            onClick={() => {
                                persistedAnchorRef.current = null;
                                persistViewState();
                                void keepAllTrackedFiles(tab.sessionId);
                            }}
                            style={{
                                alignItems: "center",
                                background: "transparent",
                                border: "none",
                                color: "var(--diff-add)",
                                cursor:
                                    items.length === 0
                                        ? "not-allowed"
                                        : "pointer",
                                display: "inline-flex",
                                fontSize: "11px",
                                fontWeight: 600,
                                gap: 4,
                                opacity: items.length === 0 ? 0.3 : 0.7,
                                padding: "4px 6px",
                            }}
                            title="Keep all changes"
                            type="button"
                        >
                            <ReviewKeepIcon size={12} />
                            keep all
                        </button>
                    </div>
                </div>
            </div>

            <div
                className="flex-1 overflow-auto px-5 py-4"
                onScroll={(event) =>
                    schedulePersistFromScroll(event.currentTarget.scrollTop)
                }
                ref={scrollContainerRef}
            >
                <div className="w-full">
                    {currentError ? (
                        <div
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, var(--diff-remove) 8%, var(--color-bg-elevated))",
                                border: "1px solid color-mix(in srgb, var(--diff-remove) 22%, var(--color-border))",
                                borderRadius: 14,
                                color: "var(--color-text-primary)",
                                padding: "12px 14px",
                            }}
                        >
                            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
                                Review Error
                            </div>
                            <div className="mt-1 text-sm">{currentError}</div>
                        </div>
                    ) : null}

                    {items.length === 0 ? (
                        <ReviewEmptyState hasUndo={AI_REVIEW_UNDO_ENABLED} />
                    ) : shouldVirtualizeItems ? (
                        <MeasuredVirtualList
                            defaultViewportHeight={900}
                            estimateSize={(item, index) =>
                                estimateReviewFileRowHeight(
                                    item,
                                    expansion.expandedKeys.has(
                                        item.file.identityKey,
                                    ),
                                    diffZoom,
                                ) +
                                (index === items.length - 1
                                    ? 0
                                    : REVIEW_FILE_ROW_GAP)
                            }
                            getItemKey={(item) => item.file.identityKey}
                            items={items}
                            onReady={handleReviewVirtualListReady}
                            overscan={REVIEW_VIRTUALIZATION_OVERSCAN}
                            renderItem={({ index, item }) => (
                                <div
                                    style={{
                                        paddingBottom:
                                            index === items.length - 1
                                                ? 0
                                                : REVIEW_FILE_ROW_GAP,
                                    }}
                                >
                                    <ReviewFileRow
                                        diffZoom={diffZoom}
                                        expanded={expansion.expandedKeys.has(
                                            item.file.identityKey,
                                        )}
                                        item={item}
                                        key={item.file.identityKey}
                                        onKeep={() => handleKeepFile(item)}
                                        onKeepHunk={(hunkId) =>
                                            handleKeepHunk(item, hunkId)
                                        }
                                        onOpen={
                                            item.canOpen
                                                ? () => handleOpenFile(item)
                                                : undefined
                                        }
                                        onReject={() => handleRejectFile(item)}
                                        onRejectHunk={(hunkId) =>
                                            handleRejectHunk(item, hunkId)
                                        }
                                        onToggle={() =>
                                            expansion.toggleFile(
                                                item.file.identityKey,
                                            )
                                        }
                                        variant="full"
                                    />
                                </div>
                            )}
                            scrollContainerRef={scrollContainerRef}
                        />
                    ) : (
                        <div className="flex flex-col gap-3">
                            {items.map((item) => (
                                <ReviewFileRow
                                    diffZoom={diffZoom}
                                    expanded={expansion.expandedKeys.has(
                                        item.file.identityKey,
                                    )}
                                    item={item}
                                    key={item.file.identityKey}
                                    onKeep={() => handleKeepFile(item)}
                                    onKeepHunk={(hunkId) =>
                                        handleKeepHunk(item, hunkId)
                                    }
                                    onOpen={
                                        item.canOpen
                                            ? () => handleOpenFile(item)
                                            : undefined
                                    }
                                    onReject={() => handleRejectFile(item)}
                                    onRejectHunk={(hunkId) =>
                                        handleRejectHunk(item, hunkId)
                                    }
                                    onToggle={() =>
                                        expansion.toggleFile(
                                            item.file.identityKey,
                                        )
                                    }
                                    variant="full"
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function createEmptySnapshot(
    tab: RuntimeWorkspaceReviewTab,
): AiSessionSnapshot {
    const now = new Date().toISOString();

    return {
        availableCommands: [],
        configOptions: [],
        lastError: null,
        messages: [],
        modeId: null,
        modes: [],
        modelId: null,
        models: [],
        pendingPermission: null,
        pendingUserInput: null,
        plan: null,
        projectId: tab.projectId,
        runtimeId: tab.runtimeId,
        runtimeSessionId: null,
        sessionId: tab.sessionId,
        status: "idle",
        title: tab.title,
        tokenUsage: null,
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: tab.worktreeId ?? null,
    };
}
