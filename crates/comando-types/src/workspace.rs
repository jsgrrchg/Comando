use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{ProjectId, WorkspaceId, WorkspaceRuntimeOwnerId, WorkspaceScopeKey, WorktreeId};

pub const WORKSPACE_PRIMARY_CONTEXT: &str = "__primary__";
pub const APP_WORKSPACE_NAVIGATION_SINGLETON_ID: &str = "main";
pub const LEGACY_WORKSPACE_MIGRATION_ID: &str = "2026-07-31-workspaces-v3-to-v4";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceLayoutSnapshot {
    pub workspace_id: Option<WorkspaceId>,
    pub active_pane_id: String,
    pub root_node: serde_json::Value,
    pub tabs: Vec<serde_json::Value>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeDurableWorkspaceLifecycle {
    Active,
    Orphaned,
    Archived,
}

impl NativeDurableWorkspaceLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Orphaned => "orphaned",
            Self::Archived => "archived",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "orphaned" => Some(Self::Orphaned),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspace {
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub runtime_owner_id: WorkspaceRuntimeOwnerId,
    pub layout_snapshot: Value,
    pub revision: u64,
    pub lifecycle: NativeDurableWorkspaceLifecycle,
    pub last_activated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceSummary {
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub runtime_owner_id: WorkspaceRuntimeOwnerId,
    pub revision: u64,
    pub lifecycle: NativeDurableWorkspaceLifecycle,
    pub last_activated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceCreateInput {
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub layout_snapshot: Value,
    pub lifecycle: NativeDurableWorkspaceLifecycle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceScopeInput {
    pub scope_key: WorkspaceScopeKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceSaveInput {
    pub scope_key: WorkspaceScopeKey,
    pub expected_revision: u64,
    pub layout_snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceRevisionInput {
    pub scope_key: WorkspaceScopeKey,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceResetInput {
    pub scope_key: WorkspaceScopeKey,
    pub expected_revision: u64,
    pub layout_snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspaceListOutput {
    pub workspaces: Vec<NativeDurableWorkspaceSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppWorkspaceNavigation {
    pub active_scope_key: Option<WorkspaceScopeKey>,
    pub recent_scope_keys: Vec<WorkspaceScopeKey>,
    pub shell_snapshot: Value,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppWorkspaceSetActiveInput {
    pub active_scope_key: Option<WorkspaceScopeKey>,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppWorkspaceSaveShellInput {
    pub expected_revision: u64,
    pub shell_snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDurableWorkspacePurgeOutput {
    pub navigation: NativeAppWorkspaceNavigation,
    pub purged_scope_key: WorkspaceScopeKey,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeWorkspaceDeletionKind {
    DeleteWorktree,
    ClearProjectData,
}

impl NativeWorkspaceDeletionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeleteWorktree => "delete_worktree",
            Self::ClearProjectData => "clear_project_data",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "delete_worktree" => Some(Self::DeleteWorktree),
            "clear_project_data" => Some(Self::ClearProjectData),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeWorkspaceDeletionStatus {
    Pending,
    CheckoutDeleted,
    Purging,
    Completed,
    Failed,
}

impl NativeWorkspaceDeletionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::CheckoutDeleted => "checkout_deleted",
            Self::Purging => "purging",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "checkout_deleted" => Some(Self::CheckoutDeleted),
            "purging" => Some(Self::Purging),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeletionJournalEntry {
    pub operation_id: String,
    pub kind: NativeWorkspaceDeletionKind,
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub checkout_path: Option<String>,
    pub status: NativeWorkspaceDeletionStatus,
    pub force_approved: bool,
    pub session_ids: Vec<String>,
    pub error_code: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeletionBeginInput {
    pub operation_id: String,
    pub kind: NativeWorkspaceDeletionKind,
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub checkout_path: Option<String>,
    pub force_approved: bool,
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeletionUpdateInput {
    pub operation_id: String,
    pub status: NativeWorkspaceDeletionStatus,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeletionOperationInput {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDeletionListOutput {
    pub operations: Vec<NativeWorkspaceDeletionJournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceRecoveryLayoutSummary {
    pub id: String,
    pub scope_key: WorkspaceScopeKey,
    pub source_window_id: Option<String>,
    pub source_workspace_id: Option<String>,
    pub source_revision: u64,
    pub source_updated_at: String,
    pub snapshot_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceRecoveryListOutput {
    pub layouts: Vec<NativeWorkspaceRecoveryLayoutSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceRecoveryApplyInput {
    pub recovery_id: String,
    pub scope_key: WorkspaceScopeKey,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceRecoveryDiscardInput {
    pub recovery_id: String,
    pub scope_key: WorkspaceScopeKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceReassociateInput {
    pub source_scope_key: WorkspaceScopeKey,
    pub target_scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub target_worktree_id: WorktreeId,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceForgetSessionInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLegacyWorkspaceContext {
    pub scope_key: WorkspaceScopeKey,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub last_activated_at: String,
    pub layout_snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLegacyWorkspaceWindow {
    pub window_id: String,
    pub workspace_id: Option<WorkspaceId>,
    pub is_open: bool,
    pub restore_revision: u64,
    pub restore_updated_at: String,
    pub active_context_key: Option<WorkspaceScopeKey>,
    pub open_context_keys: Vec<WorkspaceScopeKey>,
    pub contexts: Vec<NativeLegacyWorkspaceContext>,
    pub shell_snapshot: Value,
    pub projection_template: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationRunInput {
    pub application_version: String,
    pub historical_layout_cap: u64,
    pub normalization_dropped_context_count: u64,
    pub normalization_repaired_window_count: u64,
    pub source_backup: Value,
    pub windows: Vec<NativeLegacyWorkspaceWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationLayoutSource {
    pub scope_key: WorkspaceScopeKey,
    pub source_window_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationRecoverySource {
    pub scope_key: WorkspaceScopeKey,
    pub source_window_id: String,
    pub snapshot_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationDiagnostics {
    pub migration_id: String,
    pub status: String,
    pub source_checksum: String,
    pub source_backup_ref: String,
    pub application_version: String,
    pub source_window_count: u64,
    pub candidate_count: u64,
    pub workspace_count: u64,
    pub recovery_layout_count: u64,
    pub normalization_dropped_context_count: u64,
    pub normalization_repaired_window_count: u64,
    pub active_scope_key: Option<WorkspaceScopeKey>,
    pub active_source_window_id: Option<String>,
    pub layout_sources: Vec<NativeWorkspaceMigrationLayoutSource>,
    pub recovery_sources: Vec<NativeWorkspaceMigrationRecoverySource>,
    pub historical_layout_cap: u64,
    pub pruned_layouts_possible: bool,
    pub limitation: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub rollback_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationRunOutput {
    pub applied: bool,
    pub diagnostics: NativeWorkspaceMigrationDiagnostics,
    pub navigation: NativeAppWorkspaceNavigation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationExportOutput {
    pub diagnostics: NativeWorkspaceMigrationDiagnostics,
    pub recovery_layouts: Vec<NativeWorkspaceMigrationRecoverySource>,
    pub v3_projection: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMigrationRollbackOutput {
    pub diagnostics: NativeWorkspaceMigrationDiagnostics,
    pub v3_projection: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeWorkspaceRolloutStage {
    Internal,
    StableDualWrite,
    V4Only,
    LegacyRetired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceRolloutStatus {
    pub stage: NativeWorkspaceRolloutStage,
    pub dual_write_enabled: bool,
    pub stable_release_version: Option<String>,
    pub stable_release_verified_at: Option<String>,
    pub legacy_retention_until: Option<String>,
    pub v4_only_since: Option<String>,
    pub legacy_cleanup_completed_at: Option<String>,
    pub pending_recovery_layout_count: u64,
    pub rollback_available: bool,
    pub source_backup_retained: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceMarkStableInput {
    pub application_version: String,
    pub retention_days: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceDisableLegacyWritesInput {
    pub application_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceCleanupLegacyInput {
    pub consent: bool,
}

pub fn normalize_workspace_worktree_id(
    project_id: &str,
    worktree_id: Option<&str>,
) -> Option<String> {
    worktree_id
        .filter(|worktree_id| *worktree_id != format!("{project_id}:primary"))
        .map(str::to_string)
}

pub fn canonical_workspace_scope_key(
    project_id: &str,
    worktree_id: Option<&str>,
) -> WorkspaceScopeKey {
    let normalized_worktree_id = normalize_workspace_worktree_id(project_id, worktree_id);
    WorkspaceScopeKey(format!(
        "{project_id}::{}",
        normalized_worktree_id
            .as_deref()
            .unwrap_or(WORKSPACE_PRIMARY_CONTEXT)
    ))
}
