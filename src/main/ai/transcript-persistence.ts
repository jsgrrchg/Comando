import type {
    AiOpenTranscriptTail,
    AiOpenTranscriptTailCheckpoint,
    AiReconcileTerminalOpenTranscriptTailInput,
    AiSealTranscriptTurnInput,
    AiTranscriptBlockMetadata,
    AiTranscriptTerminalStatus,
} from "@shared/ipc";

import {
    AiLiveTranscriptTailStore,
    type AiLiveTranscriptTailSnapshot,
    type AiLiveTranscriptPendingEntry,
} from "./live-transcript";

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;

export interface AiTranscriptPersistenceOptions {
    readonly onSealed?: (
        sessionId: string,
        metadata: readonly AiTranscriptBlockMetadata[],
    ) => void;
    readonly retryBaseDelayMs?: number;
    readonly retryMaxDelayMs?: number;
}

export interface AiTranscriptRecoveryOptions {
    /** Seal an unfinished tail when no live runtime owns the session. */
    readonly sealInterruptedTail?: boolean;
}

export interface AiTranscriptPersistenceAdapter {
    checkpoint(input: AiOpenTranscriptTailCheckpoint): Promise<void>;
    load(sessionId: string): Promise<AiOpenTranscriptTail | null>;
    reconcile(
        input: AiReconcileTerminalOpenTranscriptTailInput,
    ): Promise<readonly AiTranscriptBlockMetadata[]>;
    seal(
        input: AiSealTranscriptTurnInput,
    ): Promise<readonly AiTranscriptBlockMetadata[]>;
}

export interface AiTranscriptPersistenceStatus {
    readonly attempt: number;
    readonly lastError: string | null;
    readonly phase:
        | "checkpointing"
        | "idle"
        | "retrying"
        | "sealing";
    readonly recoverable: boolean;
    readonly sessionId: string;
}

interface SessionPersistenceQueue {
    attempt: number;
    checkpointedRevision: number;
    inFlight: Promise<void> | null;
    isRecovering: boolean;
    recoveredTerminalTail: AiOpenTranscriptTail | null;
    retryTimer: ReturnType<typeof setTimeout> | null;
    sealStatus: AiTranscriptTerminalStatus | null;
    sealTurnId: string | null;
    readonly waiters: Set<() => void>;
}

export class AiTranscriptPersistenceCoordinator {
    readonly #queues = new Map<string, SessionPersistenceQueue>();
    readonly #statusBySessionId = new Map<
        string,
        AiTranscriptPersistenceStatus
    >();

    constructor(
        private readonly store: AiLiveTranscriptTailStore,
        private readonly adapter: AiTranscriptPersistenceAdapter,
        private readonly onStatus: (
            status: AiTranscriptPersistenceStatus,
        ) => void = () => undefined,
        private readonly options: AiTranscriptPersistenceOptions = {},
    ) {}

    getStatus(sessionId: string): AiTranscriptPersistenceStatus {
        return (
            this.#statusBySessionId.get(sessionId) ?? {
                attempt: 0,
                lastError: null,
                phase: "idle",
                recoverable: true,
                sessionId,
            }
        );
    }

    scheduleCheckpoint(sessionId: string): void {
        this.#queueFor(sessionId);
        queueMicrotask(() => {
            this.#pump(sessionId);
        });
    }

    requestSeal(
        sessionId: string,
        status: AiTranscriptTerminalStatus,
    ): void {
        const queue = this.#queueFor(sessionId);
        queue.sealStatus = status;
        queue.sealTurnId = this.store.getSnapshot(sessionId)?.turnId ?? null;
        this.#pump(sessionId);
    }

    async recover(
        sessionId: string,
        options: AiTranscriptRecoveryOptions = {},
    ): Promise<AiOpenTranscriptTail | null> {
        const queue = this.#queueFor(sessionId);
        queue.isRecovering = true;
        try {
            const recovered = await this.adapter.load(sessionId);
            if (!recovered) {
                return null;
            }
            if (!this.store.restoreOpenTail(recovered)) {
                // The native store has one open tail per session. A newer
                // in-memory turn therefore makes the recovered one stale and
                // a terminal predecessor must be reconciled before either
                // turn can be projected. An unresolved predecessor is kept
                // durable until the runtime can resolve the conflict.
                if (recovered.terminalStatus !== null) {
                    await this.#reconcileRecoveredTerminalTail(
                        sessionId,
                        queue,
                        recovered,
                    );
                } else {
                    throw new Error(
                        "Open transcript tail belongs to another unresolved turn.",
                    );
                }
                return recovered;
            }
            queue.checkpointedRevision = recovered.revision;
            queue.sealStatus = recovered.terminalStatus;
            queue.sealTurnId = recovered.terminalStatus
                ? recovered.turnId
                : null;
            if (recovered.terminalStatus !== null) {
                // Terminal tails are authoritative even when a delayed
                // session snapshot still reports streaming after restart.
                await this.#reconcileRecoveredTerminalTail(
                    sessionId,
                    queue,
                    recovered,
                );
            } else if (options.sealInterruptedTail) {
                await this.#sealInterruptedRecoveredTail(
                    sessionId,
                    queue,
                    recovered,
                );
            }
            return recovered;
        } finally {
            queue.isRecovering = false;
            this.#pump(sessionId);
        }
    }

    async flushSession(sessionId: string, timeoutMs: number): Promise<boolean> {
        const queue = this.#queueFor(sessionId);
        this.#pump(sessionId);
        if (this.#isIdle(sessionId, queue)) {
            return true;
        }
        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (completed: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                queue.waiters.delete(onIdle);
                resolve(completed);
            };
            const onIdle = () => {
                finish(true);
            };
            queue.waiters.add(onIdle);
            const timer = setTimeout(() => {
                finish(false);
            }, Math.max(1, timeoutMs));
            timer.unref();
        });
    }

    async waitForIdle(sessionId: string): Promise<void> {
        const queue = this.#queueFor(sessionId);
        this.#pump(sessionId);
        if (this.#isIdle(sessionId, queue)) {
            return;
        }
        await new Promise<void>((resolve) => {
            queue.waiters.add(resolve);
        });
    }

    async shutdown(timeoutMs: number): Promise<boolean> {
        const sessionIds = [...this.#queues.keys()];
        const results = await Promise.all(
            sessionIds.map((sessionId) =>
                this.flushSession(sessionId, timeoutMs),
            ),
        );
        for (const queue of this.#queues.values()) {
            if (queue.retryTimer) {
                clearTimeout(queue.retryTimer);
                queue.retryTimer = null;
            }
        }
        return results.every(Boolean);
    }

    clearSession(sessionId: string): void {
        const queue = this.#queues.get(sessionId);
        if (queue?.retryTimer) {
            clearTimeout(queue.retryTimer);
        }
        if (queue) {
            // Explicit deletion supersedes any background flush waiting for idle.
            this.#resolveWaiters(queue);
        }
        this.#queues.delete(sessionId);
        this.#statusBySessionId.delete(sessionId);
    }

    #pump(sessionId: string): void {
        const queue = this.#queueFor(sessionId);
        if (queue.inFlight || queue.isRecovering || queue.retryTimer) {
            return;
        }
        const request = this.#persistAvailableWork(sessionId, queue);
        queue.inFlight = request;
        void request.finally(() => {
            queue.inFlight = null;
            if (this.#hasWork(sessionId, queue)) {
                this.#pump(sessionId);
            } else {
                this.#setStatus(sessionId, queue, "idle", null);
                this.#resolveWaiters(queue);
            }
        });
    }

    async #persistAvailableWork(
        sessionId: string,
        queue: SessionPersistenceQueue,
    ): Promise<void> {
        try {
            if (queue.recoveredTerminalTail) {
                const tail = queue.recoveredTerminalTail;
                this.#setStatus(sessionId, queue, "sealing", null);
                const metadata = await this.adapter.reconcile({
                    sessionId,
                    turnId: tail.turnId,
                });
                queue.recoveredTerminalTail = null;
                this.#acknowledgeReconciledTerminalTail(
                    sessionId,
                    queue,
                    tail,
                    metadata,
                );
                return;
            }
            const pendingTerminal = this.store.getPendingTerminalTurn(sessionId);
            if (pendingTerminal?.turnId && pendingTerminal.terminalTurnStatus) {
                // The native store has one open tail per session, so finish the
                // older tail before the successor can replace its checkpoint.
                this.#setStatus(sessionId, queue, "checkpointing", null);
                await this.adapter.checkpoint(
                    checkpointFromTail(
                        pendingTerminal,
                        pendingTerminal.entries,
                        [],
                        pendingTerminal.terminalTurnStatus,
                        pendingTerminal.turnId,
                    ),
                );
                this.#setStatus(sessionId, queue, "sealing", null);
                const metadata = await this.adapter.seal({
                    entries: pendingTerminal.entries.map((entry) => entry.envelope),
                    payloads: pendingTerminal.entries.flatMap((entry) =>
                        entry.envelope.payloadRef
                            ? [{
                                  payloadRef: entry.envelope.payloadRef,
                                  value: entry.payload,
                              }]
                            : [],
                    ),
                    sessionId,
                    turnId: pendingTerminal.turnId,
                });
                if (
                    this.store.acknowledgePendingTerminalTurn(
                        sessionId,
                        pendingTerminal.turnId,
                        pendingTerminal.revision,
                        metadata,
                    )
                ) {
                    if (queue.sealTurnId === pendingTerminal.turnId) {
                        queue.sealStatus = null;
                        queue.sealTurnId = null;
                    }
                    this.options.onSealed?.(sessionId, metadata);
                }
                queue.attempt = 0;
                return;
            }
            const pending = this.store.takePendingEntries(sessionId);
            const removedEntryIds = this.store.takePendingRemovedEntryIds(
                sessionId,
            );
            const tail = this.store.getSnapshot(sessionId);
            if (
                !tail ||
                !tail.turnId ||
                (tail.entries.length === 0 && removedEntryIds.length === 0)
            ) {
                queue.checkpointedRevision = Math.max(
                    queue.checkpointedRevision,
                    tail?.revision ?? 0,
                );
                queue.sealStatus = null;
                queue.attempt = 0;
                return;
            }
            if (
                pending.length > 0 ||
                removedEntryIds.length > 0 ||
                tail.revision > queue.checkpointedRevision
            ) {
                this.#setStatus(sessionId, queue, "checkpointing", null);
                await this.adapter.checkpoint(
                    checkpointFromTail(
                        tail,
                        pending,
                        removedEntryIds,
                        queue.sealTurnId === tail.turnId
                            ? queue.sealStatus ?? tail.terminalTurnStatus
                            : tail.terminalTurnStatus,
                        tail.turnId,
                    ),
                );
                queue.checkpointedRevision = Math.max(
                    queue.checkpointedRevision,
                    tail.revision,
                );
                this.store.acknowledgePendingEntries(sessionId, pending);
                this.store.acknowledgePendingRemovedEntryIds(
                    sessionId,
                    removedEntryIds,
                );
                // A successor may have started while the checkpoint was in
                // flight. Re-pump so its predecessor is sealed in isolation.
                if (this.store.getPendingTerminalTurn(sessionId)) {
                    return;
                }
            }

            if (queue.sealStatus && queue.sealTurnId === tail.turnId) {
                const latest = this.store.getSnapshot(sessionId);
                if (!latest || latest.entries.length === 0 || !latest.turnId) {
                    queue.sealStatus = null;
                    queue.sealTurnId = null;
                    return;
                }
                this.#setStatus(sessionId, queue, "sealing", null);
                const metadata = await this.adapter.seal({
                    entries: latest.entries.map((entry) => entry.envelope),
                    payloads: latest.entries.flatMap((entry) =>
                        entry.envelope.payloadRef
                            ? [
                                  {
                                      payloadRef: entry.envelope.payloadRef,
                                      value: entry.payload,
                                  },
                              ]
                            : [],
                    ),
                    sessionId,
                    turnId: latest.turnId,
                });
                if (
                    this.store.acknowledgeSealedTurn(
                        sessionId,
                        latest.turnId,
                        metadata,
                        latest.revision,
                    )
                ) {
                    queue.sealStatus = null;
                    this.options.onSealed?.(sessionId, metadata);
                }
            }
            queue.attempt = 0;
        } catch (error) {
            queue.attempt += 1;
            const message =
                error instanceof Error ? error.message : String(error);
            this.#setStatus(sessionId, queue, "retrying", message);
            const delayMs = Math.min(
                this.options.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS,
                (this.options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS) *
                    2 ** Math.min(queue.attempt - 1, 4),
            );
            queue.retryTimer = setTimeout(() => {
                queue.retryTimer = null;
                this.#pump(sessionId);
            }, delayMs);
            queue.retryTimer.unref();
        }
    }

    #hasWork(
        sessionId: string,
        queue: SessionPersistenceQueue,
    ): boolean {
        return (
            queue.isRecovering ||
            queue.recoveredTerminalTail !== null ||
            this.store.getPendingTerminalTurn(sessionId) !== null ||
            this.store.takePendingEntries(sessionId).length > 0 ||
            this.store.takePendingRemovedEntryIds(sessionId).length > 0 ||
            (this.store.getSnapshot(sessionId)?.revision ?? 0) >
                queue.checkpointedRevision ||
            queue.sealStatus !== null
        );
    }

    #isIdle(
        sessionId: string,
        queue: SessionPersistenceQueue,
    ): boolean {
        return (
            !queue.inFlight &&
            !queue.isRecovering &&
            !queue.retryTimer &&
            !this.#hasWork(sessionId, queue)
        );
    }

    #queueFor(sessionId: string): SessionPersistenceQueue {
        let queue = this.#queues.get(sessionId);
        if (!queue) {
            queue = {
                attempt: 0,
                checkpointedRevision: 0,
                inFlight: null,
                isRecovering: false,
                recoveredTerminalTail: null,
                retryTimer: null,
                sealStatus: null,
                sealTurnId: null,
                waiters: new Set(),
            };
            this.#queues.set(sessionId, queue);
        }
        return queue;
    }

    async #reconcileRecoveredTerminalTail(
        sessionId: string,
        queue: SessionPersistenceQueue,
        tail: AiOpenTranscriptTail,
    ): Promise<void> {
        this.#setStatus(sessionId, queue, "sealing", null);
        try {
            const metadata = await this.adapter.reconcile({
                sessionId,
                turnId: tail.turnId,
            });
            this.#acknowledgeReconciledTerminalTail(
                sessionId,
                queue,
                tail,
                metadata,
            );
        } catch (error) {
            queue.recoveredTerminalTail = tail;
            this.#setStatus(
                sessionId,
                queue,
                "retrying",
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    async #sealInterruptedRecoveredTail(
        sessionId: string,
        queue: SessionPersistenceQueue,
        tail: AiOpenTranscriptTail,
    ): Promise<void> {
        this.#setStatus(sessionId, queue, "sealing", null);
        const metadata = await this.adapter.seal({
            entries: tail.entries,
            payloads: tail.payloads,
            sessionId,
            turnId: tail.turnId,
        });
        if (!this.store.acknowledgeSealedTurn(
            sessionId,
            tail.turnId,
            metadata,
            tail.revision,
        )) {
            this.store.setStableBlocks(sessionId, metadata);
        }
        this.options.onSealed?.(sessionId, metadata);
        queue.attempt = 0;
        if (queue.sealTurnId === tail.turnId) {
            queue.sealStatus = null;
            queue.sealTurnId = null;
        }
    }

    #acknowledgeReconciledTerminalTail(
        sessionId: string,
        queue: SessionPersistenceQueue,
        tail: AiOpenTranscriptTail,
        metadata: readonly AiTranscriptBlockMetadata[],
    ): void {
        if (!this.store.acknowledgeSealedTurn(
            sessionId,
            tail.turnId,
            metadata,
            tail.revision,
        )) {
            this.store.setStableBlocks(sessionId, metadata);
        }
        this.options.onSealed?.(sessionId, metadata);
        queue.attempt = 0;
        if (queue.sealTurnId === tail.turnId) {
            queue.sealStatus = null;
            queue.sealTurnId = null;
        }
    }

    #setStatus(
        sessionId: string,
        queue: SessionPersistenceQueue,
        phase: AiTranscriptPersistenceStatus["phase"],
        lastError: string | null,
    ): void {
        const status = {
            attempt: queue.attempt,
            lastError,
            phase,
            recoverable: true,
            sessionId,
        } satisfies AiTranscriptPersistenceStatus;
        this.#statusBySessionId.set(sessionId, status);
        this.onStatus(status);
    }

    #resolveWaiters(queue: SessionPersistenceQueue): void {
        for (const resolve of queue.waiters) {
            resolve();
        }
        queue.waiters.clear();
    }
}

function checkpointFromTail(
    tail: AiLiveTranscriptTailSnapshot,
    pending: readonly AiLiveTranscriptPendingEntry[],
    removedEntryIds: readonly string[],
    terminalStatus: AiTranscriptTerminalStatus | null,
    turnId: string,
): AiOpenTranscriptTailCheckpoint {
    const ordinalByEntryId = new Map(
        tail.entries.map((entry, ordinal) => [entry.envelope.id, ordinal]),
    );
    return {
        entries: pending.map((entry) => entry.envelope),
        entryOrder: pending.flatMap((entry) => {
            const ordinal = ordinalByEntryId.get(entry.envelope.id);
            return ordinal === undefined
                ? []
                : [{
                      entryId: entry.envelope.id,
                      entryRevision: entry.entryRevision,
                      ordinal,
                  }];
        }),
        payloads: pending.flatMap((entry) =>
            entry.envelope.payloadRef
                ? [
                      {
                          payloadRef: entry.envelope.payloadRef,
                          value: entry.payload,
                      },
                  ]
                : [],
        ),
        removedEntryIds,
        sessionId: tail.sessionId,
        terminalStatus,
        turnId,
    };
}
