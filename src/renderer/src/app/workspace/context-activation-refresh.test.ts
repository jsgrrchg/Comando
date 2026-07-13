import { describe, expect, it, vi } from "vitest";

import {
    resolveWorkspaceContextRefreshPlan,
    runDeduplicatedContextRefresh,
} from "./context-activation-refresh";

describe("resolveWorkspaceContextRefreshPlan", () => {
    it("loads only a missing visible file tree", () => {
        expect(
            resolveWorkspaceContextRefreshPlan({
                hasGitSnapshot: false,
                hasProjectTree: false,
                sidebarView: "files",
                sidebarVisible: true,
            }),
        ).toEqual({ gitSnapshot: false, projectTree: true });
    });

    it("loads only a missing visible Git snapshot", () => {
        expect(
            resolveWorkspaceContextRefreshPlan({
                hasGitSnapshot: false,
                hasProjectTree: false,
                sidebarView: "git",
                sidebarVisible: true,
            }),
        ).toEqual({ gitSnapshot: true, projectTree: false });
    });

    it("keeps cached context data without revalidating on activation", () => {
        expect(
            resolveWorkspaceContextRefreshPlan({
                hasGitSnapshot: true,
                hasProjectTree: true,
                sidebarView: "files",
                sidebarVisible: true,
            }),
        ).toEqual({ gitSnapshot: false, projectTree: false });
    });

    it("defers loading while the sidebar is hidden", () => {
        expect(
            resolveWorkspaceContextRefreshPlan({
                hasGitSnapshot: false,
                hasProjectTree: false,
                sidebarView: "git",
                sidebarVisible: false,
            }),
        ).toEqual({ gitSnapshot: false, projectTree: false });
    });
});

describe("runDeduplicatedContextRefresh", () => {
    it("shares an in-flight refresh for the same context", async () => {
        let resolveRefresh!: (value: string) => void;
        const refresh = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    resolveRefresh = resolve;
                }),
        );
        const pending = new Map<string, Promise<string>>();

        const first = runDeduplicatedContextRefresh(
            pending,
            "project::primary",
            refresh,
        );
        const second = runDeduplicatedContextRefresh(
            pending,
            "project::primary",
            refresh,
        );

        expect(first).toBe(second);
        expect(refresh).toHaveBeenCalledTimes(0);

        await Promise.resolve();
        expect(refresh).toHaveBeenCalledTimes(1);
        resolveRefresh("done");
        await expect(first).resolves.toBe("done");
        expect(pending.size).toBe(0);
    });

    it("allows a retry after a failed refresh", async () => {
        const pending = new Map<string, Promise<void>>();
        const failedRefresh = runDeduplicatedContextRefresh(
            pending,
            "project::primary",
            () => Promise.reject(new Error("failed")),
        );

        await expect(failedRefresh).rejects.toThrow("failed");
        expect(pending.size).toBe(0);

        await expect(
            runDeduplicatedContextRefresh(
                pending,
                "project::primary",
                () => Promise.resolve(),
            ),
        ).resolves.toBeUndefined();
    });
});
