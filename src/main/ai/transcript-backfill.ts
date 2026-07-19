import type {
    AiMessage,
    AiTranscriptPayload,
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
    appendPayloads?(
        sessionId: string,
        payloads: readonly AiTranscriptPayload[],
    ): Promise<void>;
    loadMigrationState?(sessionId: string): Promise<TranscriptBackfillState | null>;
    saveMigrationState?(state: TranscriptBackfillState): Promise<void>;
    verify?(input: {
        readonly entries: readonly AiTranscriptEntryEnvelope[];
        readonly sessionId: string;
        readonly total: number;
    }): Promise<boolean>;
}

export interface TranscriptBackfillState {
    readonly checkpoint: number;
    readonly lastError: string | null;
    readonly sessionId: string;
    readonly status: "block-native" | "legacy" | "migrating";
    readonly verified: boolean;
    readonly version: 1;
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
    const savedState = await adapter.loadMigrationState?.(sessionId);
    let offset = savedState?.checkpoint ?? (await adapter.loadCheckpoint(sessionId));
    let migratedEntries = 0;
    await adapter.saveMigrationState?.({
        checkpoint: offset,
        lastError: null,
        sessionId,
        status: "migrating",
        verified: false,
        version: 1,
    });
    while (!signal.aborted) {
        const page = await adapter.loadLegacyPage(sessionId, offset, pageSize);
        if (page.messages.length === 0) {
            return { completed: true, migratedEntries, nextOffset: offset };
        }
        const entries = page.messages.map((message, index) =>
            legacyMessageEnvelope(sessionId, offset + index + 1, message),
        );
        try {
            await adapter.append(sessionId, entries);
            await adapter.appendPayloads?.(
                sessionId,
                page.messages.map((message) => legacyMessagePayload(sessionId, message)),
            );
            offset += page.messages.length;
            migratedEntries += page.messages.length;
            await adapter.saveCheckpoint(sessionId, offset);
            await adapter.saveMigrationState?.({
                checkpoint: offset,
                lastError: null,
                sessionId,
                status: "migrating",
                verified: false,
                version: 1,
            });
        } catch (error) {
            await adapter.saveMigrationState?.({
                checkpoint: offset,
                lastError: error instanceof Error ? error.message : "Migration failed",
                sessionId,
                status: "legacy",
                verified: false,
                version: 1,
            });
            throw error;
        }
        if (offset >= page.total) {
            const verified =
                (await adapter.verify?.({ entries, sessionId, total: page.total })) ??
                true;
            await adapter.saveMigrationState?.({
                checkpoint: offset,
                lastError: verified ? null : "Transcript verification failed",
                sessionId,
                status: verified ? "block-native" : "legacy",
                verified,
                version: 1,
            });
            return { completed: verified, migratedEntries, nextOffset: offset };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { completed: false, migratedEntries, nextOffset: offset };
}

function legacyMessagePayload(
    sessionId: string,
    message: AiMessage,
): AiTranscriptPayload {
    const payloadRef = `legacy-message:${message.id}`;
    return {
        byteLength: new TextEncoder().encode(JSON.stringify(message)).byteLength,
        capabilityVersion: 1,
        contentHash: `legacy:${message.id}`,
        payloadRef,
        sessionId,
        transcriptRevision: 0,
        value: { kind: "message", message },
    };
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
