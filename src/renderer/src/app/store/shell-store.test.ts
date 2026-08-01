import { afterEach, describe, expect, it } from "vitest";

import {
    createDefaultShellLayout,
    resolveShellResponsiveLayout,
    shellLayoutConstraints,
} from "../layout/shell-layout";
import {
    createPersistedShellState,
    migratePersistedShellState,
    useShellStore,
} from "./shell-store";

function resetShellStore(): void {
    const layout = createDefaultShellLayout();
    const viewportWidth = 1_440;
    useShellStore.setState({
        activeSurface: "workspace",
        drawerChangedLocally: false,
        expandedProjectIds: [],
        isResizingPanel: false,
        leftCollapsed: false,
        leftCollapsedChangedLocally: false,
        leftWidth: layout.leftWidth,
        preferredDrawer: null,
        projectOrder: [],
        responsive: resolveShellResponsiveLayout(
            layout,
            {
                leftCollapsed: false,
                preferredDrawer: null,
                rightCollapsed: false,
            },
            viewportWidth,
        ),
        rightCollapsed: false,
        rightCollapsedChangedLocally: false,
        rightInspectorView: "files",
        rightWidth: layout.rightWidth,
        viewportWidth,
    });
}

describe("shell-store", () => {
    afterEach(() => {
        resetShellStore();
    });

    it("migrates the legacy left utility panel into the right inspector", () => {
        const migrated = migratePersistedShellState({
            activeSurface: "projects",
            leftCollapsed: true,
            leftWidth: 412,
            sidebarView: "git",
        });

        expect(migrated).toEqual({
            activeSurface: "navigator",
            expandedProjectIds: [],
            leftCollapsed: false,
            leftWidth: shellLayoutConstraints.defaultLeftWidth,
            preferredDrawer: null,
            projectOrder: [],
            rightCollapsed: true,
            rightInspectorView: "git",
            rightWidth: 412,
            version: 3,
        });
    });

    it("hydrates a v2 snapshot without remapping its navigator", () => {
        useShellStore.getState().hydrate({
            activeSurface: "navigator",
            leftCollapsed: true,
            leftWidth: 312,
            preferredDrawer: "right",
            rightCollapsed: false,
            rightInspectorView: "agents",
            rightWidth: 430,
            version: 2,
        });

        expect(useShellStore.getState()).toMatchObject({
            activeSurface: "navigator",
            leftCollapsed: true,
            leftWidth: 312,
            preferredDrawer: "right",
            rightCollapsed: false,
            rightInspectorView: "agents",
            rightWidth: 430,
        });
    });

    it("persists navigator project preferences in v3 without duplicates", () => {
        useShellStore.getState().setProjectExpanded("project-a", true);
        useShellStore.getState().setProjectExpanded("project-a", true);
        useShellStore.getState().setProjectExpanded("project-b", true);
        useShellStore
            .getState()
            .setProjectOrder(["project-b", "project-a", "project-b"]);

        const persisted = createPersistedShellState(useShellStore.getState());
        expect(persisted).toMatchObject({
            expandedProjectIds: ["project-a", "project-b"],
            projectOrder: ["project-b", "project-a"],
            version: 3,
        });

        useShellStore.getState().setProjectExpanded("project-a", false);
        expect(useShellStore.getState().expandedProjectIds).toEqual([
            "project-b",
        ]);
    });

    it("preserves local panel and drawer changes during late hydration", () => {
        useShellStore.getState().toggleLeftCollapsed();
        useShellStore.getState().syncViewport(700);
        useShellStore.getState().toggleRightCollapsed();

        useShellStore.getState().hydrate({
            activeSurface: "workspace",
            leftCollapsed: false,
            leftWidth: 280,
            preferredDrawer: "left",
            rightCollapsed: true,
            rightInspectorView: "git",
            rightWidth: 420,
            version: 2,
        });

        expect(useShellStore.getState()).toMatchObject({
            leftCollapsed: true,
            preferredDrawer: "right",
            rightInspectorView: "git",
        });
    });

    it("keeps manual wide collapse separate from responsive drawers", () => {
        useShellStore.getState().setRightCollapsed(true);
        useShellStore.getState().syncViewport(980);

        expect(useShellStore.getState()).toMatchObject({
            rightCollapsed: true,
            responsive: {
                mode: "medium",
                right: { collapsed: true, overlay: true },
            },
        });

        useShellStore.getState().toggleRightCollapsed();
        expect(useShellStore.getState()).toMatchObject({
            preferredDrawer: "right",
            rightCollapsed: true,
            responsive: {
                right: { collapsed: false, overlay: true },
            },
        });

        useShellStore.getState().syncViewport(1_480);
        expect(useShellStore.getState().responsive.right.collapsed).toBe(true);
    });

    it("preserves stored widths while responsive modes apply narrower effective clamps", () => {
        useShellStore.getState().resizePanel("left", 400);
        useShellStore.getState().resizePanel("right", 460);
        const storedWideWidths = {
            leftWidth: useShellStore.getState().leftWidth,
            rightWidth: useShellStore.getState().rightWidth,
        };

        useShellStore.getState().syncViewport(700);
        useShellStore.getState().syncViewport(850);
        expect(
            useShellStore.getState().responsive.left.width,
        ).toBeLessThan(400);
        useShellStore.getState().syncViewport(980);

        expect(useShellStore.getState()).toMatchObject(storedWideWidths);

        useShellStore.getState().syncViewport(1_480);
        expect(useShellStore.getState()).toMatchObject(storedWideWidths);
    });

    it("serializes only versioned manual preferences", () => {
        const state = useShellStore.getState();
        expect(createPersistedShellState(state)).toMatchObject({
            leftCollapsed: false,
            preferredDrawer: null,
            rightCollapsed: false,
            rightInspectorView: "files",
            version: 3,
        });
        expect(createPersistedShellState(state)).not.toHaveProperty(
            "responsive",
        );
    });

    it("normalizes malformed persisted widths at the current viewport", () => {
        useShellStore.getState().hydrate({
            activeSurface: "workspace",
            leftCollapsed: false,
            leftWidth: Number.NaN,
            preferredDrawer: null,
            rightCollapsed: false,
            rightInspectorView: "files",
            rightWidth: Number.POSITIVE_INFINITY,
            version: 2,
        });

        expect(useShellStore.getState()).toMatchObject({
            leftWidth: shellLayoutConstraints.defaultLeftWidth,
            rightWidth: shellLayoutConstraints.defaultRightWidth,
        });
    });
});
