use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, RelativePath, WorktreeId};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeIndexStatus {
    Idle,
    Building,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexScope {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub include_ignored: bool,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchLimits {
    pub limit: u32,
    pub max_match_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchQuery {
    pub query: String,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub include_ignored: bool,
    pub include_hidden: bool,
    pub case_sensitive: bool,
    pub limits: NativeSearchLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativePathSearchResult {
    pub relative_path: RelativePath,
    pub rank: f64,
    pub matches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeContentSearchResult {
    pub relative_path: RelativePath,
    pub rank: f64,
    pub matches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchResult {
    pub paths: Vec<NativePathSearchResult>,
    pub content: Vec<NativeContentSearchResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchCancelled {
    pub operation_id: String,
    pub cancelled_at: String,
}
