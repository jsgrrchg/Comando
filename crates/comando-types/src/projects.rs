use serde::{Deserialize, Serialize};

use crate::fs::NativeFsVisibilityPolicy;
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
    pub head_sha: Option<String>,
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
    pub project_paths: Vec<String>,
    pub owner_window_id: Option<WindowId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectSyncWorktree {
    pub root_path: String,
    pub branch_name: Option<String>,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectSyncWorktreesInput {
    pub project_id: NativeProjectId,
    pub worktrees: Vec<NativeProjectSyncWorktree>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectState {
    pub projects: Vec<NativeProjectSummary>,
    pub worktrees: Vec<NativeWorktreeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectListResult {
    pub projects: Vec<NativeProjectSummary>,
    pub worktrees: Vec<NativeWorktreeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectAddResult {
    pub project_ids_to_open: Vec<NativeProjectId>,
    pub projects: Vec<NativeProjectSummary>,
    pub state: NativeProjectState,
    pub touched_root_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectUpdatedEvent {
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    pub reason: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectTreeEntry {
    pub id: String,
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    pub name: String,
    pub relative_path: String,
    pub parent_relative_path: Option<String>,
    pub kind: String,
    pub extension: Option<String>,
    pub has_children: bool,
    pub is_git_ignored: bool,
    pub git_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<NativeFsVisibilityPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectTreeChildrenInput {
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    pub parent_relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectTreeChildrenResult {
    pub entries: Vec<NativeProjectTreeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectListEntriesInput {
    pub project_id: NativeProjectId,
    pub worktree_id: Option<NativeWorktreeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectListEntriesResult {
    pub entries: Vec<NativeProjectTreeEntry>,
    pub truncated: bool,
}
