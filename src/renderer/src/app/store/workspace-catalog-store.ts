import { createStore } from "zustand/vanilla";

import type {
    GitWorktreeSummary,
    ProjectSummary,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";
import type {
    NativeDurableWorkspaceLifecycle,
    NativeDurableWorkspaceSummary,
} from "@shared/native-backend";
import {
    getWorkspaceScopeKey,
    normalizeWorkspaceWorktreeId,
} from "@shared/workspace-context";

export interface WorkspaceCatalogEntry {
    readonly lastActivatedAt: string | null;
    readonly lifecycle: NativeDurableWorkspaceLifecycle;
    readonly projectId: string;
    readonly revision: number | null;
    readonly runtimeOwnerId: string | null;
    readonly scopeKey: string;
    readonly source: "durable" | "legacy-v3";
    readonly worktreeId: string | null;
}

interface WorkspaceCatalogState {
    readonly entriesByScopeKey: Readonly<Record<string, WorkspaceCatalogEntry>>;
    readonly error: string | null;
    readonly status: "idle" | "loading" | "ready" | "error";
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
}

export const workspaceCatalogStore = createStore<WorkspaceCatalogState>(
    (set) => ({
        entriesByScopeKey: {},
        error: null,
        status: "idle",
        replaceDurable: (entries) => {
            set({
                entriesByScopeKey: Object.fromEntries(
                    entries.map((entry) => [
                        entry.scopeKey,
                        {
                            lastActivatedAt: entry.lastActivatedAt,
                            lifecycle: entry.lifecycle,
                            projectId: entry.projectId,
                            revision: entry.revision,
                            runtimeOwnerId: entry.runtimeOwnerId,
                            scopeKey: entry.scopeKey,
                            source: "durable",
                            worktreeId: entry.worktreeId,
                        } satisfies WorkspaceCatalogEntry,
                    ]),
                ),
                error: null,
                status: "ready",
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
                const entriesByScopeKey = { ...state.entriesByScopeKey };
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
                        source: "legacy-v3",
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
    }),
);

export function resetWorkspaceCatalogStoreForTests(): void {
    workspaceCatalogStore.setState({
        entriesByScopeKey: {},
        error: null,
        status: "idle",
    });
}
