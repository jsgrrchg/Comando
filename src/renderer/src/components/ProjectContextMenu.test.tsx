import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectContextMenu } from "./ProjectContextMenu";

describe("ProjectContextMenu", () => {
    it("groups worktrees under projects and exposes workspace actions", () => {
        const markup = renderToStaticMarkup(
            <ProjectContextMenu
                anchorLeft={84}
                onCloneRepository={vi.fn(() => Promise.resolve(true))}
                onClose={vi.fn()}
                onOpenProject={vi.fn()}
                onOpenProjects={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenWorktree={vi.fn()}
                projects={[
                    {
                        id: "project-1",
                        mainIsActive: true,
                        mainIsOpen: true,
                        name: "Comando",
                        worktrees: [
                            {
                                id: "worktree-1",
                                isActive: false,
                                isOpen: true,
                                label: "feature/navigation",
                            },
                        ],
                    },
                ]}
                settingsLabel="Settings · Update ready"
            />,
        );

        expect(markup).toContain("Search projects and worktrees");
        expect(markup).toContain("Comando");
        expect(markup).toContain("feature/navigation");
        expect(markup).toContain("Open");
        expect(markup).toContain("Open folder…");
        expect(markup).toContain("Clone repository…");
        expect(markup).toContain("Settings");
        expect(markup).toContain("Update ready");
        expect(markup).toContain("project-context-update-dot");
        expect(markup).toContain('aria-expanded="true"');
    });
});
