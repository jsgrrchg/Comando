import {
    useId,
    useRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
} from "react";

import type { WorkspaceInspectorView } from "@shared/ipc";

const INSPECTOR_VIEWS: readonly WorkspaceInspectorView[] = [
    "files",
    "agents",
    "git",
    "issues",
    "pull_requests",
];

const VIEW_COPY: Record<
    WorkspaceInspectorView,
    {
        readonly label: string;
        readonly searchAriaLabel: string;
        readonly searchPlaceholder: string;
    }
> = {
    agents: {
        label: "Agents",
        searchAriaLabel: "Filter threads",
        searchPlaceholder: "Filter threads...",
    },
    files: {
        label: "Files",
        searchAriaLabel: "Filter files",
        searchPlaceholder: "Filter files...",
    },
    git: {
        label: "Git",
        searchAriaLabel: "Filter changes",
        searchPlaceholder: "Filter changes...",
    },
    issues: {
        label: "Issues",
        searchAriaLabel: "Search issues",
        searchPlaceholder: "Search issues...",
    },
    pull_requests: {
        label: "Pull Requests",
        searchAriaLabel: "Search pull requests",
        searchPlaceholder: "Search pull requests...",
    },
};

interface WorkspaceInspectorProps {
    readonly activeView: WorkspaceInspectorView;
    readonly error: string | null;
    readonly filter: string;
    readonly gitScopePicker?: ReactNode;
    readonly hasCommittedWorkspace: boolean;
    readonly loading: boolean;
    readonly onChangeFilter: (value: string) => void;
    readonly onChangeView: (view: WorkspaceInspectorView) => void;
    readonly panels: Readonly<Record<WorkspaceInspectorView, ReactNode>>;
}

export function WorkspaceInspector({
    activeView,
    error,
    filter,
    gitScopePicker,
    hasCommittedWorkspace,
    loading,
    onChangeFilter,
    onChangeView,
    panels,
}: WorkspaceInspectorProps) {
    const id = useId();
    const tabRefs = useRef(new Map<WorkspaceInspectorView, HTMLButtonElement>());
    const copy = VIEW_COPY[activeView];

    const selectViewFromKeyboard = (
        event: ReactKeyboardEvent<HTMLButtonElement>,
        view: WorkspaceInspectorView,
    ) => {
        const currentIndex = INSPECTOR_VIEWS.indexOf(view);
        let targetIndex: number | null = null;

        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            targetIndex =
                (currentIndex - 1 + INSPECTOR_VIEWS.length) %
                INSPECTOR_VIEWS.length;
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            targetIndex = (currentIndex + 1) % INSPECTOR_VIEWS.length;
        } else if (event.key === "Home") {
            targetIndex = 0;
        } else if (event.key === "End") {
            targetIndex = INSPECTOR_VIEWS.length - 1;
        }

        if (targetIndex === null) {
            return;
        }

        event.preventDefault();
        const targetView = INSPECTOR_VIEWS[targetIndex];
        if (!targetView) {
            return;
        }
        onChangeView(targetView);
        requestAnimationFrame(() => tabRefs.current.get(targetView)?.focus());
    };

    return (
        <section
            aria-label="Workspace inspector"
            className="flex h-full min-h-0 flex-col"
            data-workspace-inspector="true"
        >
            <div className="px-2 pt-1">
                <div
                    aria-label="Workspace inspector views"
                    className="flex items-center gap-1"
                    role="tablist"
                >
                    {INSPECTOR_VIEWS.map((view) => {
                        const selected = view === activeView;
                        const label = VIEW_COPY[view].label;
                        const compact =
                            view === "issues" || view === "pull_requests";
                        return (
                            <button
                                aria-controls={`${id}-panel`}
                                aria-label={label}
                                aria-selected={selected}
                                className={[
                                    "workspace-inspector-tab sidebar-action-row sidebar-action-row--compact app-no-drag",
                                    compact
                                        ? "sidebar-action-row--icon shrink-0"
                                        : "min-w-0 flex-1",
                                    selected
                                        ? "sidebar-action-row--active"
                                        : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                data-inspector-view={view}
                                id={`${id}-${view}-tab`}
                                key={view}
                                onClick={() => onChangeView(view)}
                                onKeyDown={(event) =>
                                    selectViewFromKeyboard(event, view)
                                }
                                ref={(node) => {
                                    if (node) {
                                        tabRefs.current.set(view, node);
                                    } else {
                                        tabRefs.current.delete(view);
                                    }
                                }}
                                role="tab"
                                tabIndex={selected ? 0 : -1}
                                title={label}
                                type="button"
                            >
                                <InspectorViewIcon view={view} />
                                {compact ? null : (
                                    <span className="workspace-inspector-tab__label">
                                        {label}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {activeView === "git" && hasCommittedWorkspace ? (
                    <div className="mt-1" data-workspace-inspector-git-scope>
                        {gitScopePicker}
                    </div>
                ) : null}

                <div className="sidebar-search app-no-drag mt-1">
                    <span aria-hidden="true" className="sidebar-search-icon">
                        <SearchIcon />
                    </span>
                    <input
                        aria-label={copy.searchAriaLabel}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="sidebar-search-input"
                        disabled={!hasCommittedWorkspace || loading}
                        onChange={(event) => onChangeFilter(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                onChangeFilter("");
                            }
                        }}
                        placeholder={copy.searchPlaceholder}
                        spellCheck={false}
                        type="text"
                        value={filter}
                    />
                    {filter.length > 0 ? (
                        <button
                            aria-label="Clear filter"
                            className="sidebar-search-clear"
                            onClick={() => onChangeFilter("")}
                            title="Clear filter"
                            type="button"
                        >
                            ×
                        </button>
                    ) : null}
                </div>

                {error ? (
                    <div
                        className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-[var(--diff-remove)]"
                        role="alert"
                    >
                        {error}
                    </div>
                ) : null}
            </div>

            <div
                aria-labelledby={`${id}-${activeView}-tab`}
                className="flex min-h-0 flex-1 flex-col"
                id={`${id}-panel`}
                role="tabpanel"
            >
                {loading ? (
                    <InspectorState copy="Loading workspace inspector..." />
                ) : !hasCommittedWorkspace ? (
                    <InspectorState copy="Choose a workspace to inspect its files and activity." />
                ) : (
                    panels[activeView]
                )}
            </div>
        </section>
    );
}

function InspectorState({ copy }: { readonly copy: string }) {
    return (
        <div className="px-4 py-5 text-xs text-text-secondary" role="status">
            {copy}
        </div>
    );
}

function InspectorViewIcon({ view }: { readonly view: WorkspaceInspectorView }) {
    if (view === "files") {
        return (
            <svg
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
            >
                <path
                    d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                    fill="currentColor"
                    opacity="0.55"
                />
            </svg>
        );
    }
    if (view === "git") {
        return (
            <svg
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
            >
                <circle
                    cx="4.5"
                    cy="4"
                    r="1.6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <circle
                    cx="4.5"
                    cy="12"
                    r="1.6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <circle
                    cx="11.5"
                    cy="4"
                    r="1.6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <path
                    d="M4.5 5.6v4.8"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.2"
                />
                <path
                    d="M11.5 5.6v1.4A2.5 2.5 0 0 1 9 9.5H7a2.5 2.5 0 0 0-2.5 2.5"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.2"
                />
            </svg>
        );
    }
    if (view === "agents") {
        return (
            <svg
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
            >
                <rect
                    fill="currentColor"
                    fillOpacity="0.15"
                    height="7"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    width="8.5"
                    x="3.75"
                    y="5.5"
                />
                <path
                    d="M8 5.5V3.4"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.2"
                />
                <circle cx="8" cy="2.8" fill="currentColor" r="0.95" />
                <circle cx="6.3" cy="9" fill="currentColor" r="1" />
                <circle cx="9.7" cy="9" fill="currentColor" r="1" />
            </svg>
        );
    }
    if (view === "issues") {
        return (
            <svg
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 16 16"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="5.2"
                    stroke="currentColor"
                    strokeWidth="1.15"
                />
                <path
                    d="M8 4.9v3.8"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.25"
                />
                <circle cx="8" cy="11.1" fill="currentColor" r="0.75" />
            </svg>
        );
    }
    return (
        <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0"
            fill="none"
            viewBox="0 0 16 16"
        >
            <circle cx="5" cy="4" fill="currentColor" r="1.2" />
            <circle cx="5" cy="12" fill="currentColor" r="1.2" />
            <circle cx="11" cy="8" fill="currentColor" r="1.2" />
            <path
                d="M5 5.2v5.6M6.2 4H8a3 3 0 0 1 3 3v0"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.15"
            />
        </svg>
    );
}

function SearchIcon() {
    return (
        <svg fill="none" height="12" viewBox="0 0 16 16" width="12">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
        </svg>
    );
}
