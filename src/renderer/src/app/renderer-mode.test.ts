import { describe, expect, it } from "vitest";

import {
    RENDERER_MODE_SUBSYSTEMS,
    parseWorkspaceSurfaceRendererDescriptor,
    rendererModeRequiresReviewEngine,
    resolveRendererMode,
} from "./renderer-mode";

describe("renderer mode composition", () => {
    it("selects the renderer before application modules mount", () => {
        expect(resolveRendererMode("?window=workspace-host")).toBe(
            "workspace-host",
        );
        expect(resolveRendererMode("?window=workspace-surface")).toBe(
            "workspace-surface",
        );
        expect(resolveRendererMode("?window=settings")).toBe("settings");
        expect(resolveRendererMode("")).toBe("legacy");
    });

    it("keeps host runtime subsystems out of its composition", () => {
        expect(RENDERER_MODE_SUBSYSTEMS["workspace-host"]).toEqual([
            "catalog",
            "navigation",
            "shell",
        ]);
        expect(RENDERER_MODE_SUBSYSTEMS["workspace-host"]).not.toContain(
            "runtime",
        );
        expect(RENDERER_MODE_SUBSYSTEMS["workspace-surface"]).not.toContain(
            "catalog",
        );
        expect(rendererModeRequiresReviewEngine("workspace-host")).toBe(false);
        expect(rendererModeRequiresReviewEngine("settings")).toBe(false);
        expect(rendererModeRequiresReviewEngine("workspace-surface")).toBe(
            true,
        );
    });

    it("parses an immutable surface scope and generation", () => {
        expect(
            parseWorkspaceSurfaceRendererDescriptor(
                "?window=workspace-surface&surface=g-2&runtime-owner=runtime-1&scope=project-1%3A%3Awt-1&project=project-1&worktree=wt-1&revision=7",
            ),
        ).toEqual({
            generation: "g-2",
            projectId: "project-1",
            revision: 7,
            runtimeOwnerId: "runtime-1",
            scopeKey: "project-1::wt-1",
            worktreeId: "wt-1",
        });
        expect(
            parseWorkspaceSurfaceRendererDescriptor(
                "?window=workspace-surface&surface=g-2",
            ),
        ).toBeNull();
    });
});
