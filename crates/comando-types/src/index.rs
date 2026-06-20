use serde::{Deserialize, Serialize};

use crate::ids::{OperationId, ProjectId, RelativePath, WorktreeId};
use crate::projects::NativeProjectTreeEntry;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeIndexStatus {
    Idle,
    Building,
    Ready,
    Stale,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeIndexPolicyState {
    Indexed,
    ExcludedByPolicy,
    Noisy,
    Special,
    TooLarge,
    PermissionDenied,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexScope {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexPolicy {
    pub include_dotfiles: bool,
    pub include_hidden: bool,
    pub follow_symlinks: bool,
    pub max_entries: u32,
    pub max_depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexStats {
    pub entry_count: u32,
    pub indexed_file_count: u32,
    pub indexed_directory_count: u32,
    pub skipped_count: u32,
    pub duration_ms: u64,
    pub truncated: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexStatusResult {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub generation: u64,
    pub status: NativeIndexStatus,
    pub stats: NativeIndexStats,
    pub operation_id: Option<OperationId>,
    pub occurred_at: String,
}

pub type NativeIndexEventPayload = NativeIndexStatusResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexedProjectEntry {
    pub id: String,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub name: String,
    pub relative_path: RelativePath,
    pub parent_relative_path: Option<RelativePath>,
    pub kind: String,
    pub extension: Option<String>,
    pub has_children: bool,
    pub is_git_ignored: bool,
    pub git_status: Option<String>,
    pub policy_state: NativeIndexPolicyState,
}

impl From<NativeProjectTreeEntry> for NativeIndexedProjectEntry {
    fn from(entry: NativeProjectTreeEntry) -> Self {
        Self {
            id: entry.id,
            project_id: entry.project_id,
            worktree_id: entry.worktree_id,
            name: entry.name,
            relative_path: RelativePath(entry.relative_path),
            parent_relative_path: entry.parent_relative_path.map(RelativePath),
            kind: entry.kind,
            extension: entry.extension,
            has_children: entry.has_children,
            is_git_ignored: entry.is_git_ignored,
            git_status: entry.git_status,
            policy_state: NativeIndexPolicyState::Indexed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexRebuildProjectInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<NativeIndexPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexRebuildProjectResult {
    pub status: NativeIndexStatusResult,
    pub entries: Vec<NativeIndexedProjectEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeIndexUpdateKind {
    Created,
    Updated,
    Deleted,
    Renamed,
    Invalidated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexUpdateEntriesInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub kind: NativeIndexUpdateKind,
    pub relative_paths: Option<Vec<RelativePath>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexUpdateEntriesResult {
    pub status: NativeIndexStatusResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexStatusInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexDropProjectInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIndexDropProjectResult {
    pub dropped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectEntrySearchInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub query: String,
    pub include_ancestor_directories: bool,
    pub limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativePathSearchMatch {
    pub entry: NativeIndexedProjectEntry,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectEntrySearchResult {
    pub operation_id: OperationId,
    pub generation: u64,
    pub status: NativeIndexStatus,
    pub entries: Vec<NativeIndexedProjectEntry>,
    pub matches: Vec<NativePathSearchMatch>,
    pub stats: NativeIndexStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeContentSearchInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub query: String,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeContentSearchResult {
    pub operation_id: OperationId,
    pub matches: Vec<NativeContentSearchMatch>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeContentSearchMatch {
    pub relative_path: RelativePath,
    pub line_number: u32,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchCancelInput {
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSearchCancelled {
    pub operation_id: OperationId,
    pub cancelled: bool,
    pub cancelled_at: String,
}
