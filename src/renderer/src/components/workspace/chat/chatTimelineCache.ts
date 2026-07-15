import type { AiSessionSnapshot } from "@shared/ipc";
import type { AiSessionTranscriptModel } from "@renderer/app/ai/transcriptModel";
import { workspaceArtifactBudget } from "@renderer/app/workspace/resource-budget";

import type { ChatTimelineModel } from "./chatTimelineModel";

interface CachedTimeline {
    readonly activeTurnStartedAt: string | null;
    readonly attentionToolCallIdsKey: string;
    readonly model: ChatTimelineModel;
    readonly status: AiSessionSnapshot["status"];
    readonly trackedFiles: AiSessionSnapshot["trackedFiles"];
    readonly transcript: AiSessionTranscriptModel;
}

const CHAT_TIMELINE_CACHE_SCOPE = "chat-timeline";

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
    const cached = workspaceArtifactBudget.get<CachedTimeline>(
        CHAT_TIMELINE_CACHE_SCOPE,
        input.sessionId,
    );
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
    workspaceArtifactBudget.set(CHAT_TIMELINE_CACHE_SCOPE, input.sessionId, {
        ...input,
        attentionToolCallIdsKey: getAttentionToolCallIdsKey(
            input.attentionToolCallIds,
        ),
    });

}

export function releaseCachedChatTimeline(sessionId: string): void {
    workspaceArtifactBudget.delete(CHAT_TIMELINE_CACHE_SCOPE, sessionId);
}

export function resetCachedChatTimelinesForTests(): void {
    workspaceArtifactBudget.deleteScope(CHAT_TIMELINE_CACHE_SCOPE);
}
