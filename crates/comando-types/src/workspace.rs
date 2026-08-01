use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{ProjectId, WorkspaceId, WorkspaceRuntimeOwnerId, WorkspaceScopeKey, WorktreeId};

pub const WORKSPACE_PRIMARY_CONTEXT: &str = "__primary__";
pub const APP_WORKSPACE_NAVIGATION_SINGLETON_ID: &str = "main";

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
