import type {
    AiMessage,
    AiSessionSnapshot,
    AiToolActivity,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptPayload,
} from "@shared/ipc";

import {
    buildAiSessionTranscriptModel,
    type AiSessionTranscriptModel,
} from "./transcriptModel";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import { measureChatPerformance } from "@renderer/app/debug/chatPerformanceProbe";

export function buildBlockNativeTranscript(
    liveTranscript: AiSessionTranscriptModel,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    snapshot: AiSessionSnapshot,
): AiSessionTranscriptModel {
    return measureChatPerformance(
        "block_projection_ms",
        {
            sessionId: snapshot.sessionId,
            values: {
                metadataBlocks: metadata.length,
                residentBlocks: blocksById.size,
            },
        },
        () =>
            buildBlockNativeTranscriptUnmeasured(
                liveTranscript,
                blocksById,
                metadata,
                payloadsByRef,
                snapshot,
            ),
    );
}

function buildBlockNativeTranscriptUnmeasured(
    liveTranscript: AiSessionTranscriptModel,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    snapshot: AiSessionSnapshot,
): AiSessionTranscriptModel {
    const sealedEntryIds = new Set<string>();
    const messages: AiMessage[] = [];
    const toolActivity: AiToolActivity[] = [];

    for (const item of metadata) {
        const block = blocksById.get(item.blockId);
        if (!block) continue;
        incrementChatPerformanceCounter("timeline_blocks_built");
        incrementChatPerformanceCounter(
            "stable_history_entries_visited",
            block.entries.length,
        );
        for (const entry of block.entries) {
            sealedEntryIds.add(entry.id);
            const payload = entry.payloadRef
                ? payloadsByRef.get(entry.payloadRef)?.value
                : null;
            if (isTranscriptMessagePayload(payload)) {
                messages.push(payload.message);
            } else if (isTranscriptToolPayload(payload)) {
                toolActivity.push(payload.activity);
            } else if (entry.kind === "tool") {
                toolActivity.push(createTranscriptToolSummary(entry));
            } else if (entry.kind !== "plan" && entry.kind !== "status") {
                messages.push({
                    attachments: [],
                    content: entry.summary.preview ?? entry.summary.label ?? "",
                    createdAt: entry.createdAt,
                    id: `summary:${entry.id}`,
                    kind: entry.kind === "thinking" ? "thinking" : "assistant",
                    status: "completed",
                });
            }
        }
    }

    return buildAiSessionTranscriptModel({
        activeTurnStartedAt: snapshot.activeTurnStartedAt ?? null,
        messages: [
            ...messages,
            ...liveTranscript.messages.filter(
                (message) => !sealedEntryIds.has(`message:${message.id}`),
            ),
        ],
        status: snapshot.status,
        toolActivity: [
            ...toolActivity,
            ...liveTranscript.toolActivity.filter(
                (activity) =>
                    !sealedEntryIds.has(
                        `tool:${activity.sessionId}:${activity.id}`,
                    ),
            ),
        ],
        updatedAt: snapshot.updatedAt,
    });
}

export function buildTranscriptToolPayloadRefs(
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
): ReadonlyMap<string, string> {
    const payloadRefs = new Map<string, string>();
    for (const block of blocksById.values()) {
        for (const entry of block.entries) {
            if (entry.kind === "tool" && entry.payloadRef) {
                payloadRefs.set(
                    toolActivityIdForTranscriptEntry(entry),
                    entry.payloadRef,
                );
            }
        }
    }
    return payloadRefs;
}

function createTranscriptToolSummary(
    entry: AiTranscriptBlock["entries"][number],
): AiToolActivity {
    const status = entry.summary.status;
    return {
        createdAt: entry.createdAt,
        diffs: [],
        exitCode: null,
        id: toolActivityIdForTranscriptEntry(entry),
        kind: "tool",
        locations: [],
        rawInputJson: null,
        rawOutputJson: null,
        sessionId: entry.sessionId,
        status:
            status === "failed" || status === "in_progress" || status === "pending"
                ? status
                : "completed",
        summary: entry.summary.preview,
        terminalOutput: null,
        title: entry.summary.label ?? "Tool activity",
        updatedAt: entry.updatedAt,
    };
}

function toolActivityIdForTranscriptEntry(
    entry: AiTranscriptBlock["entries"][number],
): string {
    const prefix = `tool:${entry.sessionId}:`;
    return entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
}

function isTranscriptMessagePayload(
    value: unknown,
): value is { readonly kind: "message"; readonly message: AiMessage } {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "message" &&
        "message" in value
    );
}

function isTranscriptToolPayload(
    value: unknown,
): value is { readonly kind: "tool"; readonly activity: AiToolActivity } {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "tool" &&
        "activity" in value
    );
}
