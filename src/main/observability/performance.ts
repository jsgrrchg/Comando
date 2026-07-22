import type { AiSessionUpdate } from "@shared/ipc";

export type PerformanceOperationName =
    | "db.ai.deleteSession"
    | "db.ai.listSessionHistory"
    | "db.ai.loadSessionTranscriptPage"
    | "db.ai.loadSessionSnapshot"
    | "db.ai.saveSessionSnapshot"
    | "db.ai.setSessionPinned"
    | "db.projects.listProjects"
    | "db.workspace.loadSnapshot"
    | "db.workspace.saveSnapshot"
    | "git.discardPaths"
    | "git.getRepositorySnapshot"
    | "projects.buildSearchIndex"
    | "projects.listProjectTreeChildren"
    | "workers.ai.rpc"
    | "workers.db.rpc"
    | "workers.git.rpc"
    | "workers.projects.rpc";

export type PerformanceTraceName =
    | PerformanceOperationName
    | "ai.review.apply"
    | "ai.snapshot.apply"
    | "ipc.ai-session.broadcast"
    | "ipc.git-invalidation.broadcast"
    | "ipc.project-tree.broadcast"
    | "main.lifecycle"
    | "main.event-loop.delay"
    | "native-backend.event.dispatch"
    | "native-backend.stdout.parse"
    | "project.invalidation.source";

export interface OperationMetadata {
    readonly [key: string]: boolean | number | string | null | undefined;
}

export interface PerformanceTrace {
    readonly atMs: number;
    readonly durationMs?: number;
    readonly metadata?: OperationMetadata;
    readonly name: PerformanceTraceName;
}

export interface PerformanceClock {
    now(): number;
}

export interface MainProcessPerformanceMonitorOptions {
    readonly capacity?: number;
    readonly clock?: PerformanceClock;
    readonly enabled?: boolean;
}

const DEFAULT_TRACE_CAPACITY = 512;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000;
const EVENT_LOOP_DELAY_THRESHOLD_MS = 20;

class MainProcessPerformanceMonitor {
    private readonly capacity: number;
    private readonly clock: PerformanceClock;
    private readonly enabled: boolean;
    private eventLoopTimer: NodeJS.Timeout | null = null;
    private eventLoopExpectedAtMs = 0;
    private nextTraceIndex = 0;
    private traceCount = 0;
    private readonly traces: Array<PerformanceTrace | undefined>;

    constructor(options: MainProcessPerformanceMonitorOptions = {}) {
        this.capacity = Math.max(1, options.capacity ?? DEFAULT_TRACE_CAPACITY);
        this.clock = options.clock ?? performance;
        this.enabled = options.enabled ?? isPerformanceTracingEnabled();
        this.traces = new Array<PerformanceTrace | undefined>(this.capacity);
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    startEventLoopMonitor(): void {
        if (!this.enabled || this.eventLoopTimer) {
            return;
        }

        this.eventLoopExpectedAtMs = this.clock.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
        this.eventLoopTimer = setInterval(() => {
            const now = this.clock.now();
            const delayMs = Math.max(0, now - this.eventLoopExpectedAtMs);
            this.eventLoopExpectedAtMs = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
            if (delayMs >= EVENT_LOOP_DELAY_THRESHOLD_MS) {
                this.record("main.event-loop.delay", { delayMs });
            }
        }, EVENT_LOOP_SAMPLE_INTERVAL_MS);
        this.eventLoopTimer.unref();
    }

    markAppWhenReady(): void {
        this.record("main.lifecycle", { marker: "app-ready" });
    }

    markFirstMainWindowReady(): void {
        this.record("main.lifecycle", { marker: "first-window-ready" });
    }

    measureSync<T>(
        operation: PerformanceTraceName,
        work: () => T,
        metadata?: OperationMetadata,
    ): T {
        if (!this.enabled) {
            return work();
        }

        const startedAtMs = this.clock.now();
        try {
            return work();
        } finally {
            this.record(operation, metadata, this.clock.now() - startedAtMs);
        }
    }

    async measureAsync<T>(
        operation: PerformanceTraceName,
        work: () => Promise<T>,
        metadata?: OperationMetadata,
    ): Promise<T> {
        if (!this.enabled) {
            return await work();
        }

        const startedAtMs = this.clock.now();
        try {
            return await work();
        } finally {
            this.record(operation, metadata, this.clock.now() - startedAtMs);
        }
    }

    recordAiSessionUpdate(payload: AiSessionUpdate, surfaceCount: number): void {
        if (!this.enabled) {
            return;
        }

        const session =
            payload.kind === "snapshot" ? payload.snapshot : payload.patch;
        this.record("ipc.ai-session.broadcast", {
            sessionId: session.sessionId,
            surfaceCount,
            status:
                payload.kind === "snapshot"
                    ? payload.snapshot.status
                    : payload.patch.changes.status,
            trackedFileCount:
                payload.kind === "snapshot"
                    ? payload.snapshot.trackedFiles.length
                    : payload.patch.changes.trackedFiles?.length,
        });
    }

    record(
        name: PerformanceTraceName,
        metadata?: OperationMetadata,
        durationMs?: number,
    ): void {
        if (!this.enabled) {
            return;
        }

        this.traces[this.nextTraceIndex] = {
            atMs: this.clock.now(),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(metadata === undefined ? {} : { metadata }),
            name,
        };
        this.nextTraceIndex = (this.nextTraceIndex + 1) % this.capacity;
        this.traceCount = Math.min(this.traceCount + 1, this.capacity);
    }

    snapshot(): readonly PerformanceTrace[] {
        if (this.traceCount === 0) {
            return [];
        }

        const oldestIndex =
            this.traceCount === this.capacity ? this.nextTraceIndex : 0;
        return Array.from({ length: this.traceCount }, (_, offset) => {
            return this.traces[(oldestIndex + offset) % this.capacity]!;
        });
    }

    flush(): void {
        // Traces intentionally remain in-process; diagnostics are collected on demand.
    }

    stop(): void {
        if (!this.eventLoopTimer) {
            return;
        }

        clearInterval(this.eventLoopTimer);
        this.eventLoopTimer = null;
    }
}

function isPerformanceTracingEnabled(): boolean {
    return process.env.COMANDO_PERFORMANCE_TRACE === "1";
}

export function createMainProcessPerformanceMonitor(
    options?: MainProcessPerformanceMonitorOptions,
): MainProcessPerformanceMonitor {
    return new MainProcessPerformanceMonitor(options);
}

export const mainProcessPerformance = createMainProcessPerformanceMonitor();
