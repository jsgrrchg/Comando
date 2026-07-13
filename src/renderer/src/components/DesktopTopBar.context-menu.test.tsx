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
    const onMoveContextToNewWindow = vi.fn();
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(DesktopTopBar, {
                activeContextKey: "project-1::__primary__",
                contexts: [
                    {
                        key: "project-1::__primary__",
                        projectId: "project-1",
                        projectName: "Comando",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                    {
                        key: "project-2::__primary__",
                        projectId: "project-2",
                        projectName: "Sandbox",
                        worktreeId: null,
                        worktreeLabel: "main",
                    },
                ],
                leftSidebarCollapsed: false,
                menuProjects: [],
                onActivateContext: vi.fn(),
                onCloneRepository: vi.fn(() => Promise.resolve(true)),
                onCloseContext,
                onMoveContextToNewWindow,
                onOpenProject: vi.fn(),
                onOpenProjects: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenWorktree: vi.fn(),
                onReorderContext: vi.fn(),
                onToggleLeftSidebar: vi.fn(),
                platform: "darwin",
                settingsLabel: null,
            }),
        );
    });

    return { container, onCloseContext, onMoveContextToNewWindow };
}

function getContextMenuButton(label: string): HTMLButtonElement {
    const button = document.body.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
    );
    if (!button) {
        throw new Error(`Context menu action "${label}" was not rendered.`);
    }
    return button;
}

describe("DesktopTopBar context menu", () => {
    it("offers move and close actions for the context clicked with the secondary button", async () => {
        const { container, onCloseContext, onMoveContextToNewWindow } =
            renderTopBar();
        const tab = container.querySelector<HTMLElement>(
            '[data-project-context-tab-key="project-2::__primary__"]',
        );
        expect(tab).toBeTruthy();

        act(() => {
            tab?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });

        expect(getContextMenuButton("Move to New Window")).toBeTruthy();
        expect(getContextMenuButton("Close")).toBeTruthy();

        await act(async () => {
            getContextMenuButton("Move to New Window").click();
            await Promise.resolve();
        });
        expect(onMoveContextToNewWindow).toHaveBeenCalledWith(
            "project-2::__primary__",
        );
        expect(onCloseContext).not.toHaveBeenCalled();
    });
});
