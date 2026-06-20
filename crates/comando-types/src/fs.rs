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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeFsVisibilityPolicy {
    Visible,
    Noisy,
    Special,
    HiddenByPolicy,
    TooLargeToExpand,
    PermissionDenied,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<NativeFsVisibilityPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsReadFileInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsReadFileResult {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub path: String,
    pub relative_path: RelativePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub content: Option<String>,
    pub encoding: Option<String>,
    pub line_ending: Option<String>,
    pub content_hash: Option<String>,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_data_base64: Option<String>,
    pub is_binary: bool,
    pub is_too_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWriteFileInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
    pub content: String,
    pub expected_content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_modified_at_ms: Option<f64>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWriteFileResult {
    pub entry: NativeFsEntry,
    pub conflict: Option<NativeFsConflict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<NativeFsReadFileResult>,
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
pub struct NativeFsCreateEntryInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub parent_relative_path: Option<RelativePath>,
    pub name: String,
    pub kind: NativeFsEntryKind,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsRenameEntryInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
    pub next_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_parent_relative_path: Option<RelativePath>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsDeleteEntryInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: RelativePath,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsCopyEntriesInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub source_relative_paths: Vec<RelativePath>,
    pub destination_parent_relative_path: Option<RelativePath>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsCopyExternalEntriesInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub source_paths: Vec<String>,
    pub destination_parent_relative_path: Option<RelativePath>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsEntryMutationResult {
    pub kind: NativeFsEntryKind,
    pub name: String,
    pub parent_relative_path: Option<RelativePath>,
    pub relative_path: RelativePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<NativeFsEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsEntryMutationListResult {
    pub entries: Vec<NativeFsEntryMutationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsRecordExternalMutationInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_paths: Vec<RelativePath>,
    pub origin: NativeFsMutationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsRevealEntryInfoInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: Option<RelativePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsRevealEntryInfoResult {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub path: String,
    pub relative_path: Option<RelativePath>,
    pub exists: bool,
    pub kind: NativeFsEntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWatchInput {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWatchSyncRegistryInput {
    pub projects: Vec<crate::projects::NativeProjectSummary>,
    pub worktrees: Vec<crate::projects::NativeWorktreeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectTreeInvalidation {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_paths: Option<Vec<RelativePath>>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeFsWatchEvent {
    pub project_id: ProjectId,
    pub worktree_id: Option<WorktreeId>,
    pub relative_path: Option<RelativePath>,
    pub kind: String,
    pub origin: NativeFsMutationOrigin,
    pub occurred_at: String,
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
