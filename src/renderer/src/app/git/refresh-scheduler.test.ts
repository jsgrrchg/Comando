import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitProjectRefreshScheduler } from "./refresh-scheduler";

describe("createGitProjectRefreshScheduler", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("cancels a pending invalidation refresh when a snapshot arrives", () => {
        vi.useFakeTimers();
        const refreshProject = vi.fn().mockResolvedValue(undefined);
        const scheduler = createGitProjectRefreshScheduler({
            refreshProject,
        });

        scheduler.schedule("project-1", "worktree-1");
        scheduler.cancel("project-1", "worktree-1");
        vi.runAllTimers();

        expect(refreshProject).not.toHaveBeenCalled();
    });

    it("deduplicates repeated invalidations for the same git context", () => {
        vi.useFakeTimers();
        const refreshProject = vi.fn().mockResolvedValue(undefined);
        const scheduler = createGitProjectRefreshScheduler({
            refreshProject,
        });

        scheduler.schedule("project-1", null);
        scheduler.schedule("project-1", null);
        vi.runAllTimers();

        expect(refreshProject).toHaveBeenCalledTimes(1);
        expect(refreshProject).toHaveBeenCalledWith("project-1", null);
    });

    it("keeps independent worktree refreshes separate", () => {
        vi.useFakeTimers();
        const refreshProject = vi.fn().mockResolvedValue(undefined);
        const scheduler = createGitProjectRefreshScheduler({
            refreshProject,
        });

        scheduler.schedule("project-1", "worktree-a");
        scheduler.schedule("project-1", "worktree-b");
        scheduler.cancel("project-1", "worktree-a");
        vi.runAllTimers();

        expect(refreshProject).toHaveBeenCalledTimes(1);
        expect(refreshProject).toHaveBeenCalledWith(
            "project-1",
            "worktree-b",
        );
    });

    it("runs one final refresh when invalidations arrive during a request", async () => {
        vi.useFakeTimers();
        const refreshControl: { finish: (() => void) | null } = {
            finish: null,
        };
        const refreshProject = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    refreshControl.finish = resolve;
                }),
        );
        const scheduler = createGitProjectRefreshScheduler({
            refreshProject,
        });

        scheduler.schedule("project-1", null);
        vi.runAllTimers();
        scheduler.schedule("project-1", null);
        vi.runAllTimers();

        expect(refreshProject).toHaveBeenCalledTimes(1);
        refreshControl.finish?.();
        await Promise.resolve();

        expect(refreshProject).toHaveBeenCalledTimes(2);
    });
});
