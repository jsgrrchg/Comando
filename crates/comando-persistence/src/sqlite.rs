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

        let connection = Connection::open(&config.database_path).map_err(|source| {
            PersistenceError::OpenStorage {
                path: config.database_path.clone(),
                source,
            }
        })?;
        configure_connection(&connection)?;
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
