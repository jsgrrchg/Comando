import type { AiSessionDomainEvent, AiSessionSnapshot } from "@shared/ipc";

import {
    applyAiSessionDomainEventToTranscript,
    buildAiSessionTranscriptModelFromEntries,
    buildAiSessionTranscriptModelFromSnapshot,
    createEmptyAiSessionTranscriptModel,
    type AiSessionTranscriptEntry,
    type AiSessionTranscriptModel,
} from "./transcriptModel";

export interface AiStableTranscriptHistory {
    readonly revision: number;
    readonly transcript: AiSessionTranscriptModel;
}

export interface AiSessionLiveTail {
    readonly revision: number;
    readonly turnId: string | null;
    readonly transcript: AiSessionTranscriptModel;
}

export interface AiSegmentedTranscript {
    readonly stableHistory: AiStableTranscriptHistory;
    readonly liveTail: AiSessionLiveTail;
}

export function segmentAiSessionTranscript(
    snapshot: Pick<
        AiSessionSnapshot,
        | "activeTurnStartedAt"
        | "messages"
        | "plan"
        | "status"
        | "toolActivity"
        | "updatedAt"
    >,
): AiSegmentedTranscript {
    const transcript = buildAiSessionTranscriptModelFromSnapshot(snapshot);
    const turnStartedAt = snapshot.activeTurnStartedAt ?? null;
    if (!turnStartedAt) {
        return {
            stableHistory: { revision: 1, transcript },
            liveTail: {
                revision: 0,
                transcript: createEmptyAiSessionTranscriptModel(),
                turnId: null,
            },
        };
    }

    const stableEntries: AiSessionTranscriptEntry[] = [];
    const liveEntries: AiSessionTranscriptEntry[] = [];
    for (const entryId of transcript.orderedEntryIds) {
        const entry = transcript.entriesById[entryId];
        if (!entry) continue;
        (entry.createdAt < turnStartedAt ? stableEntries : liveEntries).push(entry);
    }

    return {
        stableHistory: {
            revision: 1,
            transcript: buildAiSessionTranscriptModelFromEntries(stableEntries),
        },
        liveTail: {
            revision: 1,
            transcript: buildAiSessionTranscriptModelFromEntries(liveEntries),
            turnId: turnStartedAt,
        },
    };
}

export function applyAiSessionDomainEventToSegments(
    segmented: AiSegmentedTranscript,
    event: AiSessionDomainEvent,
): AiSegmentedTranscript {
    const nextTail = applyAiSessionDomainEventToTranscript(
        segmented.liveTail.transcript,
        event,
    );
    if (nextTail === segmented.liveTail.transcript) return segmented;

    return {
        stableHistory: segmented.stableHistory,
        liveTail: {
            revision: segmented.liveTail.revision + 1,
            transcript: nextTail,
            turnId: segmented.liveTail.turnId,
        },
    };
}

export function sealAiSessionLiveTail(
    segmented: AiSegmentedTranscript,
): AiSegmentedTranscript {
    if (segmented.liveTail.transcript.orderedEntryIds.length === 0) {
        return segmented;
    }

    const entries = [
        ...entriesOf(segmented.stableHistory.transcript),
        ...entriesOf(segmented.liveTail.transcript),
    ];
    return {
        stableHistory: {
            revision: segmented.stableHistory.revision + 1,
            transcript: buildAiSessionTranscriptModelFromEntries(entries),
        },
        liveTail: {
            revision: segmented.liveTail.revision + 1,
            transcript: createEmptyAiSessionTranscriptModel(),
            turnId: null,
        },
    };
}

function entriesOf(
    transcript: AiSessionTranscriptModel,
): AiSessionTranscriptEntry[] {
    return transcript.orderedEntryIds.flatMap((entryId) => {
        const entry = transcript.entriesById[entryId];
        return entry ? [entry] : [];
    });
}
