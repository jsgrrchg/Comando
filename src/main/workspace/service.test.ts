import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@shared/ipc";

import { WorkspaceService } from "./service";

describe("WorkspaceService", () => {
    it("persiste y recarga transcript, eventos y artefactos minimos de una chat session", () => {
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
                    runtimeId: "codex",
                    sessionId: "chat-session-1",
                    title: "Session 1",
                },
            ],
        };

        service.saveSnapshot(snapshot);

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

    it("tolera layout y tabs corruptos al restaurar el workspace", () => {
        const connection = createFakeWorkspaceConnection({
            layouts: [
                {
                    active_pane_id: "pane-corrupto",
                    id: "primary",
                    root_node_json: "{broken json",
                },
            ],
            tabs: [
                {
                    created_at: "2026-04-12T00:00:00.000Z",
                    id: "tab-corrupta",
                    kind: "chat",
                    payload_json: "{broken json",
                    position: 0,
                    title: "Tab rota",
                    workspace_id: "primary",
                },
            ],
        });
        const service = new WorkspaceService(
            connection as unknown as Database.Database,
        );

        expect(service.loadSnapshot()).toEqual({
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

function createFakeWorkspaceConnection(
    seed: {
        layouts?: readonly {
            active_pane_id: string;
            id: string;
            root_node_json: string;
        }[];
        tabs?: readonly {
            created_at: string;
            id: string;
            kind: string;
            payload_json: string;
            position: number;
            title: string;
            workspace_id: string;
        }[];
    } = {},
) {
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
    const sessionEvents = new Map<
        string,
        {
            created_at: string;
            event_type: string;
            id: string;
            payload_json: string;
            sequence: number;
            session_id: string;
        }[]
    >();
    const reviewArtifacts = new Map<
        string,
        {
            artifact_type: string;
            created_at: string;
            id: string;
            path: string | null;
            payload_json: string;
            session_id: string | null;
            title: string;
            updated_at: string;
        }[]
    >();

    seed.layouts?.forEach((layout) => {
        layouts.set(layout.id, {
            active_pane_id: layout.active_pane_id,
            root_node_json: layout.root_node_json,
        });
    });
    seed.tabs?.forEach((tab) => {
        tabs.set(tab.id, { ...tab });
    });

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
                        _runtimeId: string,
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

            if (sql.includes("SELECT id FROM chat_sessions WHERE id = ?")) {
                return {
                    get(sessionId: string) {
                        const chatSession = chatSessions.get(sessionId);
                        return chatSession ? { id: sessionId } : undefined;
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

            if (
                sql.includes(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence",
                )
            ) {
                return {
                    get(sessionId: string) {
                        const events = sessionEvents.get(sessionId) ?? [];
                        const maxSequence = events.reduce(
                            (currentMax, event) =>
                                Math.max(currentMax, event.sequence),
                            0,
                        );

                        return {
                            next_sequence: maxSequence + 1,
                        };
                    },
                };
            }

            if (sql.includes("INSERT INTO chat_session_events")) {
                return {
                    run(
                        id: string,
                        sessionId: string,
                        sequence: number,
                        eventType: string,
                        payloadJson: string,
                        createdAt: string,
                    ) {
                        const events = sessionEvents.get(sessionId) ?? [];
                        events.push({
                            created_at: createdAt,
                            event_type: eventType,
                            id,
                            payload_json: payloadJson,
                            sequence,
                            session_id: sessionId,
                        });
                        sessionEvents.set(sessionId, events);
                    },
                };
            }

            if (sql.includes("INSERT INTO review_artifacts")) {
                return {
                    run(
                        id: string,
                        sessionId: string,
                        artifactType: string,
                        title: string,
                        path: string | null,
                        payloadJson: string,
                        createdAt: string,
                        updatedAt: string,
                    ) {
                        const artifacts = reviewArtifacts.get(sessionId) ?? [];
                        const existingIndex = artifacts.findIndex(
                            (artifact) => artifact.id === id,
                        );
                        const nextArtifact = {
                            artifact_type: artifactType,
                            created_at: createdAt,
                            id,
                            path,
                            payload_json: payloadJson,
                            session_id: sessionId,
                            title,
                            updated_at: updatedAt,
                        };

                        if (existingIndex === -1) {
                            artifacts.push(nextArtifact);
                        } else {
                            artifacts[existingIndex] = nextArtifact;
                        }

                        reviewArtifacts.set(sessionId, artifacts);
                    },
                };
            }

            if (
                sql.includes(
                    "SELECT\n                    chat_sessions.project_id,",
                )
            ) {
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

            if (sql.includes("FROM chat_session_events")) {
                return {
                    all(sessionId: string) {
                        return [...(sessionEvents.get(sessionId) ?? [])].sort(
                            (left, right) => left.sequence - right.sequence,
                        );
                    },
                };
            }

            if (sql.includes("FROM review_artifacts")) {
                return {
                    all(sessionId: string) {
                        return [...(reviewArtifacts.get(sessionId) ?? [])].sort(
                            (left, right) =>
                                right.updated_at.localeCompare(left.updated_at),
                        );
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

            if (
                sql.includes("SELECT id, kind, title, payload_json, created_at")
            ) {
                return {
                    all(workspaceId: string) {
                        return [...tabs.values()]
                            .filter((tab) => tab.workspace_id === workspaceId)
                            .sort(
                                (left, right) => left.position - right.position,
                            );
                    },
                };
            }

            throw new Error(`Unsupported SQL in fake workspace test:\n${sql}`);
        },
        transaction<TArgs extends unknown[]>(
            callback: (...args: TArgs) => void,
        ) {
            return (...args: TArgs) => {
                callback(...args);
            };
        },
    };
}
