import {
    recordWorkspaceTaskCompleted,
    recordWorkspaceTaskScheduled,
} from "@renderer/app/debug/workspacePerformanceProbe";

export type RendererTaskPriority =
    | "input"
    | "visible"
    | "prefetch"
    | "background";

const PRIORITY_ORDER: readonly RendererTaskPriority[] = [
    "input",
    "visible",
    "prefetch",
    "background",
];

export interface RendererTaskContext {
    readonly signal: AbortSignal;
}

export interface RendererTaskOptions {
    readonly key: string;
    readonly priority: RendererTaskPriority;
    readonly workspaceId: string;
}

interface ScheduledTask<T> {
    readonly controller: AbortController;
    readonly key: string;
    readonly priority: RendererTaskPriority;
    readonly resolve: (value: T | undefined) => void;
    readonly run: (context: RendererTaskContext) => Promise<T> | T;
    readonly workspaceId: string;
}

/**
 * Cooperative queue for renderer work that must not outlive a workspace view.
 * Tasks are intentionally small: callers must yield between expensive chunks.
 */
export class RendererTaskScheduler {
    private readonly tasks: ScheduledTask<unknown>[] = [];
    private readonly tasksByKey = new Map<string, ScheduledTask<unknown>>();
    private scheduled = false;
    private suspended = false;

    schedule<T>(
        options: RendererTaskOptions,
        run: (context: RendererTaskContext) => Promise<T> | T,
    ): Promise<T | undefined> {
        if (this.suspended) {
            return Promise.resolve(undefined);
        }
        this.cancel(options.key);

        const controller = new AbortController();
        return new Promise<T | undefined>((resolve) => {
            const task: ScheduledTask<T> = {
                controller,
                key: options.key,
                priority: options.priority,
                resolve,
                run,
                workspaceId: options.workspaceId,
            };
            this.tasks.push(task as ScheduledTask<unknown>);
            this.tasksByKey.set(task.key, task as ScheduledTask<unknown>);
            recordWorkspaceTaskScheduled();
            this.requestFlush();
        });
    }

    cancel(key: string): void {
        const task = this.tasksByKey.get(key);
        if (!task) {
            return;
        }
        task.controller.abort();
        this.tasksByKey.delete(key);
        recordWorkspaceTaskCompleted(true);
    }

    cancelWorkspace(workspaceId: string): void {
        for (const task of this.tasksByKey.values()) {
            if (task.workspaceId === workspaceId) {
                task.controller.abort();
                this.tasksByKey.delete(task.key);
                recordWorkspaceTaskCompleted(true);
            }
        }
    }

    dispose(): void {
        for (const task of this.tasksByKey.values()) {
            task.controller.abort();
            recordWorkspaceTaskCompleted(true);
        }
        this.tasks.length = 0;
        this.tasksByKey.clear();
    }

    suspend(): void {
        this.suspended = true;
        this.dispose();
    }

    resume(): void {
        this.suspended = false;
    }

    private requestFlush(): void {
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;
        // Background preparation must yield to browser input and paint. A task
        // is dispatched per frame; callers split expensive work into chunks.
        if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => this.flush());
            return;
        }
        queueMicrotask(() => this.flush());
    }

    private flush(): void {
        this.scheduled = false;
        this.tasks.sort(
            (left, right) =>
                PRIORITY_ORDER.indexOf(left.priority) -
                PRIORITY_ORDER.indexOf(right.priority),
        );

        const next = this.tasks.shift();
        if (!next) {
            return;
        }
        if (this.tasksByKey.get(next.key) !== next || next.controller.signal.aborted) {
            next.resolve(undefined);
        } else {
            void Promise.resolve(next.run({ signal: next.controller.signal }))
                .then((result) => {
                    const cancelled = next.controller.signal.aborted;
                    if (this.tasksByKey.get(next.key) === next) {
                        this.tasksByKey.delete(next.key);
                        recordWorkspaceTaskCompleted(cancelled);
                    }
                    next.resolve(cancelled ? undefined : result);
                })
                .catch(() => {
                    if (this.tasksByKey.get(next.key) === next) {
                        this.tasksByKey.delete(next.key);
                        recordWorkspaceTaskCompleted(next.controller.signal.aborted);
                    }
                    next.resolve(undefined);
                });
        }

        if (this.tasks.length > 0) {
            this.requestFlush();
        }
    }
}

const sharedRendererTaskScheduler = new RendererTaskScheduler();

export function getRendererTaskScheduler(): RendererTaskScheduler {
    return sharedRendererTaskScheduler;
}
