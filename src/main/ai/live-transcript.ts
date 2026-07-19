import type {
    AiMessage,
    AiOpenTranscriptTail,
    AiPlan,
    AiSessionDomainEvent,
    AiSessionSnapshot,
    AiSessionStatus,
    AiToolActivity,
    AiTranscriptBlockMetadata,
    AiTranscriptEntryEnvelope,
} from "@shared/ipc";

export type AiLiveTranscriptPayload =
    | {
          readonly kind: "message";
          readonly message: AiMessage;
      }
    | {
          readonly activity: AiToolActivity;
          readonly kind: "tool";
      }
    | {
          readonly activeTurnStartedAt: string | null;
          readonly kind: "status";
          readonly lastError: string | null;
          readonly status: AiSessionStatus;
      }
    | {
          readonly kind: "plan";
          readonly plan: AiPlan;
      };

export interface AiLiveTranscriptEntry {
    readonly envelope: AiTranscriptEntryEnvelope;
    readonly payload: AiLiveTranscriptPayload;
}

export interface AiLiveTranscriptTailSnapshot {
    readonly entries: readonly AiLiveTranscriptVersionedEntry[];
    readonly revision: number;
    readonly sessionId: string;
    readonly stableBlocks: readonly AiTranscriptBlockMetadata[];
    readonly terminalTurnStatus: "cancelled" | "completed" | "failed" | null;
    readonly turnId: string | null;
}

export interface AiLiveTranscriptVersionedEntry extends AiLiveTranscriptEntry {
    readonly entryRevision: number;
}

export type AiLiveTranscriptPendingEntry = AiLiveTranscriptVersionedEntry;

interface MutableLiveTranscriptEntry
    extends Omit<AiLiveTranscriptEntry, "envelope"> {
    envelope: AiTranscriptEntryEnvelope;
    entryRevision: number;
}

interface SessionLiveTranscriptTail {
    readonly entriesById: Map<string, MutableLiveTranscriptEntry>;
    readonly orderedEntryIds: string[];
    readonly pendingEntryRevisionById: Map<string, number>;
    revision: number;
    stableBlocks: readonly AiTranscriptBlockMetadata[];
    stableEndSequence: number;
    terminalTurnStatus: "cancelled" | "completed" | "failed" | null;
    turnId: string | null;
    turnStartedAt: string | null;
}

const STATUS_ENTRY_ID = "status:active-turn";
const PLAN_ENTRY_ID = "plan:active";
const SUMMARY_PREVIEW_LENGTH = 280;

export class AiLiveTranscriptTailStore {
    readonly #sessions = new Map<string, SessionLiveTranscriptTail>();

    clear(): void {
        this.#sessions.clear();
    }

    clearSession(sessionId: string): void {
        this.#sessions.delete(sessionId);
    }

    restoreOpenTail(tail: AiOpenTranscriptTail): void {
        const previous = this.#sessions.get(tail.sessionId);
        // A live turn can emit events while its persisted tail is loading.
        // Never let an older recovered turn replace a newer in-memory one.
        if (
            previous?.turnId !== null &&
            previous?.turnId !== undefined &&
            previous.turnId !== tail.turnId
        ) {
            return;
        }
        const payloadByRef = new Map(
            tail.payloads.map((payload) => [payload.payloadRef, payload.value]),
        );
        const revisionByEntryId = new Map(
            tail.entryRevisions.map((entry) => [entry.entryId, entry]),
        );
        const entriesById = new Map<string, MutableLiveTranscriptEntry>();
        const orderedEntryIds: string[] = [];
        const pendingEntryRevisionById = new Map<string, number>();
        for (const envelope of tail.entries) {
            const payloadRef = envelope.payloadRef;
            const payload = payloadRef ? payloadByRef.get(payloadRef) : null;
            const entryState = revisionByEntryId.get(envelope.id);
            if (!isLiveTranscriptPayload(payload) || !entryState) {
                continue;
            }
            entriesById.set(envelope.id, {
                entryRevision: entryState.entryRevision,
                envelope,
                payload,
            });
            orderedEntryIds[entryState.ordinal] = envelope.id;
            pendingEntryRevisionById.set(
                envelope.id,
                entryState.entryRevision,
            );
        }
        const compactOrder = orderedEntryIds.filter(Boolean);
        const turnStartedAt = compactOrder.reduce<string | null>(
            (minimum, entryId) => {
                const createdAt = entriesById.get(entryId)?.envelope.createdAt;
                if (!createdAt) {
                    return minimum;
                }
                return minimum === null || createdAt < minimum
                    ? createdAt
                    : minimum;
            },
            null,
        );
        this.#sessions.set(tail.sessionId, {
            entriesById,
            orderedEntryIds: compactOrder,
            pendingEntryRevisionById,
            revision: Math.max(previous?.revision ?? 0, tail.revision),
            stableBlocks: previous?.stableBlocks ?? [],
            stableEndSequence: previous?.stableEndSequence ?? 0,
            terminalTurnStatus: tail.terminalStatus,
            turnId: tail.turnId,
            turnStartedAt,
        });

        if (!previous) {
            return;
        }

        const restored = this.#sessions.get(tail.sessionId);
        if (!restored) {
            return;
        }

        // Replay entries received after recovery started. #upsertEntry merges
        // duplicate IDs deterministically and keeps replayed entries pending.
        for (const entryId of previous.orderedEntryIds) {
            const entry = previous.entriesById.get(entryId);
            if (entry) {
                this.#upsertEntry(restored, entry);
            }
        }
        if (
            previous.terminalTurnStatus !== null &&
            restored.terminalTurnStatus !== previous.terminalTurnStatus
        ) {
            restored.terminalTurnStatus = previous.terminalTurnStatus;
            restored.revision += 1;
        }
    }

    synchronizeSnapshot(snapshot: AiSessionSnapshot): void {
        const session = this.#sessionFor(snapshot.sessionId);
        const turnId = snapshot.activeTurnStartedAt ?? null;
        if (!turnId) {
            return;
        }

        this.#beginTurn(session, turnId);
        for (const message of snapshot.messages) {
            if (message.createdAt < turnId) {
                continue;
            }
            this.#upsertEntry(
                session,
                createMessageEntry(snapshot.sessionId, message),
            );
        }
        for (const activity of snapshot.toolActivity) {
            if (activity.createdAt < turnId) {
                continue;
            }
            this.#upsertEntry(
                session,
                createToolEntry(snapshot.sessionId, activity),
            );
        }
        this.#upsertEntry(
            session,
            createStatusEntry(snapshot.sessionId, {
                activeTurnStartedAt: turnId,
                lastError: snapshot.lastError,
                status: snapshot.status,
                updatedAt: snapshot.updatedAt,
            }),
        );
        if (snapshot.plan) {
            this.#upsertEntry(
                session,
                createPlanEntry(
                    snapshot.sessionId,
                    snapshot.plan,
                    snapshot.updatedAt,
                    turnId,
                ),
            );
        }
    }

    setStableBlocks(
        sessionId: string,
        blocks: readonly AiTranscriptBlockMetadata[],
    ): void {
        const session = this.#sessionFor(sessionId);
        const blocksById = new Map<string, AiTranscriptBlockMetadata>();
        for (const block of blocks) {
            if (block.sessionId !== sessionId) {
                continue;
            }
            const current = blocksById.get(block.blockId);
            if (!current || current.revision < block.revision) {
                blocksById.set(block.blockId, block);
            }
        }
        const stableBlocks = [...blocksById.values()].sort(
            (left, right) =>
                left.startSequence - right.startSequence ||
                left.blockId.localeCompare(right.blockId),
        );
        const stableEndSequence = stableBlocks.reduce(
            (maximum, block) => Math.max(maximum, block.endSequence),
            0,
        );
        if (
            sameStableBlocks(session.stableBlocks, stableBlocks) &&
            session.stableEndSequence === stableEndSequence
        ) {
            return;
        }

        session.stableBlocks = stableBlocks;
        session.stableEndSequence = stableEndSequence;
        this.#renumberEntries(session, 0);
        session.revision += 1;
    }

    applyEvent(event: AiSessionDomainEvent): AiLiveTranscriptTailSnapshot {
        const session = this.#sessionFor(event.sessionId);
        if (event.kind === "status") {
            if (event.activeTurnStartedAt) {
                this.#beginTurn(session, event.activeTurnStartedAt);
            }
        }

        const entry = createEntryFromEvent(session, event);
        if (entry) {
            this.#upsertEntry(session, entry);
        } else if (event.kind === "plan" && event.plan === null) {
            this.#removeEntryByPayloadKind(session, "plan");
        } else if (
            (event.kind === "status" && !event.activeTurnStartedAt) ||
            event.kind === "session-closed"
        ) {
            this.#removeEntryByPayloadKind(session, "status");
        } else if (event.kind === "turn-status") {
            if (
                session.turnStartedAt === null ||
                event.updatedAt >= session.turnStartedAt
            ) {
                session.turnId = event.turnId;
                if (session.terminalTurnStatus !== event.status) {
                    session.terminalTurnStatus = event.status;
                    session.revision += 1;
                }
            }
        }

        return this.#snapshot(event.sessionId, session);
    }

    getSnapshot(sessionId: string): AiLiveTranscriptTailSnapshot | null {
        const session = this.#sessions.get(sessionId);
        return session ? this.#snapshot(sessionId, session) : null;
    }

    getPayload(
        sessionId: string,
        payloadRef: string,
    ): AiLiveTranscriptPayload | null {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return null;
        }
        for (const entry of session.entriesById.values()) {
            if (entry.envelope.payloadRef === payloadRef) {
                return entry.payload;
            }
        }
        return null;
    }

    takePendingEntries(
        sessionId: string,
    ): readonly AiLiveTranscriptPendingEntry[] {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return [];
        }
        return session.orderedEntryIds.flatMap((entryId) => {
            const pendingRevision =
                session.pendingEntryRevisionById.get(entryId);
            const entry = session.entriesById.get(entryId);
            return pendingRevision === undefined || !entry
                ? []
                : [{ ...entry, entryRevision: pendingRevision }];
        });
    }

    acknowledgePendingEntries(
        sessionId: string,
        entries: readonly Pick<
            AiLiveTranscriptPendingEntry,
            "entryRevision" | "envelope"
        >[],
    ): void {
        const session = this.#sessions.get(sessionId);
        if (!session) {
            return;
        }
        for (const entry of entries) {
            if (
                session.pendingEntryRevisionById.get(entry.envelope.id) ===
                entry.entryRevision
            ) {
                session.pendingEntryRevisionById.delete(entry.envelope.id);
            }
        }
    }

    acknowledgeSealedTurn(
        sessionId: string,
        turnId: string,
        stableBlocks: readonly AiTranscriptBlockMetadata[],
        expectedRevision: number,
    ): boolean {
        const session = this.#sessions.get(sessionId);
        if (
            !session ||
            session.turnId !== turnId ||
            session.revision !== expectedRevision
        ) {
            return false;
        }
        session.entriesById.clear();
        session.orderedEntryIds.length = 0;
        session.pendingEntryRevisionById.clear();
        session.turnId = null;
        session.turnStartedAt = null;
        session.terminalTurnStatus = null;
        this.setStableBlocks(sessionId, [
            ...session.stableBlocks,
            ...stableBlocks,
        ]);
        session.revision += 1;
        return true;
    }

    projectLegacySnapshot(snapshot: AiSessionSnapshot): AiSessionSnapshot {
        const session = this.#sessions.get(snapshot.sessionId);
        if (!session || session.orderedEntryIds.length === 0) {
            return snapshot;
        }

        const messagesById = new Map(
            snapshot.messages.map((message) => [message.id, message]),
        );
        const toolsById = new Map(
            snapshot.toolActivity.map((activity) => [activity.id, activity]),
        );
        let plan = snapshot.plan;
        for (const entryId of session.orderedEntryIds) {
            const payload = session.entriesById.get(entryId)?.payload;
            if (!payload) {
                continue;
            }
            if (payload.kind === "message") {
                messagesById.set(payload.message.id, payload.message);
            } else if (payload.kind === "tool") {
                toolsById.set(payload.activity.id, payload.activity);
            } else if (payload.kind === "plan") {
                plan = payload.plan;
            }
        }

        return {
            ...snapshot,
            messages: [...messagesById.values()].sort(compareMessages),
            plan,
            toolActivity: [...toolsById.values()].sort(compareToolActivity),
        };
    }

    #beginTurn(session: SessionLiveTranscriptTail, turnId: string): void {
        if (session.turnId === turnId) {
            return;
        }
        if (session.turnStartedAt !== null && session.entriesById.size > 0) {
            return;
        }
        session.turnId = turnId;
        session.turnStartedAt = turnId;
        session.terminalTurnStatus = null;
        session.revision += 1;
    }

    #removeEntry(session: SessionLiveTranscriptTail, entryId: string): void {
        const index = session.orderedEntryIds.indexOf(entryId);
        if (index < 0) {
            return;
        }
        session.entriesById.delete(entryId);
        session.pendingEntryRevisionById.delete(entryId);
        session.orderedEntryIds.splice(index, 1);
        this.#renumberEntries(session, index);
        session.revision += 1;
    }

    #removeEntryByPayloadKind(
        session: SessionLiveTranscriptTail,
        kind: "plan" | "status",
    ): void {
        const entryId = session.orderedEntryIds.find(
            (candidateId) =>
                session.entriesById.get(candidateId)?.payload.kind === kind,
        );
        if (entryId) {
            this.#removeEntry(session, entryId);
        }
    }

    #renumberEntries(
        session: SessionLiveTranscriptTail,
        startIndex: number,
    ): void {
        for (
            let index = Math.max(0, startIndex);
            index < session.orderedEntryIds.length;
            index += 1
        ) {
            const entryId = session.orderedEntryIds[index];
            const entry = session.entriesById.get(entryId);
            if (!entry) {
                continue;
            }
            const sequence = session.stableEndSequence + index + 1;
            if (entry.envelope.sequence === sequence) {
                continue;
            }
            const nextEntry = {
                ...entry,
                entryRevision: entry.entryRevision + 1,
                envelope: { ...entry.envelope, sequence },
            };
            session.entriesById.set(entryId, nextEntry);
            session.pendingEntryRevisionById.set(
                entryId,
                nextEntry.entryRevision,
            );
        }
    }

    #sessionFor(sessionId: string): SessionLiveTranscriptTail {
        let session = this.#sessions.get(sessionId);
        if (!session) {
            session = {
                entriesById: new Map(),
                orderedEntryIds: [],
                pendingEntryRevisionById: new Map(),
                revision: 0,
                stableBlocks: [],
                stableEndSequence: 0,
                terminalTurnStatus: null,
                turnId: null,
                turnStartedAt: null,
            };
            this.#sessions.set(sessionId, session);
        }
        return session;
    }

    #snapshot(
        sessionId: string,
        session: SessionLiveTranscriptTail,
    ): AiLiveTranscriptTailSnapshot {
        return {
            entries: session.orderedEntryIds.flatMap((entryId) => {
                const entry = session.entriesById.get(entryId);
                return entry ? [entry] : [];
            }),
            revision: session.revision,
            sessionId,
            stableBlocks: session.stableBlocks,
            terminalTurnStatus: session.terminalTurnStatus,
            turnId: session.turnId,
        };
    }

    #upsertEntry(
        session: SessionLiveTranscriptTail,
        incoming: AiLiveTranscriptEntry,
    ): void {
        const existing = session.entriesById.get(incoming.envelope.id);
        const candidate = mergeLiveEntry(existing, incoming);
        const merged = existing
            ? {
                  ...candidate,
                  envelope: {
                      ...candidate.envelope,
                      sequence: existing.envelope.sequence,
                  },
              }
            : candidate;
        if (existing && sameLiveEntry(existing, merged)) {
            return;
        }

        const entryRevision = (existing?.entryRevision ?? 0) + 1;
        const mutableEntry: MutableLiveTranscriptEntry = {
            ...merged,
            entryRevision,
        };
        session.entriesById.set(incoming.envelope.id, mutableEntry);
        let renumberFrom = session.orderedEntryIds.length;
        if (existing) {
            const existingIndex = session.orderedEntryIds.indexOf(
                incoming.envelope.id,
            );
            const orderChanged =
                existing.envelope.createdAt !== merged.envelope.createdAt;
            if (orderChanged && existingIndex >= 0) {
                session.orderedEntryIds.splice(existingIndex, 1);
                renumberFrom = existingIndex;
                const insertAt = findInsertIndex(
                    session.orderedEntryIds,
                    session.entriesById,
                    mutableEntry,
                );
                session.orderedEntryIds.splice(insertAt, 0, incoming.envelope.id);
                renumberFrom = Math.min(renumberFrom, insertAt);
            }
        } else {
            const insertAt = findInsertIndex(
                session.orderedEntryIds,
                session.entriesById,
                mutableEntry,
            );
            session.orderedEntryIds.splice(insertAt, 0, incoming.envelope.id);
            renumberFrom = insertAt;
        }
        this.#renumberEntries(session, renumberFrom);
        const storedEntry = session.entriesById.get(incoming.envelope.id);
        session.pendingEntryRevisionById.set(
            incoming.envelope.id,
            storedEntry?.entryRevision ?? mutableEntry.entryRevision,
        );
        session.revision += 1;
    }
}

function createEntryFromEvent(
    session: SessionLiveTranscriptTail,
    event: AiSessionDomainEvent,
): AiLiveTranscriptEntry | null {
    if (
        event.kind === "message-started" ||
        event.kind === "thinking-started" ||
        event.kind === "image-generation"
    ) {
        const existing = session.entriesById.get(
            messageEntryId(event.message.id),
        );
        if (!existing && !canCreateEntry(session, event.message.createdAt)) {
            return null;
        }
        if (
            existing &&
            session.turnStartedAt &&
            session.turnId === session.turnStartedAt &&
            event.message.createdAt < session.turnStartedAt
        ) {
            session.turnId = event.message.createdAt;
            session.turnStartedAt = event.message.createdAt;
        }
        ensureProvisionalTurn(session, event.message.createdAt);
        return createMessageEntry(event.sessionId, event.message);
    }
    if (event.kind === "message-delta" || event.kind === "thinking-delta") {
        const entryId = messageEntryId(event.messageId);
        const existing = session.entriesById.get(entryId);
        if (!existing && !canCreateEntry(session, event.updatedAt)) {
            return null;
        }
        ensureProvisionalTurn(session, event.updatedAt);
        const existingMessage =
            existing?.payload.kind === "message"
                ? existing.payload.message
                : null;
        return createMessageEntry(event.sessionId, {
            attachments: existingMessage?.attachments ?? [],
            content: chooseMessageContent(
                existingMessage?.content ?? "",
                event.content,
                event.delta,
            ),
            createdAt: existingMessage?.createdAt ?? event.updatedAt,
            generatedImage: existingMessage?.generatedImage ?? null,
            id: event.messageId,
            kind:
                event.kind === "thinking-delta"
                    ? "thinking"
                    : event.messageKind,
            status:
                existingMessage?.status === "completed"
                    ? "completed"
                    : "streaming",
        }, event.updatedAt);
    }
    if (
        event.kind === "message-completed" ||
        event.kind === "thinking-completed"
    ) {
        const existing = session.entriesById.get(messageEntryId(event.messageId));
        if (!existing || existing.payload.kind !== "message") {
            return null;
        }
        return createMessageEntry(
            event.sessionId,
            { ...existing.payload.message, status: "completed" },
            event.updatedAt,
        );
    }
    if (event.kind === "tool-activity") {
        if (!canCreateEntry(session, event.activity.createdAt)) {
            return null;
        }
        ensureProvisionalTurn(session, event.activity.createdAt);
        return createToolEntry(event.sessionId, event.activity);
    }
    if (event.kind === "status" && event.activeTurnStartedAt) {
        return createStatusEntry(event.sessionId, {
            activeTurnStartedAt: event.activeTurnStartedAt,
            lastError: event.lastError,
            status: event.status,
            updatedAt: event.updatedAt,
        });
    }
    if (event.kind === "plan" && event.plan) {
        if (!canCreateEntry(session, event.plan.updatedAt)) {
            return null;
        }
        ensureProvisionalTurn(session, event.plan.updatedAt);
        return createPlanEntry(
            event.sessionId,
            event.plan,
            event.updatedAt,
            session.turnStartedAt ?? event.plan.updatedAt,
        );
    }
    return null;
}

function canCreateEntry(
    session: SessionLiveTranscriptTail,
    createdAt: string,
): boolean {
    return session.turnStartedAt === null || createdAt >= session.turnStartedAt;
}

function ensureProvisionalTurn(
    session: SessionLiveTranscriptTail,
    createdAt: string,
): void {
    if (session.turnStartedAt === null) {
        session.turnId = createdAt;
        session.turnStartedAt = createdAt;
        session.terminalTurnStatus = null;
        session.revision += 1;
    }
}

function createMessageEntry(
    sessionId: string,
    message: AiMessage,
    updatedAt = message.createdAt,
): AiLiveTranscriptEntry {
    const id = messageEntryId(message.id);
    return {
        envelope: {
            createdAt: message.createdAt,
            id,
            kind: message.kind === "thinking" ? "thinking" : "message",
            payloadRef: payloadRefFor(id),
            sequence: 0,
            sessionId,
            summary: {
                label: message.kind,
                preview: message.content.slice(0, SUMMARY_PREVIEW_LENGTH),
                status: message.status,
            },
            updatedAt,
        },
        payload: { kind: "message", message },
    };
}

function createToolEntry(
    sessionId: string,
    activity: AiToolActivity,
): AiLiveTranscriptEntry {
    const id = `tool:${sessionId}:${activity.id}`;
    return {
        envelope: {
            createdAt: activity.createdAt,
            id,
            kind: "tool",
            payloadRef: payloadRefFor(id),
            sequence: 0,
            sessionId,
            summary: {
                label: activity.title,
                preview: activity.summary,
                status: activity.status,
            },
            updatedAt: activity.updatedAt,
        },
        payload: { activity, kind: "tool" },
    };
}

function createStatusEntry(
    sessionId: string,
    status: {
        readonly activeTurnStartedAt: string;
        readonly lastError: string | null;
        readonly status: AiSessionStatus;
        readonly updatedAt: string;
    },
): AiLiveTranscriptEntry {
    const id = scopedTurnEntryId(
        STATUS_ENTRY_ID,
        status.activeTurnStartedAt,
    );
    return {
        envelope: {
            createdAt: status.activeTurnStartedAt,
            id,
            kind: "status",
            payloadRef: payloadRefFor(id),
            sequence: 0,
            sessionId,
            summary: {
                label: "Session status",
                preview: status.lastError,
                status: status.status,
            },
            updatedAt: status.updatedAt,
        },
        payload: {
            activeTurnStartedAt: status.activeTurnStartedAt,
            kind: "status",
            lastError: status.lastError,
            status: status.status,
        },
    };
}

function createPlanEntry(
    sessionId: string,
    plan: AiPlan,
    updatedAt: string,
    turnStartedAt: string,
): AiLiveTranscriptEntry {
    const id = scopedTurnEntryId(PLAN_ENTRY_ID, turnStartedAt);
    return {
        envelope: {
            createdAt: plan.updatedAt,
            id,
            kind: "plan",
            payloadRef: payloadRefFor(id),
            sequence: 0,
            sessionId,
            summary: {
                label: plan.title,
                preview: plan.entries
                    .map((entry) => entry.content)
                    .join("\n")
                    .slice(0, SUMMARY_PREVIEW_LENGTH),
                status: plan.entries.some((entry) => entry.status !== "completed")
                    ? "in_progress"
                    : "completed",
            },
            updatedAt,
        },
        payload: { kind: "plan", plan },
    };
}

function mergeLiveEntry(
    existing: MutableLiveTranscriptEntry | undefined,
    incoming: AiLiveTranscriptEntry,
): AiLiveTranscriptEntry {
    if (!existing || existing.payload.kind !== incoming.payload.kind) {
        return incoming;
    }
    if (
        existing.payload.kind === "message" &&
        incoming.payload.kind === "message"
    ) {
        const existingMessage = existing.payload.message;
        const incomingMessage = incoming.payload.message;
        const content = chooseDeterministicContent(
            existingMessage.content,
            incomingMessage.content,
            existing.envelope.updatedAt,
            incoming.envelope.updatedAt,
        );
        const message: AiMessage = {
            ...richerMessage(existingMessage, incomingMessage),
            attachments:
                incomingMessage.attachments.length > 0
                    ? incomingMessage.attachments
                    : existingMessage.attachments,
            content,
            createdAt:
                existingMessage.createdAt < incomingMessage.createdAt
                    ? existingMessage.createdAt
                    : incomingMessage.createdAt,
            generatedImage:
                incomingMessage.generatedImage ??
                existingMessage.generatedImage ??
                null,
            status:
                existingMessage.status === "completed" ||
                incomingMessage.status === "completed"
                    ? "completed"
                    : "streaming",
        };
        return createMessageEntry(
            incoming.envelope.sessionId,
            message,
            maximumTimestamp(
                existing.envelope.updatedAt,
                incoming.envelope.updatedAt,
            ),
        );
    }
    if (
        existing.payload.kind === "tool" &&
        incoming.payload.kind === "tool"
    ) {
        const existingActivity = existing.payload.activity;
        const incomingActivity = incoming.payload.activity;
        const incomingWins =
            incomingActivity.updatedAt > existingActivity.updatedAt ||
            (incomingActivity.updatedAt === existingActivity.updatedAt &&
                stableJson(incomingActivity) >= stableJson(existingActivity));
        const winner = incomingWins ? incomingActivity : existingActivity;
        return createToolEntry(incoming.envelope.sessionId, {
            ...winner,
            diffs:
                winner.diffs.length > 0
                    ? winner.diffs
                    : existingActivity.diffs.length > 0
                      ? existingActivity.diffs
                      : incomingActivity.diffs,
        });
    }
    if (incoming.envelope.updatedAt < existing.envelope.updatedAt) {
        return existing;
    }
    if (
        incoming.envelope.updatedAt === existing.envelope.updatedAt &&
        stableJson(incoming.payload) < stableJson(existing.payload)
    ) {
        return existing;
    }
    return incoming;
}

function richerMessage(left: AiMessage, right: AiMessage): AiMessage {
    const leftWeight = messageMetadataWeight(left);
    const rightWeight = messageMetadataWeight(right);
    if (leftWeight !== rightWeight) {
        return leftWeight > rightWeight ? left : right;
    }
    return stableJson(left) >= stableJson(right) ? left : right;
}

function messageMetadataWeight(message: AiMessage): number {
    return (
        message.attachments.length * 2 +
        (message.generatedImage ? 2 : 0) +
        (message.status === "completed" ? 1 : 0)
    );
}

function chooseMessageContent(
    existing: string,
    content: string,
    delta: string,
): string {
    if (content.length >= existing.length) {
        return content;
    }
    return existing.endsWith(delta) ? existing : `${existing}${delta}`;
}

function chooseDeterministicContent(
    existing: string,
    incoming: string,
    existingUpdatedAt: string,
    incomingUpdatedAt: string,
): string {
    if (existing.length !== incoming.length) {
        return existing.length > incoming.length ? existing : incoming;
    }
    if (existingUpdatedAt !== incomingUpdatedAt) {
        return existingUpdatedAt > incomingUpdatedAt ? existing : incoming;
    }
    return existing > incoming ? existing : incoming;
}

function findInsertIndex(
    orderedEntryIds: readonly string[],
    entriesById: ReadonlyMap<string, MutableLiveTranscriptEntry>,
    entry: AiLiveTranscriptEntry,
): number {
    let low = 0;
    let high = orderedEntryIds.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = entriesById.get(orderedEntryIds[middle]);
        if (candidate && compareEntries(candidate, entry) <= 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function compareEntries(
    left: AiLiveTranscriptEntry,
    right: AiLiveTranscriptEntry,
): number {
    return (
        left.envelope.createdAt.localeCompare(right.envelope.createdAt) ||
        left.envelope.id.localeCompare(right.envelope.id)
    );
}

function compareMessages(left: AiMessage, right: AiMessage): number {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareToolActivity(
    left: AiToolActivity,
    right: AiToolActivity,
): number {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function messageEntryId(messageId: string): string {
    return `message:${messageId}`;
}

function payloadRefFor(entryId: string): string {
    return `tail:${entryId}`;
}

function scopedTurnEntryId(baseId: string, turnStartedAt: string): string {
    return `${baseId}:${turnStartedAt}`;
}

function maximumTimestamp(left: string, right: string): string {
    return left > right ? left : right;
}

function sameLiveEntry(
    left: AiLiveTranscriptEntry,
    right: AiLiveTranscriptEntry,
): boolean {
    return (
        stableJson(left.envelope) === stableJson(right.envelope) &&
        stableJson(left.payload) === stableJson(right.payload)
    );
}

function sameStableBlocks(
    left: readonly AiTranscriptBlockMetadata[],
    right: readonly AiTranscriptBlockMetadata[],
): boolean {
    return stableJson(left) === stableJson(right);
}

function isLiveTranscriptPayload(
    value: unknown,
): value is AiLiveTranscriptPayload {
    if (!value || typeof value !== "object" || !("kind" in value)) {
        return false;
    }
    const kind = (value as { readonly kind?: unknown }).kind;
    return (
        kind === "message" ||
        kind === "tool" ||
        kind === "status" ||
        kind === "plan"
    );
}

function stableJson(value: unknown): string {
    return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
}
