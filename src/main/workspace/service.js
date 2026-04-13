import { randomUUID } from "node:crypto";
const PRIMARY_WORKSPACE_ID = "primary";
export class WorkspaceService {
    #connection;
    constructor(connection) {
        this.#connection = connection;
    }
    loadSnapshot() {
        const layoutRow = this.#connection
            .prepare(`
                SELECT active_pane_id, root_node_json
                FROM workspace_layouts
                WHERE id = ?
                `)
            .get(PRIMARY_WORKSPACE_ID);
        if (!layoutRow) {
            return createDefaultWorkspaceSnapshot();
        }
        const tabRows = this.#connection
            .prepare(`
                SELECT id, kind, title, payload_json, created_at
                FROM workspace_tabs
                WHERE workspace_id = ?
                ORDER BY position ASC
                `)
            .all(PRIMARY_WORKSPACE_ID);
        return {
            activePaneId: layoutRow.active_pane_id,
            rootNode: parseJsonWithFallback(layoutRow.root_node_json, createDefaultWorkspaceSnapshot().rootNode),
            tabs: tabRows
                .map((row) => deserializeTabRow(row))
                .filter((tab) => tab !== null),
        };
    }
    saveSnapshot(snapshot) {
        const now = new Date().toISOString();
        const upsertLayout = this.#connection.prepare(`
            INSERT INTO workspace_layouts (
                id,
                root_node_json,
                active_pane_id,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                root_node_json = excluded.root_node_json,
                active_pane_id = excluded.active_pane_id,
                updated_at = excluded.updated_at
            `);
        const deleteTabs = this.#connection.prepare("DELETE FROM workspace_tabs WHERE workspace_id = ?");
        const insertTab = this.#connection.prepare(`
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
            `);
        const transaction = this.#connection.transaction((nextSnapshot) => {
            upsertLayout.run(PRIMARY_WORKSPACE_ID, JSON.stringify(nextSnapshot.rootNode), nextSnapshot.activePaneId, now, now);
            deleteTabs.run(PRIMARY_WORKSPACE_ID);
            nextSnapshot.tabs.forEach((tab, index) => {
                insertTab.run(tab.id, PRIMARY_WORKSPACE_ID, tab.kind, tab.title, JSON.stringify(serializeTab(tab)), tab.createdAt, index);
            });
            syncChatPersistence(this.#connection, nextSnapshot.tabs);
        });
        transaction(snapshot);
    }
    loadChatSessionState(sessionId) {
        const row = this.#connection
            .prepare(`
                SELECT
                    chat_sessions.project_id,
                    chat_sessions.title,
                    chat_sessions.draft,
                    chat_sessions.updated_at,
                    chat_transcripts.transcript_json,
                    chat_transcripts.message_count
                FROM chat_sessions
                LEFT JOIN chat_transcripts
                    ON chat_transcripts.session_id = chat_sessions.id
                WHERE chat_sessions.id = ?
                `)
            .get(sessionId);
        if (!row) {
            return null;
        }
        const events = this.#connection
            .prepare(`
                SELECT
                    id,
                    session_id,
                    sequence,
                    event_type,
                    payload_json,
                    created_at
                FROM chat_session_events
                WHERE session_id = ?
                ORDER BY sequence ASC
                `)
            .all(sessionId);
        const reviewArtifacts = this.#connection
            .prepare(`
                SELECT
                    id,
                    session_id,
                    artifact_type,
                    title,
                    path,
                    payload_json,
                    created_at,
                    updated_at
                FROM review_artifacts
                WHERE session_id = ?
                ORDER BY updated_at DESC, created_at DESC
                `)
            .all(sessionId);
        return {
            draft: row.draft,
            events: events.map((event) => ({
                createdAt: event.created_at,
                eventType: event.event_type,
                id: event.id,
                payloadJson: event.payload_json,
                sequence: event.sequence,
                sessionId: event.session_id,
            })),
            messageCount: row.message_count ?? 0,
            projectId: row.project_id,
            reviewArtifacts: reviewArtifacts.map((artifact) => ({
                artifactType: artifact.artifact_type,
                createdAt: artifact.created_at,
                id: artifact.id,
                path: artifact.path,
                payloadJson: artifact.payload_json,
                sessionId: artifact.session_id,
                title: artifact.title,
                updatedAt: artifact.updated_at,
            })),
            sessionId,
            title: row.title,
            transcriptJson: normalizeTranscriptJson(row.transcript_json, sessionId),
            updatedAt: row.updated_at,
        };
    }
}
function deserializeTabRow(row) {
    const payload = parseJsonWithFallback(row.payload_json, null);
    if (!payload) {
        return null;
    }
    if (row.kind === "chat") {
        const chatPayload = payload;
        return {
            createdAt: row.created_at,
            draft: typeof chatPayload.draft === "string" ? chatPayload.draft : "",
            id: row.id,
            kind: "chat",
            projectId: typeof chatPayload.projectId === "string" ||
                chatPayload.projectId === null
                ? chatPayload.projectId
                : null,
            runtimeId: chatPayload.runtimeId === "codex"
                ? chatPayload.runtimeId
                : "codex",
            sessionId: typeof chatPayload.sessionId === "string"
                ? chatPayload.sessionId
                : row.id,
            title: row.title,
        };
    }
    if (row.kind === "review") {
        const reviewPayload = payload;
        return {
            createdAt: row.created_at,
            id: row.id,
            kind: "review",
            projectId: typeof reviewPayload.projectId === "string" ||
                reviewPayload.projectId === null
                ? reviewPayload.projectId
                : null,
            runtimeId: reviewPayload.runtimeId === "codex"
                ? reviewPayload.runtimeId
                : "codex",
            sessionId: typeof reviewPayload.sessionId === "string"
                ? reviewPayload.sessionId
                : row.id,
            title: row.title,
        };
    }
    return {
        ...payload,
        createdAt: row.created_at,
        id: row.id,
        title: row.title,
    };
}
function serializeTab(tab) {
    if (tab.kind === "file") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            relativePath: tab.relativePath,
        };
    }
    if (tab.kind === "chat") {
        return {
            draft: tab.draft,
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
        };
    }
    if (tab.kind === "review") {
        return {
            kind: tab.kind,
            projectId: tab.projectId,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
        };
    }
    return {
        kind: tab.kind,
        projectId: tab.projectId,
        sessionId: tab.sessionId,
    };
}
function createDefaultWorkspaceSnapshot() {
    return {
        activePaneId: "pane-root",
        rootNode: {
            activeTabId: null,
            id: "pane-root",
            tabIds: [],
            type: "pane",
        },
        tabs: [],
    };
}
function syncChatPersistence(connection, tabs) {
    const chatTabs = tabs.filter((tab) => tab.kind === "chat");
    const findSession = connection.prepare("SELECT id FROM chat_sessions WHERE id = ?");
    const upsertChatSession = connection.prepare(`
        INSERT INTO chat_sessions (
            id,
            project_id,
            title,
            runtime,
            status,
            draft,
            created_at,
            updated_at,
            last_opened_at
        )
        VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            runtime = excluded.runtime,
            draft = excluded.draft,
            updated_at = excluded.updated_at,
            last_opened_at = excluded.last_opened_at
        `);
    const upsertTranscript = connection.prepare(`
        INSERT INTO chat_transcripts (
            id,
            session_id,
            transcript_json,
            message_count,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            transcript_json = excluded.transcript_json,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at
        `);
    const nextSessionSequence = connection.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM chat_session_events
        WHERE session_id = ?
        `);
    const insertSessionEvent = connection.prepare(`
        INSERT INTO chat_session_events (
            id,
            session_id,
            sequence,
            event_type,
            payload_json,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `);
    const upsertReviewArtifact = connection.prepare(`
        INSERT INTO review_artifacts (
            id,
            session_id,
            artifact_type,
            title,
            path,
            payload_json,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            artifact_type = excluded.artifact_type,
            title = excluded.title,
            path = excluded.path,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `);
    for (const tab of chatTabs) {
        const now = new Date().toISOString();
        const wasPersisted = Boolean(findSession.get(tab.sessionId));
        upsertChatSession.run(tab.sessionId, tab.projectId, tab.title, tab.runtimeId, tab.draft, tab.createdAt, now, now);
        if (!wasPersisted) {
            const transcriptSkeleton = createEmptyTranscriptSkeleton(tab.sessionId);
            upsertTranscript.run(`transcript:${tab.sessionId}`, tab.sessionId, transcriptSkeleton, 0, tab.createdAt, now);
            const sequence = nextSessionSequence.get(tab.sessionId)?.next_sequence ?? 1;
            insertSessionEvent.run(randomUUID(), tab.sessionId, sequence, "session.created", JSON.stringify({
                projectId: tab.projectId,
                runtimeId: tab.runtimeId,
                source: "workspace-sync",
                tabId: tab.id,
                title: tab.title,
            }), now);
        }
        upsertReviewArtifact.run(`artifact:${tab.sessionId}:transcript-skeleton`, tab.sessionId, "transcript-skeleton", "Transcript skeleton", null, JSON.stringify({
            messageCount: 0,
            runtimeId: tab.runtimeId,
            sessionId: tab.sessionId,
            tabId: tab.id,
            version: 1,
        }), tab.createdAt, now);
    }
}
function normalizeTranscriptJson(transcriptJson, sessionId) {
    return JSON.stringify(parseJsonWithFallback(transcriptJson, JSON.parse(createEmptyTranscriptSkeleton(sessionId))));
}
function parseJsonWithFallback(value, fallback) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function createEmptyTranscriptSkeleton(sessionId) {
    return JSON.stringify({
        messages: [],
        sessionId,
        version: 1,
    });
}
