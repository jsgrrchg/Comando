import type { AiMessage, AiToolActivity } from "./ipc";

export const AI_TRANSCRIPT_PLAN_ENTRY_ID = "plan:active";
export const AI_TRANSCRIPT_STATUS_ENTRY_ID = "status:active-turn";

export function getAiTranscriptMessageEntryId(messageId: string): string {
    return `message:${messageId}`;
}

export function getAiTranscriptToolEntryId(sessionId: string, toolCallId: string): string {
    return `tool:${sessionId}:${toolCallId}`;
}

export function getAiTranscriptTurnEntryId(baseId: string, turnStartedAt: string): string {
    return `${baseId}:${turnStartedAt}`;
}

export function mergeAiTranscriptMessage(existing: AiMessage, incoming: AiMessage, existingUpdatedAt: string, incomingUpdatedAt: string): AiMessage {
    const existingWeight = messageWeight(existing);
    const incomingWeight = messageWeight(incoming);
    const richer = existingWeight > incomingWeight || (existingWeight === incomingWeight && stableAiTranscriptJson(existing) >= stableAiTranscriptJson(incoming)) ? existing : incoming;
    return {
        ...richer,
        attachments: incoming.attachments.length > 0 ? incoming.attachments : existing.attachments,
        content: chooseContent(existing.content, incoming.content, existingUpdatedAt, incomingUpdatedAt),
        createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
        generatedImage: incoming.generatedImage ?? existing.generatedImage ?? null,
        status: existing.status === "completed" || incoming.status === "completed" ? "completed" : "streaming",
    };
}

export function mergeAiTranscriptToolActivity(existing: AiToolActivity, incoming: AiToolActivity): AiToolActivity {
    const incomingWins = incoming.updatedAt > existing.updatedAt || (incoming.updatedAt === existing.updatedAt && stableAiTranscriptJson(incoming) >= stableAiTranscriptJson(existing));
    const winner = incomingWins ? incoming : existing;
    const fallback = incomingWins ? existing : incoming;
    // Session links are durable transcript enrichment and must survive later
    // status-only updates from runtimes that do not repeat the action.
    const action = winner.action ?? fallback.action;
    return {
        ...winner,
        ...(action === undefined ? {} : { action }),
        changeStats: winner.changeStats ?? fallback.changeStats ?? null,
        diffs: winner.diffs.length > 0 ? winner.diffs : fallback.diffs,
        exitCode: winner.exitCode ?? fallback.exitCode,
        terminalOutput: winner.terminalOutput ?? fallback.terminalOutput,
    };
}

export function attachAiSubagentSessionAction(
    activity: AiToolActivity,
    childSessionId: string,
): AiToolActivity {
    if (
        activity.action?.kind === "open_session" &&
        activity.action.sessionId === childSessionId
    ) {
        return activity;
    }

    return {
        ...activity,
        action: {
            kind: "open_session",
            sessionId: childSessionId,
        },
    };
}

export function appendAiTranscriptDelta(
    existing: string,
    content: string,
    delta: string,
): string {
    // A full non-prefix snapshot replaces local content; only suffix deltas append.
    if (content.length > existing.length) return content;
    if (delta === content && !content.startsWith(existing)) return content;
    return existing.endsWith(delta) ? existing : `${existing}${delta}`;
}

export function stableAiTranscriptJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableAiTranscriptJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableAiTranscriptJson(item)}`).join(",")}}`;
    return JSON.stringify(value);
}

function messageWeight(message: AiMessage): number {
    return message.attachments.length * 2 + (message.generatedImage ? 2 : 0) + (message.status === "completed" ? 1 : 0);
}

function chooseContent(existing: string, incoming: string, existingUpdatedAt: string, incomingUpdatedAt: string): string {
    if (existing.length !== incoming.length) return existing.length > incoming.length ? existing : incoming;
    if (existingUpdatedAt !== incomingUpdatedAt) return existingUpdatedAt > incomingUpdatedAt ? existing : incoming;
    return existing > incoming ? existing : incoming;
}
