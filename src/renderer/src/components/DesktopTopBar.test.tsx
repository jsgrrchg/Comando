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
                        fullPath: "/projects/comando",
                        key: "project-1::__primary__",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                    {
                        fullPath: "/projects/comando-navigation",
                        key: "project-1::worktree-1",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: "worktree-1",
                        worktreeLabel: "feature/navigation",
                    },
                ]}
                leftSidebarCollapsed={false}
                menuProjects={[]}
                onActivateContext={vi.fn()}
                onActivateWorkspace={vi.fn(() => Promise.resolve())}
                onCloneRepository={vi.fn(() => Promise.resolve(true))}
                onCloseContext={vi.fn()}
                onOpenProject={vi.fn()}
                onOpenProjects={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenWorktree={vi.fn()}
                onReorderContext={vi.fn()}
                onToggleLeftSidebar={vi.fn()}
                platform="darwin"
                settingsLabel={null}
                workspaceSwitcherEntries={[]}
            />,
        );

        expect(markup).toContain("app-drag desktop-titlebar");
        expect(markup).toContain('role="tablist"');
        expect(markup).toContain('role="tab"');
        expect(markup).toContain('aria-selected="true"');
        expect(markup).toContain("feature/navigation");
        expect(markup).not.toContain("sidebar-git-scope-trigger--titlebar");
        expect(markup).toContain("app-no-drag");
        expect(markup).toContain("data-project-context-tab-key");
        expect(markup).toContain("data-project-context-tab-action");
    });
});
