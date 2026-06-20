use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, WorkspaceId, WorktreeId};

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
