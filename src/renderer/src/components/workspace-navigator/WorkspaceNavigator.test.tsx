/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeContextMenuInput } from "@shared/ipc";

import type { WorkspaceNavigatorModel } from "@renderer/app/workspace-navigator/model";
import { WorkspaceNavigator, type WorkspaceNavigatorProps } from "./WorkspaceNavigator";

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

    it("keeps Delete Worktree absent for Primary and shows a destructive scoped confirmation for worktrees", async () => {
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

function createProps(
    overrides: Partial<WorkspaceNavigatorProps> = {},
): WorkspaceNavigatorProps {
    return {
        error: null,
        expandedProjectIds: ["project-a"],
        model: createModel(),
        onActivate: vi.fn(() => Promise.resolve()),
        onCloneRepository: vi.fn(() => Promise.resolve()),
        onCloseWorkspace: vi.fn(() => Promise.resolve()),
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
        onResetWorkspace: vi.fn(() => Promise.resolve()),
        onRetry: vi.fn(() => Promise.resolve()),
        onRetryInventory: vi.fn(() => Promise.resolve()),
        onRevealPath: vi.fn(() => Promise.resolve()),
        onSetProjectExpanded: vi.fn(),
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
                    workspace("project-a::__primary__", null, "Primary", true),
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
