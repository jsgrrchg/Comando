export interface DatabaseMigration {
    readonly id: string;
    readonly sql: string;
}

export const databaseMigrations: readonly DatabaseMigration[] = [
    {
        id: "0001-foundation",
        sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO app_settings (key, value, updated_at)
      VALUES
        ('app.name', 'Comando', CURRENT_TIMESTAMP),
        ('app.bundle_id_placeholder', 'com.placeholder.comando', CURRENT_TIMESTAMP);
    `,
    },
    {
        id: "0002-projects",
        sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL UNIQUE,
        is_primary INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS recent_projects (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        last_opened_at TEXT NOT NULL
      );
    `,
    },
    {
        id: "0003-workspace",
        sql: `
      CREATE TABLE IF NOT EXISTS workspace_layouts (
        id TEXT PRIMARY KEY,
        root_node_json TEXT NOT NULL,
        active_pane_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_tabs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace_layouts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        position INTEGER NOT NULL
      );
    `,
    },
    {
        id: "0004-persistence",
        sql: `
      CREATE TABLE IF NOT EXISTS app_windows (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        x INTEGER,
        y INTEGER,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        is_maximized INTEGER NOT NULL DEFAULT 0,
        is_full_screen INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_sessions (
        id TEXT PRIMARY KEY,
        window_id TEXT NOT NULL REFERENCES app_windows(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'idle',
        draft TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_transcripts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
        transcript_json TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS review_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_sessions_last_opened
        ON workspace_sessions(last_opened_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_opened
        ON chat_sessions(last_opened_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_session_events_session_sequence
        ON chat_session_events(session_id, sequence);
    `,
    },
];
