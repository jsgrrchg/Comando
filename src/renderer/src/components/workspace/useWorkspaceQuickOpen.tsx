import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { ProjectTreeNode } from "@shared/ipc";

import {
    searchProjectQuickOpenEntries,
    type ProjectQuickOpenMatch,
} from "@renderer/app/projects/quick-open";

function scheduleEffectStateUpdate(update: () => void): () => void {
    let cancelled = false;
    queueMicrotask(() => {
        if (!cancelled) {
            update();
        }
    });
    return () => {
        cancelled = true;
    };
}

export function isQuickOpenFileShortcut(
    event: Pick<
        KeyboardEvent,
        "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "shiftKey"
    >,
): boolean {
    return (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "t"
    );
}

export function useWorkspaceQuickOpen({
    activePaneId,
    activeProjectId,
    activeWorktreeId,
    openFileTab,
}: {
    readonly activePaneId: string;
    readonly activeProjectId: string | null;
    readonly activeWorktreeId: string | null;
    readonly openFileTab: (
        projectId: string,
        relativePath: string,
        worktreeId: string | null,
        options?: undefined,
        paneId?: string,
    ) => Promise<void>;
}) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<
        readonly ProjectTreeNode[]
    >([]);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const results = useMemo(
        () => searchProjectQuickOpenEntries(searchResults, query),
        [query, searchResults],
    );

    const close = useCallback(() => {
        setLoading(false);
        setOpen(false);
        setQuery("");
        setSelectedIndex(0);
    }, []);

    const openPalette = useCallback(() => {
        setOpen(true);
        setQuery("");
        setSelectedIndex(0);
    }, []);

    useEffect(() => {
        return scheduleEffectStateUpdate(() => {
            close();
            setSearchResults([]);
        });
    }, [activeProjectId, activeWorktreeId, close]);

    useEffect(() => {
        if (results.length === 0) {
            return scheduleEffectStateUpdate(() => {
                setSelectedIndex(0);
            });
        }
        return scheduleEffectStateUpdate(() =>
            setSelectedIndex((currentIndex) =>
                Math.min(currentIndex, results.length - 1),
            ),
        );
    }, [results.length]);

    useEffect(() => {
        const normalizedQuery = query.trim();
        if (!open || !activeProjectId || !normalizedQuery) {
            return scheduleEffectStateUpdate(() => {
                setSearchResults([]);
                setLoading(false);
            });
        }

        let cancelled = false;
        const cancelLoadingUpdate = scheduleEffectStateUpdate(() => {
            setLoading(true);
        });
        const timeoutId = window.setTimeout(() => {
            void window.comando
                .searchProjectEntries({
                    limit: 120,
                    projectId: activeProjectId,
                    query: normalizedQuery,
                    searchContext: "quick-open",
                    worktreeId: activeWorktreeId,
                })
                .then((nextResults) => {
                    if (!cancelled) {
                        setSearchResults(nextResults);
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        setSearchResults([]);
                    }
                })
                .finally(() => {
                    if (!cancelled) {
                        setLoading(false);
                    }
                });
        }, normalizedQuery.length <= 1 ? 0 : 120);

        return () => {
            cancelled = true;
            cancelLoadingUpdate();
            window.clearTimeout(timeoutId);
        };
    }, [activeProjectId, activeWorktreeId, open, query]);

    const select = useCallback(
        async (item: ProjectQuickOpenMatch) => {
            if (!activeProjectId) {
                return;
            }
            close();
            await openFileTab(
                activeProjectId,
                item.relativePath,
                activeWorktreeId,
                undefined,
                activePaneId,
            );
        },
        [activePaneId, activeProjectId, activeWorktreeId, close, openFileTab],
    );

    const onInputKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
            }
            if (results.length === 0) {
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) =>
                    index >= results.length - 1 ? 0 : index + 1,
                );
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) =>
                    index <= 0 ? results.length - 1 : index - 1,
                );
                return;
            }
            if (event.key === "Home") {
                event.preventDefault();
                setSelectedIndex(0);
                return;
            }
            if (event.key === "End") {
                event.preventDefault();
                setSelectedIndex(results.length - 1);
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                const item = results[selectedIndex];
                if (item) {
                    void select(item);
                }
            }
        },
        [close, results, select, selectedIndex],
    );

    return {
        close,
        loading,
        onChangeQuery: setQuery,
        onHoverIndex: setSelectedIndex,
        onInputKeyDown,
        open,
        openPalette,
        query,
        results,
        selectedIndex,
        select,
    };
}
