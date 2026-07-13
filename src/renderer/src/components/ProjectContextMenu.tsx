import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";

import type { GitRepositorySnapshot, GitWorktreeSummary } from "@shared/ipc";

import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";

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
    readonly onCloneRepository: (repositoryUrl: string) => Promise<boolean>;
    readonly onClose: () => void;
    readonly onOpenProject: (projectId: string) => void;
    readonly onOpenProjects: () => void;
    readonly onOpenSettings: (initialCategory?: "updates") => void;
    readonly onOpenWorktree: (projectId: string, worktreeId: string) => void;
    readonly projects: readonly ProjectContextMenuProject[];
    readonly settingsLabel: string | null;
}

export function ProjectContextMenu({
    onCloneRepository,
    onClose,
    onOpenProject,
    onOpenProjects,
    onOpenSettings,
    onOpenWorktree,
    projects,
    settingsLabel,
}: ProjectContextMenuProps) {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [cloneMode, setCloneMode] = useState(false);
    const [cloneUrl, setCloneUrl] = useState("");
    const [cloneError, setCloneError] = useState<string | null>(null);
    const [cloneSubmitting, setCloneSubmitting] = useState(false);
    const [worktreeBranchName, setWorktreeBranchName] = useState("");
    const [worktreeError, setWorktreeError] = useState<string | null>(null);
    const [worktreeProjectId, setWorktreeProjectId] = useState<string | null>(
        null,
    );
    const [worktreeSubmitting, setWorktreeSubmitting] = useState(false);
    const normalizedQuery = query.trim().toLowerCase();
    const searchRef = useRef<HTMLInputElement | null>(null);
    const projectSummaries = useProjectsStore((state) => state.projects);
    const gitSnapshots = useGitStore((state) => state.snapshots);
    const createWorktree = useGitStore((state) => state.createWorktree);
    const openContext = useWorkspaceStore((state) => state.openContext);
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

    const selectableEntries = useMemo(
        () =>
            filteredProjects.flatMap((project) => {
                return [
                    { projectId: project.id, worktreeId: null },
                    ...project.worktrees.map((worktree) => ({
                        projectId: project.id,
                        worktreeId: worktree.id,
                    })),
                ];
            }),
        [filteredProjects],
    );

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        setSelectedIndex((currentIndex) =>
            Math.min(currentIndex, Math.max(selectableEntries.length - 1, 0)),
        );
    }, [selectableEntries.length]);

    const runAndClose = (action: () => void) => {
        onClose();
        queueMicrotask(action);
    };

    const openSelectableEntry = (index: number) => {
        const entry = selectableEntries[index];
        if (!entry) {
            return;
        }

        runAndClose(() => {
            if (entry.worktreeId) {
                onOpenWorktree(entry.projectId, entry.worktreeId);
                return;
            }
            onOpenProject(entry.projectId);
        });
    };

    const handleSearchKeyDown = (
        event: KeyboardEvent<HTMLInputElement>,
    ) => {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            openSelectableEntry(selectedIndex);
            return;
        }

        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
        }

        event.preventDefault();
        if (selectableEntries.length === 0) {
            return;
        }
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex(
            (currentIndex) =>
                (currentIndex + direction + selectableEntries.length) %
                selectableEntries.length,
        );
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

    const worktreeProject = worktreeProjectId
        ? (projects.find((project) => project.id === worktreeProjectId) ?? null)
        : null;
    const worktreeProjectSummary = worktreeProject
        ? (projectSummaries.find(
              (project) => project.id === worktreeProject.id,
          ) ?? null)
        : null;
    const worktreeSnapshot = worktreeProject
        ? findProjectSnapshot(gitSnapshots, worktreeProject.id)
        : null;
    const worktreeBaseBranch = resolveWorktreeBaseBranch(worktreeSnapshot);

    const handleCreateWorktree = async () => {
        const branchName = worktreeBranchName.trim();
        if (!worktreeProject || !worktreeProjectSummary || !branchName) {
            setWorktreeError("Enter a branch name to create the worktree.");
            return;
        }
        if (!worktreeSnapshot || !worktreeBaseBranch) {
            setWorktreeError("This project does not have a branch to use as a base.");
            return;
        }

        setWorktreeError(null);
        setWorktreeSubmitting(true);
        try {
            const createdWorktree = await createWorktree({
                branchName,
                path: buildSuggestedWorktreePath(
                    worktreeProjectSummary.rootPath,
                    branchName,
                    worktreeSnapshot.worktrees,
                ),
                projectId: worktreeProject.id,
                startPoint: worktreeBaseBranch,
                worktreeId: null,
            });
            await openContext(worktreeProject.id, createdWorktree.id, {
                emptyLayout: true,
            });
            onClose();
        } catch (error) {
            setWorktreeError(
                error instanceof Error
                    ? error.message
                    : "Could not create the worktree.",
            );
        } finally {
            setWorktreeSubmitting(false);
        }
    };

    if (worktreeProject) {
        return (
            <ProjectContextModal onClose={onClose}>
                <div className="project-context-worktree-form">
                    <div className="project-context-menu-heading">
                        New worktree
                    </div>
                    <div className="project-context-worktree-project">
                        {worktreeProject.name}
                    </div>
                    <input
                        autoFocus
                        className="project-context-clone-input"
                        disabled={worktreeSubmitting}
                        onChange={(event) => {
                            setWorktreeBranchName(event.target.value);
                            setWorktreeError(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void handleCreateWorktree();
                            }
                        }}
                        placeholder="feature/my-branch"
                        spellCheck={false}
                        value={worktreeBranchName}
                    />
                    <div className="project-context-worktree-hint">
                        {worktreeBaseBranch
                            ? `Creates a branch from ${worktreeBaseBranch}`
                            : "A Git branch is required"}
                    </div>
                    {worktreeError && (
                        <div className="project-context-clone-error">
                            {worktreeError}
                        </div>
                    )}
                    <div className="project-context-clone-actions">
                        <button
                            disabled={worktreeSubmitting}
                            onClick={() => {
                                setWorktreeProjectId(null);
                                setWorktreeError(null);
                            }}
                            type="button"
                        >
                            Back
                        </button>
                        <button
                            disabled={
                                worktreeSubmitting ||
                                !worktreeBranchName.trim() ||
                                !worktreeBaseBranch
                            }
                            onClick={() => void handleCreateWorktree()}
                            type="button"
                        >
                            {worktreeSubmitting ? "Creating…" : "Create worktree"}
                        </button>
                    </div>
                </div>
            </ProjectContextModal>
        );
    }

    if (cloneMode) {
        return (
            <ProjectContextModal onClose={onClose}>
                <div
                    aria-label="Clone repository"
                    className="project-context-clone-form"
                >
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
            </ProjectContextModal>
        );
    }

    return (
        <ProjectContextModal onClose={onClose}>
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
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search projects and worktrees…"
                    ref={searchRef}
                    spellCheck={false}
                    value={query}
                />
                <span>{filteredProjects.length}/{projects.length}</span>
            </div>

            <div className="project-context-project-list">
                {filteredProjects.map((project) => {
                    return (
                        <div
                            className="project-context-project-group"
                            key={project.id}
                        >
                            <div className="project-context-project-row">
                                <button
                                    className="project-context-project-main"
                                    data-selected={
                                        selectableEntries[selectedIndex]
                                            ?.projectId === project.id &&
                                        selectableEntries[selectedIndex]
                                            ?.worktreeId === null
                                            ? "true"
                                            : undefined
                                    }
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
                                <button
                                    className="project-context-new-worktree-trigger"
                                    onClick={() => {
                                        setWorktreeBranchName("");
                                        setWorktreeError(null);
                                        setWorktreeProjectId(project.id);
                                    }}
                                    type="button"
                                >
                                    New worktree
                                </button>
                            </div>
                            {project.worktrees.length > 0 && (
                                <div className="project-context-worktree-list">
                                    {project.worktrees.map((worktree) => (
                                        <button
                                            className="project-context-worktree-row"
                                            data-selected={
                                                selectableEntries[selectedIndex]
                                                    ?.projectId === project.id &&
                                                selectableEntries[selectedIndex]
                                                    ?.worktreeId === worktree.id
                                                    ? "true"
                                                    : undefined
                                            }
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
                    onClick={() =>
                        runAndClose(() =>
                            onOpenSettings(
                                settingsLabel ? "updates" : undefined,
                            ),
                        )
                    }
                    type="button"
                >
                    <span>{settingsLabel ?? "Settings"}</span>
                    {settingsLabel ? (
                        <span
                            aria-hidden="true"
                            className="project-context-update-dot"
                        />
                    ) : null}
                </button>
            </div>
            <div className="project-context-menu-footer">
                <span>↑↓ Navigate · Enter Open · Esc Close</span>
            </div>
        </ProjectContextModal>
    );
}

function ProjectContextModal({
    children,
    onClose,
}: {
    readonly children: ReactNode;
    readonly onClose: () => void;
}) {
    return (
        <div
            className="project-context-menu-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                aria-label="Open workspace"
                aria-modal="true"
                className="project-context-menu"
                role="dialog"
            >
                {children}
            </div>
        </div>
    );
}

function findProjectSnapshot(
    snapshots: Record<string, GitRepositorySnapshot | null>,
    projectId: string,
): GitRepositorySnapshot | null {
    return (
        Object.values(snapshots).find(
            (snapshot) => snapshot?.projectId === projectId,
        ) ?? null
    );
}

function resolveWorktreeBaseBranch(
    snapshot: GitRepositorySnapshot | null,
): string | null {
    const primaryWorktree = snapshot?.worktrees.find(
        (worktree) => worktree.isPrimary,
    );
    return primaryWorktree?.branchName ?? snapshot?.branch?.name ?? null;
}

function buildSuggestedWorktreePath(
    rootPath: string,
    branchName: string,
    worktrees: readonly GitWorktreeSummary[],
): string {
    const normalizedRoot = rootPath.replace(/[\\/]+$/, "");
    const suffix = branchName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, "-")
        .replace(/[\\/]+/g, "-")
        .replace(/^-+|-+$/g, "") || "worktree";
    const existingPaths = new Set(
        worktrees.map((worktree) =>
            worktree.rootPath.replace(/[\\/]+$/, ""),
        ),
    );
    let candidate = `${normalizedRoot}-${suffix}`;
    let index = 2;

    while (existingPaths.has(candidate)) {
        candidate = `${normalizedRoot}-${suffix}-${index}`;
        index += 1;
    }

    return candidate;
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
