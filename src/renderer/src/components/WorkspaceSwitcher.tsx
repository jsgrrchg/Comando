import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { useModalFocusScope } from "./accessibility/useModalFocusScope";

export interface WorkspaceSwitcherEntry {
    readonly isMissing: boolean;
    readonly projectId: string;
    readonly projectName: string;
    readonly scopeKey: string;
    readonly statusLabel: string | null;
    readonly worktreeLabel: string;
}

interface WorkspaceSwitcherProps {
    readonly entries: readonly WorkspaceSwitcherEntry[];
    readonly onActivate: (scopeKey: string) => Promise<void>;
    readonly onClose: () => void;
    readonly open: boolean;
}

export function WorkspaceSwitcher({
    entries,
    onActivate,
    onClose,
    open,
}: WorkspaceSwitcherProps) {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [activatingScopeKey, setActivatingScopeKey] = useState<string | null>(
        null,
    );
    const id = useId();
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    useModalFocusScope({
        active: open,
        containerRef: dialogRef,
        initialFocusRef: inputRef,
        modalRootRef: backdropRef,
        onDismiss: onClose,
    });

    useEffect(() => {
        if (!open) {
            return;
        }
        setQuery("");
        setSelectedIndex(0);
        setError(null);
        setActivatingScopeKey(null);
    }, [open]);

    const normalizedQuery = query.trim().toLowerCase();
    const filteredEntries = useMemo(
        () =>
            entries.filter(
                (entry) =>
                    !normalizedQuery ||
                    [
                        entry.projectName,
                        entry.worktreeLabel,
                        entry.scopeKey,
                    ]
                        .join(" ")
                        .toLowerCase()
                        .includes(normalizedQuery),
            ),
        [entries, normalizedQuery],
    );
    const groupedEntries = useMemo(() => {
        const groups: Array<{
            readonly projectId: string;
            readonly projectName: string;
            readonly workspaces: WorkspaceSwitcherEntry[];
        }> = [];
        for (const entry of filteredEntries) {
            const existing = groups.find(
                (group) => group.projectId === entry.projectId,
            );
            if (existing) {
                existing.workspaces.push(entry);
            } else {
                groups.push({
                    projectId: entry.projectId,
                    projectName: entry.projectName,
                    workspaces: [entry],
                });
            }
        }
        return groups;
    }, [filteredEntries]);

    useEffect(() => {
        setSelectedIndex((current) =>
            filteredEntries.length === 0
                ? 0
                : Math.min(current, filteredEntries.length - 1),
        );
    }, [filteredEntries.length]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const selected = listRef.current?.querySelector<HTMLElement>(
            "[data-selected='true']",
        );
        if (typeof selected?.scrollIntoView === "function") {
            selected.scrollIntoView({ block: "nearest" });
        }
    }, [open, selectedIndex]);

    if (!open || typeof document === "undefined") {
        return null;
    }

    const activate = async (entry: WorkspaceSwitcherEntry) => {
        if (activatingScopeKey) {
            return;
        }
        setError(null);
        setActivatingScopeKey(entry.scopeKey);
        try {
            await onActivate(entry.scopeKey);
            onClose();
        } catch (cause) {
            setError(
                cause instanceof Error && cause.message
                    ? cause.message
                    : "Could not switch workspaces.",
            );
            setActivatingScopeKey(null);
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
            if (filteredEntries.length === 0) {
                return;
            }
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setSelectedIndex(
                (current) =>
                    (current + direction + filteredEntries.length) %
                    filteredEntries.length,
            );
            return;
        }
        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            if (filteredEntries.length > 0) {
                setSelectedIndex(
                    event.key === "Home" ? 0 : filteredEntries.length - 1,
                );
            }
            return;
        }
        if (event.key === "Enter") {
            const selected = filteredEntries[selectedIndex];
            if (selected) {
                event.preventDefault();
                void activate(selected);
            }
        }
    };

    let displayIndex = 0;
    const listboxId = `${id}-listbox`;
    const selectedOptionId = filteredEntries[selectedIndex]
        ? `${id}-option-${selectedIndex}`
        : undefined;
    return createPortal(
        <div
            className="project-context-menu-backdrop"
            onMouseDown={(event) => {
                if (event.currentTarget === event.target) {
                    onClose();
                }
            }}
            ref={backdropRef}
        >
            <div
                aria-label="Switch workspace"
                aria-modal="true"
                className="project-context-menu workspace-switcher"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
            >
                <label className="project-context-search-shell">
                    <span aria-hidden="true">⌕</span>
                    <input
                        aria-activedescendant={selectedOptionId}
                        aria-autocomplete="list"
                        aria-controls={listboxId}
                        aria-expanded="true"
                        aria-label="Search all workspaces"
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search projects and worktrees"
                        ref={inputRef}
                        role="combobox"
                        value={query}
                    />
                    <span>{filteredEntries.length}</span>
                </label>
                <div
                    aria-label="Available workspaces"
                    className="workspace-switcher-list"
                    id={listboxId}
                    ref={listRef}
                    role="listbox"
                >
                    {groupedEntries.map((group) => (
                        <section
                            aria-label={group.projectName}
                            className="workspace-switcher-group"
                            key={group.projectId}
                            role="group"
                        >
                            <h2>{group.projectName}</h2>
                            {group.workspaces.map((entry) => {
                                const itemIndex = displayIndex++;
                                const selected = itemIndex === selectedIndex;
                                return (
                                    <button
                                        aria-label={`${entry.projectName}, ${entry.worktreeLabel}${entry.isMissing ? ", path missing" : ""}`}
                                        aria-selected={selected}
                                        className="workspace-switcher-item"
                                        data-selected={selected || undefined}
                                        id={`${id}-option-${itemIndex}`}
                                        key={entry.scopeKey}
                                        onClick={() => void activate(entry)}
                                        onMouseEnter={() =>
                                            setSelectedIndex(itemIndex)
                                        }
                                        role="option"
                                        type="button"
                                    >
                                        <span className="workspace-switcher-item-copy">
                                            <strong>{entry.worktreeLabel}</strong>
                                            <span>
                                                {entry.isMissing
                                                    ? "Saved workspace · Path missing"
                                                    : "Workspace"}
                                            </span>
                                        </span>
                                        <span className="workspace-switcher-window">
                                            {activatingScopeKey === entry.scopeKey
                                                ? "Opening…"
                                                : entry.statusLabel}
                                        </span>
                                    </button>
                                );
                            })}
                        </section>
                    ))}
                    {filteredEntries.length === 0 && !error ? (
                        <div className="workspace-switcher-empty">
                            No workspaces match your search.
                        </div>
                    ) : null}
                    {error ? (
                        <div
                            aria-live="assertive"
                            className="workspace-switcher-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>,
        document.body,
    );
}
