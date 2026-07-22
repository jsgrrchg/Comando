use std::path::{Path, PathBuf};
use std::time::Duration;

use comando_types::persistence::{
    NativePersistenceMode, NativePersistenceOpenStoreOutput, NativePersistenceStorageHealth,
};
use rusqlite::{Connection, OptionalExtension};

use crate::error::PersistenceError;

pub const STORAGE_SCHEMA_VERSION: &str = "1";
pub const STORAGE_MODE_SQLITE_CURRENT: &str = "sqlite-current";

const REQUIRED_TABLES: &[(&str, &[&str])] = &[
    (
        "projects",
        &[
            "id",
            "name",
            "canonical_root_path",
            "created_at",
            "updated_at",
            "is_hidden",
        ],
    ),
    ("project_roots", &["project_id", "root_path", "is_primary"]),
    (
        "project_worktrees",
        &[
            "id",
            "project_id",
            "root_path",
            "branch_name",
            "head_sha",
            "is_primary",
            "created_at",
            "updated_at",
        ],
    ),
    ("recent_projects", &["project_id", "last_opened_at"]),
    (
        "workspace_sessions",
        &[
            "id",
            "active_project_id",
            "active_worktree_id",
            "last_opened_at",
        ],
    ),
];

#[derive(Debug, Clone)]
pub struct NativeStorageConfig {
    pub app_data_dir: PathBuf,
    pub database_path: PathBuf,
    pub mode: NativePersistenceMode,
}

pub struct SqlitePersistenceStore {
    app_data_dir: PathBuf,
    connection: Connection,
    database_path: PathBuf,
    metadata_ready: bool,
    mode: NativePersistenceMode,
}

impl SqlitePersistenceStore {
    pub fn open(
        config: NativeStorageConfig,
    ) -> Result<(Self, NativePersistenceOpenStoreOutput), PersistenceError> {
        if config.database_path.as_os_str().is_empty() {
            return Err(PersistenceError::EmptyDatabasePath);
        }
        if let Some(parent) = config.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(&config.database_path).map_err(|source| {
            PersistenceError::OpenStorage {
                path: config.database_path.clone(),
                source,
            }
        })?;
        configure_connection(&connection)?;
        ensure_current_schema(&connection)?;
        validate_schema(&connection)?;
        crate::metadata::ensure_metadata(&connection, STORAGE_SCHEMA_VERSION, &config.mode)?;

        let store = Self {
            app_data_dir: config.app_data_dir,
            connection,
            database_path: config.database_path,
            metadata_ready: true,
            mode: config.mode,
        };
        let output = NativePersistenceOpenStoreOutput {
            opened: true,
            schema_version: STORAGE_SCHEMA_VERSION.to_string(),
            storage_mode: STORAGE_MODE_SQLITE_CURRENT.to_string(),
            metadata_ready: store.metadata_ready,
        };

        Ok((store, output))
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn health(&self) -> NativePersistenceStorageHealth {
        crate::health::storage_health(&self.connection, true)
    }

    pub fn mode(&self) -> &NativePersistenceMode {
        &self.mode
    }
}

fn ensure_current_schema(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        INSERT OR IGNORE INTO app_settings (key, value, updated_at)
        VALUES
            ('app.name', 'Comando', CURRENT_TIMESTAMP),
            ('app.bundle_id', 'io.github.jsgrrchg.comando', CURRENT_TIMESTAMP);

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            canonical_root_path TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_hidden INTEGER NOT NULL DEFAULT 0
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
            worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE CASCADE,
            position INTEGER NOT NULL
        );

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
            window_id TEXT REFERENCES app_windows(id) ON DELETE CASCADE,
            workspace_id TEXT,
            active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            active_worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
            shell_state_json TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_opened_at TEXT NOT NULL,
            is_open INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE CASCADE,
            parent_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            runtime TEXT NOT NULL DEFAULT 'pending',
            runtime_session_id TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            draft TEXT NOT NULL DEFAULT '',
            pinned_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_opened_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_transcripts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
            transcript_json TEXT NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            preview TEXT,
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

        CREATE TABLE IF NOT EXISTS chat_session_runtime_links (
            runtime_session_id TEXT PRIMARY KEY,
            app_session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
            parent_runtime_session_id TEXT,
            parent_app_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_transcript_messages (
            session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            message_index INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            role TEXT,
            payload_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, message_id),
            UNIQUE(session_id, message_index)
        );

        CREATE TABLE IF NOT EXISTS chat_session_runtime_state (
            session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_session_review_state (
            session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
            review_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_settings (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, key)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_sessions_last_opened
            ON workspace_sessions(last_opened_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_sessions_active_worktree_id
            ON workspace_sessions(active_worktree_id);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_opened
            ON chat_sessions(last_opened_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_worktree_updated_at
            ON chat_sessions(project_id, worktree_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_runtime_updated_at
            ON chat_sessions(runtime, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_worktree_pinned_at
            ON chat_sessions(project_id, worktree_id, pinned_at DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_session_id
            ON chat_sessions(parent_session_id);
        CREATE INDEX IF NOT EXISTS idx_chat_session_events_session_sequence
            ON chat_session_events(session_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_chat_session_runtime_links_parent_runtime
            ON chat_session_runtime_links(parent_runtime_session_id);
        CREATE INDEX IF NOT EXISTS idx_chat_session_runtime_links_parent_app
            ON chat_session_runtime_links(parent_app_session_id);
        CREATE INDEX IF NOT EXISTS idx_chat_transcript_messages_session_index
            ON chat_transcript_messages(session_id, message_index);
        CREATE INDEX IF NOT EXISTS idx_project_roots_project_id
            ON project_roots(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_roots_project_id_primary
            ON project_roots(project_id, is_primary);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_roots_primary
            ON project_roots(project_id)
            WHERE is_primary = 1;
        CREATE INDEX IF NOT EXISTS idx_projects_canonical_root_path
            ON projects(canonical_root_path);
        CREATE INDEX IF NOT EXISTS idx_projects_visibility
            ON projects(is_hidden);
        CREATE INDEX IF NOT EXISTS idx_project_worktrees_project_id
            ON project_worktrees(project_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_worktrees_primary
            ON project_worktrees(project_id)
            WHERE is_primary = 1;
        CREATE INDEX IF NOT EXISTS idx_workspace_tabs_worktree_id
            ON workspace_tabs(worktree_id);
        ",
    )?;
    ensure_column(connection, "workspace_sessions", "window_id", "TEXT")?;
    ensure_column(connection, "workspace_sessions", "workspace_id", "TEXT")?;
    ensure_column(connection, "workspace_sessions", "shell_state_json", "TEXT")?;
    ensure_column(
        connection,
        "workspace_sessions",
        "created_at",
        "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
    )?;
    ensure_column(
        connection,
        "workspace_sessions",
        "updated_at",
        "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'",
    )?;
    ensure_column(
        connection,
        "workspace_sessions",
        "is_open",
        "INTEGER NOT NULL DEFAULT 1",
    )?;

    connection.execute_batch(
        "
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sessions_window_id
            ON workspace_sessions(window_id);
        ",
    )?;
    migrate_worktree_owned_foreign_keys(connection)?;

    Ok(())
}

fn migrate_worktree_owned_foreign_keys(connection: &Connection) -> Result<(), PersistenceError> {
    let workspace_tabs_are_cascaded =
        foreign_key_uses_action(connection, "workspace_tabs", "worktree_id", "CASCADE")?;
    let chat_sessions_are_cascaded =
        foreign_key_uses_action(connection, "chat_sessions", "worktree_id", "CASCADE")?;
    if workspace_tabs_are_cascaded && chat_sessions_are_cascaded {
        return Ok(());
    }

    // SQLite cannot alter a foreign-key action in place, so rebuild only the owned tables.
    connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let migration = connection.execute_batch(
        "
        BEGIN IMMEDIATE;

        CREATE TABLE workspace_tabs_rebuilt (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace_layouts(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE CASCADE,
            position INTEGER NOT NULL
        );
        INSERT INTO workspace_tabs_rebuilt
        SELECT id, workspace_id, kind, title, payload_json, created_at, worktree_id, position
        FROM workspace_tabs;
        DROP TABLE workspace_tabs;
        ALTER TABLE workspace_tabs_rebuilt RENAME TO workspace_tabs;

        CREATE TABLE chat_sessions_rebuilt (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE CASCADE,
            parent_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            runtime TEXT NOT NULL DEFAULT 'pending',
            runtime_session_id TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            draft TEXT NOT NULL DEFAULT '',
            pinned_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_opened_at TEXT NOT NULL
        );
        INSERT INTO chat_sessions_rebuilt
        SELECT
            id, project_id, worktree_id, parent_session_id, title, runtime, runtime_session_id,
            status, draft, pinned_at, created_at, updated_at, last_opened_at
        FROM chat_sessions;
        DROP TABLE chat_sessions;
        ALTER TABLE chat_sessions_rebuilt RENAME TO chat_sessions;

        CREATE INDEX idx_workspace_tabs_worktree_id
            ON workspace_tabs(worktree_id);
        CREATE INDEX idx_chat_sessions_last_opened
            ON chat_sessions(last_opened_at DESC);
        CREATE INDEX idx_chat_sessions_project_worktree_updated_at
            ON chat_sessions(project_id, worktree_id, updated_at DESC);
        CREATE INDEX idx_chat_sessions_runtime_updated_at
            ON chat_sessions(runtime, updated_at DESC);
        CREATE INDEX idx_chat_sessions_project_worktree_pinned_at
            ON chat_sessions(project_id, worktree_id, pinned_at DESC, updated_at DESC);
        CREATE INDEX idx_chat_sessions_parent_session_id
            ON chat_sessions(parent_session_id);

        COMMIT;
        ",
    );
    if let Err(error) = migration {
        let _ = connection.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
        return Err(error.into());
    }
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}

fn foreign_key_uses_action(
    connection: &Connection,
    table: &'static str,
    column: &'static str,
    expected_action: &'static str,
) -> Result<bool, PersistenceError> {
    let mut statement = connection.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(3)?, row.get::<_, String>(6)?))
    })?;
    for row in rows {
        let (from_column, on_delete) = row?;
        if from_column == column {
            return Ok(on_delete.eq_ignore_ascii_case(expected_action));
        }
    }
    Ok(false)
}

fn ensure_column(
    connection: &Connection,
    table: &'static str,
    column: &'static str,
    definition: &'static str,
) -> Result<(), PersistenceError> {
    if table_columns(connection, table)?
        .iter()
        .any(|existing| existing == column)
    {
        return Ok(());
    }

    connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition};"
    ))?;
    Ok(())
}

pub fn validate_schema(connection: &Connection) -> Result<(), PersistenceError> {
    for (table, required_columns) in REQUIRED_TABLES {
        if !table_exists(connection, table)? {
            return Err(PersistenceError::MissingRequiredTable(table));
        }

        let columns = table_columns(connection, table)?;
        for required_column in *required_columns {
            if !columns.iter().any(|column| column == required_column) {
                return Err(PersistenceError::MissingRequiredColumn {
                    table,
                    column: required_column,
                });
            }
        }
    }

    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), PersistenceError> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        ",
    )?;

    Ok(())
}

fn table_exists(connection: &Connection, table: &'static str) -> Result<bool, PersistenceError> {
    let found = connection
        .query_row(
            "
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name = ?1
            ",
            [table],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(found.is_some())
}

fn table_columns(
    connection: &Connection,
    table: &'static str,
) -> Result<Vec<String>, PersistenceError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(columns)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn opens_current_schema_and_writes_metadata_idempotently() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        create_current_schema(&database_path);

        let (store, output) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path: database_path.clone(),
            mode: NativePersistenceMode::Shadow,
        })
        .expect("store opens");

        assert_eq!(output.schema_version, STORAGE_SCHEMA_VERSION);
        assert!(output.metadata_ready);
        assert_eq!(store.health().project_count, 0);

        drop(store);

        let (store, second_output) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path,
            mode: NativePersistenceMode::Write,
        })
        .expect("store reopens");

        assert!(second_output.metadata_ready);
        assert_eq!(
            metadata_value(store.connection(), "native.schema_version"),
            "1"
        );
        assert_eq!(
            metadata_value(store.connection(), "native.storage_mode"),
            "write"
        );
    }

    #[test]
    fn rejects_missing_schema_with_typed_error() {
        let connection = Connection::open_in_memory().expect("db");

        let error = validate_schema(&connection).expect_err("schema should be missing");

        assert!(matches!(
            error,
            PersistenceError::MissingRequiredTable("projects")
        ));
        assert_eq!(
            error.native_code(),
            comando_types::error::NativeErrorCode::UnsupportedSchemaVersion
        );
    }

    #[test]
    fn creates_missing_database_with_current_schema() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("fresh.sqlite3");

        let (store, output) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path: database_path.clone(),
            mode: NativePersistenceMode::Shadow,
        })
        .expect("fresh database opens");

        assert!(database_path.exists());
        assert!(output.opened);
        assert!(output.metadata_ready);
        assert_eq!(store.health().project_count, 0);
        assert_eq!(
            metadata_value(store.connection(), "native.schema_version"),
            "1"
        );
    }

    #[test]
    fn migrates_worktree_owned_foreign_keys_to_cascade() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("legacy.sqlite3");
        create_current_schema(&database_path);
        let connection = Connection::open(&database_path).expect("db");
        connection
            .execute_batch(
                "
                CREATE TABLE workspace_layouts (
                    id TEXT PRIMARY KEY,
                    root_node_json TEXT NOT NULL,
                    active_pane_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE workspace_tabs (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspace_layouts(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
                    position INTEGER NOT NULL
                );
                CREATE TABLE chat_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
                    parent_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
                    title TEXT NOT NULL,
                    runtime TEXT NOT NULL DEFAULT 'pending',
                    runtime_session_id TEXT,
                    status TEXT NOT NULL DEFAULT 'idle',
                    draft TEXT NOT NULL DEFAULT '',
                    pinned_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_opened_at TEXT NOT NULL
                );
                ",
            )
            .expect("legacy owned tables");
        drop(connection);

        let (store, _) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path,
            mode: NativePersistenceMode::Write,
        })
        .expect("migrate store");

        assert!(
            foreign_key_uses_action(
                store.connection(),
                "workspace_tabs",
                "worktree_id",
                "CASCADE"
            )
            .expect("workspace tabs action")
        );
        assert!(
            foreign_key_uses_action(
                store.connection(),
                "chat_sessions",
                "worktree_id",
                "CASCADE"
            )
            .expect("chat sessions action")
        );
    }

    #[test]
    fn reports_visible_project_and_worktree_counts() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("comando.sqlite3");
        create_current_schema(&database_path);
        let connection = Connection::open(&database_path).expect("db");
        connection
            .execute(
                "
                INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at, is_hidden)
                VALUES ('visible', 'Visible', '/tmp/visible', 'now', 'now', 0),
                       ('hidden', 'Hidden', '/tmp/hidden', 'now', 'now', 1)
                ",
                [],
            )
            .expect("insert projects");
        connection
            .execute(
                "
                INSERT INTO project_worktrees (
                    id, project_id, root_path, branch_name, head_sha, is_primary, created_at, updated_at
                )
                VALUES ('visible:primary', 'visible', '/tmp/visible', NULL, NULL, 1, 'now', 'now'),
                       ('hidden:primary', 'hidden', '/tmp/hidden', NULL, NULL, 1, 'now', 'now')
                ",
                [],
            )
            .expect("insert worktrees");
        drop(connection);

        let (store, _) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path,
            mode: NativePersistenceMode::Shadow,
        })
        .expect("store opens");

        let health = store.health();
        assert_eq!(health.project_count, 1);
        assert_eq!(health.worktree_count, 1);
    }

    fn metadata_value(connection: &Connection, key: &str) -> String {
        connection
            .query_row(
                "SELECT value FROM native_backend_metadata WHERE key = ?",
                [key],
                |row| row.get(0),
            )
            .expect("metadata value")
    }

    fn create_current_schema(database_path: &std::path::Path) {
        let connection = Connection::open(database_path).expect("db");
        connection
            .execute_batch(
                "
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    canonical_root_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_hidden INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE project_roots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    root_path TEXT NOT NULL UNIQUE,
                    is_primary INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE project_worktrees (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    root_path TEXT NOT NULL UNIQUE,
                    branch_name TEXT,
                    head_sha TEXT,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE recent_projects (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    last_opened_at TEXT NOT NULL
                );
                CREATE TABLE workspace_sessions (
                    id TEXT PRIMARY KEY,
                    active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    active_worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
                    last_opened_at TEXT NOT NULL
                );
                ",
            )
            .expect("schema");
    }
}
