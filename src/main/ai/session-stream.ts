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
    readonly pendingCriticalPayloadCount: number;
    readonly reason: AiSessionStreamRecoveryReason;
    readonly resyncSnapshotCount: number;
}

export interface PendingCriticalAiSessionStreamPayload {
    readonly payload: AiSessionStreamPayload;
    readonly seq: number;
}

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
    readonly pendingCriticalPayloadCount: number;
    readonly reason: AiSessionStreamRecoveryReason;
    readonly resyncSnapshotCount: number;
    readonly state: AiSessionStreamAckState;
}): AiSessionStreamRecoveryDiagnostic {
    return {
        ackLagMs: Math.max(0, input.nowMs - input.state.lastSentAt),
        lastAckSeq: input.state.lastAckSeq,
        lastSentSeq: input.state.lastSentSeq,
        pendingCriticalPayloadCount: input.pendingCriticalPayloadCount,
        reason: input.reason,
        resyncSnapshotCount: input.resyncSnapshotCount,
    };
}

export function buildAiSessionStreamRecoveryFallbackPayloads(input: {
    readonly pendingCriticalPayloads: readonly PendingCriticalAiSessionStreamPayload[];
    readonly resyncSnapshots: readonly AiSessionSnapshot[];
}): readonly AiSessionStreamPayload[] {
    const pendingPayloads = [...input.pendingCriticalPayloads]
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
