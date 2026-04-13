import type Database from "better-sqlite3";

import type {
    PersistedChatSessionState,
    WorkspaceChatTab,
    WorkspaceFileTab,
    WorkspaceNode,
    WorkspaceSnapshot,
    WorkspaceTab,
    WorkspaceTerminalTab,
} from "@shared/ipc";

const PRIMARY_WORKSPACE_ID = "primary";

interface WorkspaceLayoutRow {
    readonly active_pane_id: string;
    readonly root_node_json: string;
}

interface WorkspaceTabRow {
    readonly created_at: string;
    readonly id: string;
    readonly kind: string;
    readonly payload_json: string;
    readonly title: string;
}

type WorkspaceFilePayload = Omit<
    WorkspaceFileTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceChatPayload = Omit<
    WorkspaceChatTab,
    "createdAt" | "id" | "title"
>;
type WorkspaceTerminalPayload = Omit<
    WorkspaceTerminalTab,
    "createdAt" | "id" | "title"
>;

export class WorkspaceService {
    readonly #connection: Database.Database;

    constructor(connection: Database.Database) {
        this.#connection = connection;
    }

    loadSnapshot(): WorkspaceSnapshot {
        const layoutRow = this.#connection
            .prepare<[string], WorkspaceLayoutRow | undefined>(
                `
                SELECT active_pane_id, root_node_json
                FROM workspace_layouts
                WHERE id = ?
                `,
            )
            .get(PRIMARY_WORKSPACE_ID);

        if (!layoutRow) {
            return createDefaultWorkspaceSnapshot();
        }

        const tabRows = this.#connection
            .prepare<[string], WorkspaceTabRow>(
                `
                SELECT id, kind, title, payload_json, created_at
                FROM workspace_tabs
                WHERE workspace_id = ?
                ORDER BY position ASC
                `,
            )
            .all(PRIMARY_WORKSPACE_ID);

        return {
            activePaneId: layoutRow.active_pane_id,
            rootNode: JSON.parse(layoutRow.root_node_json) as WorkspaceNode,
            tabs: tabRows.map((row) => deserializeTabRow(row)),
        };
    }

    saveSnapshot(snapshot: WorkspaceSnapshot): void {
        const now = new Date().toISOString();
        const upsertLayout = this.#connection.prepare<
            [string, string, string, string, string],
            void
        >(
            `
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
            `,
        );
        const deleteTabs = this.#connection.prepare<[string], void>(
            "DELETE FROM workspace_tabs WHERE workspace_id = ?",
        );
        const insertTab = this.#connection.prepare<
            [string, string, string, string, string, string, number],
            void
        >(
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
        );

        const transaction = this.#connection.transaction(
            (nextSnapshot: WorkspaceSnapshot) => {
                upsertLayout.run(
                    PRIMARY_WORKSPACE_ID,
                    JSON.stringify(nextSnapshot.rootNode),
                    nextSnapshot.activePaneId,
                    now,
                    now,
                );
                deleteTabs.run(PRIMARY_WORKSPACE_ID);

                nextSnapshot.tabs.forEach((tab, index) => {
                    insertTab.run(
                        tab.id,
                        PRIMARY_WORKSPACE_ID,
                        tab.kind,
                        tab.title,
                        JSON.stringify(serializeTab(tab)),
                        tab.createdAt,
                        index,
                    );
                });

                syncChatPersistence(this.#connection, nextSnapshot.tabs);
            },
        );

        transaction(snapshot);
    }

    loadChatSessionState(sessionId: string): PersistedChatSessionState | null {
        const row = this.#connection
            .prepare<
                [string],
                | {
                      draft: string;
                      message_count: number;
                      project_id: string | null;
                      transcript_json: string;
                      title: string;
                      updated_at: string;
                  }
                | undefined
            >(
                `
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
                `,
            )
            .get(sessionId);

        if (!row) {
            return null;
        }

        return {
            draft: row.draft,
            messageCount: row.message_count ?? 0,
            projectId: row.project_id,
            sessionId,
            title: row.title,
            transcriptJson:
                row.transcript_json ?? createEmptyTranscriptSkeleton(sessionId),
            updatedAt: row.updated_at,
        };
    }
}

function deserializeTabRow(row: WorkspaceTabRow): WorkspaceTab {
    const payload = JSON.parse(row.payload_json) as
        | WorkspaceFilePayload
        | WorkspaceChatPayload
        | WorkspaceTerminalPayload;

    return {
        ...payload,
        createdAt: row.created_at,
        id: row.id,
        title: row.title,
    } as WorkspaceTab;
}

function serializeTab(
    tab: WorkspaceTab,
): WorkspaceFilePayload | WorkspaceChatPayload | WorkspaceTerminalPayload {
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
            sessionId: tab.sessionId,
        };
    }

    return {
        kind: tab.kind,
        projectId: tab.projectId,
        sessionId: tab.sessionId,
    };
}

function createDefaultWorkspaceSnapshot(): WorkspaceSnapshot {
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

function syncChatPersistence(
    connection: Database.Database,
    tabs: readonly WorkspaceTab[],
): void {
    const chatTabs = tabs.filter(
        (tab): tab is WorkspaceChatTab => tab.kind === "chat",
    );
    const upsertChatSession = connection.prepare<
        [string, string | null, string, string, string, string, string],
        void
    >(
        `
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
        VALUES (?, ?, ?, 'pending', 'idle', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            draft = excluded.draft,
            updated_at = excluded.updated_at,
            last_opened_at = excluded.last_opened_at
        `,
    );
    const upsertTranscript = connection.prepare<
        [string, string, string, number, string, string],
        void
    >(
        `
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
            updated_at = excluded.updated_at
        `,
    );

    for (const tab of chatTabs) {
        const now = new Date().toISOString();
        upsertChatSession.run(
            tab.sessionId,
            tab.projectId,
            tab.title,
            tab.draft,
            tab.createdAt,
            now,
            now,
        );
        upsertTranscript.run(
            `transcript:${tab.sessionId}`,
            tab.sessionId,
            createEmptyTranscriptSkeleton(tab.sessionId),
            0,
            tab.createdAt,
            now,
        );
    }
}

function createEmptyTranscriptSkeleton(sessionId: string | null): string {
    return JSON.stringify({
        messages: [],
        sessionId,
        version: 1,
    });
}
