import type { AiSessionSnapshot } from "@shared/ipc";
import type { AiSessionTranscriptModel } from "@renderer/app/ai/transcriptModel";

import type { ChatTimelineModel } from "./chatTimelineModel";

const MAX_CACHED_TIMELINES = 12;

interface CachedTimeline {
    readonly activeTurnStartedAt: string | null;
    readonly attentionToolCallIdsKey: string;
    readonly model: ChatTimelineModel;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly transcript: AiSessionTranscriptModel;
}

const cachedTimelines = new Map<string, CachedTimeline>();

function getAttentionToolCallIdsKey(ids: ReadonlySet<string>): string {
    return [...ids].sort().join("\u0000");
}

export function getCachedChatTimeline(input: {
    readonly activeTurnStartedAt: string | null;
    readonly attentionToolCallIds: ReadonlySet<string>;
    readonly sessionId: string;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly transcript: AiSessionTranscriptModel;
}): ChatTimelineModel | null {
    const cached = cachedTimelines.get(input.sessionId);
    if (
        !cached ||
        cached.activeTurnStartedAt !== input.activeTurnStartedAt ||
        cached.attentionToolCallIdsKey !==
            getAttentionToolCallIdsKey(input.attentionToolCallIds) ||
        cached.status !== input.status ||
        cached.trackedFiles !== input.trackedFiles ||
        cached.transcript !== input.transcript
    ) {
        return null;
    }

    // Touch the entry so recently visited chats retain their derived model.
    cachedTimelines.delete(input.sessionId);
    cachedTimelines.set(input.sessionId, cached);
    return cached.model;
}

export function cacheChatTimeline(input: {
    readonly activeTurnStartedAt: string | null;
    readonly attentionToolCallIds: ReadonlySet<string>;
    readonly model: ChatTimelineModel;
    readonly sessionId: string;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly transcript: AiSessionTranscriptModel;
}): void {
    cachedTimelines.delete(input.sessionId);
    cachedTimelines.set(input.sessionId, {
        ...input,
        attentionToolCallIdsKey: getAttentionToolCallIdsKey(
            input.attentionToolCallIds,
        ),
    });

    while (cachedTimelines.size > MAX_CACHED_TIMELINES) {
        const oldestSessionId = cachedTimelines.keys().next().value;
        if (!oldestSessionId) {
            return;
        }
        cachedTimelines.delete(oldestSessionId);
    }
}

export function releaseCachedChatTimeline(sessionId: string): void {
    cachedTimelines.delete(sessionId);
}

export function resetCachedChatTimelinesForTests(): void {
    cachedTimelines.clear();
}
