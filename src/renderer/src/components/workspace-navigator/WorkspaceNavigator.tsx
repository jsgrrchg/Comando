import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";

import type { NativeContextMenuEntry } from "@shared/ipc";

import type {
    WorkspaceNavigatorModel,
    WorkspaceNavigatorProject,
    WorkspaceNavigatorWorkspace,
} from "@renderer/app/workspace-navigator/model";

export interface WorkspaceNavigatorProps {
    readonly deleteUnavailableReason: string;
    readonly error: string | null;
    readonly expandedProjectIds: readonly string[];
    readonly model: WorkspaceNavigatorModel;
    readonly onActivate: (workspace: WorkspaceNavigatorWorkspace) => Promise<void>;
    readonly onCloneRepository: (repositoryUrl: string) => Promise<void>;
    readonly onCloseWorkspace: (
        workspace: WorkspaceNavigatorWorkspace,
    ) => Promise<void>;
    readonly onCopyPath: (workspace: WorkspaceNavigatorWorkspace) => Promise<void>;
    readonly onCreateWorktree: (
        project: WorkspaceNavigatorProject,
        branchName: string,
    ) => Promise<void>;
    readonly onOpenFolder: () => Promise<void>;
    readonly onOpenSettings: () => void;
    readonly onRemoveProject: (project: WorkspaceNavigatorProject) => Promise<void>;
    readonly onResetWorkspace: (
        workspace: WorkspaceNavigatorWorkspace,
    ) => Promise<void>;
    readonly onRetry: () => Promise<void>;
    readonly onRetryInventory: (
        project: WorkspaceNavigatorProject,
    ) => Promise<void>;
    readonly onRevealPath: (workspace: WorkspaceNavigatorWorkspace) => Promise<void>;
    readonly onSetProjectExpanded: (
        projectId: string,
        expanded: boolean,
    ) => void;
    readonly settingsLabel: string | null;
    readonly status: "idle" | "loading" | "ready" | "error";
}

type NavigatorDialog =
    | { readonly kind: "clone" }
    | { readonly kind: "delete"; readonly workspace: WorkspaceNavigatorWorkspace }
    | { readonly kind: "new-worktree"; readonly project: WorkspaceNavigatorProject }
    | { readonly kind: "recovery"; readonly workspace: WorkspaceNavigatorWorkspace }
    | { readonly kind: "reset"; readonly workspace: WorkspaceNavigatorWorkspace }
    | null;

type VisibleTreeItem =
    | { readonly id: string; readonly kind: "project"; readonly label: string; readonly project: WorkspaceNavigatorProject }
    | { readonly id: string; readonly kind: "workspace"; readonly label: string; readonly project: WorkspaceNavigatorProject; readonly workspace: WorkspaceNavigatorWorkspace };

const TYPEAHEAD_RESET_MS = 650;

export function WorkspaceNavigator({
    deleteUnavailableReason,
    error,
    expandedProjectIds,
    model,
    onActivate,
    onCloneRepository,
    onCloseWorkspace,
    onCopyPath,
    onCreateWorktree,
    onOpenFolder,
    onOpenSettings,
    onRemoveProject,
    onResetWorkspace,
    onRetry,
    onRetryInventory,
    onRevealPath,
    onSetProjectExpanded,
    settingsLabel,
    status,
}: WorkspaceNavigatorProps) {
    const [query, setQuery] = useState("");
    const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
    const [pendingScopeKey, setPendingScopeKey] = useState<string | null>(null);
    const [activationErrors, setActivationErrors] = useState<
        Readonly<Record<string, string>>
    >({});
    const [operationError, setOperationError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<NavigatorDialog>(null);
    const itemRefs = useRef(new Map<string, HTMLElement>());
    const initializedActiveProjectIdsRef = useRef(new Set<string>());
    const typeaheadRef = useRef({ query: "", updatedAt: 0 });
    const expandedProjectIdSet = useMemo(
        () => new Set(expandedProjectIds),
        [expandedProjectIds],
    );
    const normalizedQuery = query.trim().toLowerCase();
    const filteredProjects = useMemo(
        () =>
            model.projects.flatMap((project) => {
                if (!normalizedQuery) {
                    return [project];
                }
                const projectMatches = project.name
                    .toLowerCase()
                    .includes(normalizedQuery);
                const workspaces = project.workspaces.filter(
                    (workspace) =>
                        projectMatches ||
                        workspace.label.toLowerCase().includes(normalizedQuery) ||
                        workspace.rootPath?.toLowerCase().includes(normalizedQuery),
                );
                return workspaces.length > 0 ? [{ ...project, workspaces }] : [];
            }),
        [model.projects, normalizedQuery],
    );
    const visibleItems = useMemo(
        () =>
            filteredProjects.flatMap((project): readonly VisibleTreeItem[] => {
                const projectItem: VisibleTreeItem = {
                    id: `project:${project.id}`,
                    kind: "project",
                    label: project.name,
                    project,
                };
                const expanded =
                    Boolean(normalizedQuery) || expandedProjectIdSet.has(project.id);
                if (!expanded) {
                    return [projectItem];
                }
                return [
                    projectItem,
                    ...project.workspaces.map(
                        (workspace): VisibleTreeItem => ({
                            id: `workspace:${workspace.scopeKey}`,
                            kind: "workspace",
                            label: `${project.name} ${workspace.label}`,
                            project,
                            workspace,
                        }),
                    ),
                ];
            }),
        [expandedProjectIdSet, filteredProjects, normalizedQuery],
    );

    useEffect(() => {
        const activeProject = model.projects.find((project) =>
            project.workspaces.some(
                (workspace) => workspace.scopeKey === model.activeScopeKey,
            ),
        );
        if (
            !activeProject ||
            expandedProjectIdSet.has(activeProject.id) ||
            initializedActiveProjectIdsRef.current.has(activeProject.id)
        ) {
            return;
        }
        initializedActiveProjectIdsRef.current.add(activeProject.id);
        onSetProjectExpanded(activeProject.id, true);
    }, [
        expandedProjectIdSet,
        model.activeScopeKey,
        model.projects,
        onSetProjectExpanded,
    ]);

    useEffect(() => {
        if (
            focusedItemId &&
            visibleItems.some((item) => item.id === focusedItemId)
        ) {
            return;
        }
        setFocusedItemId(
            visibleItems.find(
                (item) =>
                    item.kind === "workspace" &&
                    item.workspace.scopeKey === model.activeScopeKey,
            )?.id ??
                visibleItems[0]?.id ??
                null,
        );
    }, [focusedItemId, model.activeScopeKey, visibleItems]);

    const focusItem = (id: string | null) => {
        if (!id) {
            return;
        }
        setFocusedItemId(id);
        itemRefs.current.get(id)?.focus();
    };

    const runWorkspaceActivation = async (
        workspace: WorkspaceNavigatorWorkspace,
    ) => {
        if (pendingScopeKey) {
            return;
        }
        setPendingScopeKey(workspace.scopeKey);
        setOperationError(null);
        setActivationErrors((current) => omitKey(current, workspace.scopeKey));
        try {
            await onActivate(workspace);
        } catch (cause) {
            const message = formatError(cause, "Could not open this workspace.");
            setActivationErrors((current) => ({
                ...current,
                [workspace.scopeKey]: message,
            }));
        } finally {
            setPendingScopeKey(null);
        }
    };

    const runOperation = async (
        operation: () => Promise<void>,
        fallbackMessage: string,
    ) => {
        setOperationError(null);
        try {
            await operation();
        } catch (cause) {
            setOperationError(formatError(cause, fallbackMessage));
        }
    };

    const handleTreeKeyDown = (
        event: KeyboardEvent<HTMLElement>,
        item: VisibleTreeItem,
    ) => {
        const currentIndex = visibleItems.findIndex(
            (candidate) => candidate.id === item.id,
        );
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = Math.max(
                0,
                Math.min(visibleItems.length - 1, currentIndex + direction),
            );
            focusItem(visibleItems[nextIndex]?.id ?? null);
            return;
        }
        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            focusItem(
                event.key === "Home"
                    ? visibleItems[0]?.id ?? null
                    : visibleItems.at(-1)?.id ?? null,
            );
            return;
        }
        if (event.key === "ArrowRight" && item.kind === "project") {
            event.preventDefault();
            if (!expandedProjectIdSet.has(item.project.id)) {
                onSetProjectExpanded(item.project.id, true);
                return;
            }
            focusItem(
                visibleItems.find(
                    (candidate) =>
                        candidate.kind === "workspace" &&
                        candidate.project.id === item.project.id,
                )?.id ?? null,
            );
            return;
        }
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (item.kind === "workspace") {
                focusItem(`project:${item.project.id}`);
            } else if (expandedProjectIdSet.has(item.project.id)) {
                onSetProjectExpanded(item.project.id, false);
            }
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (item.kind === "project") {
                onSetProjectExpanded(
                    item.project.id,
                    !expandedProjectIdSet.has(item.project.id),
                );
            } else {
                void runWorkspaceActivation(item.workspace);
            }
            return;
        }
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            void openNativeMenu(item, rect.left + 16, rect.bottom);
            return;
        }
        if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            event.key.length === 1 &&
            /\S/.test(event.key)
        ) {
            const now = event.timeStamp;
            const previous = typeaheadRef.current;
            const nextQuery = `${
                now - previous.updatedAt > TYPEAHEAD_RESET_MS
                    ? ""
                    : previous.query
            }${event.key.toLowerCase()}`;
            typeaheadRef.current = { query: nextQuery, updatedAt: now };
            const candidates = [
                ...visibleItems.slice(currentIndex + 1),
                ...visibleItems.slice(0, currentIndex + 1),
            ];
            focusItem(
                candidates.find((candidate) =>
                    candidate.label.toLowerCase().startsWith(nextQuery),
                )?.id ?? null,
            );
        }
    };

    const openNativeMenu = async (
        item: VisibleTreeItem,
        x: number,
        y: number,
    ) => {
        const entries =
            item.kind === "project"
                ? buildProjectMenuEntries(item.project)
                : buildWorkspaceMenuEntries(item.workspace);
        const action = await window.comando?.showNativeContextMenu({
            entries,
            x,
            y,
        });
        if (!action) {
            return;
        }
        if (item.kind === "project") {
            if (action === "new-worktree") {
                setDialog({ kind: "new-worktree", project: item.project });
            } else if (action === "reveal-project") {
                const primaryWorkspace = item.project.workspaces[0];
                if (!primaryWorkspace) {
                    return;
                }
                await runOperation(
                    () => onRevealPath(primaryWorkspace),
                    "Could not reveal this project.",
                );
            } else if (action === "retry-inventory") {
                await runOperation(
                    () => onRetryInventory(item.project),
                    "Could not refresh worktrees.",
                );
            } else if (action === "remove-project") {
                await runOperation(
                    () => onRemoveProject(item.project),
                    "Could not remove this project.",
                );
            }
            return;
        }

        const workspace = item.workspace;
        if (action === "activate") {
            await runWorkspaceActivation(workspace);
        } else if (action === "close") {
            await runOperation(
                () => onCloseWorkspace(workspace),
                "Could not close this workspace.",
            );
        } else if (action === "copy-path") {
            await runOperation(
                () => onCopyPath(workspace),
                "Could not copy this path.",
            );
        } else if (action === "reveal-path") {
            await runOperation(
                () => onRevealPath(workspace),
                "Could not reveal this workspace.",
            );
        } else if (action === "reset") {
            setDialog({ kind: "reset", workspace });
        } else if (action === "recovery") {
            setDialog({ kind: "recovery", workspace });
        } else if (action === "delete-worktree") {
            setDialog({ kind: "delete", workspace });
        }
    };

    const buildProjectMenuEntries = (
        project: WorkspaceNavigatorProject,
    ): readonly NativeContextMenuEntry[] => [
        {
            enabled: !project.isMissing && !project.inventoryLoading,
            id: "new-worktree",
            label: "New Worktree…",
        },
        {
            enabled: Boolean(project.rootPath),
            id: "reveal-project",
            label: "Reveal Project",
        },
        ...(project.inventoryError
            ? [
                  { type: "separator" as const },
                  {
                      enabled: true,
                      id: "retry-inventory",
                      label: "Retry Worktree Inventory",
                  },
              ]
            : []),
        { type: "separator" },
        {
            enabled:
                !project.isMissing &&
                project.workspaces.every(
                    (workspace) => workspace.catalogEntry.source === "registry",
                ),
            id: "remove-project",
            label: "Remove Project from Navigator",
        },
    ];

    const buildWorkspaceMenuEntries = (
        workspace: WorkspaceNavigatorWorkspace,
    ): readonly NativeContextMenuEntry[] => [
        {
            enabled: workspace.scopeKey !== model.activeScopeKey,
            id: "activate",
            label: "Activate Workspace",
        },
        {
            enabled: workspace.isResident,
            id: "close",
            label: "Close Workspace",
        },
        { type: "separator" },
        {
            enabled: Boolean(workspace.rootPath),
            id: "copy-path",
            label: "Copy Path",
        },
        {
            enabled: Boolean(workspace.rootPath),
            id: "reveal-path",
            label: "Reveal Path",
        },
        { type: "separator" },
        {
            enabled: workspace.catalogEntry.revision !== null,
            id: "reset",
            label: "Reset Workspace Layout…",
        },
        {
            enabled: workspace.recoveryLayouts.length > 0,
            id: "recovery",
            label: `Recovery Layouts (${workspace.recoveryLayouts.length})`,
        },
        ...(!workspace.isPrimary
            ? [
                  { type: "separator" as const },
                  {
                      enabled: true,
                      id: "delete-worktree",
                      label: "Delete Worktree…",
                  },
              ]
            : []),
    ];

    const renderProject = (project: WorkspaceNavigatorProject) => {
        const projectItem = visibleItems.find(
            (item) => item.id === `project:${project.id}`,
        );
        if (!projectItem) {
            return null;
        }
        const expanded =
            Boolean(normalizedQuery) || expandedProjectIdSet.has(project.id);
        return (
            <div className="workspace-navigator-project" key={project.id}>
                <div
                    aria-expanded={expanded}
                    aria-level={1}
                    className="workspace-navigator-project-row"
                    data-missing={project.isMissing || undefined}
                    onClick={() =>
                        onSetProjectExpanded(project.id, !expanded)
                    }
                    onContextMenu={(event) => {
                        event.preventDefault();
                        void openNativeMenu(
                            projectItem,
                            event.clientX,
                            event.clientY,
                        );
                    }}
                    onFocus={() => setFocusedItemId(projectItem.id)}
                    onKeyDown={(event) =>
                        handleTreeKeyDown(event, projectItem)
                    }
                    ref={(element) => setItemRef(itemRefs.current, projectItem.id, element)}
                    role="treeitem"
                    tabIndex={focusedItemId === projectItem.id ? 0 : -1}
                >
                    <span aria-hidden="true" className="workspace-navigator-disclosure">
                        {expanded ? "⌄" : "›"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.inventoryLoading ? (
                        <span className="workspace-navigator-spinner" title="Loading worktrees" />
                    ) : null}
                    {project.inventoryError ? (
                        <span aria-label="Worktree inventory unavailable" className="workspace-navigator-attention">
                            !
                        </span>
                    ) : null}
                </div>
                {expanded ? (
                    <div aria-label={`${project.name} workspaces`} role="group">
                        {project.workspaces.map((workspace) => {
                            const item = visibleItems.find(
                                (candidate) =>
                                    candidate.id === `workspace:${workspace.scopeKey}`,
                            );
                            if (!item) {
                                return null;
                            }
                            const localError = activationErrors[workspace.scopeKey];
                            const opening = pendingScopeKey === workspace.scopeKey;
                            const active = model.activeScopeKey === workspace.scopeKey;
                            return (
                                <div
                                    aria-current={active ? "page" : undefined}
                                    aria-describedby={
                                        localError
                                            ? `workspace-error-${workspace.scopeKey}`
                                            : undefined
                                    }
                                    aria-label={buildWorkspaceAccessibleLabel(
                                        project,
                                        workspace,
                                        opening,
                                        localError,
                                    )}
                                    aria-level={2}
                                    className="workspace-navigator-workspace-row"
                                    data-active={active || undefined}
                                    data-missing={workspace.isMissing || undefined}
                                    data-status={opening ? "warming" : localError ? "error" : workspace.status}
                                    key={workspace.scopeKey}
                                    onClick={() => void runWorkspaceActivation(workspace)}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        void openNativeMenu(
                                            item,
                                            event.clientX,
                                            event.clientY,
                                        );
                                    }}
                                    onFocus={() => setFocusedItemId(item.id)}
                                    onKeyDown={(event) => handleTreeKeyDown(event, item)}
                                    ref={(element) => setItemRef(itemRefs.current, item.id, element)}
                                    role="treeitem"
                                    tabIndex={focusedItemId === item.id ? 0 : -1}
                                >
                                    <WorkspaceRowIcon
                                        active={active}
                                        isPrimary={workspace.isPrimary}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                        {workspace.label}
                                    </span>
                                    <WorkspaceRowBadge
                                        error={localError}
                                        isMissing={workspace.isMissing}
                                        opening={opening}
                                        status={workspace.status}
                                    />
                                    {localError ? (
                                        <span className="sr-only" id={`workspace-error-${workspace.scopeKey}`}>
                                            {localError}. Press Enter to retry.
                                        </span>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : null}
                {project.inventoryError && expanded ? (
                    <button
                        className="workspace-navigator-inline-error"
                        onClick={() =>
                            void runOperation(
                                () => onRetryInventory(project),
                                "Could not refresh worktrees.",
                            )
                        }
                        type="button"
                    >
                        Worktrees unavailable · Retry
                    </button>
                ) : null}
            </div>
        );
    };

    return (
        <nav aria-label="Workspace navigator" className="workspace-navigator">
            <div className="workspace-navigator-header">
                <div className="workspace-navigator-title-row">
                    <span>Workspaces</span>
                    <span aria-label={`${model.workspaceCount} workspaces`}>
                        {model.workspaceCount}
                    </span>
                </div>
                <label className="workspace-navigator-search">
                    <span aria-hidden="true">⌕</span>
                    <input
                        aria-label="Search projects and worktrees"
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape" && query) {
                                event.preventDefault();
                                setQuery("");
                            } else if (event.key === "ArrowDown") {
                                event.preventDefault();
                                focusItem(visibleItems[0]?.id ?? null);
                            }
                        }}
                        placeholder="Search workspaces…"
                        spellCheck={false}
                        value={query}
                    />
                    {query ? (
                        <button aria-label="Clear workspace search" onClick={() => setQuery("")} type="button">
                            ×
                        </button>
                    ) : null}
                </label>
            </div>

            <div className="workspace-navigator-tree-shell">
                {(status === "loading" || status === "idle") &&
                model.projects.length === 0 ? (
                    <WorkspaceNavigatorSkeleton />
                ) : error && model.projects.length === 0 ? (
                    <WorkspaceNavigatorState
                        action="Retry"
                        message={error}
                        onAction={() => void onRetry()}
                        title="Could not load workspaces"
                    />
                ) : model.projects.length === 0 ? (
                    <WorkspaceNavigatorState
                        action="Open Folder"
                        message="Add a local project or clone a repository to create your first workspace."
                        onAction={() => void onOpenFolder()}
                        title="No workspaces yet"
                    />
                ) : filteredProjects.length === 0 ? (
                    <WorkspaceNavigatorState
                        message="No projects or worktrees match your search."
                        title="No matches"
                    />
                ) : (
                    <div aria-label="Projects and workspaces" role="tree">
                        {filteredProjects.map(renderProject)}
                    </div>
                )}
            </div>

            {operationError || (error && model.projects.length > 0) ? (
                <div className="workspace-navigator-error" role="alert">
                    {operationError ?? error}
                </div>
            ) : null}

            <div className="workspace-navigator-footer">
                <button onClick={() => void onOpenFolder()} type="button">
                    Open Folder
                </button>
                <button onClick={() => setDialog({ kind: "clone" })} type="button">
                    Clone
                </button>
                <button onClick={onOpenSettings} type="button">
                    {settingsLabel ?? "Settings"}
                </button>
            </div>

            {dialog ? (
                <WorkspaceNavigatorDialog onClose={() => setDialog(null)}>
                    {dialog.kind === "clone" ? (
                        <CloneDialog
                            onCancel={() => setDialog(null)}
                            onSubmit={async (repositoryUrl) => {
                                await onCloneRepository(repositoryUrl);
                                setDialog(null);
                            }}
                        />
                    ) : dialog.kind === "new-worktree" ? (
                        <NewWorktreeDialog
                            onCancel={() => setDialog(null)}
                            onSubmit={async (branchName) => {
                                await onCreateWorktree(dialog.project, branchName);
                                setDialog(null);
                            }}
                            project={dialog.project}
                        />
                    ) : dialog.kind === "reset" ? (
                        <ConfirmationDialog
                            confirmLabel="Reset Layout"
                            danger
                            description="This replaces panes and tabs with an empty layout. Transcripts and chat history are preserved, but workspace drafts can be removed."
                            onCancel={() => setDialog(null)}
                            onConfirm={async () => {
                                await onResetWorkspace(dialog.workspace);
                                setDialog(null);
                            }}
                            title={`Reset ${dialog.workspace.label}?`}
                        />
                    ) : dialog.kind === "delete" ? (
                        <ConfirmationDialog
                            confirmDisabledReason={deleteUnavailableReason}
                            confirmLabel="Delete Worktree"
                            danger
                            description={`This will permanently delete ${dialog.workspace.rootPath ?? dialog.workspace.worktreeId ?? dialog.workspace.label} and purge its layout, drafts, recovery layouts, navigation references, transcripts, runtime metadata, and recoverable terminal data. The parent project and sibling worktrees are not affected.`}
                            onCancel={() => setDialog(null)}
                            onConfirm={() => Promise.resolve()}
                            title={`Delete ${dialog.workspace.label}?`}
                        />
                    ) : (
                        <RecoveryDialog
                            onClose={() => setDialog(null)}
                            workspace={dialog.workspace}
                        />
                    )}
                </WorkspaceNavigatorDialog>
            ) : null}
        </nav>
    );
}

function WorkspaceNavigatorDialog({
    children,
    onClose,
}: {
    readonly children: ReactNode;
    readonly onClose: () => void;
}) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        dialogRef.current
            ?.querySelector<HTMLElement>(
                'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
            )
            ?.focus();
    }, []);
    return (
        <div
            className="workspace-navigator-dialog-backdrop"
            onMouseDown={(event) => {
                if (event.currentTarget === event.target) {
                    onClose();
                }
            }}
        >
            <div
                aria-modal="true"
                className="workspace-navigator-dialog"
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onClose();
                        return;
                    }
                    if (event.key !== "Tab") {
                        return;
                    }
                    const focusable = [
                        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
                            'input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
                        ) ?? []),
                    ];
                    if (focusable.length === 0) {
                        event.preventDefault();
                        return;
                    }
                    const currentIndex = focusable.indexOf(
                        document.activeElement as HTMLElement,
                    );
                    const nextIndex = event.shiftKey
                        ? (currentIndex - 1 + focusable.length) % focusable.length
                        : (currentIndex + 1) % focusable.length;
                    event.preventDefault();
                    focusable[nextIndex]?.focus();
                }}
                ref={dialogRef}
                role="dialog"
            >
                {children}
            </div>
        </div>
    );
}

function CloneDialog({
    onCancel,
    onSubmit,
}: {
    readonly onCancel: () => void;
    readonly onSubmit: (repositoryUrl: string) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    return (
        <NavigatorFormDialog
            description="Enter a Git repository URL."
            onCancel={onCancel}
            onSubmit={() => onSubmit(value.trim())}
            submitDisabled={!value.trim()}
            submitLabel="Clone"
            title="Clone Repository"
        >
            <input
                aria-label="Repository URL"
                autoFocus
                onChange={(event) => setValue(event.target.value)}
                placeholder="https://github.com/user/repo.git"
                spellCheck={false}
                value={value}
            />
        </NavigatorFormDialog>
    );
}

function NewWorktreeDialog({
    onCancel,
    onSubmit,
    project,
}: {
    readonly onCancel: () => void;
    readonly onSubmit: (branchName: string) => Promise<void>;
    readonly project: WorkspaceNavigatorProject;
}) {
    const [value, setValue] = useState("");
    return (
        <NavigatorFormDialog
            description={`Create a branch and worktree for ${project.name}.`}
            onCancel={onCancel}
            onSubmit={() => onSubmit(value.trim())}
            submitDisabled={!value.trim()}
            submitLabel="Create"
            title="New Worktree"
        >
            <input
                aria-label="Branch name"
                autoFocus
                onChange={(event) => setValue(event.target.value)}
                placeholder="feature/my-branch"
                spellCheck={false}
                value={value}
            />
        </NavigatorFormDialog>
    );
}

function NavigatorFormDialog({
    children,
    description,
    onCancel,
    onSubmit,
    submitDisabled,
    submitLabel,
    title,
}: {
    readonly children: ReactNode;
    readonly description: string;
    readonly onCancel: () => void;
    readonly onSubmit: () => Promise<void>;
    readonly submitDisabled: boolean;
    readonly submitLabel: string;
    readonly title: string;
}) {
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            await onSubmit();
        } catch (cause) {
            setError(formatError(cause, "The operation could not be completed."));
            setSubmitting(false);
        }
    };
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <h2>{title}</h2>
            <p>{description}</p>
            {children}
            {error ? <div className="workspace-navigator-dialog-error" role="alert">{error}</div> : null}
            <div className="workspace-navigator-dialog-actions">
                <button disabled={submitting} onClick={onCancel} type="button">Cancel</button>
                <button disabled={submitting || submitDisabled} type="submit">
                    {submitting ? "Working…" : submitLabel}
                </button>
            </div>
        </form>
    );
}

function ConfirmationDialog({
    confirmDisabledReason,
    confirmLabel,
    danger = false,
    description,
    onCancel,
    onConfirm,
    title,
}: {
    readonly confirmDisabledReason?: string;
    readonly confirmLabel: string;
    readonly danger?: boolean;
    readonly description: string;
    readonly onCancel: () => void;
    readonly onConfirm: () => Promise<void>;
    readonly title: string;
}) {
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            await onConfirm();
        } catch (cause) {
            setError(formatError(cause, "The operation could not be completed."));
            setSubmitting(false);
        }
    };
    return (
        <div>
            <h2>{title}</h2>
            <p>{description}</p>
            {confirmDisabledReason ? (
                <div className="workspace-navigator-dialog-warning" role="status">
                    {confirmDisabledReason}
                </div>
            ) : null}
            {error ? <div className="workspace-navigator-dialog-error" role="alert">{error}</div> : null}
            <div className="workspace-navigator-dialog-actions">
                <button disabled={submitting} onClick={onCancel} type="button">Cancel</button>
                <button
                    className={danger ? "danger" : undefined}
                    disabled={submitting || Boolean(confirmDisabledReason)}
                    onClick={() => void submit()}
                    title={confirmDisabledReason}
                    type="button"
                >
                    {submitting ? "Working…" : confirmLabel}
                </button>
            </div>
        </div>
    );
}

function RecoveryDialog({
    onClose,
    workspace,
}: {
    readonly onClose: () => void;
    readonly workspace: WorkspaceNavigatorWorkspace;
}) {
    return (
        <div>
            <h2>Recovery Layouts</h2>
            <p>Saved alternatives for {workspace.label}. Recovery sources remain read-only until the lifecycle tooling can apply one safely.</p>
            <ul className="workspace-navigator-recovery-list">
                {workspace.recoveryLayouts.map((layout) => (
                    <li key={`${layout.sourceWindowId}:${layout.snapshotHash}`}>
                        <span>{layout.sourceWindowId}</span>
                        <code>{layout.snapshotHash.slice(0, 12)}</code>
                    </li>
                ))}
            </ul>
            <div className="workspace-navigator-dialog-actions">
                <button onClick={onClose} type="button">Done</button>
            </div>
        </div>
    );
}

function WorkspaceRowIcon({
    active,
    isPrimary,
}: {
    readonly active: boolean;
    readonly isPrimary: boolean;
}) {
    return (
        <span aria-hidden="true" className="workspace-navigator-row-icon">
            {active ? "✓" : isPrimary ? "◆" : "⑂"}
        </span>
    );
}

function WorkspaceRowBadge({
    error,
    isMissing,
    opening,
    status,
}: {
    readonly error: string | undefined;
    readonly isMissing: boolean;
    readonly opening: boolean;
    readonly status: WorkspaceNavigatorWorkspace["status"];
}) {
    const label = opening
        ? "Opening"
        : error || status === "error"
          ? "Retry"
          : status === "activity"
            ? "Activity"
            : isMissing
              ? "Missing"
              : status === "active"
                ? "Active"
                : null;
    return label ? <span className="workspace-navigator-row-badge">{label}</span> : null;
}

function WorkspaceNavigatorSkeleton() {
    return (
        <div aria-label="Loading workspaces" className="workspace-navigator-skeleton" role="status">
            {[0, 1, 2].map((index) => (
                <div key={index}>
                    <span />
                    <span />
                </div>
            ))}
        </div>
    );
}

function WorkspaceNavigatorState({
    action,
    message,
    onAction,
    title,
}: {
    readonly action?: string;
    readonly message: string;
    readonly onAction?: () => void;
    readonly title: string;
}) {
    return (
        <div className="workspace-navigator-state">
            <strong>{title}</strong>
            <span>{message}</span>
            {action && onAction ? <button onClick={onAction} type="button">{action}</button> : null}
        </div>
    );
}

function buildWorkspaceAccessibleLabel(
    project: WorkspaceNavigatorProject,
    workspace: WorkspaceNavigatorWorkspace,
    opening: boolean,
    error: string | undefined,
): string {
    const state = opening
        ? "Opening"
        : error
          ? `Error: ${error}`
          : workspace.status === "active"
            ? "Active workspace"
            : workspace.isMissing
              ? "Saved workspace path missing"
              : workspace.status === "activity"
                ? "Background activity"
                : "Available workspace";
    return `${project.name}, ${workspace.label}. ${state}.`;
}

function setItemRef(
    refs: Map<string, HTMLElement>,
    id: string,
    element: HTMLElement | null,
): void {
    if (element) {
        refs.set(id, element);
    } else {
        refs.delete(id);
    }
}

function omitKey(
    value: Readonly<Record<string, string>>,
    key: string,
): Readonly<Record<string, string>> {
    const next = { ...value };
    delete next[key];
    return next;
}

function formatError(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message ? cause.message : fallback;
}
