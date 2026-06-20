use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    Idle,
    Building,
    Ready,
    Stale,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexBuildStats {
    pub entry_count: usize,
    pub indexed_file_count: usize,
    pub indexed_directory_count: usize,
    pub skipped_count: usize,
    pub duration_ms: u64,
    pub truncated: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusSnapshot {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub generation: u64,
    pub status: IndexStatus,
    pub stats: IndexBuildStats,
    pub operation_id: Option<String>,
    pub occurred_at: String,
}
