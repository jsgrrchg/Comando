use comando_types::ids::{ProjectId, WorkspaceRuntimeOwnerId, WorkspaceScopeKey, WorktreeId};
use comando_types::workspace::{
    APP_WORKSPACE_NAVIGATION_SINGLETON_ID, NativeAppWorkspaceNavigation,
    NativeAppWorkspaceSaveShellInput, NativeAppWorkspaceSetActiveInput, NativeDurableWorkspace,
    NativeDurableWorkspaceCreateInput, NativeDurableWorkspaceLifecycle,
    NativeDurableWorkspacePurgeOutput, NativeDurableWorkspaceResetInput,
    NativeDurableWorkspaceRevisionInput, NativeDurableWorkspaceSaveInput,
    NativeDurableWorkspaceSummary, canonical_workspace_scope_key, normalize_workspace_worktree_id,
};
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::Value;
use uuid::Uuid;

use crate::SqlitePersistenceStore;
use crate::error::PersistenceError;

impl SqlitePersistenceStore {
    pub fn list_durable_workspaces(
        &self,
    ) -> Result<Vec<NativeDurableWorkspaceSummary>, PersistenceError> {
        let mut statement = self.connection().prepare(
            "
            SELECT
                scope_key,
                project_id,
                worktree_id,
                runtime_owner_id,
                layout_revision,
                lifecycle,
                last_activated_at,
                created_at,
                updated_at
            FROM durable_workspaces
            ORDER BY
                last_activated_at IS NULL,
                last_activated_at DESC,
                updated_at DESC,
                scope_key ASC
            ",
        )?;
        let workspaces = statement
            .query_map([], row_to_workspace_summary)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(workspaces)
    }

    pub fn load_durable_workspace(
        &self,
        scope_key: &WorkspaceScopeKey,
    ) -> Result<Option<NativeDurableWorkspace>, PersistenceError> {
        load_workspace(self.connection(), scope_key)
    }

    pub fn create_durable_workspace(
        &mut self,
        input: NativeDurableWorkspaceCreateInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        let normalized = normalize_create_input(input)?;
        let now = crate::store::now_rfc3339();
        let runtime_owner_id =
            WorkspaceRuntimeOwnerId(format!("workspace-runtime-{}", Uuid::new_v4().simple()));
        let layout_snapshot_json = encode_json(&normalized.layout_snapshot)?;
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "
            INSERT INTO durable_workspaces (
                scope_key,
                project_id,
                worktree_id,
                runtime_owner_id,
                layout_snapshot_json,
                layout_revision,
                lifecycle,
                last_activated_at,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL, ?7, ?7)
            ON CONFLICT(scope_key) DO NOTHING
            ",
            params![
                normalized.scope_key.0,
                normalized.project_id.0,
                normalized.worktree_id.map(|id| id.0),
                runtime_owner_id.0,
                layout_snapshot_json,
                normalized.lifecycle.as_str(),
                now,
            ],
        )?;
        if changed == 0 {
            return Err(PersistenceError::WorkspaceAlreadyExists(
                normalized.scope_key.0,
            ));
        }
        let workspace = load_workspace(&transaction, &normalized.scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(normalized.scope_key.0.clone()))?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(workspace)
    }

    pub fn save_durable_workspace(
        &mut self,
        input: NativeDurableWorkspaceSaveInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        require_snapshot_object(&input.layout_snapshot)?;
        let layout_snapshot_json = encode_json(&input.layout_snapshot)?;
        let updated_at = crate::store::now_rfc3339();
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "
            UPDATE durable_workspaces
            SET layout_snapshot_json = ?1,
                layout_revision = layout_revision + 1,
                updated_at = ?2
            WHERE scope_key = ?3
              AND layout_revision = ?4
            ",
            params![
                layout_snapshot_json,
                updated_at,
                input.scope_key.0,
                revision_to_sql(input.expected_revision)?,
            ],
        )?;
        if changed == 0 {
            return Err(workspace_revision_error(
                &transaction,
                &input.scope_key,
                input.expected_revision,
            )?);
        }
        let workspace = required_workspace(&transaction, &input.scope_key)?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(workspace)
    }

    pub fn archive_durable_workspace(
        &mut self,
        input: NativeDurableWorkspaceRevisionInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "
            UPDATE durable_workspaces
            SET lifecycle = 'archived',
                layout_revision = layout_revision + 1,
                updated_at = ?1
            WHERE scope_key = ?2
              AND layout_revision = ?3
            ",
            params![
                crate::store::now_rfc3339(),
                input.scope_key.0,
                revision_to_sql(input.expected_revision)?,
            ],
        )?;
        if changed == 0 {
            return Err(workspace_revision_error(
                &transaction,
                &input.scope_key,
                input.expected_revision,
            )?);
        }
        let workspace = required_workspace(&transaction, &input.scope_key)?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(workspace)
    }

    pub fn reset_durable_workspace(
        &mut self,
        input: NativeDurableWorkspaceResetInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        self.save_durable_workspace(NativeDurableWorkspaceSaveInput {
            scope_key: input.scope_key,
            expected_revision: input.expected_revision,
            layout_snapshot: input.layout_snapshot,
        })
    }

    pub fn purge_durable_workspace(
        &mut self,
        input: NativeDurableWorkspaceRevisionInput,
    ) -> Result<NativeDurableWorkspacePurgeOutput, PersistenceError> {
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual_revision = workspace_revision(&transaction, &input.scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(input.scope_key.0.clone()))?;
        if actual_revision != input.expected_revision {
            return Err(PersistenceError::RevisionConflict {
                entity: "durable workspace",
                expected_revision: input.expected_revision,
                actual_revision,
            });
        }

        let mut navigation = load_navigation(&transaction)?;
        let previous_recent_count = navigation.recent_scope_keys.len();
        navigation
            .recent_scope_keys
            .retain(|recent| recent != &input.scope_key);
        let active_was_purged = navigation.active_scope_key.as_ref() == Some(&input.scope_key);
        if active_was_purged {
            navigation.active_scope_key = None;
        }
        if active_was_purged || navigation.recent_scope_keys.len() != previous_recent_count {
            navigation.revision = navigation.revision.saturating_add(1);
            navigation.updated_at = crate::store::now_rfc3339();
            write_navigation(&transaction, &navigation)?;
        }

        transaction.execute(
            "DELETE FROM workspace_layout_recovery WHERE scope_key = ?1",
            [&input.scope_key.0],
        )?;
        transaction.execute(
            "DELETE FROM durable_workspaces WHERE scope_key = ?1",
            [&input.scope_key.0],
        )?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;

        Ok(NativeDurableWorkspacePurgeOutput {
            navigation,
            purged_scope_key: input.scope_key,
        })
    }

    pub fn load_workspace_navigation(
        &self,
    ) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
        load_navigation(self.connection())
    }

    pub fn set_active_workspace(
        &mut self,
        input: NativeAppWorkspaceSetActiveInput,
    ) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut navigation = load_navigation(&transaction)?;
        require_navigation_revision(&navigation, input.expected_revision)?;

        if let Some(scope_key) = input.active_scope_key.as_ref()
            && load_workspace(&transaction, scope_key)?.is_none()
        {
            return Err(PersistenceError::WorkspaceNotFound(scope_key.0.clone()));
        }

        let updated_at = crate::store::now_rfc3339();
        if let Some(scope_key) = input.active_scope_key.as_ref() {
            navigation
                .recent_scope_keys
                .retain(|recent| recent != scope_key);
            navigation.recent_scope_keys.insert(0, scope_key.clone());
            transaction.execute(
                "UPDATE durable_workspaces SET last_activated_at = ?1 WHERE scope_key = ?2",
                params![updated_at, scope_key.0],
            )?;
        }
        navigation.active_scope_key = input.active_scope_key;
        navigation.revision = navigation.revision.saturating_add(1);
        navigation.updated_at = updated_at;
        write_navigation_cas(&transaction, &navigation, input.expected_revision)?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(navigation)
    }

    pub fn save_workspace_shell(
        &mut self,
        input: NativeAppWorkspaceSaveShellInput,
    ) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
        if !input.shell_snapshot.is_object() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "shellSnapshot must be a JSON object".to_string(),
            ));
        }
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut navigation = load_navigation(&transaction)?;
        require_navigation_revision(&navigation, input.expected_revision)?;
        navigation.shell_snapshot = input.shell_snapshot;
        navigation.revision = navigation.revision.saturating_add(1);
        navigation.updated_at = crate::store::now_rfc3339();
        write_navigation_cas(&transaction, &navigation, input.expected_revision)?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(navigation)
    }
}

fn normalize_create_input(
    mut input: NativeDurableWorkspaceCreateInput,
) -> Result<NativeDurableWorkspaceCreateInput, PersistenceError> {
    let project_id = input.project_id.0.trim();
    if project_id.is_empty() {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "projectId must not be empty".to_string(),
        ));
    }
    if input
        .worktree_id
        .as_ref()
        .is_some_and(|worktree_id| worktree_id.0.trim().is_empty())
    {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "worktreeId must not be empty".to_string(),
        ));
    }
    require_snapshot_object(&input.layout_snapshot)?;

    let normalized_worktree_id = normalize_workspace_worktree_id(
        project_id,
        input.worktree_id.as_ref().map(|id| id.0.as_str()),
    );
    let expected_scope_key =
        canonical_workspace_scope_key(project_id, normalized_worktree_id.as_deref());
    if input.scope_key != expected_scope_key {
        return Err(PersistenceError::InvalidWorkspaceInput(format!(
            "scopeKey must be {}",
            expected_scope_key.0
        )));
    }

    input.project_id = ProjectId(project_id.to_string());
    input.worktree_id = normalized_worktree_id.map(WorktreeId);
    Ok(input)
}

fn require_snapshot_object(snapshot: &Value) -> Result<(), PersistenceError> {
    if snapshot.is_object() {
        Ok(())
    } else {
        Err(PersistenceError::InvalidWorkspaceInput(
            "layoutSnapshot must be a JSON object".to_string(),
        ))
    }
}

fn encode_json(value: &Value) -> Result<String, PersistenceError> {
    serde_json::to_string(value).map_err(|error| {
        PersistenceError::InvalidWorkspaceInput(format!("JSON encoding failed: {error}"))
    })
}

fn decode_json(value: String, column: usize) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
    })
}

fn decode_lifecycle(
    value: String,
    column: usize,
) -> rusqlite::Result<NativeDurableWorkspaceLifecycle> {
    NativeDurableWorkspaceLifecycle::from_storage(&value).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            Type::Text,
            format!("invalid durable workspace lifecycle: {value}").into(),
        )
    })
}

fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<NativeDurableWorkspace> {
    let layout_snapshot_json: String = row.get(4)?;
    let revision: i64 = row.get(5)?;
    let lifecycle: String = row.get(6)?;
    Ok(NativeDurableWorkspace {
        scope_key: WorkspaceScopeKey(row.get(0)?),
        project_id: ProjectId(row.get(1)?),
        worktree_id: row.get::<_, Option<String>>(2)?.map(WorktreeId),
        runtime_owner_id: WorkspaceRuntimeOwnerId(row.get(3)?),
        layout_snapshot: decode_json(layout_snapshot_json, 4)?,
        revision: revision_from_sql(revision, 5)?,
        lifecycle: decode_lifecycle(lifecycle, 6)?,
        last_activated_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_workspace_summary(row: &Row<'_>) -> rusqlite::Result<NativeDurableWorkspaceSummary> {
    let revision: i64 = row.get(4)?;
    let lifecycle: String = row.get(5)?;
    Ok(NativeDurableWorkspaceSummary {
        scope_key: WorkspaceScopeKey(row.get(0)?),
        project_id: ProjectId(row.get(1)?),
        worktree_id: row.get::<_, Option<String>>(2)?.map(WorktreeId),
        runtime_owner_id: WorkspaceRuntimeOwnerId(row.get(3)?),
        revision: revision_from_sql(revision, 4)?,
        lifecycle: decode_lifecycle(lifecycle, 5)?,
        last_activated_at: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn load_workspace(
    connection: &Connection,
    scope_key: &WorkspaceScopeKey,
) -> Result<Option<NativeDurableWorkspace>, PersistenceError> {
    let workspace = connection
        .query_row(
            "
            SELECT
                scope_key,
                project_id,
                worktree_id,
                runtime_owner_id,
                layout_snapshot_json,
                layout_revision,
                lifecycle,
                last_activated_at,
                created_at,
                updated_at
            FROM durable_workspaces
            WHERE scope_key = ?1
            ",
            [&scope_key.0],
            row_to_workspace,
        )
        .optional()?;
    Ok(workspace)
}

fn required_workspace(
    connection: &Connection,
    scope_key: &WorkspaceScopeKey,
) -> Result<NativeDurableWorkspace, PersistenceError> {
    load_workspace(connection, scope_key)?
        .ok_or_else(|| PersistenceError::WorkspaceNotFound(scope_key.0.clone()))
}

fn workspace_revision(
    connection: &Connection,
    scope_key: &WorkspaceScopeKey,
) -> Result<Option<u64>, PersistenceError> {
    let revision = connection
        .query_row(
            "SELECT layout_revision FROM durable_workspaces WHERE scope_key = ?1",
            [&scope_key.0],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    revision
        .map(|revision| revision_from_sql(revision, 0).map_err(PersistenceError::from))
        .transpose()
}

fn workspace_revision_error(
    connection: &Connection,
    scope_key: &WorkspaceScopeKey,
    expected_revision: u64,
) -> Result<PersistenceError, PersistenceError> {
    match workspace_revision(connection, scope_key)? {
        Some(actual_revision) => Ok(PersistenceError::RevisionConflict {
            entity: "durable workspace",
            expected_revision,
            actual_revision,
        }),
        None => Ok(PersistenceError::WorkspaceNotFound(scope_key.0.clone())),
    }
}

fn load_navigation(
    connection: &Connection,
) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
    let navigation = connection.query_row(
        "
        SELECT
            active_scope_key,
            recent_scope_keys_json,
            shell_snapshot_json,
            revision,
            updated_at
        FROM app_workspace_navigation
        WHERE singleton_id = ?1
        ",
        [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        |row| {
            let recent_scope_keys_json: String = row.get(1)?;
            let shell_snapshot_json: String = row.get(2)?;
            let revision: i64 = row.get(3)?;
            Ok(NativeAppWorkspaceNavigation {
                active_scope_key: row.get::<_, Option<String>>(0)?.map(WorkspaceScopeKey),
                recent_scope_keys: serde_json::from_str(&recent_scope_keys_json).map_err(
                    |error| {
                        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
                    },
                )?,
                shell_snapshot: decode_json(shell_snapshot_json, 2)?,
                revision: revision_from_sql(revision, 3)?,
                updated_at: row.get(4)?,
            })
        },
    )?;
    Ok(navigation)
}

fn write_navigation(
    connection: &Connection,
    navigation: &NativeAppWorkspaceNavigation,
) -> Result<(), PersistenceError> {
    connection.execute(
        "
        UPDATE app_workspace_navigation
        SET active_scope_key = ?1,
            recent_scope_keys_json = ?2,
            shell_snapshot_json = ?3,
            revision = ?4,
            updated_at = ?5
        WHERE singleton_id = ?6
        ",
        params![
            navigation
                .active_scope_key
                .as_ref()
                .map(|key| key.0.as_str()),
            encode_json(
                &serde_json::to_value(&navigation.recent_scope_keys).map_err(|error| {
                    PersistenceError::InvalidWorkspaceInput(format!(
                        "recency encoding failed: {error}"
                    ))
                })?
            )?,
            encode_json(&navigation.shell_snapshot)?,
            revision_to_sql(navigation.revision)?,
            navigation.updated_at,
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
        ],
    )?;
    Ok(())
}

fn write_navigation_cas(
    connection: &Connection,
    navigation: &NativeAppWorkspaceNavigation,
    expected_revision: u64,
) -> Result<(), PersistenceError> {
    let changed = connection.execute(
        "
        UPDATE app_workspace_navigation
        SET active_scope_key = ?1,
            recent_scope_keys_json = ?2,
            shell_snapshot_json = ?3,
            revision = ?4,
            updated_at = ?5
        WHERE singleton_id = ?6
          AND revision = ?7
        ",
        params![
            navigation
                .active_scope_key
                .as_ref()
                .map(|key| key.0.as_str()),
            encode_json(
                &serde_json::to_value(&navigation.recent_scope_keys).map_err(|error| {
                    PersistenceError::InvalidWorkspaceInput(format!(
                        "recency encoding failed: {error}"
                    ))
                })?
            )?,
            encode_json(&navigation.shell_snapshot)?,
            revision_to_sql(navigation.revision)?,
            navigation.updated_at,
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
            revision_to_sql(expected_revision)?,
        ],
    )?;
    if changed == 0 {
        let actual_revision = load_navigation(connection)?.revision;
        return Err(PersistenceError::RevisionConflict {
            entity: "workspace navigation",
            expected_revision,
            actual_revision,
        });
    }
    Ok(())
}

fn require_navigation_revision(
    navigation: &NativeAppWorkspaceNavigation,
    expected_revision: u64,
) -> Result<(), PersistenceError> {
    if navigation.revision == expected_revision {
        Ok(())
    } else {
        Err(PersistenceError::RevisionConflict {
            entity: "workspace navigation",
            expected_revision,
            actual_revision: navigation.revision,
        })
    }
}

fn revision_to_sql(revision: u64) -> Result<i64, PersistenceError> {
    i64::try_from(revision).map_err(|_| {
        PersistenceError::InvalidWorkspaceInput("revision exceeds SQLite range".to_string())
    })
}

fn revision_from_sql(revision: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(revision).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use comando_types::persistence::NativePersistenceMode;
    use comando_types::workspace::{
        NativeAppWorkspaceSetActiveInput, NativeDurableWorkspaceCreateInput,
        NativeDurableWorkspaceLifecycle, NativeDurableWorkspaceResetInput,
        NativeDurableWorkspaceRevisionInput, NativeDurableWorkspaceSaveInput,
        canonical_workspace_scope_key,
    };
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{NativeStorageConfig, SqlitePersistenceStore};

    #[test]
    fn creates_unique_scopes_and_keeps_runtime_ownership_stable() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("workspace.sqlite3");
        let mut store = open_store(&temp_dir, &database_path);
        let scope_key = canonical_workspace_scope_key("project-a", None);

        let created = store
            .create_durable_workspace(create_input("project-a", None, json!({"tabs": ["a"]})))
            .expect("workspace created");
        assert_eq!(created.scope_key, scope_key);
        assert_eq!(created.revision, 0);
        assert_eq!(created.worktree_id, None);
        assert_eq!(created.lifecycle, NativeDurableWorkspaceLifecycle::Active);

        let duplicate = store
            .create_durable_workspace(create_input(
                "project-a",
                Some("project-a:primary"),
                json!({"tabs": []}),
            ))
            .expect_err("synthetic primary id resolves to the same scope");
        assert!(matches!(
            duplicate,
            PersistenceError::WorkspaceAlreadyExists(_)
        ));

        let saved = store
            .save_durable_workspace(NativeDurableWorkspaceSaveInput {
                scope_key: scope_key.clone(),
                expected_revision: 0,
                layout_snapshot: json!({"tabs": ["a", "b"]}),
            })
            .expect("workspace saved");
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.runtime_owner_id, created.runtime_owner_id);
        drop(store);

        let reopened = open_store(&temp_dir, &database_path)
            .load_durable_workspace(&scope_key)
            .expect("workspace loads")
            .expect("workspace exists");
        assert_eq!(reopened.runtime_owner_id, created.runtime_owner_id);
        assert_eq!(reopened.layout_snapshot, json!({"tabs": ["a", "b"]}));
    }

    #[test]
    fn list_returns_metadata_without_materializing_layout_snapshots() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("workspace.sqlite3");
        let mut store = open_store(&temp_dir, &database_path);
        store
            .create_durable_workspace(create_input(
                "project-a",
                Some("worktree-a"),
                json!({"largeLayout": [1, 2, 3]}),
            ))
            .expect("workspace created");

        let summaries = store.list_durable_workspaces().expect("workspaces list");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].project_id.0, "project-a");
        assert_eq!(summaries[0].worktree_id.as_ref().unwrap().0, "worktree-a");
    }

    #[test]
    fn rejects_stale_layout_and_lifecycle_revisions() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("workspace.sqlite3");
        let mut store = open_store(&temp_dir, &database_path);
        let created = store
            .create_durable_workspace(create_input("project-a", None, json!({"tabs": []})))
            .expect("workspace created");

        let saved = store
            .save_durable_workspace(NativeDurableWorkspaceSaveInput {
                scope_key: created.scope_key.clone(),
                expected_revision: 0,
                layout_snapshot: json!({"tabs": ["new"]}),
            })
            .expect("first save wins");
        let conflict = store
            .save_durable_workspace(NativeDurableWorkspaceSaveInput {
                scope_key: created.scope_key.clone(),
                expected_revision: 0,
                layout_snapshot: json!({"tabs": ["stale"]}),
            })
            .expect_err("stale save rejected");
        assert!(matches!(
            conflict,
            PersistenceError::RevisionConflict {
                expected_revision: 0,
                actual_revision: 1,
                ..
            }
        ));

        let archived = store
            .archive_durable_workspace(NativeDurableWorkspaceRevisionInput {
                scope_key: saved.scope_key.clone(),
                expected_revision: saved.revision,
            })
            .expect("workspace archived");
        assert_eq!(archived.revision, 2);
        assert_eq!(
            archived.lifecycle,
            NativeDurableWorkspaceLifecycle::Archived
        );

        let reset = store
            .reset_durable_workspace(NativeDurableWorkspaceResetInput {
                scope_key: archived.scope_key,
                expected_revision: archived.revision,
                layout_snapshot: json!({"tabs": []}),
            })
            .expect("workspace reset");
        assert_eq!(reset.revision, 3);
        assert_eq!(reset.layout_snapshot, json!({"tabs": []}));
        assert_eq!(reset.runtime_owner_id, created.runtime_owner_id);
    }

    #[test]
    fn navigation_cas_allows_only_one_concurrent_writer() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("workspace.sqlite3");
        let mut seed_store = open_store(&temp_dir, &database_path);
        let first_scope = seed_store
            .create_durable_workspace(create_input("project-a", None, json!({})))
            .expect("first workspace")
            .scope_key;
        let second_scope = seed_store
            .create_durable_workspace(create_input("project-a", Some("worktree-b"), json!({})))
            .expect("second workspace")
            .scope_key;
        drop(seed_store);

        let barrier = Arc::new(Barrier::new(2));
        let handles = [first_scope.clone(), second_scope.clone()].map(|scope_key| {
            let app_data_dir = temp_dir.path().to_path_buf();
            let database_path = database_path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let (mut store, _) = SqlitePersistenceStore::open(NativeStorageConfig {
                    app_data_dir,
                    database_path,
                    mode: NativePersistenceMode::Write,
                })
                .expect("concurrent store opens");
                let revision = store
                    .load_workspace_navigation()
                    .expect("navigation loads")
                    .revision;
                barrier.wait();
                match store.set_active_workspace(NativeAppWorkspaceSetActiveInput {
                    active_scope_key: Some(scope_key),
                    expected_revision: revision,
                }) {
                    Ok(navigation) => Ok(navigation.active_scope_key.unwrap().0),
                    Err(PersistenceError::RevisionConflict {
                        actual_revision, ..
                    }) => Err(actual_revision),
                    Err(error) => panic!("unexpected navigation error: {error}"),
                }
            })
        });

        let outcomes = handles.map(|handle| handle.join().expect("writer joins"));
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_err()).count(),
            1
        );
        assert_eq!(
            outcomes.iter().find_map(|outcome| outcome.as_ref().err()),
            Some(&1)
        );

        let store = open_store(&temp_dir, &database_path);
        let navigation = store.load_workspace_navigation().expect("navigation loads");
        assert_eq!(navigation.revision, 1);
        assert_eq!(navigation.recent_scope_keys.len(), 1);
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
    fn purge_removes_only_v4_scope_data_and_repairs_navigation() {
        let temp_dir = TempDir::new().expect("temp dir");
        let database_path = temp_dir.path().join("workspace.sqlite3");
        let mut store = open_store(&temp_dir, &database_path);
        let purged = store
            .create_durable_workspace(create_input(
                "project-a",
                Some("worktree-a"),
                json!({"tabs": ["purged"]}),
            ))
            .expect("purged workspace created");
        let sibling = store
            .create_durable_workspace(create_input("project-a", None, json!({"tabs": ["kept"]})))
            .expect("sibling workspace created");
        store
            .set_active_workspace(NativeAppWorkspaceSetActiveInput {
                active_scope_key: Some(purged.scope_key.clone()),
                expected_revision: 0,
            })
            .expect("workspace activated");
        store
            .connection_mut()
            .execute(
                "
                INSERT INTO workspace_layout_recovery (
                    id, scope_key, source_window_id, source_workspace_id,
                    source_revision, source_updated_at, snapshot_hash,
                    layout_snapshot_json, created_at
                ) VALUES ('recovery-a', ?1, 'legacy-window', 'legacy-workspace', 1,
                          'now', 'hash', '{}', 'now')
                ",
                [&purged.scope_key.0],
            )
            .expect("recovery row");
        store
            .connection_mut()
            .execute(
                "
                INSERT INTO workspace_layouts (
                    id, root_node_json, active_pane_id, created_at, updated_at
                ) VALUES ('legacy-layout', '{}', 'pane', 'now', 'now')
                ",
                [],
            )
            .expect("legacy v3 layout");

        let output = store
            .purge_durable_workspace(NativeDurableWorkspaceRevisionInput {
                scope_key: purged.scope_key.clone(),
                expected_revision: purged.revision,
            })
            .expect("scope purged");

        assert_eq!(output.purged_scope_key, purged.scope_key);
        assert_eq!(output.navigation.active_scope_key, None);
        assert!(output.navigation.recent_scope_keys.is_empty());
        assert!(
            store
                .load_durable_workspace(&purged.scope_key)
                .expect("purged scope lookup")
                .is_none()
        );
        assert!(
            store
                .load_durable_workspace(&sibling.scope_key)
                .expect("sibling lookup")
                .is_some()
        );
        assert_eq!(
            count_rows(store.connection(), "workspace_layout_recovery"),
            0
        );
        assert_eq!(count_rows(store.connection(), "workspace_layouts"), 1);
    }

    fn create_input(
        project_id: &str,
        worktree_id: Option<&str>,
        layout_snapshot: Value,
    ) -> NativeDurableWorkspaceCreateInput {
        NativeDurableWorkspaceCreateInput {
            scope_key: canonical_workspace_scope_key(project_id, worktree_id),
            project_id: ProjectId(project_id.to_string()),
            worktree_id: worktree_id.map(|value| WorktreeId(value.to_string())),
            layout_snapshot,
            lifecycle: NativeDurableWorkspaceLifecycle::Active,
        }
    }

    fn open_store(temp_dir: &TempDir, database_path: &std::path::Path) -> SqlitePersistenceStore {
        SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path: database_path.to_path_buf(),
            mode: NativePersistenceMode::Write,
        })
        .expect("store opens")
        .0
    }

    fn count_rows(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("row count")
    }
}
