import type { ProjectTreeInvalidation } from "@shared/ipc";

type TimeoutHandle = ReturnType<typeof setTimeout>;

export type ProjectInvalidationCoordinator = {
    dispose: () => void;
    enqueue: (payload: ProjectTreeInvalidation) => void;
};

type Options = {
    readonly apply: (payload: ProjectTreeInvalidation) => void;
    readonly delayMs?: number;
    readonly clearTimeoutFn?: typeof clearTimeout;
    readonly setTimeoutFn?: typeof setTimeout;
};

type PendingInvalidation = {
    generation: number;
    occurredAt: string;
    paths: Set<string> | null;
    projectId: string;
    timeout: TimeoutHandle;
    worktreeId: string | null;
};

export function createProjectInvalidationCoordinator({
    apply,
    delayMs = 50,
    clearTimeoutFn = clearTimeout,
    setTimeoutFn = setTimeout,
}: Options): ProjectInvalidationCoordinator {
    const pending = new Map<string, PendingInvalidation>();
    const generations = new Map<string, number>();

    const flush = (key: string): void => {
        const next = pending.get(key);
        if (!next) {
            return;
        }
        pending.delete(key);
        apply({
            generation: next.generation,
            occurredAt: next.occurredAt,
            projectId: next.projectId,
            relativePaths: next.paths ? [...next.paths].sort() : null,
            worktreeId: next.worktreeId,
        });
    };

    return {
        dispose: () => {
            for (const entry of pending.values()) {
                clearTimeoutFn(entry.timeout);
            }
            pending.clear();
        },
        enqueue: (payload) => {
            const worktreeId = payload.worktreeId ?? null;
            const key = `${payload.projectId}::${worktreeId ?? "__primary__"}`;
            const existing = pending.get(key);
            if (existing) {
                if (existing.paths !== null) {
                    if (payload.relativePaths === null || payload.relativePaths === undefined) {
                        existing.paths = null;
                    } else {
                        for (const path of payload.relativePaths) {
                            existing.paths.add(path);
                        }
                    }
                }
                existing.occurredAt = payload.occurredAt;
                return;
            }
            const generation = (generations.get(key) ?? 0) + 1;
            generations.set(key, generation);
            const entry: PendingInvalidation = {
                generation,
                occurredAt: payload.occurredAt,
                paths:
                    payload.relativePaths === null || payload.relativePaths === undefined
                        ? null
                        : new Set(payload.relativePaths),
                projectId: payload.projectId,
                timeout: setTimeoutFn(() => {
                    flush(key);
                }, delayMs),
                worktreeId,
            };
            pending.set(key, entry);
        },
    };
}
