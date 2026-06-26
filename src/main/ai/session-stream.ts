import type {
    AiSessionSnapshot,
    AiSessionStreamPayload,
    AiSessionUpdate,
} from "@shared/ipc";

export type AiSessionStreamRecoveryReason =
    | "ack-timeout"
    | "heartbeat-error"
    | "heartbeat-stale"
    | "post-error"
    | "pre-send-stale";

export interface AiSessionStreamAckState {
    readonly lastAckSeq: number;
    readonly lastSentAt: number;
    readonly lastSentSeq: number;
}

export interface AiSessionStreamRecoveryDiagnostic {
    readonly ackLagMs: number;
    readonly lastAckSeq: number;
    readonly lastSentSeq: number;
    readonly pendingPreservedPayloadCount: number;
    readonly reason: AiSessionStreamRecoveryReason;
    readonly resyncSnapshotCount: number;
}

export interface PendingPreservedAiSessionStreamPayload {
    readonly payload: AiSessionStreamPayload;
    readonly seq: number;
}

export interface AiSessionStreamPreservationResult {
    readonly droppedOldest: boolean;
    readonly pendingCount: number;
    readonly preserved: boolean;
}

export type AiSessionStreamPreservationQueue = Map<
    string,
    PendingPreservedAiSessionStreamPayload
>;

export type AiSessionStreamPayloadKind = AiSessionStreamPayload["kind"];

export function getAiSessionStreamPayloadKind(
    payload: AiSessionStreamPayload,
): AiSessionStreamPayloadKind {
    return payload.kind;
}

export function isAiSessionUpdate(
    payload: AiSessionStreamPayload,
): payload is AiSessionUpdate {
    return payload.kind === "patch" || payload.kind === "snapshot";
}

export function isCriticalAiSessionStreamPayload(
    payload: AiSessionStreamPayload,
): boolean {
    if (isAiSessionUpdate(payload)) {
        const status =
            payload.kind === "snapshot"
                ? payload.snapshot.status
                : payload.patch.changes.status;
        return status === "idle" || status === "error";
    }

    if (
        payload.kind === "message-completed" ||
        payload.kind === "thinking-completed"
    ) {
        return true;
    }

    return (
        payload.kind === "status" &&
        (payload.status === "idle" || payload.status === "error")
    );
}

export function isPreservableAiSessionStreamPayload(
    payload: AiSessionStreamPayload,
): boolean {
    if (isCriticalAiSessionStreamPayload(payload)) {
        return true;
    }

    if (payload.kind === "patch") {
        return (
            payload.patch.changes.messages !== undefined ||
            payload.patch.changes.toolActivity !== undefined
        );
    }

    return (
        payload.kind === "message-started" ||
        payload.kind === "message-delta" ||
        payload.kind === "thinking-started" ||
        payload.kind === "thinking-delta"
    );
}

export function getAiSessionStreamPreservationKey(
    payload: AiSessionStreamPayload,
): string | null {
    if (!isPreservableAiSessionStreamPayload(payload)) {
        return null;
    }

    if (payload.kind === "patch") {
        return `${payload.patch.sessionId}:patch`;
    }

    if (payload.kind === "snapshot") {
        return `${payload.snapshot.sessionId}:snapshot`;
    }

    if (
        payload.kind === "message-started" ||
        payload.kind === "thinking-started"
    ) {
        return `${payload.sessionId}:${payload.message.id}:${payload.kind}`;
    }

    if (
        payload.kind === "message-delta" ||
        payload.kind === "thinking-delta" ||
        payload.kind === "message-completed" ||
        payload.kind === "thinking-completed"
    ) {
        return `${payload.sessionId}:${payload.messageId}:${payload.kind}`;
    }

    return `${payload.sessionId}:${payload.kind}`;
}

export function rememberAiSessionStreamPayloadForRecovery(input: {
    readonly maxPayloads: number;
    readonly payload: AiSessionStreamPayload;
    readonly queue: AiSessionStreamPreservationQueue;
    readonly seq: number;
}): AiSessionStreamPreservationResult {
    const key = getAiSessionStreamPreservationKey(input.payload);
    if (key === null) {
        return {
            droppedOldest: false,
            pendingCount: input.queue.size,
            preserved: false,
        };
    }

    input.queue.set(key, {
        payload: input.payload,
        seq: input.seq,
    });

    let droppedOldest = false;
    while (input.queue.size > input.maxPayloads) {
        let oldestKey: string | null = null;
        let oldestSeq = Number.POSITIVE_INFINITY;
        for (const [candidateKey, pendingPayload] of input.queue) {
            if (pendingPayload.seq < oldestSeq) {
                oldestKey = candidateKey;
                oldestSeq = pendingPayload.seq;
            }
        }
        if (oldestKey === null) {
            break;
        }
        input.queue.delete(oldestKey);
        droppedOldest = true;
    }

    return {
        droppedOldest,
        pendingCount: input.queue.size,
        preserved: input.queue.has(key),
    };
}

export function isAiSessionStreamAckStale(
    state: AiSessionStreamAckState,
    nowMs: number,
    staleMs: number,
): boolean {
    return (
        state.lastSentSeq > state.lastAckSeq &&
        nowMs - state.lastSentAt >= staleMs
    );
}

export function buildAiSessionStreamRecoveryDiagnostic(input: {
    readonly nowMs: number;
    readonly pendingPreservedPayloadCount: number;
    readonly reason: AiSessionStreamRecoveryReason;
    readonly resyncSnapshotCount: number;
    readonly state: AiSessionStreamAckState;
}): AiSessionStreamRecoveryDiagnostic {
    return {
        ackLagMs: Math.max(0, input.nowMs - input.state.lastSentAt),
        lastAckSeq: input.state.lastAckSeq,
        lastSentSeq: input.state.lastSentSeq,
        pendingPreservedPayloadCount: input.pendingPreservedPayloadCount,
        reason: input.reason,
        resyncSnapshotCount: input.resyncSnapshotCount,
    };
}

export function buildAiSessionStreamRecoveryFallbackPayloads(input: {
    readonly pendingPreservedPayloads: readonly PendingPreservedAiSessionStreamPayload[];
    readonly resyncSnapshots: readonly AiSessionSnapshot[];
}): readonly AiSessionStreamPayload[] {
    const pendingPayloads = [...input.pendingPreservedPayloads]
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => entry.payload);
    const snapshotPayloads = input.resyncSnapshots.map(
        (snapshot): AiSessionUpdate => ({
            kind: "snapshot",
            snapshot,
        }),
    );

    return [...pendingPayloads, ...snapshotPayloads];
}
