import type { AiSessionStreamMessage } from "@shared/ipc";

export interface AiSessionStreamDeliveryHandlers {
    readonly acknowledge: (seq: number) => void;
    readonly notifyPayload: (payload: unknown) => void;
    readonly reportDispatchError: (message: string, error: unknown) => void;
    readonly reportWarning: (message: string, error?: unknown) => void;
}

function isAiSessionStreamMessage(
    message: unknown,
): message is AiSessionStreamMessage {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const candidate = message as {
        readonly payload?: unknown;
        readonly sentAt?: unknown;
        readonly seq?: unknown;
        readonly type?: unknown;
    };
    if (typeof candidate.seq !== "number") {
        return false;
    }
    if (candidate.type === "payload") {
        return candidate.payload !== undefined;
    }
    return candidate.type === "ping" && typeof candidate.sentAt === "number";
}

export function deliverAiSessionStreamMessage(
    message: unknown,
    handlers: AiSessionStreamDeliveryHandlers,
): void {
    if (!isAiSessionStreamMessage(message)) {
        handlers.reportWarning("[comando] Dropped AI session stream envelope.");
        return;
    }

    if (message.type !== "payload") {
        try {
            handlers.acknowledge(message.seq);
        } catch (error) {
            handlers.reportWarning(
                "[comando] Failed to acknowledge AI session stream.",
                error,
            );
        }
        return;
    }

    try {
        handlers.notifyPayload(message.payload);
    } catch (error) {
        handlers.reportDispatchError(
            "[comando] AI session stream listener dispatch failed.",
            error,
        );
        return;
    }

    // ACK confirms synchronous listener ingestion, not a completed React paint.
    try {
        handlers.acknowledge(message.seq);
    } catch (error) {
        handlers.reportWarning(
            "[comando] Failed to acknowledge AI session stream.",
            error,
        );
    }
}
