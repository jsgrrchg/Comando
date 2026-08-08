import type {
    AiSessionSnapshot,
    AiSessionStreamMessage,
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

export interface AiSessionStreamControllerMetrics {
    readonly coalescedPendingPayloadCount: number;
    readonly peakInFlightPayloadCount: number;
    readonly pendingDeliveryPayloadCount: number;
    readonly pendingInFlightPayloadCount: number;
    readonly pendingPreservedPayloadCount: number;
}

export interface AiSessionStreamControllerRecoveryRequest {
    readonly additionalPayloads: readonly AiSessionStreamPayload[];
    readonly reason: AiSessionStreamRecoveryReason;
}

export interface AiSessionStreamControllerOptions {
    readonly maxInFlight?: number;
    readonly maxPendingPayloads?: number;
    readonly maxPreservedPayloads?: number;
    readonly now?: () => number;
    readonly onMessageSent?: () => void;
    readonly onRecovery: (
        request: AiSessionStreamControllerRecoveryRequest,
    ) => void;
    readonly postMessage: (message: AiSessionStreamMessage) => void;
    readonly staleMs?: number;
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
        for (const [key, candidate] of queue) {
            if (
                candidate.order < critical.order &&
                isAiSessionStreamCausalDependency(
                    candidate.payload,
                    critical.payload,
                ) &&
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

function getAiSessionStreamCausalEntityKey(
    payload: AiSessionStreamPayload,
): string | null {
    const sessionId = getAiSessionStreamPayloadSessionId(payload);
    if (payload.kind === "message-started") {
        return `${sessionId}:message:${payload.message.id}`;
    }
    if (payload.kind === "thinking-started") {
        return `${sessionId}:thinking:${payload.message.id}`;
    }
    if (
        payload.kind === "message-delta" ||
        payload.kind === "message-completed"
    ) {
        return `${sessionId}:message:${payload.messageId}`;
    }
    if (
        payload.kind === "thinking-delta" ||
        payload.kind === "thinking-completed"
    ) {
        return `${sessionId}:thinking:${payload.messageId}`;
    }
    if (payload.kind === "tool-activity") {
        return `${sessionId}:tool:${payload.activity.id}`;
    }
    if (
        (payload.kind === "permission-request" ||
            payload.kind === "user-input-request") &&
        payload.request
    ) {
        return `${sessionId}:tool:${payload.request.toolCallId}`;
    }
    return null;
}

function isAiSessionStreamSessionBarrier(
    payload: AiSessionStreamPayload,
): boolean {
    if (payload.kind === "session-closed" || payload.kind === "turn-status") {
        return true;
    }
    if (payload.kind === "status") {
        return payload.status === "idle" || payload.status === "error";
    }
    if (payload.kind === "patch") {
        return (
            payload.patch.changes.status === "idle" ||
            payload.patch.changes.status === "error"
        );
    }
    if (payload.kind === "snapshot") {
        return (
            payload.snapshot.status === "idle" ||
            payload.snapshot.status === "error"
        );
    }
    return false;
}

function isAiSessionStreamCausalDependency(
    candidate: AiSessionStreamPayload,
    critical: AiSessionStreamPayload,
): boolean {
    const criticalEntityKey = getAiSessionStreamCausalEntityKey(critical);
    if (criticalEntityKey !== null) {
        return (
            getAiSessionStreamCausalEntityKey(candidate) === criticalEntityKey
        );
    }
    return (
        isAiSessionStreamSessionBarrier(critical) &&
        getAiSessionStreamPayloadSessionId(candidate) ===
            getAiSessionStreamPayloadSessionId(critical)
    );
}

export function releaseAcknowledgedAiSessionStreamPayloads(
    inFlightPayloadSeqs: Set<number>,
    acknowledgedSeq: number,
): number {
    return inFlightPayloadSeqs.delete(acknowledgedSeq) ? 1 : 0;
}

export class AiSessionStreamController {
    private coalescedPendingPayloadCount = 0;
    private lastAckSeq = 0;
    private lastSentAt: number;
    private lastSentSeq = 0;
    private readonly maxInFlight: number;
    private readonly maxPendingPayloads: number;
    private readonly maxPreservedPayloads: number;
    private nextPendingOrder = 1;
    private nextSeq = 1;
    private readonly now: () => number;
    private readonly onMessageSent: () => void;
    private readonly onRecovery: (
        request: AiSessionStreamControllerRecoveryRequest,
    ) => void;
    private peakInFlightPayloadCount = 0;
    private readonly pendingAckSentAtBySeq = new Map<number, number>();
    private readonly pendingDeliveryPayloads: AiSessionStreamDeliveryQueue =
        new Map();
    private readonly pendingInFlightPayloadSeqs = new Set<number>();
    private readonly pendingPreservedPayloads: AiSessionStreamPreservationQueue =
        new Map();
    private readonly postMessage: (message: AiSessionStreamMessage) => void;
    private recovering = false;
    private readonly staleMs: number;

    constructor(options: AiSessionStreamControllerOptions) {
        this.maxInFlight =
            options.maxInFlight ?? AI_SESSION_STREAM_MAX_IN_FLIGHT;
        this.maxPendingPayloads =
            options.maxPendingPayloads ??
            AI_SESSION_STREAM_MAX_PENDING_PAYLOADS;
        this.maxPreservedPayloads = options.maxPreservedPayloads ?? 100;
        this.now = options.now ?? Date.now;
        this.onMessageSent = options.onMessageSent ?? (() => undefined);
        this.onRecovery = options.onRecovery;
        this.postMessage = options.postMessage;
        this.staleMs = options.staleMs ?? 10_000;
        const now = this.now();
        this.lastSentAt = now;
    }

    get ackState(): AiSessionStreamAckState {
        return {
            lastAckSeq: this.lastAckSeq,
            lastSentAt: this.lastSentAt,
            lastSentSeq: this.lastSentSeq,
            pendingAckSentAtBySeq: new Map(this.pendingAckSentAtBySeq),
        };
    }

    get metrics(): AiSessionStreamControllerMetrics {
        return {
            coalescedPendingPayloadCount: this.coalescedPendingPayloadCount,
            peakInFlightPayloadCount: this.peakInFlightPayloadCount,
            pendingDeliveryPayloadCount: this.pendingDeliveryPayloads.size,
            pendingInFlightPayloadCount:
                this.pendingInFlightPayloadSeqs.size,
            pendingPreservedPayloadCount:
                this.pendingPreservedPayloads.size +
                this.pendingDeliveryPayloads.size,
        };
    }

    acknowledge(seq: number): void {
        if (this.recovering) return;
        this.lastAckSeq = Math.max(this.lastAckSeq, seq);
        // ACKs stay exact so a newer ping cannot release an older payload.
        this.pendingAckSentAtBySeq.delete(seq);
        releaseAcknowledgedAiSessionStreamPayloads(
            this.pendingInFlightPayloadSeqs,
            seq,
        );
        for (const [key, pendingPayload] of this.pendingPreservedPayloads) {
            if (pendingPayload.seq === seq) {
                this.pendingPreservedPayloads.delete(key);
            }
        }
        this.drain();
    }

    isAckStale(nowMs = this.now()): boolean {
        return isAiSessionStreamAckStale(
            this.ackState,
            nowMs,
            this.staleMs,
        );
    }

    postHeartbeat(): void {
        if (this.recovering) return;
        if (this.isAckStale()) {
            this.requestRecovery("heartbeat-stale");
            return;
        }
        const message = this.nextMessage("ping");
        try {
            this.postMessage(message);
            this.onMessageSent();
        } catch {
            this.requestRecovery("heartbeat-error");
        }
    }

    postPayload(payload: AiSessionStreamPayload): void {
        if (this.recovering) return;
        if (this.isAckStale()) {
            this.requestRecovery("pre-send-stale", [payload]);
            return;
        }
        if (this.pendingInFlightPayloadSeqs.size < this.maxInFlight) {
            this.sendPayload(payload);
            return;
        }

        const result = rememberAiSessionStreamPayloadForDelivery({
            maxPayloads: this.maxPendingPayloads,
            order: this.nextPendingOrder,
            payload,
            queue: this.pendingDeliveryPayloads,
        });
        this.nextPendingOrder += 1;
        if (result.coalesced) this.coalescedPendingPayloadCount += 1;
        if (result.preserved && !result.droppedOldest) return;

        // A rejected payload is not present in either recovery queue.
        this.requestRecovery(
            "post-error",
            result.preserved ? [] : [payload],
        );
    }

    takeRecoveryPayloads(
        additionalPayloads: readonly AiSessionStreamPayload[] = [],
    ): readonly PendingPreservedAiSessionStreamPayload[] {
        const pendingPayloads: PendingPreservedAiSessionStreamPayload[] = [
            ...this.pendingPreservedPayloads.values(),
            ...[...this.pendingDeliveryPayloads.values()].map((pending) => ({
                payload: pending.payload,
                seq: this.nextSeq + pending.order,
            })),
        ];
        let nextAdditionalSeq =
            pendingPayloads.reduce(
                (highest, pending) => Math.max(highest, pending.seq),
                this.nextSeq,
            ) + 1;
        for (const payload of additionalPayloads) {
            pendingPayloads.push({ payload, seq: nextAdditionalSeq });
            nextAdditionalSeq += 1;
        }
        this.pendingPreservedPayloads.clear();
        this.pendingDeliveryPayloads.clear();
        this.pendingInFlightPayloadSeqs.clear();
        this.pendingAckSentAtBySeq.clear();
        return pendingPayloads;
    }

    private drain(): void {
        while (
            !this.recovering &&
            this.pendingInFlightPayloadSeqs.size < this.maxInFlight
        ) {
            const pending = takeNextAiSessionStreamDelivery(
                this.pendingDeliveryPayloads,
            );
            if (!pending) return;
            this.sendPayload(pending.payload);
        }
    }

    private nextMessage(type: "ping"): AiSessionStreamMessage;
    private nextMessage(
        type: "payload",
        payload: AiSessionStreamPayload,
    ): AiSessionStreamMessage;
    private nextMessage(
        type: "payload" | "ping",
        payload?: AiSessionStreamPayload,
    ): AiSessionStreamMessage {
        const seq = this.nextSeq;
        this.nextSeq += 1;
        this.lastSentAt = this.now();
        this.lastSentSeq = seq;
        this.pendingAckSentAtBySeq.set(seq, this.lastSentAt);
        if (type === "ping") {
            return { sentAt: this.lastSentAt, seq, type };
        }
        return { payload: payload as AiSessionStreamPayload, seq, type };
    }

    private requestRecovery(
        reason: AiSessionStreamRecoveryReason,
        additionalPayloads: readonly AiSessionStreamPayload[] = [],
    ): void {
        if (this.recovering) return;
        this.recovering = true;
        this.onRecovery({ additionalPayloads, reason });
    }

    private sendPayload(payload: AiSessionStreamPayload): void {
        const message = this.nextMessage("payload", payload);
        const preservation = rememberAiSessionStreamPayloadForRecovery({
            maxPayloads: this.maxPreservedPayloads,
            payload,
            queue: this.pendingPreservedPayloads,
            seq: message.seq,
        });
        this.pendingInFlightPayloadSeqs.add(message.seq);
        this.peakInFlightPayloadCount = Math.max(
            this.peakInFlightPayloadCount,
            this.pendingInFlightPayloadSeqs.size,
        );
        try {
            this.postMessage(message);
            this.onMessageSent();
        } catch {
            this.requestRecovery(
                "post-error",
                preservation.preserved ? [] : [payload],
            );
        }
    }
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
