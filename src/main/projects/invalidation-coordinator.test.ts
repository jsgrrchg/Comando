import { describe, expect, it, vi } from "vitest";
import type { ProjectTreeInvalidation } from "@shared/ipc";

import { createProjectInvalidationCoordinator } from "./invalidation-coordinator";

describe("ProjectInvalidationCoordinator", () => {
    it("coalesces a burst by project/worktree into one generation", () => {
        vi.useFakeTimers();
        const apply = vi.fn();
        const coordinator = createProjectInvalidationCoordinator({ apply });

        coordinator.enqueue({
            occurredAt: "2026-07-20T00:00:00.000Z",
            projectId: "project-1",
            relativePaths: ["src/a.ts"],
            worktreeId: "worktree-1",
        });
        coordinator.enqueue({
            occurredAt: "2026-07-20T00:00:01.000Z",
            projectId: "project-1",
            relativePaths: ["src/b.ts", "src/a.ts"],
            worktreeId: "worktree-1",
        });

        vi.runAllTimers();

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith({
            generation: 1,
            occurredAt: "2026-07-20T00:00:01.000Z",
            projectId: "project-1",
            relativePaths: ["src/a.ts", "src/b.ts"],
            worktreeId: "worktree-1",
        });
        coordinator.dispose();
        vi.useRealTimers();
    });

    it("keeps worktrees independent", () => {
        vi.useFakeTimers();
        const apply = vi.fn();
        const coordinator = createProjectInvalidationCoordinator({ apply });

        for (const worktreeId of ["worktree-a", "worktree-b"]) {
            coordinator.enqueue({
                occurredAt: "2026-07-20T00:00:00.000Z",
                projectId: "project-1",
                relativePaths: null,
                worktreeId,
            });
        }
        vi.runAllTimers();

        expect(apply).toHaveBeenCalledTimes(2);
        const worktreeIds = apply.mock.calls
            .map(
                ([payload]) =>
                    (payload as ProjectTreeInvalidation).worktreeId ?? null,
            )
            .sort();
        expect(worktreeIds).toEqual(["worktree-a", "worktree-b"]);
        coordinator.dispose();
        vi.useRealTimers();
    });
});
