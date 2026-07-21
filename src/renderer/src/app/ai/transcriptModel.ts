import type {
    AiMessage,
    AiPlan,
    AiSessionDomainEvent,
    AiSessionPatch,
    AiSessionSnapshot,
    AiSessionStatus,
    AiToolActivity,
} from "@shared/ipc";
import {
    AI_TRANSCRIPT_PLAN_ENTRY_ID,
    AI_TRANSCRIPT_STATUS_ENTRY_ID,
    attachAiSubagentSessionAction,
    getAiTranscriptMessageEntryId,
    getAiTranscriptToolEntryId,
    mergeAiTranscriptMessage,
    mergeAiTranscriptToolActivity,
} from "@shared/ai-transcript";

export type AiSessionTranscriptEntry =
    | {
          readonly createdAt: string;
          readonly id: string;
          readonly kind: "message";
          readonly message: AiMessage;
          readonly updatedAt: string;
      }
    | {
          readonly activity: AiToolActivity;
          readonly createdAt: string;
          readonly id: string;
          readonly kind: "tool";
          readonly updatedAt: string;
      }
    | {
          readonly activeTurnStartedAt: string | null;
          readonly createdAt: string;
          readonly id: string;
          readonly kind: "status";
          readonly lastError: string | null;
          readonly status: AiSessionStatus;
          readonly updatedAt: string;
      }
    | {
          readonly createdAt: string;
          readonly id: string;
          readonly kind: "plan";
          readonly plan: AiPlan | null;
          readonly updatedAt: string;
      };

export interface AiSessionTranscriptModel {
    readonly activePlanMessageId: string | null;
    readonly entriesById: Readonly<Record<string, AiSessionTranscriptEntry>>;
    readonly lastAssistantMessageId: string | null;
    readonly lastThinkingMessageId: string | null;
    readonly lastTurnStartedMessageId: string | null;
    readonly messageIndexById: Readonly<Record<string, number>>;
    readonly messageProjectionIndexByEntryId: Readonly<
        Record<string, number>
    >;
    readonly messageOrder: readonly string[];
    readonly messagesById: Readonly<Record<string, AiSessionTranscriptEntry>>;
    readonly messages: readonly AiMessage[];
    readonly orderedEntryIds: readonly string[];
    readonly toolActivity: readonly AiToolActivity[];
    readonly toolActivityProjectionIndexByEntryId: Readonly<
        Record<string, number>
    >;
}

export type AiSessionTranscriptMutation =
    | {
          readonly entryId: string;
          readonly kind: "append";
      }
    | {
          readonly entryId: string;
          readonly kind: "patch";
      }
    | {
          readonly entryId: string;
          readonly kind: "remove";
      }
    | {
          readonly kind: "rebuild";
      };

interface TranscriptBuildInput {
    readonly activeTurnStartedAt?: string | null;
    readonly messages: readonly AiMessage[];
    readonly plan?: AiPlan | null;
    readonly status?: AiSessionStatus;
    readonly toolActivity: readonly AiToolActivity[];
    readonly updatedAt?: string | null;
}

interface TranscriptMergeOptions {
    readonly includeMessages: boolean;
    readonly includePlan: boolean;
    readonly includeStatus: boolean;
    readonly includeTools: boolean;
    readonly preserveMissingTools?: boolean;
}

const PLAN_ENTRY_ID = AI_TRANSCRIPT_PLAN_ENTRY_ID;
const STATUS_ENTRY_ID = AI_TRANSCRIPT_STATUS_ENTRY_ID;
const OPAQUE_ENCRYPTED_MESSAGE_PATTERN = /^gAAAAA[A-Za-z0-9_-]{40,}={0,2}$/;
const transcriptMutationByModel = new WeakMap<
    AiSessionTranscriptModel,
    AiSessionTranscriptMutation
>();
const transcriptMutationParentByModel = new WeakMap<
    AiSessionTranscriptModel,
    AiSessionTranscriptModel
>();

export function getAiSessionTranscriptMutation(
    transcript: AiSessionTranscriptModel,
): AiSessionTranscriptMutation {
    return transcriptMutationByModel.get(transcript) ?? { kind: "rebuild" };
}

export function isAiSessionTranscriptMutationFrom(
    transcript: AiSessionTranscriptModel,
    previousTranscript: AiSessionTranscriptModel,
): boolean {
    return (
        transcriptMutationParentByModel.get(transcript) === previousTranscript
    );
}

export function getAiSessionTranscriptMutationChainFrom(
    transcript: AiSessionTranscriptModel,
    ancestor: AiSessionTranscriptModel,
): readonly AiSessionTranscriptModel[] | null {
    const chain: AiSessionTranscriptModel[] = [];
    let current: AiSessionTranscriptModel | undefined = transcript;
    while (current && current !== ancestor) {
        chain.push(current);
        current = transcriptMutationParentByModel.get(current);
    }
    return current === ancestor ? chain.reverse() : null;
}

export function createEmptyAiSessionTranscriptModel(): AiSessionTranscriptModel {
    return buildAiSessionTranscriptModel({
        messages: [],
        toolActivity: [],
    });
}

export function buildAiSessionTranscriptModel(
    input: TranscriptBuildInput,
): AiSessionTranscriptModel {
    const entries: AiSessionTranscriptEntry[] = [];

    for (const message of input.messages) {
        if (isOpaqueEncryptedInterAgentMessage(message)) {
            continue;
        }
        entries.push(createMessageTranscriptEntry(message));
    }

    for (const activity of input.toolActivity) {
        entries.push(createToolTranscriptEntry(activity));
    }

    if (input.activeTurnStartedAt) {
        entries.push({
            activeTurnStartedAt: input.activeTurnStartedAt,
            createdAt: input.activeTurnStartedAt,
            id: STATUS_ENTRY_ID,
            kind: "status",
            lastError: null,
            status: input.status ?? "streaming",
            updatedAt: input.updatedAt ?? input.activeTurnStartedAt,
        });
    }

    if (input.plan) {
        entries.push({
            createdAt: input.plan.updatedAt,
            id: PLAN_ENTRY_ID,
            kind: "plan",
            plan: input.plan,
            updatedAt: input.plan.updatedAt,
        });
    }

    return buildAiSessionTranscriptModelFromEntries(entries);
}

export function buildAiSessionTranscriptModelFromSnapshot(
    snapshot: Pick<
        AiSessionSnapshot,
        | "activeTurnStartedAt"
        | "messages"
        | "plan"
        | "status"
        | "toolActivity"
        | "updatedAt"
    >,
): AiSessionTranscriptModel {
    return buildAiSessionTranscriptModel(snapshot);
}

export function applyAiSessionDomainEventToTranscript(
    transcript: AiSessionTranscriptModel,
    event: AiSessionDomainEvent,
): AiSessionTranscriptModel {
    switch (event.kind) {
        case "message-started":
        case "thinking-started":
        case "image-generation":
            return upsertAiSessionTranscriptEntry(
                transcript,
                createMessageTranscriptEntry(event.message),
            );
        case "message-delta":
            return applyMessageDeltaToTranscript(transcript, {
                content: event.content,
                delta: event.delta,
                kind: event.messageKind,
                messageId: event.messageId,
                updatedAt: event.updatedAt,
            });
        case "thinking-delta":
            return applyMessageDeltaToTranscript(transcript, {
                content: event.content,
                delta: event.delta,
                kind: "thinking",
                messageId: event.messageId,
                updatedAt: event.updatedAt,
            });
        case "message-completed":
        case "thinking-completed":
            return replaceAiSessionTranscriptEntry(
                transcript,
                getMessageTranscriptId(event.messageId),
                (entry) =>
                    entry.kind === "message"
                        ? {
                              ...entry,
                              message: {
                                  ...entry.message,
                                  status: "completed",
                              },
                              updatedAt: event.updatedAt,
                          }
                        : entry,
            );
        case "tool-activity":
            return upsertAiSessionTranscriptEntry(
                transcript,
                createToolTranscriptEntry(event.activity),
                {
                    preserveCreatedAt: true,
                },
            );
        case "status":
            if (!event.activeTurnStartedAt) {
                return removeAiSessionTranscriptEntry(
                    transcript,
                    STATUS_ENTRY_ID,
                );
            }

            return upsertAiSessionTranscriptEntry(transcript, {
                activeTurnStartedAt: event.activeTurnStartedAt,
                createdAt: event.activeTurnStartedAt,
                id: STATUS_ENTRY_ID,
                kind: "status",
                lastError: event.lastError,
                status: event.status,
                updatedAt: event.updatedAt,
            });
        case "plan":
            if (!event.plan) {
                return removeAiSessionTranscriptEntry(
                    transcript,
                    PLAN_ENTRY_ID,
                );
            }

            return upsertAiSessionTranscriptEntry(transcript, {
                createdAt: event.plan.updatedAt,
                id: PLAN_ENTRY_ID,
                kind: "plan",
                plan: event.plan,
                updatedAt: event.updatedAt,
            });
        case "permission-request":
        case "session-info":
        case "subagent-created":
        case "token-usage":
        case "user-input-request":
            return transcript;
        case "subagent-breadcrumb":
            return replaceAiSessionTranscriptEntry(
                transcript,
                getToolTranscriptId(event.sessionId, event.toolCallId),
                (entry) => {
                    if (entry.kind !== "tool") {
                        return entry;
                    }
                    const activity = attachAiSubagentSessionAction(
                        entry.activity,
                        event.childSessionId,
                    );
                    const updatedAt =
                        entry.updatedAt > event.updatedAt
                            ? entry.updatedAt
                            : event.updatedAt;
                    return activity === entry.activity &&
                        updatedAt === entry.updatedAt
                        ? entry
                        : { ...entry, activity, updatedAt };
                },
            );
        default:
            return transcript;
    }
}

export function writeAiSessionTranscriptToSnapshot(
    snapshot: AiSessionSnapshot,
    transcript: AiSessionTranscriptModel,
): AiSessionSnapshot {
    return {
        ...snapshot,
        messages: getAiSessionTranscriptMessages(transcript),
        toolActivity: getAiSessionTranscriptToolActivity(transcript),
    };
}

export function getAiSessionTranscriptMessages(
    transcript: AiSessionTranscriptModel,
): readonly AiMessage[] {
    return transcript.messages;
}

export function getAiSessionTranscriptToolActivity(
    transcript: AiSessionTranscriptModel,
): readonly AiToolActivity[] {
    return transcript.toolActivity;
}

export function mergeAiSessionTranscriptSources(
    current: AiSessionTranscriptModel,
    incoming: AiSessionTranscriptModel,
    options: TranscriptMergeOptions,
): AiSessionTranscriptModel {
    const entriesById: Record<string, AiSessionTranscriptEntry> = {};
    const currentEntriesById = current.messagesById;
    const incomingHasPlan = hasTranscriptEntryKind(incoming, "plan");
    const incomingHasStatus = hasTranscriptEntryKind(incoming, "status");

    for (const entryId of current.messageOrder) {
        const entry = current.messagesById[entryId];
        if (
            !entry ||
            (options.includePlan && entry.kind === "plan" && !incomingHasPlan) ||
            (options.includeStatus &&
                entry.kind === "status" &&
                !incomingHasStatus) ||
            (options.includeTools &&
                !options.preserveMissingTools &&
                entry.kind === "tool")
        ) {
            continue;
        }

        entriesById[entryId] = entry;
    }

    for (const entryId of incoming.messageOrder) {
        const entry = incoming.messagesById[entryId];
        if (!entry || !shouldIncludeIncomingEntry(entry, options)) {
            continue;
        }

        const existingEntry =
            entriesById[entryId] ??
            (entry.kind === "tool" ? currentEntriesById[entryId] : undefined);
        entriesById[entryId] = mergeTranscriptEntry(existingEntry, entry, {
            preserveCreatedAt:
                existingEntry?.kind === "tool" && entry.kind === "tool",
        });
    }

    return buildAiSessionTranscriptModelFromEntries(Object.values(entriesById));
}

export function shouldPreserveCurrentAiSessionTranscript(
    current: AiSessionTranscriptModel,
    incoming: AiSessionTranscriptModel,
): boolean {
    if (
        current.messageOrder.length < incoming.messageOrder.length ||
        !hasCompatibleTranscriptPrefix(incoming, current)
    ) {
        return false;
    }

    if (current.messageOrder.length > incoming.messageOrder.length) {
        return true;
    }

    return getTranscriptWeight(current) > getTranscriptWeight(incoming);
}

export function getSnapshotTranscriptMergeOptions(
    changedKeys: ReadonlySet<keyof AiSessionPatch["changes"]> | null,
): TranscriptMergeOptions {
    return {
        includeMessages: changedKeys === null || changedKeys.has("messages"),
        includePlan: changedKeys === null || changedKeys.has("plan"),
        includeStatus:
            changedKeys === null ||
            changedKeys.has("activeTurnStartedAt") ||
            changedKeys.has("lastError") ||
            changedKeys.has("status"),
        includeTools: changedKeys === null || changedKeys.has("toolActivity"),
    };
}

function createMessageTranscriptEntry(
    message: AiMessage,
): AiSessionTranscriptEntry {
    return {
        createdAt: message.createdAt,
        id: getMessageTranscriptId(message.id),
        kind: "message",
        message,
        updatedAt: message.createdAt,
    };
}

function isOpaqueEncryptedInterAgentMessage(message: AiMessage): boolean {
    if (
        message.kind !== "user" ||
        (!message.id.startsWith("acp:user:") &&
            !message.id.startsWith("amsg_"))
    ) {
        return false;
    }

    return OPAQUE_ENCRYPTED_MESSAGE_PATTERN.test(message.content.trim());
}

function createToolTranscriptEntry(
    activity: AiToolActivity,
): AiSessionTranscriptEntry {
    return {
        activity,
        createdAt: activity.createdAt,
        id: getToolTranscriptId(activity.sessionId, activity.id),
        kind: "tool",
        updatedAt: activity.updatedAt,
    };
}

function getMessageTranscriptId(messageId: string): string {
    return getAiTranscriptMessageEntryId(messageId);
}

function getToolTranscriptId(sessionId: string, toolCallId: string): string {
    return getAiTranscriptToolEntryId(sessionId, toolCallId);
}

export function buildAiSessionTranscriptModelFromEntries(
    entries: readonly AiSessionTranscriptEntry[],
): AiSessionTranscriptModel {
    const sortedEntries = [...entries].sort(compareTranscriptEntries);
    const entriesById: Record<string, AiSessionTranscriptEntry> = {};
    const orderedEntryIds: string[] = [];

    for (const entry of sortedEntries) {
        if (entriesById[entry.id]) {
            continue;
        }
        entriesById[entry.id] = entry;
        orderedEntryIds.push(entry.id);
    }

    return buildAiSessionTranscriptModelFromOrderedEntries(
        orderedEntryIds,
        entriesById,
    );
}

function buildAiSessionTranscriptModelFromOrderedEntries(
    orderedEntryIds: readonly string[],
    entriesById: Readonly<Record<string, AiSessionTranscriptEntry>>,
): AiSessionTranscriptModel {
    const messageIndexById: Record<string, number> = {};
    const messageProjectionIndexByEntryId: Record<string, number> = {};
    const messages: AiMessage[] = [];
    const toolActivity: AiToolActivity[] = [];
    const toolActivityProjectionIndexByEntryId: Record<string, number> = {};
    let lastAssistantMessageId: string | null = null;
    let lastThinkingMessageId: string | null = null;
    let lastTurnStartedMessageId: string | null = null;
    let activePlanMessageId: string | null = null;

    for (const [index, entryId] of orderedEntryIds.entries()) {
        const entry = entriesById[entryId];
        if (!entry) {
            continue;
        }

        messageIndexById[entryId] = index;
        if (entry.kind === "message") {
            messageProjectionIndexByEntryId[entryId] = messages.length;
            messages.push(entry.message);
            if (entry.message.kind === "assistant") {
                lastAssistantMessageId = entryId;
            }
            if (entry.message.kind === "thinking") {
                lastThinkingMessageId = entryId;
            }
        } else if (entry.kind === "tool") {
            toolActivityProjectionIndexByEntryId[entryId] = toolActivity.length;
            toolActivity.push(entry.activity);
        } else if (entry.kind === "status") {
            lastTurnStartedMessageId = entryId;
        } else if (entry.kind === "plan" && isIncompletePlan(entry.plan)) {
            activePlanMessageId = entryId;
        }
    }

    return markAiSessionTranscriptMutation(
        {
            activePlanMessageId,
            entriesById,
            lastAssistantMessageId,
            lastThinkingMessageId,
            lastTurnStartedMessageId,
            messageIndexById,
            messageProjectionIndexByEntryId,
            messageOrder: orderedEntryIds,
            messagesById: entriesById,
            messages,
            orderedEntryIds,
            toolActivity,
            toolActivityProjectionIndexByEntryId,
        },
        { kind: "rebuild" },
    );
}

function upsertAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entry: AiSessionTranscriptEntry,
    options: {
        readonly preserveCreatedAt?: boolean;
    } = {},
): AiSessionTranscriptModel {
    const existing = transcript.entriesById[entry.id];

    if (!existing) {
        return insertAiSessionTranscriptEntry(transcript, entry);
    }

    return updateAiSessionTranscriptEntry(
        transcript,
        existing,
        mergeTranscriptEntry(existing, entry, options),
    );
}

function replaceAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entryId: string,
    updater: (entry: AiSessionTranscriptEntry) => AiSessionTranscriptEntry,
): AiSessionTranscriptModel {
    const existing = transcript.entriesById[entryId];
    if (!existing) {
        return transcript;
    }

    const nextEntry = updater(existing);
    if (nextEntry === existing) {
        return transcript;
    }

    return updateAiSessionTranscriptEntry(transcript, existing, nextEntry);
}

function removeAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entryId: string,
): AiSessionTranscriptModel {
    if (!transcript.entriesById[entryId]) {
        return transcript;
    }

    const entriesById = { ...transcript.entriesById };
    delete entriesById[entryId];
    const nextTranscript = buildAiSessionTranscriptModelFromOrderedEntries(
        transcript.orderedEntryIds.filter((candidateId) => candidateId !== entryId),
        entriesById,
    );
    return markAiSessionTranscriptMutation(
        nextTranscript,
        { entryId, kind: "remove" },
        transcript,
    );
}

export function applyAiSessionTranscriptMutationToProjection(
    projection: AiSessionTranscriptModel,
    source: AiSessionTranscriptModel,
): AiSessionTranscriptModel | null {
    const mutation = getAiSessionTranscriptMutation(source);
    if (mutation.kind === "rebuild") {
        return null;
    }

    if (mutation.kind === "remove") {
        return removeAiSessionTranscriptEntry(projection, mutation.entryId);
    }

    const entry = source.entriesById[mutation.entryId];
    if (!entry) {
        return null;
    }

    // Reusing the regular mutation path preserves the projected model's own
    // parent chain instead of coupling it to the larger source transcript.
    return upsertAiSessionTranscriptEntry(projection, entry);
}

export function removeAiSessionTranscriptEntries(
    transcript: AiSessionTranscriptModel,
    entryIds: ReadonlySet<string>,
): AiSessionTranscriptModel {
    const removableEntryIds = new Set(
        [...entryIds].filter((entryId) => transcript.entriesById[entryId]),
    );
    if (removableEntryIds.size === 0) {
        return transcript;
    }

    const entriesById = { ...transcript.entriesById };
    for (const entryId of removableEntryIds) {
        delete entriesById[entryId];
    }
    return buildAiSessionTranscriptModelFromOrderedEntries(
        transcript.orderedEntryIds.filter(
            (entryId) => !removableEntryIds.has(entryId),
        ),
        entriesById,
    );
}

function insertAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entry: AiSessionTranscriptEntry,
): AiSessionTranscriptModel {
    const entriesById = {
        ...transcript.entriesById,
        [entry.id]: entry,
    };
    const orderedEntryIds = transcript.orderedEntryIds;
    const lastEntryId = orderedEntryIds[orderedEntryIds.length - 1];
    const lastEntry = lastEntryId
        ? transcript.entriesById[lastEntryId]
        : undefined;

    if (!lastEntry || compareTranscriptEntries(lastEntry, entry) <= 0) {
        return appendAiSessionTranscriptEntry(
            transcript,
            entry,
            entriesById,
        );
    }

    const insertAt = findTranscriptEntryInsertIndex(
        orderedEntryIds,
        transcript.entriesById,
        entry,
    );
    return buildAiSessionTranscriptModelFromOrderedEntries(
        [
            ...orderedEntryIds.slice(0, insertAt),
            entry.id,
            ...orderedEntryIds.slice(insertAt),
        ],
        entriesById,
    );
}

function appendAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entry: AiSessionTranscriptEntry,
    entriesById: Readonly<Record<string, AiSessionTranscriptEntry>>,
): AiSessionTranscriptModel {
    const orderedEntryIds = [...transcript.orderedEntryIds, entry.id];
    const messageIndexById = {
        ...transcript.messageIndexById,
        [entry.id]: transcript.orderedEntryIds.length,
    };
    const messageProjectionIndexByEntryId =
        entry.kind === "message"
            ? {
                  ...transcript.messageProjectionIndexByEntryId,
                  [entry.id]: transcript.messages.length,
              }
            : transcript.messageProjectionIndexByEntryId;
    const toolActivityProjectionIndexByEntryId =
        entry.kind === "tool"
            ? {
                  ...transcript.toolActivityProjectionIndexByEntryId,
                  [entry.id]: transcript.toolActivity.length,
              }
            : transcript.toolActivityProjectionIndexByEntryId;

    return markAiSessionTranscriptMutation(
        {
            ...transcript,
            activePlanMessageId:
                entry.kind === "plan"
                    ? isIncompletePlan(entry.plan)
                        ? entry.id
                        : transcript.activePlanMessageId
                    : transcript.activePlanMessageId,
            entriesById,
            lastAssistantMessageId:
                entry.kind === "message" && entry.message.kind === "assistant"
                    ? entry.id
                    : transcript.lastAssistantMessageId,
            lastThinkingMessageId:
                entry.kind === "message" && entry.message.kind === "thinking"
                    ? entry.id
                    : transcript.lastThinkingMessageId,
            lastTurnStartedMessageId:
                entry.kind === "status"
                    ? entry.id
                    : transcript.lastTurnStartedMessageId,
            messageIndexById,
            messageOrder: orderedEntryIds,
            messageProjectionIndexByEntryId,
            messagesById: entriesById,
            messages:
                entry.kind === "message"
                    ? [...transcript.messages, entry.message]
                    : transcript.messages,
            orderedEntryIds,
            toolActivity:
                entry.kind === "tool"
                    ? [...transcript.toolActivity, entry.activity]
                    : transcript.toolActivity,
            toolActivityProjectionIndexByEntryId,
        },
        { entryId: entry.id, kind: "append" },
        transcript,
    );
}

function updateAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    existing: AiSessionTranscriptEntry,
    nextEntry: AiSessionTranscriptEntry,
): AiSessionTranscriptModel {
    if (existing.createdAt !== nextEntry.createdAt || existing.kind !== nextEntry.kind) {
        const entriesById = { ...transcript.entriesById };
        delete entriesById[existing.id];
        const orderedEntryIds = transcript.orderedEntryIds.filter(
            (entryId) => entryId !== existing.id,
        );
        entriesById[nextEntry.id] = nextEntry;
        const insertAt = findTranscriptEntryInsertIndex(
            orderedEntryIds,
            entriesById,
            nextEntry,
        );
        return buildAiSessionTranscriptModelFromOrderedEntries(
            [
                ...orderedEntryIds.slice(0, insertAt),
                nextEntry.id,
                ...orderedEntryIds.slice(insertAt),
            ],
            entriesById,
        );
    }

    const entriesById = {
        ...transcript.entriesById,
        [nextEntry.id]: nextEntry,
    };
    const messages = updateMessagePresentation(
        transcript,
        existing,
        nextEntry,
    );
    const toolActivity = updateToolActivityPresentation(
        transcript,
        existing,
        nextEntry,
    );

    if (
        existing.kind === "message" &&
        nextEntry.kind === "message" &&
        existing.message.kind !== nextEntry.message.kind
    ) {
        return buildAiSessionTranscriptModelFromOrderedEntries(
            transcript.orderedEntryIds,
            entriesById,
        );
    }

    return markAiSessionTranscriptMutation(
        {
            ...transcript,
            activePlanMessageId:
                nextEntry.kind === "plan"
                    ? isIncompletePlan(nextEntry.plan)
                        ? nextEntry.id
                        : null
                    : transcript.activePlanMessageId,
            entriesById,
            messages,
            messagesById: entriesById,
            toolActivity,
        },
        { entryId: nextEntry.id, kind: "patch" },
        transcript,
    );
}

function markAiSessionTranscriptMutation(
    transcript: AiSessionTranscriptModel,
    mutation: AiSessionTranscriptMutation,
    previousTranscript?: AiSessionTranscriptModel,
): AiSessionTranscriptModel {
    transcriptMutationByModel.set(transcript, mutation);
    if (previousTranscript) {
        transcriptMutationParentByModel.set(transcript, previousTranscript);
    }
    return transcript;
}

function updateMessagePresentation(
    transcript: AiSessionTranscriptModel,
    existing: AiSessionTranscriptEntry,
    nextEntry: AiSessionTranscriptEntry,
): readonly AiMessage[] {
    if (existing.kind !== "message" || nextEntry.kind !== "message") {
        return transcript.messages;
    }

    const index = transcript.messageProjectionIndexByEntryId[existing.id];
    return replaceTranscriptPresentationItem(
        transcript.messages,
        index,
        nextEntry.message,
    );
}

function updateToolActivityPresentation(
    transcript: AiSessionTranscriptModel,
    existing: AiSessionTranscriptEntry,
    nextEntry: AiSessionTranscriptEntry,
): readonly AiToolActivity[] {
    if (existing.kind !== "tool" || nextEntry.kind !== "tool") {
        return transcript.toolActivity;
    }

    const index = transcript.toolActivityProjectionIndexByEntryId[existing.id];
    return replaceTranscriptPresentationItem(
        transcript.toolActivity,
        index,
        nextEntry.activity,
    );
}

function replaceTranscriptPresentationItem<T>(
    items: readonly T[],
    index: number | undefined,
    nextItem: T,
): readonly T[] {
    if (index === undefined || items[index] === nextItem) {
        return items;
    }

    return [...items.slice(0, index), nextItem, ...items.slice(index + 1)];
}

function findTranscriptEntryInsertIndex(
    orderedEntryIds: readonly string[],
    entriesById: Readonly<Record<string, AiSessionTranscriptEntry>>,
    entry: AiSessionTranscriptEntry,
): number {
    let low = 0;
    let high = orderedEntryIds.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = entriesById[orderedEntryIds[middle]];
        if (candidate && compareTranscriptEntries(candidate, entry) <= 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function applyMessageDeltaToTranscript(
    transcript: AiSessionTranscriptModel,
    input: {
        readonly content: string;
        readonly delta: string;
        readonly kind: AiMessage["kind"];
        readonly messageId: string;
        readonly updatedAt: string;
    },
): AiSessionTranscriptModel {
    const entryId = getMessageTranscriptId(input.messageId);
    const existing = transcript.messagesById[entryId];

    if (!existing || existing.kind !== "message") {
        return upsertAiSessionTranscriptEntry(
            transcript,
            createMessageTranscriptEntry({
                attachments: [],
                content: input.content || input.delta,
                createdAt: input.updatedAt,
                id: input.messageId,
                kind: input.kind,
                status: "streaming",
            }),
        );
    }

    return replaceAiSessionTranscriptEntry(transcript, entryId, (entry) => {
        if (entry.kind !== "message") {
            return entry;
        }

        const nextContent =
            input.content.length >= entry.message.content.length
                ? input.content
                : entry.message.content.endsWith(input.delta)
                  ? entry.message.content
                  : `${entry.message.content}${input.delta}`;

        return {
            ...entry,
            message: {
                ...entry.message,
                content: nextContent,
                status:
                    entry.message.status === "completed"
                        ? "completed"
                        : "streaming",
            },
            updatedAt: input.updatedAt,
        };
    });
}

function mergeTranscriptEntry(
    existing: AiSessionTranscriptEntry | undefined,
    incoming: AiSessionTranscriptEntry,
    options: {
        readonly preserveCreatedAt?: boolean;
    } = {},
): AiSessionTranscriptEntry {
    if (!existing) {
        return incoming;
    }

    if (existing.kind !== incoming.kind) {
        return incoming;
    }

    if (existing.kind === "message" && incoming.kind === "message") {
        return {
            ...incoming,
            createdAt: options.preserveCreatedAt
                ? existing.createdAt
                : incoming.createdAt,
            message: mergeAiTranscriptMessage(existing.message, incoming.message, existing.updatedAt, incoming.updatedAt),
        };
    }

    if (existing.kind === "tool" && incoming.kind === "tool") {
        return {
            ...incoming,
            activity: {
                ...mergeAiTranscriptToolActivity(existing.activity, incoming.activity),
                createdAt: options.preserveCreatedAt ? existing.createdAt : incoming.createdAt,
            },
            createdAt: options.preserveCreatedAt
                ? existing.createdAt
                : incoming.createdAt,
            updatedAt:
                existing.updatedAt > incoming.updatedAt
                    ? existing.updatedAt
                    : incoming.updatedAt,
        };
    }

    return incoming;
}


function shouldIncludeIncomingEntry(
    entry: AiSessionTranscriptEntry,
    options: TranscriptMergeOptions,
): boolean {
    switch (entry.kind) {
        case "message":
            return options.includeMessages;
        case "plan":
            return options.includePlan;
        case "status":
            return options.includeStatus;
        case "tool":
            return options.includeTools;
        default:
            return false;
    }
}

function hasTranscriptEntryKind(
    transcript: AiSessionTranscriptModel,
    kind: AiSessionTranscriptEntry["kind"],
): boolean {
    return transcript.messageOrder.some(
        (entryId) => transcript.messagesById[entryId]?.kind === kind,
    );
}

function hasCompatibleTranscriptPrefix(
    prefix: AiSessionTranscriptModel,
    candidate: AiSessionTranscriptModel,
): boolean {
    return prefix.messageOrder.every((entryId, index) => {
        const candidateId = candidate.messageOrder[index];
        if (candidateId !== entryId) {
            return false;
        }

        const prefixEntry = prefix.messagesById[entryId];
        const candidateEntry = candidate.messagesById[candidateId];
        if (!prefixEntry || !candidateEntry) {
            return false;
        }

        return areTranscriptEntriesCompatible(prefixEntry, candidateEntry);
    });
}

function areTranscriptEntriesCompatible(
    prefix: AiSessionTranscriptEntry,
    candidate: AiSessionTranscriptEntry,
): boolean {
    if (prefix.kind !== candidate.kind) {
        return false;
    }

    if (prefix.kind === "message" && candidate.kind === "message") {
        return (
            prefix.message.kind === candidate.message.kind &&
            candidate.message.content.startsWith(prefix.message.content) &&
            candidate.message.attachments.length >= prefix.message.attachments.length
        );
    }

    if (prefix.kind === "tool" && candidate.kind === "tool") {
        return (
            prefix.activity.kind === candidate.activity.kind &&
            prefix.activity.id === candidate.activity.id
        );
    }

    return true;
}

function getTranscriptWeight(transcript: AiSessionTranscriptModel): number {
    return transcript.messageOrder.reduce((total, entryId) => {
        const entry = transcript.messagesById[entryId];
        if (!entry) {
            return total;
        }

        if (entry.kind === "message") {
            return (
                total +
                entry.message.content.length +
                entry.message.attachments.length
            );
        }

        if (entry.kind === "tool") {
            return (
                total +
                (entry.activity.summary?.length ?? 0) +
                (entry.activity.terminalOutput?.length ?? 0) +
                entry.activity.diffs.length
            );
        }

        if (entry.kind === "plan") {
            return (
                total +
                (entry.plan?.entries.reduce(
                    (sum, planEntry) => sum + planEntry.content.length,
                    0,
                ) ?? 0)
            );
        }

        return total;
    }, 0);
}

function compareTranscriptEntries(
    left: AiSessionTranscriptEntry,
    right: AiSessionTranscriptEntry,
): number {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdAtComparison !== 0) {
        return createdAtComparison;
    }

    return left.id.localeCompare(right.id);
}

function isIncompletePlan(plan: AiPlan | null): boolean {
    const entries = plan?.entries ?? [];
    return (
        entries.length > 0 &&
        entries.some((entry) => entry.status !== "completed")
    );
}
