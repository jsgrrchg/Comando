import { describe, expect, it, vi } from "vitest";

import type {
    PersistedWorkspaceContext,
    WindowContextSnapshot,
    WorkspaceNavigationSnapshot,
} from "@shared/ipc";
import { createWindowWorkspaceRestoreRecord } from "@shared/workspace-restore";

import type { WorkspaceGateway } from "./service";
import { moveWorkspaceBetweenWindows } from "./move-coordinator";
import type { WorkspaceSurfaceManager } from "./surface-manager";

type TransferSurfaceInput = Parameters<
    WorkspaceSurfaceManager["transferSurface"]
>[0];

describe("moveWorkspaceBetweenWindows", () => {
    it("moves a primary scope beside distinct worktrees without recreating it", async () => {
        const primary = createContext("project-a::__primary__", null);
        const worktreeOne = createContext("project-a::worktree-1", "worktree-1");
        const worktreeTwo = createContext("project-a::worktree-2", "worktree-2");
        const sourceSnapshot = createSnapshot(primary.key, [primary, worktreeOne]);
        const targetSnapshot = createSnapshot(worktreeTwo.key, [worktreeTwo]);
        const committedSource = createSnapshot(worktreeOne.key, [worktreeOne]);
        const committedTarget = createSnapshot(primary.key, [worktreeTwo, primary]);
        const transferContext = vi.fn(() =>
            Promise.resolve({
                source: createWindowWorkspaceRestoreRecord(committedSource, 4),
                target: createWindowWorkspaceRestoreRecord(committedTarget, 7),
            }),
        );
        const saveSnapshot = vi.fn(() => Promise.resolve());
        const flushHost = vi.fn(() => Promise.resolve());
        const onTransferred = vi.fn();
        const transferSurface = vi.fn(async (input: TransferSurfaceInput) => {
            const committed = await input.commit();
            const transfer = {
                sourceSnapshot: committed.source.snapshot,
                surfaceId: "surface-primary",
                targetSnapshot: committed.target.snapshot,
            };
            input.onCommitted?.(transfer);
            return transfer;
        });

        await moveWorkspaceBetweenWindows(
            "window-1",
            {
                contextKey: primary.key,
                projectId: "project-a",
                targetWindowId: "window-2",
                worktreeId: null,
            },
            {
                captureContext: vi.fn(() => Promise.resolve(sourceSnapshot)),
                createEmptyTarget: vi.fn(),
                flushHost,
                getWindowContext: (windowId) => createWindowContext(windowId),
                isWindowAvailable: () => true,
                manager: {
                    getHostSnapshotForWindow: (windowId) =>
                        windowId === "window-1" ? sourceSnapshot : targetSnapshot,
                    listOpenWorkspaceLocations: () => [
                        {
                            contextKey: primary.key,
                            hostWindowId: "window-1",
                            isActive: true,
                            lastActivatedAt: primary.lastActivatedAt,
                            projectId: primary.projectId,
                            worktreeId: primary.worktreeId,
                        },
                    ],
                    transferSurface,
                },
                onTransferred,
                workspaceService: createWorkspaceService({
                    saveSnapshot,
                    sourceSnapshot,
                    targetSnapshot,
                    transferContext,
                }),
            },
        );

        expect(flushHost).toHaveBeenCalledWith("window-1");
        expect(flushHost).toHaveBeenCalledWith("window-2");
        expect(transferSurface).toHaveBeenCalledWith(
            expect.objectContaining({
                contextKey: primary.key,
                sourceHostWindowId: "window-1",
                targetHostWindowId: "window-2",
            }),
        );
        expect(transferContext).toHaveBeenCalledWith(
            expect.objectContaining({
                contextKey: primary.key,
                sourceWorkspaceId: "workspace-window-1",
                targetWorkspaceId: "workspace-window-2",
            }),
        );
        expect(onTransferred).toHaveBeenCalledWith(
            "window-1",
            "window-2",
            expect.objectContaining({ surfaceId: "surface-primary" }),
        );
    });

    it("creates an empty target and does not flush its renderer before moving", async () => {
        const primary = createContext("project-a::__primary__", null);
        const sourceSnapshot = createSnapshot(primary.key, [primary]);
        const emptySnapshot = createSnapshot(null, []);
        const flushHost = vi.fn(() => Promise.resolve());
        const targetContext = createWindowContext("window-new");
        const transferSurface = vi.fn(async (input: TransferSurfaceInput) => {
            const committed = await input.commit();
            const transfer = {
                sourceSnapshot: committed.source.snapshot,
                surfaceId: "surface-primary",
                targetSnapshot: committed.target.snapshot,
            };
            input.onCommitted?.(transfer);
            return transfer;
        });

        await moveWorkspaceBetweenWindows(
            "window-1",
            {
                contextKey: primary.key,
                projectId: primary.projectId,
                targetWindowId: null,
                worktreeId: null,
            },
            {
                captureContext: vi.fn(() => Promise.resolve(sourceSnapshot)),
                createEmptyTarget: vi.fn(() => Promise.resolve(targetContext)),
                flushHost,
                getWindowContext: (windowId) => createWindowContext(windowId),
                isWindowAvailable: () => true,
                manager: {
                    getHostSnapshotForWindow: (windowId) =>
                        windowId === "window-new" ? emptySnapshot : sourceSnapshot,
                    listOpenWorkspaceLocations: () => [
                        {
                            contextKey: primary.key,
                            hostWindowId: "window-1",
                            isActive: true,
                            lastActivatedAt: primary.lastActivatedAt,
                            projectId: primary.projectId,
                            worktreeId: null,
                        },
                    ],
                    transferSurface,
                },
                onTransferred: vi.fn(),
                workspaceService: createWorkspaceService({
                    saveSnapshot: vi.fn(() => Promise.resolve()),
                    sourceSnapshot,
                    targetSnapshot: emptySnapshot,
                    transferContext: vi.fn(() =>
                        Promise.resolve({
                            source: createWindowWorkspaceRestoreRecord(
                                emptySnapshot,
                                2,
                            ),
                            target: createWindowWorkspaceRestoreRecord(
                                sourceSnapshot,
                                2,
                            ),
                        }),
                    ),
                }),
            },
        );

        expect(flushHost).toHaveBeenCalledTimes(1);
        expect(flushHost).toHaveBeenCalledWith("window-1");
        expect(transferSurface).toHaveBeenCalledWith(
            expect.objectContaining({ targetHostWindowId: "window-new" }),
        );
    });

    it("allows a target that only retains a closed equivalent context", async () => {
        const primary = createContext("project-a::__primary__", null);
        const other = {
            ...createContext("project-b::__primary__", null),
            projectId: "project-b",
        };
        const sourceSnapshot = createSnapshot(primary.key, [primary]);
        const targetSnapshot = createSnapshot(
            other.key,
            [other, primary],
            [other.key],
        );
        const committedSource = createSnapshot(null, []);
        const committedTarget = createSnapshot(primary.key, [other, primary]);
        const transferSurface = vi.fn(async (input: TransferSurfaceInput) => {
            const committed = await input.commit();
            const transfer = {
                sourceSnapshot: committed.source.snapshot,
                surfaceId: "surface-primary",
                targetSnapshot: committed.target.snapshot,
            };
            input.onCommitted?.(transfer);
            return transfer;
        });

        await moveWorkspaceBetweenWindows(
            "window-1",
            {
                contextKey: primary.key,
                projectId: primary.projectId,
                targetWindowId: "window-2",
                worktreeId: null,
            },
            {
                captureContext: vi.fn(() => Promise.resolve(sourceSnapshot)),
                createEmptyTarget: vi.fn(),
                flushHost: vi.fn(() => Promise.resolve()),
                getWindowContext: (windowId) => createWindowContext(windowId),
                isWindowAvailable: () => true,
                manager: {
                    getHostSnapshotForWindow: (windowId) =>
                        windowId === "window-1" ? sourceSnapshot : targetSnapshot,
                    listOpenWorkspaceLocations: () => [
                        {
                            contextKey: primary.key,
                            hostWindowId: "window-1",
                            isActive: true,
                            lastActivatedAt: primary.lastActivatedAt,
                            projectId: primary.projectId,
                            worktreeId: null,
                        },
                    ],
                    transferSurface,
                },
                onTransferred: vi.fn(),
                workspaceService: createWorkspaceService({
                    saveSnapshot: vi.fn(() => Promise.resolve()),
                    sourceSnapshot,
                    targetSnapshot,
                    transferContext: vi.fn(() =>
                        Promise.resolve({
                            source: createWindowWorkspaceRestoreRecord(
                                committedSource,
                                4,
                            ),
                            target: createWindowWorkspaceRestoreRecord(
                                committedTarget,
                                7,
                            ),
                        }),
                    ),
                }),
            },
        );

        expect(transferSurface).toHaveBeenCalledWith(
            expect.objectContaining({
                contextKey: primary.key,
                targetHostWindowId: "window-2",
            }),
        );
    });

    it("leaves the source untouched when a selected target has closed", async () => {
        const primary = createContext("project-a::__primary__", null);
        const sourceSnapshot = createSnapshot(primary.key, [primary]);
        const transferSurface = vi.fn();
        const saveSnapshot = vi.fn();

        await expect(
            moveWorkspaceBetweenWindows(
                "window-1",
                {
                    contextKey: primary.key,
                    projectId: primary.projectId,
                    targetWindowId: "window-closed",
                    worktreeId: null,
                },
                {
                    captureContext: vi.fn(),
                    createEmptyTarget: vi.fn(),
                    flushHost: vi.fn(),
                    getWindowContext: (windowId) => createWindowContext(windowId),
                    isWindowAvailable: (windowId) =>
                        windowId !== "window-closed",
                    manager: {
                        getHostSnapshotForWindow: () => sourceSnapshot,
                        listOpenWorkspaceLocations: () => [
                            {
                                contextKey: primary.key,
                                hostWindowId: "window-1",
                                isActive: true,
                                lastActivatedAt: primary.lastActivatedAt,
                                projectId: primary.projectId,
                                worktreeId: null,
                            },
                        ],
                        transferSurface,
                    },
                    onTransferred: vi.fn(),
                    workspaceService: createWorkspaceService({
                        saveSnapshot,
                        sourceSnapshot,
                        targetSnapshot: sourceSnapshot,
                        transferContext: vi.fn(),
                    }),
                },
            ),
        ).rejects.toThrow("destination window is no longer available");

        expect(saveSnapshot).not.toHaveBeenCalled();
        expect(transferSurface).not.toHaveBeenCalled();
    });
});

function createWorkspaceService(input: {
    readonly saveSnapshot: WorkspaceGateway["saveSnapshot"];
    readonly sourceSnapshot: WorkspaceNavigationSnapshot;
    readonly targetSnapshot: WorkspaceNavigationSnapshot;
    readonly transferContext: WorkspaceGateway["transferContext"];
}): WorkspaceGateway {
    return {
        loadChatSessionState: vi.fn(() => Promise.resolve(null)),
        loadSnapshot: vi.fn((workspaceId: string) =>
            Promise.resolve(
                createWindowWorkspaceRestoreRecord(
                    workspaceId === "workspace-window-1"
                        ? input.sourceSnapshot
                        : input.targetSnapshot,
                    workspaceId === "workspace-window-1" ? 3 : 6,
                ),
            ),
        ),
        saveSnapshot: input.saveSnapshot,
        transferContext: input.transferContext,
    };
}

function createWindowContext(windowId: string): WindowContextSnapshot {
    return {
        projectId: null,
        windowId,
        windowKind: "main",
        workspaceId: `workspace-${windowId}`,
        workspaceSessionId: `session-${windowId}`,
        worktreeId: null,
    };
}

function createContext(
    key: string,
    worktreeId: string | null,
): PersistedWorkspaceContext {
    return {
        key,
        lastActivatedAt: "2026-07-22T12:00:00.000Z",
        projectId: "project-a",
        workspace: {
            activePaneId: `pane-${key}`,
            rootNode: {
                activeTabId: null,
                id: `pane-${key}`,
                tabIds: [],
                type: "pane",
            },
            tabs: [],
        },
        worktreeId,
    };
}

function createSnapshot(
    activeContextKey: string | null,
    contexts: readonly PersistedWorkspaceContext[],
    openContextKeys = contexts.map((context) => context.key),
): WorkspaceNavigationSnapshot {
    return {
        activeContextKey,
        contexts,
        openContextKeys,
        version: 3,
    };
}
