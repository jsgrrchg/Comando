import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PersistenceSnapshot } from "@shared/ipc";

import { prepareLegacyWorkspaceMigration } from "./migration";

describe("prepareLegacyWorkspaceMigration", () => {
    it("normalizes v1 fallback and v2 primary identities", async () => {
        const v1 = fixture("legacy-v1-layout.json");
        const v2 = fixture("legacy-v2-navigation.json");
        const records = [
            windowRecord("window-v1", "workspace-v1", "project-v1", null),
            {
                ...windowRecord(
                    "window-v2",
                    "workspace-v2",
                    "project-v2",
                    "project-v2:primary",
                ),
                workspaceRestore: {
                    revision: 2,
                    schemaVersion: 1 as const,
                    snapshot: v2,
                    updatedAt: "2026-02-11T10:00:00.000Z",
                },
            },
        ];
        const loadFallbackLayout = vi.fn((workspaceId: string) =>
            Promise.resolve(workspaceId === "workspace-v1" ? v1 : null),
        );

        const result = await prepareLegacyWorkspaceMigration({
            applicationVersion: "0.2.1",
            loadFallbackLayout,
            records,
        });

        expect(loadFallbackLayout).toHaveBeenCalledWith("workspace-v1");
        expect(result.windows[0]?.contexts[0]).toMatchObject({
            scopeKey: "project-v1::__primary__",
            worktreeId: null,
        });
        expect(result.windows[0]?.contexts[0]?.layoutSnapshot.tabs).toContainEqual(
            expect.objectContaining({
                draft: "preserve v1 draft byte-for-byte",
                sessionId: "session-v1",
            }),
        );
        expect(result.windows[1]?.contexts[0]).toMatchObject({
            scopeKey: "project-v2::__primary__",
            worktreeId: null,
        });
    });

    it("flattens every open and closed v3 window context", async () => {
        const source = fixture<LegacyMultiwindowFixture>(
            "legacy-v3-multiwindow.json",
        );
        const records = source.windows.map((window) => ({
            ...windowRecord(
                window.windowId,
                `workspace-${window.windowId}`,
                null,
                null,
            ),
            isOpen: window.isOpen,
            workspaceRestore: window.restore,
        }));

        const result = await prepareLegacyWorkspaceMigration({
            applicationVersion: "0.2.1",
            loadFallbackLayout: () => Promise.resolve(null),
            records,
        });

        expect(
            result.windows.reduce(
                (total, window) => total + window.contexts.length,
                0,
            ),
        ).toBe(source.expected.normalizedContextCount);
        expect(result.normalizationDroppedContextCount).toBe(
            source.expected.droppedContextCount,
        );
        const tabs = result.windows.flatMap((window) =>
            window.contexts.flatMap((context) => context.layoutSnapshot.tabs),
        );
        expect(tabs).toContainEqual(
            expect.objectContaining({ sessionId: "session-alpha-stream" }),
        );
    });
});

const FIXTURE_ROOT = path.join(
    process.cwd(),
    "fixtures",
    "workspace-migration",
);

interface LegacyMultiwindowFixture {
    readonly expected: {
        readonly droppedContextCount: number;
        readonly normalizedContextCount: number;
    };
    readonly windows: readonly {
        readonly isOpen: boolean;
        readonly restore: {
            readonly revision: number;
            readonly schemaVersion: 1;
            readonly snapshot: never;
            readonly updatedAt: string;
        };
        readonly windowId: string;
    }[];
}

function fixture<T = never>(fileName: string): T {
    return JSON.parse(
        readFileSync(path.join(FIXTURE_ROOT, fileName), "utf8"),
    ) as T;
}

function windowRecord(
    windowId: string,
    workspaceId: string,
    projectId: string | null,
    worktreeId: string | null,
) {
    return {
        isOpen: true,
        lastOpenedAt: "2026-07-30T00:00:00.000Z",
        snapshot: {
            activeProjectId: projectId,
            activeWorktreeId: worktreeId,
            shellState: null,
            windowContext: {
                projectId,
                windowId,
                windowKind: "main" as const,
                workspaceId,
                workspaceSessionId: `session-${windowId}`,
                worktreeId,
            },
            windowState: {
                height: 900,
                id: windowId,
                isFullScreen: false,
                isMaximized: false,
                width: 1400,
                x: null,
                y: null,
            },
        } satisfies PersistenceSnapshot,
    };
}
