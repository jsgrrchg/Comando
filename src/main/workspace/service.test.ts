import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { WorkspaceService } from "./service";

describe("WorkspaceService", () => {
    it("persists and reloads events and minimal artifacts for a chat session", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-a";

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "chat-tab-1",
                id: "pane-root",
                tabIds: ["chat-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-04-12T00:00:00.000Z",
                    draft: "I need to review this change",
                    id: "chat-tab-1",
                    kind: "chat",
                    projectId: null,
                    runtimeId: "codex",
                    sessionId: "chat-session-1",
                    title: "Session 1",
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        const chatSessionState = service.loadChatSessionState("chat-session-1");

        expect(chatSessionState).not.toBeNull();
        expect(chatSessionState).toMatchObject({
            draft: "I need to review this change",
            events: [
                {
                    eventType: "session.created",
                    sequence: 1,
                    sessionId: "chat-session-1",
                },
            ],
            messageCount: 0,
            projectId: null,
            reviewArtifacts: [
                {
                    artifactType: "transcript-skeleton",
                    sessionId: "chat-session-1",
                    title: "Transcript skeleton",
                },
            ],
            sessionId: "chat-session-1",
            title: "Session 1",
        });
        expect(chatSessionState?.updatedAt).toEqual(expect.any(String));
    });

    it("tolerates corrupt layout and tabs when restoring a specific workspace", () => {
        const connection = createTestConnection();
        connection
            .prepare(
                `
                INSERT INTO workspace_layouts (
                    id,
                    root_node_json,
                    active_pane_id,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                `,
            )
            .run(
                "workspace-corrupt",
                "{broken json",
                "pane-corrupt",
                "2026-04-12T00:00:00.000Z",
                "2026-04-12T00:00:00.000Z",
            );
        connection
            .prepare(
                `
                INSERT INTO workspace_tabs (
                    id,
                    workspace_id,
                    kind,
                    title,
                    payload_json,
                    created_at,
                    position
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                `,
            )
            .run(
                "tab-corrupt",
                "workspace-corrupt",
                "chat",
                "Broken tab",
                "{broken json",
                "2026-04-12T00:00:00.000Z",
                0,
            );

        const service = new WorkspaceService(connection);

        expect(service.loadSnapshot("workspace-corrupt")).toEqual({
            activePaneId: "pane-corrupt",
            rootNode: {
                activeTabId: null,
                id: "pane-root",
                tabIds: [],
                type: "pane",
            },
            tabs: [],
        });
    });

    it("persists and reloads workspace git tabs", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-git";

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "git-tab-1",
                id: "pane-root",
                tabIds: ["git-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "git-tab-1",
                    kind: "git",
                    projectId: "project-1",
                    title: "Git",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        expect(service.loadSnapshot(workspaceId)).toEqual(snapshot);
    });

    it("migrates legacy terminal tabs to a stable terminal id", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-terminal";

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "terminal-tab-1",
                id: "pane-root",
                tabIds: ["terminal-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-05-31T00:00:00.000Z",
                    id: "terminal-tab-1",
                    kind: "terminal",
                    projectId: "project-1",
                    sessionId: "legacy-terminal-session",
                    title: "Terminal 1",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        expect(service.loadSnapshot(workspaceId).tabs[0]).toMatchObject({
            kind: "terminal",
            sessionId: "legacy-terminal-session",
            terminalId: "legacy-terminal-session",
        });
    });

    it("normalizes legacy project diff tab titles on reload", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-git-worktree-diff";

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "git-worktree-diff-tab-1",
                id: "pane-root",
                tabIds: ["git-worktree-diff-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-05-17T00:00:00.000Z",
                    id: "git-worktree-diff-tab-1",
                    kind: "git_worktree_diff",
                    projectId: "project-1",
                    title: "Project Diff",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        expect(service.loadSnapshot(workspaceId).tabs[0]).toMatchObject({
            kind: "git_worktree_diff",
            title: "Uncommitted Changes",
        });
    });

    it("persists and reloads commit detail tabs in the workspace", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-git-commit";

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "git-commit-tab-1",
                id: "pane-root",
                tabIds: ["git-commit-tab-1"],
                type: "pane",
            },
            tabs: [
                {
                    commitSha: "a614135c2b2a7d8093f9f4e16a3f698e8041a123",
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "git-commit-tab-1",
                    kind: "git_commit",
                    projectId: "project-1",
                    title: "a614135 · Fix sidebar draft",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        expect(service.loadSnapshot(workspaceId)).toEqual(snapshot);
    });

    it("persists and reloads GitHub workspace tabs", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-github";
        const ref = {
            host: "github.com",
            owner: "octocat",
            repo: "hello-world",
        };

        const snapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "github-pr-tab-1",
                id: "pane-root",
                tabIds: [
                    "github-issues-tab-1",
                    "github-issue-tab-1",
                    "github-prs-tab-1",
                    "github-pr-tab-1",
                ],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-05-07T00:01:00.000Z",
                    id: "github-issues-tab-1",
                    kind: "github_issues",
                    projectId: "project-1",
                    ref,
                    title: "Issues",
                    worktreeId: null,
                },
                {
                    createdAt: "2026-05-07T00:02:00.000Z",
                    id: "github-issue-tab-1",
                    issueNumber: 123,
                    kind: "github_issue",
                    projectId: "project-1",
                    ref,
                    title: "#123",
                    worktreeId: null,
                },
                {
                    createdAt: "2026-05-07T00:03:00.000Z",
                    id: "github-prs-tab-1",
                    kind: "github_pull_requests",
                    projectId: "project-1",
                    ref,
                    title: "Pull Requests",
                    worktreeId: null,
                },
                {
                    createdAt: "2026-05-07T00:04:00.000Z",
                    id: "github-pr-tab-1",
                    kind: "github_pull_request",
                    projectId: "project-1",
                    pullRequestNumber: 456,
                    ref,
                    title: "PR #456",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, snapshot);

        expect(service.loadSnapshot(workspaceId)).toEqual(snapshot);
    });

    it("updates only the rows that changed when saving the same workspace again", () => {
        const connection = createTestConnection();
        const service = new WorkspaceService(connection);
        const workspaceId = "workspace-diff";

        const firstSnapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1", "file-tab-2"],
                type: "pane",
            },
            tabs: [
                {
                    createdAt: "2026-04-14T00:00:00.000Z",
                    id: "file-tab-1",
                    kind: "file",
                    projectId: "project-1",
                    relativePath: "src/app.ts",
                    title: "app.ts",
                    worktreeId: null,
                },
                {
                    createdAt: "2026-04-14T00:01:00.000Z",
                    id: "file-tab-2",
                    kind: "file",
                    projectId: "project-1",
                    relativePath: "src/other.ts",
                    title: "other.ts",
                    worktreeId: null,
                },
            ],
        };

        service.saveSnapshot(workspaceId, firstSnapshot);

        const changesAfterFirstSave = getTotalChanges(connection);

        const layoutOnlySnapshot: WorkspaceSnapshot = {
            ...firstSnapshot,
            rootNode: {
                id: "pane-root",
                tabIds: ["file-tab-1", "file-tab-2"],
                activeTabId: "file-tab-2",
                type: "pane",
            },
        };

        service.saveSnapshot(workspaceId, layoutOnlySnapshot);

        expect(getTotalChanges(connection) - changesAfterFirstSave).toBe(1);

        const replacementSnapshot: WorkspaceSnapshot = {
            activePaneId: "pane-root",
            rootNode: {
                activeTabId: "file-tab-1",
                id: "pane-root",
                tabIds: ["file-tab-1", "file-tab-3"],
                type: "pane",
            },
            tabs: [
                firstSnapshot.tabs[0],
                {
                    createdAt: "2026-04-14T00:02:00.000Z",
                    id: "file-tab-3",
                    kind: "file",
                    projectId: "project-1",
                    relativePath: "src/new.ts",
                    title: "new.ts",
                    worktreeId: null,
                },
            ],
        };

        const changesBeforeReplacement = getTotalChanges(connection);
        service.saveSnapshot(workspaceId, replacementSnapshot);

        expect(getTotalChanges(connection) - changesBeforeReplacement).toBe(3);
        expect(service.loadSnapshot(workspaceId)).toEqual(replacementSnapshot);
    });
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}

function getTotalChanges(
    connection: ReturnType<typeof createTestConnection>,
): number {
    const row = connection
        .prepare<
            [],
            { total_changes: number }
        >("SELECT total_changes() AS total_changes")
        .get();

    if (!row) {
        throw new Error("Expected SQLite total_changes() to return a row.");
    }

    return row.total_changes;
}
