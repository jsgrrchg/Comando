import { useCallback } from "react";
import { useStore } from "zustand";

import type { SettingsWindowCategory } from "@shared/ipc";
import { getWorkspaceScopeKey } from "@shared/workspace-context";

import { useGitStore } from "@renderer/app/store/git-store";
import { useProjectsStore } from "@renderer/app/store/projects-store";
import {
    refreshDurableWorkspaceCatalog,
    workspaceCatalogStore,
} from "@renderer/app/store/workspace-catalog-store";
import { useWorkspaceStore } from "@renderer/app/store/workspace-store";
import type {
    WorkspaceNavigatorModel,
    WorkspaceNavigatorWorkspace,
} from "@renderer/app/workspace-navigator/model";
import {
    buildSuggestedWorktreePath,
    findProjectGitSnapshot,
    resolveWorktreeBaseBranch,
} from "@renderer/app/workspace-navigator/project-actions";
import { WorkspaceNavigator } from "./WorkspaceNavigator";

export function WorkspaceNavigatorPanel({
    model,
    settingsLabel,
}: {
    readonly model: WorkspaceNavigatorModel;
    readonly settingsLabel: string | null;
}) {
    const catalogStatus = useStore(
        workspaceCatalogStore,
        (state) => state.status,
    );
    const catalogError = useStore(
        workspaceCatalogStore,
        (state) => state.error,
    );
    const projects = useProjectsStore((state) => state.projects);
    const projectsError = useProjectsStore((state) => state.error);
    const addProjects = useProjectsStore((state) => state.addProjects);
    const cloneRepository = useProjectsStore(
        (state) => state.cloneRepository,
    );
    const removeProject = useProjectsStore((state) => state.removeProject);
    const hydrateProjects = useProjectsStore((state) => state.hydrate);
    const revealEntry = useProjectsStore((state) => state.revealEntry);
    const createWorktree = useGitStore((state) => state.createWorktree);
    const gitSnapshots = useGitStore((state) => state.snapshots);
    const refreshGitProject = useGitStore((state) => state.refreshProject);
    const worktreesByProject = useGitStore(
        (state) => state.worktreesByProject,
    );

    const activate = useCallback(
        async (workspace: WorkspaceNavigatorWorkspace) => {
            const api = window.comando;
            if (!api) {
                throw new Error("The desktop bridge is unavailable.");
            }
            const contextKey = await useWorkspaceStore
                .getState()
                .registerWorkspaceScope(workspace.projectId, workspace.worktreeId);
            // Main receives the compatibility context before activation, while
            // selection remains committed to the previous surface until ready.
            await api.initializeWorkspaceSurfaces(
                useWorkspaceStore.getState().getWorkspaceSurfaceRegistry(),
            );
            const result = await api.activateWorkspaceSurface(contextKey);
            if (result.status === "failed") {
                throw new Error(result.message);
            }
            if (result.status === "stale") {
                throw new Error(
                    "A newer workspace selection replaced this request.",
                );
            }
        },
        [],
    );

    const refreshCatalog = useCallback(async () => {
        if (!window.comando) {
            throw new Error("The desktop bridge is unavailable.");
        }
        await refreshDurableWorkspaceCatalog(window.comando);
        workspaceCatalogStore
            .getState()
            .mergeRegistry(
                useProjectsStore.getState().projects,
                useGitStore.getState().worktreesByProject,
            );
    }, []);

    const retry = useCallback(async () => {
        await hydrateProjects();
        await refreshCatalog();
    }, [hydrateProjects, refreshCatalog]);

    return (
        <WorkspaceNavigator
            error={catalogError ?? projectsError}
            model={model}
            onActivate={activate}
            onCloneRepository={async (repositoryUrl) => {
                const projectIds = await cloneRepository(repositoryUrl);
                const projectId = projectIds[0];
                if (!projectId) {
                    return;
                }
                workspaceCatalogStore
                    .getState()
                    .mergeRegistry(
                        useProjectsStore.getState().projects,
                        useGitStore.getState().worktreesByProject,
                    );
                const workspace = findWorkspace(model, projectId, null);
                if (workspace) {
                    await activate(workspace);
                } else {
                    await activate(createPendingWorkspace(projectId));
                }
            }}
            onCloseWorkspace={async (workspace) => {
                const result = await window.comando?.closeWorkspaceSurface(
                    workspace.scopeKey,
                );
                if (!result) {
                    throw new Error("The desktop bridge is unavailable.");
                }
                if (result.status === "blocked") {
                    throw new Error(
                        result.leases.map((lease) => lease.message).join(" "),
                    );
                }
                if (result.status === "failed") {
                    throw new Error(result.message);
                }
            }}
            onCopyPath={async (workspace) => {
                if (!workspace.rootPath) {
                    throw new Error("This workspace path is unavailable.");
                }
                await window.comando?.writeClipboardText(workspace.rootPath);
            }}
            onCreateWorktree={async (project, branchName) => {
                const summary = projects.find(
                    (candidate) => candidate.id === project.id,
                );
                const snapshot = findProjectGitSnapshot(
                    gitSnapshots,
                    project.id,
                );
                const baseBranch = resolveWorktreeBaseBranch(snapshot);
                if (!summary || !snapshot || !baseBranch) {
                    throw new Error(
                        "This project does not have a branch to use as a base.",
                    );
                }
                const created = await createWorktree({
                    branchName,
                    path: buildSuggestedWorktreePath(
                        summary.rootPath,
                        branchName,
                        worktreesByProject[project.id] ?? snapshot.worktrees,
                    ),
                    projectId: project.id,
                    startPoint: baseBranch,
                    worktreeId: null,
                });
                workspaceCatalogStore
                    .getState()
                    .mergeRegistry(
                        useProjectsStore.getState().projects,
                        useGitStore.getState().worktreesByProject,
                    );
                await activate({
                    ...createPendingWorkspace(project.id, created.id),
                    label: created.branchName ?? created.id,
                    rootPath: created.rootPath,
                });
            }}
            onPreflightDeleteWorktree={async (workspace) => {
                if (!window.comando || !workspace.worktreeId) {
                    throw new Error("This worktree cannot be deleted.");
                }
                return await window.comando.preflightDeleteWorktree({
                    projectId: workspace.projectId,
                    scopeKey: workspace.scopeKey,
                    worktreeId: workspace.worktreeId,
                });
            }}
            onDeleteWorktree={async (workspace, forceApproved) => {
                if (!window.comando || !workspace.worktreeId) {
                    throw new Error("This worktree cannot be deleted.");
                }
                await window.comando.deleteWorktree({
                    forceApproved,
                    projectId: workspace.projectId,
                    scopeKey: workspace.scopeKey,
                    worktreeId: workspace.worktreeId,
                });
                await useWorkspaceStore
                    .getState()
                    .removeWorktreeTabs(
                        workspace.projectId,
                        workspace.worktreeId,
                    );
                await hydrateProjects();
                await refreshGitProject(workspace.projectId);
                await refreshCatalog();
            }}
            onApplyRecoveryLayout={async (workspace, recoveryId) => {
                const revision = workspace.catalogEntry.revision;
                if (!window.comando || revision === null) {
                    throw new Error("This recovery layout is unavailable.");
                }
                const closeResult = await window.comando.closeWorkspaceSurface(
                    workspace.scopeKey,
                );
                if (closeResult.status === "blocked") {
                    throw new Error(
                        closeResult.leases.map((lease) => lease.message).join(" "),
                    );
                }
                if (closeResult.status === "failed") {
                    throw new Error(closeResult.message);
                }
                await window.comando.applyWorkspaceRecoveryLayout({
                    expectedRevision: revision,
                    recoveryId,
                    scopeKey: workspace.scopeKey,
                });
                await refreshCatalog();
            }}
            onDiscardRecoveryLayout={async (workspace, recoveryId) => {
                if (!window.comando) {
                    throw new Error("This recovery layout is unavailable.");
                }
                await window.comando.discardWorkspaceRecoveryLayout({
                    recoveryId,
                    scopeKey: workspace.scopeKey,
                });
                await refreshCatalog();
            }}
            onReassociateWorkspace={async (workspace, target) => {
                const revision = workspace.catalogEntry.revision;
                if (!window.comando || revision === null || !target.worktreeId) {
                    throw new Error("This workspace cannot be reassociated.");
                }
                await window.comando.reassociateWorkspace({
                    expectedRevision: revision,
                    projectId: workspace.projectId,
                    sourceScopeKey: workspace.scopeKey,
                    targetScopeKey: target.scopeKey,
                    targetWorktreeId: target.worktreeId,
                });
                await useWorkspaceStore
                    .getState()
                    .removeWorktreeTabs(
                        workspace.projectId,
                        workspace.worktreeId,
                    );
                await refreshCatalog();
            }}
            onRemoveSavedWorkspace={async (workspace) => {
                const revision = workspace.catalogEntry.revision;
                if (!window.comando || revision === null) {
                    throw new Error("This saved workspace is unavailable.");
                }
                await window.comando.removeSavedWorkspace({
                    expectedRevision: revision,
                    scopeKey: workspace.scopeKey,
                });
                await useWorkspaceStore
                    .getState()
                    .removeWorktreeTabs(
                        workspace.projectId,
                        workspace.worktreeId,
                    );
                await refreshCatalog();
            }}
            onOpenFolder={async () => {
                const projectIds = await addProjects();
                const projectId = projectIds[0];
                workspaceCatalogStore
                    .getState()
                    .mergeRegistry(
                        useProjectsStore.getState().projects,
                        useGitStore.getState().worktreesByProject,
                    );
                if (projectId) {
                    await activate(createPendingWorkspace(projectId));
                }
            }}
            onOpenSettings={() => {
                const initialCategory: SettingsWindowCategory | undefined =
                    settingsLabel ? "updates" : undefined;
                void window.comando?.openSettingsWindow({
                    initialCategory,
                    projectId:
                        model.projects
                            .flatMap((project) => project.workspaces)
                            .find(
                                (workspace) =>
                                    workspace.scopeKey === model.activeScopeKey,
                            )?.projectId ?? null,
                });
            }}
            onRemoveProject={async (project) => {
                if (
                    !window.confirm(
                        `Remove ${project.name} from the workspace navigator? Saved workspace data is preserved.`,
                    )
                ) {
                    return;
                }
                if (!window.comando) {
                    throw new Error("The desktop bridge is unavailable.");
                }
                for (const workspace of project.workspaces) {
                    const result = await window.comando.closeWorkspaceSurface(
                        workspace.scopeKey,
                    );
                    if (result.status === "blocked") {
                        throw new Error(
                            result.leases.map((lease) => lease.message).join(" "),
                        );
                    }
                    if (result.status === "failed") {
                        throw new Error(result.message);
                    }
                }
                await removeProject(project.id);
                await refreshCatalog();
            }}
            onResetWorkspace={async (workspace) => {
                const revision = workspace.catalogEntry.revision;
                if (revision === null || !window.comando) {
                    throw new Error(
                        "This workspace does not have a durable layout to reset.",
                    );
                }
                const closeResult = await window.comando.closeWorkspaceSurface(
                    workspace.scopeKey,
                );
                if (closeResult.status === "blocked") {
                    throw new Error(
                        closeResult.leases
                            .map((lease) => lease.message)
                            .join(" "),
                    );
                }
                if (closeResult.status === "failed") {
                    throw new Error(closeResult.message);
                }
                await window.comando.resetWorkspaceLayout({
                    expectedRevision: revision,
                    scopeKey: workspace.scopeKey,
                });
                await refreshCatalog();
            }}
            onRetry={retry}
            onRetryInventory={async (project) => {
                await refreshGitProject(project.id);
                workspaceCatalogStore
                    .getState()
                    .mergeRegistry(
                        useProjectsStore.getState().projects,
                        useGitStore.getState().worktreesByProject,
                    );
            }}
            onRevealPath={async (workspace) => {
                if (!workspace.rootPath) {
                    throw new Error("This workspace path is unavailable.");
                }
                await revealEntry(
                    workspace.projectId,
                    null,
                    workspace.worktreeId,
                );
            }}
            settingsLabel={settingsLabel}
            status={catalogStatus}
        />
    );
}

function findWorkspace(
    model: WorkspaceNavigatorModel,
    projectId: string,
    worktreeId: string | null,
): WorkspaceNavigatorWorkspace | null {
    return (
        model.projects
            .find((project) => project.id === projectId)
            ?.workspaces.find(
                (workspace) => workspace.worktreeId === worktreeId,
            ) ?? null
    );
}

function createPendingWorkspace(
    projectId: string,
    worktreeId: string | null = null,
): WorkspaceNavigatorWorkspace {
    const scopeKey = getWorkspaceScopeKey(projectId, worktreeId);
    return {
        catalogEntry: {
            lastActivatedAt: null,
            lifecycle: "active",
            projectId,
            revision: null,
            runtimeOwnerId: null,
            scopeKey,
            source: "registry",
            worktreeId,
        },
        deletionOperation: null,
        isMissing: false,
        isPrimary: worktreeId === null,
        isResident: false,
        label: worktreeId ?? "Primary",
        projectId,
        recoveryLayouts: [],
        rootPath: null,
        scopeKey,
        status: "available",
        statusMessage: null,
        worktreeId,
    };
}
