const WORKSPACE_PERFORMANCE_PROBE_STORAGE_KEY =
    "comando:workspace-performance-probe";

export interface WorkspacePerformanceSnapshot {
    readonly cancelledTasks: number;
    readonly completedTasks: number;
    readonly events: readonly WorkspacePerformanceEvent[];
    readonly scheduledTasks: number;
}

export interface WorkspacePerformanceEvent {
    readonly detail?: string;
    readonly name: string;
    readonly timestamp: number;
}

let enabled: boolean | null = null;
let cancelledTasks = 0;
let completedTasks = 0;
let scheduledTasks = 0;
const events: WorkspacePerformanceEvent[] = [];

function isEnabled(): boolean {
    if (enabled !== null) {
        return enabled;
    }
    if (typeof window === "undefined") {
        enabled = false;
        return enabled;
    }
    enabled = window.localStorage.getItem(WORKSPACE_PERFORMANCE_PROBE_STORAGE_KEY) === "1";
    return enabled;
}

export function recordWorkspacePerformanceEvent(
    name: string,
    detail?: string,
): void {
    if (!isEnabled()) {
        return;
    }
    events.push({ detail, name, timestamp: performance.now() });
    if (events.length > 200) {
        events.splice(0, events.length - 200);
    }
}

export function recordWorkspaceTaskScheduled(): void {
    if (!isEnabled()) {
        return;
    }
    scheduledTasks += 1;
}

export function recordWorkspaceTaskCompleted(cancelled: boolean): void {
    if (!isEnabled()) {
        return;
    }
    if (cancelled) {
        cancelledTasks += 1;
        return;
    }
    completedTasks += 1;
}

export function getWorkspacePerformanceSnapshot(): WorkspacePerformanceSnapshot {
    return {
        cancelledTasks,
        completedTasks,
        events: [...events],
        scheduledTasks,
    };
}

export function resetWorkspacePerformanceProbeForTests(): void {
    enabled = null;
    cancelledTasks = 0;
    completedTasks = 0;
    scheduledTasks = 0;
    events.length = 0;
}

if (typeof window !== "undefined") {
    Object.assign(window, {
        comandoWorkspacePerformance: {
            dump: getWorkspacePerformanceSnapshot,
            reset: resetWorkspacePerformanceProbeForTests,
        },
    });
}
