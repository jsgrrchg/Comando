import { useMemo, useState } from "react";

export interface ProjectContextMenuProject {
    readonly id: string;
    readonly mainIsActive: boolean;
    readonly mainIsOpen: boolean;
    readonly name: string;
    readonly worktrees: readonly {
        readonly id: string;
        readonly isActive: boolean;
        readonly isOpen: boolean;
        readonly label: string;
    }[];
}

interface ProjectContextMenuProps {
    readonly anchorLeft: number;
    readonly onCloneRepository: (repositoryUrl: string) => Promise<boolean>;
    readonly onClose: () => void;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: () => void;
    readonly onOpenWorktree: (projectId: string, worktreeId: string) => void;
    readonly projects: readonly ProjectContextMenuProject[];
}

export function ProjectContextMenu({
    anchorLeft,
    onCloneRepository,
    onClose,
    onOpenProject,
    onOpenProjects,
    onOpenSettings,
    onOpenWorktree,
    projects,
}: ProjectContextMenuProps) {
    const [query, setQuery] = useState("");
    const [cloneMode, setCloneMode] = useState(false);
    const [cloneUrl, setCloneUrl] = useState("");
    const [cloneError, setCloneError] = useState<string | null>(null);
    const [cloneSubmitting, setCloneSubmitting] = useState(false);
    const [expandedProjectIds, setExpandedProjectIds] = useState<
        ReadonlySet<string>
    >(
        () =>
            new Set(
                projects
                    .filter(
                        (project) =>
                            project.mainIsActive ||
                            project.worktrees.some((worktree) => worktree.isActive),
                    )
                    .map((project) => project.id),
            ),
    );
    const normalizedQuery = query.trim().toLowerCase();
    const filteredProjects = useMemo(
        () =>
            projects.flatMap((project) => {
                if (!normalizedQuery) {
                    return [project];
                }

                const projectMatches = project.name
                    .toLowerCase()
                    .includes(normalizedQuery);
                const matchingWorktrees = project.worktrees.filter((worktree) =>
                    worktree.label.toLowerCase().includes(normalizedQuery),
                );
                if (!projectMatches && matchingWorktrees.length === 0) {
                    return [];
                }

                return [
                    {
                        ...project,
                        worktrees: projectMatches
                            ? project.worktrees
                            : matchingWorktrees,
                    },
                ];
            }),
        [normalizedQuery, projects],
    );

    const runAndClose = (action: () => void) => {
        onClose();
        queueMicrotask(action);
    };

    const handleCloneSubmit = async () => {
        const repositoryUrl = cloneUrl.trim();
        if (!repositoryUrl) {
            setCloneError("Paste a repository URL before cloning.");
            return;
        }

        setCloneSubmitting(true);
        setCloneError(null);
        try {
            if (await onCloneRepository(repositoryUrl)) {
                onClose();
            } else {
                setCloneSubmitting(false);
            }
        } catch (error) {
            setCloneSubmitting(false);
            setCloneError(
                error instanceof Error
                    ? error.message
                    : "Could not clone the repository.",
            );
        }
    };

    if (cloneMode) {
        return (
            <div
                aria-label="Clone repository"
                className="project-context-menu"
                role="dialog"
                style={{ left: anchorLeft }}
            >
                <div className="project-context-clone-form">
                    <div className="project-context-menu-heading">
                        Clone repository
                    </div>
                    <input
                        autoFocus
                        className="project-context-clone-input"
                        disabled={cloneSubmitting}
                        onChange={(event) => {
                            setCloneUrl(event.target.value);
                            setCloneError(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void handleCloneSubmit();
                            }
                        }}
                        placeholder="https://github.com/user/repo.git"
                        spellCheck={false}
                        value={cloneUrl}
                    />
                    {cloneError && (
                        <div className="project-context-clone-error">
                            {cloneError}
                        </div>
                    )}
                    <div className="project-context-clone-actions">
                        <button
                            onClick={() => {
                                setCloneMode(false);
                                setCloneError(null);
                            }}
                            type="button"
                        >
                            Back
                        </button>
                        <button
                            disabled={cloneSubmitting}
                            onClick={() => void handleCloneSubmit()}
                            type="button"
                        >
                            {cloneSubmitting ? "Cloning…" : "Clone"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            aria-label="Open workspace"
            className="project-context-menu"
            role="dialog"
            style={{ left: anchorLeft }}
        >
            <div className="project-context-search-shell">
                <svg
                    aria-hidden="true"
                    fill="none"
                    height="13"
                    viewBox="0 0 14 14"
                    width="13"
                >
                    <circle cx="6" cy="6" r="3.5" stroke="currentColor" />
                    <path
                        d="m8.7 8.7 2.6 2.6"
                        stroke="currentColor"
                        strokeLinecap="round"
                    />
                </svg>
                <input
                    aria-label="Search projects and worktrees"
                    autoFocus
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search projects and worktrees…"
                    spellCheck={false}
                    value={query}
                />
                <span>{filteredProjects.length}/{projects.length}</span>
            </div>

            <div className="project-context-project-list">
                {filteredProjects.map((project) => {
                    const expanded =
                        normalizedQuery.length > 0 ||
                        expandedProjectIds.has(project.id);
                    return (
                        <div
                            className="project-context-project-group"
                            key={project.id}
                        >
                            <div className="project-context-project-row">
                                <button
                                    className="project-context-project-main"
                                    onClick={() =>
                                        runAndClose(() =>
                                            onOpenProject(project.id),
                                        )
                                    }
                                    type="button"
                                >
                                    <ContextStateIndicator
                                        active={project.mainIsActive}
                                        open={project.mainIsOpen}
                                    />
                                    <span className="truncate">
                                        {project.name}
                                    </span>
                                    <span className="project-context-menu-hint">
                                        Main
                                    </span>
                                </button>
                                {project.worktrees.length > 0 && (
                                    <button
                                        aria-expanded={expanded}
                                        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name} worktrees`}
                                        className="project-context-disclosure"
                                        onClick={() => {
                                            setExpandedProjectIds(
                                                (currentProjectIds) => {
                                                    const nextProjectIds = new Set(
                                                        currentProjectIds,
                                                    );
                                                    if (expanded) {
                                                        nextProjectIds.delete(
                                                            project.id,
                                                        );
                                                    } else {
                                                        nextProjectIds.add(
                                                            project.id,
                                                        );
                                                    }
                                                    return nextProjectIds;
                                                },
                                            );
                                        }}
                                        type="button"
                                    >
                                        <svg
                                            aria-hidden="true"
                                            fill="none"
                                            height="12"
                                            viewBox="0 0 12 12"
                                            width="12"
                                        >
                                            <path
                                                d="m4.5 3 3 3-3 3"
                                                stroke="currentColor"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                style={{
                                                    transform: expanded
                                                        ? "rotate(90deg)"
                                                        : undefined,
                                                    transformOrigin: "center",
                                                }}
                                            />
                                        </svg>
                                    </button>
                                )}
                            </div>
                            {expanded && project.worktrees.length > 0 && (
                                <div className="project-context-worktree-list">
                                    {project.worktrees.map((worktree) => (
                                        <button
                                            className="project-context-worktree-row"
                                            key={worktree.id}
                                            onClick={() =>
                                                runAndClose(() =>
                                                    onOpenWorktree(
                                                        project.id,
                                                        worktree.id,
                                                    ),
                                                )
                                            }
                                            type="button"
                                        >
                                            <ContextStateIndicator
                                                active={worktree.isActive}
                                                open={worktree.isOpen}
                                            />
                                            <svg
                                                aria-hidden="true"
                                                className="project-context-branch-icon"
                                                fill="none"
                                                height="13"
                                                viewBox="0 0 14 14"
                                                width="13"
                                            >
                                                <circle cx="4" cy="3" r="1.25" />
                                                <circle cx="4" cy="11" r="1.25" />
                                                <circle cx="10" cy="5" r="1.25" />
                                                <path d="M4 4.5v5M5.25 8c2.8 0 4.75-.8 4.75-1.75" />
                                            </svg>
                                            <span className="truncate">
                                                {worktree.label}
                                            </span>
                                            {worktree.isOpen && (
                                                <span className="project-context-open-label">
                                                    Open
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                {filteredProjects.length === 0 && (
                    <div className="project-context-menu-empty">
                        No matching projects or worktrees
                    </div>
                )}
            </div>

            <div className="project-context-menu-separator" />
            <div className="project-context-menu-actions">
                <button
                    onClick={() => runAndClose(onOpenProjects)}
                    type="button"
                >
                    Open folder…
                </button>
                <button onClick={() => setCloneMode(true)} type="button">
                    Clone repository…
                </button>
                <button
                    onClick={() => runAndClose(onOpenSettings)}
                    type="button"
                >
                    Settings
                </button>
            </div>
        </div>
    );
}

function ContextStateIndicator({
    active,
    open,
}: {
    readonly active: boolean;
    readonly open: boolean;
}) {
    return (
        <span
            aria-hidden="true"
            className="project-context-state-indicator"
            data-active={active || undefined}
            data-open={open || undefined}
        >
            {active ? "✓" : ""}
        </span>
    );
}
