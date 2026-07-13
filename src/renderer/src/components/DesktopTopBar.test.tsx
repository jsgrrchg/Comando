import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DesktopTopBar } from "./DesktopTopBar";

describe("DesktopTopBar", () => {
    it("renders accessible project context tabs inside the draggable chrome", () => {
        const markup = renderToStaticMarkup(
            <DesktopTopBar
                activeContextKey="project-1::__primary__"
                contexts={[
                    {
                        key: "project-1::__primary__",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                    {
                        key: "project-1::worktree-1",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: "worktree-1",
                        worktreeLabel: "feature/navigation",
                    },
                ]}
                menuProjects={[]}
                onActivateContext={vi.fn()}
                onCloneRepository={vi.fn(() => Promise.resolve(true))}
                onCloseContext={vi.fn()}
                onOpenProject={vi.fn()}
                onOpenProjects={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenWorktree={vi.fn()}
                platform="darwin"
            />,
        );

        expect(markup).toContain("app-drag desktop-titlebar");
        expect(markup).toContain('role="tablist"');
        expect(markup).toContain('role="tab"');
        expect(markup).toContain('aria-selected="true"');
        expect(markup).toContain("feature/navigation");
        expect(markup).toContain("app-no-drag");
    });
});
