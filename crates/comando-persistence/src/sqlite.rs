use std::path::{Path, PathBuf};
use std::time::Duration;

use comando_types::persistence::{
    NativePersistenceMode, NativePersistenceOpenStoreOutput, NativePersistenceStorageHealth,
};
use rusqlite::{Connection, OptionalExtension};

use crate::error::PersistenceError;

pub const STORAGE_SCHEMA_VERSION: &str = "2";
pub const STORAGE_MODE_SQLITE_CURRENT: &str = "sqlite-current";

const DURABLE_WORKSPACE_SCHEMA_MIGRATION_ID: &str = "2026-07-31-durable-workspaces-v4";

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
    (
        "durable_workspaces",
        &[
            "scope_key",
            "project_id",
            "worktree_id",
            "runtime_owner_id",
            "layout_snapshot_json",
            "layout_revision",
            "lifecycle",
            "last_activated_at",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "app_workspace_navigation",
        &[
            "singleton_id",
            "active_scope_key",
            "recent_scope_keys_json",
            "shell_snapshot_json",
            "revision",
            "updated_at",
        ],
    ),
    (
        "workspace_layout_recovery",
        &[
            "id",
            "scope_key",
            "source_window_id",
            "source_workspace_id",
            "source_revision",
            "source_updated_at",
            "snapshot_hash",
            "layout_snapshot_json",
            "created_at",
        ],
    ),
    (
        "workspace_migrations",
        &[
            "migration_id",
            "source_checksum",
            "source_backup_ref",
            "status",
            "started_at",
            "completed_at",
        ],
    ),
    (
        "workspace_deletion_journal",
        &[
            "operation_id",
            "scope_key",
            "checkout_path",
            "status",
            "force_approved",
            "error_code",
            "started_at",
            "updated_at",
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

        let mut connection = Connection::open(&config.database_path).map_err(|source| {
            PersistenceError::OpenStorage {
                path: config.database_path.clone(),
                source,
            }
        })?;
        configure_connection(&connection)?;
        ensure_current_schema(&connection)?;
        ensure_durable_workspace_schema(&mut connection)?;
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
            worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
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

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DurableSchemaFailpoint {
    None,
    AfterTables,
    AfterSingletonSeed,
}

fn ensure_durable_workspace_schema(connection: &mut Connection) -> Result<(), PersistenceError> {
    ensure_durable_workspace_schema_with_failpoint(connection, DurableSchemaFailpoint::None)
}

fn ensure_durable_workspace_schema_with_failpoint(
    connection: &mut Connection,
    failpoint: DurableSchemaFailpoint,
) -> Result<(), PersistenceError> {
    let already_applied = connection
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE id = ?1",
            [DURABLE_WORKSPACE_SCHEMA_MIGRATION_ID],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if already_applied {
        return Ok(());
    }

    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "
        CREATE TABLE durable_workspaces (
            scope_key TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            worktree_id TEXT,
            runtime_owner_id TEXT NOT NULL UNIQUE,
            layout_snapshot_json TEXT NOT NULL,
            layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(layout_revision >= 0),
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'orphaned', 'archived')),
            last_activated_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE app_workspace_navigation (
            singleton_id TEXT PRIMARY KEY CHECK(singleton_id = 'main'),
            active_scope_key TEXT REFERENCES durable_workspaces(scope_key) ON DELETE SET NULL,
            recent_scope_keys_json TEXT NOT NULL DEFAULT '[]',
            shell_snapshot_json TEXT NOT NULL DEFAULT '{}',
            revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
            updated_at TEXT NOT NULL
        );

        CREATE TABLE workspace_layout_recovery (
            id TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL REFERENCES durable_workspaces(scope_key) ON DELETE CASCADE,
            source_window_id TEXT,
            source_workspace_id TEXT,
            source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
            source_updated_at TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            layout_snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE workspace_migrations (
            migration_id TEXT PRIMARY KEY,
            source_checksum TEXT NOT NULL,
            source_backup_ref TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('not_started', 'running', 'complete', 'failed')),
            started_at TEXT NOT NULL,
            completed_at TEXT
        );

        CREATE TABLE workspace_deletion_journal (
            operation_id TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL,
            checkout_path TEXT,
            status TEXT NOT NULL CHECK(status IN (
                'pending', 'checkout_deleted', 'purging', 'completed', 'failed'
            )),
            force_approved INTEGER NOT NULL DEFAULT 0 CHECK(force_approved IN (0, 1)),
            error_code TEXT,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_durable_workspaces_project_id
            ON durable_workspaces(project_id);
        CREATE INDEX idx_durable_workspaces_lifecycle_recency
            ON durable_workspaces(lifecycle, last_activated_at DESC, updated_at DESC);
        CREATE INDEX idx_workspace_layout_recovery_scope_key
            ON workspace_layout_recovery(scope_key, created_at DESC);
        CREATE INDEX idx_workspace_deletion_journal_scope_status
            ON workspace_deletion_journal(scope_key, status);
        ",
    )?;

    if failpoint == DurableSchemaFailpoint::AfterTables {
        return Err(PersistenceError::MigrationInterrupted("after_tables"));
    }

    transaction.execute(
        "
        INSERT INTO app_workspace_navigation (
            singleton_id,
            active_scope_key,
            recent_scope_keys_json,
            shell_snapshot_json,
            revision,
            updated_at
        ) VALUES (?1, NULL, '[]', '{}', 0, ?2)
        ",
        rusqlite::params![
            comando_types::workspace::APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
            crate::store::now_rfc3339(),
        ],
    )?;

    if failpoint == DurableSchemaFailpoint::AfterSingletonSeed {
        return Err(PersistenceError::MigrationInterrupted(
            "after_singleton_seed",
        ));
    }

    transaction.execute(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)",
        rusqlite::params![
            DURABLE_WORKSPACE_SCHEMA_MIGRATION_ID,
            crate::store::now_rfc3339(),
        ],
    )?;
    transaction.commit()?;
    Ok(())
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
            "2"
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
            "2"
        );
    }

    #[test]
    fn migrates_legacy_storage_without_mutating_v3_rows() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("legacy.sqlite3");
        create_current_schema(&database_path);
        let connection = Connection::open(&database_path).expect("db");
        connection
            .execute(
                "
                INSERT INTO workspace_sessions (
                    id, active_project_id, active_worktree_id, last_opened_at
                ) VALUES ('legacy-window', NULL, NULL, '2026-07-30T00:00:00Z')
                ",
                [],
            )
            .expect("legacy row");
        drop(connection);

        let (store, output) = SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path,
            mode: NativePersistenceMode::Write,
        })
        .expect("legacy database migrates");

        assert_eq!(output.schema_version, "2");
        let legacy_last_opened: String = store
            .connection()
            .query_row(
                "SELECT last_opened_at FROM workspace_sessions WHERE id = 'legacy-window'",
                [],
                |row| row.get(0),
            )
            .expect("legacy row remains");
        assert_eq!(legacy_last_opened, "2026-07-30T00:00:00Z");
        assert!(table_exists(store.connection(), "durable_workspaces").unwrap());
        assert_eq!(
            store
                .connection()
                .query_row("SELECT COUNT(*) FROM durable_workspaces", [], |row| row
                    .get::<_, i64>(0),)
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT COUNT(*) FROM app_workspace_navigation", [], |row| {
                    row.get::<_, i64>(0)
                },)
                .unwrap(),
            1
        );
    }

    #[test]
    fn durable_schema_failpoints_roll_back_the_entire_migration() {
        for failpoint in [
            DurableSchemaFailpoint::AfterTables,
            DurableSchemaFailpoint::AfterSingletonSeed,
        ] {
            let mut connection = Connection::open_in_memory().expect("db");
            configure_connection(&connection).expect("connection config");
            ensure_current_schema(&connection).expect("legacy schema");

            let error = ensure_durable_workspace_schema_with_failpoint(&mut connection, failpoint)
                .expect_err("failpoint interrupts migration");

            assert!(matches!(error, PersistenceError::MigrationInterrupted(_)));
            assert!(!table_exists(&connection, "durable_workspaces").unwrap());
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM schema_migrations WHERE id = ?1",
                        [DURABLE_WORKSPACE_SCHEMA_MIGRATION_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0
            );

            ensure_durable_workspace_schema(&mut connection)
                .expect("migration retries after rollback");
            assert!(table_exists(&connection, "durable_workspaces").unwrap());
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM app_workspace_navigation", [], |row| {
                        row.get::<_, i64>(0)
                    },)
                    .unwrap(),
                1
            );
        }
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
