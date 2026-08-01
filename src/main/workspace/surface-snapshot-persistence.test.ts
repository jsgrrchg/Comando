import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

import { IPC_EVENTS } from "@shared/ipc";
import type { WorkspaceNavigationSnapshot } from "@shared/ipc";

import {
    activateWorkspaceSurfaceAndNotifyHost,
    persistWorkspaceSurfaceSnapshot,
} from "./surface-snapshot-persistence";

describe("activateWorkspaceSurfaceAndNotifyHost", () => {
    it("publishes the authoritative snapshot produced by main activation", async () => {
        const contextB = "project-b::__primary__";
        const snapshotB = createSnapshot(contextB);
        const send = vi.fn();
        let activeSnapshot = createSnapshot("project-a::__primary__");
        const manager = {
            activate: vi.fn((_hostWindowId: string, contextKey: string) => {
                activeSnapshot = createSnapshot(contextKey);
                return Promise.resolve({
                    generation: `surface:${contextKey}`,
                    scopeKey: contextKey,
                    status: "activated" as const,
                    warm: true,
                });
            }),
            getHostSnapshotForWindow: vi.fn(() => activeSnapshot),
            getHostWebContents: vi.fn(() => ({ send })),
        };

        await expect(
            activateWorkspaceSurfaceAndNotifyHost({
                contextKey: contextB,
                hostWindowId: "host-1",
                manager,
            }),
        ).resolves.toMatchObject({ status: "activated" });
        expect(send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
            snapshotB,
        );
    });
});

describe("persistWorkspaceSurfaceSnapshot", () => {
    it("does not republish a stale active context after navigation wins the race", async () => {
        const contextA = "project-a::__primary__";
        const contextB = "project-b::__primary__";
        const snapshotA = createSnapshot(contextA);
        const snapshotB = createSnapshot(contextB);
        const saveGate = createDeferred<void>();
        const send = vi.fn();
        let currentHostSnapshot = snapshotA;
        const manager = {
            activate: vi.fn((contextKey: string) => {
                currentHostSnapshot = createSnapshot(contextKey);
            }),
            getHostSnapshotForWindow: vi.fn(() => currentHostSnapshot),
            getHostWebContents: vi.fn(() => ({ send })),
            mergeSurfaceSnapshot: vi.fn(() => ({
                hostWindowId: "host-1",
                snapshot: snapshotA,
            })),
        };
        const saveSnapshot = vi.fn(() => saveGate.promise);

        const persistence = persistWorkspaceSurfaceSnapshot({
            manager,
            saveSnapshot,
            sender: {} as WebContents,
            snapshot: snapshotA,
            workspaceId: "workspace-1",
        });
        await vi.waitFor(() => expect(saveSnapshot).toHaveBeenCalledOnce());

        // Navigation can advance while durable persistence is still pending.
        manager.activate(contextB);
        saveGate.resolve();
        await persistence;

        expect(send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
            snapshotB,
        );
    });

    it("publishes the merged snapshot when navigation does not advance", async () => {
        const snapshot = createSnapshot("project-a::__primary__");
        const send = vi.fn();

        await persistWorkspaceSurfaceSnapshot({
            manager: {
                getHostSnapshotForWindow: vi.fn(() => snapshot),
                getHostWebContents: vi.fn(() => ({ send })),
                mergeSurfaceSnapshot: vi.fn(() => ({
                    hostWindowId: "host-1",
                    snapshot,
                })),
            },
            saveSnapshot: vi.fn(() => Promise.resolve()),
            sender: {} as WebContents,
            snapshot,
            workspaceId: "workspace-1",
        });

        expect(send).toHaveBeenCalledWith(
            IPC_EVENTS.workspaceSurfaceSnapshotUpdated,
            snapshot,
        );
    });
});

function createSnapshot(activeContextKey: string): WorkspaceNavigationSnapshot {
    const contextKeys = ["project-a::__primary__", "project-b::__primary__"];
    return {
        activeContextKey,
        contexts: contextKeys.map((key) => ({
            key,
            lastActivatedAt: "2026-07-20T00:00:00.000Z",
            projectId: key.startsWith("project-a") ? "project-a" : "project-b",
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
            worktreeId: null,
        })),
        openContextKeys: contextKeys,
        version: 3,
    };
}

function createDeferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}
