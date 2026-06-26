import { describe, expect, it, vi } from "vitest";

import type {
    AiSessionDomainEvent,
    AiSessionStreamMessage,
    AiSessionStreamPayload,
} from "@shared/ipc";

import { deliverAiSessionStreamMessage } from "./ai-session-stream";

function createPayload(): AiSessionStreamPayload {
    return {
        kind: "status",
        activeTurnStartedAt: null,
        lastError: null,
        origin: "live",
        parentSessionId: null,
        runtimeId: "codex",
        runtimeSessionId: "runtime-session-1",
        sessionId: "session-1",
        status: "streaming",
        updatedAt: "2026-04-14T00:00:00.000Z",
    } satisfies AiSessionDomainEvent;
}

function createMessage(
    payload: AiSessionStreamPayload = createPayload(),
): AiSessionStreamMessage {
    return {
        payload,
        seq: 7,
        type: "payload",
    };
}

function createHandlers() {
    return {
        acknowledge: vi.fn(),
        notifyPayload: vi.fn(),
        reportDispatchError: vi.fn(),
        reportWarning: vi.fn(),
    };
}

describe("AI session stream preload delivery", () => {
    it("acknowledges valid payloads before notifying listeners", () => {
        const handlers = createHandlers();

        deliverAiSessionStreamMessage(createMessage(), handlers);

        expect(handlers.acknowledge).toHaveBeenCalledWith(7);
        expect(handlers.notifyPayload).toHaveBeenCalledTimes(1);
        expect(handlers.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
            handlers.notifyPayload.mock.invocationCallOrder[0],
        );
    });

    it("acknowledges ping envelopes without notifying payload listeners", () => {
        const handlers = createHandlers();

        deliverAiSessionStreamMessage(
            {
                sentAt: 1_000,
                seq: 8,
                type: "ping",
            },
            handlers,
        );

        expect(handlers.acknowledge).toHaveBeenCalledWith(8);
        expect(handlers.notifyPayload).not.toHaveBeenCalled();
    });

    it("acknowledges a valid payload even when listener dispatch fails", () => {
        const error = new Error("listener failed");
        const handlers = createHandlers();
        handlers.notifyPayload.mockImplementation(() => {
            throw error;
        });

        deliverAiSessionStreamMessage(createMessage(), handlers);

        expect(handlers.acknowledge).toHaveBeenCalledWith(7);
        expect(handlers.reportDispatchError).toHaveBeenCalledWith(
            "[comando] AI session stream listener dispatch failed.",
            error,
        );
    });

    it("does not acknowledge or notify invalid envelopes", () => {
        const handlers = createHandlers();

        deliverAiSessionStreamMessage({ seq: 7, type: "payload" }, handlers);

        expect(handlers.acknowledge).not.toHaveBeenCalled();
        expect(handlers.notifyPayload).not.toHaveBeenCalled();
        expect(handlers.reportWarning).toHaveBeenCalledWith(
            "[comando] Dropped AI session stream envelope.",
        );
    });

    it("logs ACK failures and still notifies valid payload listeners", () => {
        const error = new Error("port closed");
        const handlers = createHandlers();
        handlers.acknowledge.mockImplementation(() => {
            throw error;
        });

        deliverAiSessionStreamMessage(createMessage(), handlers);

        expect(handlers.reportWarning).toHaveBeenCalledWith(
            "[comando] Failed to acknowledge AI session stream.",
            error,
        );
        expect(handlers.notifyPayload).toHaveBeenCalledWith(createPayload());
    });
});
