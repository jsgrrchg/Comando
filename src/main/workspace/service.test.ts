import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { databaseMigrations } from "@main/db/migrations";
import {
    applyMigrations,
    createSqliteCompatConnection,
} from "@main/testing/sqlite-compat";

import { WorkspaceService } from "./service";

describe("WorkspaceService", () => {
    it("persiste y recarga transcript, eventos y artefactos minimos de una chat session", () => {
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
                    draft: "Necesito revisar este cambio",
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
            draft: "Necesito revisar este cambio",
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

    it("tolera layout y tabs corruptos al restaurar un workspace especifico", () => {
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
                "workspace-corrupto",
                "{broken json",
                "pane-corrupto",
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
                "tab-corrupta",
                "workspace-corrupto",
                "chat",
                "Tab rota",
                "{broken json",
                "2026-04-12T00:00:00.000Z",
                0,
            );

        const service = new WorkspaceService(connection);

        expect(service.loadSnapshot("workspace-corrupto")).toEqual({
            activePaneId: "pane-corrupto",
            rootNode: {
                activeTabId: null,
                id: "pane-root",
                tabIds: [],
                type: "pane",
            },
            tabs: [],
        });
    });
});

function createTestConnection() {
    const connection = createSqliteCompatConnection();
    applyMigrations(connection, databaseMigrations);
    return connection;
}
