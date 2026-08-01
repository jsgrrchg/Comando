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
    it("groups, filters, and activates the complete catalog", async () => {
        const setWorkspaceHostOverlayVisible = vi.fn(() => Promise.resolve());
        vi.stubGlobal("comando", { setWorkspaceHostOverlayVisible });
        const onActivate = vi.fn(() => Promise.resolve());
        const onClose = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root?.render(
                <WorkspaceSwitcher
                    entries={[
                        createEntry("project-1", "Comando", "Primary"),
                        createEntry(
                            "project-2",
                            "Sandbox",
                            "feature/navigation",
                            "worktree-2",
                        ),
                    ]}
                    onActivate={onActivate}
                    onClose={onClose}
                    open={true}
                />,
            );
            await Promise.resolve();
        });

        expect(document.body.textContent).toContain("Comando");
        expect(document.body.textContent).toContain("Sandbox");
        const input = document.body.querySelector<HTMLInputElement>(
            '[aria-label="Search all workspaces"]',
        );
        act(() => {
            if (!input) return;
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )?.set?.call(input, "navigation");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain("Comando");
        const option = document.body.querySelector<HTMLButtonElement>(
            ".workspace-switcher-item",
        );
        await act(async () => {
            option?.click();
            await Promise.resolve();
        });
        expect(onActivate).toHaveBeenCalledWith("project-2::worktree-2");
        expect(onClose).toHaveBeenCalledOnce();
        expect(setWorkspaceHostOverlayVisible).toHaveBeenCalledWith(true);
    });

    it("closes with Escape without activating", async () => {
        vi.stubGlobal("comando", {
            setWorkspaceHostOverlayVisible: vi.fn(() => Promise.resolve()),
        });
        const onActivate = vi.fn();
        const onClose = vi.fn();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root?.render(
                <WorkspaceSwitcher
                    entries={[]}
                    onActivate={onActivate}
                    onClose={onClose}
                    open={true}
                />,
            );
            await Promise.resolve();
        });
        const input = document.body.querySelector<HTMLInputElement>(
            '[aria-label="Search all workspaces"]',
        );
        act(() => {
            input?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
        });
        expect(onClose).toHaveBeenCalledOnce();
        expect(onActivate).not.toHaveBeenCalled();
    });
});

function createEntry(
    projectId: string,
    projectName: string,
    worktreeLabel: string,
    worktreeId: string | null = null,
) {
    return {
        isMissing: false,
        projectId,
        projectName,
        scopeKey: worktreeId
            ? `${projectId}::${worktreeId}`
            : `${projectId}::__primary__`,
        statusLabel: null,
        worktreeLabel,
    };
}
