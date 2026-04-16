import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

import type { AiSessionUpdate } from "@shared/ipc";

const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_EVENT_LOOP_WARN_MS = 32;
const DEFAULT_AI_UPDATE_SIZE_WARN_BYTES = 64 * 1024;
const DEFAULT_AI_UPDATE_RATE_WARN_PER_MIN = 120;
const DEFAULT_OPERATION_WARN_MS = 50;

export const PERFORMANCE_BASELINE_THRESHOLDS = {
    ai: {
        updateRatePerMinute: DEFAULT_AI_UPDATE_RATE_WARN_PER_MIN,
        updateSizeBytes: DEFAULT_AI_UPDATE_SIZE_WARN_BYTES,
    },
    eventLoopLagMs: DEFAULT_EVENT_LOOP_WARN_MS,
    operations: {
        "db.ai.loadSessionSnapshot": 20,
        "db.ai.saveSessionSnapshot": 25,
        "db.projects.listProjects": 20,
        "db.workspace.loadSnapshot": 20,
        "db.workspace.saveSnapshot": 25,
        "git.discardPaths": 250,
        "git.getRepositorySnapshot": 120,
        "projects.buildSearchIndex": 180,
        "projects.listProjectTreeChildren": 75,
        "workers.db.rpc": 80,
        "workers.git.rpc": 750,
        "workers.projects.rpc": 220,
    },
    startup: {
        firstMainWindowReadyMs: 1_500,
    },
} as const;

export type PerformanceOperationName =
    keyof typeof PERFORMANCE_BASELINE_THRESHOLDS.operations;

interface NumericSampleStats {
    count: number;
    max: number;
    samples: number[];
    total: number;
}

interface OperationStats extends NumericSampleStats {
    slowCount: number;
}

interface SummaryStats {
    readonly average: number;
    readonly count: number;
    readonly max: number;
    readonly p95: number;
}

type LogLevel = "info" | "warn";

export interface OperationMetadata {
    readonly [key: string]: boolean | number | string | null | undefined;
}

class MainProcessPerformanceMonitor {
    readonly #enabled: boolean;
    readonly #summaryIntervalMs: number;
    readonly #bootStartedAtMs = performance.now();
    readonly #operationStats = new Map<
        PerformanceOperationName,
        OperationStats
    >();
    readonly #eventLoopStats = createOperationStats();
    readonly #aiPayloadStats = createOperationStats();
    #aiUpdateCount = 0;
    #lastFlushAtMs = performance.now();
    #appWhenReadyAtMs: number | null = null;
    #eventLoopExpectedAtMs: number | null = null;
    #eventLoopTimer: NodeJS.Timeout | null = null;
    #summaryTimer: NodeJS.Timeout | null = null;
    #firstMainWindowReadyLogged = false;

    constructor() {
        this.#enabled = shouldEnablePerformanceMetrics();
        this.#summaryIntervalMs = readEnvNumber(
            "COMANDO_PERF_SUMMARY_MS",
            DEFAULT_SUMMARY_INTERVAL_MS,
        );

        if (this.#enabled) {
            this.#startSummaryLoop();
        }
    }

    startEventLoopMonitor(): void {
        if (!this.#enabled || this.#eventLoopTimer) {
            return;
        }

        this.#eventLoopExpectedAtMs =
            performance.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
        this.#eventLoopTimer = setInterval(() => {
            const now = performance.now();
            const expectedAtMs =
                this.#eventLoopExpectedAtMs ??
                now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
            const lagMs = Math.max(0, now - expectedAtMs);

            this.#eventLoopExpectedAtMs = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
            recordSample(
                this.#eventLoopStats,
                lagMs,
                PERFORMANCE_BASELINE_THRESHOLDS.eventLoopLagMs,
            );

            if (lagMs >= PERFORMANCE_BASELINE_THRESHOLDS.eventLoopLagMs) {
                this.#log(
                    "warn",
                    `[perf][event-loop-lag] lagMs=${formatNumber(lagMs)} thresholdMs=${formatNumber(
                        PERFORMANCE_BASELINE_THRESHOLDS.eventLoopLagMs,
                    )}`,
                );
            }
        }, EVENT_LOOP_SAMPLE_INTERVAL_MS);
        this.#eventLoopTimer.unref?.();
    }

    markAppWhenReady(): void {
        if (!this.#enabled) {
            return;
        }

        this.startEventLoopMonitor();
        this.#appWhenReadyAtMs = performance.now();
        this.#log("info", "[perf][startup] app.whenReady resolved");
    }

    markFirstMainWindowReady(): void {
        if (!this.#enabled || this.#firstMainWindowReadyLogged) {
            return;
        }

        this.#firstMainWindowReadyLogged = true;
        const startAtMs = this.#appWhenReadyAtMs ?? this.#bootStartedAtMs;
        const durationMs = performance.now() - startAtMs;
        const level: LogLevel =
            durationMs >=
            PERFORMANCE_BASELINE_THRESHOLDS.startup.firstMainWindowReadyMs
                ? "warn"
                : "info";

        this.#log(
            level,
            `[perf][startup] firstMainWindowReadyMs=${formatNumber(
                durationMs,
            )} thresholdMs=${formatNumber(
                PERFORMANCE_BASELINE_THRESHOLDS.startup.firstMainWindowReadyMs,
            )}`,
        );
    }

    measureSync<T>(
        operation: PerformanceOperationName,
        work: () => T,
        metadata?: OperationMetadata,
    ): T {
        if (!this.#enabled) {
            return work();
        }

        const startedAtMs = performance.now();

        try {
            return work();
        } finally {
            this.#recordOperation(
                operation,
                performance.now() - startedAtMs,
                metadata,
            );
        }
    }

    async measureAsync<T>(
        operation: PerformanceOperationName,
        work: () => Promise<T>,
        metadata?: OperationMetadata,
    ): Promise<T> {
        if (!this.#enabled) {
            return work();
        }

        const startedAtMs = performance.now();

        try {
            return await work();
        } finally {
            this.#recordOperation(
                operation,
                performance.now() - startedAtMs,
                metadata,
            );
        }
    }

    recordAiSessionUpdate(payload: AiSessionUpdate): void {
        if (!this.#enabled) {
            return;
        }

        const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        this.#aiUpdateCount += 1;
        recordSample(
            this.#aiPayloadStats,
            sizeBytes,
            PERFORMANCE_BASELINE_THRESHOLDS.ai.updateSizeBytes,
        );

        if (sizeBytes >= PERFORMANCE_BASELINE_THRESHOLDS.ai.updateSizeBytes) {
            this.#log(
                "warn",
                `[perf][ai-update] sizeBytes=${sizeBytes} thresholdBytes=${PERFORMANCE_BASELINE_THRESHOLDS.ai.updateSizeBytes} kind=${payload.kind}`,
            );
        }
    }

    flush(): void {
        if (!this.#enabled) {
            return;
        }

        this.#flushSummaries();
    }

    stop(): void {
        if (this.#eventLoopTimer) {
            clearInterval(this.#eventLoopTimer);
            this.#eventLoopTimer = null;
        }

        if (this.#summaryTimer) {
            clearInterval(this.#summaryTimer);
            this.#summaryTimer = null;
        }
    }

    #startSummaryLoop(): void {
        this.#summaryTimer = setInterval(() => {
            this.#flushSummaries();
        }, this.#summaryIntervalMs);
        this.#summaryTimer.unref?.();
    }

    #recordOperation(
        operation: PerformanceOperationName,
        durationMs: number,
        metadata?: OperationMetadata,
    ): void {
        const operationStats =
            this.#operationStats.get(operation) ?? createOperationStats();
        const thresholdMs =
            PERFORMANCE_BASELINE_THRESHOLDS.operations[operation] ??
            DEFAULT_OPERATION_WARN_MS;

        recordSample(operationStats, durationMs, thresholdMs);
        this.#operationStats.set(operation, operationStats);

        if (durationMs < thresholdMs) {
            return;
        }

        this.#log(
            "warn",
            `[perf][slow][${operation}] durationMs=${formatNumber(
                durationMs,
            )} thresholdMs=${formatNumber(thresholdMs)}${formatMetadata(
                metadata,
            )}`,
        );
    }

    #flushSummaries(): void {
        const now = performance.now();
        const intervalMs = Math.max(1, now - this.#lastFlushAtMs);
        this.#lastFlushAtMs = now;

        this.#flushEventLoopSummary();
        this.#flushOperationSummaries();
        this.#flushAiUpdateSummary(intervalMs);
    }

    #flushEventLoopSummary(): void {
        if (this.#eventLoopStats.count === 0) {
            return;
        }

        const summary = summarizeSamples(this.#eventLoopStats);
        const level: LogLevel =
            summary.max >= PERFORMANCE_BASELINE_THRESHOLDS.eventLoopLagMs
                ? "warn"
                : "info";

        this.#log(
            level,
            `[perf][summary][eventLoopLag] count=${summary.count} avgMs=${formatNumber(
                summary.average,
            )} p95Ms=${formatNumber(summary.p95)} maxMs=${formatNumber(
                summary.max,
            )} slow=${this.#eventLoopStats.slowCount} thresholdMs=${formatNumber(
                PERFORMANCE_BASELINE_THRESHOLDS.eventLoopLagMs,
            )}`,
        );
        resetOperationStats(this.#eventLoopStats);
    }

    #flushOperationSummaries(): void {
        for (const [operation, stats] of this.#operationStats.entries()) {
            if (stats.count === 0) {
                continue;
            }

            const summary = summarizeSamples(stats);
            const thresholdMs =
                PERFORMANCE_BASELINE_THRESHOLDS.operations[operation] ??
                DEFAULT_OPERATION_WARN_MS;
            const level: LogLevel =
                summary.max >= thresholdMs || stats.slowCount > 0
                    ? "warn"
                    : "info";

            this.#log(
                level,
                `[perf][summary][${operation}] count=${summary.count} avgMs=${formatNumber(
                    summary.average,
                )} p95Ms=${formatNumber(summary.p95)} maxMs=${formatNumber(
                    summary.max,
                )} slow=${stats.slowCount} thresholdMs=${formatNumber(
                    thresholdMs,
                )}`,
            );
        }

        this.#operationStats.clear();
    }

    #flushAiUpdateSummary(intervalMs: number): void {
        if (this.#aiUpdateCount === 0 || this.#aiPayloadStats.count === 0) {
            return;
        }

        const summary = summarizeSamples(this.#aiPayloadStats);
        const ratePerMinute = (this.#aiUpdateCount / intervalMs) * 60_000;
        const level: LogLevel =
            summary.max >= PERFORMANCE_BASELINE_THRESHOLDS.ai.updateSizeBytes ||
            ratePerMinute >=
                PERFORMANCE_BASELINE_THRESHOLDS.ai.updateRatePerMinute
                ? "warn"
                : "info";

        this.#log(
            level,
            `[perf][summary][ai.sessionUpdate] count=${this.#aiUpdateCount} ratePerMin=${formatNumber(
                ratePerMinute,
            )} avgBytes=${formatNumber(
                summary.average,
            )} p95Bytes=${formatNumber(summary.p95)} maxBytes=${formatNumber(
                summary.max,
            )} thresholdBytes=${PERFORMANCE_BASELINE_THRESHOLDS.ai.updateSizeBytes} thresholdRatePerMin=${PERFORMANCE_BASELINE_THRESHOLDS.ai.updateRatePerMinute}`,
        );

        this.#aiUpdateCount = 0;
        resetOperationStats(this.#aiPayloadStats);
    }

    #log(level: LogLevel, message: string): void {
        void level;
        void message;
    }
}

export const mainProcessPerformance = new MainProcessPerformanceMonitor();

function createOperationStats(): OperationStats {
    return {
        count: 0,
        max: 0,
        samples: [],
        slowCount: 0,
        total: 0,
    };
}

function recordSample(
    stats: OperationStats,
    value: number,
    threshold: number,
): void {
    stats.count += 1;
    stats.total += value;
    stats.max = Math.max(stats.max, value);
    stats.samples.push(value);

    if (value >= threshold) {
        stats.slowCount += 1;
    }
}

function summarizeSamples(stats: NumericSampleStats): SummaryStats {
    const sortedSamples = [...stats.samples].sort(
        (left, right) => left - right,
    );

    return {
        average: stats.total / stats.count,
        count: stats.count,
        max: stats.max,
        p95: percentile(sortedSamples, 0.95),
    };
}

function percentile(samples: readonly number[], ratio: number): number {
    if (samples.length === 0) {
        return 0;
    }

    const position = Math.min(
        samples.length - 1,
        Math.max(0, Math.ceil(samples.length * ratio) - 1),
    );
    return samples[position] ?? 0;
}

function resetOperationStats(stats: OperationStats): void {
    stats.count = 0;
    stats.max = 0;
    stats.samples = [];
    stats.slowCount = 0;
    stats.total = 0;
}

function formatMetadata(metadata?: OperationMetadata): string {
    if (!metadata) {
        return "";
    }

    const parts = Object.entries(metadata)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ` ${key}=${String(value)}`);

    return parts.join("");
}

function formatNumber(value: number): string {
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

function readEnvNumber(name: string, fallback: number): number {
    const rawValue = process.env[name];
    if (!rawValue) {
        return fallback;
    }

    const parsedValue = Number(rawValue);
    return Number.isFinite(parsedValue) && parsedValue > 0
        ? parsedValue
        : fallback;
}

function shouldEnablePerformanceMetrics(): boolean {
    return isMainThread && process.env.COMANDO_PERF_METRICS === "1";
}
