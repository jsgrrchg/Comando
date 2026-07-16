import { describe, expect, it, vi } from "vitest";

import { RendererTaskScheduler } from "./renderer-task-scheduler";

describe("RendererTaskScheduler", () => {
    it("runs visible work before background work", async () => {
        const scheduler = new RendererTaskScheduler();
        const calls: string[] = [];

        const background = scheduler.schedule(
            { key: "background", priority: "background", workspaceId: "one" },
            () => calls.push("background"),
        );
        const visible = scheduler.schedule(
            { key: "visible", priority: "visible", workspaceId: "one" },
            () => calls.push("visible"),
        );

        await Promise.all([background, visible]);
        expect(calls).toEqual(["visible", "background"]);
    });

    it("does not apply a cancelled workspace task", async () => {
        const scheduler = new RendererTaskScheduler();
        const run = vi.fn();
        const pending = scheduler.schedule(
            { key: "search", priority: "visible", workspaceId: "one" },
            run,
        );

        scheduler.cancelWorkspace("one");

        await expect(pending).resolves.toBeUndefined();
        expect(run).not.toHaveBeenCalled();
    });

    it("aborts a task that is already running", async () => {
        const scheduler = new RendererTaskScheduler();
        let resolveRun!: (value: string) => void;
        const pending = scheduler.schedule(
            { key: "running", priority: "visible", workspaceId: "one" },
            ({ signal }) =>
                new Promise<string>((resolve) => {
                    expect(signal.aborted).toBe(false);
                    resolveRun = resolve;
                }),
        );

        await Promise.resolve();
        scheduler.cancelWorkspace("one");
        resolveRun("stale");

        await expect(pending).resolves.toBeUndefined();
    });
});
