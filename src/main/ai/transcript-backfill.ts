import type {
    AiMessage,
    AiTranscriptEntryEnvelope,
} from "@shared/ipc";

export interface TranscriptBackfillAdapter {
    append(
        sessionId: string,
        entries: readonly AiTranscriptEntryEnvelope[],
    ): Promise<void>;
    loadLegacyPage(
        sessionId: string,
        offset: number,
        limit: number,
    ): Promise<{ readonly messages: readonly AiMessage[]; readonly total: number }>;
    loadCheckpoint(sessionId: string): Promise<number>;
    saveCheckpoint(sessionId: string, offset: number): Promise<void>;
}

export interface TranscriptBackfillResult {
    readonly completed: boolean;
    readonly migratedEntries: number;
    readonly nextOffset: number;
}

export async function backfillLegacyTranscript(
    adapter: TranscriptBackfillAdapter,
    sessionId: string,
    signal: AbortSignal,
    pageSize = 256,
): Promise<TranscriptBackfillResult> {
    let offset = await adapter.loadCheckpoint(sessionId);
    let migratedEntries = 0;
    while (!signal.aborted) {
        const page = await adapter.loadLegacyPage(sessionId, offset, pageSize);
        if (page.messages.length === 0) {
            return { completed: true, migratedEntries, nextOffset: offset };
        }
        const entries = page.messages.map((message, index) =>
            legacyMessageEnvelope(sessionId, offset + index + 1, message),
        );
        await adapter.append(sessionId, entries);
        offset += page.messages.length;
        migratedEntries += page.messages.length;
        await adapter.saveCheckpoint(sessionId, offset);
        if (offset >= page.total) {
            return { completed: true, migratedEntries, nextOffset: offset };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { completed: false, migratedEntries, nextOffset: offset };
}

function legacyMessageEnvelope(
    sessionId: string,
    sequence: number,
    message: AiMessage,
): AiTranscriptEntryEnvelope {
    return {
        createdAt: message.createdAt,
        id: `message:${message.id}`,
        kind: message.kind === "thinking" ? "thinking" : "message",
        payloadRef: `legacy-message:${message.id}`,
        sequence,
        sessionId,
        summary: {
            label: message.kind,
            preview: message.content.slice(0, 280),
            status: message.status,
        },
        updatedAt: message.createdAt,
    };
}
