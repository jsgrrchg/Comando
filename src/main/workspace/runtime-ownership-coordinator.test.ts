import { describe, expect, it, vi } from "vitest";

import type { WebContents } from "electron";

import { WorkspaceRuntimeOwnershipCoordinator } from "./runtime-ownership-coordinator";

describe("WorkspaceRuntimeOwnershipCoordinator", () => {
    it("replaces only the subscriber while retaining the durable owner", () => {
        const coordinator = new WorkspaceRuntimeOwnershipCoordinator();
        const first = createSubscriber(1, "generation-1");
        const second = createSubscriber(2, "generation-2");

        expect(coordinator.attach(first)).toBeNull();
        coordinator.setLifecycle(first, "visible");
        expect(coordinator.getVisibleSubscriber("runtime-owner")?.generation).toBe(
            "generation-1",
        );

        expect(coordinator.attach(second)?.generation).toBe("generation-1");
        coordinator.setLifecycle(second, "visible");
        expect(coordinator.getVisibleSubscriber("runtime-owner")?.generation).toBe(
            "generation-2",
        );
        coordinator
            .getVisibleSubscriber("runtime-owner")
            ?.webContents.send("runtime:event", { revision: 2 });
        expect(first.send).not.toHaveBeenCalled();
        expect(second.send).toHaveBeenCalledWith(
            "runtime:event",
            { revision: 2 },
        );
        expect(coordinator.detach(first)).toBe(false);
        expect(coordinator.getRuntimeOwnerId(first.webContents)).toBeNull();
        expect(coordinator.getRuntimeOwnerId(second.webContents)).toBe(
            "runtime-owner",
        );
    });

    it("does not dispatch to suspended or stale subscribers", () => {
        const coordinator = new WorkspaceRuntimeOwnershipCoordinator();
        const first = createSubscriber(1, "generation-1");
        const second = createSubscriber(2, "generation-2");
        coordinator.attach(first);
        coordinator.setLifecycle(first, "visible");
        coordinator.attach(second);
        coordinator.setLifecycle(second, "suspended");

        expect(coordinator.setLifecycle(first, "visible")).toBe(false);
        expect(coordinator.getVisibleSubscriber("runtime-owner")).toBeNull();
        coordinator.markRuntimeChanged("runtime-owner");
        expect(coordinator.consumeResyncRequirement(second)).toBe(true);
        expect(coordinator.consumeResyncRequirement(first)).toBe(false);
    });

    it("requires a fresh authoritative resync after every resume", () => {
        const coordinator = new WorkspaceRuntimeOwnershipCoordinator();
        const subscriber = createSubscriber(1, "generation-1");
        coordinator.attach(subscriber);

        expect(coordinator.consumeResyncRequirement(subscriber)).toBe(true);
        expect(coordinator.consumeResyncRequirement(subscriber)).toBe(false);
        coordinator.setLifecycle(subscriber, "visible");
        expect(coordinator.consumeResyncRequirement(subscriber)).toBe(true);
    });
});

function createSubscriber(webContentsId: number, generation: string) {
    const send = vi.fn();
    const webContents = {
        id: webContentsId,
        isDestroyed: vi.fn(() => false),
        send,
    } as unknown as WebContents;
    return {
        generation,
        runtimeOwnerId: "runtime-owner",
        scopeKey: "project::__primary__",
        send,
        webContents,
    };
}
