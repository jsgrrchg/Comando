use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, WorkspaceId, WorktreeId};

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
