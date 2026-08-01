use comando_types::ids::{ProjectId, WorkspaceRuntimeOwnerId, WorkspaceScopeKey, WorktreeId};
use comando_types::workspace::{
    APP_WORKSPACE_NAVIGATION_SINGLETON_ID, NativeDurableWorkspace, NativeDurableWorkspaceLifecycle,
    NativeWorkspaceDeletionBeginInput, NativeWorkspaceDeletionJournalEntry,
    NativeWorkspaceDeletionKind, NativeWorkspaceDeletionOperationInput,
    NativeWorkspaceDeletionStatus, NativeWorkspaceDeletionUpdateInput,
    NativeWorkspaceForgetSessionInput, NativeWorkspaceReassociateInput,
    NativeWorkspaceRecoveryApplyInput, NativeWorkspaceRecoveryDiscardInput,
    NativeWorkspaceRecoveryLayoutSummary,
};
use rusqlite::types::Type;
use rusqlite::{OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde_json::Value;
use uuid::Uuid;

use crate::SqlitePersistenceStore;
use crate::error::PersistenceError;

impl SqlitePersistenceStore {
    pub fn durable_workspace_session_ids(
        &self,
        scope_key: &WorkspaceScopeKey,
    ) -> Result<Vec<String>, PersistenceError> {
        let workspace = load_workspace(self.connection(), scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(scope_key.0.clone()))?;
        if workspace.lifecycle != NativeDurableWorkspaceLifecycle::Orphaned {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "only orphaned workspaces can be reassociated".to_string(),
            ));
        }
        scope_session_ids(self.connection(), scope_key, &workspace.layout_snapshot)
    }

    pub fn list_workspace_recovery_layouts(
        &self,
    ) -> Result<Vec<NativeWorkspaceRecoveryLayoutSummary>, PersistenceError> {
        let mut statement = self.connection().prepare(
            "
            SELECT id, scope_key, source_window_id, source_workspace_id,
                   source_revision, source_updated_at, snapshot_hash, created_at
            FROM workspace_layout_recovery
            ORDER BY created_at DESC, id ASC
            ",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(NativeWorkspaceRecoveryLayoutSummary {
                    id: row.get(0)?,
                    scope_key: WorkspaceScopeKey(row.get(1)?),
                    source_window_id: row.get(2)?,
                    source_workspace_id: row.get(3)?,
                    source_revision: revision_from_sql(row.get(4)?, 4)?,
                    source_updated_at: row.get(5)?,
                    snapshot_hash: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn apply_workspace_recovery_layout(
        &mut self,
        input: NativeWorkspaceRecoveryApplyInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot: String = transaction
            .query_row(
                "SELECT layout_snapshot_json FROM workspace_layout_recovery WHERE id = ?1 AND scope_key = ?2",
                params![input.recovery_id, input.scope_key.0],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PersistenceError::WorkspaceRecoveryNotFound(input.recovery_id.clone()))?;
        let changed = transaction.execute(
            "
            UPDATE durable_workspaces
            SET layout_snapshot_json = ?1,
                layout_revision = layout_revision + 1,
                updated_at = ?2
            WHERE scope_key = ?3 AND layout_revision = ?4
            ",
            params![
                snapshot,
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
        let workspace = load_workspace(&transaction, &input.scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(input.scope_key.0.clone()))?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(workspace)
    }

    pub fn discard_workspace_recovery_layout(
        &mut self,
        input: NativeWorkspaceRecoveryDiscardInput,
    ) -> Result<(), PersistenceError> {
        let changed = self.connection_mut().execute(
            "DELETE FROM workspace_layout_recovery WHERE id = ?1 AND scope_key = ?2",
            params![input.recovery_id, input.scope_key.0],
        )?;
        if changed == 0 {
            return Err(PersistenceError::WorkspaceRecoveryNotFound(
                input.recovery_id,
            ));
        }
        Ok(())
    }

    pub fn reassociate_workspace(
        &mut self,
        input: NativeWorkspaceReassociateInput,
    ) -> Result<NativeDurableWorkspace, PersistenceError> {
        if input.source_scope_key == input.target_scope_key {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "sourceScopeKey and targetScopeKey must differ".to_string(),
            ));
        }
        let expected_target = comando_types::workspace::canonical_workspace_scope_key(
            &input.project_id.0,
            Some(&input.target_worktree_id.0),
        );
        if expected_target != input.target_scope_key {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "targetScopeKey does not match the target worktree".to_string(),
            ));
        }

        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source = load_workspace(&transaction, &input.source_scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(input.source_scope_key.0.clone()))?;
        if source.project_id != input.project_id {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "source workspace does not belong to projectId".to_string(),
            ));
        }
        if source.revision != input.expected_revision {
            return Err(workspace_revision_error(
                &transaction,
                &input.source_scope_key,
                input.expected_revision,
            )?);
        }
        if source.lifecycle != NativeDurableWorkspaceLifecycle::Orphaned {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "only orphaned workspaces can be reassociated".to_string(),
            ));
        }
        let target_exists: bool = transaction
            .query_row(
                "SELECT 1 FROM project_worktrees WHERE id = ?1 AND project_id = ?2 AND is_primary = 0",
                params![input.target_worktree_id.0, input.project_id.0],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !target_exists {
            return Err(PersistenceError::WorkspaceReassociationTargetNotFound(
                input.target_worktree_id.0.clone(),
            ));
        }
        if load_workspace(&transaction, &input.target_scope_key)?.is_some() {
            return Err(PersistenceError::WorkspaceAlreadyExists(
                input.target_scope_key.0.clone(),
            ));
        }

        let temporary_owner = format!("reassociating-{}", Uuid::new_v4().simple());
        let session_ids = scope_session_ids(
            &transaction,
            &input.source_scope_key,
            &source.layout_snapshot,
        )?;
        transaction.execute(
            "UPDATE durable_workspaces SET runtime_owner_id = ?1 WHERE scope_key = ?2",
            params![temporary_owner, input.source_scope_key.0],
        )?;
        let layout = rewrite_layout_scope(
            source.layout_snapshot.clone(),
            &input.project_id.0,
            &input.target_worktree_id.0,
        );
        let now = crate::store::now_rfc3339();
        transaction.execute(
            "
            INSERT INTO durable_workspaces (
                scope_key, project_id, worktree_id, runtime_owner_id,
                layout_snapshot_json, layout_revision, lifecycle,
                last_activated_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9)
            ",
            params![
                input.target_scope_key.0,
                input.project_id.0,
                input.target_worktree_id.0,
                source.runtime_owner_id.0,
                encode_json(&layout)?,
                revision_to_sql(source.revision.saturating_add(1))?,
                source.last_activated_at,
                source.created_at,
                now,
            ],
        )?;

        rewrite_navigation_scope(
            &transaction,
            &input.source_scope_key,
            Some(&input.target_scope_key),
        )?;
        rewrite_recovery_scope(
            &transaction,
            &input.source_scope_key,
            &input.target_scope_key,
            &input.project_id.0,
            &input.target_worktree_id.0,
        )?;
        reassociate_chat_sessions(
            &transaction,
            &session_ids,
            &input.project_id.0,
            &input.target_worktree_id.0,
        )?;
        transaction.execute(
            "DELETE FROM durable_workspaces WHERE scope_key = ?1",
            [&input.source_scope_key.0],
        )?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        let workspace = load_workspace(&transaction, &input.target_scope_key)?
            .ok_or_else(|| PersistenceError::WorkspaceNotFound(input.target_scope_key.0.clone()))?;
        transaction.commit()?;
        Ok(workspace)
    }

    pub fn forget_workspace_session_references(
        &mut self,
        input: NativeWorkspaceForgetSessionInput,
    ) -> Result<u64, PersistenceError> {
        if input.session_id.trim().is_empty() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "sessionId must not be empty".to_string(),
            ));
        }
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = forget_session_references(&transaction, &[input.session_id])?;
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        Ok(changed)
    }

    pub fn begin_workspace_deletion(
        &mut self,
        input: NativeWorkspaceDeletionBeginInput,
    ) -> Result<NativeWorkspaceDeletionJournalEntry, PersistenceError> {
        validate_deletion_begin(&input)?;
        let now = crate::store::now_rfc3339();
        let existing_operation_id = self
            .connection()
            .query_row(
                "SELECT operation_id FROM workspace_deletion_journal WHERE operation_kind = ?1 AND scope_key = ?2 AND status <> 'completed'",
                params![input.kind.as_str(), input.scope_key.0],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(operation_id) = existing_operation_id {
            let existing = self
                .load_workspace_deletion(&operation_id)?
                .ok_or_else(|| PersistenceError::WorkspaceDeletionNotFound(operation_id.clone()))?;
            if existing.status != NativeWorkspaceDeletionStatus::Failed
                || !existing
                    .error_code
                    .as_deref()
                    .is_some_and(|error| error.starts_with("pre_checkout:"))
            {
                return Err(PersistenceError::InvalidWorkspaceInput(
                    "an incomplete deletion already owns this scope".to_string(),
                ));
            }
            self.connection_mut().execute(
                "UPDATE workspace_deletion_journal SET checkout_path = ?1, force_approved = ?2, error_code = NULL, session_ids_json = ?3, status = 'pending', updated_at = ?4 WHERE operation_id = ?5",
                params![
                    input.checkout_path,
                    i64::from(input.force_approved),
                    encode_json(&serde_json::to_value(input.session_ids).map_err(|error| {
                        PersistenceError::InvalidWorkspaceInput(error.to_string())
                    })?)?,
                    now,
                    operation_id,
                ],
            )?;
            return self
                .load_workspace_deletion(&operation_id)?
                .ok_or(PersistenceError::WorkspaceDeletionNotFound(operation_id));
        }
        self.connection_mut().execute(
            "
            INSERT INTO workspace_deletion_journal (
                operation_id, operation_kind, scope_key, project_id, worktree_id,
                checkout_path, status, force_approved, error_code,
                session_ids_json, started_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, NULL, ?8, ?9, ?9)
            ",
            params![
                input.operation_id,
                input.kind.as_str(),
                input.scope_key.0,
                input.project_id.0,
                input.worktree_id.map(|id| id.0),
                input.checkout_path,
                i64::from(input.force_approved),
                encode_json(&serde_json::to_value(input.session_ids).map_err(|error| {
                    PersistenceError::InvalidWorkspaceInput(error.to_string())
                })?)?,
                now,
            ],
        )?;
        self.load_workspace_deletion(&input.operation_id)?
            .ok_or_else(|| PersistenceError::WorkspaceDeletionNotFound(input.operation_id))
    }

    pub fn update_workspace_deletion(
        &mut self,
        input: NativeWorkspaceDeletionUpdateInput,
    ) -> Result<NativeWorkspaceDeletionJournalEntry, PersistenceError> {
        let existing = self
            .load_workspace_deletion(&input.operation_id)?
            .ok_or_else(|| {
                PersistenceError::WorkspaceDeletionNotFound(input.operation_id.clone())
            })?;
        if !valid_deletion_transition(existing.status, input.status) {
            return Err(PersistenceError::InvalidWorkspaceDeletionTransition {
                from: existing.status.as_str().to_string(),
                to: input.status.as_str().to_string(),
            });
        }
        self.connection_mut().execute(
            "UPDATE workspace_deletion_journal SET status = ?1, error_code = ?2, updated_at = ?3 WHERE operation_id = ?4",
            params![
                input.status.as_str(),
                input.error_code,
                crate::store::now_rfc3339(),
                input.operation_id,
            ],
        )?;
        self.load_workspace_deletion(&input.operation_id)?
            .ok_or_else(|| PersistenceError::WorkspaceDeletionNotFound(input.operation_id))
    }

    pub fn list_incomplete_workspace_deletions(
        &self,
    ) -> Result<Vec<NativeWorkspaceDeletionJournalEntry>, PersistenceError> {
        let mut statement = self.connection().prepare(
            "
            SELECT operation_id, operation_kind, scope_key, project_id, worktree_id,
                   checkout_path, status, force_approved, error_code,
                   session_ids_json, started_at, updated_at
            FROM workspace_deletion_journal
            WHERE status <> 'completed'
            ORDER BY started_at ASC, operation_id ASC
            ",
        )?;
        Ok(statement
            .query_map([], row_to_deletion)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn complete_workspace_deletion(
        &mut self,
        input: NativeWorkspaceDeletionOperationInput,
    ) -> Result<NativeWorkspaceDeletionJournalEntry, PersistenceError> {
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = load_deletion(&transaction, &input.operation_id)?.ok_or_else(|| {
            PersistenceError::WorkspaceDeletionNotFound(input.operation_id.clone())
        })?;
        let can_complete = match operation.kind {
            NativeWorkspaceDeletionKind::DeleteWorktree => matches!(
                operation.status,
                NativeWorkspaceDeletionStatus::CheckoutDeleted
                    | NativeWorkspaceDeletionStatus::Purging
            ),
            NativeWorkspaceDeletionKind::ClearProjectData => {
                operation.status == NativeWorkspaceDeletionStatus::Purging
            }
        };
        if !can_complete {
            return Err(PersistenceError::InvalidWorkspaceDeletionTransition {
                from: operation.status.as_str().to_string(),
                to: NativeWorkspaceDeletionStatus::Completed
                    .as_str()
                    .to_string(),
            });
        }

        transaction.execute(
            "UPDATE workspace_deletion_journal SET status = 'purging', error_code = NULL, updated_at = ?1 WHERE operation_id = ?2",
            params![crate::store::now_rfc3339(), operation.operation_id],
        )?;
        forget_session_references(&transaction, &operation.session_ids)?;
        match operation.kind {
            NativeWorkspaceDeletionKind::DeleteWorktree => {
                purge_worktree_scope(&transaction, &operation)?;
            }
            NativeWorkspaceDeletionKind::ClearProjectData => {
                purge_project_data(&transaction, &operation.project_id.0)?;
            }
        }
        crate::workspace_migration::refresh_v3_projection(&transaction)?;
        transaction.execute(
            "UPDATE workspace_deletion_journal SET status = 'completed', error_code = NULL, updated_at = ?1 WHERE operation_id = ?2",
            params![crate::store::now_rfc3339(), operation.operation_id],
        )?;
        let completed = load_deletion(&transaction, &operation.operation_id)?
            .ok_or_else(|| PersistenceError::WorkspaceDeletionNotFound(operation.operation_id))?;
        transaction.commit()?;
        Ok(completed)
    }

    fn load_workspace_deletion(
        &self,
        operation_id: &str,
    ) -> Result<Option<NativeWorkspaceDeletionJournalEntry>, PersistenceError> {
        load_deletion(self.connection(), operation_id)
    }
}

fn purge_worktree_scope(
    transaction: &Transaction<'_>,
    operation: &NativeWorkspaceDeletionJournalEntry,
) -> Result<(), PersistenceError> {
    let Some(worktree_id) = operation.worktree_id.as_ref() else {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "Delete Worktree requires a worktreeId".to_string(),
        ));
    };
    delete_chat_session_ids(transaction, &operation.session_ids, &operation.project_id.0)?;
    delete_chat_sessions(
        transaction,
        "project_id = ?1 AND worktree_id = ?2",
        params![operation.project_id.0, worktree_id.0],
    )?;
    transaction.execute(
        "DELETE FROM workspace_tabs WHERE worktree_id = ?1 OR (json_valid(payload_json) AND json_extract(payload_json, '$.projectId') = ?2 AND json_extract(payload_json, '$.worktreeId') = ?1)",
        params![worktree_id.0, operation.project_id.0],
    )?;
    transaction.execute(
        "UPDATE workspace_sessions SET active_project_id = NULL, active_worktree_id = NULL WHERE active_worktree_id = ?1",
        [&worktree_id.0],
    )?;
    rewrite_navigation_scope(transaction, &operation.scope_key, None)?;
    transaction.execute(
        "DELETE FROM workspace_layout_recovery WHERE scope_key = ?1",
        [&operation.scope_key.0],
    )?;
    transaction.execute(
        "DELETE FROM durable_workspaces WHERE scope_key = ?1",
        [&operation.scope_key.0],
    )?;
    transaction.execute(
        "DELETE FROM project_worktrees WHERE id = ?1 AND project_id = ?2 AND is_primary = 0",
        params![worktree_id.0, operation.project_id.0],
    )?;
    delete_unreferenced_legacy_layouts(transaction)?;
    Ok(())
}

fn reassociate_chat_sessions(
    transaction: &Transaction<'_>,
    session_ids: &[String],
    project_id: &str,
    worktree_id: &str,
) -> Result<(), PersistenceError> {
    for session_id in session_ids {
        transaction.execute(
            "UPDATE chat_sessions SET project_id = ?1, worktree_id = ?2 WHERE id = ?3 AND (project_id = ?1 OR project_id IS NULL)",
            params![project_id, worktree_id, session_id],
        )?;
    }
    Ok(())
}

fn delete_chat_session_ids(
    transaction: &Transaction<'_>,
    session_ids: &[String],
    project_id: &str,
) -> Result<(), PersistenceError> {
    for session_id in session_ids {
        transaction.execute(
            "DELETE FROM chat_sessions WHERE id = ?1 AND (project_id = ?2 OR project_id IS NULL)",
            params![session_id, project_id],
        )?;
    }
    Ok(())
}

fn purge_project_data(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> Result<(), PersistenceError> {
    delete_chat_sessions(transaction, "project_id = ?1", [project_id])?;
    transaction.execute(
        "DELETE FROM project_settings WHERE project_id = ?1",
        [project_id],
    )?;
    transaction.execute(
        "DELETE FROM recent_projects WHERE project_id = ?1",
        [project_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_tabs WHERE json_valid(payload_json) AND json_extract(payload_json, '$.projectId') = ?1",
        [project_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_tabs WHERE worktree_id IN (SELECT id FROM project_worktrees WHERE project_id = ?1)",
        [project_id],
    )?;
    transaction.execute(
        "UPDATE workspace_sessions SET active_project_id = NULL, active_worktree_id = NULL, shell_state_json = NULL WHERE active_project_id = ?1 OR active_worktree_id IN (SELECT id FROM project_worktrees WHERE project_id = ?1)",
        [project_id],
    )?;
    rewrite_navigation_project(transaction, project_id)?;
    transaction.execute(
        "DELETE FROM workspace_layout_recovery WHERE scope_key IN (SELECT scope_key FROM durable_workspaces WHERE project_id = ?1)",
        [project_id],
    )?;
    transaction.execute(
        "DELETE FROM durable_workspaces WHERE project_id = ?1",
        [project_id],
    )?;
    delete_unreferenced_legacy_layouts(transaction)?;
    Ok(())
}

fn delete_chat_sessions<P: rusqlite::Params>(
    transaction: &Transaction<'_>,
    predicate: &str,
    params: P,
) -> Result<(), PersistenceError> {
    transaction.execute(
        &format!("DELETE FROM chat_sessions WHERE {predicate}"),
        params,
    )?;
    Ok(())
}

fn delete_unreferenced_legacy_layouts(
    transaction: &Transaction<'_>,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "DELETE FROM workspace_layouts WHERE NOT EXISTS (SELECT 1 FROM workspace_tabs WHERE workspace_tabs.workspace_id = workspace_layouts.id)",
        [],
    )?;
    Ok(())
}

fn forget_session_references(
    transaction: &Transaction<'_>,
    session_ids: &[String],
) -> Result<u64, PersistenceError> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let session_ids = session_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut changed = 0_u64;
    let workspaces = {
        let mut statement = transaction
            .prepare("SELECT scope_key, layout_snapshot_json FROM durable_workspaces")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (scope_key, snapshot_json) in workspaces {
        let mut snapshot: Value = serde_json::from_str(&snapshot_json).map_err(|error| {
            PersistenceError::InvalidWorkspaceInput(format!("layout JSON is invalid: {error}"))
        })?;
        if remove_session_tabs(&mut snapshot, &session_ids) {
            transaction.execute(
                "UPDATE durable_workspaces SET layout_snapshot_json = ?1, layout_revision = layout_revision + 1, updated_at = ?2 WHERE scope_key = ?3",
                params![encode_json(&snapshot)?, crate::store::now_rfc3339(), scope_key],
            )?;
            changed = changed.saturating_add(1);
        }
    }

    let recoveries = {
        let mut statement = transaction
            .prepare("SELECT id, layout_snapshot_json FROM workspace_layout_recovery")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, snapshot_json) in recoveries {
        let mut snapshot: Value = serde_json::from_str(&snapshot_json).map_err(|error| {
            PersistenceError::InvalidWorkspaceInput(format!("recovery JSON is invalid: {error}"))
        })?;
        if remove_session_tabs(&mut snapshot, &session_ids) {
            transaction.execute(
                "UPDATE workspace_layout_recovery SET layout_snapshot_json = ?1 WHERE id = ?2",
                params![encode_json(&snapshot)?, id],
            )?;
        }
    }
    Ok(changed)
}

fn remove_session_tabs(
    snapshot: &mut Value,
    session_ids: &std::collections::HashSet<&str>,
) -> bool {
    let Some(object) = snapshot.as_object_mut() else {
        return false;
    };
    let Some(tabs) = object.get_mut("tabs").and_then(Value::as_array_mut) else {
        return false;
    };
    let removed_ids = tabs
        .iter()
        .filter_map(|tab| {
            let tab = tab.as_object()?;
            let kind = tab.get("kind")?.as_str()?;
            let session_id = tab.get("sessionId")?.as_str()?;
            ((kind == "chat" || kind == "review") && session_ids.contains(session_id))
                .then(|| tab.get("id")?.as_str().map(str::to_string))
                .flatten()
        })
        .collect::<std::collections::HashSet<_>>();
    if removed_ids.is_empty() {
        return false;
    }
    tabs.retain(|tab| {
        tab.get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !removed_ids.contains(id))
    });
    if let Some(root) = object.get_mut("rootNode") {
        remove_tab_ids_from_node(root, &removed_ids);
    }
    true
}

fn remove_tab_ids_from_node(node: &mut Value, removed_ids: &std::collections::HashSet<String>) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    if object.get("type").and_then(Value::as_str) == Some("pane") {
        for key in ["tabIds", "pinnedTabIds"] {
            if let Some(ids) = object.get_mut(key).and_then(Value::as_array_mut) {
                ids.retain(|id| id.as_str().is_none_or(|id| !removed_ids.contains(id)));
            }
        }
        let active_removed = object
            .get("activeTabId")
            .and_then(Value::as_str)
            .is_some_and(|id| removed_ids.contains(id));
        if active_removed {
            let next = object
                .get("tabIds")
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .cloned()
                .unwrap_or(Value::Null);
            object.insert("activeTabId".to_string(), next);
        }
        return;
    }
    if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {
            remove_tab_ids_from_node(child, removed_ids);
        }
    }
}

fn rewrite_layout_scope(mut snapshot: Value, project_id: &str, worktree_id: &str) -> Value {
    if let Some(tabs) = snapshot.get_mut("tabs").and_then(Value::as_array_mut) {
        for tab in tabs {
            if let Some(tab) = tab.as_object_mut() {
                tab.insert(
                    "projectId".to_string(),
                    Value::String(project_id.to_string()),
                );
                tab.insert(
                    "worktreeId".to_string(),
                    Value::String(worktree_id.to_string()),
                );
            }
        }
    }
    snapshot
}

fn layout_session_ids(snapshot: &Value) -> Vec<String> {
    let mut session_ids = snapshot
        .get("tabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tab| {
            let kind = tab.get("kind")?.as_str()?;
            ((kind == "chat" || kind == "review")
                && tab.get("sessionId").and_then(Value::as_str).is_some())
            .then(|| tab.get("sessionId")?.as_str().map(str::to_string))
            .flatten()
        })
        .collect::<Vec<_>>();
    session_ids.sort_unstable();
    session_ids.dedup();
    session_ids
}

fn scope_session_ids(
    connection: &rusqlite::Connection,
    scope_key: &WorkspaceScopeKey,
    layout_snapshot: &Value,
) -> Result<Vec<String>, PersistenceError> {
    let mut session_ids = layout_session_ids(layout_snapshot);
    let recovery_snapshots = {
        let mut statement = connection.prepare(
            "SELECT layout_snapshot_json FROM workspace_layout_recovery WHERE scope_key = ?1",
        )?;
        let rows = statement.query_map([&scope_key.0], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for snapshot_json in recovery_snapshots {
        let snapshot: Value = serde_json::from_str(&snapshot_json).map_err(|error| {
            PersistenceError::InvalidWorkspaceInput(format!("recovery JSON is invalid: {error}"))
        })?;
        session_ids.extend(layout_session_ids(&snapshot));
    }
    let tombstoned_sessions = {
        let mut statement = connection.prepare(
            "SELECT session_id FROM workspace_scope_session_tombstones WHERE scope_key = ?1",
        )?;
        let rows = statement.query_map([&scope_key.0], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    session_ids.extend(tombstoned_sessions);
    session_ids.sort_unstable();
    session_ids.dedup();
    Ok(session_ids)
}

fn rewrite_recovery_scope(
    transaction: &Transaction<'_>,
    source: &WorkspaceScopeKey,
    target: &WorkspaceScopeKey,
    project_id: &str,
    worktree_id: &str,
) -> Result<(), PersistenceError> {
    let records = {
        let mut statement = transaction.prepare(
            "SELECT id, layout_snapshot_json FROM workspace_layout_recovery WHERE scope_key = ?1",
        )?;
        let rows = statement.query_map([&source.0], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, snapshot) in records {
        let snapshot: Value = serde_json::from_str(&snapshot).map_err(|error| {
            PersistenceError::InvalidWorkspaceInput(format!("recovery JSON is invalid: {error}"))
        })?;
        transaction.execute(
            "UPDATE workspace_layout_recovery SET scope_key = ?1, layout_snapshot_json = ?2 WHERE id = ?3",
            params![target.0, encode_json(&rewrite_layout_scope(snapshot, project_id, worktree_id))?, id],
        )?;
    }
    Ok(())
}

fn rewrite_navigation_scope(
    transaction: &Transaction<'_>,
    source: &WorkspaceScopeKey,
    target: Option<&WorkspaceScopeKey>,
) -> Result<(), PersistenceError> {
    let (active, recent_json, revision): (Option<String>, String, i64) = transaction.query_row(
        "SELECT active_scope_key, recent_scope_keys_json, revision FROM app_workspace_navigation WHERE singleton_id = ?1",
        [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut recent: Vec<String> = serde_json::from_str(&recent_json).unwrap_or_default();
    let next_active = if active.as_deref() == Some(source.0.as_str()) {
        target.map(|value| value.0.clone())
    } else {
        active
    };
    recent = recent
        .into_iter()
        .filter_map(|value| {
            if value == source.0 {
                target.map(|target| target.0.clone())
            } else {
                Some(value)
            }
        })
        .collect();
    recent.dedup();
    transaction.execute(
        "UPDATE app_workspace_navigation SET active_scope_key = ?1, recent_scope_keys_json = ?2, revision = ?3, updated_at = ?4 WHERE singleton_id = ?5",
        params![
            next_active,
            encode_json(&serde_json::to_value(recent).map_err(|error| PersistenceError::InvalidWorkspaceInput(error.to_string()))?)?,
            revision.saturating_add(1),
            crate::store::now_rfc3339(),
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
        ],
    )?;
    Ok(())
}

fn rewrite_navigation_project(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> Result<(), PersistenceError> {
    let scopes = {
        let mut statement = transaction
            .prepare("SELECT scope_key FROM durable_workspaces WHERE project_id = ?1")?;
        let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()?
    };
    if scopes.is_empty() {
        return Ok(());
    }
    let (active, recent_json, revision): (Option<String>, String, i64) = transaction.query_row(
        "SELECT active_scope_key, recent_scope_keys_json, revision FROM app_workspace_navigation WHERE singleton_id = ?1",
        [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let recent: Vec<String> = serde_json::from_str::<Vec<String>>(&recent_json)
        .unwrap_or_default()
        .into_iter()
        .filter(|scope| !scopes.contains(scope))
        .collect();
    transaction.execute(
        "UPDATE app_workspace_navigation SET active_scope_key = ?1, recent_scope_keys_json = ?2, revision = ?3, updated_at = ?4 WHERE singleton_id = ?5",
        params![
            active.filter(|scope| !scopes.contains(scope)),
            encode_json(&serde_json::to_value(recent).map_err(|error| PersistenceError::InvalidWorkspaceInput(error.to_string()))?)?,
            revision.saturating_add(1),
            crate::store::now_rfc3339(),
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
        ],
    )?;
    Ok(())
}

fn validate_deletion_begin(
    input: &NativeWorkspaceDeletionBeginInput,
) -> Result<(), PersistenceError> {
    if input.operation_id.trim().is_empty() || input.project_id.0.trim().is_empty() {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "operationId and projectId must not be empty".to_string(),
        ));
    }
    if input.kind == NativeWorkspaceDeletionKind::DeleteWorktree
        && (input.worktree_id.is_none() || input.checkout_path.is_none())
    {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "Delete Worktree requires worktreeId and checkoutPath".to_string(),
        ));
    }
    Ok(())
}

fn valid_deletion_transition(
    from: NativeWorkspaceDeletionStatus,
    to: NativeWorkspaceDeletionStatus,
) -> bool {
    from == to
        || matches!(
            (from, to),
            (
                NativeWorkspaceDeletionStatus::Pending,
                NativeWorkspaceDeletionStatus::CheckoutDeleted
            ) | (
                NativeWorkspaceDeletionStatus::Pending,
                NativeWorkspaceDeletionStatus::Purging
            ) | (
                NativeWorkspaceDeletionStatus::Pending,
                NativeWorkspaceDeletionStatus::Failed
            ) | (
                NativeWorkspaceDeletionStatus::CheckoutDeleted,
                NativeWorkspaceDeletionStatus::Purging
            ) | (
                NativeWorkspaceDeletionStatus::CheckoutDeleted,
                NativeWorkspaceDeletionStatus::Failed
            ) | (
                NativeWorkspaceDeletionStatus::Purging,
                NativeWorkspaceDeletionStatus::Completed
            ) | (
                NativeWorkspaceDeletionStatus::Purging,
                NativeWorkspaceDeletionStatus::Failed
            ) | (
                NativeWorkspaceDeletionStatus::Failed,
                NativeWorkspaceDeletionStatus::CheckoutDeleted
            ) | (
                NativeWorkspaceDeletionStatus::Failed,
                NativeWorkspaceDeletionStatus::Purging
            )
        )
}

fn load_deletion(
    connection: &rusqlite::Connection,
    operation_id: &str,
) -> Result<Option<NativeWorkspaceDeletionJournalEntry>, PersistenceError> {
    Ok(connection
        .query_row(
            "
            SELECT operation_id, operation_kind, scope_key, project_id, worktree_id,
                   checkout_path, status, force_approved, error_code,
                   session_ids_json, started_at, updated_at
            FROM workspace_deletion_journal WHERE operation_id = ?1
            ",
            [operation_id],
            row_to_deletion,
        )
        .optional()?)
}

fn row_to_deletion(row: &Row<'_>) -> rusqlite::Result<NativeWorkspaceDeletionJournalEntry> {
    let kind: String = row.get(1)?;
    let status: String = row.get(6)?;
    let session_ids_json: String = row.get(9)?;
    Ok(NativeWorkspaceDeletionJournalEntry {
        operation_id: row.get(0)?,
        kind: NativeWorkspaceDeletionKind::from_storage(&kind).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                Type::Text,
                format!("invalid deletion kind: {kind}").into(),
            )
        })?,
        scope_key: WorkspaceScopeKey(row.get(2)?),
        project_id: ProjectId(row.get(3)?),
        worktree_id: row.get::<_, Option<String>>(4)?.map(WorktreeId),
        checkout_path: row.get(5)?,
        status: NativeWorkspaceDeletionStatus::from_storage(&status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                Type::Text,
                format!("invalid deletion status: {status}").into(),
            )
        })?,
        force_approved: row.get::<_, i64>(7)? != 0,
        error_code: row.get(8)?,
        session_ids: serde_json::from_str(&session_ids_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(9, Type::Text, Box::new(error))
        })?,
        started_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn load_workspace(
    connection: &rusqlite::Connection,
    scope_key: &WorkspaceScopeKey,
) -> Result<Option<NativeDurableWorkspace>, PersistenceError> {
    Ok(connection
        .query_row(
            "SELECT scope_key, project_id, worktree_id, runtime_owner_id, layout_snapshot_json, layout_revision, lifecycle, last_activated_at, created_at, updated_at FROM durable_workspaces WHERE scope_key = ?1",
            [&scope_key.0],
            row_to_workspace,
        )
        .optional()?)
}

fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<NativeDurableWorkspace> {
    let snapshot: String = row.get(4)?;
    let lifecycle: String = row.get(6)?;
    Ok(NativeDurableWorkspace {
        scope_key: WorkspaceScopeKey(row.get(0)?),
        project_id: ProjectId(row.get(1)?),
        worktree_id: row.get::<_, Option<String>>(2)?.map(WorktreeId),
        runtime_owner_id: WorkspaceRuntimeOwnerId(row.get(3)?),
        layout_snapshot: serde_json::from_str(&snapshot).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(4, Type::Text, Box::new(error))
        })?,
        revision: revision_from_sql(row.get(5)?, 5)?,
        lifecycle: NativeDurableWorkspaceLifecycle::from_storage(&lifecycle).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                Type::Text,
                format!("invalid lifecycle: {lifecycle}").into(),
            )
        })?,
        last_activated_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn workspace_revision_error(
    connection: &rusqlite::Connection,
    scope_key: &WorkspaceScopeKey,
    expected_revision: u64,
) -> Result<PersistenceError, PersistenceError> {
    let actual = connection
        .query_row(
            "SELECT layout_revision FROM durable_workspaces WHERE scope_key = ?1",
            [&scope_key.0],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    match actual {
        Some(actual) => Ok(PersistenceError::RevisionConflict {
            entity: "durable workspace",
            expected_revision,
            actual_revision: revision_from_sql(actual, 0)?,
        }),
        None => Ok(PersistenceError::WorkspaceNotFound(scope_key.0.clone())),
    }
}

fn revision_from_sql(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

fn revision_to_sql(value: u64) -> Result<i64, PersistenceError> {
    i64::try_from(value).map_err(|_| {
        PersistenceError::InvalidWorkspaceInput("revision exceeds SQLite range".to_string())
    })
}

fn encode_json(value: &Value) -> Result<String, PersistenceError> {
    serde_json::to_string(value).map_err(|error| {
        PersistenceError::InvalidWorkspaceInput(format!("JSON encoding failed: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use comando_types::persistence::NativePersistenceMode;
    use comando_types::workspace::{
        NativeDurableWorkspaceCreateInput, NativeWorkspaceDeletionBeginInput,
        NativeWorkspaceDeletionKind, NativeWorkspaceDeletionOperationInput,
        NativeWorkspaceDeletionStatus, NativeWorkspaceDeletionUpdateInput,
        NativeWorkspaceForgetSessionInput, NativeWorkspaceReassociateInput,
        NativeWorkspaceRecoveryApplyInput, canonical_workspace_scope_key,
    };
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::{NativeStorageConfig, SqlitePersistenceStore};

    #[test]
    fn failed_pre_checkout_delete_preserves_data_and_resume_purges_only_the_scope() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        let deleted = create_workspace(
            &mut store,
            "worktree-a",
            json!({
                "activePaneId": "pane-root",
                "rootNode": {"activeTabId": "chat-a", "id": "pane-root", "tabIds": ["chat-a"], "type": "pane"},
                "tabs": [{"id": "chat-a", "kind": "chat", "sessionId": "session-a", "title": "A"}]
            }),
        );
        let sibling = create_workspace(&mut store, "worktree-b", json!({"tabs": []}));
        seed_chat(&mut store, "session-a", "worktree-a");
        seed_chat(&mut store, "session-b", "worktree-b");
        store
            .begin_workspace_deletion(NativeWorkspaceDeletionBeginInput {
                operation_id: "delete-a".to_string(),
                kind: NativeWorkspaceDeletionKind::DeleteWorktree,
                scope_key: deleted.scope_key.clone(),
                project_id: ProjectId("project-a".to_string()),
                worktree_id: Some(WorktreeId("worktree-a".to_string())),
                checkout_path: Some("/tmp/worktree-a".to_string()),
                force_approved: false,
                session_ids: vec!["session-a".to_string()],
            })
            .expect("journal begins");
        store
            .update_workspace_deletion(NativeWorkspaceDeletionUpdateInput {
                operation_id: "delete-a".to_string(),
                status: NativeWorkspaceDeletionStatus::Failed,
                error_code: Some("pre_checkout:git failed".to_string()),
            })
            .expect("failure recorded");

        assert!(
            store
                .load_durable_workspace(&deleted.scope_key)
                .unwrap()
                .is_some()
        );
        assert_eq!(chat_count(&store, "session-a"), 1);
        let retried = store
            .begin_workspace_deletion(NativeWorkspaceDeletionBeginInput {
                operation_id: "delete-retry".to_string(),
                kind: NativeWorkspaceDeletionKind::DeleteWorktree,
                scope_key: deleted.scope_key.clone(),
                project_id: ProjectId("project-a".to_string()),
                worktree_id: Some(WorktreeId("worktree-a".to_string())),
                checkout_path: Some("/tmp/worktree-a".to_string()),
                force_approved: true,
                session_ids: vec!["session-a".to_string()],
            })
            .expect("failed pre-checkout operation is reused");
        assert_eq!(retried.operation_id, "delete-a");
        assert!(retried.force_approved);
        assert_eq!(retried.status, NativeWorkspaceDeletionStatus::Pending);
        assert!(
            store
                .complete_workspace_deletion(NativeWorkspaceDeletionOperationInput {
                    operation_id: "delete-a".to_string(),
                })
                .is_err()
        );
        assert_eq!(chat_count(&store, "session-a"), 1);

        store
            .update_workspace_deletion(NativeWorkspaceDeletionUpdateInput {
                operation_id: "delete-a".to_string(),
                status: NativeWorkspaceDeletionStatus::CheckoutDeleted,
                error_code: None,
            })
            .expect("resume after checkout removal");
        let completed = store
            .complete_workspace_deletion(NativeWorkspaceDeletionOperationInput {
                operation_id: "delete-a".to_string(),
            })
            .expect("purge completes");

        assert_eq!(completed.status, NativeWorkspaceDeletionStatus::Completed);
        assert!(
            store
                .load_durable_workspace(&deleted.scope_key)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .load_durable_workspace(&sibling.scope_key)
                .unwrap()
                .is_some()
        );
        assert_eq!(chat_count(&store, "session-a"), 0);
        assert_eq!(chat_count(&store, "session-b"), 1);
    }

    #[test]
    fn project_purge_removes_declared_data_without_touching_other_projects() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        seed_other_project(&mut store);
        let project_workspace = create_workspace(&mut store, "worktree-a", json!({"tabs": []}));
        let sibling_project_workspace = store
            .create_durable_workspace(NativeDurableWorkspaceCreateInput {
                scope_key: canonical_workspace_scope_key("project-b", None),
                project_id: ProjectId("project-b".to_string()),
                worktree_id: None,
                layout_snapshot: json!({"tabs": []}),
                lifecycle: NativeDurableWorkspaceLifecycle::Active,
            })
            .expect("other project workspace");
        seed_chat(&mut store, "session-a", "worktree-a");
        seed_chat_for(&mut store, "session-b", "project-b", "project-b:primary");
        store
            .begin_workspace_deletion(NativeWorkspaceDeletionBeginInput {
                operation_id: "clear-a".to_string(),
                kind: NativeWorkspaceDeletionKind::ClearProjectData,
                scope_key: WorkspaceScopeKey("project-data::project-a".to_string()),
                project_id: ProjectId("project-a".to_string()),
                worktree_id: None,
                checkout_path: None,
                force_approved: true,
                session_ids: vec!["session-a".to_string()],
            })
            .expect("project purge journal");
        store
            .update_workspace_deletion(NativeWorkspaceDeletionUpdateInput {
                operation_id: "clear-a".to_string(),
                status: NativeWorkspaceDeletionStatus::Purging,
                error_code: None,
            })
            .expect("project purge begins");

        store
            .complete_workspace_deletion(NativeWorkspaceDeletionOperationInput {
                operation_id: "clear-a".to_string(),
            })
            .expect("project purge completes");

        assert!(
            store
                .load_durable_workspace(&project_workspace.scope_key)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .load_durable_workspace(&sibling_project_workspace.scope_key)
                .unwrap()
                .is_some()
        );
        assert_eq!(chat_count(&store, "session-a"), 0);
        assert_eq!(chat_count(&store, "session-b"), 1);
    }

    #[test]
    fn recovery_apply_replaces_layout_without_removing_transcripts() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        let workspace = create_workspace(&mut store, "worktree-a", json!({"tabs": []}));
        seed_chat(&mut store, "session-a", "worktree-a");
        store.connection_mut().execute(
            "INSERT INTO workspace_layout_recovery (id, scope_key, source_window_id, source_workspace_id, source_revision, source_updated_at, snapshot_hash, layout_snapshot_json, created_at) VALUES ('recovery-a', ?1, 'window-a', 'legacy-a', 3, 'now', 'hash-a', ?2, 'now')",
            params![workspace.scope_key.0, json!({"tabs": [{"id": "chat-a", "kind": "chat", "sessionId": "session-a", "draft": "keep", "title": "Recovered"}]}).to_string()],
        ).expect("recovery row");

        let applied = store
            .apply_workspace_recovery_layout(NativeWorkspaceRecoveryApplyInput {
                recovery_id: "recovery-a".to_string(),
                scope_key: workspace.scope_key,
                expected_revision: workspace.revision,
            })
            .expect("recovery applied");

        assert_eq!(applied.layout_snapshot["tabs"][0]["draft"], "keep");
        assert_eq!(chat_count(&store, "session-a"), 1);
    }

    #[test]
    fn reset_replaces_only_layout_and_preserves_transcripts() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        let workspace = create_workspace(
            &mut store,
            "worktree-a",
            json!({"tabs": [{"id": "chat-a", "kind": "chat", "sessionId": "session-a"}]}),
        );
        seed_chat(&mut store, "session-a", "worktree-a");

        let reset = store
            .reset_durable_workspace(comando_types::workspace::NativeDurableWorkspaceResetInput {
                scope_key: workspace.scope_key,
                expected_revision: workspace.revision,
                layout_snapshot: json!({"tabs": []}),
            })
            .expect("workspace reset");

        assert_eq!(reset.layout_snapshot, json!({"tabs": []}));
        assert_eq!(chat_count(&store, "session-a"), 1);
    }

    #[test]
    fn forgetting_deleted_session_repairs_live_and_recovery_layouts() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        let layout = json!({
            "activePaneId": "pane-root",
            "rootNode": {"activeTabId": "chat-a", "id": "pane-root", "tabIds": ["chat-a", "file-a"], "type": "pane"},
            "tabs": [
                {"id": "chat-a", "kind": "chat", "sessionId": "session-a"},
                {"id": "file-a", "kind": "file", "path": "README.md"}
            ]
        });
        let workspace = create_workspace(&mut store, "worktree-a", layout.clone());
        store.connection_mut().execute(
            "INSERT INTO workspace_layout_recovery (id, scope_key, source_window_id, source_workspace_id, source_revision, source_updated_at, snapshot_hash, layout_snapshot_json, created_at) VALUES ('recovery-a', ?1, NULL, NULL, 1, 'now', 'hash-a', ?2, 'now')",
            params![workspace.scope_key.0, layout.to_string()],
        ).expect("recovery row");

        store
            .forget_workspace_session_references(NativeWorkspaceForgetSessionInput {
                session_id: "session-a".to_string(),
            })
            .expect("session references removed");

        let repaired = store
            .load_durable_workspace(&workspace.scope_key)
            .unwrap()
            .expect("workspace remains");
        assert_eq!(
            repaired.layout_snapshot["tabs"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            repaired.layout_snapshot["rootNode"]["tabIds"],
            json!(["file-a"])
        );
        assert_eq!(
            repaired.layout_snapshot["rootNode"]["activeTabId"],
            "file-a"
        );
        let recovery_json: String = store.connection().query_row(
            "SELECT layout_snapshot_json FROM workspace_layout_recovery WHERE id = 'recovery-a'",
            [],
            |row| row.get(0),
        ).expect("recovery snapshot");
        let recovery: Value = serde_json::from_str(&recovery_json).unwrap();
        assert_eq!(recovery["tabs"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn explicit_reassociation_moves_layout_recovery_navigation_and_chat_scope() {
        let temp = TempDir::new().expect("temp dir");
        let mut store = open_store(&temp);
        seed_project(&mut store);
        let source = create_workspace(
            &mut store,
            "worktree-a",
            json!({"tabs": [{"id": "chat-a", "kind": "chat", "sessionId": "session-a", "title": "A"}]}),
        );
        seed_chat(&mut store, "session-a", "worktree-a");
        seed_chat(&mut store, "session-closed", "worktree-a");
        seed_chat(&mut store, "session-recovery", "worktree-a");
        store.connection_mut().execute(
            "INSERT INTO workspace_scope_session_tombstones (scope_key, session_id, project_id, created_at) VALUES (?1, 'session-closed', 'project-a', 'now')",
            [&source.scope_key.0],
        ).expect("closed session tombstone");
        store.connection_mut().execute(
            "INSERT INTO workspace_layout_recovery (id, scope_key, source_window_id, source_workspace_id, source_revision, source_updated_at, snapshot_hash, layout_snapshot_json, created_at) VALUES ('recovery-a', ?1, NULL, NULL, 1, 'now', 'hash-a', '{\"tabs\":[{\"id\":\"chat-recovery\",\"kind\":\"chat\",\"sessionId\":\"session-recovery\"}]}', 'now')",
            [&source.scope_key.0],
        ).expect("recovery row");
        store
            .connection_mut()
            .execute("DELETE FROM project_worktrees WHERE id = 'worktree-a'", [])
            .expect("missing worktree");
        store
            .connection_mut()
            .execute(
                "UPDATE durable_workspaces SET lifecycle = 'orphaned' WHERE scope_key = ?1",
                [&source.scope_key.0],
            )
            .expect("workspace orphaned");
        for session_id in ["session-a", "session-closed", "session-recovery"] {
            assert_eq!(chat_worktree(&store, session_id), None);
        }
        let target_scope = canonical_workspace_scope_key("project-a", Some("worktree-b"));

        let target = store
            .reassociate_workspace(NativeWorkspaceReassociateInput {
                source_scope_key: source.scope_key.clone(),
                target_scope_key: target_scope.clone(),
                project_id: ProjectId("project-a".to_string()),
                target_worktree_id: WorktreeId("worktree-b".to_string()),
                expected_revision: source.revision,
            })
            .expect("workspace reassociated");

        assert_eq!(target.scope_key, target_scope);
        assert_eq!(target.runtime_owner_id, source.runtime_owner_id);
        assert!(
            store
                .load_durable_workspace(&source.scope_key)
                .unwrap()
                .is_none()
        );
        for session_id in ["session-a", "session-closed", "session-recovery"] {
            assert_eq!(
                chat_worktree(&store, session_id),
                Some("worktree-b".to_string())
            );
        }
        assert_eq!(
            store.list_workspace_recovery_layouts().unwrap()[0].scope_key,
            target.scope_key,
        );
    }

    fn open_store(temp: &TempDir) -> SqlitePersistenceStore {
        SqlitePersistenceStore::open(NativeStorageConfig {
            app_data_dir: temp.path().to_path_buf(),
            database_path: temp.path().join("app.sqlite3"),
            mode: NativePersistenceMode::Write,
        })
        .expect("store opens")
        .0
    }

    fn seed_project(store: &mut SqlitePersistenceStore) {
        store.connection_mut().execute(
            "INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at, is_hidden) VALUES ('project-a', 'Project A', '/tmp/project-a', 'now', 'now', 0)",
            [],
        ).expect("project");
        for (id, path, primary) in [
            ("project-a:primary", "/tmp/project-a", 1),
            ("worktree-a", "/tmp/worktree-a", 0),
            ("worktree-b", "/tmp/worktree-b", 0),
        ] {
            store.connection_mut().execute(
                "INSERT INTO project_worktrees (id, project_id, root_path, is_primary, created_at, updated_at) VALUES (?1, 'project-a', ?2, ?3, 'now', 'now')",
                params![id, path, primary],
            ).expect("worktree");
        }
    }

    fn seed_other_project(store: &mut SqlitePersistenceStore) {
        store.connection_mut().execute(
            "INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at, is_hidden) VALUES ('project-b', 'Project B', '/tmp/project-b', 'now', 'now', 0)",
            [],
        ).expect("other project");
        store.connection_mut().execute(
            "INSERT INTO project_worktrees (id, project_id, root_path, is_primary, created_at, updated_at) VALUES ('project-b:primary', 'project-b', '/tmp/project-b', 1, 'now', 'now')",
            [],
        ).expect("other project worktree");
    }

    fn create_workspace(
        store: &mut SqlitePersistenceStore,
        worktree_id: &str,
        layout_snapshot: Value,
    ) -> NativeDurableWorkspace {
        store
            .create_durable_workspace(NativeDurableWorkspaceCreateInput {
                scope_key: canonical_workspace_scope_key("project-a", Some(worktree_id)),
                project_id: ProjectId("project-a".to_string()),
                worktree_id: Some(WorktreeId(worktree_id.to_string())),
                layout_snapshot,
                lifecycle: NativeDurableWorkspaceLifecycle::Active,
            })
            .expect("workspace")
    }

    fn seed_chat(store: &mut SqlitePersistenceStore, session_id: &str, worktree_id: &str) {
        seed_chat_for(store, session_id, "project-a", worktree_id);
    }

    fn seed_chat_for(
        store: &mut SqlitePersistenceStore,
        session_id: &str,
        project_id: &str,
        worktree_id: &str,
    ) {
        store.connection_mut().execute(
            "INSERT INTO chat_sessions (id, project_id, worktree_id, title, runtime, status, draft, created_at, updated_at, last_opened_at) VALUES (?1, ?2, ?3, 'Chat', 'codex', 'idle', '', 'now', 'now', 'now')",
            params![session_id, project_id, worktree_id],
        ).expect("chat");
    }

    fn chat_count(store: &SqlitePersistenceStore, session_id: &str) -> i64 {
        store
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM chat_sessions WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("chat count")
    }

    fn chat_worktree(store: &SqlitePersistenceStore, session_id: &str) -> Option<String> {
        store
            .connection()
            .query_row(
                "SELECT worktree_id FROM chat_sessions WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("chat worktree")
    }
}
