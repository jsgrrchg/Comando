import type {
    AiTranscriptBlock,
    AiTranscriptBlockMetadata,
} from "@shared/ipc";

import { incrementChatPerformanceCounter } from "@renderer/app/debug/chatPerformanceCounters";

export interface TranscriptBlockLoader {
    loadBlock(sessionId: string, blockId: string): Promise<AiTranscriptBlock>;
}

interface SessionWindow {
    readonly blocks: Map<string, AiTranscriptBlock>;
    generation: number;
    metadata: readonly AiTranscriptBlockMetadata[];
    readonly pending: Map<string, Promise<AiTranscriptBlock | null>>;
    readonly protectedBlockIds: Set<string>;
    readonly touchedAt: Map<string, number>;
}

export interface TranscriptWindowSnapshot {
    readonly blocksById: ReadonlyMap<string, AiTranscriptBlock>;
    readonly generation: number;
    readonly metadata: readonly AiTranscriptBlockMetadata[];
    readonly residentEntries: number;
}

export class TranscriptWindowStore {
    private readonly sessions = new Map<string, SessionWindow>();
    private readonly evictedSessionIds = new Set<string>();

    constructor(
        private readonly loader: TranscriptBlockLoader,
        private readonly maxResidentEntries = 2_048,
    ) {}

    setMetadata(
        sessionId: string,
        metadata: readonly AiTranscriptBlockMetadata[],
    ): void {
        const session = this.sessionFor(sessionId);
        session.metadata = metadata;
        session.generation += 1;
    }

    protect(sessionId: string, blockIds: ReadonlySet<string>): void {
        const session = this.sessionFor(sessionId);
        session.protectedBlockIds.clear();
        for (const blockId of blockIds) session.protectedBlockIds.add(blockId);
        this.evict();
    }

    clear(sessionId: string): void {
        this.sessions.delete(sessionId);
        this.evictedSessionIds.delete(sessionId);
    }

    reset(): void {
        this.sessions.clear();
        this.evictedSessionIds.clear();
    }

    async load(sessionId: string, blockId: string): Promise<AiTranscriptBlock | null> {
        const session = this.sessionFor(sessionId);
        const cached = session.blocks.get(blockId);
        if (cached) {
            session.touchedAt.set(blockId, performance.now());
            return cached;
        }
        const existing = session.pending.get(blockId);
        if (existing) return existing;

        const generation = session.generation;
        const request = this.loader
            .loadBlock(sessionId, blockId)
            .then((block) => {
                if (session.generation !== generation) return null;
                session.blocks.set(blockId, block);
                session.touchedAt.set(blockId, performance.now());
                incrementChatPerformanceCounter("transcript_blocks_loaded");
                this.evict();
                return block;
            })
            .finally(() => session.pending.delete(blockId));
        session.pending.set(blockId, request);
        return request;
    }

    snapshot(sessionId: string): TranscriptWindowSnapshot {
        const session = this.sessionFor(sessionId);
        return {
            blocksById: new Map(session.blocks),
            generation: session.generation,
            metadata: session.metadata,
            residentEntries: residentEntryCount(session),
        };
    }

    takeEvictedSessionIds(): readonly string[] {
        const sessionIds = [...this.evictedSessionIds];
        this.evictedSessionIds.clear();
        return sessionIds;
    }

    private evict(): void {
        while (this.residentEntryCount() > this.maxResidentEntries) {
            const candidate = [...this.sessions.entries()]
                .flatMap(([sessionId, session]) =>
                    [...session.blocks.keys()]
                        .filter((blockId) => !session.protectedBlockIds.has(blockId))
                        .map((blockId) => ({
                            blockId,
                            session,
                            sessionId,
                            touchedAt: session.touchedAt.get(blockId) ?? 0,
                        })),
                )
                .sort((left, right) => left.touchedAt - right.touchedAt)[0];
            if (!candidate) return;
            candidate.session.blocks.delete(candidate.blockId);
            candidate.session.touchedAt.delete(candidate.blockId);
            this.evictedSessionIds.add(candidate.sessionId);
            incrementChatPerformanceCounter("transcript_blocks_evicted");
        }
    }

    private residentEntryCount(): number {
        let count = 0;
        for (const session of this.sessions.values()) {
            count += residentEntryCount(session);
        }
        return count;
    }

    private sessionFor(sessionId: string): SessionWindow {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                blocks: new Map(),
                generation: 0,
                metadata: [],
                pending: new Map(),
                protectedBlockIds: new Set(),
                touchedAt: new Map(),
            };
            this.sessions.set(sessionId, session);
        }
        return session;
    }
}

function residentEntryCount(session: SessionWindow): number {
    let count = 0;
    for (const block of session.blocks.values()) count += block.entryCount;
    return count;
}
