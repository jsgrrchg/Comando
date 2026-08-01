import { createStore } from "zustand/vanilla";

import type {
    GitWorktreeSummary,
    ProjectSummary,
    WorkspaceNavigationSnapshot,
    WorkspaceSurfacePoolDiagnostics,
    WorkspaceCatalogSnapshot,
} from "@shared/ipc";
import type {
    NativeDurableWorkspaceLifecycle,
    NativeDurableWorkspaceSummary,
    NativeWorkspaceMigrationRecoverySource,
} from "@shared/native-backend";
import {
    getWorkspaceScopeKey,
    normalizeWorkspaceWorktreeId,
} from "@shared/workspace-context";
import { appNavigationStore } from "./app-navigation-store";

export interface WorkspaceCatalogEntry {
    readonly lastActivatedAt: string | null;
    readonly lifecycle: NativeDurableWorkspaceLifecycle;
    readonly projectId: string;
    readonly revision: number | null;
    readonly runtimeOwnerId: string | null;
    readonly scopeKey: string;
    readonly source: "durable" | "legacy-v3" | "registry";
    readonly worktreeId: string | null;
}

interface WorkspaceCatalogState {
    readonly entriesByScopeKey: Readonly<Record<string, WorkspaceCatalogEntry>>;
    readonly error: string | null;
    readonly recoveryByScopeKey: Readonly<
        Record<string, readonly NativeWorkspaceMigrationRecoverySource[]>
    >;
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly surfaceDiagnostics: WorkspaceSurfacePoolDiagnostics | null;
    replaceDurable: (
        entries: readonly NativeDurableWorkspaceSummary[],
    ) => void;
    replaceLegacy: (snapshot: WorkspaceNavigationSnapshot) => void;
    mergeRegistry: (
        projects: readonly ProjectSummary[],
        worktreesByProject: Readonly<
            Record<string, readonly GitWorktreeSummary[]>
        >,
    ) => void;
    setError: (error: string) => void;
    setLoading: () => void;
    setRecoveryLayouts: (
        layouts: readonly NativeWorkspaceMigrationRecoverySource[],
    ) => void;
    setSurfaceDiagnostics: (
        diagnostics: WorkspaceSurfacePoolDiagnostics,
    ) => void;
}

export const workspaceCatalogStore = createStore<WorkspaceCatalogState>(
    (set) => ({
        entriesByScopeKey: {},
        error: null,
        recoveryByScopeKey: {},
        status: "idle",
        surfaceDiagnostics: null,
        replaceDurable: (entries) => {
            set((state) => {
                const entriesByScopeKey = Object.fromEntries(
                    Object.values(state.entriesByScopeKey)
                        .filter((entry) => entry.source === "registry")
                        .map((entry) => [entry.scopeKey, entry]),
                );
                for (const entry of entries) {
                    entriesByScopeKey[entry.scopeKey] = {
                        lastActivatedAt: entry.lastActivatedAt,
                        lifecycle: entry.lifecycle,
                        projectId: entry.projectId,
                        revision: entry.revision,
                        runtimeOwnerId: entry.runtimeOwnerId,
                        scopeKey: entry.scopeKey,
                        source: "durable",
                        worktreeId: entry.worktreeId,
                    } satisfies WorkspaceCatalogEntry;
                }
                return {
                    entriesByScopeKey,
                    error: null,
                    status: "ready",
                };
            });
        },
        replaceLegacy: (snapshot) => {
            set({
                entriesByScopeKey: Object.fromEntries(
                    snapshot.contexts.map((context) => {
                        const worktreeId = normalizeWorkspaceWorktreeId(
                            context.projectId,
                            context.worktreeId,
                        );
                        const scopeKey = getWorkspaceScopeKey(
                            context.projectId,
                            worktreeId,
                        );
                        return [
                            scopeKey,
                            {
                                lastActivatedAt: context.lastActivatedAt,
                                lifecycle: "active",
                                projectId: context.projectId,
                                revision: null,
                                runtimeOwnerId: null,
                                scopeKey,
                                source: "legacy-v3",
                                worktreeId,
                            } satisfies WorkspaceCatalogEntry,
                        ];
                    }),
                ),
                error: null,
                status: "ready",
            });
        },
        mergeRegistry: (projects, worktreesByProject) => {
            set((state) => {
                const entriesByScopeKey = Object.fromEntries(
                    Object.values(state.entriesByScopeKey)
                        .filter((entry) => entry.source !== "registry")
                        .map((entry) => [entry.scopeKey, entry]),
                );
                const addScope = (
                    projectId: string,
                    worktreeId: string | null,
                ) => {
                    const normalizedWorktreeId = normalizeWorkspaceWorktreeId(
                        projectId,
                        worktreeId,
                    );
                    const scopeKey = getWorkspaceScopeKey(
                        projectId,
                        normalizedWorktreeId,
                    );
                    entriesByScopeKey[scopeKey] ??= {
                        lastActivatedAt: null,
                        lifecycle: "active",
                        projectId,
                        revision: null,
                        runtimeOwnerId: null,
                        scopeKey,
                        source: "registry",
                        worktreeId: normalizedWorktreeId,
                    };
                };

                for (const project of projects) {
                    addScope(project.id, null);
                    for (const worktree of worktreesByProject[project.id] ?? []) {
                        if (!worktree.isPrimary) {
                            addScope(project.id, worktree.id);
                        }
                    }
                }

                return { entriesByScopeKey };
            });
        },
        setError: (error) => set({ error, status: "error" }),
        setLoading: () => set({ error: null, status: "loading" }),
        setRecoveryLayouts: (layouts) => {
            const recoveryByScopeKey: Record<
                string,
                NativeWorkspaceMigrationRecoverySource[]
            > = {};
            for (const layout of layouts) {
                (recoveryByScopeKey[layout.scopeKey] ??= []).push(layout);
            }
            set({ recoveryByScopeKey });
        },
        setSurfaceDiagnostics: (surfaceDiagnostics) =>
            set({ surfaceDiagnostics }),
    }),
);

export function resetWorkspaceCatalogStoreForTests(): void {
    workspaceCatalogStore.setState({
        entriesByScopeKey: {},
        error: null,
        recoveryByScopeKey: {},
        status: "idle",
        surfaceDiagnostics: null,
    });
}

interface DurableWorkspaceCatalogApi {
    getWorkspaceCatalog: () => Promise<WorkspaceCatalogSnapshot>;
    getWorkspaceSurfaceDiagnostics: () => Promise<WorkspaceSurfacePoolDiagnostics>;
}

export async function refreshDurableWorkspaceCatalog(
    api: DurableWorkspaceCatalogApi,
): Promise<void> {
    const store = workspaceCatalogStore.getState();
    store.setLoading();
    try {
        const [catalog, diagnostics] = await Promise.all([
            api.getWorkspaceCatalog(),
            api.getWorkspaceSurfaceDiagnostics(),
        ]);
        workspaceCatalogStore.getState().replaceDurable(catalog.workspaces);
        workspaceCatalogStore
            .getState()
            .setRecoveryLayouts(catalog.recoveryLayouts);
        workspaceCatalogStore
            .getState()
            .setSurfaceDiagnostics(diagnostics);
        appNavigationStore.getState().replaceDurable(catalog.navigation);
    } catch (error) {
        workspaceCatalogStore
            .getState()
            .setError(
                error instanceof Error
                    ? error.message
                    : "Could not load the workspace catalog.",
            );
        throw error;
    }
}
