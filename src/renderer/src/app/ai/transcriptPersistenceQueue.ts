import type { AiTranscriptEntryEnvelope } from "@shared/ipc";

export interface TranscriptPersistenceAdapter {
    append(
        sessionId: string,
        entries: readonly AiTranscriptEntryEnvelope[],
    ): Promise<void>;
    seal(sessionId: string, turnId: string): Promise<void>;
}

interface SessionQueue {
    entriesById: Map<string, AiTranscriptEntryEnvelope>;
    inFlight: Promise<void> | null;
    retryTimer: ReturnType<typeof setTimeout> | null;
}

export class TranscriptPersistenceQueue {
    private readonly queues = new Map<string, SessionQueue>();

    constructor(private readonly adapter: TranscriptPersistenceAdapter) {}

    enqueue(entry: AiTranscriptEntryEnvelope): void {
        const queue = this.queueFor(entry.sessionId);
        queue.entriesById.set(entry.id, entry);
        this.flush(entry.sessionId);
    }

    async seal(sessionId: string, turnId: string): Promise<void> {
        await this.flushNow(sessionId);
        await this.adapter.seal(sessionId, turnId);
    }

    async flushNow(sessionId: string): Promise<void> {
        const queue = this.queueFor(sessionId);
        if (queue.inFlight) await queue.inFlight;
        if (queue.entriesById.size === 0) return;
        await this.startFlush(sessionId, queue);
    }

    private flush(sessionId: string): void {
        const queue = this.queueFor(sessionId);
        if (queue.inFlight || queue.retryTimer) return;
        queueMicrotask(() => void this.startFlush(sessionId, queue));
    }

    private async startFlush(sessionId: string, queue: SessionQueue): Promise<void> {
        if (queue.inFlight || queue.entriesById.size === 0) return;
        const entries = [...queue.entriesById.values()];
        for (const entry of entries) queue.entriesById.delete(entry.id);
        const request = this.adapter.append(sessionId, entries);
        queue.inFlight = request;
        try {
            await request;
        } catch {
            for (const entry of entries) {
                if (!queue.entriesById.has(entry.id)) {
                    queue.entriesById.set(entry.id, entry);
                }
            }
            queue.retryTimer = setTimeout(() => {
                queue.retryTimer = null;
                this.flush(sessionId);
            }, 250);
        } finally {
            queue.inFlight = null;
            if (queue.entriesById.size > 0 && !queue.retryTimer) this.flush(sessionId);
        }
    }

    private queueFor(sessionId: string): SessionQueue {
        let queue = this.queues.get(sessionId);
        if (!queue) {
            queue = { entriesById: new Map(), inFlight: null, retryTimer: null };
            this.queues.set(sessionId, queue);
        }
        return queue;
    }
}
