import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { WorkspaceService } from "./service";

describe("WorkspaceService", () => {
    it("persiste y recarga el esqueleto de transcript de una chat session", () => {
        const connection = createFakeWorkspaceConnection();
        const service = new WorkspaceService(
            connection as unknown as Database.Database,
        );

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
                    sessionId: "chat-session-1",
                    title: "Session 1",
                },
            ],
        };

        service.saveSnapshot(snapshot);

        const chatSessionState =
            service.loadChatSessionState("chat-session-1");

        expect(chatSessionState).not.toBeNull();
        expect(chatSessionState).toMatchObject({
            draft: "Necesito revisar este cambio",
            messageCount: 0,
            projectId: null,
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
});

function createFakeWorkspaceConnection() {
    const layouts = new Map<
        string,
        {
            active_pane_id: string;
            root_node_json: string;
        }
    >();
    const tabs = new Map<
        string,
        {
            created_at: string;
            id: string;
            kind: string;
            payload_json: string;
            position: number;
            title: string;
            workspace_id: string;
        }
    >();
    const chatSessions = new Map<
        string,
        {
            draft: string;
            project_id: string | null;
            title: string;
            updated_at: string;
        }
    >();
    const transcripts = new Map<
        string,
        {
            message_count: number;
            session_id: string;
            transcript_json: string;
        }
    >();

    return {
        prepare(sql: string) {
            if (sql.includes("INSERT INTO workspace_layouts")) {
                return {
                    run(
                        id: string,
                        rootNodeJson: string,
                        activePaneId: string,
                    ) {
                        layouts.set(id, {
                            active_pane_id: activePaneId,
                            root_node_json: rootNodeJson,
                        });
                    },
                };
            }

            if (sql.includes("DELETE FROM workspace_tabs")) {
                return {
                    run(workspaceId: string) {
                        for (const [id, tab] of tabs.entries()) {
                            if (tab.workspace_id === workspaceId) {
                                tabs.delete(id);
                            }
                        }
                    },
                };
            }

            if (sql.includes("INSERT INTO workspace_tabs")) {
                return {
                    run(
                        id: string,
                        workspaceId: string,
                        kind: string,
                        title: string,
                        payloadJson: string,
                        createdAt: string,
                        position: number,
                    ) {
                        tabs.set(id, {
                            created_at: createdAt,
                            id,
                            kind,
                            payload_json: payloadJson,
                            position,
                            title,
                            workspace_id: workspaceId,
                        });
                    },
                };
            }

            if (sql.includes("INSERT INTO chat_sessions")) {
                return {
                    run(
                        id: string,
                        projectId: string | null,
                        title: string,
                        draft: string,
                        _createdAt: string,
                        updatedAt: string,
                    ) {
                        chatSessions.set(id, {
                            draft,
                            project_id: projectId,
                            title,
                            updated_at: updatedAt,
                        });
                    },
                };
            }

            if (sql.includes("INSERT INTO chat_transcripts")) {
                return {
                    run(
                        _id: string,
                        sessionId: string,
                        transcriptJson: string,
                        messageCount: number,
                    ) {
                        transcripts.set(sessionId, {
                            message_count: messageCount,
                            session_id: sessionId,
                            transcript_json: transcriptJson,
                        });
                    },
                };
            }

            if (sql.includes("SELECT\n                    chat_sessions.project_id,")) {
                return {
                    get(sessionId: string) {
                        const chatSession = chatSessions.get(sessionId);
                        if (!chatSession) {
                            return undefined;
                        }

                        const transcript = transcripts.get(sessionId);
                        return {
                            draft: chatSession.draft,
                            message_count: transcript?.message_count ?? 0,
                            project_id: chatSession.project_id,
                            title: chatSession.title,
                            transcript_json:
                                transcript?.transcript_json ?? null,
                            updated_at: chatSession.updated_at,
                        };
                    },
                };
            }

            if (sql.includes("SELECT active_pane_id, root_node_json")) {
                return {
                    get(id: string) {
                        return layouts.get(id);
                    },
                };
            }

            if (sql.includes("SELECT id, kind, title, payload_json, created_at")) {
                return {
                    all(workspaceId: string) {
                        return [...tabs.values()]
                            .filter((tab) => tab.workspace_id === workspaceId)
                            .sort((left, right) => left.position - right.position);
                    },
                };
            }

            throw new Error(`Unsupported SQL in fake workspace test:\n${sql}`);
        },
        transaction<TArgs extends unknown[]>(callback: (...args: TArgs) => void) {
            return (...args: TArgs) => {
                callback(...args);
            };
        },
    };
}
