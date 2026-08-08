import {
    isMoreRestrictiveHistoryRetention,
    normalizeChatHistoryRetentionDays,
    type ChatHistoryRetentionDays,
} from "@shared/chat-history-retention";

import type { AiHistoryPruneResult } from "./contracts";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type HistoryRetentionReason = "scheduled" | "settings_change" | "startup";

export interface HistoryRetentionRunResult extends AiHistoryPruneResult {
    readonly cutoff: string;
    readonly reason: HistoryRetentionReason;
    readonly retentionDays: ChatHistoryRetentionDays;
}

interface PrunedHistorySideEffectsOptions {
    readonly broadcast: (result: HistoryRetentionRunResult) => void;
    readonly forgetSessionReferences?: (sessionId: string) => Promise<unknown>;
    readonly onDiagnostic?: (message: string) => void;
}

export async function applyPrunedHistorySideEffects(
    result: HistoryRetentionRunResult,
    options: PrunedHistorySideEffectsOptions,
): Promise<void> {
    const failures = options.forgetSessionReferences
        ? (
              await Promise.allSettled(
                  result.deletedSessionIds.map((sessionId) =>
                      options.forgetSessionReferences!(sessionId),
                  ),
              )
          ).filter((outcome) => outcome.status === "rejected").length
        : 0;
    if (failures > 0) {
        options.onDiagnostic?.(
            `Failed to clear ${failures} durable workspace reference(s) after chat history pruning.`,
        );
    }
    // Files are already gone at this point, so renderer reconciliation must
    // happen even when cleanup of a secondary durable reference failed.
    options.broadcast(result);
}

interface HistoryRetentionCoordinatorOptions {
    readonly getRetentionDays: () => unknown;
    readonly now?: () => number;
    readonly onDiagnostic?: (message: string) => void;
    readonly onPruned?: (result: HistoryRetentionRunResult) => Promise<void> | void;
    readonly pruneExpiredHistory: (
        cutoff: string,
        retentionDays: ChatHistoryRetentionDays,
    ) => Promise<AiHistoryPruneResult>;
    readonly scheduleEvery?: (callback: () => void, intervalMs: number) => () => void;
}

export class HistoryRetentionCoordinator {
    readonly #getRetentionDays: () => unknown;
    readonly #now: () => number;
    readonly #onDiagnostic: (message: string) => void;
    readonly #onPruned: (result: HistoryRetentionRunResult) => Promise<void> | void;
    readonly #pruneExpiredHistory: (
        cutoff: string,
        retentionDays: ChatHistoryRetentionDays,
    ) => Promise<AiHistoryPruneResult>;
    readonly #scheduleEvery: (callback: () => void, intervalMs: number) => () => void;
    #cancelSchedule: (() => void) | null = null;
    #currentRetentionDays: ChatHistoryRetentionDays = 0;
    #nextReason: HistoryRetentionReason | null = null;
    #running: Promise<void> | null = null;

    constructor(options: HistoryRetentionCoordinatorOptions) {
        this.#getRetentionDays = options.getRetentionDays;
        this.#now = options.now ?? Date.now;
        this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
        this.#onPruned = options.onPruned ?? (() => undefined);
        this.#pruneExpiredHistory = options.pruneExpiredHistory;
        this.#scheduleEvery = options.scheduleEvery ?? defaultScheduleEvery;
    }

    start(): void {
        if (this.#cancelSchedule) {
            return;
        }
        this.#currentRetentionDays = normalizeChatHistoryRetentionDays(
            this.#getRetentionDays(),
        );
        this.#cancelSchedule = this.#scheduleEvery(() => {
            void this.trigger("scheduled");
        }, RETENTION_INTERVAL_MS);
        if (this.#currentRetentionDays > 0) {
            void this.trigger("startup");
        }
    }

    close(): void {
        this.#cancelSchedule?.();
        this.#cancelSchedule = null;
        this.#nextReason = null;
    }

    updateRetentionDays(value: unknown): void {
        const next = normalizeChatHistoryRetentionDays(value);
        const previous = this.#currentRetentionDays;
        this.#currentRetentionDays = next;
        if (isMoreRestrictiveHistoryRetention(previous, next)) {
            void this.trigger("settings_change");
        }
    }

    trigger(reason: HistoryRetentionReason): Promise<void> {
        this.#nextReason = preferReason(this.#nextReason, reason);
        if (!this.#running) {
            this.#running = this.#drain().finally(() => {
                this.#running = null;
                // A trigger can arrive after the drain loop resolves but before
                // this finalizer runs, so hand it to a fresh drain explicitly.
                if (this.#nextReason) {
                    void this.trigger(this.#nextReason);
                }
            });
        }
        return this.#running;
    }

    async #drain(): Promise<void> {
        while (this.#nextReason) {
            const reason = this.#nextReason;
            this.#nextReason = null;
            const retentionDays = this.#currentRetentionDays;
            if (retentionDays === 0) {
                continue;
            }
            const startedAt = this.#now();
            const cutoff = new Date(startedAt - retentionDays * DAY_MS).toISOString();
            try {
                const result = await this.#pruneExpiredHistory(
                    cutoff,
                    retentionDays,
                );
                const runResult: HistoryRetentionRunResult = {
                    ...result,
                    cutoff,
                    reason,
                    retentionDays,
                };
                if (result.deletedSessionIds.length > 0) {
                    await this.#onPruned(runResult);
                }
                this.#onDiagnostic(
                    JSON.stringify({
                        action: "chat_history_retention",
                        cutoff,
                        deletedSessionCount: result.deletedSessionIds.length,
                        durationMs: Math.max(0, this.#now() - startedAt),
                        failedRootCount: result.failedRootIds.length,
                        inspectedSessionCount: result.inspectedSessionCount,
                        reason,
                        retentionDays,
                    }),
                );
            } catch (error) {
                this.#onDiagnostic(
                    `Chat history retention failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }
}

function defaultScheduleEvery(
    callback: () => void,
    intervalMs: number,
): () => void {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => {
        clearInterval(timer);
    };
}

function preferReason(
    current: HistoryRetentionReason | null,
    next: HistoryRetentionReason,
): HistoryRetentionReason {
    if (current === "settings_change" || next === "settings_change") {
        return "settings_change";
    }
    if (current === "startup" || next === "startup") {
        return "startup";
    }
    return "scheduled";
}
