import { describe, expect, it } from "vitest";

import {
    ChatActivationScheduler,
    type ChatActivationPhase,
} from "./chatActivationScheduler";

describe("ChatActivationScheduler", () => {
    it("shows shell first and cancels stale activation work", async () => {
        const scheduler = new ChatActivationScheduler();
        const phases: ChatActivationPhase[] = [];
        const deferred: { release: () => void } = { release: () => undefined };
        const cancel = scheduler.activate("tab-1", async (phase) => {
            phases.push(phase);
            if (phase === "window") {
                await new Promise<void>((resolve) => {
                    deferred.release = resolve;
                });
            }
        });

        await Promise.resolve();
        cancel();
        deferred.release();
        await Promise.resolve();
        await Promise.resolve();

        expect(phases).toEqual(["shell", "window"]);
    });

    it("retains semantic view state independently from mounted DOM", () => {
        const scheduler = new ChatActivationScheduler();
        scheduler.save("tab-1", {
            anchor: { alignment: "start", entryId: "entry-1", offsetWithinEntry: 4 },
            expandedRailIds: new Set(["rail-1"]),
            followingLiveTail: false,
            protectedBlockIds: new Set(["block-1"]),
        });
        expect(scheduler.restore("tab-1")?.anchor?.entryId).toBe("entry-1");
    });
});
