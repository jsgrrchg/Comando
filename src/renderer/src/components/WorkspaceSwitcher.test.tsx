/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
});

describe("WorkspaceSwitcher", () => {
    it("groups, filters, and activates remote workspaces", async () => {
        const activateWorkspaceLocation = vi.fn(() => Promise.resolve(true));
        vi.stubGlobal("comando", {
            activateWorkspaceLocation,
            listOpenWorkspaceLocations: vi.fn(() =>
                Promise.resolve([
                    createLocation("window-1", "project-1", true),
                    createLocation("window-2", "project-2", false),
                ]),
            ),
        });
        const onClose = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root?.render(
                <WorkspaceSwitcher
                    onClose={onClose}
                    open={true}
                    projects={[
                        { id: "project-1", name: "Comando", worktrees: [] },
                        { id: "project-2", name: "Sandbox", worktrees: [] },
                    ]}
                />,
            );
            await Promise.resolve();
        });

        expect(document.body.textContent).toContain("Current Window");
        expect(document.body.textContent).toContain("Other Windows");
        const input = document.body.querySelector<HTMLInputElement>(
            '[aria-label="Search open workspaces"]',
        );
        expect(input).toBeTruthy();
        act(() => {
            if (!input) {
                return;
            }
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )?.set?.call(input, "Sandbox");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain("Current Window");
        const option = document.body.querySelector<HTMLButtonElement>(
            ".workspace-switcher-item",
        );
        await act(async () => {
            option?.click();
            await Promise.resolve();
        });
        expect(activateWorkspaceLocation).toHaveBeenCalledWith(
            expect.objectContaining({ hostWindowId: "window-2" }),
        );
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes with Escape without activating", async () => {
        const activateWorkspaceLocation = vi.fn();
        vi.stubGlobal("comando", {
            activateWorkspaceLocation,
            listOpenWorkspaceLocations: vi.fn(() => Promise.resolve([])),
        });
        const onClose = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root?.render(
                <WorkspaceSwitcher
                    onClose={onClose}
                    open={true}
                    projects={[]}
                />,
            );
            await Promise.resolve();
        });
        const input = document.body.querySelector<HTMLInputElement>(
            '[aria-label="Search open workspaces"]',
        );
        act(() => {
            input?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
        });
        expect(onClose).toHaveBeenCalledOnce();
        expect(activateWorkspaceLocation).not.toHaveBeenCalled();
    });
});

function createLocation(
    hostWindowId: string,
    projectId: string,
    isCurrentWindow: boolean,
) {
    return {
        contextKey: `${projectId}::__primary__`,
        hostWindowId,
        isActive: true,
        isCurrentWindow,
        lastActivatedAt: "2026-07-22T00:00:00.000Z",
        projectId,
        windowTitle: `Comando · ${projectId}`,
        worktreeId: null,
    };
}
