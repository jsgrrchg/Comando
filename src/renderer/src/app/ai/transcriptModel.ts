import type {
    AiMessage,
    AiPlan,
    AiSessionDomainEvent,
    AiSessionPatch,
    AiSessionSnapshot,
    AiSessionStatus,
    AiToolActivity,
} from "@shared/ipc";

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
    readonly lastAssistantMessageId: string | null;
    readonly lastThinkingMessageId: string | null;
    readonly lastTurnStartedMessageId: string | null;
    readonly messageIndexById: Readonly<Record<string, number>>;
    readonly messageOrder: readonly string[];
    readonly messagesById: Readonly<Record<string, AiSessionTranscriptEntry>>;
}

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
}

const PLAN_ENTRY_ID = "plan:active";
const STATUS_ENTRY_ID = "status:active-turn";

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
        case "subagent-breadcrumb":
        case "subagent-created":
        case "token-usage":
        case "user-input-request":
            return transcript;
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
    return transcript.messageOrder.flatMap((entryId) => {
        const entry = transcript.messagesById[entryId];
        return entry?.kind === "message" ? [entry.message] : [];
    });
}

export function getAiSessionTranscriptToolActivity(
    transcript: AiSessionTranscriptModel,
): readonly AiToolActivity[] {
    return transcript.messageOrder.flatMap((entryId) => {
        const entry = transcript.messagesById[entryId];
        return entry?.kind === "tool" ? [entry.activity] : [];
    });
}

export function mergeAiSessionTranscriptSources(
    current: AiSessionTranscriptModel,
    incoming: AiSessionTranscriptModel,
    options: TranscriptMergeOptions,
): AiSessionTranscriptModel {
    const entriesById: Record<string, AiSessionTranscriptEntry> = {};
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
            (options.includeTools && entry.kind === "tool")
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

        entriesById[entryId] = mergeTranscriptEntry(entriesById[entryId], entry);
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

function createToolTranscriptEntry(
    activity: AiToolActivity,
): AiSessionTranscriptEntry {
    return {
        activity,
        createdAt: activity.createdAt,
        id: getToolTranscriptId(activity.id),
        kind: "tool",
        updatedAt: activity.updatedAt,
    };
}

function getMessageTranscriptId(messageId: string): string {
    return `message:${messageId}`;
}

function getToolTranscriptId(toolCallId: string): string {
    return `tool:${toolCallId}`;
}

function buildAiSessionTranscriptModelFromEntries(
    entries: readonly AiSessionTranscriptEntry[],
): AiSessionTranscriptModel {
    const sortedEntries = [...entries].sort(compareTranscriptEntries);
    const messageOrder: string[] = [];
    const messagesById: Record<string, AiSessionTranscriptEntry> = {};
    const messageIndexById: Record<string, number> = {};
    let lastAssistantMessageId: string | null = null;
    let lastThinkingMessageId: string | null = null;
    let lastTurnStartedMessageId: string | null = null;
    let activePlanMessageId: string | null = null;

    for (const entry of sortedEntries) {
        if (messagesById[entry.id]) {
            continue;
        }

        messageIndexById[entry.id] = messageOrder.length;
        messageOrder.push(entry.id);
        messagesById[entry.id] = entry;

        if (entry.kind === "message" && entry.message.kind === "assistant") {
            lastAssistantMessageId = entry.id;
        }

        if (entry.kind === "message" && entry.message.kind === "thinking") {
            lastThinkingMessageId = entry.id;
        }

        if (entry.kind === "status") {
            lastTurnStartedMessageId = entry.id;
        }

        if (entry.kind === "plan" && isIncompletePlan(entry.plan)) {
            activePlanMessageId = entry.id;
        }
    }

    return {
        activePlanMessageId,
        lastAssistantMessageId,
        lastThinkingMessageId,
        lastTurnStartedMessageId,
        messageIndexById,
        messageOrder,
        messagesById,
    };
}

function upsertAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entry: AiSessionTranscriptEntry,
    options: {
        readonly preserveCreatedAt?: boolean;
    } = {},
): AiSessionTranscriptModel {
    const existing = transcript.messagesById[entry.id];
    const entries = transcript.messageOrder
        .map((entryId) => transcript.messagesById[entryId])
        .filter((candidate): candidate is AiSessionTranscriptEntry =>
            Boolean(candidate),
        );

    if (!existing) {
        return buildAiSessionTranscriptModelFromEntries([...entries, entry]);
    }

    return buildAiSessionTranscriptModelFromEntries(
        entries.map((candidate) =>
            candidate.id === entry.id
                ? mergeTranscriptEntry(existing, entry, options)
                : candidate,
        ),
    );
}

function replaceAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entryId: string,
    updater: (entry: AiSessionTranscriptEntry) => AiSessionTranscriptEntry,
): AiSessionTranscriptModel {
    const existing = transcript.messagesById[entryId];
    if (!existing) {
        return transcript;
    }

    const nextEntry = updater(existing);
    if (nextEntry === existing) {
        return transcript;
    }

    return buildAiSessionTranscriptModelFromEntries(
        transcript.messageOrder.flatMap((candidateId) => {
            const candidate = transcript.messagesById[candidateId];
            if (!candidate) {
                return [];
            }
            return candidateId === entryId ? [nextEntry] : [candidate];
        }),
    );
}

function removeAiSessionTranscriptEntry(
    transcript: AiSessionTranscriptModel,
    entryId: string,
): AiSessionTranscriptModel {
    if (!transcript.messagesById[entryId]) {
        return transcript;
    }

    return buildAiSessionTranscriptModelFromEntries(
        transcript.messageOrder.flatMap((candidateId) => {
            const candidate = transcript.messagesById[candidateId];
            return candidate && candidateId !== entryId ? [candidate] : [];
        }),
    );
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
            message: mergeAiMessage(existing.message, incoming.message),
        };
    }

    if (existing.kind === "tool" && incoming.kind === "tool") {
        return {
            ...incoming,
            activity: {
                ...incoming.activity,
                createdAt: options.preserveCreatedAt
                    ? existing.activity.createdAt
                    : incoming.activity.createdAt,
            },
            createdAt: options.preserveCreatedAt
                ? existing.createdAt
                : incoming.createdAt,
        };
    }

    return incoming;
}

function mergeAiMessage(existing: AiMessage, incoming: AiMessage): AiMessage {
    return {
        ...incoming,
        attachments:
            existing.attachments.length > incoming.attachments.length
                ? existing.attachments
                : incoming.attachments,
        content:
            existing.content.length > incoming.content.length
                ? existing.content
                : incoming.content,
        generatedImage: incoming.generatedImage ?? existing.generatedImage,
        status:
            existing.status === "completed" && incoming.status !== "completed"
                ? "completed"
                : incoming.status,
    };
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
