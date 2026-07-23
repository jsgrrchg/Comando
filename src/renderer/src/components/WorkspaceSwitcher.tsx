import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import type { OpenWorkspaceLocationSummary } from "@shared/ipc";

export interface WorkspaceSwitcherProject {
    readonly id: string;
    readonly name: string;
    readonly worktrees: readonly {
        readonly id: string;
        readonly label: string;
    }[];
}

interface WorkspaceSwitcherProps {
    readonly onClose: () => void;
    readonly open: boolean;
    readonly projects: readonly WorkspaceSwitcherProject[];
}

interface DisplayWorkspaceLocation {
    readonly location: OpenWorkspaceLocationSummary;
    readonly projectName: string;
    readonly searchText: string;
    readonly worktreeLabel: string;
}

export function WorkspaceSwitcher({
    onClose,
    open,
    projects,
}: WorkspaceSwitcherProps) {
    const [locations, setLocations] = useState<
        readonly OpenWorkspaceLocationSummary[]
    >([]);
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        setQuery("");
        setSelectedIndex(0);
        setError(null);
        void window.comando
            ?.listOpenWorkspaceLocations()
            .then((nextLocations) => {
                if (!cancelled) {
                    setLocations(nextLocations);
                    requestAnimationFrame(() => inputRef.current?.focus());
                }
            })
            .catch((cause: unknown) => {
                if (!cancelled) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : "Could not load open workspaces.",
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    const displayLocations = useMemo(
        () =>
            locations.map((location): DisplayWorkspaceLocation => {
                const project = projects.find(
                    (candidate) => candidate.id === location.projectId,
                );
                const projectName = project?.name ?? location.projectId;
                const worktreeLabel = location.worktreeId
                    ? (project?.worktrees.find(
                          (worktree) => worktree.id === location.worktreeId,
                      )?.label ?? location.worktreeId)
                    : "Primary worktree";
                return {
                    location,
                    projectName,
                    searchText: [
                        projectName,
                        worktreeLabel,
                        location.windowTitle,
                    ]
                        .join(" ")
                        .toLowerCase(),
                    worktreeLabel,
                };
            }),
        [locations, projects],
    );
    const normalizedQuery = query.trim().toLowerCase();
    const filteredLocations = useMemo(
        () =>
            displayLocations.filter(
                (entry) =>
                    !normalizedQuery ||
                    entry.searchText.includes(normalizedQuery),
            ),
        [displayLocations, normalizedQuery],
    );

    useEffect(() => {
        setSelectedIndex((current) =>
            filteredLocations.length === 0
                ? 0
                : Math.min(current, filteredLocations.length - 1),
        );
    }, [filteredLocations.length]);

    if (!open || typeof document === "undefined") {
        return null;
    }

    const activate = async (entry: DisplayWorkspaceLocation) => {
        setError(null);
        try {
            const activated = await window.comando?.activateWorkspaceLocation(
                entry.location,
            );
            if (!activated) {
                setError("This workspace is no longer open.");
                return;
            }
            onClose();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Could not switch workspaces.",
            );
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (filteredLocations.length === 0) {
                return;
            }
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setSelectedIndex(
                (current) =>
                    (current + direction + filteredLocations.length) %
                    filteredLocations.length,
            );
            return;
        }
        if (event.key === "Enter") {
            const selected = filteredLocations[selectedIndex];
            if (selected) {
                event.preventDefault();
                void activate(selected);
            }
        }
    };

    const currentWindow = filteredLocations.filter(
        (entry) => entry.location.isCurrentWindow,
    );
    const otherWindows = filteredLocations.filter(
        (entry) => !entry.location.isCurrentWindow,
    );
    let displayIndex = 0;

    return createPortal(
        <div
            className="project-context-menu-backdrop"
            onMouseDown={(event) => {
                if (event.currentTarget === event.target) {
                    onClose();
                }
            }}
        >
            <div
                aria-label="Switch workspace"
                aria-modal="true"
                className="project-context-menu workspace-switcher"
                role="dialog"
            >
                <label className="project-context-search-shell">
                    <span aria-hidden="true">⌕</span>
                    <input
                        aria-label="Search open workspaces"
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search projects, worktrees, or windows"
                        ref={inputRef}
                        value={query}
                    />
                    <span>{filteredLocations.length}</span>
                </label>
                <div className="workspace-switcher-list" role="listbox">
                    {renderGroup("Current Window", currentWindow)}
                    {renderGroup("Other Windows", otherWindows)}
                    {filteredLocations.length === 0 && !error && (
                        <div className="workspace-switcher-empty">
                            No open workspaces match your search.
                        </div>
                    )}
                    {error && (
                        <div className="workspace-switcher-error" role="alert">
                            {error}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );

    function renderGroup(
        label: string,
        entries: readonly DisplayWorkspaceLocation[],
    ) {
        if (entries.length === 0) {
            return null;
        }
        return (
            <section aria-label={label} className="workspace-switcher-group">
                <h2>{label}</h2>
                {entries.map((entry) => {
                    const itemIndex = displayIndex++;
                    const selected = itemIndex === selectedIndex;
                    return (
                        <button
                            aria-selected={selected}
                            className="workspace-switcher-item"
                            data-selected={selected || undefined}
                            key={`${entry.location.hostWindowId}:${entry.location.contextKey}`}
                            onClick={() => void activate(entry)}
                            onMouseEnter={() => setSelectedIndex(itemIndex)}
                            role="option"
                            type="button"
                        >
                            <span className="workspace-switcher-item-copy">
                                <strong>{entry.projectName}</strong>
                                <span>{entry.worktreeLabel}</span>
                            </span>
                            <span className="workspace-switcher-window">
                                {entry.location.isActive ? "Active · " : ""}
                                {entry.location.windowTitle}
                            </span>
                        </button>
                    );
                })}
            </section>
        );
    }
}
