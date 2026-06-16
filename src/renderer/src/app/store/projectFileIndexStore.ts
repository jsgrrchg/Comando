import { useCallback, useEffect } from "react";

import { create } from "zustand";

import type { ComandoApi } from "@shared/ipc";

import { getProjectContextKey } from "@renderer/app/projects/context-key";
import type { ResolvedProjectFileReference } from "@renderer/components/workspace/projectFileReferences";

// Renderer-side cache of the *complete* project file index, keyed by
// (project, worktree). Unlike `projects-store`'s `treeNodes`, which is lazy and
// only holds the children of expanded directories, this index is the full
// recursive list produced by `listProjectEntries` (cached in the main process).
// It exists so file references in chat can be validated for real existence —
// only paths that are actually files in the project become clickable pills.

/**
 * Normalizes a relative path to the canonical form stored in the index so that
 * lookups from `resolveProjectFileReference` and the indexed entries always
 * agree. Case is preserved on purpose (project file systems can be
 * case-sensitive); creating a pill for a path that differs only in case would
 * point at a non-existent file.
 */
export function normalizeIndexPath(path: string): string {
    return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

type ProjectFileIndexStatus = "loading" | "ready" | "error";

interface ProjectFileIndexEntry {
    readonly status: ProjectFileIndexStatus;
    readonly paths: ReadonlySet<string> | null;
}

interface ProjectFileIndexState {
    /** Per-context load status + the set of normalized file relative paths. */
    readonly byContext: Record<string, ProjectFileIndexEntry>;
    /**
     * Loads the index for a context. Skips when already loaded or in flight; a
     * previous error is retryable. Safe to call from many consumers — the
     * `loading` status dedupes concurrent loads to a single IPC call.
     */
    readonly load: (
        projectId: string | null,
        worktreeId: string | null,
    ) => void;
}

// Monotonic epoch per context, kept outside the reactive store because it is
// race-control bookkeeping, not render state. It must survive a context being
// dropped on invalidation: a load started before an invalidation reads its epoch
// up front, and the response is discarded if the epoch has since advanced. This
// is what makes an invalidation win even when it races a first in-flight load.
const generationByContext = new Map<string, number>();

let invalidationSubscribed = false;

function getComandoApi(): ComandoApi | null {
    return "comando" in window ? window.comando : null;
}

export const useProjectFileIndexStore = create<ProjectFileIndexState>(
    (set, get) => {
        function subscribeToInvalidations(): void {
            if (invalidationSubscribed) {
                return;
            }
            const comandoApi = getComandoApi();
            if (!comandoApi?.onProjectTreeInvalidated) {
                return;
            }
            invalidationSubscribed = true;

            comandoApi.onProjectTreeInvalidated((payload) => {
                const prefix = `${payload.projectId}::`;
                const affectedKeys = Object.keys(get().byContext).filter(
                    (contextKey) => contextKey.startsWith(prefix),
                );
                if (affectedKeys.length === 0) {
                    return;
                }
                for (const contextKey of affectedKeys) {
                    // Advance the epoch so any in-flight load (including a first
                    // load that has not yet resolved) is discarded, then drop the
                    // entry so consumers reload fresh.
                    generationByContext.set(
                        contextKey,
                        (generationByContext.get(contextKey) ?? 0) + 1,
                    );
                }
                set((state) => {
                    const nextByContext = { ...state.byContext };
                    for (const contextKey of affectedKeys) {
                        delete nextByContext[contextKey];
                    }
                    return { byContext: nextByContext };
                });
            });
        }

        return {
            byContext: {},
            load: (projectId, worktreeId) => {
                if (!projectId) {
                    return;
                }
                const comandoApi = getComandoApi();
                if (!comandoApi?.listProjectEntries) {
                    return;
                }
                subscribeToInvalidations();

                const contextKey = getProjectContextKey(projectId, worktreeId);
                const existing = get().byContext[contextKey];
                // Loaded or in flight → nothing to do. A prior error is retried.
                if (existing && existing.status !== "error") {
                    return;
                }

                const generation = generationByContext.get(contextKey) ?? 0;
                generationByContext.set(contextKey, generation);
                set((state) => ({
                    byContext: {
                        ...state.byContext,
                        [contextKey]: { status: "loading", paths: null },
                    },
                }));

                void comandoApi
                    .listProjectEntries({ projectId, worktreeId })
                    .then((entries) => {
                        if (
                            (generationByContext.get(contextKey) ?? 0) !==
                            generation
                        ) {
                            return;
                        }
                        const paths = new Set<string>();
                        for (const entry of entries) {
                            if (entry.kind === "file") {
                                paths.add(normalizeIndexPath(entry.relativePath));
                            }
                        }
                        set((state) => ({
                            byContext: {
                                ...state.byContext,
                                [contextKey]: { status: "ready", paths },
                            },
                        }));
                    })
                    .catch(() => {
                        if (
                            (generationByContext.get(contextKey) ?? 0) !==
                            generation
                        ) {
                            return;
                        }
                        // Mark as error (retryable) instead of leaving it stuck
                        // in `loading`, so the next mount or invalidation retries.
                        set((state) => ({
                            byContext: {
                                ...state.byContext,
                                [contextKey]: { status: "error", paths: null },
                            },
                        }));
                    });
            },
        };
    },
);

/**
 * Returns the complete set of file relative paths for a (project, worktree), or
 * `null` while the index is loading, errored, or not yet requested. A `null`
 * result means callers must not render file pills (better a brief absence than a
 * false positive).
 */
export function useProjectFileIndex(
    projectId: string | null,
    worktreeId: string | null,
): ReadonlySet<string> | null {
    const contextKey = projectId
        ? getProjectContextKey(projectId, worktreeId)
        : null;
    const entry = useProjectFileIndexStore((state) =>
        contextKey ? state.byContext[contextKey] : undefined,
    );
    const load = useProjectFileIndexStore((state) => state.load);

    // Re-run when the entry appears/disappears: on mount (absent), and after an
    // invalidation drops it (absent again → reload). The dep is `entry ===
    // undefined`, not `entry`, so reaching the `error` state does not re-trigger
    // the effect and spin a tight retry loop — errors recover on the next mount
    // or invalidation. `load` itself no-ops while loading or ready.
    const isAbsent = entry === undefined;
    useEffect(() => {
        if (projectId) {
            load(projectId, worktreeId);
        }
    }, [load, projectId, worktreeId, isAbsent]);

    return entry?.status === "ready" ? entry.paths : null;
}

/**
 * Returns a predicate that confirms a resolved file reference points at a real
 * file in the project index. Centralizes the "is this an existing file" check so
 * every chat surface (messages, tool summaries) validates pills identically.
 */
export function useFileReferenceValidator(
    projectId: string | null,
    worktreeId: string | null,
): (rawReference: string, reference: ResolvedProjectFileReference) => boolean {
    const fileIndex = useProjectFileIndex(projectId, worktreeId);
    return useCallback(
        (_rawReference: string, reference: ResolvedProjectFileReference) =>
            fileIndex
                ? fileIndex.has(normalizeIndexPath(reference.relativePath))
                : false,
        [fileIndex],
    );
}
