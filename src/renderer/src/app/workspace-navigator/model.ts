import type {
    GitWorktreeSummary,
    ProjectSummary,
    WorkspaceSurfaceDiagnostic,
    WorkspaceSurfacePoolDiagnostics,
} from "@shared/ipc";
import type { NativeWorkspaceMigrationRecoverySource } from "@shared/native-backend";
import {
    getWorkspaceScopeKey,
    normalizeWorkspaceWorktreeId,
} from "@shared/workspace-context";

import type { WorkspaceCatalogEntry } from "../store/workspace-catalog-store";

export type WorkspaceNavigatorRowStatus =
    | "active"
    | "activity"
    | "available"
    | "error"
    | "warming";

export interface WorkspaceNavigatorWorkspace {
    readonly catalogEntry: WorkspaceCatalogEntry;
    readonly isMissing: boolean;
    readonly isPrimary: boolean;
    readonly isResident: boolean;
    readonly label: string;
    readonly projectId: string;
    readonly recoveryLayouts: readonly NativeWorkspaceMigrationRecoverySource[];
    readonly rootPath: string | null;
    readonly scopeKey: string;
    readonly status: WorkspaceNavigatorRowStatus;
    readonly statusMessage: string | null;
    readonly worktreeId: string | null;
}

export interface WorkspaceNavigatorProject {
    readonly id: string;
    readonly inventoryError: string | null;
    readonly inventoryLoading: boolean;
    readonly isMissing: boolean;
    readonly name: string;
    readonly rootPath: string | null;
    readonly workspaces: readonly WorkspaceNavigatorWorkspace[];
}

export interface WorkspaceNavigatorModel {
    readonly activeScopeKey: string | null;
    readonly projects: readonly WorkspaceNavigatorProject[];
    readonly workspaceCount: number;
}

export interface BuildWorkspaceNavigatorModelInput {
    readonly catalogEntries: Readonly<Record<string, WorkspaceCatalogEntry>>;
    readonly diagnostics: WorkspaceSurfacePoolDiagnostics | null;
    readonly inventoryErrorsByProject?: Readonly<Record<string, string | null>>;
    readonly inventoryLoadingByProject?: Readonly<Record<string, boolean>>;
    readonly projects: readonly ProjectSummary[];
    readonly recoveryByScopeKey?: Readonly<
        Record<string, readonly NativeWorkspaceMigrationRecoverySource[]>
    >;
    readonly worktreesByProject: Readonly<
        Record<string, readonly GitWorktreeSummary[]>
    >;
}

export function buildWorkspaceNavigatorModel({
    catalogEntries,
    diagnostics,
    inventoryErrorsByProject = {},
    inventoryLoadingByProject = {},
    projects,
    recoveryByScopeKey = {},
    worktreesByProject,
}: BuildWorkspaceNavigatorModelInput): WorkspaceNavigatorModel {
    const diagnosticsByScopeKey = new Map(
        (diagnostics?.surfaces ?? []).map((entry) => [entry.scopeKey, entry]),
    );
    const registeredProjectIds = new Set(projects.map((project) => project.id));
    const projectIds = [
        ...projects.map((project) => project.id),
        ...new Set(
            Object.values(catalogEntries)
                .map((entry) => entry.projectId)
                .filter((projectId) => !registeredProjectIds.has(projectId)),
        ),
    ];
    const projectById = new Map(projects.map((project) => [project.id, project]));

    const navigatorProjects = projectIds.map(
        (projectId): WorkspaceNavigatorProject => {
            const project = projectById.get(projectId) ?? null;
            const inventory = worktreesByProject[projectId] ?? [];
            const inventoryByScopeKey = new Map<string, GitWorktreeSummary>();
            for (const worktree of inventory) {
                inventoryByScopeKey.set(
                    getWorkspaceScopeKey(
                        projectId,
                        worktree.isPrimary ? null : worktree.id,
                    ),
                    worktree,
                );
            }

            const projectEntries = Object.values(catalogEntries).filter(
                (entry) => entry.projectId === projectId,
            );
            const orderedScopeKeys: string[] = [];
            const primaryScopeKey = getWorkspaceScopeKey(projectId, null);
            orderedScopeKeys.push(primaryScopeKey);
            for (const worktree of inventory) {
                if (!worktree.isPrimary) {
                    orderedScopeKeys.push(
                        getWorkspaceScopeKey(projectId, worktree.id),
                    );
                }
            }
            for (const entry of projectEntries
                .filter((entry) => !orderedScopeKeys.includes(entry.scopeKey))
                .toSorted(compareCatalogEntries)) {
                orderedScopeKeys.push(entry.scopeKey);
            }

            const workspaces = orderedScopeKeys.flatMap(
                (scopeKey): readonly WorkspaceNavigatorWorkspace[] => {
                    const inventoryWorktree = inventoryByScopeKey.get(scopeKey);
                    const existingEntry = catalogEntries[scopeKey];
                    const worktreeId = normalizeWorkspaceWorktreeId(
                        projectId,
                        existingEntry?.worktreeId ??
                            (inventoryWorktree?.isPrimary
                                ? null
                                : inventoryWorktree?.id ?? null),
                    );
                    const isPrimary = worktreeId === null;
                    const catalogEntry =
                        existingEntry ??
                        createRegistryEntry(projectId, worktreeId, scopeKey);
                    const isMissing =
                        !project ||
                        (!isPrimary && !inventoryWorktree) ||
                        catalogEntry.lifecycle === "orphaned";
                    const diagnostic = diagnosticsByScopeKey.get(scopeKey) ?? null;
                    const presentation = resolveRowPresentation(
                        diagnostic,
                        isMissing,
                    );
                    return [
                        {
                            catalogEntry,
                            isMissing,
                            isPrimary,
                            isResident:
                                diagnostic?.state === "active" ||
                                diagnostic?.state === "warm",
                            label: isPrimary
                                ? "Primary"
                                : inventoryWorktree
                                  ? getWorktreeDisplayLabel(inventoryWorktree)
                                  : worktreeId ?? "Missing worktree",
                            projectId,
                            recoveryLayouts: recoveryByScopeKey[scopeKey] ?? [],
                            rootPath:
                                inventoryWorktree?.rootPath ??
                                (isPrimary ? project?.rootPath ?? null : null),
                            scopeKey,
                            status: presentation.status,
                            statusMessage: presentation.message,
                            worktreeId,
                        },
                    ];
                },
            );

            return {
                id: projectId,
                inventoryError: inventoryErrorsByProject[projectId] ?? null,
                inventoryLoading:
                    inventoryLoadingByProject[projectId] === true,
                isMissing: !project,
                name: project?.name ?? `Missing project · ${projectId}`,
                rootPath: project?.rootPath ?? null,
                workspaces,
            };
        },
    );

    return {
        activeScopeKey:
            diagnostics?.activeScopeKey ??
            navigatorProjects
                .flatMap((project) => project.workspaces)
                .find((workspace) => workspace.status === "active")?.scopeKey ??
            null,
        projects: navigatorProjects,
        workspaceCount: navigatorProjects.reduce(
            (total, project) => total + project.workspaces.length,
            0,
        ),
    };
}

function createRegistryEntry(
    projectId: string,
    worktreeId: string | null,
    scopeKey: string,
): WorkspaceCatalogEntry {
    return {
        lastActivatedAt: null,
        lifecycle: "active",
        projectId,
        revision: null,
        runtimeOwnerId: null,
        scopeKey,
        source: "registry",
        worktreeId,
    };
}

function compareCatalogEntries(
    left: WorkspaceCatalogEntry,
    right: WorkspaceCatalogEntry,
): number {
    return (
        (right.lastActivatedAt ?? "").localeCompare(
            left.lastActivatedAt ?? "",
        ) || left.scopeKey.localeCompare(right.scopeKey)
    );
}

function getWorktreeDisplayLabel(worktree: GitWorktreeSummary): string {
    if (worktree.branchName) {
        return worktree.branchName;
    }
    return (
        worktree.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        "Detached worktree"
    );
}

function resolveRowPresentation(
    diagnostic: WorkspaceSurfaceDiagnostic | null,
    isMissing: boolean,
): { readonly message: string | null; readonly status: WorkspaceNavigatorRowStatus } {
    if (diagnostic?.state === "error") {
        return {
            message: diagnostic.error ?? "The workspace could not be opened.",
            status: "error",
        };
    }
    if (
        diagnostic?.state === "warming" ||
        diagnostic?.state === "suspending" ||
        diagnostic?.state === "disposing"
    ) {
        return { message: "Workspace is changing state.", status: "warming" };
    }
    if (diagnostic?.state === "active") {
        return { message: null, status: "active" };
    }
    if (diagnostic && diagnostic.leases.length > 0) {
        return {
            message: diagnostic.leases[0]?.message ?? "Background activity",
            status: "activity",
        };
    }
    return {
        message: isMissing ? "The saved workspace path is unavailable." : null,
        status: "available",
    };
}
