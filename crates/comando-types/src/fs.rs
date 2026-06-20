use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, RelativePath, WorktreeId};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeFsEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeFsEntryStatus {
    Clean,
    Modified,
    Created,
    Deleted,
    Renamed,
    Conflicted,
    Ignored,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeFsMutationOrigin {
    User,
    Agent,
    External,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsEntry {
    pub path: String,
    pub relative_path: RelativePath,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub kind: NativeFsEntryKind,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_binary: bool,
    pub is_too_large: bool,
    pub size_bytes: Option<u64>,
    pub mtime_ms: Option<u64>,
    pub content_hash: Option<String>,
    pub status: NativeFsEntryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsReadFileInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsReadFileResult {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub path: String,
    pub relative_path: RelativePath,
    pub content: Option<String>,
    pub encoding: Option<String>,
    pub line_ending: Option<String>,
    pub content_hash: Option<String>,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub is_binary: bool,
    pub is_too_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWriteFileInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
    pub content: String,
    pub expected_content_hash: Option<String>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWriteFileResult {
    pub entry: NativeFsEntry,
    pub conflict: Option<NativeFsConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsConflict {
    pub reason: String,
    pub current_content_hash: Option<String>,
    pub external_mtime_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpenBufferState {
    pub path: String,
    pub relative_path: RelativePath,
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub content_hash: Option<String>,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativePathPolicy {
    pub path: String,
    pub visible: bool,
    pub ai_access: bool,
    pub reason: Option<String>,
}
