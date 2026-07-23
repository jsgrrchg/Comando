import { describe, expect, it } from "vitest";

import { buildWorkspaceMoveDestinations } from "./move-destinations";

const emptySnapshot = {
    activeContextKey: null,
    contexts: [],
    openContextKeys: [],
    version: 3,
} as const;

describe("buildWorkspaceMoveDestinations", () => {
    it("omits the source and preserves exact destination window IDs", () => {
        expect(
            buildWorkspaceMoveDestinations({
                candidates: [
                    {
                        snapshot: emptySnapshot,
                        windowId: "source",
                        windowTitle: "Comando",
                    },
                    {
                        snapshot: emptySnapshot,
                        windowId: "target",
                        windowTitle: "Comando",
                    },
                ],
                scope: { projectId: "project-a", worktreeId: null },
                sourceWindowId: "source",
            }),
        ).toEqual([
            {
                enabled: true,
                label: "Window 1",
                targetWindowId: "target",
            },
        ]);
    });

    it("disables legacy duplicate scopes and labels active destinations", () => {
        const context = {
            key: "project-a::__primary__",
            lastActivatedAt: "2026-07-22T12:00:00.000Z",
            projectId: "project-a",
            workspace: {
                activePaneId: "pane-root",
                rootNode: {
                    activeTabId: null,
                    id: "pane-root",
                    tabIds: [],
                    type: "pane" as const,
                },
                tabs: [],
            },
            worktreeId: null,
        };
        const destinations = buildWorkspaceMoveDestinations({
            candidates: [
                {
                    snapshot: {
                        activeContextKey: context.key,
                        contexts: [context],
                        openContextKeys: [context.key],
                        version: 3,
                    },
                    windowId: "duplicate",
                    windowTitle: "Comando · Comando",
                },
            ],
            scope: { projectId: "project-a", worktreeId: null },
            sourceWindowId: "source",
        });

        expect(destinations).toEqual([
            {
                enabled: false,
                label: "Comando",
                targetWindowId: "duplicate",
            },
        ]);
    });

    it("enables a destination that only retains a closed equivalent scope", () => {
        const retainedContext = {
            key: "project-a::__primary__",
            lastActivatedAt: "2026-07-22T12:00:00.000Z",
            projectId: "project-a",
            workspace: {
                activePaneId: "pane-retained",
                rootNode: {
                    activeTabId: null,
                    id: "pane-retained",
                    tabIds: [],
                    type: "pane" as const,
                },
                tabs: [],
            },
            worktreeId: null,
        };

        expect(
            buildWorkspaceMoveDestinations({
                candidates: [
                    {
                        snapshot: {
                            activeContextKey: null,
                            contexts: [retainedContext],
                            openContextKeys: [],
                            version: 3,
                        },
                        windowId: "target",
                        windowTitle: "Comando",
                    },
                ],
                scope: { projectId: "project-a", worktreeId: null },
                sourceWindowId: "source",
            }),
        ).toEqual([
            {
                enabled: true,
                label: "Window 1",
                targetWindowId: "target",
            },
        ]);
    });
});
