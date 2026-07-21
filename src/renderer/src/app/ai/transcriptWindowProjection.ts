import type {
    AiMessage,
    AiSessionSnapshot,
    AiToolActivity,
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
    AiTranscriptPayload,
} from "@shared/ipc";

import {
    applyAiSessionTranscriptMutationToProjection,
    buildAiSessionTranscriptModel,
    getAiSessionTranscriptMutation,
    getAiSessionTranscriptMutationChainFrom,
    removeAiSessionTranscriptEntries,
    type AiSessionTranscriptModel,
    type AiSessionTranscriptMutation,
} from "./transcriptModel";
import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";
import { measureChatPerformance } from "@renderer/app/debug/chatPerformanceProbe";

export interface SealedTranscriptBlockProjection {
    readonly blockId: string;
    readonly entryIds: readonly string[];
    readonly revision: number;
    readonly transcript: AiSessionTranscriptModel;
}

export interface SealedTranscriptProjection {
    readonly blockIdByEntryId: ReadonlyMap<string, string>;
    readonly blocks: readonly SealedTranscriptBlockProjection[];
    readonly entryCount: number;
    readonly entryIds: ReadonlySet<string>;
    readonly transcript: AiSessionTranscriptModel;
}

export interface HotTranscriptProjection {
    readonly mutation: AiSessionTranscriptMutation;
    readonly parent: HotTranscriptProjection | null;
    readonly source: AiSessionTranscriptModel;
    readonly transcript: AiSessionTranscriptModel;
}

export interface BlockNativeTranscriptProjection {
    readonly hot: HotTranscriptProjection;
    readonly sealed: SealedTranscriptProjection;
}

interface SealedTranscriptProjectionSource {
    readonly blocksById: ReadonlyMap<string, AiTranscriptBlock>;
    readonly metadata: readonly AiTranscriptBlockMetadata[];
    readonly payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>;
}

const sealedProjectionSource = new WeakMap<
    SealedTranscriptProjection,
    SealedTranscriptProjectionSource
>();

export function buildSealedTranscriptProjection(
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    previous: SealedTranscriptProjection | null = null,
): SealedTranscriptProjection {
    const previousSource = previous
        ? sealedProjectionSource.get(previous)
        : undefined;
    if (
        previous &&
        previousSource?.blocksById === blocksById &&
        previousSource.metadata === metadata &&
        previousSource.payloadsByRef === payloadsByRef
    ) {
        return previous;
    }

    return measureChatPerformance(
        "block_projection_ms",
        {
            values: {
                metadataBlocks: metadata.length,
                residentBlocks: blocksById.size,
            },
        },
        () => {
            const blockIdByEntryId = new Map<string, string>();
            const blocks: SealedTranscriptBlockProjection[] = [];
            const entryIds = new Set<string>();
            const messages: AiMessage[] = [];
            const previousBlocksById = new Map(
                previous?.blocks.map((block) => [block.blockId, block]),
            );
            const toolActivity: AiToolActivity[] = [];

            for (const item of metadata) {
                const block = blocksById.get(item.blockId);
                if (!block) continue;
                const previousBlock = previousBlocksById.get(item.blockId);
                const canReuseBlock = Boolean(
                    previousBlock &&
                        previousSource?.payloadsByRef === payloadsByRef &&
                        previousBlock.revision === item.revision,
                );
                if (!canReuseBlock) {
                    incrementChatPerformanceCounter("timeline_blocks_built");
                    incrementChatPerformanceCounter(
                        "stable_history_entries_visited",
                        block.entries.length,
                    );
                }
                const blockProjection = canReuseBlock
                    ? previousBlock!
                    : projectSealedTranscriptBlock(block, payloadsByRef);
                blocks.push(blockProjection);
                for (const entryId of blockProjection.entryIds) {
                    entryIds.add(entryId);
                    blockIdByEntryId.set(entryId, item.blockId);
                }
                messages.push(...blockProjection.transcript.messages);
                toolActivity.push(...blockProjection.transcript.toolActivity);
            }

            const projection: SealedTranscriptProjection = {
                blockIdByEntryId,
                blocks,
                entryCount: entryIds.size,
                entryIds,
                transcript: buildAiSessionTranscriptModel({
                    messages,
                    toolActivity,
                }),
            };
            sealedProjectionSource.set(projection, {
                blocksById,
                metadata,
                payloadsByRef,
            });
            return projection;
        },
    );
}

export function reconcileHotTranscriptProjection(
    liveTranscript: AiSessionTranscriptModel,
    sealed: SealedTranscriptProjection,
    previous: HotTranscriptProjection | null = null,
): HotTranscriptProjection {
    if (previous?.source === liveTranscript) {
        return previous;
    }

    const mutation = getAiSessionTranscriptMutation(liveTranscript);
    const sourceChain = previous
        ? getAiSessionTranscriptMutationChainFrom(
              liveTranscript,
              previous.source,
          )
        : null;
    const canCollapseSourceChain = Boolean(
        sourceChain &&
            (sourceChain.length === 1 ||
                hasSingleUpsertTarget(sourceChain)),
    );
    if (previous && canCollapseSourceChain) {
        const entryId = mutation.kind === "rebuild" ? null : mutation.entryId;
        if (entryId && sealed.entryIds.has(entryId)) {
            return {
                mutation,
                parent: previous,
                source: liveTranscript,
                transcript: previous.transcript,
            };
        }

        const transcript = applyAiSessionTranscriptMutationToProjection(
            previous.transcript,
            liveTranscript,
        );
        if (transcript) {
            return {
                mutation,
                parent: previous,
                source: liveTranscript,
                transcript,
            };
        }
    }

    return {
        mutation,
        parent: null,
        source: liveTranscript,
        transcript: removeAiSessionTranscriptEntries(
            liveTranscript,
            sealed.entryIds,
        ),
    };
}

function hasSingleUpsertTarget(
    sourceChain: readonly AiSessionTranscriptModel[],
): boolean {
    let entryId: string | null = null;
    for (const source of sourceChain) {
        const mutation = getAiSessionTranscriptMutation(source);
        if (mutation.kind !== "append" && mutation.kind !== "patch") {
            return false;
        }
        entryId ??= mutation.entryId;
        if (entryId !== mutation.entryId) {
            return false;
        }
    }
    return entryId !== null;
}

export function buildBlockNativeTranscriptProjection(
    liveTranscript: AiSessionTranscriptModel,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    previous: BlockNativeTranscriptProjection | null = null,
): BlockNativeTranscriptProjection {
    const sealed = buildSealedTranscriptProjection(
        blocksById,
        metadata,
        payloadsByRef,
        previous?.sealed ?? null,
    );
    const hot = reconcileHotTranscriptProjection(
        liveTranscript,
        sealed,
        previous?.sealed === sealed ? previous.hot : null,
    );
    if (previous?.sealed === sealed && previous.hot === hot) {
        return previous;
    }
    return { hot, sealed };
}

export function buildBlockNativeTranscriptBootstrap(
    projection: BlockNativeTranscriptProjection,
    snapshot: Pick<
        AiSessionSnapshot,
        "activeTurnStartedAt" | "status" | "updatedAt"
    >,
): AiSessionTranscriptModel {
    return buildAiSessionTranscriptModel({
        activeTurnStartedAt: snapshot.activeTurnStartedAt ?? null,
        messages: [
            ...projection.sealed.transcript.messages,
            ...projection.hot.transcript.messages,
        ],
        status: snapshot.status,
        toolActivity: [
            ...projection.sealed.transcript.toolActivity,
            ...projection.hot.transcript.toolActivity,
        ],
        updatedAt: snapshot.updatedAt,
    });
}

// Kept for callers that need a one-shot materialized transcript. Streaming
// consumers should retain BlockNativeTranscriptProjection across updates.
export function buildBlockNativeTranscript(
    liveTranscript: AiSessionTranscriptModel,
    blocksById: ReadonlyMap<string, AiTranscriptBlock>,
    metadata: readonly AiTranscriptBlockMetadata[],
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
    snapshot: AiSessionSnapshot,
): AiSessionTranscriptModel {
    return buildBlockNativeTranscriptBootstrap(
        buildBlockNativeTranscriptProjection(
            liveTranscript,
            blocksById,
            metadata,
            payloadsByRef,
        ),
        snapshot,
    );
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

function projectSealedTranscriptBlock(
    block: AiTranscriptBlock,
    payloadsByRef: ReadonlyMap<string, AiTranscriptPayload>,
): SealedTranscriptBlockProjection {
    const entryIds: string[] = [];
    const messages: AiMessage[] = [];
    const toolActivity: AiToolActivity[] = [];
    for (const entry of block.entries) {
        entryIds.push(entry.id);
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
                id: entry.id.startsWith("message:")
                    ? entry.id.slice("message:".length)
                    : `summary:${entry.id}`,
                kind: entry.kind === "thinking" ? "thinking" : "assistant",
                status: "completed",
            });
        }
    }
    return {
        blockId: block.blockId,
        entryIds,
        revision: block.revision,
        transcript: buildAiSessionTranscriptModel({ messages, toolActivity }),
    };
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
        kind: entry.summary.toolKind ?? "tool",
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
        // Older sealed blocks predate the summary fields. The backend has used
        // this stable key for detail records, so retain backwards-compatible
        // recovery without inflating the transcript payload.
        toolActivityDetailId:
            entry.summary.toolActivityDetailId ??
            `tool-detail:${entry.sessionId}:${toolActivityIdForTranscriptEntry(entry)}`,
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
