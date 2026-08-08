import type {
    AiSessionSnapshot,
    AiSessionStreamPayload,
    AiSessionUpdate,
} from "@shared/ipc";
import { mergeAiTranscriptToolActivity } from "@shared/ai-transcript";

export const AI_SESSION_STREAM_MAX_IN_FLIGHT = 32;
export const AI_SESSION_STREAM_MAX_PENDING_PAYLOADS = 100;

export type AiSessionStreamRecoveryReason =
    | "ack-timeout"
    | "heartbeat-error"
    | "heartbeat-stale"
    | "post-error"
    | "pre-send-stale";

export interface AiSessionStreamAckState {
    readonly lastAckSeq: number;
    readonly pendingAckSentAtBySeq: ReadonlyMap<number, number>;
    readonly lastSentAt: number;
    readonly lastSentSeq: number;
}

export interface AiSessionStreamRecoveryDiagnostic {
    readonly ackLagMs: number;
    readonly lastAckSeq: number;
    readonly lastSentSeq: number;
    readonly coalescedPendingPayloadCount: number;
    readonly peakInFlightPayloadCount: number;
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

export interface PendingAiSessionStreamDelivery {
    readonly critical: boolean;
    readonly order: number;
    readonly payload: AiSessionStreamPayload;
}

export type AiSessionStreamDeliveryQueue = Map<
    string,
    PendingAiSessionStreamDelivery
>;

export interface AiSessionStreamDeliveryQueueResult {
    readonly coalesced: boolean;
    readonly droppedCritical: boolean;
    readonly droppedOldest: boolean;
    readonly pendingCount: number;
    readonly preserved: boolean;
}

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
        payload.kind === "thinking-completed" ||
        payload.kind === "permission-request" ||
        payload.kind === "session-closed" ||
        payload.kind === "turn-status" ||
        payload.kind === "user-input-request"
    ) {
        return true;
    }

    if (payload.kind === "tool-activity") {
        return (
            payload.activity.status === "completed" ||
            payload.activity.status === "failed"
        );
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
        payload.kind === "thinking-delta" ||
        payload.kind === "tool-activity"
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

    if (payload.kind === "tool-activity") {
        return `${payload.sessionId}:${payload.activity.id}:${payload.kind}`;
    }

    return `${payload.sessionId}:${payload.kind}`;
}

export function getAiSessionStreamDeliveryKey(
    payload: AiSessionStreamPayload,
): string {
    // Session updates must keep one stable slot even when their status changes
    // whether the payload is currently classified as critical.
    if (payload.kind === "patch") {
        return `${payload.patch.sessionId}:patch`;
    }
    if (payload.kind === "snapshot") {
        return `${payload.snapshot.sessionId}:snapshot`;
    }
    const preservedKey = getAiSessionStreamPreservationKey(payload);
    if (preservedKey !== null) return preservedKey;
    if (payload.kind === "image-generation") {
        return `${payload.sessionId}:${payload.message.id}:${payload.kind}`;
    }
    if (payload.kind === "review-delta") {
        return `${payload.sessionId}:${payload.delta.toolCallId}:${payload.kind}`;
    }
    if (payload.kind === "subagent-created") {
        return `${payload.sessionId}:${payload.childSessionId}:${payload.kind}`;
    }
    if (payload.kind === "subagent-breadcrumb") {
        return `${payload.sessionId}:${payload.childSessionId}:${payload.kind}`;
    }
    return `${payload.sessionId}:${payload.kind}`;
}

export function rememberAiSessionStreamPayloadForDelivery(input: {
    readonly maxPayloads: number;
    readonly order: number;
    readonly payload: AiSessionStreamPayload;
    readonly queue: AiSessionStreamDeliveryQueue;
}): AiSessionStreamDeliveryQueueResult {
    const key = getAiSessionStreamDeliveryKey(input.payload);
    const existing = input.queue.get(key);
    const critical = isCriticalAiSessionStreamPayload(input.payload);
    if (existing) {
        input.queue.set(key, {
            critical: existing.critical || critical,
            order: existing.order,
            payload: mergePendingDeliveryPayload(existing.payload, input.payload),
        });
        return {
            coalesced: true,
            droppedCritical: false,
            droppedOldest: false,
            pendingCount: input.queue.size,
            preserved: true,
        };
    }

    let droppedCritical = false;
    let droppedOldest = false;
    if (input.queue.size >= input.maxPayloads) {
        const evictable = [...input.queue].find(
            ([, pending]) => !pending.critical,
        );
        if (evictable) {
            input.queue.delete(evictable[0]);
            droppedOldest = true;
        } else if (!critical) {
            return {
                coalesced: false,
                droppedCritical: false,
                droppedOldest: false,
                pendingCount: input.queue.size,
                preserved: false,
            };
        } else {
            const oldest = input.queue.keys().next().value;
            if (oldest !== undefined) {
                input.queue.delete(oldest);
                droppedCritical = true;
                droppedOldest = true;
            }
        }
    }

    input.queue.set(key, {
        critical,
        order: input.order,
        payload: input.payload,
    });
    return {
        coalesced: false,
        droppedCritical,
        droppedOldest,
        pendingCount: input.queue.size,
        preserved: true,
    };
}

export function takeNextAiSessionStreamDelivery(
    queue: AiSessionStreamDeliveryQueue,
): PendingAiSessionStreamDelivery | null {
    let oldestKey: string | null = null;
    let oldest: PendingAiSessionStreamDelivery | null = null;
    let criticalKey: string | null = null;
    let critical: PendingAiSessionStreamDelivery | null = null;
    for (const [key, candidate] of queue) {
        if (!oldest || candidate.order < oldest.order) {
            oldestKey = key;
            oldest = candidate;
        }
        if (candidate.critical && (!critical || candidate.order < critical.order)) {
            criticalKey = key;
            critical = candidate;
        }
    }
    let dependencyKey: string | null = null;
    let dependency: PendingAiSessionStreamDelivery | null = null;
    if (critical) {
        const criticalSessionId = getAiSessionStreamPayloadSessionId(
            critical.payload,
        );
        for (const [key, candidate] of queue) {
            if (
                candidate.order < critical.order &&
                getAiSessionStreamPayloadSessionId(candidate.payload) ===
                    criticalSessionId &&
                (!dependency || candidate.order < dependency.order)
            ) {
                dependencyKey = key;
                dependency = candidate;
            }
        }
    }
    const nextKey = dependencyKey ?? criticalKey ?? oldestKey;
    const next = dependency ?? critical ?? oldest;
    if (nextKey !== null) queue.delete(nextKey);
    return next;
}

function getAiSessionStreamPayloadSessionId(
    payload: AiSessionStreamPayload,
): string {
    if (payload.kind === "patch") return payload.patch.sessionId;
    if (payload.kind === "snapshot") return payload.snapshot.sessionId;
    return payload.sessionId;
}

export function releaseAcknowledgedAiSessionStreamPayloads(
    inFlightPayloadSeqs: Set<number>,
    acknowledgedSeq: number,
): number {
    return inFlightPayloadSeqs.delete(acknowledgedSeq) ? 1 : 0;
}

function mergePendingDeliveryPayload(
    existing: AiSessionStreamPayload,
    incoming: AiSessionStreamPayload,
): AiSessionStreamPayload {
    if (existing.kind === "patch" && incoming.kind === "patch") {
        return {
            kind: "patch",
            patch: {
                ...incoming.patch,
                changes: {
                    ...existing.patch.changes,
                    ...incoming.patch.changes,
                },
            },
        };
    }
    if (existing.kind === "tool-activity" && incoming.kind === "tool-activity") {
        const merged = mergeAiTranscriptToolActivity(
            existing.activity,
            incoming.activity,
        );
        return {
            ...incoming,
            activity: {
                ...merged,
                locations:
                    incoming.activity.locations.length > 0
                        ? incoming.activity.locations
                        : existing.activity.locations,
                rawInputJson:
                    incoming.activity.rawInputJson ??
                    existing.activity.rawInputJson,
                rawOutputJson:
                    incoming.activity.rawOutputJson ??
                    existing.activity.rawOutputJson,
                summary:
                    incoming.activity.summary ?? existing.activity.summary,
                toolActivityDetailId:
                    incoming.activity.toolActivityDetailId ??
                    existing.activity.toolActivityDetailId,
            },
        };
    }
    return incoming;
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

    const existing = input.queue.get(key);
    if (
        existing?.payload.kind === "patch" &&
        input.payload.kind === "patch"
    ) {
        input.queue.set(key, {
            payload: {
                kind: "patch",
                patch: {
                    ...input.payload.patch,
                    changes: {
                        ...existing.payload.patch.changes,
                        ...input.payload.patch.changes,
                    },
                },
            },
            seq: input.seq,
        });
    } else if (
        existing?.payload.kind === "tool-activity" &&
        input.payload.kind === "tool-activity"
    ) {
        input.queue.set(key, {
            payload: mergePendingDeliveryPayload(
                existing.payload,
                input.payload,
            ),
            seq: input.seq,
        });
    } else {
        input.queue.set(key, {
            payload: input.payload,
            seq: input.seq,
        });
    }

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
    const oldestPendingSentAt = getOldestPendingAiSessionStreamAckSentAt(state);
    return (
        oldestPendingSentAt !== null && nowMs - oldestPendingSentAt >= staleMs
    );
}

export function buildAiSessionStreamRecoveryDiagnostic(input: {
    readonly coalescedPendingPayloadCount?: number;
    readonly nowMs: number;
    readonly peakInFlightPayloadCount?: number;
    readonly pendingPreservedPayloadCount: number;
    readonly reason: AiSessionStreamRecoveryReason;
    readonly resyncSnapshotCount: number;
    readonly state: AiSessionStreamAckState;
}): AiSessionStreamRecoveryDiagnostic {
    const oldestPendingSentAt = getOldestPendingAiSessionStreamAckSentAt(
        input.state,
    );
    return {
        ackLagMs:
            oldestPendingSentAt === null
                ? 0
                : Math.max(0, input.nowMs - oldestPendingSentAt),
        lastAckSeq: input.state.lastAckSeq,
        lastSentSeq: input.state.lastSentSeq,
        coalescedPendingPayloadCount:
            input.coalescedPendingPayloadCount ?? 0,
        peakInFlightPayloadCount: input.peakInFlightPayloadCount ?? 0,
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

function getOldestPendingAiSessionStreamAckSentAt(
    state: AiSessionStreamAckState,
): number | null {
    let oldestPendingSentAt: number | null = null;
    for (const sentAt of state.pendingAckSentAtBySeq.values()) {
        if (oldestPendingSentAt === null || sentAt < oldestPendingSentAt) {
            oldestPendingSentAt = sentAt;
        }
    }

    return oldestPendingSentAt;
}
