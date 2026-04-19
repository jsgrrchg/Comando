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
        ('app.bundle_id', 'io.github.jsgrrchg.comando', CURRENT_TIMESTAMP);
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
    {
        id: "0005-project-settings",
        sql: `
	      CREATE TABLE IF NOT EXISTS project_settings (
	        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
	      );
	    `,
    },
    {
        id: "0006-workspace-session-shell-state",
        sql: `
          ALTER TABLE workspace_sessions
            ADD COLUMN shell_state_json TEXT;

          ALTER TABLE workspace_sessions
            ADD COLUMN is_open INTEGER NOT NULL DEFAULT 1;

          CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sessions_window_id
            ON workspace_sessions(window_id);
        `,
    },
    {
        id: "0007-git-worktrees",
        sql: `
      ALTER TABLE projects
        ADD COLUMN canonical_root_path TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS project_worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL UNIQUE,
        branch_name TEXT,
        head_sha TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      UPDATE project_roots
      SET is_primary = CASE
        WHEN id = (
          SELECT candidate.id
          FROM project_roots AS candidate
          WHERE candidate.project_id = project_roots.project_id
          ORDER BY candidate.is_primary DESC, candidate.id ASC
          LIMIT 1
        ) THEN 1
        ELSE 0
      END
      WHERE project_id IN (
        SELECT DISTINCT project_id
        FROM project_roots
      );

      CREATE INDEX IF NOT EXISTS idx_project_roots_project_id
        ON project_roots(project_id);

      CREATE INDEX IF NOT EXISTS idx_project_roots_project_id_primary
        ON project_roots(project_id, is_primary);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_roots_primary
        ON project_roots(project_id)
        WHERE is_primary = 1;

      CREATE INDEX IF NOT EXISTS idx_projects_canonical_root_path
        ON projects(canonical_root_path);

      CREATE INDEX IF NOT EXISTS idx_project_worktrees_project_id
        ON project_worktrees(project_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_worktrees_primary
        ON project_worktrees(project_id)
        WHERE is_primary = 1;

      ALTER TABLE workspace_sessions
        ADD COLUMN active_worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL;

      ALTER TABLE chat_sessions
        ADD COLUMN worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL;

      ALTER TABLE workspace_tabs
        ADD COLUMN worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL;

      INSERT INTO project_worktrees (
        id,
        project_id,
        root_path,
        branch_name,
        head_sha,
        is_primary,
        created_at,
        updated_at
      )
      SELECT
        projects.id || ':primary',
        projects.id,
        project_roots.root_path,
        NULL,
        NULL,
        1,
        projects.created_at,
        projects.updated_at
      FROM projects
      INNER JOIN project_roots
        ON project_roots.project_id = projects.id
       AND project_roots.is_primary = 1;

      UPDATE projects
      SET canonical_root_path = COALESCE(
        NULLIF(canonical_root_path, ''),
        (
          SELECT project_roots.root_path
          FROM project_roots
          WHERE project_roots.project_id = projects.id
            AND project_roots.is_primary = 1
          LIMIT 1
        ),
        (
          SELECT project_roots.root_path
          FROM project_roots
          WHERE project_roots.project_id = projects.id
          ORDER BY project_roots.id ASC
          LIMIT 1
        )
      );

      UPDATE workspace_sessions
      SET active_worktree_id = (
        SELECT project_worktrees.id
        FROM project_worktrees
        WHERE project_worktrees.project_id = workspace_sessions.active_project_id
          AND project_worktrees.is_primary = 1
        LIMIT 1
      )
      WHERE active_project_id IS NOT NULL
        AND active_worktree_id IS NULL;

      UPDATE chat_sessions
      SET worktree_id = (
        SELECT project_worktrees.id
        FROM project_worktrees
        WHERE project_worktrees.project_id = chat_sessions.project_id
          AND project_worktrees.is_primary = 1
        LIMIT 1
      )
      WHERE project_id IS NOT NULL
        AND worktree_id IS NULL;

      UPDATE workspace_tabs
      SET worktree_id = (
        SELECT project_worktrees.id
        FROM project_worktrees
        INNER JOIN projects
          ON projects.id = project_worktrees.project_id
        WHERE projects.id = json_extract(workspace_tabs.payload_json, '$.projectId')
          AND project_worktrees.is_primary = 1
        LIMIT 1
      )
      WHERE worktree_id IS NULL
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.projectId') IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_workspace_sessions_active_worktree_id
        ON workspace_sessions(active_worktree_id);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_worktree_id
        ON chat_sessions(worktree_id);

      CREATE INDEX IF NOT EXISTS idx_workspace_tabs_worktree_id
        ON workspace_tabs(worktree_id);
    `,
    },
    {
        id: "0008-project-visibility",
        sql: `
      ALTER TABLE projects
        ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_projects_visibility
        ON projects(is_hidden);
    `,
    },
    {
        id: "0009-ai-history-indexes",
        sql: `
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_worktree_updated_at
        ON chat_sessions(project_id, worktree_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_runtime_updated_at
        ON chat_sessions(runtime, updated_at DESC);
    `,
    },
];
