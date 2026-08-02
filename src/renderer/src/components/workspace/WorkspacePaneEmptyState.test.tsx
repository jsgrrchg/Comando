/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

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

function renderEmptyState() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mountedContainers.push(container);

    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(
            createElement(WorkspacePaneEmptyState),
        );
    });

    return { container };
}

describe("WorkspacePaneEmptyState", () => {
    it("shows only workspace shortcuts", () => {
        const { container } = renderEmptyState();
        expect(container.textContent).toContain("Open a file");
        expect(container.textContent).not.toContain("Open existing project");
        expect(container.querySelectorAll("button")).toHaveLength(0);
    });
});
