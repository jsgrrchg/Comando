import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createGitProjectRefreshScheduler,
    gitInvalidationAffectsHistory,
    gitInvalidationAffectsHistoryForScope,
} from "./refresh-scheduler";

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

    it("coalesces history refreshes with the project refresh", async () => {
        vi.useFakeTimers();
        const refreshHistory = vi.fn().mockResolvedValue(undefined);
        const refreshProject = vi.fn().mockResolvedValue(undefined);
        const scheduler = createGitProjectRefreshScheduler({
            refreshHistory,
            refreshProject,
        });

        scheduler.schedule("project-1", "worktree-1", {
            refreshHistory: true,
        });
        scheduler.schedule("project-1", "worktree-1");
        vi.runAllTimers();
        await Promise.resolve();

        expect(refreshProject).toHaveBeenCalledTimes(1);
        expect(refreshHistory).toHaveBeenCalledTimes(1);
        expect(refreshHistory).toHaveBeenCalledWith("project-1", "worktree-1");
    });

    it("does not invalidate history for status-only changes", () => {
        expect(gitInvalidationAffectsHistory("status")).toBe(false);
        expect(gitInvalidationAffectsHistory("branch")).toBe(true);
        expect(gitInvalidationAffectsHistory("remote")).toBe(true);
        expect(gitInvalidationAffectsHistory("worktree")).toBe(true);
        expect(gitInvalidationAffectsHistory("unknown")).toBe(true);
    });

    it("refreshes History only in the invalidated workspace scope", () => {
        const invalidation = {
            occurredAt: "2026-08-03T12:00:00.000Z",
            projectId: "project-1",
            reason: "branch" as const,
            rootPath: "/tmp/project-worktree",
            worktreeId: "project-1:worktree:feature",
        };

        expect(
            gitInvalidationAffectsHistoryForScope(
                invalidation,
                "project-1:worktree:feature",
            ),
        ).toBe(true);
        expect(
            gitInvalidationAffectsHistoryForScope(
                invalidation,
                "project-1:primary",
            ),
        ).toBe(false);
        expect(
            gitInvalidationAffectsHistoryForScope(
                { ...invalidation, worktreeId: null },
                "project-1:primary",
            ),
        ).toBe(true);
    });
});
