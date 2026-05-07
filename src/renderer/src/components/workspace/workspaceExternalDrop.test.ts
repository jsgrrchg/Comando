import { describe, expect, it, vi } from "vitest";

import {
    COMPOSER_PROJECT_ENTRY_LIST_MIME,
    serializeComposerProjectEntryListDragData,
} from "@renderer/app/drag-and-drop";

import type { WorkspacePaneDropTarget } from "./workspaceDropTargets";
import {
    createWorkspaceDropTargetPreviewScheduler,
    getWorkspacePaneFileDropEntries,
    resolveWorkspacePaneFileDragOverIntent,
} from "./workspaceExternalDrop";

const paneTarget: WorkspacePaneDropTarget = {
    paneId: "pane-1",
    rect: {
        bottom: 320,
        height: 300,
        left: 20,
        right: 420,
        top: 20,
        width: 400,
    },
    type: "pane-center",
};

describe("workspaceExternalDrop", () => {
    it("previews internal project file payloads", () => {
        const dataTransfer = createDataTransfer({
            data: {
                [COMPOSER_PROJECT_ENTRY_LIST_MIME]:
                    serializeComposerProjectEntryListDragData({
                        entries: [
                            {
                                kind: "file",
                                name: "app.ts",
                                relativePath: "src/app.ts",
                            },
                            {
                                kind: "directory",
                                name: "docs",
                                relativePath: "docs",
                            },
                        ],
                    }),
            },
            types: [COMPOSER_PROJECT_ENTRY_LIST_MIME],
        });

        expect(
            resolveWorkspacePaneFileDragOverIntent({
                dataTransfer,
                projectRootPath: null,
                target: paneTarget,
            }),
        ).toEqual({
            acceptsDrop: true,
            previewTarget: paneTarget,
        });
        expect(
            getWorkspacePaneFileDropEntries({
                dataTransfer,
                projectRootPath: null,
            }),
        ).toEqual([
            {
                kind: "file",
                name: "app.ts",
                relativePath: "src/app.ts",
            },
        ]);
    });

    it("previews native files inside the active root", () => {
        const dataTransfer = createNativeFileDataTransfer(
            "/Users/jfg/project/src/app.ts",
            "text/typescript",
        );

        expect(
            resolveWorkspacePaneFileDragOverIntent({
                dataTransfer,
                projectRootPath: "/Users/jfg/project",
                target: paneTarget,
            }),
        ).toEqual({
            acceptsDrop: true,
            previewTarget: paneTarget,
        });
        expect(
            getWorkspacePaneFileDropEntries({
                dataTransfer,
                projectRootPath: "/Users/jfg/project",
            }),
        ).toEqual([
            {
                kind: "file",
                name: "app.ts",
                relativePath: "src/app.ts",
            },
        ]);
    });

    it("accepts but does not preview native files outside the active root", () => {
        const dataTransfer = createNativeFileDataTransfer(
            "/Users/jfg/Downloads/outside.ts",
            "text/typescript",
        );

        expect(
            resolveWorkspacePaneFileDragOverIntent({
                dataTransfer,
                projectRootPath: "/Users/jfg/project",
                target: paneTarget,
            }),
        ).toEqual({
            acceptsDrop: true,
            previewTarget: null,
        });
        expect(
            getWorkspacePaneFileDropEntries({
                dataTransfer,
                projectRootPath: "/Users/jfg/project",
            }),
        ).toEqual([]);
    });

    it("clears preview intent when a drag is over a workspace gap", () => {
        const dataTransfer = createNativeFileDataTransfer(
            "/Users/jfg/project/src/app.ts",
            "text/typescript",
        );

        expect(
            resolveWorkspacePaneFileDragOverIntent({
                dataTransfer,
                projectRootPath: "/Users/jfg/project",
                target: null,
            }),
        ).toEqual({
            acceptsDrop: false,
            previewTarget: null,
        });
    });

    it("keeps valid targets immediate but defers clears by one frame", () => {
        const frames = createFrameHarness();
        const applied: Array<WorkspacePaneDropTarget | null> = [];
        const scheduler =
            createWorkspaceDropTargetPreviewScheduler<WorkspacePaneDropTarget>({
                applyTarget: (target) => applied.push(target),
                cancelFrame: frames.cancelFrame,
                requestFrame: frames.requestFrame,
            });

        scheduler.schedule(paneTarget);
        scheduler.schedule(null);

        expect(applied).toEqual([paneTarget]);
        expect(frames.pendingCount()).toBe(1);

        frames.flushAll();

        expect(applied).toEqual([paneTarget, null]);
    });

    it("cancels a pending clear when a new valid target arrives", () => {
        const frames = createFrameHarness();
        const nextTarget: WorkspacePaneDropTarget = {
            direction: "right",
            paneId: "pane-2",
            rect: paneTarget.rect,
            type: "split",
        };
        const applied: Array<WorkspacePaneDropTarget | null> = [];
        const scheduler =
            createWorkspaceDropTargetPreviewScheduler<WorkspacePaneDropTarget>({
                applyTarget: (target) => applied.push(target),
                cancelFrame: frames.cancelFrame,
                requestFrame: frames.requestFrame,
            });

        scheduler.schedule(paneTarget);
        scheduler.schedule(null);
        scheduler.schedule(nextTarget);
        frames.flushAll();

        expect(applied).toEqual([paneTarget, nextTarget]);
    });
});

function createDataTransfer(input: {
    readonly data?: Record<string, string>;
    readonly files?: readonly File[];
    readonly items?: readonly Partial<DataTransferItem>[];
    readonly types?: readonly string[];
}): DataTransfer {
    return {
        files: input.files ?? [],
        getData: vi.fn((type: string) => input.data?.[type] ?? ""),
        items: input.items ?? [],
        types: input.types ?? [],
    } as unknown as DataTransfer;
}

function createNativeFileDataTransfer(path: string, type: string): DataTransfer {
    const file = {
        path,
        size: 42,
        type,
    } as unknown as File;

    return createDataTransfer({
        files: [file],
        items: [
            {
                getAsFile: () => file,
                kind: "file",
            },
        ],
        types: ["Files"],
    });
}

function createFrameHarness() {
    let nextFrameId = 1;
    const frames = new Map<number, () => void>();

    return {
        cancelFrame: (frameId: number) => {
            frames.delete(frameId);
        },
        flushAll: () => {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach((callback) => callback());
        },
        pendingCount: () => frames.size,
        requestFrame: (callback: () => void) => {
            const frameId = nextFrameId;
            nextFrameId += 1;
            frames.set(frameId, callback);
            return frameId;
        },
    };
}
