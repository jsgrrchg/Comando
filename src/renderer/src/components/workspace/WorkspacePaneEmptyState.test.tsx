/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";

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

function renderEmptyState(
    props: Partial<Parameters<typeof WorkspacePaneEmptyState>[0]> = {},
) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainers.push(container);

    const onOpenProject = vi.fn();
    const onOpenProjects = vi.fn();
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(WorkspacePaneEmptyState, {
                onOpenProject,
                onOpenProjects,
                recentProjects: [],
                ...props,
            }),
        );
    });

    return { container, onOpenProject, onOpenProjects };
}

describe("WorkspacePaneEmptyState", () => {
    it("shows the open project CTA as the dominant action when there are no recent projects", () => {
        const { container } = renderEmptyState();
        const cta = container.querySelector<HTMLButtonElement>(
            'button[type="button"]',
        );
        expect(cta?.textContent).toContain("Open existing project");
    });

    it("renders the name of each recent project", () => {
        const { container } = renderEmptyState({
            recentProjects: [
                { id: "project-1", name: "Comando" },
                { id: "project-2", name: "Sandbox" },
            ],
        });

        expect(container.textContent).toContain("Comando");
        expect(container.textContent).toContain("Sandbox");
    });

    it("opens the exact project id clicked", () => {
        const { container, onOpenProject } = renderEmptyState({
            recentProjects: [
                { id: "project-1", name: "Comando" },
                { id: "project-2", name: "Sandbox" },
            ],
        });

        const sandboxButton = Array.from(
            container.querySelectorAll("button"),
        ).find((button) => button.textContent?.includes("Sandbox"));
        expect(sandboxButton).toBeTruthy();

        act(() => {
            sandboxButton?.click();
        });

        expect(onOpenProject).toHaveBeenCalledOnce();
        expect(onOpenProject).toHaveBeenCalledWith("project-2");
    });

    it("invokes the open projects callback from the CTA", () => {
        const { container, onOpenProjects } = renderEmptyState({
            recentProjects: [{ id: "project-1", name: "Comando" }],
        });

        const cta = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.includes("Open existing project"),
        );
        expect(cta).toBeTruthy();

        act(() => {
            cta?.click();
        });

        expect(onOpenProjects).toHaveBeenCalledOnce();
    });
});
