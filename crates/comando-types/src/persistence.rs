use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, WorkspaceId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativePersistenceMode {
    Shadow,
    Write,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePersistenceOpenStoreInput {
    pub app_data_dir: String,
    pub database_path: String,
    pub mode: NativePersistenceMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePersistenceOpenStoreOutput {
    pub opened: bool,
    pub schema_version: String,
    pub storage_mode: String,
    pub metadata_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePersistenceStorageHealth {
    pub opened: bool,
    pub database_reachable: bool,
    pub schema_compatible: bool,
    pub metadata_ready: bool,
    pub project_count: u64,
    pub worktree_count: u64,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceSnapshotRef {
    pub workspace_id: Option<WorkspaceId>,
    pub project_id: Option<ProjectId>,
    pub worktree_id: Option<WorktreeId>,
    pub updated_at: String,
    pub storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePersistenceSnapshot {
    pub active_project_id: Option<ProjectId>,
    pub active_worktree_id: Option<WorktreeId>,
    pub workspace: Option<NativeWorkspaceSnapshotRef>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectRecord {
    pub project_id: ProjectId,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeMigrationState {
    NotStarted,
    Running,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeStorageHealth {
    Healthy,
    NeedsRecovery,
    ReadOnly,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrashRecoveryState {
    pub has_pending_recovery: bool,
    pub last_crash_at: Option<String>,
}
