import { mergeAiTranscriptToolActivity } from "@shared/ai-transcript";
import type { AiSessionDomainEvent, AiToolActivity } from "@shared/ipc";

export type FrameBufferedAiSessionEvent = Extract<
    AiSessionDomainEvent,
    {
        kind: "message-delta" | "thinking-delta" | "tool-activity";
    }
>;

interface SessionEventFrame {
    cancelScheduledFlush: (() => void) | null;
    readonly events: Map<string, FrameBufferedAiSessionEvent>;
    firstQueuedAt: number;
}

interface AiSessionEventFrameBufferOptions {
    readonly apply: (event: FrameBufferedAiSessionEvent) => void;
    readonly now?: () => number | null;
    readonly onCoalesced?: (event: FrameBufferedAiSessionEvent) => void;
    readonly onFlush?: (input: {
        readonly eventCount: number;
        readonly firstQueuedAt: number;
        readonly sessionId: string;
    }) => void;
    readonly schedule?: (flush: () => void) => () => void;
}

const MAX_EVENTS_PER_SESSION_FRAME = 512;
const MAX_EVENTS_ACROSS_SESSION_FRAMES = 2_048;

export class AiSessionEventFrameBuffer {
    private readonly framesBySessionId = new Map<string, SessionEventFrame>();
    private flushing = false;

    constructor(private readonly options: AiSessionEventFrameBufferOptions) {}

    get isFlushing(): boolean {
        return this.flushing;
    }

    pendingCount(sessionId: string): number {
        return this.framesBySessionId.get(sessionId)?.events.size ?? 0;
    }

    buffer(event: FrameBufferedAiSessionEvent): void {
        let frame = this.framesBySessionId.get(event.sessionId);
        if (!frame) {
            frame = {
                cancelScheduledFlush: null,
                events: new Map(),
                firstQueuedAt: this.options.now?.() ?? performance.now(),
            };
            this.framesBySessionId.set(event.sessionId, frame);
        }

        const key = frameEventKey(event);
        const existing = frame.events.get(key);
        if (existing) {
            frame.events.set(key, mergeFrameEvent(existing, event));
            this.options.onCoalesced?.(event);
        } else {
            frame.events.set(key, event);
        }

        if (
            frame.events.size >= MAX_EVENTS_PER_SESSION_FRAME ||
            this.pendingEventCount() >= MAX_EVENTS_ACROSS_SESSION_FRAMES
        ) {
            // Flushing preserves order and bounds memory without dropping a critical event.
            this.flushSession(event.sessionId);
            return;
        }
        this.scheduleFlush(event.sessionId, frame);
    }

    flushSession(sessionId: string): void {
        const frame = this.framesBySessionId.get(sessionId);
        if (!frame || frame.events.size === 0) return;

        frame.cancelScheduledFlush?.();
        frame.cancelScheduledFlush = null;
        const events = [...frame.events.values()];
        this.framesBySessionId.delete(sessionId);
        this.options.onFlush?.({
            eventCount: events.length,
            firstQueuedAt: frame.firstQueuedAt,
            sessionId,
        });
        this.flushing = true;
        try {
            for (const event of events) this.options.apply(event);
        } finally {
            this.flushing = false;
        }
    }

    reset(): void {
        for (const frame of this.framesBySessionId.values()) {
            frame.cancelScheduledFlush?.();
        }
        this.framesBySessionId.clear();
        this.flushing = false;
    }

    private pendingEventCount(): number {
        let total = 0;
        for (const frame of this.framesBySessionId.values()) {
            total += frame.events.size;
        }
        return total;
    }

    private scheduleFlush(sessionId: string, frame: SessionEventFrame): void {
        if (frame.cancelScheduledFlush) return;
        const flush = () => {
            if (this.framesBySessionId.get(sessionId) === frame) {
                frame.cancelScheduledFlush = null;
            }
            this.flushSession(sessionId);
        };
        frame.cancelScheduledFlush = (this.options.schedule ?? scheduleNextFrame)(
            flush,
        );
    }
}

export function isFrameBufferableAiSessionEvent(
    event: AiSessionDomainEvent,
): event is FrameBufferedAiSessionEvent {
    return (
        event.kind === "message-delta" ||
        event.kind === "thinking-delta" ||
        (event.kind === "tool-activity" &&
            (event.activity.status === "pending" ||
                event.activity.status === "in_progress"))
    );
}

function frameEventKey(event: FrameBufferedAiSessionEvent): string {
    if (event.kind === "message-delta") {
        return `${event.kind}\u{1f}${event.messageKind}\u{1f}${event.messageId}`;
    }
    if (event.kind === "thinking-delta") {
        return `${event.kind}\u{1f}${event.messageId}`;
    }
    return `${event.kind}\u{1f}${event.activity.id}`;
}

function mergeFrameEvent(
    existing: FrameBufferedAiSessionEvent,
    incoming: FrameBufferedAiSessionEvent,
): FrameBufferedAiSessionEvent {
    if (existing.kind === "tool-activity" && incoming.kind === "tool-activity") {
        return {
            ...incoming,
            activity: mergeBufferedToolActivity(
                existing.activity,
                incoming.activity,
            ),
        };
    }
    if (existing.kind === "message-delta" && incoming.kind === "message-delta") {
        return {
            ...incoming,
            content:
                incoming.content.length >= existing.content.length
                    ? incoming.content
                    : `${existing.content}${incoming.delta}`,
            delta: `${existing.delta}${incoming.delta}`,
        };
    }
    if (existing.kind === "thinking-delta" && incoming.kind === "thinking-delta") {
        return {
            ...incoming,
            content:
                incoming.content.length >= existing.content.length
                    ? incoming.content
                    : `${existing.content}${incoming.delta}`,
            delta: `${existing.delta}${incoming.delta}`,
        };
    }
    return incoming;
}

function mergeBufferedToolActivity(
    existing: AiToolActivity,
    incoming: AiToolActivity,
): AiToolActivity {
    const merged = mergeAiTranscriptToolActivity(existing, incoming);
    return {
        ...merged,
        action: incoming.action ?? existing.action,
        changeStats: incoming.changeStats ?? existing.changeStats,
        diffs: incoming.diffs.length > 0 ? incoming.diffs : existing.diffs,
        locations:
            incoming.locations.length > 0
                ? incoming.locations
                : existing.locations,
        rawInputJson: incoming.rawInputJson ?? existing.rawInputJson,
        rawOutputJson: incoming.rawOutputJson ?? existing.rawOutputJson,
        summary: incoming.summary ?? existing.summary,
        terminalOutput: incoming.terminalOutput ?? existing.terminalOutput,
        toolActivityDetailId:
            incoming.toolActivityDetailId ?? existing.toolActivityDetailId,
    };
}

function scheduleNextFrame(flush: () => void): () => void {
    if (typeof globalThis.requestAnimationFrame === "function") {
        const frameId = globalThis.requestAnimationFrame(flush);
        return () => globalThis.cancelAnimationFrame(frameId);
    }
    const timer = setTimeout(flush, 16);
    return () => clearTimeout(timer);
}
