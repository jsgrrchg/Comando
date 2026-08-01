use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use comando_types::ids::{ProjectId, WorkspaceRuntimeOwnerId, WorkspaceScopeKey, WorktreeId};
use comando_types::workspace::{
    APP_WORKSPACE_NAVIGATION_SINGLETON_ID, LEGACY_WORKSPACE_MIGRATION_ID,
    NativeAppWorkspaceNavigation, NativeDurableWorkspaceLifecycle, NativeLegacyWorkspaceWindow,
    NativeWorkspaceCleanupLegacyInput, NativeWorkspaceDisableLegacyWritesInput,
    NativeWorkspaceMarkStableInput, NativeWorkspaceMigrationDiagnostics,
    NativeWorkspaceMigrationExportOutput, NativeWorkspaceMigrationLayoutSource,
    NativeWorkspaceMigrationRecoverySource, NativeWorkspaceMigrationRollbackOutput,
    NativeWorkspaceMigrationRunInput, NativeWorkspaceMigrationRunOutput,
    NativeWorkspaceRolloutStage, NativeWorkspaceRolloutStatus, canonical_workspace_scope_key,
    normalize_workspace_worktree_id,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::SqlitePersistenceStore;
use crate::error::PersistenceError;

const APP_DATA_WINDOWS_STORAGE_KEY: &str = "native.appData.persistence.windows";
const BACKUP_DIRECTORY: &str = "workspace-migrations";
const PRUNED_LAYOUT_LIMITATION: &str = "Legacy versions retained at most 30 closed layouts per window; layouts pruned before this migration cannot be recovered.";
const MINIMUM_LEGACY_RETENTION_DAYS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MigrationFailpoint {
    None,
    AfterBackup,
    AfterWorkspaces,
    AfterRecovery,
    AfterNavigation,
    AfterMarker,
    AfterProjection,
}

#[derive(Debug, Clone)]
struct MigrationCandidate {
    scope_key: WorkspaceScopeKey,
    project_id: ProjectId,
    worktree_id: Option<WorktreeId>,
    layout_snapshot: Value,
    snapshot_hash: String,
    last_activated_at: String,
    source_window_id: String,
    source_workspace_id: Option<String>,
    source_revision: u64,
    source_updated_at: String,
    is_window_open: bool,
    is_context_open: bool,
    is_active: bool,
    original_position: usize,
}

impl SqlitePersistenceStore {
    pub fn run_workspace_migration(
        &mut self,
        input: NativeWorkspaceMigrationRunInput,
    ) -> Result<NativeWorkspaceMigrationRunOutput, PersistenceError> {
        self.run_workspace_migration_with_failpoint(input, MigrationFailpoint::None)
    }

    fn run_workspace_migration_with_failpoint(
        &mut self,
        input: NativeWorkspaceMigrationRunInput,
        failpoint: MigrationFailpoint,
    ) -> Result<NativeWorkspaceMigrationRunOutput, PersistenceError> {
        if let Some(diagnostics) = load_diagnostics(self.connection())? {
            return Ok(NativeWorkspaceMigrationRunOutput {
                applied: false,
                diagnostics,
                navigation: load_navigation(self.connection())?,
            });
        }

        validate_migration_input(&input)?;
        require_empty_v4_authority(self.connection())?;
        let source_bytes = canonical_json_bytes(&input.source_backup)?;
        let source_checksum = sha256_hex(&source_bytes);
        let started_at = crate::store::now_rfc3339();
        // The immutable backup must exist before SQLite can publish v4 authority.
        let source_backup_ref =
            write_immutable_backup(self.app_data_dir(), &source_checksum, &input, &started_at)?;
        if failpoint == MigrationFailpoint::AfterBackup {
            return Err(PersistenceError::MigrationInterrupted("workspace_backup"));
        }

        let candidates = flatten_candidates(&input.windows)?;
        let active_winner = candidates
            .iter()
            .filter(|candidate| candidate.is_active)
            .min_by(|left, right| compare_active_candidates(left, right))
            .cloned();
        let grouped = group_candidates(&candidates);
        let mut winners = Vec::with_capacity(grouped.len());
        let mut recovery = Vec::new();
        for scope_candidates in grouped.values() {
            let mut ranked = scope_candidates.clone();
            ranked.sort_by(|left, right| compare_layout_candidates(left, right));
            let Some(winner) = ranked.first().cloned() else {
                continue;
            };
            // Layout trees are never merged because that can corrupt drafts and tab identity.
            recovery.extend(
                ranked
                    .into_iter()
                    .skip(1)
                    .filter(|candidate| candidate.snapshot_hash != winner.snapshot_hash),
            );
            winners.push(winner);
        }
        winners.sort_by(|left, right| left.scope_key.0.cmp(&right.scope_key.0));
        recovery.sort_by(|left, right| {
            left.scope_key
                .0
                .cmp(&right.scope_key.0)
                .then_with(|| left.source_window_id.cmp(&right.source_window_id))
                .then_with(|| left.snapshot_hash.cmp(&right.snapshot_hash))
        });

        let completed_at = crate::store::now_rfc3339();
        let diagnostics = build_diagnostics(
            &input,
            &source_checksum,
            &source_backup_ref,
            &started_at,
            &completed_at,
            &candidates,
            &winners,
            &recovery,
            active_winner.as_ref(),
        );
        let projection_template =
            select_projection_template(&input.windows, active_winner.as_ref());
        let shell_snapshot = select_shell_snapshot(&input.windows, active_winner.as_ref());
        let recent_scope_keys = migration_recency(&winners, active_winner.as_ref());
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        insert_workspace_winners(&transaction, &winners, &completed_at)?;
        fail_at(
            failpoint,
            MigrationFailpoint::AfterWorkspaces,
            "workspace_rows",
        )?;
        insert_recovery_layouts(&transaction, &recovery, &completed_at)?;
        fail_at(
            failpoint,
            MigrationFailpoint::AfterRecovery,
            "workspace_recovery",
        )?;
        write_migrated_navigation(
            &transaction,
            active_winner.as_ref().map(|candidate| &candidate.scope_key),
            &recent_scope_keys,
            &shell_snapshot,
            &completed_at,
        )?;
        fail_at(
            failpoint,
            MigrationFailpoint::AfterNavigation,
            "workspace_navigation",
        )?;
        insert_migration_marker(&transaction, &diagnostics)?;
        insert_compatibility_state(&transaction, &projection_template, &completed_at)?;
        fail_at(
            failpoint,
            MigrationFailpoint::AfterMarker,
            "workspace_marker",
        )?;
        refresh_v3_projection(&transaction)?;
        fail_at(
            failpoint,
            MigrationFailpoint::AfterProjection,
            "workspace_projection",
        )?;
        transaction.commit()?;

        Ok(NativeWorkspaceMigrationRunOutput {
            applied: true,
            diagnostics,
            navigation: load_navigation(self.connection())?,
        })
    }

    pub fn export_workspace_migration_diagnostics(
        &self,
    ) -> Result<NativeWorkspaceMigrationExportOutput, PersistenceError> {
        let diagnostics = required_diagnostics(self.connection())?;
        let recovery_layouts = load_recovery_sources(self.connection())?;
        let v3_projection = load_v3_projection(self.connection())?;
        Ok(NativeWorkspaceMigrationExportOutput {
            diagnostics,
            recovery_layouts,
            v3_projection,
        })
    }

    pub fn sync_legacy_workspace_migration(
        &mut self,
        input: NativeWorkspaceMigrationRunInput,
    ) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
        required_diagnostics(self.connection())?;
        if !self.workspace_rollout_status()?.dual_write_enabled {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy workspace writes are disabled".to_string(),
            ));
        }
        validate_migration_input(&input)?;
        let candidates = flatten_candidates(&input.windows)?;
        let active_winner = candidates
            .iter()
            .filter(|candidate| candidate.is_active)
            .min_by(|left, right| compare_active_candidates(left, right))
            .cloned();
        let grouped = group_candidates(&candidates);
        let mut winners = Vec::with_capacity(grouped.len());
        let mut recovery = Vec::new();
        for scope_candidates in grouped.values() {
            let mut ranked = scope_candidates.clone();
            ranked.sort_by(|left, right| compare_layout_candidates(left, right));
            let Some(winner) = ranked.first().cloned() else {
                continue;
            };
            recovery.extend(
                ranked
                    .into_iter()
                    .skip(1)
                    .filter(|candidate| candidate.snapshot_hash != winner.snapshot_hash),
            );
            winners.push(winner);
        }
        let now = crate::store::now_rfc3339();
        let recent_scope_keys = migration_recency(&winners, active_winner.as_ref());
        let shell_snapshot = select_shell_snapshot(&input.windows, active_winner.as_ref());
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        sync_workspace_winners(&transaction, &winners, &now)?;
        insert_recovery_layouts(&transaction, &recovery, &now)?;
        write_migrated_navigation(
            &transaction,
            active_winner.as_ref().map(|candidate| &candidate.scope_key),
            &recent_scope_keys,
            &shell_snapshot,
            &now,
        )?;
        refresh_v3_projection(&transaction)?;
        transaction.commit()?;
        load_navigation(self.connection())
    }

    pub fn rollback_workspace_migration(
        &mut self,
    ) -> Result<NativeWorkspaceMigrationRollbackOutput, PersistenceError> {
        if !self.workspace_rollout_status()?.rollback_available {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "workspace rollback is no longer available".to_string(),
            ));
        }
        let transaction = self
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rollback_at = crate::store::now_rfc3339();
        let v3_projection = refresh_v3_projection(&transaction)?.ok_or_else(|| {
            PersistenceError::WorkspaceMigrationNotFound(LEGACY_WORKSPACE_MIGRATION_ID.to_string())
        })?;
        let mut diagnostics = required_diagnostics(&transaction)?;
        diagnostics.rollback_at = Some(rollback_at.clone());
        transaction.execute(
            "UPDATE workspace_v3_compatibility SET rollback_at = ?1, updated_at = ?1 WHERE singleton_id = ?2",
            params![rollback_at, APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        )?;
        transaction.execute(
            "UPDATE workspace_migrations SET diagnostics_json = ?1 WHERE migration_id = ?2",
            params![
                encode_json(&serde_json::to_value(&diagnostics).map_err(invalid_json)?)?,
                LEGACY_WORKSPACE_MIGRATION_ID
            ],
        )?;
        transaction.commit()?;
        Ok(NativeWorkspaceMigrationRollbackOutput {
            diagnostics,
            v3_projection,
        })
    }

    pub fn workspace_rollout_status(
        &self,
    ) -> Result<NativeWorkspaceRolloutStatus, PersistenceError> {
        let state = self.connection().query_row(
            "SELECT dual_write_enabled, stable_release_version, stable_release_verified_at, legacy_retention_until, v4_only_since, legacy_cleanup_completed_at FROM workspace_v3_compatibility WHERE singleton_id = ?1",
            [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        ).optional()?.ok_or_else(|| {
            PersistenceError::WorkspaceMigrationNotFound(
                LEGACY_WORKSPACE_MIGRATION_ID.to_string(),
            )
        })?;
        let pending_recovery_layout_count = self.connection().query_row(
            "SELECT COUNT(*) FROM workspace_layout_recovery",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let source_backup_ref = self.connection().query_row(
            "SELECT source_backup_ref FROM workspace_migrations WHERE migration_id = ?1",
            [LEGACY_WORKSPACE_MIGRATION_ID],
            |row| row.get::<_, String>(0),
        )?;
        let source_backup_retained = source_backup_ref != "retired"
            && resolve_legacy_backup_path(self.app_data_dir(), &source_backup_ref)?.exists();
        let stage = if state.5.is_some() {
            NativeWorkspaceRolloutStage::LegacyRetired
        } else if !state.0 {
            NativeWorkspaceRolloutStage::V4Only
        } else if state.2.is_some() {
            NativeWorkspaceRolloutStage::StableDualWrite
        } else {
            NativeWorkspaceRolloutStage::Internal
        };
        Ok(NativeWorkspaceRolloutStatus {
            stage,
            dual_write_enabled: state.0,
            stable_release_version: state.1,
            stable_release_verified_at: state.2,
            legacy_retention_until: state.3,
            v4_only_since: state.4,
            legacy_cleanup_completed_at: state.5,
            pending_recovery_layout_count: u64::try_from(pending_recovery_layout_count).map_err(
                |_| {
                    PersistenceError::InvalidWorkspaceInput(
                        "recovery layout count is invalid".to_string(),
                    )
                },
            )?,
            rollback_available: state.0 && source_backup_retained,
            source_backup_retained,
        })
    }

    pub fn mark_workspace_rollout_stable(
        &mut self,
        input: NativeWorkspaceMarkStableInput,
    ) -> Result<NativeWorkspaceRolloutStatus, PersistenceError> {
        if input.application_version.trim().is_empty() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "applicationVersion must not be empty".to_string(),
            ));
        }
        if input.retention_days < MINIMUM_LEGACY_RETENTION_DAYS || input.retention_days > 3_650 {
            return Err(PersistenceError::InvalidWorkspaceInput(format!(
                "retentionDays must be between {MINIMUM_LEGACY_RETENTION_DAYS} and 3650"
            )));
        }
        let retention_days = i64::try_from(input.retention_days).map_err(|_| {
            PersistenceError::InvalidWorkspaceInput("retentionDays is too large".to_string())
        })?;
        let now = OffsetDateTime::now_utc();
        let verified_at = format_timestamp(now)?;
        let retention_until = format_timestamp(now + Duration::days(retention_days))?;
        let changed = self.connection_mut().execute(
            "UPDATE workspace_v3_compatibility SET stable_release_version = COALESCE(stable_release_version, ?1), stable_release_verified_at = COALESCE(stable_release_verified_at, ?2), legacy_retention_until = COALESCE(legacy_retention_until, ?3), updated_at = ?2 WHERE singleton_id = ?4 AND dual_write_enabled = 1 AND legacy_cleanup_completed_at IS NULL",
            params![
                input.application_version,
                verified_at,
                retention_until,
                APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
            ],
        )?;
        if changed == 0 {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "stable rollout can only be recorded while dual-write is active".to_string(),
            ));
        }
        self.workspace_rollout_status()
    }

    pub fn disable_workspace_legacy_writes(
        &mut self,
        input: NativeWorkspaceDisableLegacyWritesInput,
    ) -> Result<NativeWorkspaceRolloutStatus, PersistenceError> {
        if input.application_version.trim().is_empty() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "applicationVersion must not be empty".to_string(),
            ));
        }
        let status = self.workspace_rollout_status()?;
        let stable_version = status.stable_release_version.as_deref().ok_or_else(|| {
            PersistenceError::InvalidWorkspaceInput(
                "a stable dual-write release must be verified first".to_string(),
            )
        })?;
        if stable_version == input.application_version {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy writes can only stop in a later application version".to_string(),
            ));
        }
        if status.pending_recovery_layout_count != 0 {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "all recovery layouts must be resolved explicitly first".to_string(),
            ));
        }
        if !status.dual_write_enabled {
            return Ok(status);
        }
        let now = crate::store::now_rfc3339();
        self.connection_mut().execute(
            "UPDATE workspace_v3_compatibility SET dual_write_enabled = 0, v4_only_since = ?1, updated_at = ?1 WHERE singleton_id = ?2",
            params![now, APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        )?;
        self.workspace_rollout_status()
    }

    pub fn cleanup_workspace_legacy_compatibility(
        &mut self,
        input: NativeWorkspaceCleanupLegacyInput,
    ) -> Result<NativeWorkspaceRolloutStatus, PersistenceError> {
        if !input.consent {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "explicit consent is required to delete legacy workspace data".to_string(),
            ));
        }
        let status = self.workspace_rollout_status()?;
        if status.dual_write_enabled || status.v4_only_since.is_none() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy writes must be disabled before cleanup".to_string(),
            ));
        }
        if status.pending_recovery_layout_count != 0 {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "all recovery layouts must be resolved explicitly before cleanup".to_string(),
            ));
        }
        let retention_until = status.legacy_retention_until.as_deref().ok_or_else(|| {
            PersistenceError::InvalidWorkspaceInput(
                "legacy retention policy was not recorded".to_string(),
            )
        })?;
        let retention_until = OffsetDateTime::parse(retention_until, &Rfc3339).map_err(|_| {
            PersistenceError::InvalidWorkspaceInput(
                "legacy retention deadline is invalid".to_string(),
            )
        })?;
        if retention_until > OffsetDateTime::now_utc() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy retention period has not elapsed".to_string(),
            ));
        }
        if status.legacy_cleanup_completed_at.is_some() {
            return Ok(status);
        }

        let (source_backup_ref, source_checksum, projection_template) = self.connection().query_row(
            "SELECT migrations.source_backup_ref, migrations.source_checksum, compatibility.projection_template_json FROM workspace_migrations AS migrations JOIN workspace_v3_compatibility AS compatibility ON compatibility.migration_id = migrations.migration_id WHERE migrations.migration_id = ?1",
            [LEGACY_WORKSPACE_MIGRATION_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let legacy_projection = self
            .connection()
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [APP_DATA_WINDOWS_STORAGE_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let backup_path = resolve_legacy_backup_path(self.app_data_dir(), &source_backup_ref)?;
        if !backup_path.exists() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy backup is unavailable for verified cleanup".to_string(),
            ));
        }
        verify_existing_backup(&backup_path, &source_checksum)?;
        let staged_backup =
            backup_path.with_extension(format!("retiring-{}", Uuid::new_v4().simple()));
        fs::rename(&backup_path, &staged_backup)?;
        let now = crate::store::now_rfc3339();
        let transaction_result = (|| -> Result<(), PersistenceError> {
            let transaction = self
                .connection_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM app_settings WHERE key = ?1",
                [APP_DATA_WINDOWS_STORAGE_KEY],
            )?;
            transaction.execute(
                "UPDATE workspace_v3_compatibility SET projection_template_json = '{}', legacy_cleanup_completed_at = ?1, updated_at = ?1 WHERE singleton_id = ?2",
                params![now, APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
            )?;
            transaction.execute(
                "UPDATE workspace_migrations SET source_backup_ref = 'retired' WHERE migration_id = ?1",
                [LEGACY_WORKSPACE_MIGRATION_ID],
            )?;
            transaction.commit()?;
            Ok(())
        })();
        if let Err(error) = transaction_result {
            if staged_backup.exists() {
                let _ = fs::rename(&staged_backup, &backup_path);
            }
            return Err(error);
        }
        if staged_backup.exists()
            && let Err(remove_error) = fs::remove_file(&staged_backup)
        {
            let _ = fs::rename(&staged_backup, &backup_path);
            // Restore the compatibility marker if filesystem cleanup could not finish.
            let transaction = self
                .connection_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(projection) = legacy_projection {
                transaction.execute(
                    "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    params![APP_DATA_WINDOWS_STORAGE_KEY, projection, now],
                )?;
            }
            transaction.execute(
                "UPDATE workspace_v3_compatibility SET projection_template_json = ?1, legacy_cleanup_completed_at = NULL, updated_at = ?2 WHERE singleton_id = ?3",
                params![
                    projection_template,
                    now,
                    APP_WORKSPACE_NAVIGATION_SINGLETON_ID
                ],
            )?;
            transaction.execute(
                "UPDATE workspace_migrations SET source_backup_ref = ?1 WHERE migration_id = ?2",
                params![source_backup_ref, LEGACY_WORKSPACE_MIGRATION_ID],
            )?;
            transaction.commit()?;
            return Err(PersistenceError::Io(remove_error));
        }
        self.workspace_rollout_status()
    }
}

fn validate_migration_input(
    input: &NativeWorkspaceMigrationRunInput,
) -> Result<(), PersistenceError> {
    if input.application_version.trim().is_empty() {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "applicationVersion must not be empty".to_string(),
        ));
    }
    if !input.source_backup.is_object() {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "sourceBackup must be a JSON object".to_string(),
        ));
    }
    for window in &input.windows {
        if window.window_id.trim().is_empty() || !window.shell_snapshot.is_object() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "legacy windows require an id and object shellSnapshot".to_string(),
            ));
        }
        if !window.projection_template.is_object() {
            return Err(PersistenceError::InvalidWorkspaceInput(
                "projectionTemplate must be a JSON object".to_string(),
            ));
        }
    }
    Ok(())
}

fn require_empty_v4_authority(connection: &Connection) -> Result<(), PersistenceError> {
    let workspace_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM durable_workspaces", [], |row| {
            row.get(0)
        })?;
    let navigation_revision: i64 = connection.query_row(
        "SELECT revision FROM app_workspace_navigation WHERE singleton_id = ?1",
        [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
        |row| row.get(0),
    )?;
    if workspace_count != 0 || navigation_revision != 0 {
        // A mixed initial authority cannot be resolved without an explicit recovery decision.
        return Err(PersistenceError::InvalidWorkspaceInput(
            "initial migration requires empty v4 workspace authority".to_string(),
        ));
    }
    Ok(())
}

fn flatten_candidates(
    windows: &[NativeLegacyWorkspaceWindow],
) -> Result<Vec<MigrationCandidate>, PersistenceError> {
    let mut candidates = Vec::new();
    for window in windows {
        let open_keys = window
            .open_context_keys
            .iter()
            .map(|key| key.0.as_str())
            .collect::<HashSet<_>>();
        for (position, context) in window.contexts.iter().enumerate() {
            let project_id = context.project_id.0.trim();
            if project_id.is_empty() || !context.layout_snapshot.is_object() {
                continue;
            }
            let worktree_id = normalize_workspace_worktree_id(
                project_id,
                context.worktree_id.as_ref().map(|id| id.0.as_str()),
            )
            .map(WorktreeId);
            let scope_key = canonical_workspace_scope_key(
                project_id,
                worktree_id.as_ref().map(|id| id.0.as_str()),
            );
            let is_active = window
                .active_context_key
                .as_ref()
                .is_some_and(|key| key == &scope_key || key == &context.scope_key);
            let is_context_open = open_keys.contains(context.scope_key.0.as_str())
                || open_keys.contains(scope_key.0.as_str());
            candidates.push(MigrationCandidate {
                scope_key,
                project_id: ProjectId(project_id.to_string()),
                worktree_id,
                snapshot_hash: hash_json(&context.layout_snapshot)?,
                layout_snapshot: context.layout_snapshot.clone(),
                last_activated_at: context.last_activated_at.clone(),
                source_window_id: window.window_id.clone(),
                source_workspace_id: window.workspace_id.as_ref().map(|id| id.0.clone()),
                source_revision: window.restore_revision,
                source_updated_at: window.restore_updated_at.clone(),
                is_window_open: window.is_open,
                is_context_open,
                is_active,
                original_position: position,
            });
        }
    }
    Ok(candidates)
}

fn group_candidates(
    candidates: &[MigrationCandidate],
) -> BTreeMap<String, Vec<MigrationCandidate>> {
    let mut grouped = BTreeMap::new();
    for candidate in candidates {
        grouped
            .entry(candidate.scope_key.0.clone())
            .or_insert_with(Vec::new)
            .push(candidate.clone());
    }
    grouped
}

fn compare_active_candidates(left: &MigrationCandidate, right: &MigrationCandidate) -> Ordering {
    right
        .is_window_open
        .cmp(&left.is_window_open)
        .then_with(|| right.last_activated_at.cmp(&left.last_activated_at))
        .then_with(|| right.source_updated_at.cmp(&left.source_updated_at))
        .then_with(|| right.source_revision.cmp(&left.source_revision))
        .then_with(|| left.source_window_id.cmp(&right.source_window_id))
        .then_with(|| left.original_position.cmp(&right.original_position))
}

fn compare_layout_candidates(left: &MigrationCandidate, right: &MigrationCandidate) -> Ordering {
    let left_open = left.is_window_open && left.is_context_open;
    let right_open = right.is_window_open && right.is_context_open;
    right_open
        .cmp(&left_open)
        .then_with(|| right.is_active.cmp(&left.is_active))
        .then_with(|| right.last_activated_at.cmp(&left.last_activated_at))
        .then_with(|| right.source_updated_at.cmp(&left.source_updated_at))
        .then_with(|| right.source_revision.cmp(&left.source_revision))
        .then_with(|| left.source_window_id.cmp(&right.source_window_id))
        .then_with(|| left.original_position.cmp(&right.original_position))
}

fn insert_workspace_winners(
    transaction: &Transaction<'_>,
    winners: &[MigrationCandidate],
    now: &str,
) -> Result<(), PersistenceError> {
    for winner in winners {
        let lifecycle = migration_lifecycle(transaction, winner)?;
        transaction.execute(
            "
            INSERT INTO durable_workspaces (
                scope_key, project_id, worktree_id, runtime_owner_id,
                layout_snapshot_json, layout_revision, lifecycle,
                last_activated_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?8)
            ON CONFLICT(scope_key) DO NOTHING
            ",
            params![
                winner.scope_key.0,
                winner.project_id.0,
                winner.worktree_id.as_ref().map(|id| id.0.as_str()),
                WorkspaceRuntimeOwnerId(format!("workspace-runtime-{}", Uuid::new_v4().simple())).0,
                encode_json(&winner.layout_snapshot)?,
                lifecycle.as_str(),
                winner.last_activated_at,
                now,
            ],
        )?;
    }
    Ok(())
}

fn sync_workspace_winners(
    transaction: &Transaction<'_>,
    winners: &[MigrationCandidate],
    now: &str,
) -> Result<(), PersistenceError> {
    for winner in winners {
        let lifecycle = migration_lifecycle(transaction, winner)?;
        preserve_displaced_v4_layout(transaction, winner, now)?;
        let runtime_owner_id =
            WorkspaceRuntimeOwnerId(format!("workspace-runtime-{}", Uuid::new_v4().simple()));
        transaction.execute(
            "
            INSERT INTO durable_workspaces (
                scope_key, project_id, worktree_id, runtime_owner_id,
                layout_snapshot_json, layout_revision, lifecycle,
                last_activated_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?8)
            ON CONFLICT(scope_key) DO UPDATE SET
                project_id = excluded.project_id,
                worktree_id = excluded.worktree_id,
                layout_snapshot_json = excluded.layout_snapshot_json,
                layout_revision = durable_workspaces.layout_revision +
                    CASE
                        WHEN durable_workspaces.layout_snapshot_json != excluded.layout_snapshot_json
                          OR durable_workspaces.lifecycle != excluded.lifecycle
                        THEN 1
                        ELSE 0
                    END,
                lifecycle = excluded.lifecycle,
                last_activated_at = excluded.last_activated_at,
                updated_at = excluded.updated_at
            WHERE durable_workspaces.layout_snapshot_json != excluded.layout_snapshot_json
               OR durable_workspaces.lifecycle != excluded.lifecycle
               OR COALESCE(durable_workspaces.last_activated_at, '') != excluded.last_activated_at
            ",
            params![
                winner.scope_key.0,
                winner.project_id.0,
                winner.worktree_id.as_ref().map(|id| id.0.as_str()),
                runtime_owner_id.0,
                encode_json(&winner.layout_snapshot)?,
                lifecycle.as_str(),
                winner.last_activated_at,
                now,
            ],
        )?;
    }
    Ok(())
}

fn preserve_displaced_v4_layout(
    transaction: &Transaction<'_>,
    winner: &MigrationCandidate,
    now: &str,
) -> Result<(), PersistenceError> {
    let existing = transaction
        .query_row(
            "SELECT layout_snapshot_json, layout_revision, updated_at FROM durable_workspaces WHERE scope_key = ?1",
            [&winner.scope_key.0],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((layout_json, revision, updated_at)) = existing else {
        return Ok(());
    };
    let layout: Value = serde_json::from_str(&layout_json).map_err(invalid_json)?;
    let snapshot_hash = hash_json(&layout)?;
    if snapshot_hash == winner.snapshot_hash {
        return Ok(());
    }
    // A shadow v3 write may race a v4 writer, so retain the displaced v4 revision.
    let recovery_id = sha256_hex(
        format!(
            "{}\0v4-dual-write\0{}\0{}",
            winner.scope_key.0, revision, snapshot_hash
        )
        .as_bytes(),
    );
    transaction.execute(
        "
        INSERT OR IGNORE INTO workspace_layout_recovery (
            id, scope_key, source_window_id, source_workspace_id,
            source_revision, source_updated_at, snapshot_hash,
            layout_snapshot_json, created_at
        ) VALUES (?1, ?2, 'v4-dual-write', NULL, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            recovery_id,
            winner.scope_key.0,
            revision,
            updated_at,
            snapshot_hash,
            layout_json,
            now,
        ],
    )?;
    Ok(())
}

fn migration_lifecycle(
    connection: &Connection,
    candidate: &MigrationCandidate,
) -> Result<NativeDurableWorkspaceLifecycle, PersistenceError> {
    let project_hidden = connection
        .query_row(
            "SELECT is_hidden FROM projects WHERE id = ?1",
            [&candidate.project_id.0],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    match project_hidden {
        Some(value) if value != 0 => Ok(NativeDurableWorkspaceLifecycle::Archived),
        None => Ok(NativeDurableWorkspaceLifecycle::Orphaned),
        Some(_) => {
            let Some(worktree_id) = candidate.worktree_id.as_ref() else {
                return Ok(NativeDurableWorkspaceLifecycle::Active);
            };
            let exists = connection
                .query_row(
                    "SELECT 1 FROM project_worktrees WHERE id = ?1 AND project_id = ?2",
                    params![worktree_id.0, candidate.project_id.0],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            Ok(if exists {
                NativeDurableWorkspaceLifecycle::Active
            } else {
                NativeDurableWorkspaceLifecycle::Orphaned
            })
        }
    }
}

fn insert_recovery_layouts(
    transaction: &Transaction<'_>,
    recovery: &[MigrationCandidate],
    now: &str,
) -> Result<(), PersistenceError> {
    for candidate in recovery {
        let id = recovery_id(candidate);
        transaction.execute(
            "
            INSERT OR IGNORE INTO workspace_layout_recovery (
                id, scope_key, source_window_id, source_workspace_id,
                source_revision, source_updated_at, snapshot_hash,
                layout_snapshot_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                id,
                candidate.scope_key.0,
                candidate.source_window_id,
                candidate.source_workspace_id,
                revision_to_sql(candidate.source_revision)?,
                candidate.source_updated_at,
                candidate.snapshot_hash,
                encode_json(&candidate.layout_snapshot)?,
                now,
            ],
        )?;
    }
    Ok(())
}

fn write_migrated_navigation(
    transaction: &Transaction<'_>,
    active_scope_key: Option<&WorkspaceScopeKey>,
    recent_scope_keys: &[WorkspaceScopeKey],
    shell_snapshot: &Value,
    now: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "
        UPDATE app_workspace_navigation
        SET active_scope_key = ?1,
            recent_scope_keys_json = ?2,
            shell_snapshot_json = ?3,
            revision = revision + 1,
            updated_at = ?4
        WHERE singleton_id = ?5
        ",
        params![
            active_scope_key.map(|key| key.0.as_str()),
            encode_json(&serde_json::to_value(recent_scope_keys).map_err(invalid_json)?)?,
            encode_json(shell_snapshot)?,
            now,
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
        ],
    )?;
    Ok(())
}

fn insert_migration_marker(
    transaction: &Transaction<'_>,
    diagnostics: &NativeWorkspaceMigrationDiagnostics,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "
        INSERT INTO workspace_migrations (
            migration_id, source_checksum, source_backup_ref, status,
            diagnostics_json, started_at, completed_at
        ) VALUES (?1, ?2, ?3, 'complete', ?4, ?5, ?6)
        ",
        params![
            LEGACY_WORKSPACE_MIGRATION_ID,
            diagnostics.source_checksum,
            diagnostics.source_backup_ref,
            encode_json(&serde_json::to_value(diagnostics).map_err(invalid_json)?)?,
            diagnostics.started_at,
            diagnostics.completed_at,
        ],
    )?;
    Ok(())
}

fn insert_compatibility_state(
    transaction: &Transaction<'_>,
    projection_template: &Value,
    now: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "
        INSERT INTO workspace_v3_compatibility (
            singleton_id, migration_id, projection_template_json,
            projection_revision, updated_at, rollback_at
        ) VALUES (?1, ?2, ?3, 0, ?4, NULL)
        ",
        params![
            APP_WORKSPACE_NAVIGATION_SINGLETON_ID,
            LEGACY_WORKSPACE_MIGRATION_ID,
            encode_json(projection_template)?,
            now,
        ],
    )?;
    Ok(())
}

fn build_diagnostics(
    input: &NativeWorkspaceMigrationRunInput,
    source_checksum: &str,
    source_backup_ref: &str,
    started_at: &str,
    completed_at: &str,
    candidates: &[MigrationCandidate],
    winners: &[MigrationCandidate],
    recovery: &[MigrationCandidate],
    active_winner: Option<&MigrationCandidate>,
) -> NativeWorkspaceMigrationDiagnostics {
    NativeWorkspaceMigrationDiagnostics {
        migration_id: LEGACY_WORKSPACE_MIGRATION_ID.to_string(),
        status: "complete".to_string(),
        source_checksum: source_checksum.to_string(),
        source_backup_ref: source_backup_ref.to_string(),
        application_version: input.application_version.clone(),
        source_window_count: input.windows.len() as u64,
        candidate_count: candidates.len() as u64,
        workspace_count: winners.len() as u64,
        recovery_layout_count: recovery.len() as u64,
        normalization_dropped_context_count: input.normalization_dropped_context_count,
        normalization_repaired_window_count: input.normalization_repaired_window_count,
        active_scope_key: active_winner.map(|candidate| candidate.scope_key.clone()),
        active_source_window_id: active_winner.map(|candidate| candidate.source_window_id.clone()),
        layout_sources: winners
            .iter()
            .map(|candidate| NativeWorkspaceMigrationLayoutSource {
                scope_key: candidate.scope_key.clone(),
                source_window_id: candidate.source_window_id.clone(),
            })
            .collect(),
        recovery_sources: recovery
            .iter()
            .map(|candidate| NativeWorkspaceMigrationRecoverySource {
                scope_key: candidate.scope_key.clone(),
                source_window_id: candidate.source_window_id.clone(),
                snapshot_hash: candidate.snapshot_hash.clone(),
            })
            .collect(),
        historical_layout_cap: input.historical_layout_cap,
        pruned_layouts_possible: input.historical_layout_cap > 0,
        limitation: PRUNED_LAYOUT_LIMITATION.to_string(),
        started_at: started_at.to_string(),
        completed_at: Some(completed_at.to_string()),
        rollback_at: None,
    }
}

fn migration_recency(
    winners: &[MigrationCandidate],
    active_winner: Option<&MigrationCandidate>,
) -> Vec<WorkspaceScopeKey> {
    let mut ranked = winners.to_vec();
    ranked.sort_by(|left, right| {
        right
            .last_activated_at
            .cmp(&left.last_activated_at)
            .then_with(|| left.scope_key.0.cmp(&right.scope_key.0))
    });
    let mut output = Vec::with_capacity(ranked.len());
    if let Some(active) = active_winner {
        output.push(active.scope_key.clone());
    }
    for candidate in ranked {
        if !output.contains(&candidate.scope_key) {
            output.push(candidate.scope_key);
        }
    }
    output
}

fn select_projection_template(
    windows: &[NativeLegacyWorkspaceWindow],
    active_winner: Option<&MigrationCandidate>,
) -> Value {
    select_source_window(windows, active_winner)
        .map(|window| window.projection_template.clone())
        .unwrap_or_else(default_projection_template)
}

fn select_shell_snapshot(
    windows: &[NativeLegacyWorkspaceWindow],
    active_winner: Option<&MigrationCandidate>,
) -> Value {
    select_source_window(windows, active_winner)
        .map(|window| window.shell_snapshot.clone())
        .unwrap_or_else(|| json!({}))
}

fn select_source_window<'a>(
    windows: &'a [NativeLegacyWorkspaceWindow],
    active_winner: Option<&MigrationCandidate>,
) -> Option<&'a NativeLegacyWorkspaceWindow> {
    if let Some(active) = active_winner
        && let Some(window) = windows
            .iter()
            .find(|window| window.window_id == active.source_window_id)
    {
        return Some(window);
    }
    windows.iter().min_by(|left, right| {
        right
            .is_open
            .cmp(&left.is_open)
            .then_with(|| right.restore_updated_at.cmp(&left.restore_updated_at))
            .then_with(|| right.restore_revision.cmp(&left.restore_revision))
            .then_with(|| left.window_id.cmp(&right.window_id))
    })
}

fn write_immutable_backup(
    app_data_dir: &std::path::Path,
    source_checksum: &str,
    input: &NativeWorkspaceMigrationRunInput,
    captured_at: &str,
) -> Result<String, PersistenceError> {
    let relative_ref = format!("{BACKUP_DIRECTORY}/v3-{source_checksum}.json");
    let backup_path = app_data_dir.join(&relative_ref);
    if backup_path.exists() {
        verify_existing_backup(&backup_path, source_checksum)?;
        return Ok(relative_ref);
    }
    let parent = backup_path.parent().ok_or_else(|| {
        PersistenceError::InvalidWorkspaceInput("backup path has no parent".to_string())
    })?;
    fs::create_dir_all(parent)?;
    let envelope = json!({
        "applicationVersion": input.application_version,
        "capturedAt": captured_at,
        "historicalLayoutCap": input.historical_layout_cap,
        "sourceChecksum": source_checksum,
        "source": input.source_backup,
    });
    let bytes = serde_json::to_vec_pretty(&envelope).map_err(invalid_json)?;
    let temporary_path = parent.join(format!(
        ".v3-{source_checksum}-{}.tmp",
        Uuid::new_v4().simple()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = fs::rename(&temporary_path, &backup_path) {
        let _ = fs::remove_file(&temporary_path);
        if backup_path.exists() {
            verify_existing_backup(&backup_path, source_checksum)?;
        } else {
            return Err(PersistenceError::Io(error));
        }
    }
    Ok(relative_ref)
}

fn verify_existing_backup(
    backup_path: &std::path::Path,
    expected_checksum: &str,
) -> Result<(), PersistenceError> {
    let value: Value = serde_json::from_slice(&fs::read(backup_path)?).map_err(invalid_json)?;
    let declared_checksum = value
        .get("sourceChecksum")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let actual_checksum = value
        .get("source")
        .map(hash_json)
        .transpose()?
        .unwrap_or_default();
    if declared_checksum != expected_checksum || actual_checksum != expected_checksum {
        return Err(PersistenceError::WorkspaceBackupChecksumMismatch(
            backup_path.to_path_buf(),
        ));
    }
    Ok(())
}

fn resolve_legacy_backup_path(
    app_data_dir: &Path,
    relative_ref: &str,
) -> Result<PathBuf, PersistenceError> {
    let relative = Path::new(relative_ref);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PersistenceError::InvalidWorkspaceInput(
            "legacy backup reference is invalid".to_string(),
        ));
    }
    Ok(app_data_dir.join(relative))
}

fn format_timestamp(value: OffsetDateTime) -> Result<String, PersistenceError> {
    value.format(&Rfc3339).map_err(|_| {
        PersistenceError::InvalidWorkspaceInput(
            "workspace rollout timestamp could not be formatted".to_string(),
        )
    })
}

pub fn refresh_v3_projection(connection: &Connection) -> Result<Option<Value>, PersistenceError> {
    let compatibility = connection
        .query_row(
            "SELECT projection_template_json, projection_revision, dual_write_enabled FROM workspace_v3_compatibility WHERE singleton_id = ?1",
            [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()?;
    let Some((template_json, current_revision, dual_write_enabled)) = compatibility else {
        return Ok(None);
    };
    if !dual_write_enabled {
        return Ok(None);
    }
    let template: Value = serde_json::from_str(&template_json).map_err(invalid_json)?;
    let navigation = load_navigation(connection)?;
    let contexts = load_projection_contexts(connection)?;
    let projection_revision = current_revision.checked_add(1).ok_or_else(|| {
        PersistenceError::InvalidWorkspaceInput("projection revision overflow".to_string())
    })?;
    let projection =
        build_v3_projection(template, &navigation, contexts, projection_revision as u64);
    let now = crate::store::now_rfc3339();
    connection.execute(
        "
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        ",
        params![APP_DATA_WINDOWS_STORAGE_KEY, encode_json(&projection)?, now],
    )?;
    connection.execute(
        "UPDATE workspace_v3_compatibility SET projection_revision = ?1, updated_at = ?2 WHERE singleton_id = ?3",
        params![projection_revision, now, APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
    )?;
    Ok(Some(projection))
}

fn build_v3_projection(
    template: Value,
    navigation: &NativeAppWorkspaceNavigation,
    contexts: Vec<Value>,
    projection_revision: u64,
) -> Value {
    let mut record = template.as_object().cloned().unwrap_or_default();
    record.insert("isOpen".to_string(), Value::Bool(true));
    record.insert(
        "lastOpenedAt".to_string(),
        Value::String(navigation.updated_at.clone()),
    );
    let active = navigation.active_scope_key.as_ref().and_then(|scope_key| {
        contexts.iter().find(|context| {
            context.get("key").and_then(Value::as_str) == Some(scope_key.0.as_str())
        })
    });
    let active_project_id = active
        .and_then(|context| context.get("projectId"))
        .cloned()
        .unwrap_or(Value::Null);
    let active_worktree_id = active
        .and_then(|context| context.get("worktreeId"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut snapshot = record
        .get("snapshot")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    snapshot.insert("activeProjectId".to_string(), active_project_id.clone());
    snapshot.insert("activeWorktreeId".to_string(), active_worktree_id.clone());
    apply_shell_snapshot(&mut snapshot, &navigation.shell_snapshot);
    let mut window_context = snapshot
        .get("windowContext")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(default_window_context);
    window_context.insert("projectId".to_string(), active_project_id);
    window_context.insert("worktreeId".to_string(), active_worktree_id);
    snapshot.insert("windowContext".to_string(), Value::Object(window_context));
    record.insert("snapshot".to_string(), Value::Object(snapshot));
    record.insert(
        "workspaceRestore".to_string(),
        json!({
            "revision": projection_revision,
            "schemaVersion": 1,
            "snapshot": {
                "activeContextKey": navigation.active_scope_key,
                "contexts": contexts,
                // Downgraded builds must not materialize the entire durable catalog.
                "openContextKeys": navigation.active_scope_key.iter().collect::<Vec<_>>(),
                "version": 3,
            },
            "updatedAt": navigation.updated_at,
        }),
    );
    Value::Array(vec![Value::Object(record)])
}

fn apply_shell_snapshot(snapshot: &mut Map<String, Value>, shell: &Value) {
    let Some(shell) = shell.as_object() else {
        return;
    };
    if let Some(value) = shell.get("shellState") {
        snapshot.insert("shellState".to_string(), value.clone());
    }
    if let Some(value) = shell.get("windowState") {
        snapshot.insert("windowState".to_string(), value.clone());
    }
}

fn load_projection_contexts(connection: &Connection) -> Result<Vec<Value>, PersistenceError> {
    let mut statement = connection.prepare(
        "
        SELECT scope_key, project_id, worktree_id, layout_snapshot_json,
               COALESCE(last_activated_at, updated_at)
        FROM durable_workspaces
        ORDER BY scope_key ASC
        ",
    )?;
    let contexts = statement
        .query_map([], |row| {
            let layout_json: String = row.get(3)?;
            let layout: Value = serde_json::from_str(&layout_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(json!({
                "key": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "worktreeId": row.get::<_, Option<String>>(2)?,
                "workspace": layout,
                "lastActivatedAt": row.get::<_, String>(4)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(contexts)
}

fn load_navigation(
    connection: &Connection,
) -> Result<NativeAppWorkspaceNavigation, PersistenceError> {
    connection
        .query_row(
            "SELECT active_scope_key, recent_scope_keys_json, shell_snapshot_json, revision, updated_at FROM app_workspace_navigation WHERE singleton_id = ?1",
            [APP_WORKSPACE_NAVIGATION_SINGLETON_ID],
            |row| {
                let recent_json: String = row.get(1)?;
                let shell_json: String = row.get(2)?;
                let revision: i64 = row.get(3)?;
                Ok(NativeAppWorkspaceNavigation {
                    active_scope_key: row.get::<_, Option<String>>(0)?.map(WorkspaceScopeKey),
                    recent_scope_keys: serde_json::from_str(&recent_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error)))?,
                    shell_snapshot: serde_json::from_str(&shell_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error)))?,
                    revision: u64::try_from(revision).map_err(|error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Integer, Box::new(error)))?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(PersistenceError::from)
}

fn load_diagnostics(
    connection: &Connection,
) -> Result<Option<NativeWorkspaceMigrationDiagnostics>, PersistenceError> {
    let raw = connection
        .query_row(
            "SELECT diagnostics_json FROM workspace_migrations WHERE migration_id = ?1 AND status = 'complete'",
            [LEGACY_WORKSPACE_MIGRATION_ID],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|value| serde_json::from_str(&value).map_err(invalid_json))
        .transpose()
}

fn required_diagnostics(
    connection: &Connection,
) -> Result<NativeWorkspaceMigrationDiagnostics, PersistenceError> {
    load_diagnostics(connection)?.ok_or_else(|| {
        PersistenceError::WorkspaceMigrationNotFound(LEGACY_WORKSPACE_MIGRATION_ID.to_string())
    })
}

fn load_recovery_sources(
    connection: &Connection,
) -> Result<Vec<NativeWorkspaceMigrationRecoverySource>, PersistenceError> {
    let mut statement = connection.prepare(
        "SELECT scope_key, COALESCE(source_window_id, ''), snapshot_hash FROM workspace_layout_recovery ORDER BY scope_key, source_window_id, snapshot_hash",
    )?;
    let values = statement
        .query_map([], |row| {
            Ok(NativeWorkspaceMigrationRecoverySource {
                scope_key: WorkspaceScopeKey(row.get(0)?),
                source_window_id: row.get(1)?,
                snapshot_hash: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn load_v3_projection(connection: &Connection) -> Result<Value, PersistenceError> {
    let raw = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [APP_DATA_WINDOWS_STORAGE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            PersistenceError::WorkspaceMigrationNotFound(LEGACY_WORKSPACE_MIGRATION_ID.to_string())
        })?;
    serde_json::from_str(&raw).map_err(invalid_json)
}

fn recovery_id(candidate: &MigrationCandidate) -> String {
    sha256_hex(
        format!(
            "{}\0{}\0{}\0{}",
            candidate.scope_key.0,
            candidate.source_window_id,
            candidate.source_workspace_id.as_deref().unwrap_or_default(),
            candidate.snapshot_hash,
        )
        .as_bytes(),
    )
}

fn default_projection_template() -> Value {
    json!({
        "isOpen": true,
        "lastOpenedAt": "1970-01-01T00:00:00Z",
        "snapshot": {
            "activeProjectId": null,
            "activeWorktreeId": null,
            "shellState": null,
            "windowContext": default_window_context(),
            "windowState": {
                "height": 960,
                "id": "legacy-canonical-window",
                "isFullScreen": false,
                "isMaximized": false,
                "width": 1480,
                "x": null,
                "y": null
            }
        }
    })
}

fn default_window_context() -> Map<String, Value> {
    serde_json::from_value::<Map<String, Value>>(json!({
        "projectId": null,
        "windowId": "legacy-canonical-window",
        "windowKind": "main",
        "workspaceId": "legacy-canonical-workspace",
        "workspaceSessionId": "legacy-canonical-session",
        "worktreeId": null
    }))
    .expect("static window context is valid")
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, PersistenceError> {
    serde_json::to_vec(value).map_err(invalid_json)
}

fn hash_json(value: &Value) -> Result<String, PersistenceError> {
    Ok(sha256_hex(&canonical_json_bytes(value)?))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encode_json(value: &Value) -> Result<String, PersistenceError> {
    serde_json::to_string(value).map_err(invalid_json)
}

fn invalid_json(error: serde_json::Error) -> PersistenceError {
    PersistenceError::InvalidWorkspaceInput(format!("JSON encoding failed: {error}"))
}

fn revision_to_sql(revision: u64) -> Result<i64, PersistenceError> {
    i64::try_from(revision).map_err(|_| {
        PersistenceError::InvalidWorkspaceInput("revision exceeds SQLite range".to_string())
    })
}

fn fail_at(
    actual: MigrationFailpoint,
    expected: MigrationFailpoint,
    label: &'static str,
) -> Result<(), PersistenceError> {
    if actual == expected {
        Err(PersistenceError::MigrationInterrupted(label))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use comando_types::persistence::NativePersistenceMode;
    use comando_types::workspace::{
        NativeLegacyWorkspaceContext, NativeWorkspaceMigrationRunInput,
    };
    use tempfile::TempDir;

    fn open_store() -> (TempDir, SqlitePersistenceStore) {
        let temp_dir = TempDir::new().expect("temp dir");
        let (store, _) = SqlitePersistenceStore::open(crate::NativeStorageConfig {
            app_data_dir: temp_dir.path().to_path_buf(),
            database_path: temp_dir.path().join("migration.sqlite3"),
            mode: NativePersistenceMode::Write,
        })
        .expect("store opens");
        (temp_dir, store)
    }

    fn layout(draft: &str) -> Value {
        json!({
            "activePaneId": "pane-root",
            "rootNode": {
                "activeTabId": "chat-a",
                "id": "pane-root",
                "pinnedTabIds": ["chat-a"],
                "tabIds": ["chat-a"],
                "type": "pane"
            },
            "tabs": [{
                "draft": draft,
                "id": "chat-a",
                "kind": "chat",
                "sessionId": "session-a",
                "title": "Chat"
            }]
        })
    }

    fn migration_input() -> NativeWorkspaceMigrationRunInput {
        let primary = WorkspaceScopeKey("project-a::__primary__".to_string());
        NativeWorkspaceMigrationRunInput {
            application_version: "0.2.1".to_string(),
            historical_layout_cap: 30,
            normalization_dropped_context_count: 1,
            normalization_repaired_window_count: 1,
            source_backup: json!({"windows": ["window-a", "window-b"]}),
            windows: vec![
                NativeLegacyWorkspaceWindow {
                    window_id: "window-a".to_string(),
                    workspace_id: None,
                    is_open: true,
                    restore_revision: 4,
                    restore_updated_at: "2026-07-30T10:00:00Z".to_string(),
                    active_context_key: Some(primary.clone()),
                    open_context_keys: vec![primary.clone()],
                    contexts: vec![NativeLegacyWorkspaceContext {
                        scope_key: primary.clone(),
                        project_id: ProjectId("project-a".to_string()),
                        worktree_id: Some(WorktreeId("project-a:primary".to_string())),
                        last_activated_at: "2026-07-30T10:00:00Z".to_string(),
                        layout_snapshot: layout("winner draft"),
                    }],
                    shell_snapshot: json!({"shellState": {"left": 240}}),
                    projection_template: default_projection_template(),
                },
                NativeLegacyWorkspaceWindow {
                    window_id: "window-b".to_string(),
                    workspace_id: None,
                    is_open: false,
                    restore_revision: 8,
                    restore_updated_at: "2026-07-30T11:00:00Z".to_string(),
                    active_context_key: Some(primary.clone()),
                    open_context_keys: vec![primary.clone()],
                    contexts: vec![NativeLegacyWorkspaceContext {
                        scope_key: primary.clone(),
                        project_id: ProjectId("project-a".to_string()),
                        worktree_id: None,
                        last_activated_at: "2026-07-30T11:00:00Z".to_string(),
                        layout_snapshot: layout("recovery draft"),
                    }],
                    shell_snapshot: json!({}),
                    projection_template: default_projection_template(),
                },
            ],
        }
    }

    #[test]
    fn migrates_primary_duplicates_and_preserves_divergent_recovery() {
        let (_temp_dir, mut store) = open_store();
        let output = store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");

        assert!(output.applied);
        assert_eq!(output.diagnostics.workspace_count, 1);
        assert_eq!(output.diagnostics.recovery_layout_count, 1);
        assert_eq!(
            output.navigation.active_scope_key,
            Some(WorkspaceScopeKey("project-a::__primary__".to_string()))
        );
        let workspace = store
            .load_durable_workspace(&WorkspaceScopeKey("project-a::__primary__".to_string()))
            .expect("workspace loads")
            .expect("workspace exists");
        assert_eq!(workspace.worktree_id, None);
        assert_eq!(workspace.layout_snapshot, layout("winner draft"));
        assert_eq!(
            workspace.lifecycle,
            NativeDurableWorkspaceLifecycle::Orphaned
        );
        let recovery_json: String = store
            .connection()
            .query_row(
                "SELECT layout_snapshot_json FROM workspace_layout_recovery",
                [],
                |row| row.get(0),
            )
            .expect("recovery row");
        assert_eq!(
            serde_json::from_str::<Value>(&recovery_json).expect("recovery JSON"),
            layout("recovery draft")
        );
    }

    #[test]
    fn migration_is_idempotent_and_backup_has_a_verified_checksum() {
        let (temp_dir, mut store) = open_store();
        let first = store
            .run_workspace_migration(migration_input())
            .expect("first migration");
        let second = store
            .run_workspace_migration(migration_input())
            .expect("second migration");

        assert!(first.applied);
        assert!(!second.applied);
        assert_eq!(first.diagnostics, second.diagnostics);
        assert!(
            temp_dir
                .path()
                .join(first.diagnostics.source_backup_ref)
                .exists()
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT COUNT(*) FROM durable_workspaces", [], |row| row
                    .get::<_, i64>(0))
                .expect("workspace count"),
            1
        );
    }

    #[test]
    fn every_transaction_stage_rolls_back_and_can_resume() {
        {
            let (temp_dir, mut store) = open_store();
            let error = store
                .run_workspace_migration_with_failpoint(
                    migration_input(),
                    MigrationFailpoint::AfterBackup,
                )
                .expect_err("backup failpoint interrupts");
            assert!(matches!(error, PersistenceError::MigrationInterrupted(_)));
            assert_eq!(
                store
                    .connection()
                    .query_row("SELECT COUNT(*) FROM durable_workspaces", [], |row| row
                        .get::<_, i64>(0))
                    .expect("workspace count"),
                0
            );
            assert!(temp_dir.path().join(BACKUP_DIRECTORY).exists());
            store
                .run_workspace_migration(migration_input())
                .expect("migration resumes after backup");
        }
        for failpoint in [
            MigrationFailpoint::AfterWorkspaces,
            MigrationFailpoint::AfterRecovery,
            MigrationFailpoint::AfterNavigation,
            MigrationFailpoint::AfterMarker,
            MigrationFailpoint::AfterProjection,
        ] {
            let (_temp_dir, mut store) = open_store();
            let error = store
                .run_workspace_migration_with_failpoint(migration_input(), failpoint)
                .expect_err("failpoint interrupts");
            assert!(matches!(error, PersistenceError::MigrationInterrupted(_)));
            for table in [
                "durable_workspaces",
                "workspace_layout_recovery",
                "workspace_migrations",
                "workspace_v3_compatibility",
            ] {
                let count: i64 = store
                    .connection()
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .expect("count rows");
                assert_eq!(count, 0, "{table} must roll back");
            }
            store
                .run_workspace_migration(migration_input())
                .expect("migration resumes");
        }
    }

    #[test]
    fn rollback_exports_one_canonical_v3_window_without_touching_layouts() {
        let (_temp_dir, mut store) = open_store();
        store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");
        let rollback = store
            .rollback_workspace_migration()
            .expect("rollback projection succeeds");
        let windows = rollback.v3_projection.as_array().expect("projection array");
        assert_eq!(windows.len(), 1);
        assert_eq!(
            windows[0]["workspaceRestore"]["snapshot"]["openContextKeys"],
            json!(["project-a::__primary__"])
        );
        assert_eq!(
            windows[0]["workspaceRestore"]["snapshot"]["contexts"][0]["workspace"],
            layout("winner draft")
        );
        assert!(rollback.diagnostics.rollback_at.is_some());
    }

    #[test]
    fn identical_duplicates_do_not_create_recovery_rows() {
        let (_temp_dir, mut store) = open_store();
        let mut input = migration_input();
        input.windows[1].contexts[0].layout_snapshot = layout("winner draft");

        let output = store
            .run_workspace_migration(input)
            .expect("migration succeeds");

        assert_eq!(output.diagnostics.recovery_layout_count, 0);
        assert_eq!(
            store
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM workspace_layout_recovery",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("recovery count"),
            0
        );
    }

    #[test]
    fn classifies_hidden_and_missing_catalog_scopes_without_dropping_them() {
        let (_temp_dir, mut store) = open_store();
        for (id, hidden) in [("project-visible", 0), ("project-hidden", 1)] {
            store
                .connection_mut()
                .execute(
                    "INSERT INTO projects (id, name, canonical_root_path, created_at, updated_at, is_hidden) VALUES (?1, ?1, ?2, 'now', 'now', ?3)",
                    params![id, format!("/tmp/{id}"), hidden],
                )
                .expect("project row");
        }
        let mut input = migration_input();
        input.windows.truncate(1);
        input.windows[0].active_context_key = Some(WorkspaceScopeKey(
            "project-visible::__primary__".to_string(),
        ));
        input.windows[0].open_context_keys = vec![WorkspaceScopeKey(
            "project-visible::__primary__".to_string(),
        )];
        input.windows[0].contexts = vec![
            NativeLegacyWorkspaceContext {
                scope_key: WorkspaceScopeKey("project-visible::__primary__".to_string()),
                project_id: ProjectId("project-visible".to_string()),
                worktree_id: None,
                last_activated_at: "2026-07-31T00:00:00Z".to_string(),
                layout_snapshot: layout("visible"),
            },
            NativeLegacyWorkspaceContext {
                scope_key: WorkspaceScopeKey("project-visible::missing-worktree".to_string()),
                project_id: ProjectId("project-visible".to_string()),
                worktree_id: Some(WorktreeId("missing-worktree".to_string())),
                last_activated_at: "2026-07-30T00:00:00Z".to_string(),
                layout_snapshot: layout("missing worktree"),
            },
            NativeLegacyWorkspaceContext {
                scope_key: WorkspaceScopeKey("project-hidden::__primary__".to_string()),
                project_id: ProjectId("project-hidden".to_string()),
                worktree_id: None,
                last_activated_at: "2026-07-29T00:00:00Z".to_string(),
                layout_snapshot: layout("hidden"),
            },
        ];

        store
            .run_workspace_migration(input)
            .expect("migration succeeds");

        let lifecycle = |scope_key: &str| {
            store
                .connection()
                .query_row(
                    "SELECT lifecycle FROM durable_workspaces WHERE scope_key = ?1",
                    [scope_key],
                    |row| row.get::<_, String>(0),
                )
                .expect("lifecycle")
        };
        assert_eq!(lifecycle("project-visible::__primary__"), "active");
        assert_eq!(lifecycle("project-visible::missing-worktree"), "orphaned");
        assert_eq!(lifecycle("project-hidden::__primary__"), "archived");
    }

    #[test]
    fn dual_write_keeps_v4_ownership_and_v3_projection_current() {
        let (_temp_dir, mut store) = open_store();
        store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");
        let scope_key = WorkspaceScopeKey("project-a::__primary__".to_string());
        let original_owner = store
            .load_durable_workspace(&scope_key)
            .expect("workspace loads")
            .expect("workspace exists")
            .runtime_owner_id;
        store
            .save_durable_workspace(comando_types::workspace::NativeDurableWorkspaceSaveInput {
                scope_key: scope_key.clone(),
                expected_revision: 0,
                layout_snapshot: layout("v4 write"),
            })
            .expect("v4 save succeeds");
        assert_eq!(
            load_v3_projection(store.connection()).expect("projection")[0]["workspaceRestore"]["snapshot"]
                ["contexts"][0]["workspace"],
            layout("v4 write")
        );

        let mut legacy = migration_input();
        legacy.windows[0].contexts[0].layout_snapshot = layout("v3 write");
        legacy.windows.truncate(1);
        store
            .sync_legacy_workspace_migration(legacy)
            .expect("legacy sync succeeds");
        let workspace = store
            .load_durable_workspace(&scope_key)
            .expect("workspace loads")
            .expect("workspace exists");
        assert_eq!(workspace.runtime_owner_id, original_owner);
        assert_eq!(workspace.layout_snapshot, layout("v3 write"));
        assert_eq!(
            load_v3_projection(store.connection()).expect("projection")[0]["workspaceRestore"]["snapshot"]
                ["contexts"][0]["workspace"],
            layout("v3 write")
        );

        let revision_before_recency_sync = workspace.revision;
        let mut recency_only = migration_input();
        recency_only.windows.truncate(1);
        recency_only.windows[0].contexts[0].layout_snapshot = layout("v3 write");
        recency_only.windows[0].contexts[0].last_activated_at = "2026-07-31T00:00:00Z".to_string();
        store
            .sync_legacy_workspace_migration(recency_only)
            .expect("recency-only sync succeeds");
        assert_eq!(
            store
                .load_durable_workspace(&scope_key)
                .expect("workspace loads")
                .expect("workspace exists")
                .revision,
            revision_before_recency_sync
        );
    }

    #[test]
    fn rollout_keeps_dual_write_for_stable_and_gates_the_v4_only_transition() {
        let (_temp_dir, mut store) = open_store();
        store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");

        let stable = store
            .mark_workspace_rollout_stable(NativeWorkspaceMarkStableInput {
                application_version: "0.2.1".to_string(),
                retention_days: 90,
            })
            .expect("stable release recorded");
        assert_eq!(stable.stage, NativeWorkspaceRolloutStage::StableDualWrite);
        assert!(stable.dual_write_enabled);
        assert!(
            store
                .disable_workspace_legacy_writes(NativeWorkspaceDisableLegacyWritesInput {
                    application_version: "0.2.1".to_string(),
                })
                .is_err(),
            "the stable dual-write version cannot retire its own rollback path"
        );
        assert!(
            store
                .disable_workspace_legacy_writes(NativeWorkspaceDisableLegacyWritesInput {
                    application_version: "0.3.0".to_string(),
                })
                .is_err(),
            "unresolved recovery layouts must block compatibility retirement"
        );

        let recovery = store
            .list_workspace_recovery_layouts()
            .expect("recovery layouts list");
        for layout in recovery {
            store
                .discard_workspace_recovery_layout(
                    comando_types::workspace::NativeWorkspaceRecoveryDiscardInput {
                        recovery_id: layout.id,
                        scope_key: layout.scope_key,
                    },
                )
                .expect("recovery layout explicitly discarded");
        }
        let projection_before = load_v3_projection(store.connection()).expect("v3 projection");
        let v4_only = store
            .disable_workspace_legacy_writes(NativeWorkspaceDisableLegacyWritesInput {
                application_version: "0.3.0".to_string(),
            })
            .expect("later version disables legacy writes");
        assert_eq!(v4_only.stage, NativeWorkspaceRolloutStage::V4Only);
        assert!(!v4_only.rollback_available);

        let scope_key = WorkspaceScopeKey("project-a::__primary__".to_string());
        let workspace = store
            .load_durable_workspace(&scope_key)
            .expect("workspace loads")
            .expect("workspace exists");
        store
            .save_durable_workspace(comando_types::workspace::NativeDurableWorkspaceSaveInput {
                scope_key,
                expected_revision: workspace.revision,
                layout_snapshot: layout("v4-only write"),
            })
            .expect("v4-only save succeeds");
        assert_eq!(
            load_v3_projection(store.connection()).expect("last projection retained"),
            projection_before,
        );
        assert!(store.rollback_workspace_migration().is_err());
    }

    #[test]
    fn legacy_cleanup_requires_consent_retention_and_resolved_recovery() {
        let (temp_dir, mut store) = open_store();
        let migration = store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");
        let backup_path = temp_dir
            .path()
            .join(&migration.diagnostics.source_backup_ref);
        assert!(backup_path.exists());
        for layout in store
            .list_workspace_recovery_layouts()
            .expect("recovery layouts list")
        {
            store
                .discard_workspace_recovery_layout(
                    comando_types::workspace::NativeWorkspaceRecoveryDiscardInput {
                        recovery_id: layout.id,
                        scope_key: layout.scope_key,
                    },
                )
                .expect("recovery layout explicitly discarded");
        }
        store
            .mark_workspace_rollout_stable(NativeWorkspaceMarkStableInput {
                application_version: "0.2.1".to_string(),
                retention_days: 90,
            })
            .expect("stable release recorded");
        store
            .disable_workspace_legacy_writes(NativeWorkspaceDisableLegacyWritesInput {
                application_version: "0.3.0".to_string(),
            })
            .expect("legacy writes disabled");

        assert!(
            store
                .cleanup_workspace_legacy_compatibility(NativeWorkspaceCleanupLegacyInput {
                    consent: true,
                })
                .is_err(),
            "retention must elapse"
        );
        store
            .connection_mut()
            .execute(
                "UPDATE workspace_v3_compatibility SET legacy_retention_until = '2020-01-01T00:00:00Z'",
                [],
            )
            .expect("test retention deadline moved to the past");
        assert!(
            store
                .cleanup_workspace_legacy_compatibility(NativeWorkspaceCleanupLegacyInput {
                    consent: false,
                })
                .is_err(),
            "cleanup requires explicit consent"
        );
        let retired = store
            .cleanup_workspace_legacy_compatibility(NativeWorkspaceCleanupLegacyInput {
                consent: true,
            })
            .expect("legacy compatibility retired");
        assert_eq!(retired.stage, NativeWorkspaceRolloutStage::LegacyRetired);
        assert!(!retired.source_backup_retained);
        assert!(!backup_path.exists());
        assert!(
            store
                .connection()
                .query_row(
                    "SELECT value FROM app_settings WHERE key = ?1",
                    [APP_DATA_WINDOWS_STORAGE_KEY],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .expect("legacy key query")
                .is_none()
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT COUNT(*) FROM durable_workspaces", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("durable workspace count"),
            1,
        );
    }

    #[test]
    fn migration_does_not_modify_ai_history_files() {
        let (temp_dir, mut store) = open_store();
        let history_dir = temp_dir.path().join("ai").join("history");
        fs::create_dir_all(&history_dir).expect("history dir");
        let history_path = history_dir.join("session-a.jsonl");
        let original = b"{\"sessionId\":\"session-a\",\"text\":\"unchanged\"}\n";
        fs::write(&history_path, original).expect("history fixture");

        store
            .run_workspace_migration(migration_input())
            .expect("migration succeeds");

        assert_eq!(fs::read(history_path).expect("history remains"), original);
    }
}
