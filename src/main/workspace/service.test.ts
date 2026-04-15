import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { WorkspaceService } from "./service";

describe("WorkspaceService", () => {
    it("persists and reloads transcript, events, and minimal artifacts for a chat session", () => {
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
            transcriptJson: JSON.stringify({
                messages: [],
                sessionId: "chat-session-1",
                version: 1,
            }),
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
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}
