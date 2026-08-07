use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use comando_types::projects::{
    NativeProjectAddResult, NativeProjectAppDataSummary, NativeProjectClearAppDataResult,
    NativeProjectListResult, NativeProjectRelocateResult, NativeProjectState, NativeProjectSummary,
    NativeProjectSyncWorktree, NativeWorktreeSummary,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};
use uuid::Uuid;

use crate::error::ProjectRegistryError;
use crate::paths::{
    ProjectPathMetadata, normalize_lexical_path, path_to_storage_string,
    resolve_project_path_metadata,
};

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

    pub fn remove_project(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
    ) -> Result<NativeProjectState, ProjectRegistryError> {
        let transaction = self.connection.transaction()?;
        let updated = transaction.execute(
            "
            UPDATE projects
            SET is_hidden = 1
            WHERE id = ?1
              AND is_hidden = 0
            ",
            [&project_id.0],
        )?;
        if updated == 0 {
            return Err(ProjectRegistryError::ProjectNotFound);
        }
        transaction.execute(
            "DELETE FROM recent_projects WHERE project_id = ?1",
            [&project_id.0],
        )?;
        let archived_scope_keys = project_scope_keys(&transaction, &project_id.0)?;
        transaction.execute(
            "UPDATE durable_workspaces SET lifecycle = 'archived', updated_at = ?1 WHERE project_id = ?2 AND lifecycle <> 'archived'",
            params![comando_persistence::store::now_rfc3339(), project_id.0],
        )?;
        remove_navigation_scopes(&transaction, &archived_scope_keys)?;
        transaction.commit()?;

        load_project_state(self.connection)
    }

    pub fn touch_project(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
    ) -> Result<NativeProjectState, ProjectRegistryError> {
        if load_project_record(self.connection, &project_id.0)?.is_none() {
            return Err(ProjectRegistryError::ProjectNotFound);
        }

        let now = comando_persistence::store::now_rfc3339();
        let transaction = self.connection.transaction()?;
        touch_recent_project(&transaction, &project_id.0, &now)?;
        transaction.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![now, project_id.0],
        )?;
        transaction.commit()?;

        load_project_state(self.connection)
    }

    pub fn relocate_project(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
        project_path: &str,
    ) -> Result<NativeProjectRelocateResult, ProjectRegistryError> {
        if load_project_record(self.connection, &project_id.0)?.is_none() {
            return Err(ProjectRegistryError::ProjectNotFound);
        }
        let metadata = resolve_project_path_metadata(project_path)?;
        assert_relocation_does_not_conflict(self.connection, &project_id.0, &metadata)?;
        let now = comando_persistence::store::now_rfc3339();
        let primary_worktree_id = format!("{}:primary", project_id.0);
        let transaction = self.connection.transaction()?;

        release_hidden_project_paths(&transaction, &project_id.0, &metadata)?;
        transaction.execute(
            "
            UPDATE projects
            SET canonical_root_path = 'hidden:' || id || ':' || canonical_root_path,
                updated_at = ?1
            WHERE canonical_root_path = ?2
              AND id <> ?3
              AND is_hidden = 1
            ",
            params![now, metadata.canonical_root_path, project_id.0],
        )?;
        transaction.execute(
            "
            UPDATE projects
            SET name = ?1,
                canonical_root_path = ?2,
                updated_at = ?3,
                is_hidden = 0
            WHERE id = ?4
            ",
            params![
                metadata.name,
                metadata.canonical_root_path,
                now,
                project_id.0
            ],
        )?;
        transaction.execute(
            "DELETE FROM project_roots WHERE project_id = ?1",
            [&project_id.0],
        )?;
        ensure_project_roots(&transaction, &project_id.0, &metadata)?;
        transaction.execute(
            "
            DELETE FROM project_worktrees
            WHERE project_id = ?1
              AND root_path = ?2
              AND id <> ?3
            ",
            params![
                project_id.0,
                metadata.canonical_root_path,
                primary_worktree_id
            ],
        )?;
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
            params![
                primary_worktree_id,
                project_id.0,
                metadata.canonical_root_path,
                now,
                now
            ],
        )?;
        if metadata.worktree_root_path != metadata.canonical_root_path {
            ensure_secondary_worktree(
                &transaction,
                &project_id.0,
                &metadata.worktree_root_path,
                &now,
            )?;
        }
        touch_recent_project(&transaction, &project_id.0, &now)?;
        transaction.commit()?;

        let state = load_project_state(self.connection)?;
        let project = state
            .projects
            .iter()
            .find(|candidate| candidate.id == *project_id)
            .cloned()
            .ok_or(ProjectRegistryError::ProjectNotFound)?;

        Ok(NativeProjectRelocateResult {
            project,
            state,
            touched_root_paths: vec![metadata.worktree_root_path],
        })
    }

    pub fn get_project_app_data_summary(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
    ) -> Result<NativeProjectAppDataSummary, ProjectRegistryError> {
        if load_project_record(self.connection, &project_id.0)?.is_none() {
            return Err(ProjectRegistryError::ProjectNotFound);
        }
        project_app_data_summary(self.connection, &project_id.0)
    }

    pub fn clear_project_app_data(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
    ) -> Result<NativeProjectClearAppDataResult, ProjectRegistryError> {
        if load_project_record(self.connection, &project_id.0)?.is_none() {
            return Err(ProjectRegistryError::ProjectNotFound);
        }
        let cleared = project_app_data_summary(self.connection, &project_id.0)?;
        let worktree_ids = list_project_worktree_ids(self.connection, &project_id.0)?;
        let workspace_layout_ids =
            list_project_workspace_layout_ids(self.connection, &project_id.0, &worktree_ids)?;
        let has_legacy_recovery = has_legacy_recovery_table(self.connection)?;
        let transaction = self.connection.transaction()?;

        transaction.execute(
            "
            DELETE FROM review_artifacts
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?1
            )
            ",
            [&project_id.0],
        )?;
        transaction.execute(
            "
            DELETE FROM chat_session_events
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?1
            )
            ",
            [&project_id.0],
        )?;
        transaction.execute(
            "
            DELETE FROM chat_transcripts
            WHERE session_id IN (
                SELECT id
                FROM chat_sessions
                WHERE project_id = ?1
            )
            ",
            [&project_id.0],
        )?;
        transaction.execute(
            "DELETE FROM chat_sessions WHERE project_id = ?1",
            [&project_id.0],
        )?;
        transaction.execute(
            "DELETE FROM project_settings WHERE project_id = ?1",
            [&project_id.0],
        )?;
        transaction.execute(
            "DELETE FROM recent_projects WHERE project_id = ?1",
            [&project_id.0],
        )?;
        transaction.execute(
            "
            DELETE FROM workspace_tabs
            WHERE json_valid(payload_json)
              AND json_extract(payload_json, '$.projectId') = ?1
            ",
            [&project_id.0],
        )?;
        if !worktree_ids.is_empty() {
            transaction.execute(
                &format!(
                    "DELETE FROM workspace_tabs WHERE worktree_id IN ({})",
                    placeholders(worktree_ids.len())
                ),
                params_from_iter(worktree_ids.iter()),
            )?;
        }
        if !workspace_layout_ids.is_empty() {
            transaction.execute(
                &format!(
                    "DELETE FROM workspace_layouts WHERE id IN ({})",
                    placeholders(workspace_layout_ids.len())
                ),
                params_from_iter(workspace_layout_ids.iter()),
            )?;
        }
        transaction.execute(
            "
            UPDATE workspace_sessions
            SET active_project_id = NULL,
                active_worktree_id = NULL,
                shell_state_json = NULL
            WHERE active_project_id = ?1
            ",
            [&project_id.0],
        )?;
        if !worktree_ids.is_empty() {
            transaction.execute(
                &format!(
                    "
                    UPDATE workspace_sessions
                    SET active_project_id = NULL,
                        active_worktree_id = NULL,
                        shell_state_json = NULL
                    WHERE active_worktree_id IN ({})
                    ",
                    placeholders(worktree_ids.len())
                ),
                params_from_iter(worktree_ids.iter()),
            )?;
        }
        let scope_keys = project_scope_keys(&transaction, &project_id.0)?;
        remove_navigation_scopes(&transaction, &scope_keys)?;
        if has_legacy_recovery {
            // Older databases can retain recovery rows after the feature is retired.
            transaction.execute(
                "DELETE FROM workspace_layout_recovery WHERE scope_key IN (SELECT scope_key FROM durable_workspaces WHERE project_id = ?1)",
                [&project_id.0],
            )?;
        }
        transaction.execute(
            "DELETE FROM durable_workspaces WHERE project_id = ?1",
            [&project_id.0],
        )?;
        transaction.commit()?;

        Ok(NativeProjectClearAppDataResult {
            cleared,
            state: load_project_state(self.connection)?,
        })
    }

    pub fn sync_project_worktrees(
        &mut self,
        project_id: &comando_types::ids::ProjectId,
        worktrees: &[NativeProjectSyncWorktree],
    ) -> Result<Vec<NativeWorktreeSummary>, ProjectRegistryError> {
        let project = load_project_record(self.connection, &project_id.0)?
            .ok_or(ProjectRegistryError::ProjectNotFound)?;
        let project_root_path = normalize_storage_path(&project.canonical_root_path);
        let project_root_key = normalize_worktree_key(&project_root_path);
        let mut desired_worktrees = worktrees
            .iter()
            .map(|worktree| {
                let root_path = normalize_storage_path(&worktree.root_path);
                (
                    normalize_worktree_key(&root_path),
                    DesiredWorktree {
                        root_path,
                        branch_name: worktree.branch_name.clone(),
                        head_sha: worktree.head_sha.clone(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();

        desired_worktrees
            .entry(project_root_key.clone())
            .or_insert_with(|| DesiredWorktree {
                root_path: project_root_path.clone(),
                branch_name: None,
                head_sha: None,
            });

        let existing_rows = list_project_worktree_rows(self.connection, &project_id.0)?;
        let existing_by_path = preferred_existing_worktrees(
            &existing_rows,
            &desired_worktrees,
            &project_id.0,
            &project_root_key,
        );
        let retained_existing_ids = existing_by_path
            .iter()
            .filter(|(root_key, _)| desired_worktrees.contains_key(*root_key))
            .map(|(_, row)| row.id.clone())
            .collect::<BTreeSet<_>>();
        let now = comando_persistence::store::now_rfc3339();
        let transaction = self.connection.transaction()?;

        for existing in &existing_rows {
            let existing_root_key = normalize_worktree_key(&existing.root_path);
            if retained_existing_ids.contains(&existing.id) {
                continue;
            }
            if existing.is_primary == 1 && !desired_worktrees.contains_key(&existing_root_key) {
                continue;
            }
            // Preserve closed-session ownership before the worktree FK is cleared.
            transaction.execute(
                "INSERT OR IGNORE INTO workspace_scope_session_tombstones (scope_key, session_id, project_id, created_at) SELECT durable_workspaces.scope_key, chat_sessions.id, ?1, ?2 FROM durable_workspaces JOIN chat_sessions ON chat_sessions.project_id = durable_workspaces.project_id AND chat_sessions.worktree_id = durable_workspaces.worktree_id WHERE durable_workspaces.project_id = ?1 AND durable_workspaces.worktree_id = ?3",
                params![project_id.0, now, existing.id],
            )?;
            transaction.execute(
                "UPDATE durable_workspaces SET lifecycle = 'orphaned', updated_at = ?1 WHERE project_id = ?2 AND worktree_id = ?3 AND lifecycle <> 'orphaned'",
                params![now, project_id.0, existing.id],
            )?;
            transaction.execute(
                "DELETE FROM project_worktrees WHERE id = ?1",
                [&existing.id],
            )?;
        }

        for (root_key, desired) in desired_worktrees {
            let existing = existing_by_path.get(&root_key);
            let is_primary = root_key == project_root_key;
            let worktree_id = existing.map(|row| row.id.clone()).unwrap_or_else(|| {
                if is_primary {
                    format!("{}:primary", project_id.0)
                } else {
                    Uuid::new_v4().to_string()
                }
            });
            let created_at = existing
                .map(|row| row.updated_at.as_str())
                .unwrap_or(now.as_str());

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
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(id) DO UPDATE SET
                    root_path = excluded.root_path,
                    branch_name = excluded.branch_name,
                    head_sha = excluded.head_sha,
                    is_primary = excluded.is_primary,
                    updated_at = excluded.updated_at
                ",
                params![
                    worktree_id,
                    project_id.0,
                    desired.root_path,
                    desired.branch_name,
                    desired.head_sha,
                    if is_primary { 1 } else { 0 },
                    created_at,
                    now
                ],
            )?;
            transaction.execute(
                "UPDATE durable_workspaces SET lifecycle = 'active', updated_at = ?1 WHERE project_id = ?2 AND worktree_id = ?3 AND lifecycle = 'orphaned'",
                params![now, project_id.0, worktree_id],
            )?;
        }

        transaction.commit()?;
        list_project_worktrees(self.connection, &project_id.0)
    }
}

#[derive(Debug, Clone)]
struct DesiredWorktree {
    root_path: String,
    branch_name: Option<String>,
    head_sha: Option<String>,
}

pub fn load_project_state(
    connection: &Connection,
) -> Result<NativeProjectState, ProjectRegistryError> {
    Ok(NativeProjectState {
        projects: list_project_records(connection)?,
        worktrees: list_visible_worktrees(connection)?,
    })
}

fn project_scope_keys(
    connection: &Connection,
    project_id: &str,
) -> Result<BTreeSet<String>, ProjectRegistryError> {
    let mut statement =
        connection.prepare("SELECT scope_key FROM durable_workspaces WHERE project_id = ?1")?;
    let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn remove_navigation_scopes(
    connection: &Connection,
    scope_keys: &BTreeSet<String>,
) -> Result<(), ProjectRegistryError> {
    if scope_keys.is_empty() {
        return Ok(());
    }
    let (active_scope_key, recent_json, revision): (Option<String>, String, i64) =
        connection.query_row(
            "SELECT active_scope_key, recent_scope_keys_json, revision FROM app_workspace_navigation WHERE singleton_id = 'main'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let recent_scope_keys = serde_json::from_str::<Vec<String>>(&recent_json)
        .unwrap_or_default()
        .into_iter()
        .filter(|scope_key| !scope_keys.contains(scope_key))
        .collect::<Vec<_>>();
    connection.execute(
        "UPDATE app_workspace_navigation SET active_scope_key = ?1, recent_scope_keys_json = ?2, revision = ?3, updated_at = ?4 WHERE singleton_id = 'main'",
        params![
            active_scope_key.filter(|scope_key| !scope_keys.contains(scope_key)),
            serde_json::to_string(&recent_scope_keys).unwrap_or_else(|_| "[]".to_string()),
            revision.saturating_add(1),
            comando_persistence::store::now_rfc3339(),
        ],
    )?;
    Ok(())
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

    transaction.execute(
        "UPDATE durable_workspaces SET lifecycle = 'active', updated_at = ?1 WHERE project_id = ?2 AND lifecycle = 'archived'",
        params![now, project_id],
    )?;

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

fn assert_relocation_does_not_conflict(
    connection: &Connection,
    project_id: &str,
    metadata: &ProjectPathMetadata,
) -> Result<(), ProjectRegistryError> {
    let conflicting_project = connection
        .query_row(
            "
            SELECT name
            FROM projects
            WHERE canonical_root_path = ?1
              AND id <> ?2
              AND is_hidden = 0
            LIMIT 1
            ",
            params![metadata.canonical_root_path, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(name) = conflicting_project {
        return Err(ProjectRegistryError::ProjectPathAlreadyRegistered { name });
    }

    for root_path in [&metadata.canonical_root_path, &metadata.worktree_root_path] {
        let conflicting_worktree = connection
            .query_row(
                "
                SELECT project_worktrees.project_id
                FROM project_worktrees
                INNER JOIN projects
                    ON projects.id = project_worktrees.project_id
                WHERE root_path = ?1
                  AND project_worktrees.project_id <> ?2
                  AND projects.is_hidden = 0
                LIMIT 1
                ",
                params![root_path, project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if conflicting_worktree.is_some() {
            return Err(ProjectRegistryError::WorktreePathAlreadyRegistered);
        }
    }

    Ok(())
}

fn release_hidden_project_paths(
    transaction: &Transaction<'_>,
    project_id: &str,
    metadata: &ProjectPathMetadata,
) -> Result<(), ProjectRegistryError> {
    transaction.execute(
        "
        DELETE FROM project_roots
        WHERE root_path IN (?1, ?2)
          AND project_id IN (
              SELECT id
              FROM projects
              WHERE is_hidden = 1
                AND id <> ?3
          )
        ",
        params![
            metadata.canonical_root_path,
            metadata.worktree_root_path,
            project_id
        ],
    )?;
    transaction.execute(
        "
        DELETE FROM project_worktrees
        WHERE root_path IN (?1, ?2)
          AND project_id IN (
              SELECT id
              FROM projects
              WHERE is_hidden = 1
                AND id <> ?3
          )
        ",
        params![
            metadata.canonical_root_path,
            metadata.worktree_root_path,
            project_id
        ],
    )?;

    Ok(())
}

fn load_project_record(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<ProjectRow>, ProjectRegistryError> {
    connection
        .query_row(
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
            WHERE projects.id = ?1
              AND projects.is_hidden = 0
            ",
            [project_id],
            |row| {
                Ok(ProjectRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    canonical_root_path: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    last_opened_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(ProjectRegistryError::from)
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

fn list_project_worktree_rows(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<WorktreeRow>, ProjectRegistryError> {
    let mut statement = connection.prepare(
        "
        SELECT
            id,
            project_id,
            root_path,
            branch_name,
            head_sha,
            is_primary,
            updated_at
        FROM project_worktrees
        WHERE project_id = ?1
        ",
    )?;

    let rows = statement.query_map([project_id], |row| {
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

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn list_project_worktrees(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<NativeWorktreeSummary>, ProjectRegistryError> {
    let mut statement = connection.prepare(
        "
        SELECT
            id,
            project_id,
            root_path,
            branch_name,
            head_sha,
            is_primary,
            updated_at
        FROM project_worktrees
        WHERE project_id = ?1
        ORDER BY is_primary DESC, root_path COLLATE NOCASE ASC
        ",
    )?;

    let rows = statement.query_map([project_id], |row| {
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

fn project_app_data_summary(
    connection: &Connection,
    project_id: &str,
) -> Result<NativeProjectAppDataSummary, ProjectRegistryError> {
    let worktree_ids = list_project_worktree_ids(connection, project_id)?;
    let workspace_layout_count = u64::try_from(
        list_project_workspace_layout_ids(connection, project_id, &worktree_ids)?.len(),
    )
    .unwrap_or(0);

    Ok(NativeProjectAppDataSummary {
        chat_session_count: count_project_rows(
            connection,
            "SELECT COUNT(*) FROM chat_sessions WHERE project_id = ?1",
            project_id,
        )?,
        durable_workspace_count: count_project_rows(
            connection,
            "SELECT COUNT(*) FROM durable_workspaces WHERE project_id = ?1",
            project_id,
        )?,
        project_settings_count: count_project_rows(
            connection,
            "SELECT COUNT(*) FROM project_settings WHERE project_id = ?1",
            project_id,
        )?,
        recent_project_count: count_project_rows(
            connection,
            "SELECT COUNT(*) FROM recent_projects WHERE project_id = ?1",
            project_id,
        )?,
        recovery_layout_count: if has_legacy_recovery_table(connection)? {
            count_project_rows(
                connection,
                "SELECT COUNT(*) FROM workspace_layout_recovery WHERE scope_key IN (SELECT scope_key FROM durable_workspaces WHERE project_id = ?1)",
                project_id,
            )?
        } else {
            0
        },
        workspace_layout_count,
        workspace_session_count: count_workspace_sessions(connection, project_id, &worktree_ids)?,
        workspace_tab_count: count_workspace_tabs(connection, project_id, &worktree_ids)?,
    })
}

fn count_project_rows(
    connection: &Connection,
    sql: &str,
    project_id: &str,
) -> Result<u64, ProjectRegistryError> {
    let count: i64 = connection.query_row(sql, [project_id], |row| row.get(0))?;
    Ok(u64::try_from(count).unwrap_or(0))
}

fn has_legacy_recovery_table(connection: &Connection) -> Result<bool, ProjectRegistryError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_layout_recovery')",
        [],
        |row| row.get(0),
    )?)
}

fn count_workspace_sessions(
    connection: &Connection,
    project_id: &str,
    worktree_ids: &[String],
) -> Result<u64, ProjectRegistryError> {
    let sql = if worktree_ids.is_empty() {
        "SELECT COUNT(*) FROM workspace_sessions WHERE active_project_id = ?1".to_string()
    } else {
        format!(
            "
            SELECT COUNT(*)
            FROM workspace_sessions
            WHERE active_project_id = ?1
               OR active_worktree_id IN ({})
            ",
            placeholders(worktree_ids.len())
        )
    };
    let count: i64 = connection.query_row(
        &sql,
        params_from_iter(
            std::iter::once(project_id).chain(worktree_ids.iter().map(String::as_str)),
        ),
        |row| row.get(0),
    )?;
    Ok(u64::try_from(count).unwrap_or(0))
}

fn count_workspace_tabs(
    connection: &Connection,
    project_id: &str,
    worktree_ids: &[String],
) -> Result<u64, ProjectRegistryError> {
    let sql = if worktree_ids.is_empty() {
        "
        SELECT COUNT(*)
        FROM workspace_tabs
        WHERE json_valid(payload_json)
          AND json_extract(payload_json, '$.projectId') = ?1
        "
        .to_string()
    } else {
        format!(
            "
            SELECT COUNT(*)
            FROM workspace_tabs
            WHERE (
                json_valid(payload_json)
                AND json_extract(payload_json, '$.projectId') = ?1
            )
            OR worktree_id IN ({})
            ",
            placeholders(worktree_ids.len())
        )
    };
    let count: i64 = connection.query_row(
        &sql,
        params_from_iter(
            std::iter::once(project_id).chain(worktree_ids.iter().map(String::as_str)),
        ),
        |row| row.get(0),
    )?;
    Ok(u64::try_from(count).unwrap_or(0))
}

fn list_project_workspace_layout_ids(
    connection: &Connection,
    project_id: &str,
    worktree_ids: &[String],
) -> Result<Vec<String>, ProjectRegistryError> {
    let sql = if worktree_ids.is_empty() {
        "
        SELECT DISTINCT workspace_sessions.workspace_id
        FROM workspace_sessions
        INNER JOIN workspace_layouts
            ON workspace_layouts.id = workspace_sessions.workspace_id
        WHERE workspace_sessions.active_project_id = ?1
        "
        .to_string()
    } else {
        format!(
            "
            SELECT DISTINCT workspace_sessions.workspace_id
            FROM workspace_sessions
            INNER JOIN workspace_layouts
                ON workspace_layouts.id = workspace_sessions.workspace_id
            WHERE workspace_sessions.active_project_id = ?1
               OR workspace_sessions.active_worktree_id IN ({})
            ",
            placeholders(worktree_ids.len())
        )
    };
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(
            std::iter::once(project_id).chain(worktree_ids.iter().map(String::as_str)),
        ),
        |row| row.get::<_, String>(0),
    )?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn list_project_worktree_ids(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<String>, ProjectRegistryError> {
    let mut statement = connection.prepare(
        "
        SELECT id
        FROM project_worktrees
        WHERE project_id = ?1
        ",
    )?;
    let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ProjectRegistryError::from)
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
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

fn preferred_existing_worktrees<'a>(
    existing_rows: &'a [WorktreeRow],
    desired_worktrees: &BTreeMap<String, DesiredWorktree>,
    project_id: &str,
    project_root_key: &str,
) -> BTreeMap<String, &'a WorktreeRow> {
    let primary_id = format!("{project_id}:primary");
    let mut selected = BTreeMap::<String, &WorktreeRow>::new();

    for row in existing_rows {
        let root_key = normalize_worktree_key(&row.root_path);
        let replace = selected.get(&root_key).is_none_or(|current| {
            preferred_worktree_score(
                row,
                desired_worktrees.contains_key(&root_key),
                &primary_id,
                project_root_key,
            ) > preferred_worktree_score(
                current,
                desired_worktrees.contains_key(&root_key),
                &primary_id,
                project_root_key,
            )
        });
        if replace {
            selected.insert(root_key, row);
        }
    }

    selected
}

fn preferred_worktree_score(
    row: &WorktreeRow,
    is_desired: bool,
    primary_id: &str,
    project_root_key: &str,
) -> u8 {
    let row_key = normalize_worktree_key(&row.root_path);
    let mut score = 0;
    if row_key == project_root_key && row.id == primary_id {
        score += 100;
    }
    if row_key == project_root_key && row.is_primary == 1 {
        score += 50;
    }
    if is_desired {
        score += 10;
    }
    score
}

fn normalize_storage_path(path: &str) -> String {
    path_to_storage_string(normalize_lexical_path(PathBuf::from(path)))
}

fn normalize_worktree_key(path: &str) -> String {
    let normalized = normalize_storage_path(path);
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
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
            .add_project_paths(std::slice::from_ref(&project_root))
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
    fn readding_existing_project_preserves_primary_git_metadata() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "git-metadata");
        let mut connection = create_current_schema();

        let first = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("first add");
        let project_id = first.project_ids_to_open[0].0.clone();
        connection
            .execute(
                "
                UPDATE project_worktrees
                SET branch_name = 'main',
                    head_sha = 'abc123'
                WHERE id = ?1
                ",
                [format!("{project_id}:primary")],
            )
            .expect("seed git metadata");

        let second = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("second add");

        let primary = second
            .state
            .worktrees
            .iter()
            .find(|worktree| worktree.id.0 == format!("{project_id}:primary"))
            .expect("primary worktree");
        assert_eq!(primary.branch_name.as_deref(), Some("main"));
        assert_eq!(primary.head_sha.as_deref(), Some("abc123"));
    }

    #[test]
    fn sync_project_worktrees_updates_git_metadata() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "sync-git-metadata");
        let mut connection = create_current_schema();
        let added = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("add project");
        let project_id = added.project_ids_to_open[0].clone();

        let worktrees = ProjectRegistry::new(&mut connection)
            .sync_project_worktrees(
                &project_id,
                &[NativeProjectSyncWorktree {
                    root_path: project_root.clone(),
                    branch_name: Some("main".to_string()),
                    head_sha: Some("abc123".to_string()),
                }],
            )
            .expect("sync worktrees");

        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].id.0, format!("{}:primary", project_id.0));
        assert_eq!(worktrees[0].branch_name.as_deref(), Some("main"));
        assert_eq!(worktrees[0].head_sha.as_deref(), Some("abc123"));

        let listed = ProjectRegistry::new(&mut connection)
            .list_projects()
            .expect("list projects");
        assert_eq!(listed.worktrees[0].branch_name.as_deref(), Some("main"));
        assert_eq!(listed.worktrees[0].head_sha.as_deref(), Some("abc123"));
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
    fn removing_and_readding_project_archives_then_revives_durable_workspaces() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "archive-reopen");
        let mut connection = create_current_schema();
        let first = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("first add");
        let project_id = first.project_ids_to_open[0].0.clone();
        let scope_key = format!("{project_id}::__primary__");
        seed_durable_workspace(
            &connection,
            &scope_key,
            &project_id,
            &format!("{project_id}:primary"),
        );
        seed_navigation(&connection, &scope_key);

        ProjectRegistry::new(&mut connection)
            .remove_project(&comando_types::ids::ProjectId(project_id.clone()))
            .expect("project hidden");
        assert_eq!(workspace_lifecycle(&connection, &scope_key), "archived");
        assert_eq!(navigation_active_scope(&connection), None);

        let reopened = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("project reopened");
        assert_eq!(reopened.project_ids_to_open[0].0, project_id);
        assert_eq!(workspace_lifecycle(&connection, &scope_key), "active");
    }

    #[test]
    fn external_worktree_recreation_keeps_the_old_scope_orphaned() {
        let temp_dir = TempDir::new().expect("temp dir");
        let project_root = create_dir(temp_dir.path(), "external-project");
        let worktree_root = create_dir(temp_dir.path(), "external-worktree");
        let mut connection = create_current_schema();
        let added = ProjectRegistry::new(&mut connection)
            .add_project_paths(std::slice::from_ref(&project_root))
            .expect("project added");
        let project_id = added.project_ids_to_open[0].clone();
        let initial = ProjectRegistry::new(&mut connection)
            .sync_project_worktrees(
                &project_id,
                &[
                    NativeProjectSyncWorktree {
                        root_path: project_root.clone(),
                        branch_name: Some("main".to_string()),
                        head_sha: Some("root".to_string()),
                    },
                    NativeProjectSyncWorktree {
                        root_path: worktree_root.clone(),
                        branch_name: Some("feature".to_string()),
                        head_sha: Some("feature-a".to_string()),
                    },
                ],
            )
            .expect("initial sync");
        let removed_id = initial
            .iter()
            .find(|worktree| !worktree.is_primary)
            .expect("secondary worktree")
            .id
            .0
            .clone();
        let scope_key = format!("{}::{removed_id}", project_id.0);
        seed_durable_workspace(&connection, &scope_key, &project_id.0, &removed_id);
        let revision_before: i64 = connection
            .query_row(
                "SELECT layout_revision FROM durable_workspaces WHERE scope_key = ?1",
                [&scope_key],
                |row| row.get(0),
            )
            .expect("workspace revision");
        connection.execute(
            "INSERT INTO chat_sessions (id, project_id, worktree_id) VALUES ('session-external', ?1, ?2)",
            params![project_id.0, removed_id],
        ).expect("scoped chat");

        ProjectRegistry::new(&mut connection)
            .sync_project_worktrees(
                &project_id,
                &[NativeProjectSyncWorktree {
                    root_path: project_root.clone(),
                    branch_name: Some("main".to_string()),
                    head_sha: Some("root".to_string()),
                }],
            )
            .expect("external removal synced");
        assert_eq!(workspace_lifecycle(&connection, &scope_key), "orphaned");
        assert_eq!(tombstone_session_count(&connection, &scope_key), 1);
        let revision_after: i64 = connection
            .query_row(
                "SELECT layout_revision FROM durable_workspaces WHERE scope_key = ?1",
                [&scope_key],
                |row| row.get(0),
            )
            .expect("workspace revision");
        assert_eq!(revision_after, revision_before);

        let recreated = ProjectRegistry::new(&mut connection)
            .sync_project_worktrees(
                &project_id,
                &[
                    NativeProjectSyncWorktree {
                        root_path: project_root,
                        branch_name: Some("main".to_string()),
                        head_sha: Some("root".to_string()),
                    },
                    NativeProjectSyncWorktree {
                        root_path: worktree_root,
                        branch_name: Some("feature".to_string()),
                        head_sha: Some("feature-b".to_string()),
                    },
                ],
            )
            .expect("recreated worktree synced");
        let recreated_id = recreated
            .iter()
            .find(|worktree| !worktree.is_primary)
            .expect("recreated secondary")
            .id
            .0
            .clone();
        assert_ne!(recreated_id, removed_id);
        assert_eq!(workspace_lifecycle(&connection, &scope_key), "orphaned");
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
                CREATE TABLE chat_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL
                );
                CREATE TABLE workspace_sessions (
                    id TEXT PRIMARY KEY,
                    active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    active_worktree_id TEXT REFERENCES project_worktrees(id) ON DELETE SET NULL,
                    last_opened_at TEXT NOT NULL
                );
                CREATE TABLE durable_workspaces (
                    scope_key TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    worktree_id TEXT,
                    runtime_owner_id TEXT NOT NULL,
                    layout_snapshot_json TEXT NOT NULL,
                    layout_revision INTEGER NOT NULL,
                    lifecycle TEXT NOT NULL,
                    last_activated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE app_workspace_navigation (
                    singleton_id TEXT PRIMARY KEY,
                    active_scope_key TEXT,
                    recent_scope_keys_json TEXT NOT NULL,
                    shell_snapshot_json TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE workspace_scope_session_tombstones (
                    scope_key TEXT NOT NULL REFERENCES durable_workspaces(scope_key) ON DELETE CASCADE,
                    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                    project_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(scope_key, session_id)
                );
                ",
            )
            .expect("schema");
        connection
    }

    fn seed_durable_workspace(
        connection: &Connection,
        scope_key: &str,
        project_id: &str,
        worktree_id: &str,
    ) {
        connection.execute(
            "INSERT INTO durable_workspaces (scope_key, project_id, worktree_id, runtime_owner_id, layout_snapshot_json, layout_revision, lifecycle, last_activated_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '{\"tabs\":[]}', 1, 'active', 'now', 'now', 'now')",
            params![scope_key, project_id, worktree_id, format!("owner:{scope_key}")],
        ).expect("durable workspace");
    }

    fn seed_navigation(connection: &Connection, scope_key: &str) {
        connection.execute(
            "INSERT INTO app_workspace_navigation (singleton_id, active_scope_key, recent_scope_keys_json, shell_snapshot_json, revision, updated_at) VALUES ('main', ?1, ?2, '{}', 1, 'now')",
            params![scope_key, serde_json::to_string(&vec![scope_key]).unwrap()],
        ).expect("navigation");
    }

    fn workspace_lifecycle(connection: &Connection, scope_key: &str) -> String {
        connection
            .query_row(
                "SELECT lifecycle FROM durable_workspaces WHERE scope_key = ?1",
                [scope_key],
                |row| row.get(0),
            )
            .expect("workspace lifecycle")
    }

    fn navigation_active_scope(connection: &Connection) -> Option<String> {
        connection
            .query_row(
                "SELECT active_scope_key FROM app_workspace_navigation WHERE singleton_id = 'main'",
                [],
                |row| row.get(0),
            )
            .expect("active scope")
    }

    fn tombstone_session_count(connection: &Connection, scope_key: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM workspace_scope_session_tombstones WHERE scope_key = ?1",
                [scope_key],
                |row| row.get(0),
            )
            .expect("tombstone count")
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
