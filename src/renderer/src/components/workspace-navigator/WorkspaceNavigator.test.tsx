/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeContextMenuInput } from "@shared/ipc";

import type { WorkspaceNavigatorModel } from "@renderer/app/workspace-navigator/model";
import {
    reorderProjectIds,
    WorkspaceNavigator,
    type WorkspaceNavigatorProps,
} from "./WorkspaceNavigator";

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

describe("WorkspaceNavigator", () => {
    it("reorders projects around the selected drop edge", () => {
        expect(
            reorderProjectIds(
                ["project-a", "project-b", "project-c"],
                "project-a",
                "project-c",
                "after",
            ),
        ).toEqual(["project-b", "project-c", "project-a"]);
        expect(
            reorderProjectIds(
                ["project-a", "project-b", "project-c"],
                "project-c",
                "project-a",
                "before",
            ),
        ).toEqual(["project-c", "project-a", "project-b"]);
    });

    it("supports accessible project reordering with Alt and arrow keys", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const model = createModel();
        const firstProject = model.projects[0];
        if (!firstProject) {
            throw new Error("Expected a project fixture.");
        }
        const onReorderProjects = vi.fn();
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: {
                        ...model,
                        projects: [
                            ...model.projects,
                            {
                                ...firstProject,
                                id: "project-b",
                                name: "Testing",
                                workspaces: [],
                            },
                        ],
                    },
                    onReorderProjects,
                })}
            />,
        );
        await act(async () => Promise.resolve());

        const projectRows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-project-row",
        );
        act(() => {
            projectRows?.[1]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    altKey: true,
                    bubbles: true,
                    key: "ArrowUp",
                }),
            );
        });

        expect(onReorderProjects).toHaveBeenCalledWith([
            "project-b",
            "project-a",
        ]);
    });

    it("reorders projects through the pointer drag handle", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const model = createModel();
        const firstProject = model.projects[0];
        if (!firstProject) {
            throw new Error("Expected a project fixture.");
        }
        const onReorderProjects = vi.fn();
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: {
                        ...model,
                        projects: [
                            ...model.projects,
                            {
                                ...firstProject,
                                id: "project-b",
                                name: "Testing",
                                workspaces: [],
                            },
                        ],
                    },
                    onReorderProjects,
                })}
            />,
        );
        await act(async () => Promise.resolve());

        const projectRows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-project-row",
        );
        const handles = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-project-drag-handle",
        );
        vi.spyOn(projectRows?.[0] as HTMLElement, "getBoundingClientRect").mockReturnValue(
            createRect(0, 32),
        );
        vi.spyOn(projectRows?.[1] as HTMLElement, "getBoundingClientRect").mockReturnValue(
            createRect(100, 32),
        );

        act(() => {
            handles?.[0]?.dispatchEvent(createPointerEvent("pointerdown", 8));
        });
        act(() => {
            handles?.[0]?.dispatchEvent(createPointerEvent("pointermove", 120));
        });
        expect(
            container?.querySelectorAll(".workspace-navigator-project")[1]
                ?.getAttribute("data-drop-position"),
        ).toBe("after");
        act(() => {
            handles?.[0]?.dispatchEvent(createPointerEvent("pointerup", 120));
        });

        expect(onReorderProjects).toHaveBeenCalledWith([
            "project-b",
            "project-a",
        ]);
    });

    it("keeps every project's workspaces visible", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        mount(<WorkspaceNavigator {...createProps()} />);
        await act(async () => Promise.resolve());

        const projectRow = container?.querySelector<HTMLElement>(
            ".workspace-navigator-project-row",
        );
        act(() => {
            projectRow?.click();
            projectRow?.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
            );
        });

        expect(
            container?.querySelectorAll(".workspace-navigator-workspace-row"),
        ).toHaveLength(2);
        expect(
            projectRow?.getAttribute("aria-expanded"),
        ).toBe("true");
        expect(
            container?.querySelector(".workspace-navigator-project-drag-handle"),
        ).toBeTruthy();
        expect(projectRow?.getAttribute("aria-roledescription")).toBe(
            "draggable project",
        );
        expect(
            container?.querySelector(".workspace-navigator-chevron"),
        ).toBeNull();
    });

    it("renders an accessible tree and supports complete roving keyboard navigation", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const props = createProps();
        mount(<WorkspaceNavigator {...props} />);
        await act(async () => Promise.resolve());

        const tree = container?.querySelector('[role="tree"]');
        const items = container?.querySelectorAll<HTMLElement>('[role="treeitem"]');
        expect(tree).toBeTruthy();
        expect(items).toHaveLength(3);
        expect(items?.[1]?.getAttribute("aria-current")).toBe("page");

        act(() => {
            items?.[0]?.focus();
            items?.[0]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "ArrowRight",
                }),
            );
        });
        expect(document.activeElement).toBe(items?.[1]);

        act(() => {
            items?.[1]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "End",
                }),
            );
        });
        expect(document.activeElement).toBe(items?.[2]);

        act(() => {
            items?.[2]?.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "c",
                }),
            );
        });
        expect(document.activeElement).toBe(items?.[0]);
    });

    it("keeps Delete Worktree absent for the primary workspace and shows a destructive scoped confirmation for worktrees", async () => {
        const showNativeContextMenu = vi
            .fn<(input: NativeContextMenuInput) => Promise<string | null>>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce("delete-worktree");
        vi.stubGlobal("comando", { showNativeContextMenu });
        mount(<WorkspaceNavigator {...createProps()} />);
        await act(async () => Promise.resolve());
        const rows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        );

        await act(async () => {
            rows?.[0]?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: 10,
                    clientY: 20,
                }),
            );
            await Promise.resolve();
        });
        const primaryMenu = showNativeContextMenu.mock.calls[0]?.[0];
        expect(
            primaryMenu?.entries.some(
                (entry) => "id" in entry && entry.id === "delete-worktree",
            ),
        ).toBe(false);

        await act(async () => {
            rows?.[1]?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: 10,
                    clientY: 40,
                }),
            );
            await Promise.resolve();
        });
        expect(document.body.textContent).toContain(
            "all app data saved exclusively for this workspace",
        );
        expect(document.body.textContent).toContain(
            "/projects/comando-feature",
        );
        const destructiveButton = container?.querySelector<HTMLButtonElement>(
            ".workspace-navigator-dialog-actions .danger",
        );
        expect(destructiveButton?.disabled).toBe(false);
    });

    it("copies the full path from project and worktree context menus", async () => {
        const showNativeContextMenu = vi
            .fn<(input: NativeContextMenuInput) => Promise<string | null>>()
            .mockResolvedValueOnce("copy-project-path")
            .mockResolvedValueOnce("copy-path");
        vi.stubGlobal("comando", { showNativeContextMenu });
        const onCopyProjectPath = vi.fn(() => Promise.resolve());
        const onCopyPath = vi.fn(() => Promise.resolve());
        mount(
            <WorkspaceNavigator
                {...createProps({ onCopyPath, onCopyProjectPath })}
            />,
        );
        await act(async () => Promise.resolve());

        const projectRow = container?.querySelector<HTMLElement>(
            ".workspace-navigator-project-row",
        );
        const worktreeRow = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        )[1];

        await act(async () => {
            projectRow?.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true }),
            );
            await Promise.resolve();
        });
        await act(async () => {
            worktreeRow?.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true }),
            );
            await Promise.resolve();
        });

        expect(showNativeContextMenu.mock.calls[0]?.[0].entries).toContainEqual({
            enabled: true,
            id: "copy-project-path",
            label: "Copy Full Path",
        });
        expect(showNativeContextMenu.mock.calls[1]?.[0].entries).toContainEqual({
            enabled: true,
            id: "copy-path",
            label: "Copy Full Path",
        });
        expect(onCopyProjectPath).toHaveBeenCalledWith(
            expect.objectContaining({ rootPath: "/projects/comando" }),
        );
        expect(onCopyPath).toHaveBeenCalledWith(
            expect.objectContaining({ rootPath: "/projects/comando-feature" }),
        );
    });

    it("keeps the committed row active while activation fails and exposes retry copy", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const props = createProps({
            onActivate: vi.fn(() => Promise.reject(new Error("Restore failed"))),
        });
        mount(<WorkspaceNavigator {...props} />);
        await act(async () => Promise.resolve());
        const rows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        );

        await act(async () => {
            rows?.[1]?.click();
            await Promise.resolve();
        });

        expect(rows?.[0]?.getAttribute("aria-current")).toBe("page");
        expect(rows?.[1]?.dataset.status).toBe("error");
        expect(rows?.[1]?.textContent).toContain("Retry");
        expect(rows?.[1]?.getAttribute("aria-label")).toContain("Comando");
    });

    it("tracks workspace activity without rendering an activity badge", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const model = createModel();
        const project = model.projects[0];
        const activeWorkspace = project?.workspaces[0];
        const activityWorkspace = project?.workspaces[1];
        if (!project || !activeWorkspace || !activityWorkspace) {
            throw new Error("Expected workspace fixtures.");
        }
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: {
                        ...model,
                        projects: [
                            {
                                ...project,
                                workspaces: [
                                    activeWorkspace,
                                    {
                                        ...activityWorkspace,
                                        isResident: true,
                                        status: "activity",
                                    },
                                ],
                            },
                        ],
                    },
                })}
            />,
        );
        await act(async () => Promise.resolve());

        const activityRow = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        )[1];
        expect(activityRow?.dataset.status).toBe("activity");
        expect(activityRow?.textContent).not.toContain("Activity");
    });

    it("lets the latest activation win while an earlier activation is pending", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        let rejectFirst: ((cause: Error) => void) | null = null;
        const onActivate = vi
            .fn<WorkspaceNavigatorProps["onActivate"]>()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectFirst = reject;
                    }),
            )
            .mockResolvedValueOnce();
        const model = createModel();
        const extraWorkspace = workspace(
            "project-a::worktree-second",
            "worktree-second",
            "feature/second",
            false,
        );
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: {
                        ...model,
                        projects: [
                            {
                                ...model.projects[0],
                                workspaces: [
                                    ...model.projects[0].workspaces,
                                    extraWorkspace,
                                ],
                            },
                        ],
                    },
                    onActivate,
                })}
            />,
        );
        await act(async () => Promise.resolve());
        const rows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        );

        await act(async () => {
            rows?.[1]?.click();
            await Promise.resolve();
        });
        await act(async () => {
            rows?.[2]?.click();
            await Promise.resolve();
        });
        await act(async () => {
            rejectFirst?.(new Error("Late failure"));
            await Promise.resolve();
        });

        expect(onActivate).toHaveBeenCalledTimes(2);
        expect(rows?.[1]?.dataset.status).not.toBe("error");
    });

    it("exposes missing projects with visible text", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve(null)),
        });
        const model = createModel();
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: {
                        ...model,
                        projects: [{ ...model.projects[0], isMissing: true }],
                    },
                })}
            />,
        );
        await act(async () => Promise.resolve());

        expect(
            container?.querySelector(".workspace-navigator-project-row")
                ?.textContent,
        ).toContain("Missing");
    });

    it("requires explicit confirmation before discarding a pending recovery layout", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() => Promise.resolve("recovery")),
        });
        vi.spyOn(window, "confirm").mockReturnValue(true);
        const model = createModel();
        const project = model.projects[0];
        const target = project?.workspaces[1];
        if (!project || !target) {
            throw new Error("Expected recovery workspace fixture.");
        }
        const recoveryModel: WorkspaceNavigatorModel = {
            ...model,
            projects: [
                {
                    ...project,
                    workspaces: [
                        project.workspaces[0],
                        {
                            ...target,
                            recoveryLayouts: [
                                {
                                    createdAt: "2026-08-01T00:00:00Z",
                                    id: "recovery-a",
                                    scopeKey: target.scopeKey,
                                    snapshotHash: "hash-a",
                                    sourceRevision: 1,
                                    sourceUpdatedAt: "2026-07-31T00:00:00Z",
                                    sourceWindowId: "legacy-window",
                                    sourceWorkspaceId: null,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const onDiscardRecoveryLayout = vi.fn(() => Promise.resolve());
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: recoveryModel,
                    onDiscardRecoveryLayout,
                })}
            />,
        );
        await act(async () => Promise.resolve());
        const rows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        );
        await act(async () => {
            rows?.[1]?.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true }),
            );
            await Promise.resolve();
        });
        const discard = [...(container?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Discard",
        );
        await act(async () => {
            discard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await Promise.resolve();
        });

        expect(window.confirm).toHaveBeenCalled();
        expect(onDiscardRecoveryLayout).toHaveBeenCalledWith(
            expect.objectContaining({ scopeKey: target.scopeKey }),
            "recovery-a",
        );
    });

    it("retries deletion-pending cleanup without running checkout preflight again", async () => {
        vi.stubGlobal("comando", {
            showNativeContextMenu: vi.fn(() =>
                Promise.resolve("delete-worktree"),
            ),
        });
        const model = createModel();
        const pendingWorkspace = model.projects[0]?.workspaces[1];
        if (!pendingWorkspace) {
            throw new Error("Expected secondary workspace fixture.");
        }
        const pendingModel: WorkspaceNavigatorModel = {
            ...model,
            projects: [
                {
                    ...model.projects[0],
                    workspaces: [
                        model.projects[0].workspaces[0],
                        {
                            ...pendingWorkspace,
                            deletionOperation: {
                                checkoutPath: pendingWorkspace.rootPath,
                                errorCode: "post_checkout:interrupted",
                                forceApproved: false,
                                kind: "delete_worktree",
                                operationId: "delete-a",
                                projectId: pendingWorkspace.projectId,
                                scopeKey: pendingWorkspace.scopeKey,
                                sessionIds: [],
                                startedAt: "2026-08-01T00:00:00.000Z",
                                status: "failed",
                                updatedAt: "2026-08-01T00:01:00.000Z",
                                worktreeId: pendingWorkspace.worktreeId,
                            },
                            status: "deletion-pending",
                        },
                    ],
                },
            ],
        };
        const onDeleteWorktree = vi.fn(() => Promise.resolve());
        const onPreflightDeleteWorktree = vi.fn();
        mount(
            <WorkspaceNavigator
                {...createProps({
                    model: pendingModel,
                    onDeleteWorktree,
                    onPreflightDeleteWorktree,
                })}
            />,
        );
        await act(async () => Promise.resolve());
        const rows = container?.querySelectorAll<HTMLElement>(
            ".workspace-navigator-workspace-row",
        );

        await act(async () => {
            rows?.[1]?.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true }),
            );
            await Promise.resolve();
        });

        expect(onDeleteWorktree).toHaveBeenCalledWith(
            expect.objectContaining({ scopeKey: "project-a::worktree-feature" }),
            false,
        );
        expect(onPreflightDeleteWorktree).not.toHaveBeenCalled();
    });
});

function mount(element: React.ReactNode): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(element));
}

function createPointerEvent(type: string, clientY: number): MouseEvent {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientY,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event;
}

function createRect(top: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left: 0,
        right: 200,
        top,
        width: 200,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

function createProps(
    overrides: Partial<WorkspaceNavigatorProps> = {},
): WorkspaceNavigatorProps {
    return {
        error: null,
        model: createModel(),
        onActivate: vi.fn(() => Promise.resolve()),
        onCloneRepository: vi.fn(() => Promise.resolve()),
        onCloseWorkspace: vi.fn(() => Promise.resolve()),
        onCopyProjectPath: vi.fn(() => Promise.resolve()),
        onCopyPath: vi.fn(() => Promise.resolve()),
        onCreateWorktree: vi.fn(() => Promise.resolve()),
        onDeleteWorktree: vi.fn(() => Promise.resolve()),
        onPreflightDeleteWorktree: vi.fn(() =>
            Promise.resolve({
                blockers: [],
                inventory: {
                    chatSessionCount: 0,
                    checkoutPath: "/projects/comando-feature",
                    recoveryLayoutCount: 0,
                    runtimeCount: 0,
                    workspaceLayoutCount: 1,
                },
                requiresForce: false,
                warnings: [],
            }),
        ),
        onApplyRecoveryLayout: vi.fn(() => Promise.resolve()),
        onDiscardRecoveryLayout: vi.fn(() => Promise.resolve()),
        onReassociateWorkspace: vi.fn(() => Promise.resolve()),
        onRemoveSavedWorkspace: vi.fn(() => Promise.resolve()),
        onOpenFolder: vi.fn(() => Promise.resolve()),
        onOpenSettings: vi.fn(),
        onRemoveProject: vi.fn(() => Promise.resolve()),
        onReorderProjects: vi.fn(),
        onResetWorkspace: vi.fn(() => Promise.resolve()),
        onRetry: vi.fn(() => Promise.resolve()),
        onRetryInventory: vi.fn(() => Promise.resolve()),
        onRevealPath: vi.fn(() => Promise.resolve()),
        settingsLabel: null,
        status: "ready",
        ...overrides,
    };
}

function createModel(): WorkspaceNavigatorModel {
    return {
        activeScopeKey: "project-a::__primary__",
        projects: [
            {
                id: "project-a",
                inventoryError: null,
                inventoryLoading: false,
                isMissing: false,
                name: "Comando",
                rootPath: "/projects/comando",
                workspaces: [
                    workspace("project-a::__primary__", null, "main", true),
                    workspace(
                        "project-a::worktree-feature",
                        "worktree-feature",
                        "feature/navigation",
                        false,
                    ),
                ],
            },
        ],
        workspaceCount: 2,
    };
}

function workspace(
    scopeKey: string,
    worktreeId: string | null,
    label: string,
    active: boolean,
) {
    return {
        catalogEntry: {
            lastActivatedAt: null,
            lifecycle: "active" as const,
            projectId: "project-a",
            revision: 2,
            runtimeOwnerId: `owner:${scopeKey}`,
            scopeKey,
            source: "durable" as const,
            worktreeId,
        },
        deletionOperation: null,
        isMissing: false,
        isPrimary: worktreeId === null,
        isResident: active,
        label,
        projectId: "project-a",
        recoveryLayouts: [],
        rootPath: worktreeId
            ? "/projects/comando-feature"
            : "/projects/comando",
        scopeKey,
        status: active ? ("active" as const) : ("available" as const),
        statusMessage: null,
        worktreeId,
    };
}
