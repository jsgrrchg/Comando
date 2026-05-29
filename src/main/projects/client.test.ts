import { describe, expect, it, vi } from "vitest";

vi.mock("./worker?modulePath", () => ({
    default: "/test/project-worker.js",
}));

const { __testing } = await import("./client");

describe("project worker client event routing", () => {
    it("lets RPC responses pass through to the supervisor", () => {
        const onProjectTreeInvalidated = vi.fn();

        const handled = __testing.handleProjectWorkerMessage(
            {
                id: 1,
                result: null,
            },
            onProjectTreeInvalidated,
        );

        expect(handled).toBe(false);
        expect(onProjectTreeInvalidated).not.toHaveBeenCalled();
    });

    it("handles project invalidation events", () => {
        const onProjectTreeInvalidated = vi.fn();
        const payload = {
            occurredAt: "2026-05-29T00:00:00.000Z",
            projectId: "project-1",
            relativePaths: ["src/main.ts"],
            worktreeId: null,
        };

        const handled = __testing.handleProjectWorkerMessage(
            {
                event: "project.invalidated",
                payload,
                type: "event",
            },
            onProjectTreeInvalidated,
        );

        expect(handled).toBe(true);
        expect(onProjectTreeInvalidated).toHaveBeenCalledWith(payload);
    });

    it("consumes malformed project invalidation events without crashing", () => {
        const onProjectTreeInvalidated = vi.fn();

        const handled = __testing.handleProjectWorkerMessage(
            {
                event: "project.invalidated",
                type: "event",
            },
            onProjectTreeInvalidated,
        );

        expect(handled).toBe(true);
        expect(onProjectTreeInvalidated).not.toHaveBeenCalled();
    });
});
