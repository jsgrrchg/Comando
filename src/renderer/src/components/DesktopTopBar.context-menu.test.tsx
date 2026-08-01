/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopTopBar } from "./DesktopTopBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of mountedRoots.splice(0)) {
        act(() => root.unmount());
    }
    for (const container of mountedContainers.splice(0)) {
        container.remove();
    }
});

function renderTopBar() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainers.push(container);

    const onCloseContext = vi.fn();
    const onOpenProject = vi.fn();
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(DesktopTopBar, {
                activeContextKey: "project-1::__primary__",
                contexts: [
                    {
                        fullPath: "/projects/comando",
                        key: "project-1::__primary__",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                    {
                        fullPath: "/projects/sandbox",
                        key: "project-2::__primary__",
                        projectId: "project-2",
                        projectName: "Sandbox",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                ],
                leftSidebarCollapsed: false,
                menuProjects: [
                    {
                        id: "project-1",
                        mainIsActive: true,
                        mainIsOpen: true,
                        name: "Comando",
                        worktrees: [],
                    },
                ],
                onActivateContext: vi.fn(),
                onActivateWorkspace: vi.fn(() => Promise.resolve()),
                onCloneRepository: vi.fn(() => Promise.resolve(true)),
                onCloseContext,
                onOpenProject,
                onOpenProjects: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenWorktree: vi.fn(),
                onReorderContext: vi.fn(),
                onToggleLeftSidebar: vi.fn(),
                platform: "darwin",
                settingsLabel: null,
                workspaceSwitcherEntries: [],
            }),
        );
    });

    return {
        container,
        onCloseContext,
        onOpenProject,
    };
}

describe("DesktopTopBar context menu", () => {
    it("offers path copy and close actions for the context clicked with the secondary button", async () => {
        const writeClipboardText = vi.fn(() => Promise.resolve());
        const writeText = vi.fn(() => Promise.resolve());
        const showWorkspaceContextMenu = vi
            .fn()
            .mockResolvedValueOnce({ type: "copy_full_path" })
            .mockResolvedValueOnce({ type: "close" });
        vi.stubGlobal("navigator", {
            ...navigator,
            clipboard: { writeText },
        });
        vi.stubGlobal("comando", {
            showWorkspaceContextMenu,
            writeClipboardText,
        });
        const { container, onCloseContext } = renderTopBar();
        const tab = container.querySelector<HTMLElement>(
            '[data-project-context-tab-key="project-2::__primary__"]',
        );
        expect(tab).toBeTruthy();

        await act(async () => {
            tab?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
            await Promise.resolve();
        });

        expect(showWorkspaceContextMenu).toHaveBeenLastCalledWith({
            canCopyFullPath: true,
            contextKey: "project-2::__primary__",
            projectId: "project-2",
            worktreeId: null,
            x: 120,
            y: 40,
        });
        expect(writeClipboardText).toHaveBeenCalledWith("/projects/sandbox");
        expect(writeText).not.toHaveBeenCalled();

        await act(async () => {
            tab?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
            await Promise.resolve();
        });
        expect(onCloseContext).toHaveBeenCalledWith(
            "project-2::__primary__",
        );

        await act(async () => {
            tab?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
            await Promise.resolve();
        });
        expect(onCloseContext).toHaveBeenCalledTimes(1);
    });

    it("opens a project from the portaled project menu", async () => {
        const { container, onOpenProject } = renderTopBar();
        const trigger = container.querySelector<HTMLButtonElement>(
            '[aria-label="Open project or worktree"]',
        );
        expect(trigger).toBeTruthy();

        act(() => {
            trigger?.click();
        });

        const project = document.body.querySelector<HTMLButtonElement>(
            ".project-context-project-main",
        );
        expect(project).toBeTruthy();

        await act(async () => {
            project?.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true }),
            );
            project?.click();
            await Promise.resolve();
        });

        expect(onOpenProject).toHaveBeenCalledWith("project-1");
    });
});
