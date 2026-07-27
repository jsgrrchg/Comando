import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type RefCallback,
    type UIEventHandler,
} from "react";

const WORKSPACE_SCROLL_STATE_VERSION = 1;
const WORKSPACE_SCROLL_STATE_PREFIX = "comando.workspace.scroll";
const SCROLL_PERSIST_DELAY_MS = 120;
const SCROLL_RESTORE_TIMEOUT_MS = 2500;

export interface WorkspaceScrollScope {
    readonly surface: string;
    readonly projectId?: string | null;
    readonly worktreeId?: string | null;
    readonly entityId?: string | null;
}

export interface PersistedWorkspaceScrollState {
    readonly scrollTop: number;
    readonly updatedAt: number;
    readonly version: number;
}

const useBrowserLayoutEffect =
    typeof window === "undefined" ? useEffect : useLayoutEffect;

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function encodeScopePart(value: string): string {
    return encodeURIComponent(value.trim());
}

function getProjectScope(projectId: string | null | undefined): string {
    return projectId?.trim() || "global";
}

function getWorktreeScope(worktreeId: string | null | undefined): string {
    return worktreeId?.trim() || "root";
}

function normalizePersistedScrollState(
    raw: unknown,
): PersistedWorkspaceScrollState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const scrollTop = (raw as { scrollTop?: unknown }).scrollTop;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;

    if (
        version !== WORKSPACE_SCROLL_STATE_VERSION ||
        typeof scrollTop !== "number" ||
        !Number.isFinite(scrollTop) ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        scrollTop: Math.max(0, scrollTop),
        updatedAt,
        version: WORKSPACE_SCROLL_STATE_VERSION,
    };
}

export function getWorkspaceScrollStorageKey(scope: WorkspaceScrollScope): string {
    const parts = [
        WORKSPACE_SCROLL_STATE_PREFIX,
        `v${WORKSPACE_SCROLL_STATE_VERSION}`,
        "surface",
        encodeScopePart(scope.surface),
        "project",
        encodeScopePart(getProjectScope(scope.projectId)),
        "worktree",
        encodeScopePart(getWorktreeScope(scope.worktreeId)),
    ];

    const entityId = scope.entityId?.trim();
    if (entityId) {
        parts.push("entity", encodeScopePart(entityId));
    }

    return parts.join(":");
}

export function readPersistedWorkspaceScrollState(
    storageKey: string,
): PersistedWorkspaceScrollState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const raw = storage.getItem(storageKey);
    if (!raw) {
        return null;
    }

    try {
        return normalizePersistedScrollState(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function persistWorkspaceScrollState(
    storageKey: string,
    scrollTop: number,
): PersistedWorkspaceScrollState | null {
    const storage = getStorage();
    if (!storage) {
        return null;
    }

    const nextState: PersistedWorkspaceScrollState = {
        scrollTop: Math.max(0, scrollTop),
        updatedAt: Date.now(),
        version: WORKSPACE_SCROLL_STATE_VERSION,
    };

    storage.setItem(storageKey, JSON.stringify(nextState));
    return nextState;
}

export function usePersistedWorkspaceScroll<TElement extends HTMLElement>(
    scope: WorkspaceScrollScope,
): {
    readonly handleScroll: UIEventHandler<TElement>;
    readonly handleScrollTop: (scrollTop: number) => void;
    readonly scrollRef: RefCallback<TElement>;
    readonly storageKey: string;
} {
    const scrollElementRef = useRef<TElement | null>(null);
    const [scrollElementVersion, setScrollElementVersion] = useState(0);
    const pendingScrollTopRef = useRef<number | null>(null);
    const persistTimerRef = useRef<number | null>(null);
    const restoreFrameRef = useRef<number | null>(null);
    const restoreTimeoutRef = useRef<number | null>(null);
    const restoreObserverRef = useRef<ResizeObserver | null>(null);
    const isRestoringRef = useRef(false);
    const { entityId, projectId, surface, worktreeId } = scope;
    const storageKey = useMemo(
        () =>
            getWorkspaceScrollStorageKey({
                entityId,
                projectId,
                surface,
                worktreeId,
            }),
        [entityId, projectId, surface, worktreeId],
    );

    const persistScrollTop = useCallback(
        (scrollTop: number) => {
            persistWorkspaceScrollState(storageKey, scrollTop);
        },
        [storageKey],
    );

    const clearScheduledRestore = useCallback(() => {
        if (restoreFrameRef.current !== null) {
            window.cancelAnimationFrame(restoreFrameRef.current);
            restoreFrameRef.current = null;
        }
        if (restoreTimeoutRef.current !== null) {
            window.clearTimeout(restoreTimeoutRef.current);
            restoreTimeoutRef.current = null;
        }
        restoreObserverRef.current?.disconnect();
        restoreObserverRef.current = null;
        isRestoringRef.current = false;
    }, []);

    const flushScheduledScrollPersist = useCallback(() => {
        if (persistTimerRef.current !== null) {
            window.clearTimeout(persistTimerRef.current);
            persistTimerRef.current = null;
        }

        const scrollTop = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;

        if (typeof scrollTop === "number" && Number.isFinite(scrollTop)) {
            persistScrollTop(scrollTop);
        }
    }, [persistScrollTop]);

    const scrollRef = useCallback<RefCallback<TElement>>(
        (node) => {
            if (scrollElementRef.current === node) {
                return;
            }

            if (!node) {
                clearScheduledRestore();
                flushScheduledScrollPersist();
                scrollElementRef.current = null;
                return;
            }

            scrollElementRef.current = node;
            setScrollElementVersion((current) => current + 1);
        },
        [clearScheduledRestore, flushScheduledScrollPersist],
    );

    const handleScrollTop = useCallback(
        (scrollTop: number) => {
            if (isRestoringRef.current || !Number.isFinite(scrollTop)) {
                return;
            }

            pendingScrollTopRef.current = scrollTop;

            if (persistTimerRef.current !== null) {
                return;
            }

            persistTimerRef.current = window.setTimeout(() => {
                persistTimerRef.current = null;
                const scrollTop = pendingScrollTopRef.current;
                pendingScrollTopRef.current = null;

                if (
                    typeof scrollTop === "number" &&
                    Number.isFinite(scrollTop)
                ) {
                    persistScrollTop(scrollTop);
                }
            }, SCROLL_PERSIST_DELAY_MS);
        },
        [persistScrollTop],
    );
    const handleScroll = useCallback<UIEventHandler<TElement>>(
        (event) => handleScrollTop(event.currentTarget.scrollTop),
        [handleScrollTop],
    );

    useBrowserLayoutEffect(() => {
        const scrollEl = scrollElementRef.current;
        const persistedState = readPersistedWorkspaceScrollState(storageKey);
        const restoreScrollTop = persistedState?.scrollTop ?? 0;

        if (!scrollEl) {
            return undefined;
        }

        clearScheduledRestore();
        pendingScrollTopRef.current = null;

        if (restoreScrollTop <= 0) {
            scrollEl.scrollTop = 0;
            return () => {
                clearScheduledRestore();
                flushScheduledScrollPersist();
            };
        }

        isRestoringRef.current = true;
        let removeUserIntentListeners = () => {};

        const completeRestore = () => {
            removeUserIntentListeners();
            clearScheduledRestore();
        };

        const cancelRestoreForUserIntent = () => {
            if (isRestoringRef.current) {
                completeRestore();
            }
        };

        scrollEl.addEventListener("wheel", cancelRestoreForUserIntent, {
            passive: true,
        });
        scrollEl.addEventListener("touchstart", cancelRestoreForUserIntent, {
            passive: true,
        });
        scrollEl.addEventListener("pointerdown", cancelRestoreForUserIntent, {
            passive: true,
        });
        scrollEl.addEventListener("keydown", cancelRestoreForUserIntent);
        removeUserIntentListeners = () => {
            scrollEl.removeEventListener("wheel", cancelRestoreForUserIntent);
            scrollEl.removeEventListener(
                "touchstart",
                cancelRestoreForUserIntent,
            );
            scrollEl.removeEventListener(
                "pointerdown",
                cancelRestoreForUserIntent,
            );
            scrollEl.removeEventListener("keydown", cancelRestoreForUserIntent);
            removeUserIntentListeners = () => {};
        };

        const applyRestore = () => {
            const nextScrollEl = scrollElementRef.current;
            if (!nextScrollEl) {
                return;
            }

            nextScrollEl.scrollTop = restoreScrollTop;

            const maxScrollTop = Math.max(
                0,
                nextScrollEl.scrollHeight - nextScrollEl.clientHeight,
            );
            if (
                restoreScrollTop <= maxScrollTop ||
                nextScrollEl.scrollTop >= restoreScrollTop
            ) {
                completeRestore();
            }
        };

        const scheduleRestore = () => {
            if (restoreFrameRef.current !== null || !isRestoringRef.current) {
                return;
            }

            restoreFrameRef.current = window.requestAnimationFrame(() => {
                restoreFrameRef.current = null;
                applyRestore();
                scheduleRestore();
            });
        };

        applyRestore();

        if (isRestoringRef.current) {
            if (typeof ResizeObserver !== "undefined") {
                restoreObserverRef.current = new ResizeObserver(() => {
                    scheduleRestore();
                });
                restoreObserverRef.current.observe(scrollEl);
            }

            restoreTimeoutRef.current = window.setTimeout(() => {
                clearScheduledRestore();
            }, SCROLL_RESTORE_TIMEOUT_MS);

            scheduleRestore();
        }

        return () => {
            removeUserIntentListeners();
            clearScheduledRestore();
            flushScheduledScrollPersist();
        };
    }, [
        clearScheduledRestore,
        flushScheduledScrollPersist,
        scrollElementVersion,
        storageKey,
    ]);

    return {
        handleScroll,
        handleScrollTop,
        scrollRef,
        storageKey,
    };
}
