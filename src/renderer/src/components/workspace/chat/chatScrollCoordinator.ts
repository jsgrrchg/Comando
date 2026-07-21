import {
    recordChatScrollWrite,
    type ChatScrollWriteReason,
} from "@renderer/app/debug/chatPerformanceProbe";

export type ChatScrollTarget = "end" | number;

export interface ChatScrollRequest {
    readonly reason: Exclude<ChatScrollWriteReason, "settle">;
    readonly target: ChatScrollTarget;
}

export interface ChatScrollCoordinator {
    cancelPending: () => void;
    flush: () => void;
    request: (
        request: ChatScrollRequest,
        context: ChatScrollRequestContext,
    ) => void;
}

export interface ChatScrollRequestContext {
    readonly element: HTMLElement | null;
    readonly navigationGeneration: number;
    readonly sessionId: string;
}

interface PendingChatScrollRequest extends ChatScrollRequest {
    readonly context: ChatScrollRequestContext;
}

const REQUEST_PRIORITY: Readonly<
    Record<ChatScrollRequest["reason"], number>
> = {
    "follow-end": 2,
    "measure-anchor": 1,
    "new-turn": 3,
    restore: 4,
    "scroll-to-index": 1,
};

function resolveScrollTarget(
    element: HTMLElement,
    target: ChatScrollTarget,
): number {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    const requested = target === "end" ? maximum : target;

    return Math.max(0, Math.min(requested, maximum));
}

export function createChatScrollCoordinator(): ChatScrollCoordinator {
    let pending: PendingChatScrollRequest | null = null;
    let flushScheduled = false;
    let priorityFloor = 0;

    const flush = () => {
        flushScheduled = false;
        const request = pending;
        pending = null;
        const element = request?.context.element;

        if (!request || !element) {
            return;
        }

        priorityFloor = Math.max(
            priorityFloor,
            REQUEST_PRIORITY[request.reason],
        );
        queueMicrotask(() => {
            priorityFloor = 0;
        });

        const after = resolveScrollTarget(element, request.target);
        const before = element.scrollTop;
        if (Math.abs(before - after) < 1) {
            return;
        }

        // One owner applies the selected request, so virtual corrections cannot
        // race a higher-priority restore, new-turn, or end-follow movement.
        element.scrollTop = after;
        recordChatScrollWrite({
            after,
            before,
            clientHeight: element.clientHeight,
            navigationGeneration: request.context.navigationGeneration,
            reason: request.reason,
            scrollHeight: element.scrollHeight,
            sessionId: request.context.sessionId,
        });
    };

    const scheduleFlush = () => {
        if (flushScheduled) {
            return;
        }

        flushScheduled = true;
        queueMicrotask(flush);
    };

    return {
        cancelPending: () => {
            pending = null;
        },
        flush,
        request: (request, context) => {
            const next: PendingChatScrollRequest = {
                ...request,
                context,
            };
            const current = pending;

            // Equal-priority requests use the latest geometry, while lower
            // priority corrections never displace an explicit navigation.
            if (REQUEST_PRIORITY[next.reason] < priorityFloor) {
                return;
            }

            if (
                !current ||
                REQUEST_PRIORITY[next.reason] >= REQUEST_PRIORITY[current.reason]
            ) {
                pending = next;
            }

            scheduleFlush();
        },
    };
}
