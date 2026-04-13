import { describe, expect, it } from "vitest";
import { WorkspaceService } from "./service";
describe("WorkspaceService", () => {
    it("persiste y recarga transcript, eventos y artefactos minimos de una chat session", () => {
        const connection = createFakeWorkspaceConnection();
        const service = new WorkspaceService(connection);
        const snapshot = {
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
        const service = new WorkspaceService(connection);
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
function createFakeWorkspaceConnection(seed = {}) {
    const layouts = new Map();
    const tabs = new Map();
    const chatSessions = new Map();
    const transcripts = new Map();
    const sessionEvents = new Map();
    const reviewArtifacts = new Map();
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
        prepare(sql) {
            if (sql.includes("INSERT INTO workspace_layouts")) {
                return {
                    run(id, rootNodeJson, activePaneId) {
                        layouts.set(id, {
                            active_pane_id: activePaneId,
                            root_node_json: rootNodeJson,
                        });
                    },
                };
            }
            if (sql.includes("DELETE FROM workspace_tabs")) {
                return {
                    run(workspaceId) {
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
                    run(id, workspaceId, kind, title, payloadJson, createdAt, position) {
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
                    run(id, projectId, title, _runtimeId, draft, _createdAt, updatedAt) {
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
                    get(sessionId) {
                        const chatSession = chatSessions.get(sessionId);
                        return chatSession ? { id: sessionId } : undefined;
                    },
                };
            }
            if (sql.includes("INSERT INTO chat_transcripts")) {
                return {
                    run(_id, sessionId, transcriptJson, messageCount) {
                        transcripts.set(sessionId, {
                            message_count: messageCount,
                            session_id: sessionId,
                            transcript_json: transcriptJson,
                        });
                    },
                };
            }
            if (sql.includes("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence")) {
                return {
                    get(sessionId) {
                        const events = sessionEvents.get(sessionId) ?? [];
                        const maxSequence = events.reduce((currentMax, event) => Math.max(currentMax, event.sequence), 0);
                        return {
                            next_sequence: maxSequence + 1,
                        };
                    },
                };
            }
            if (sql.includes("INSERT INTO chat_session_events")) {
                return {
                    run(id, sessionId, sequence, eventType, payloadJson, createdAt) {
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
                    run(id, sessionId, artifactType, title, path, payloadJson, createdAt, updatedAt) {
                        const artifacts = reviewArtifacts.get(sessionId) ?? [];
                        const existingIndex = artifacts.findIndex((artifact) => artifact.id === id);
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
                        }
                        else {
                            artifacts[existingIndex] = nextArtifact;
                        }
                        reviewArtifacts.set(sessionId, artifacts);
                    },
                };
            }
            if (sql.includes("SELECT\n                    chat_sessions.project_id,")) {
                return {
                    get(sessionId) {
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
                            transcript_json: transcript?.transcript_json ?? null,
                            updated_at: chatSession.updated_at,
                        };
                    },
                };
            }
            if (sql.includes("FROM chat_session_events")) {
                return {
                    all(sessionId) {
                        return [...(sessionEvents.get(sessionId) ?? [])].sort((left, right) => left.sequence - right.sequence);
                    },
                };
            }
            if (sql.includes("FROM review_artifacts")) {
                return {
                    all(sessionId) {
                        return [...(reviewArtifacts.get(sessionId) ?? [])].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
                    },
                };
            }
            if (sql.includes("SELECT active_pane_id, root_node_json")) {
                return {
                    get(id) {
                        return layouts.get(id);
                    },
                };
            }
            if (sql.includes("SELECT id, kind, title, payload_json, created_at")) {
                return {
                    all(workspaceId) {
                        return [...tabs.values()]
                            .filter((tab) => tab.workspace_id === workspaceId)
                            .sort((left, right) => left.position - right.position);
                    },
                };
            }
            throw new Error(`Unsupported SQL in fake workspace test:\n${sql}`);
        },
        transaction(callback) {
            return (...args) => {
                callback(...args);
            };
        },
    };
}
