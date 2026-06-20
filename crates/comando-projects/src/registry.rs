use comando_types::projects::{
    NativeProjectAddResult, NativeProjectListResult, NativeProjectState, NativeProjectSummary,
    NativeWorktreeSummary,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use crate::error::ProjectRegistryError;
use crate::paths::{ProjectPathMetadata, resolve_project_path_metadata};

struct ProjectRow {
    id: String,
    name: String,
    canonical_root_path: String,
    created_at: String,
    updated_at: String,
    last_opened_at: Option<String>,
}

struct WorktreeRow {
    id: String,
    project_id: String,
    root_path: String,
    branch_name: Option<String>,
    head_sha: Option<String>,
    is_primary: i64,
    updated_at: String,
}

pub struct ProjectRegistry<'a> {
    connection: &'a mut Connection,
}

impl<'a> ProjectRegistry<'a> {
    pub fn new(connection: &'a mut Connection) -> Self {
        Self { connection }
    }

    pub fn list_projects(&mut self) -> Result<NativeProjectListResult, ProjectRegistryError> {
        let state = load_project_state(self.connection)?;
        Ok(NativeProjectListResult {
            projects: state.projects,
            worktrees: state.worktrees,
        })
    }

    pub fn add_project_paths(
        &mut self,
        project_paths: &[String],
    ) -> Result<NativeProjectAddResult, ProjectRegistryError> {
        if project_paths.is_empty() {
            return Err(ProjectRegistryError::EmptyProjectPaths);
        }

        let path_metadata = project_paths
            .iter()
            .map(resolve_project_path_metadata)
            .collect::<Result<Vec<_>, _>>()?;
        let transaction = self.connection.transaction()?;
        let mut project_ids_to_open = Vec::new();
        let mut touched_root_paths = Vec::new();

        for metadata in &path_metadata {
            let project_id = add_project_path(&transaction, metadata)?;
            project_ids_to_open.push(comando_types::ids::ProjectId(project_id));
            touched_root_paths.push(metadata.worktree_root_path.clone());
        }

        transaction.commit()?;

        let state = load_project_state(self.connection)?;
        Ok(NativeProjectAddResult {
            project_ids_to_open,
            projects: state.projects.clone(),
            state,
            touched_root_paths,
        })
    }
}

pub fn load_project_state(
    connection: &Connection,
) -> Result<NativeProjectState, ProjectRegistryError> {
    Ok(NativeProjectState {
        projects: list_project_records(connection)?,
        worktrees: list_visible_worktrees(connection)?,
    })
}

fn add_project_path(
    transaction: &Transaction<'_>,
    metadata: &ProjectPathMetadata,
) -> Result<String, ProjectRegistryError> {
    let now = comando_persistence::store::now_rfc3339();
    let existing_project_id = transaction
        .query_row(
            "
            SELECT id
            FROM projects
            WHERE canonical_root_path = ?1
            ",
            [&metadata.canonical_root_path],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    let project_id = match existing_project_id {
        Some(project_id) => {
            transaction.execute(
                "
                UPDATE projects
                SET name = ?1,
                    updated_at = ?2,
                    is_hidden = 0
                WHERE id = ?3
                  AND canonical_root_path = ?4
                ",
                params![metadata.name, now, project_id, metadata.canonical_root_path],
            )?;
            project_id
        }
        None => {
            let project_id = Uuid::new_v4().to_string();
            transaction.execute(
                "
                INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ",
                params![
                    project_id,
                    metadata.name,
                    metadata.canonical_root_path,
                    now,
                    now
                ],
            )?;
            project_id
        }
    };

    ensure_project_roots(transaction, &project_id, metadata)?;
    ensure_primary_worktree(
        transaction,
        &project_id,
        &metadata.canonical_root_path,
        &now,
    )?;
    if metadata.worktree_root_path != metadata.canonical_root_path {
        ensure_secondary_worktree(transaction, &project_id, &metadata.worktree_root_path, &now)?;
    }
    touch_recent_project(transaction, &project_id, &now)?;

    Ok(project_id)
}

fn ensure_project_roots(
    transaction: &Transaction<'_>,
    project_id: &str,
    metadata: &ProjectPathMetadata,
) -> Result<(), ProjectRegistryError> {
    transaction.execute(
        "
        INSERT OR IGNORE INTO project_roots (project_id, root_path, is_primary)
        VALUES (?1, ?2, 1)
        ",
        params![project_id, metadata.canonical_root_path],
    )?;

    if metadata.worktree_root_path != metadata.canonical_root_path {
        transaction.execute(
            "
            INSERT OR IGNORE INTO project_roots (project_id, root_path, is_primary)
            VALUES (?1, ?2, 0)
            ",
            params![project_id, metadata.worktree_root_path],
        )?;
    }

    Ok(())
}

fn ensure_primary_worktree(
    transaction: &Transaction<'_>,
    project_id: &str,
    root_path: &str,
    now: &str,
) -> Result<(), ProjectRegistryError> {
    let worktree_id = format!("{project_id}:primary");
    transaction.execute(
        "
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
        VALUES (?1, ?2, ?3, NULL, NULL, 1, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            root_path = excluded.root_path,
            branch_name = excluded.branch_name,
            head_sha = excluded.head_sha,
            is_primary = 1,
            updated_at = excluded.updated_at
        ",
        params![worktree_id, project_id, root_path, now, now],
    )?;

    Ok(())
}

fn ensure_secondary_worktree(
    transaction: &Transaction<'_>,
    project_id: &str,
    root_path: &str,
    now: &str,
) -> Result<String, ProjectRegistryError> {
    let existing_id = transaction
        .query_row(
            "
            SELECT id
            FROM project_worktrees
            WHERE root_path = ?1
            ",
            [root_path],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if let Some(existing_id) = existing_id {
        return Ok(existing_id);
    }

    let worktree_id = Uuid::new_v4().to_string();
    transaction.execute(
        "
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
        VALUES (?1, ?2, ?3, NULL, NULL, 0, ?4, ?5)
        ",
        params![worktree_id, project_id, root_path, now, now],
    )?;

    Ok(worktree_id)
}

fn touch_recent_project(
    transaction: &Transaction<'_>,
    project_id: &str,
    now: &str,
) -> Result<(), ProjectRegistryError> {
    transaction.execute(
        "
        INSERT INTO recent_projects (project_id, last_opened_at)
        VALUES (?1, ?2)
        ON CONFLICT(project_id) DO UPDATE SET
            last_opened_at = excluded.last_opened_at
        ",
        params![project_id, now],
    )?;

    Ok(())
}

fn list_project_records(
    connection: &Connection,
) -> Result<Vec<NativeProjectSummary>, ProjectRegistryError> {
    let mut statement = connection.prepare(
        "
        SELECT
            projects.id,
            projects.name,
            projects.canonical_root_path,
            projects.created_at,
            projects.updated_at,
            recent_projects.last_opened_at
        FROM projects
        LEFT JOIN recent_projects
            ON recent_projects.project_id = projects.id
        WHERE projects.is_hidden = 0
        ORDER BY
            recent_projects.last_opened_at IS NULL,
            recent_projects.last_opened_at DESC,
            projects.name COLLATE NOCASE ASC
        ",
    )?;

    let rows = statement.query_map([], |row| {
        Ok(ProjectRow {
            id: row.get(0)?,
            name: row.get(1)?,
            canonical_root_path: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            last_opened_at: row.get(5)?,
        })
    })?;

    rows.map(|row| row.map(map_project_row))
        .collect::<Result<Vec<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn list_visible_worktrees(
    connection: &Connection,
) -> Result<Vec<NativeWorktreeSummary>, ProjectRegistryError> {
    let mut statement = connection.prepare(
        "
        SELECT
            project_worktrees.id,
            project_worktrees.project_id,
            project_worktrees.root_path,
            project_worktrees.branch_name,
            project_worktrees.head_sha,
            project_worktrees.is_primary,
            project_worktrees.updated_at
        FROM project_worktrees
        INNER JOIN projects
            ON projects.id = project_worktrees.project_id
        WHERE projects.is_hidden = 0
        ORDER BY
            project_worktrees.project_id,
            project_worktrees.is_primary DESC,
            project_worktrees.root_path COLLATE NOCASE ASC
        ",
    )?;

    let rows = statement.query_map([], |row| {
        Ok(WorktreeRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            root_path: row.get(2)?,
            branch_name: row.get(3)?,
            head_sha: row.get(4)?,
            is_primary: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    rows.map(|row| row.map(map_worktree_row))
        .collect::<Result<Vec<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn map_project_row(row: ProjectRow) -> NativeProjectSummary {
    NativeProjectSummary {
        id: comando_types::ids::ProjectId(row.id),
        name: row.name,
        canonical_root_path: Some(row.canonical_root_path.clone()),
        root_path: row.canonical_root_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_opened_at: row.last_opened_at,
    }
}

fn map_worktree_row(row: WorktreeRow) -> NativeWorktreeSummary {
    NativeWorktreeSummary {
        id: comando_types::ids::WorktreeId(row.id),
        project_id: comando_types::ids::ProjectId(row.project_id),
        root_path: row.root_path,
        branch_name: row.branch_name,
        head_sha: row.head_sha,
        is_primary: row.is_primary == 1,
        updated_at: row.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn lists_visible_projects_with_primary_worktrees() {
        let temp_dir = TempDir::new().expect("temp dir");
        let visible_root = create_dir(temp_dir.path(), "visible");
        let hidden_root = create_dir(temp_dir.path(), "hidden");
        let mut connection = create_current_schema();
        seed_project(&connection, "visible", "Visible", &visible_root, 0);
        seed_project(&connection, "hidden", "Hidden", &hidden_root, 1);

        let state = ProjectRegistry::new(&mut connection)
            .list_projects()
            .expect("list projects");

        assert_eq!(state.projects.len(), 1);
        assert_eq!(state.projects[0].id.0, "visible");
        assert_eq!(state.worktrees.len(), 1);
        assert_eq!(state.worktrees[0].id.0, "visible:primary");
    }

    #[test]
    fn add_project_creates_root_recent_project_and_primary_worktree() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "alpha");
        let mut connection = create_current_schema();

        let result = ProjectRegistry::new(&mut connection)
            .add_project_paths(&[project_root.clone()])
            .expect("add project");

        assert_eq!(result.project_ids_to_open.len(), 1);
        assert_eq!(result.touched_root_paths, vec![project_root.clone()]);
        assert_eq!(result.state.projects.len(), 1);
        assert_eq!(result.state.projects[0].root_path, project_root);
        assert_eq!(result.state.worktrees.len(), 1);
        assert!(result.state.worktrees[0].is_primary);
        assert_eq!(count_rows(&connection, "project_roots"), 1);
        assert_eq!(count_rows(&connection, "recent_projects"), 1);
    }

    #[test]
    fn add_same_path_twice_reuses_project_id() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "same");
        let mut connection = create_current_schema();

        let first = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("first add");
        let second = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("second add");

        assert_eq!(first.project_ids_to_open, second.project_ids_to_open);
        assert_eq!(second.state.projects.len(), 1);
        assert_eq!(second.state.worktrees.len(), 1);
    }

    #[test]
    fn reopens_hidden_project_and_reuses_id() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "hidden-reopen");
        let mut connection = create_current_schema();

        let first = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("first add");
        let project_id = first.project_ids_to_open[0].0.clone();
        connection
            .execute(
                "UPDATE projects SET is_hidden = 1 WHERE id = ?1",
                [&project_id],
            )
            .expect("hide project");

        let reopened = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("reopen");

        assert_eq!(reopened.project_ids_to_open[0].0, project_id);
        assert_eq!(reopened.state.projects.len(), 1);
    }

    #[test]
    fn add_multiple_paths_is_transactional_on_invalid_path() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "valid");
        let invalid_root = temp_dir.path().join("missing");
        let mut connection = create_current_schema();

        let error = ProjectRegistry::new(&mut connection)
            .add_project_paths(&[project_root, invalid_root.to_string_lossy().into_owned()])
            .expect_err("invalid path should fail");

        assert!(matches!(error, ProjectRegistryError::DirectoryNotFound(_)));
        assert_eq!(count_rows(&connection, "projects"), 0);
    }

    fn create_current_schema() -> Connection {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
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
        connection
    }

    fn seed_project(
        connection: &Connection,
        id: &str,
        name: &str,
        root_path: &str,
        is_hidden: i64,
    ) {
        connection
            .execute(
                "
                INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at, is_hidden)
                VALUES (?1, ?2, ?3, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', ?4)
                ",
                params![id, name, root_path, is_hidden],
            )
            .expect("insert project");
        connection
            .execute(
                "
                INSERT INTO project_worktrees (
                    id, project_id, root_path, branch_name, head_sha, is_primary, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, NULL, NULL, 1, '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')
                ",
                params![format!("{id}:primary"), id, root_path],
            )
            .expect("insert worktree");
    }

    fn create_dir(root: &std::path::Path, name: &str) -> String {
        let path = root.join(name);
        std::fs::create_dir_all(&path).expect("create project dir");
        path.canonicalize()
            .expect("canonical project dir")
            .to_string_lossy()
            .into_owned()
    }

    fn count_rows(connection: &Connection, table: &str) -> u64 {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rows");
        u64::try_from(count).unwrap_or(0)
    }
}
