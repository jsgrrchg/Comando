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

// "stale" marks an entry whose data is still shown but must be revalidated
// after a tree invalidation (stale-while-revalidate — keeps pills visible
// instead of blanking them while the fresh index loads).
type ProjectFileIndexStatus = "loading" | "ready" | "error" | "stale";

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
                    // load that has not yet resolved) is discarded.
                    generationByContext.set(
                        contextKey,
                        (generationByContext.get(contextKey) ?? 0) + 1,
                    );
                }
                set((state) => {
                    const nextByContext = { ...state.byContext };
                    for (const contextKey of affectedKeys) {
                        // Keep the old paths visible and mark the entry stale so
                        // consumers revalidate without blanking pills in between.
                        const previous = nextByContext[contextKey];
                        nextByContext[contextKey] = {
                            status: "stale",
                            paths: previous?.paths ?? null,
                        };
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
                // Ready or in flight → nothing to do. A prior error, or a stale
                // entry awaiting revalidation, is (re)loaded.
                if (
                    existing &&
                    existing.status !== "error" &&
                    existing.status !== "stale"
                ) {
                    return;
                }

                const generation = generationByContext.get(contextKey) ?? 0;
                generationByContext.set(contextKey, generation);
                set((state) => ({
                    byContext: {
                        ...state.byContext,
                        [contextKey]: {
                            status: "loading",
                            // Keep showing the previous paths while revalidating.
                            paths: state.byContext[contextKey]?.paths ?? null,
                        },
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
                        // Keep any previous paths so a failed *revalidation* does
                        // not blank pills that were valid a moment ago.
                        set((state) => ({
                            byContext: {
                                ...state.byContext,
                                [contextKey]: {
                                    status: "error",
                                    paths:
                                        state.byContext[contextKey]?.paths ??
                                        null,
                                },
                            },
                        }));
                    });
            },
        };
    },
);

/**
 * Returns the complete set of file relative paths for a (project, worktree), or
 * `null` while the first index load is pending/errored. After an invalidation it
 * keeps returning the previous set (stale) while the fresh one loads, so pills
 * never blank out. `null` means callers must not render file pills (better a
 * brief absence than a false positive).
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

    // Re-run on mount (no entry) and after an invalidation marks the entry
    // `stale` → revalidate. The dep is this boolean, not `entry`, so reaching
    // `loading`/`ready`/`error` does not re-trigger the effect: no tight loop,
    // and errors recover on the next mount or invalidation.
    const needsLoad = entry === undefined || entry.status === "stale";
    useEffect(() => {
        if (projectId) {
            load(projectId, worktreeId);
        }
    }, [load, projectId, worktreeId, needsLoad]);

    // Show paths whenever we have them (ready or revalidating), never blank.
    return entry?.paths ?? null;
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
