import { describe, expect, it } from "vitest";

import { createChatScrollCoordinator } from "./chatScrollCoordinator";

function createScrollElement({
    clientHeight = 100,
    scrollHeight = 1_000,
    scrollTop = 0,
}: {
    readonly clientHeight?: number;
    readonly scrollHeight?: number;
    readonly scrollTop?: number;
} = {}): HTMLElement {
    return {
        clientHeight,
        scrollHeight,
        scrollTop,
    } as HTMLElement;
}

describe("chat scroll coordinator", () => {
    it("coalesces a visual change to its highest-priority request", async () => {
        const element = createScrollElement({ scrollTop: 240 });
        const coordinator = createChatScrollCoordinator();
        const context = {
            element,
            navigationGeneration: 7,
            sessionId: "session",
        };

        coordinator.request({ reason: "measure-anchor", target: 300 }, context);
        coordinator.request({ reason: "follow-end", target: "end" }, context);
        coordinator.request({ reason: "new-turn", target: 420 }, context);
        await Promise.resolve();

        expect(element.scrollTop).toBe(420);
    });

    it("keeps a synchronous restore ahead of later corrections in the same turn", async () => {
        const element = createScrollElement({ scrollTop: 240 });
        const coordinator = createChatScrollCoordinator();
        const context = {
            element,
            navigationGeneration: 3,
            sessionId: "session",
        };

        coordinator.request({ reason: "restore", target: 640 }, context);
        coordinator.flush();
        coordinator.request({ reason: "measure-anchor", target: 680 }, context);
        await Promise.resolve();

        expect(element.scrollTop).toBe(640);
    });

    it("lets a user gesture discard a queued programmatic movement", async () => {
        const element = createScrollElement({ scrollTop: 240 });
        const coordinator = createChatScrollCoordinator();
        const context = {
            element,
            navigationGeneration: 8,
            sessionId: "session",
        };

        coordinator.request({ reason: "follow-end", target: "end" }, context);
        coordinator.cancelPending();
        await Promise.resolve();

        expect(element.scrollTop).toBe(240);
    });
});
