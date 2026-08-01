/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceInspectorView } from "@shared/ipc";
import { WorkspaceInspector } from "./WorkspaceInspector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
});

describe("WorkspaceInspector", () => {
    it("mounts all contextual views as an accessible keyboard tablist", () => {
        const onChangeView = vi.fn();
        mountInspector({ onChangeView });
        const tabs = container?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
        );

        expect(tabs).toHaveLength(5);
        expect(
            Array.from(tabs ?? [], (tab) => tab.getAttribute("aria-label")),
        ).toEqual(["Files", "Agents", "Git", "Issues", "Pull Requests"]);
        expect(tabs?.[0]?.getAttribute("aria-selected")).toBe("true");
        expect(container?.querySelector('[role="tabpanel"]')?.textContent).toBe(
            "Files panel",
        );
        expect(
            Array.from(
                container?.querySelectorAll(
                    ".workspace-inspector-tab__label",
                ) ?? [],
                (label) => label.textContent,
            ),
        ).toEqual(["Files", "Agents", "Git"]);
        expect(
            container?.querySelectorAll(".sidebar-action-row--icon"),
        ).toHaveLength(2);

        act(() => {
            tabs?.[0]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "ArrowRight",
                }),
            );
        });
        expect(onChangeView).toHaveBeenCalledWith("agents");

        act(() => {
            tabs?.[0]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "End",
                }),
            );
        });
        expect(onChangeView).toHaveBeenLastCalledWith("pull_requests");
    });

    it("keeps search contextual and exposes loading and unavailable states", () => {
        const onChangeFilter = vi.fn();
        mountInspector({
            filter: "src",
            hasCommittedWorkspace: false,
            onChangeFilter,
        });
        const search = container?.querySelector<HTMLInputElement>(
            'input[aria-label="Filter files"]',
        );

        expect(search?.disabled).toBe(true);
        expect(container?.textContent).toContain("Choose a workspace");
        act(() => {
            container
                ?.querySelector<HTMLButtonElement>(
                    'button[aria-label="Clear filter"]',
                )
                ?.click();
        });
        expect(onChangeFilter).toHaveBeenCalledWith("");
    });

    it("reports loading and inventory errors without mounting a stale panel", () => {
        mountInspector({
            error: "Project inventory is unavailable.",
            loading: true,
        });

        expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
            "Project inventory is unavailable.",
        );
        expect(container?.querySelector('[role="status"]')?.textContent).toBe(
            "Loading workspace inspector...",
        );
        expect(container?.textContent).not.toContain("Files panel");
    });

    it("renders the Git scope control only in the committed Git view", () => {
        mountInspector({ activeView: "git" });
        expect(
            container?.querySelector("[data-workspace-inspector-git-scope]")
                ?.textContent,
        ).toContain("Scope picker");
    });
});

function mountInspector({
    activeView = "files",
    error = null,
    filter = "",
    hasCommittedWorkspace = true,
    loading = false,
    onChangeFilter = vi.fn(),
    onChangeView = vi.fn(),
}: {
    readonly activeView?: WorkspaceInspectorView;
    readonly error?: string | null;
    readonly filter?: string;
    readonly hasCommittedWorkspace?: boolean;
    readonly loading?: boolean;
    readonly onChangeFilter?: (value: string) => void;
    readonly onChangeView?: (view: WorkspaceInspectorView) => void;
} = {}): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const panels = {
        agents: <div>Agents panel</div>,
        files: <div>Files panel</div>,
        git: <div>Git panel</div>,
        issues: <div>Issues panel</div>,
        pull_requests: <div>Pull requests panel</div>,
    };
    act(() =>
        root?.render(
            <WorkspaceInspector
                activeView={activeView}
                error={error}
                filter={filter}
                gitScopePicker={<button>Scope picker</button>}
                hasCommittedWorkspace={hasCommittedWorkspace}
                loading={loading}
                onChangeFilter={onChangeFilter}
                onChangeView={onChangeView}
                panels={panels}
            />,
        ),
    );
}
