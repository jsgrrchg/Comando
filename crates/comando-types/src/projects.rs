use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, WindowId, WorktreeId};

pub type NativeProjectId = ProjectId;
pub type NativeWorktreeId = WorktreeId;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectSummary {
    pub id: NativeProjectId,
    pub name: String,
    pub canonical_root_path: Option<String>,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorktreeSummary {
    pub id: NativeWorktreeId,
    pub project_id: NativeProjectId,
    pub root_path: String,
    pub branch_name: Option<String>,
    pub is_primary: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectOpenState {
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    pub owner_window_id: Option<WindowId>,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectAddInput {
    pub root_path: String,
    pub owner_window_id: Option<WindowId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectListResult {
    pub projects: Vec<NativeProjectSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectUpdatedEvent {
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    pub reason: String,
    pub occurred_at: String,
}
