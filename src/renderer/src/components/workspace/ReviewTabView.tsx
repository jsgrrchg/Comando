import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSessionSnapshot } from "@shared/ipc";

import {
    AI_REVIEW_UNDO_ENABLED,
    DEFAULT_AI_DIFF_ZOOM,
} from "@renderer/app/ai/sessionReviewContracts";
import { useAiStore } from "@renderer/app/store/ai-store";
import type {
    RuntimeWorkspaceFileReviewContext,
    RuntimeWorkspaceReviewTab,
} from "@renderer/app/workspace/tree";
import {
    deriveReviewItems,
    deriveReviewSummary,
    type ReviewFileItem,
} from "./review/editedFilesPresentationModel";
import { ReviewFileRow } from "./review/ReviewFileRow";
import {
    DIFF_ZOOM_MAX,
    DIFF_ZOOM_MIN,
    DIFF_ZOOM_STEP,
    formatDiffStat,
    stepDiffZoom,
} from "./review/reviewDiff";
import {
    createPersistedReviewAnchor,
    getReviewViewStorageKey,
    persistReviewViewState,
    readPersistedReviewViewState,
    resolvePersistedReviewAnchor,
    type PersistedReviewAnchor,
} from "./review/reviewTabPersistence";
import {
    getAccentButtonStyle,
    getDangerButtonStyle,
    getNeutralButtonStyle,
    getStatChipStyle,
} from "./review/reviewStyles";

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

function ReviewEmptyState() {
    return (
        <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md text-center">
                <div className="text-sm font-semibold text-text-primary">
                    No pending changes
                </div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">
                    AI edits will appear here automatically as soon as files are
                    changed.
                </p>
            </div>
        </div>
    );
}

function ReviewStatChips({
    summary,
}: {
    readonly summary: ReturnType<typeof deriveReviewSummary>;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <span style={getStatChipStyle()}>
                {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"}
            </span>
            {summary.additions > 0 ? (
                <span style={getStatChipStyle("var(--diff-add)")}>
                    +{formatDiffStat(summary.additions, summary.approximate)}
                </span>
            ) : null}
            {summary.deletions > 0 ? (
                <span style={getStatChipStyle("var(--diff-remove)")}>
                    -{formatDiffStat(summary.deletions, summary.approximate)}
                </span>
            ) : null}
            {summary.partialCount > 0 ? (
                <span style={getStatChipStyle("var(--diff-warn)")}>
                    {summary.partialCount} partial
                </span>
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
    const setSessionDiffZoom = useAiStore((state) => state.setSessionDiffZoom);
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
    const openablePathSet = useMemo(() => {
        if (!tab.projectId) {
            return new Set<string>();
        }

        return new Set(
            trackedFiles
                .filter((trackedFile) => trackedFile.kind !== "delete")
                .filter((trackedFile) => !looksAbsolutePath(trackedFile.path))
                .map((trackedFile) => trackedFile.path),
        );
    }, [tab.projectId, trackedFiles]);
    const items = useMemo(
        () => deriveReviewItems(trackedFiles, openablePathSet),
        [openablePathSet, trackedFiles],
    );
    const summary = useMemo(() => deriveReviewSummary(items), [items]);
    const rejectableCount = useMemo(
        () => items.filter((item) => item.canReject).length,
        [items],
    );
    const diffZoom = sessionState?.diffZoom ?? DEFAULT_AI_DIFF_ZOOM;
    const canDecreaseZoom = diffZoom > DIFF_ZOOM_MIN;
    const canIncreaseZoom = diffZoom < DIFF_ZOOM_MAX;

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
    const reviewWriterIdRef = useRef(createWriterId());
    const lastSeenPersistedUpdatedAtRef = useRef<number>(0);
    const didRunPersistEffectRef = useRef(false);
    const restoreAppliedRef = useRef(false);
    const scrollPersistTimerRef = useRef<number | null>(null);
    const storageRefreshTimerRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const expandedKeysSignature = useMemo(
        () => [...expansion.expandedKeys].sort().join("\u0000"),
        [expansion.expandedKeys],
    );

    const persistViewState = useCallback(
        (nextScrollTop?: number) => {
            const persisted = persistReviewViewState(
                tab.projectId,
                tab.worktreeId ?? null,
                tab.sessionId,
                {
                    anchor: persistedAnchorRef.current,
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
        if (persistedAnchorRef.current == null && initialAnchor) {
            persistedAnchorRef.current = initialAnchor;
        }
    }, [initialAnchor]);

    useEffect(() => {
        if (restoreAppliedRef.current || items.length === 0) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        restoreAppliedRef.current = true;
        if (persistedState?.scrollTop) {
            container.scrollTop = persistedState.scrollTop;
        }

        const anchor = resolvePersistedReviewAnchor(
            persistedState?.anchor ?? null,
            items,
        );
        if (!anchor) {
            return;
        }

        const hunkTarget = Array.from(
            container.querySelectorAll<HTMLElement>("[data-review-hunk-key]"),
        ).find((element) => {
            const reviewFileKey = element.dataset.reviewFileKey;
            const reviewHunkKey = element.dataset.reviewHunkKey;
            return (
                reviewFileKey === anchor.identityKey &&
                !!reviewHunkKey &&
                anchor.hunkIds.includes(reviewHunkKey)
            );
        });

        if (hunkTarget) {
            hunkTarget.scrollIntoView({ block: "center" });
            return;
        }

        const fileTarget = Array.from(
            container.querySelectorAll<HTMLElement>("[data-review-file-key]"),
        ).find(
            (element) => element.dataset.reviewFileKey === anchor.identityKey,
        );

        fileTarget?.scrollIntoView({ block: "center" });
    }, [items, persistedState]);

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
        persistViewState();
    }, [items, persistViewState, persistedState?.anchor]);

    useEffect(
        () => () => {
            flushScheduledScrollPersist();
            if (storageRefreshTimerRef.current != null) {
                window.clearTimeout(storageRefreshTimerRef.current);
                storageRefreshTimerRef.current = null;
            }
            persistViewState();
        },
        [flushScheduledScrollPersist, persistViewState],
    );

    const handleOpenFile = useCallback(
        (item: ReviewFileItem) => {
            if (!tab.projectId || !item.canOpen) {
                return;
            }

            void onOpenFile(
                tab.projectId,
                item.file.path,
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
        return <ReviewEmptyState />;
    }

    return (
        <div
            className="flex h-full flex-col overflow-hidden"
            style={{ backgroundColor: "var(--color-bg-primary)" }}
        >
            <div
                className="shrink-0 px-5 py-3"
                style={{
                    backgroundColor: "var(--color-bg-secondary)",
                    borderBottom:
                        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
                }}
            >
                <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex items-center gap-3">
                            <h1
                                className="text-sm font-semibold"
                                style={{ color: "var(--color-text-primary)" }}
                            >
                                Pending Changes
                            </h1>
                            <ReviewStatChips summary={summary} />
                        </div>
                        <div className="mt-1 text-xs text-text-secondary">
                            Review and accept or reject pending AI file edits.
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <div
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, var(--color-bg-primary) 48%, transparent)",
                                border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
                                borderRadius: 8,
                                display: "flex",
                                overflow: "hidden",
                            }}
                        >
                            <button
                                aria-label="Decrease diff zoom"
                                disabled={!canDecreaseZoom}
                                onClick={() =>
                                    setSessionDiffZoom(
                                        tab.sessionId,
                                        stepDiffZoom(diffZoom, -DIFF_ZOOM_STEP),
                                    )
                                }
                                style={{
                                    color: canDecreaseZoom
                                        ? "var(--color-text-primary)"
                                        : "var(--color-text-secondary)",
                                    cursor: canDecreaseZoom
                                        ? "pointer"
                                        : "not-allowed",
                                    opacity: canDecreaseZoom ? 1 : 0.45,
                                    padding: "4px 10px",
                                }}
                                type="button"
                            >
                                -
                            </button>
                            <div
                                style={{
                                    borderLeft:
                                        "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
                                    borderRight:
                                        "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.75em",
                                    minWidth: 46,
                                    padding: "6px 8px",
                                    textAlign: "center",
                                }}
                            >
                                {Math.round(diffZoom * 100)}%
                            </div>
                            <button
                                aria-label="Increase diff zoom"
                                disabled={!canIncreaseZoom}
                                onClick={() =>
                                    setSessionDiffZoom(
                                        tab.sessionId,
                                        stepDiffZoom(diffZoom, DIFF_ZOOM_STEP),
                                    )
                                }
                                style={{
                                    color: canIncreaseZoom
                                        ? "var(--color-text-primary)"
                                        : "var(--color-text-secondary)",
                                    cursor: canIncreaseZoom
                                        ? "pointer"
                                        : "not-allowed",
                                    opacity: canIncreaseZoom ? 1 : 0.45,
                                    padding: "4px 10px",
                                }}
                                type="button"
                            >
                                +
                            </button>
                        </div>
                        {AI_REVIEW_UNDO_ENABLED ? (
                            <button
                                className="review-action-btn"
                                style={{
                                    ...getNeutralButtonStyle(),
                                    borderRadius: 8,
                                    fontSize: "0.75em",
                                    fontWeight: 600,
                                    padding: "6px 10px",
                                }}
                                type="button"
                            >
                                Undo Last Reject
                            </button>
                        ) : null}
                        <button
                            className="review-action-btn"
                            disabled={expansion.allExpanded}
                            onClick={expansion.expandAll}
                            style={{
                                ...getNeutralButtonStyle(),
                                borderRadius: 8,
                                cursor: expansion.allExpanded
                                    ? "not-allowed"
                                    : "pointer",
                                fontSize: "0.75em",
                                fontWeight: 600,
                                opacity: expansion.allExpanded ? 0.45 : 1,
                                padding: "6px 10px",
                            }}
                            type="button"
                        >
                            Expand All
                        </button>
                        <button
                            className="review-action-btn"
                            disabled={expansion.expandedKeys.size === 0}
                            onClick={expansion.collapseAll}
                            style={{
                                ...getNeutralButtonStyle(),
                                borderRadius: 8,
                                cursor:
                                    expansion.expandedKeys.size === 0
                                        ? "not-allowed"
                                        : "pointer",
                                fontSize: "0.75em",
                                fontWeight: 600,
                                opacity:
                                    expansion.expandedKeys.size === 0
                                        ? 0.45
                                        : 1,
                                padding: "6px 10px",
                            }}
                            type="button"
                        >
                            Collapse All
                        </button>
                        <button
                            className="review-action-btn"
                            disabled={rejectableCount === 0}
                            onClick={() => {
                                persistedAnchorRef.current = null;
                                persistViewState();
                                void rejectAllTrackedFiles(tab.sessionId);
                            }}
                            style={{
                                ...getDangerButtonStyle(rejectableCount === 0),
                                borderRadius: 8,
                                fontSize: "0.75em",
                                fontWeight: 700,
                                padding: "6px 12px",
                            }}
                            type="button"
                        >
                            Reject All
                        </button>
                        <button
                            className="review-action-btn"
                            disabled={items.length === 0}
                            onClick={() => {
                                persistedAnchorRef.current = null;
                                persistViewState();
                                void keepAllTrackedFiles(tab.sessionId);
                            }}
                            style={{
                                ...getAccentButtonStyle(),
                                borderRadius: 8,
                                cursor:
                                    items.length === 0
                                        ? "not-allowed"
                                        : "pointer",
                                fontSize: "0.75em",
                                fontWeight: 700,
                                opacity: items.length === 0 ? 0.45 : 1,
                                padding: "6px 12px",
                            }}
                            type="button"
                        >
                            Keep All
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
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
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
                        <ReviewEmptyState />
                    ) : (
                        items.map((item) => (
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
                                    expansion.toggleFile(item.file.identityKey)
                                }
                                variant="full"
                            />
                        ))
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
        toolActivity: [],
        trackedFiles: [],
        updatedAt: now,
        worktreeId: tab.worktreeId ?? null,
    };
}

function looksAbsolutePath(candidatePath: string): boolean {
    return (
        candidatePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidatePath)
    );
}
